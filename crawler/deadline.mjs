export function remainingDeadlineMs(deadline, now = Date.now()) {
  if (deadline == null) return Infinity;
  if (typeof deadline === 'number') return Math.max(0, deadline - now);
  if (Number.isFinite(Number(deadline.deadlineMs))) return Math.max(0, Number(deadline.deadlineMs) - now);
  const remaining = typeof deadline.remainingMs === 'function' ? deadline.remainingMs() : deadline.remainingMs;
  return Number.isFinite(Number(remaining)) ? Math.max(0, Number(remaining)) : Infinity;
}

export function deadlineError(message = 'daily execution deadline exceeded') {
  const error = new Error(message);
  error.code = 'DAILY_DEADLINE_EXCEEDED';
  return error;
}

export function sourceBudgetError(message = 'source maximum duration exceeded') {
  const error = new Error(message);
  error.code = 'SOURCE_MAX_DURATION_EXCEEDED';
  return error;
}

export function cancellationError(signal, deadline) {
  if (signal?.aborted) {
    const error = signal.reason instanceof Error ? signal.reason : new Error('source aborted');
    if (!error.code && remainingDeadlineMs(deadline) <= 0) error.code = 'DAILY_DEADLINE_EXCEEDED';
    return error;
  }
  if (remainingDeadlineMs(deadline) <= 0) return deadlineError();
  return null;
}

export function throwIfNetworkWorkDisallowed(signal, deadline) {
  const error = cancellationError(signal, deadline);
  if (error) throw error;
}

export function isDeadlineCancellation(error, signal, deadline) {
  const reason = signal?.reason;
  const parentDeadline = signal?.aborted && (reason?.code === 'DAILY_DEADLINE_EXCEEDED' || /deadline/i.test(reason?.message || ''));
  return Boolean(parentDeadline || error?.code === 'DAILY_DEADLINE_EXCEEDED'
    || (error?.code === 'ETIMEDOUT' && remainingDeadlineMs(deadline) <= 0));
}

export function isSourceBudgetCancellation(error, signal) {
  return Boolean(error?.code === 'SOURCE_MAX_DURATION_EXCEEDED'
    || signal?.reason?.code === 'SOURCE_MAX_DURATION_EXCEEDED');
}

export function validateExecutionBudget(execution = {}) {
  const positiveFields = [
    'wholeRunDeadlineMs',
    'discoveryBudgetMs',
    'scorerFloorMs',
    'perSourceMaxDurationMs',
    'minimumSourceStartAllocationMs',
  ];
  for (const field of positiveFields) {
    if (!Number.isInteger(execution[field]) || execution[field] <= 0) {
      throw new Error(`execution.${field} must be a positive integer`);
    }
  }
  for (const field of ['downstreamReserveMs', 'handoffReserveMs']) {
    if (!Number.isInteger(execution[field]) || execution[field] < 0) {
      throw new Error(`execution.${field} must be a non-negative integer`);
    }
  }
  if (execution.scorerFloorMs > execution.downstreamReserveMs) {
    throw new Error('execution.scorerFloorMs must be <= execution.downstreamReserveMs');
  }
  if (execution.discoveryBudgetMs + execution.downstreamReserveMs + execution.handoffReserveMs > execution.wholeRunDeadlineMs) {
    throw new Error('execution discovery, downstream, and handoff reserves exceed wholeRunDeadlineMs');
  }
  return execution;
}

export const DEFAULT_EXECUTION_BUDGET = Object.freeze({
  wholeRunDeadlineMs: 2_520_000,
  discoveryBudgetMs: 1_920_000,
  downstreamReserveMs: 300_000,
  handoffReserveMs: 300_000,
  scorerFloorMs: 300_000,
  perSourceMaxDurationMs: 180_000,
  minimumSourceStartAllocationMs: 1_000,
});

export function normalizeExecutionBudget(execution = {}) {
  const wholeRunDeadlineMs = Number(execution.wholeRunDeadlineMs ?? DEFAULT_EXECUTION_BUDGET.wholeRunDeadlineMs);
  const downstreamReserveMs = Number(execution.downstreamReserveMs ?? DEFAULT_EXECUTION_BUDGET.downstreamReserveMs);
  const handoffReserveMs = Number(execution.handoffReserveMs
    ?? (wholeRunDeadlineMs <= 1_200_000 ? wholeRunDeadlineMs * 0.15 : 0));
  const normalized = {
    ...DEFAULT_EXECUTION_BUDGET,
    ...execution,
    wholeRunDeadlineMs,
    downstreamReserveMs,
    handoffReserveMs,
    discoveryBudgetMs: Number(execution.discoveryBudgetMs
      ?? (wholeRunDeadlineMs <= 1_200_000 ? wholeRunDeadlineMs * 0.6 : wholeRunDeadlineMs - downstreamReserveMs - handoffReserveMs)),
    scorerFloorMs: Number(execution.scorerFloorMs ?? Math.min(DEFAULT_EXECUTION_BUDGET.scorerFloorMs, downstreamReserveMs)),
  };
  return validateExecutionBudget(normalized);
}

/**
 * Produce a deterministic inspection plan. Runtime allowances are calculated
 * separately from actual remaining time immediately before each source starts.
 */
export function planSourceBudgets(sourcePlans = [], execution = {}) {
  const budget = normalizeExecutionBudget(execution);
  const plans = [];
  const enabledCount = sourcePlans.filter((source) => source?.plannerStatus !== 'omitted_by_planner').length;
  const plannedCount = Math.min(enabledCount, Math.floor(budget.discoveryBudgetMs / budget.minimumSourceStartAllocationMs));
  const plannedAllocationMs = plannedCount > 0 ? Math.floor(budget.discoveryBudgetMs / plannedCount) : 0;
  let enabledIndex = 0;
  for (const [index, source] of sourcePlans.entries()) {
    const sourceId = source?.id ?? `source-${index + 1}`;
    if (source?.plannerStatus === 'omitted_by_planner') {
      plans.push({ ...source, budget: { status: 'omitted_by_planner', reason: 'planner-omission' } });
      continue;
    }
    const shouldPlan = enabledIndex < plannedCount;
    enabledIndex += 1;
    if (!shouldPlan) {
      plans.push({
        ...source,
        budget: { status: 'omitted_by_planner', reason: 'minimum-start-allocation-unavailable' },
      });
      continue;
    }
    const configuredMaxDurationMs = Number(source.maxDurationMs);
    const maxDurationMs = Math.floor(
      Number.isFinite(configuredMaxDurationMs) && configuredMaxDurationMs > 0
        ? configuredMaxDurationMs
        : budget.perSourceMaxDurationMs,
    );
    plans.push({
      ...source,
      budget: {
        status: 'planned',
        sourceId,
        startAllocationMs: plannedAllocationMs,
        maxDurationMs,
      },
    });
  }
  return {
    plans,
    budget,
    telemetry: {
      discoveryBudgetMs: budget.discoveryBudgetMs,
      minimumSourceStartAllocationMs: budget.minimumSourceStartAllocationMs,
      perSourceMaxDurationMs: budget.perSourceMaxDurationMs,
      sourceCount: sourcePlans.length,
      plannedSourceIds: plans.filter((source) => source.budget.status === 'planned').map((source) => source.id),
      omittedSourceIds: plans.filter((source) => source.budget.status === 'omitted_by_planner').map((source) => source.id),
    },
  };
}

export function createSourceDeadline(parentDeadline, maxDurationMs, startedAt = Date.now(), nowMs = Date.now) {
  const duration = Math.max(1, Number(maxDurationMs) || 1);
  const readNowMs = parentDeadline?.wallClock === true
    ? Date.now
    : typeof nowMs === 'function' ? nowMs : () => nowMs;
  return {
    remainingMs: () => {
      const current = Number(readNowMs());
      const currentNow = Number.isFinite(current) ? current : Date.now();
      return Math.max(0, Math.min(duration - (currentNow - startedAt), remainingDeadlineMs(parentDeadline, currentNow)));
    },
    wallClock: parentDeadline?.wallClock === true,
  };
}

/** Starts one transport operation only after the parent budget check. */
export async function requestWithDeadline(transport, url, options = {}, { signal = null, deadline = null, abortOnDeadline = false } = {}) {
  throwIfNetworkWorkDisallowed(signal, deadline);
  const remainingMs = remainingDeadlineMs(deadline);
  const transportRemainingMs = Number.isFinite(Number(options.remainingMs)) ? Number(options.remainingMs) : remainingMs;
  const configuredTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(remainingMs)
    ? Math.max(1, Math.min(Number.isFinite(configuredTimeoutMs) ? configuredTimeoutMs : remainingMs, remainingMs))
    : configuredTimeoutMs;
  const controller = abortOnDeadline ? new AbortController() : null;
  const transportSignal = controller?.signal ?? signal;
  const abortWith = (reason) => {
    if (!controller || controller.signal.aborted) return;
    controller.abort(reason);
  };
  const abortFromParent = () => abortWith(signal.reason);
  if (controller && signal) {
    if (signal.aborted) abortFromParent();
    else signal.addEventListener('abort', abortFromParent, { once: true });
  }
  const request = Promise.resolve().then(() => {
    throwIfNetworkWorkDisallowed(signal, deadline);
    return transport(url, {
      ...options,
      ...(transportSignal ? { signal: transportSignal } : {}),
      ...(deadline ? { deadline } : {}),
      ...(Number.isFinite(timeoutMs) ? { timeoutMs: Math.max(1, timeoutMs) } : {}),
      ...(Number.isFinite(transportRemainingMs) ? { remainingMs: transportRemainingMs } : {}),
    });
  });
  let timer = null;
  let onAbort = null;
  let cancellationWon = false;
  const cancellation = new Promise((_, reject) => {
    onAbort = () => {
      cancellationWon = true;
      reject(cancellationError(signal, deadline) || controller.signal.reason || deadlineError());
    };
    if (signal?.aborted) onAbort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(remainingMs)) {
      timer = setTimeout(() => {
        const error = deadlineError();
        cancellationWon = true;
        abortWith(error);
        reject(error);
      }, remainingMs);
    }
  });
  try {
    return await Promise.race([request, cancellation]);
  } finally {
    if (cancellationWon) {
      await Promise.race([
        request.then(() => undefined, () => undefined),
        new Promise((resolve) => setTimeout(resolve, 0)),
      ]);
    }
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    signal?.removeEventListener?.('abort', abortFromParent);
  }
}
