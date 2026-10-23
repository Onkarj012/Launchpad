import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDedupKey, normalizeCandidate } from '../job-pull/candidate.mjs';
import { loadConfig, loadConversionPlan } from '../job-pull/config.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';
import { applicationReadiness } from '../job-pull/normal-readiness.mjs';

const cell = (value) => String(value ?? 'Not Verified').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
// Escape text before placing it in the HTML report.
const html = (value) => String(value ?? 'Not Verified').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Show each date with its source and original precision.
function dateEvidenceText(evidence) {
  if (!evidence || typeof evidence !== 'object') return 'Not Verified';
  return ['originalPublication', 'sourcePublication', 'catalogFirstSeen', 'localFirstSeen', 'updatedAt', 'lastObservation']
    .map((key) => {
      const field = evidence[key];
      return field?.value == null ? `${key}: Not Verified`
        : `${key}: ${field.value} (${field.source ?? 'Not Verified'}; ${field.precision ?? 'source-value'}; ${field.timezone ?? 'timezone Not Verified'})`;
    }).join('; ')
    + (Array.isArray(evidence.originalPublicationAlternates) && evidence.originalPublicationAlternates.length
      ? `; originalPublication alternatives: ${evidence.originalPublicationAlternates.map((item) => `${item.value} (${item.source ?? 'Not Verified'})`).join(', ')}` : '')
    + `; conflicts: ${(Array.isArray(evidence.conflicts) && evidence.conflicts.length ? evidence.conflicts.join(', ') : 'None recorded')}`;
}

// Prefer the final delivery outcome and reconciliation over the discovery envelope.
function reportRunStatus(result) {
  const normalize = (status) => status === 'fatal' ? 'failed' : status === 'ok' ? 'completed' : ['completed', 'partial', 'degraded', 'failed'].includes(status) ? status : null;
  const statuses = [
    normalize(result.outcome?.status),
    normalize(result.deliveryReconciliation?.status ?? result.terminalEnvelope?.deliveryReconciliation?.status),
    normalize(result.terminalEnvelope?.status),
  ];
  const incomplete = ['failed', 'degraded', 'partial'].find((status) => statuses.includes(status));
  if (incomplete) return incomplete;
  if (result.outcome?.status != null && statuses[0] == null) return 'Not Verified';
  return statuses.find(Boolean) ?? 'Not Verified';
}

const MODE_LABELS = Object.freeze({
  normal: Object.freeze({ label: 'Pune', roleTarget: 10, employerTarget: 6 }),
  startup: Object.freeze({ label: 'Startup', roleTarget: 5, employerTarget: 4 }),
  remote: Object.freeze({ label: 'Remote', roleTarget: 5, employerTarget: 4 }),
});

// Exclude separate lanes and unresolved rows from the full-time daily target units.
function countsTowardTarget(role) {
  const labels = [...(role.labels ?? []), ...(role.eligibility?.labels ?? [])];
  return role.selectionTier !== 'Stretch' && role.tier !== 'Stretch'
    && role.freshness?.window !== 'VerifyQueue' && role.freshnessTier !== 'VerifyQueue'
    && role.eligibility?.employment?.lane !== 'eor-contract'
    && !/^(EOR|Contract)$/i.test(role.employmentCategory ?? '')
    && !labels.some((label) => /^(EOR|Contract)$/i.test(label));
}

// Count retained role identities once across modes without collapsing missing URLs.
function uniqueRoles(roles) {
  return [...new Map(roles.map((role) => [role.key ?? candidateDedupKey(role), role])).values()];
}

// Keep this-run delivery and retained all-mode IST-day allocations in separate units.
function dailyReportUnits(result, now) {
  const budget = result.dailyShortlistBudget;
  const date = budget?.date ?? eventDate(now).slice(0, 10);
  const day = result.phaseTargetRollup?.days?.find((entry) => entry.date === date);
  const runRoles = uniqueRoles(Object.keys(MODE_LABELS).flatMap((mode) =>
    (result.modes?.[mode]?.shortlist ?? (result.mode === mode ? result.shortlist ?? [] : [])).filter(countsTowardTarget)));
  const cumulative = Array.isArray(budget?.cumulativeCandidates) ? uniqueRoles(budget.cumulativeCandidates.filter(countsTowardTarget)) : null;
  const modes = Object.entries(MODE_LABELS).map(([mode, config]) => {
    const roles = cumulative?.filter((role) => role.primaryMode === mode);
    const retained = day?.modes?.[mode];
    return { mode, ...config,
      roles: retained?.roles ?? roles?.length ?? null,
      employers: retained?.employers ?? (roles ? new Set(roles.map((role) => String(role.company ?? '').trim().toLowerCase()).filter(Boolean)).size : null),
      strict: retained?.strict ?? (roles ? roles.filter((role) => String(role.tier ?? role.selectionTier ?? '').toLowerCase() === 'strict').length : null),
    };
  });
  return { date, modes, runRoles, cumulative,
    focus: MODE_LABELS[result.mode]?.label ?? 'Not Verified',
    focusCount: Array.isArray(result.shortlist) ? result.shortlist.filter(countsTowardTarget).length : null,
    selectedToday: budget?.selectedToday ?? cumulative?.length ?? null,
    strictToday: budget?.strictSelected ?? day?.strict ?? (cumulative ? cumulative.filter((role) => String(role.tier ?? role.selectionTier ?? '').toLowerCase() === 'strict').length : null),
    remaining: budget?.remaining ?? null,
    historyVerified: day?.historyVerified,
    separate: { stretch: result.stretch?.length ?? 0, eorContract: result.modes?.eorContract?.shortlist?.length ?? 0, verification: result.verificationQueue?.length ?? 0 },
  };
}

// Display a target shortfall only when its retained count is known.
function targetShortfall(mode) {
  if (mode.roles === null || mode.employers === null) return 'Not Verified';
  const roles = Math.max(0, mode.roleTarget - mode.roles);
  const employers = Math.max(0, mode.employerTarget - mode.employers);
  return roles || employers ? `${roles} roles, ${employers} employers` : 'None';
}

// Read request counts from source telemetry without inferring missing requests.
function sourceRequests(source) {
  const details = source.detail ?? source;
  const candidates = [source.requests, details.requests, details.telemetry?.requests];
  return candidates.find(Number.isFinite) ?? null;
}

// Render only drift signals supported by retained run evidence.
function dailyDriftSignals(result) {
  const signals = [];
  const telemetry = { ...(result.sourceTelemetry ?? {}), ...(result.crawlerV2Telemetry ?? {}) };
  const textFor = (source) => JSON.stringify(source).toLowerCase();
  for (const [id, source] of Object.entries(telemetry)) {
    const evidence = textFor(source);
    if (/linkedin/.test(id.toLowerCase()) && /429|rate.limit/.test(evidence)) signals.push(`LinkedIn 429: ${id}`);
    if (/glassdoor/.test(id.toLowerCase()) && /403|forbidden/.test(evidence)) signals.push(`Glassdoor 403: ${id}`);
    const failedBoards = Number(source.boardsFailed ?? source.failed ?? source.detail?.boardsFailed ?? source.detail?.failed ?? source.detail?.telemetry?.boardsFailed ?? source.detail?.telemetry?.failed ?? source.detail?.failures?.length ?? 0);
    if (failedBoards > 0) signals.push(`${id}: ${failedBoards} board failure${failedBoards === 1 ? '' : 's'}`);
  }
  for (const [id, endState] of Object.entries({ ...(result.terminalEnvelope?.sourceEndStates ?? {}), ...(result.sourceEndStates ?? {}) })) {
    const evidence = `${endState.state ?? ''} ${endState.reason ?? ''}`.toLowerCase();
    if (/linkedin/.test(id.toLowerCase()) && /429|rate.limit/.test(evidence)) signals.push(`LinkedIn 429: ${id}`);
    if (/glassdoor/.test(id.toLowerCase()) && /403|forbidden/.test(evidence)) signals.push(`Glassdoor 403: ${id}`);
    if (/failed|http_[45]|transport/.test(evidence) && !/linkedin|glassdoor/.test(id.toLowerCase())) signals.push(`${id}: board failure`);
    if (['interrupted', 'truncated', 'degraded'].includes(endState.state)) signals.push(`${id}: ${endState.state}, ${endState.reason ?? 'Not Verified'}`);
  }
  for (const entry of result.scorerVariance ?? result.scoring?.variance ?? []) {
    const previous = entry.previous ?? entry.previousScore;
    const current = entry.current ?? entry.currentScore;
    if (Number.isFinite(previous) && Number.isFinite(current)) signals.push(`Scorer variance: ${entry.role ?? entry.title ?? 'Role'} ${previous} to ${current}`);
  }
  return [...new Set(signals)];
}

const FAILED_SCORING_REASONS = new Set(['scoring-failed', 'scoring-retry-exhausted']);

// Count scoring retry records by the outcome the report names. Carried rows came from an earlier run.
function scoringRecoveryCounts(records) {
  const current = records.filter((record) => !record.carried);
  const count = (test) => current.filter(test).length;
  const failed = (record) => FAILED_SCORING_REASONS.has(record.outcomeReason);
  return {
    recovered: count((record) => record.outcome === 'recovered'),
    selected: count((record) => record.outcome === 'selected'),
    scoringFailed: count((record) => failed(record) && record.attemptCount === 1),
    failedAgain: count((record) => failed(record) && record.attemptCount > 1),
    waiting: count((record) => record.outcome === 'pending' && record.outcomeReason === 'awaiting-current-evidence'),
    terminal: count((record) => record.outcome === 'terminal'),
  };
}

// Write the scoring recovery counts as one sentence.
function scoringRecoverySummary(records) {
  const counts = scoringRecoveryCounts(records);
  return `Recovered: ${counts.recovered}. Selected: ${counts.selected}. Scoring failed: ${counts.scoringFailed}. Failed again: ${counts.failedAgain}. Waiting for current evidence: ${counts.waiting}. Terminal: ${counts.terminal}.`;
}

// Name a retry row's reason, and say so when the row came from an earlier run.
function recoveryReason(record) {
  return record.carried ? `previous run: ${record.outcomeReason.replace(/-previous-run$/, '')}` : record.outcomeReason;
}

// Render the scoring recovery counts and one row per retry record, or nothing without records.
function scoringRecoveryHtml(records) {
  if (!records.length) return '';
  const rows = records.map((record) => `<tr><td>${html(record.company)}</td><td>${html(record.title)}</td><td>${html(record.outcome)}</td><td>${html(recoveryReason(record))}</td><td>${html(record.attemptCount)}</td><td>${html(record.attemptedAt)}</td><td>${html(record.nextEligibleAt ?? 'Not scheduled')}</td></tr>`).join('');
  return `<section data-section="scoring-recovery"><h2>Scoring recovery</h2><p>${html(scoringRecoverySummary(records))}</p><table><thead><tr><th>Company</th><th>Title</th><th>Outcome</th><th>Reason</th><th>Attempts</th><th>Attempted</th><th>Earliest retry (not enforced)</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

// Display timezone-backed timestamps in IST and preserve date-only precision.
function eventDate(value) {
  if (value == null) return 'Not Verified';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} IST`;
}

// Name the last successful snapshot of an incomplete source. Unknown snapshots stay Not Verified.
function snapshotClause(state, snapshot) {
  if (['ok', 'empty', 'disabled'].includes(state)) return '';
  if (!snapshot?.lastSuccessfulAt || snapshot.ageHours == null) return 'last successful snapshot Not Verified';
  return `last successful snapshot ${eventDate(snapshot.lastSuccessfulAt)} (${snapshot.ageHours.toFixed(1)} h old), not current`;
}

/** Render retained operator observations; never score or persist a lifecycle. */
export function renderLocalLeadReport(result, { now = result.run?.startedAt ?? new Date().toISOString(), policy = null } = {}) {
  const effectivePolicy = policy ?? { ...loadConfig(), salaryFloorLpa: loadConversionPlan().salaryFloorLpa };
  const buckets = { strictReady: [], fallbackReady: [], verification: [], rejected: [] };
  for (const raw of result.observations ?? []) {
    const missingRecoveryIdentity = raw.evidence?.recovery?.kind === 'held-lead-recovery'
      ? [!raw.company ? 'EMPLOYER_NOT_VERIFIED' : null, !raw.title ? 'ROLE_NOT_VERIFIED' : null].filter(Boolean)
      : [];
    if (missingRecoveryIdentity.length) {
      buckets.verification.push({
        candidate: raw,
        eligibility: { reasons: [], experience: { manualReview: false, code: null } },
        freshness: { window: 'VerifyQueue', eligible: false, code: 'FRESHNESS_NOT_VERIFIED' },
        readiness: { reasons: missingRecoveryIdentity },
        reasons: [],
        verificationReasons: missingRecoveryIdentity,
      });
      continue;
    }
    const candidate = normalizeCandidate(raw, { runAt: now });
    const eligibility = classifyCandidate(candidate, effectivePolicy);
    const freshness = classifyFreshness(candidate, { now, ...effectivePolicy.freshness });
    const readiness = applicationReadiness(candidate, eligibility);
    const missingRecoveryFacts = raw.evidence?.recovery?.kind === 'held-lead-recovery' ? [
      !raw.company ? 'EMPLOYER_NOT_VERIFIED' : null,
      !raw.title ? 'ROLE_NOT_VERIFIED' : null,
      !raw.location ? 'LOCATION_NOT_VERIFIED' : null,
      !raw.employment?.type ? 'EMPLOYMENT_NOT_VERIFIED' : null,
    ].filter(Boolean) : [];
    const reasons = [...eligibility.reasons,
      ...(freshness.eligible === false && freshness.window !== 'VerifyQueue' ? [freshness.code ?? 'FRESHNESS_REJECTED'] : [])];
    const row = { candidate, eligibility, freshness, readiness, reasons };
    const recoveryFactsUnverified = missingRecoveryFacts.length > 0;
    const recoveryHasOnlyUnverifiedFacts = recoveryFactsUnverified && eligibility.reasons.every((reason) =>
      /NOT_VERIFIED/.test(reason) || (!raw.title && reason === 'TITLE_OFF_TARGET'));
    if (recoveryHasOnlyUnverifiedFacts && eligibility.experience.code !== 'EXPERIENCE_HARD_MIN_3_PLUS'
      && !(freshness.eligible === false && freshness.window !== 'VerifyQueue')) {
      row.verificationReasons = missingRecoveryFacts;
      buckets.verification.push(row);
    }
    else if (reasons.length) buckets.rejected.push(row);
    else if (readiness.ready && freshness.eligible) buckets[eligibility.strict ? 'strictReady' : 'fallbackReady'].push(row);
    else buckets.verification.push(row);
  }
  const lines = ['# Local lead handoff', '', `Observed at ${now}. Public evidence only. No scores, applications, outreach or store delivery.`, '',
    `Strict ready: ${buckets.strictReady.length}. Shortage fallback ready: ${buckets.fallbackReady.length}. Needs verification: ${buckets.verification.length}. Rejected: ${buckets.rejected.length}.`, ''];
  const heldRecovery = result.heldLeadRecovery ?? result.crawlerV2Telemetry?.['portal-discovery']?.detail?.telemetry?.heldLeadRecovery;
  if (heldRecovery) {
    lines.push('## Recovery of already known leads', '',
      `Recovered: ${heldRecovery.recovered ?? 0}. Blocked: ${heldRecovery.blocked ?? 0}. Missing: ${heldRecovery.missing ?? 0}. Mismatched: ${heldRecovery.mismatched ?? 0}. Failed: ${heldRecovery.failed ?? 0}. Unattempted: ${heldRecovery.unattempted ?? 0}. Waiting for retry: ${heldRecovery.waiting ?? 0}.`,
      `Raw requested: ${heldRecovery.rawRequested ?? heldRecovery.requested ?? 0}. Distinct: ${heldRecovery.distinct ?? 'Not Verified'}. Duplicate inputs: ${heldRecovery.duplicates ?? 'Not Verified'}. Already in current discovery: ${heldRecovery.alreadyDiscovered ?? 'Not Verified'}.`,
      `Request budget exhausted: ${heldRecovery.requestBudgetExhausted === true ? 'Yes' : 'No'}. Deadline exhausted: ${heldRecovery.deadlineExhausted === true ? 'Yes' : 'No'}. Continuation pending: ${heldRecovery.continuation === true ? 'Yes' : 'No'}.`,
      `Historical V4 snapshot: ${cell(result.v4HistorySnapshot?.status ?? 'Not Verified')}. Recovery alone does not establish history novelty.`,
      'These outcomes describe retained leads. They do not count as new discovery or new market supply.', '');
    for (const outcome of heldRecovery.outcomes ?? []) lines.push(`- ${cell(outcome.lead)}: ${cell(outcome.outcome)} / ${cell(outcome.reason)}; retained ${cell(outcome.recoveryState ?? 'Not Verified')}, attempts ${outcome.attemptCount ?? 0}, attempted ${cell(outcome.attemptedAt ?? 'Not attempted')}, retry ${cell(outcome.nextEligibleAt ?? 'Not scheduled')}; requests ${outcome.requests ?? 0}; discovery ${cell(outcome.originalDiscoverySource ?? 'Not Verified')} ${cell(outcome.originalDiscoveryUrl ?? 'Not Verified')}; employer route ${cell(outcome.employerDetailUrl ?? 'Not Verified')}; missing facts ${cell(outcome.missingFields?.join(', ') || 'None recorded')}.`);
    if (!heldRecovery.outcomes?.length) lines.push('- No held lead recovery was attempted.');
    lines.push('');
  }
  const scoringRecords = result.scoringRetry?.records ?? [];
  if (scoringRecords.length) {
    lines.push('## Scoring recovery', '', scoringRecoverySummary(scoringRecords), '',
      '| Company | Title | Outcome | Reason | Attempts | Attempted | Earliest retry (not enforced) |',
      '| --- | --- | --- | --- | ---: | --- | --- |');
    for (const record of scoringRecords) lines.push(`| ${cell(record.company)} | ${cell(record.title)} | ${cell(record.outcome)} | ${cell(recoveryReason(record))} | ${cell(record.attemptCount)} | ${cell(record.attemptedAt)} | ${cell(record.nextEligibleAt ?? 'Not scheduled')} |`);
    lines.push('');
  }
  if (result.modes && typeof result.modes === 'object') {
    const units = dailyReportUnits(result, now);
    lines.push('## This-run allocation and focus delivery', '',
      `Requested-mode delivery focus: ${units.focus}. This-run focus delivery: ${units.focusCount ?? 'Not Verified'} roles.`,
      `This-run all-mode allocation: ${units.runRoles.length} roles.`, '',
      `## Per-mode daily targets (IST ${units.date})`, '',
      'Counts are cumulative completed allocations across modes and schedules for this IST day.', '',
      '| Mode | Roles / target | Employers / target | Strict | Shortfall |',
      '| --- | ---: | ---: | ---: | --- |');
    for (const mode of units.modes) {
      lines.push(`| ${mode.mode === 'normal' ? 'Pune (normal)' : mode.label} | ${mode.roles ?? 'Not Verified'}/${mode.roleTarget} | ${mode.employers ?? 'Not Verified'}/${mode.employerTarget} | ${mode.strict ?? 'Not Verified'} | ${targetShortfall(mode)} |`);
    }
    lines.push('', `Cumulative all-mode roles today: ${units.selectedToday ?? 'Not Verified'}/20 maximum. Remaining daily capacity: ${units.remaining ?? 'Not Verified'}.`,
      `Cumulative Strict across modes today: ${units.strictToday ?? 'Not Verified'}, phase target 2.`,
      `Historical suppression evidence: ${units.historyVerified === true ? 'Verified' : 'Not Verified'}.`, '',
      '## Separate lanes outside daily role targets', '',
      `This-run Stretch: ${units.separate.stretch}. EOR / Contract: ${units.separate.eorContract}. VerifyQueue: ${units.separate.verification}.`, '');
  }
  const table = (name, rows) => {
    lines.push(`## ${name}`, '');
    if (!rows.length) { lines.push('None.', ''); return; }
    lines.push('| Role / company | Public URL | JD excerpt | Portal date / freshness | Date evidence | Salary | Experience | Application / liveness / applied | Exact reasons |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const { candidate: c, eligibility: e, freshness: f, readiness: r } = row;
      const reasonList = [...row.reasons, ...(row.verificationReasons ?? []),
        ...(!row.reasons.length ? r.reasons : []),
        ...(e.experience.manualReview ? [e.experience.code] : []),
        ...(!c.description ? ['PORTAL_DESCRIPTION_MISSING'] : []),
        ...(c.evidence?.resolution?.reason ? [c.evidence.resolution.reason] : []),
        ...(f.eligible ? [] : [f.code ?? 'FRESHNESS_NOT_VERIFIED'])];
      lines.push(`| ${cell(c.title)} / ${cell(c.company)} | ${cell(c.discoveryUrl ?? c.canonicalUrl)} | ${cell(c.description || 'Not Verified').slice(0, 240)} | ${cell(c.postedAt)} / ${cell(f.window)} | ${cell(dateEvidenceText(c.dateEvidence ?? c.evidence?.dateEvidence))} | ${cell(c.salary?.evidence || 'Not Verified')} | ${cell(e.experience.evidence || 'Not stated; manual review')} | ${cell(c.applicationResolution?.status)} / ${cell(c.liveness?.status)} / Applied?: Not Verified | ${cell([...new Set(reasonList)].join('; ') || 'Ready, unscored')} |`);
    }
    lines.push('');
  };
  table('Strict ready, unscored', buckets.strictReady);
  table('Shortage fallback ready, unscored', buckets.fallbackReady);
  table('Needs verification', buckets.verification);
  table('Rejected', buckets.rejected);
  if (result.experienceDecisions?.length) {
    lines.push('## Experience decisions', '', '| Role / company | Decision | Selected track | Requirement evidence |', '| --- | --- | --- | --- |');
    for (const { candidate, eligibility } of result.experienceDecisions) {
      const decision = eligibility.experience;
      const evidence = [...new Set((decision.requirements || []).map((item) => item.excerpt).filter(Boolean))].join(' | ') || decision.evidence || 'Not Verified';
      lines.push(`| ${cell(candidate.title)} / ${cell(candidate.company)} | ${cell(decision.code)} | ${cell(decision.selectedTrack || 'Not Verified')} | ${cell(evidence)} |`);
    }
    lines.push('');
  }
  if (result.hiringEvents?.items?.length || result.hiringEvents?.quarantine?.length) {
    lines.push('## Hiring challenges and off-campus drives', '',
      'Timestamps use IST. Date-only values have no verified time. These items do not count toward role targets.', '',
      '| Kind | Item | Company | Public URL | Event date | Deadline |',
      '| --- | --- | --- | --- | --- | --- |');
    for (const item of result.hiringEvents.items ?? []) {
      const kind = item.kind === 'hiring-challenge' ? 'Hiring challenge' : 'Off-campus drive';
      lines.push(`| ${kind} | ${cell(item.title)} | ${cell(item.company)} | ${cell(item.url)} | ${eventDate(item.date)} | ${eventDate(item.deadline)} |`);
    }
    lines.push('');
    for (const entry of result.hiringEvents.quarantine ?? []) lines.push(`- Held item ${entry.index + 1}: ${cell(entry.errors.join('; '))}.`);
    lines.push('');
  }
  const counts = {};
  for (const row of buckets.rejected) for (const reason of row.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  lines.push('## Rejection counts', '', ...Object.entries(counts).map(([reason, count]) => `- ${reason}: ${count}`));
  if (!Object.keys(counts).length) lines.push('None.');
  lines.push('', '## Source limits and failures', '');
  for (const [id, source] of Object.entries(result.sourceTelemetry ?? {})) {
    const telemetry = source.detail?.telemetry ?? source.manifest?.telemetry ?? {};
    lines.push(`- ${cell(id)}: ${cell(source.status)} / ${cell(source.detail?.status ?? source.manifest?.status)}; fetched ${source.fetched ?? 0}; detail/resolver GETs ${telemetry.resolutionRequests ?? 0}/${telemetry.maxRequests ?? 'unknown'}; candidate cap ${telemetry.maxCandidates ?? 'unknown'}; truncated ${Boolean(source.truncated || telemetry.truncated)}.`);
    for (const error of [...new Set([source.error, ...(source.detail?.errors ?? []), ...(source.manifest?.errors ?? [])].filter(Boolean))]) lines.push(`  - ${cell(error)}`);
  }
  for (const [id, endState] of Object.entries(result.sourceEndStates ?? result.terminalEnvelope?.sourceEndStates ?? {})) {
    if (!['ok', 'empty', 'disabled'].includes(endState.state)) lines.push(`- ${cell(id)}: ${cell(endState.state)}; ${cell(endState.reason)}; ${cell(snapshotClause(endState.state, result.sourceSnapshotAges?.[id]))}.`);
  }
  if (result.error) lines.push(`- ${cell(result.error)}`);
  const terminal = result.terminalEnvelope ?? {};
  const errors = result.outcome?.errors ?? [];
  const runStatus = reportRunStatus(result);
  const runCause = terminal.fatalReason ?? result.outcome?.fatalReason ?? (errors.map((error) => error?.message ?? error).filter(Boolean).join('; ') || 'Not Verified');
  lines.push('', '## Run status', '', `Status: ${cell(runStatus)}.`, `Cause: ${cell(runCause)}.`);
  for (const error of errors) lines.push(`- ${cell(error?.message ?? error)}`);
  const coverage = terminal.sourceCoverage ?? result.sourceCoverage ?? {};
  const durable = terminal.lastDurableSourceState ?? result.lastDurableSourceState ?? {};
  for (const group of ['completed', 'interrupted', 'failed', 'not_started']) {
    const sources = coverage[group] ?? durable[group];
    lines.push(`- ${group.replace('_', ' ')}: ${Array.isArray(sources) ? sources.map(cell).join(', ') || 'None recorded' : 'Not Verified'}`);
  }
  lines.push('');
  if (result.dailyReceipt) {
    const receipt = result.dailyReceipt;
    lines.push('## Daily stage-loss receipt', '',
      `Raw observations: ${receipt.scopes.rawObservations.count}. Unique requisitions: ${receipt.scopes.uniqueRequisitions.count}. Verification: ${receipt.scopes.verification.count}. Hard rejection: ${receipt.scopes.hardRejection.count}. Scoring failure: ${receipt.scopes.scoringFailure.count}. History suppression: ${receipt.scopes.historySuppression.count}. Final selection: ${receipt.scopes.finalSelection.count}. Confirmed delivery: ${receipt.scopes.confirmedDelivery.count}.`,
      `Implementation state: ${receipt.provenance.implementationState}. Implementation hash: ${receipt.provenance.implementationHash}. Retained input hash: ${receipt.provenance.retainedInputHash}. Release claim: none.`, '',
      '| Requisition hash | Stage | Reason | Provider | Source provenance | Selected |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of receipt.retained.identityRows === 'Not Verified' ? [] : receipt.retained.identityRows) {
      const provenance = row.provenance?.map((item) => [item.source, item.sourceId].filter(Boolean).join(' / ')).filter(Boolean).join(', ') || row.source;
      lines.push(`| ${cell(row.identityHash)} | ${cell(row.stage)} | ${cell(row.reason)} | ${cell(row.provider)} | ${cell(provenance)} | ${row.selected ? 'Yes' : 'No'} |`);
    }
    if (receipt.retained.identityRows === 'Not Verified') lines.push('| Not Verified | Not Verified | Not Verified | Not Verified | Not Verified | Not Verified |');
    lines.push('', `Source coverage: ${cell(JSON.stringify(receipt.run.sourceCoverage ?? result.terminalEnvelope?.sourceCoverage ?? 'Not Verified'))}.`, '');
  }
  return lines.join('\n');
}

// Render daily mode results and their shortlists without changing run state.
export function renderLocalDailyHtmlReport(result, { now = result.runAt ?? result.run?.startedAt ?? new Date().toISOString() } = {}) {
  const targetModes = Object.entries(MODE_LABELS).map(([mode, config]) => [mode, config.label]);
  const modes = [...targetModes, ['eorContract', 'EOR / Contract']];
  const modeRuns = result.modes ?? {};
  const telemetry = { ...(result.sourceTelemetry ?? {}), ...(result.crawlerV2Telemetry ?? {}) };
  const units = dailyReportUnits(result, now);
  const uniqueShortlist = units.runRoles;
  const lifecycle = result.funnel?.lifecycle ?? {};
  const counts = result.counts ?? {};
  // Choose the first available count without inferring missing values.
  const readCount = (...values) => values.find((value) => Number.isFinite(value)) ?? null;
  const strictCount = uniqueShortlist.filter((role) => role.selectionTier === 'Strict' || role.eligibility?.strict === true).length;
  const employers = new Set(uniqueShortlist.map((role) => String(role.company ?? '').trim().toLowerCase()).filter(Boolean));
  const funnel = [
    ['Fetched', readCount(counts.fetched, lifecycle.fetched)],
    ['Eligible', readCount(counts.eligible, lifecycle.eligible)],
    ['Passed gates', readCount(counts.gatePassing, lifecycle.gatePassing, lifecycle.eligible)],
    ['Ready', readCount(counts.ready, lifecycle.ready)],
    ['Scored', readCount(counts.scored, lifecycle.scored)],
    ['Shortlisted', uniqueShortlist.length],
    ['Employers represented', employers.size],
    ['Strict', strictCount],
  ];
  // Render one role card with its evidence, labels, and employer apply link.
  const roleCard = (role, isShortlist) => {
    const labels = [...new Set([...(role.labels ?? []), ...(role.eligibility?.labels ?? [])])];
    const experienceDecision = role.evidence?.experienceDecision;
    const experienceEvidence = experienceDecision
      ? `<p>Experience: ${html(experienceDecision.code)}; selected track ${html(experienceDecision.selectedTrack || 'Not Verified')}. ${html(experienceDecision.evidence || '')} ${html((experienceDecision.requirements || []).map((item) => item.excerpt).filter(Boolean).join(' | '))}</p>`
      : '';
    const rawApplyUrl = role.originalApplicationUrl ?? null;
    const applyUrl = typeof rawApplyUrl === 'string' && /^https?:\/\//i.test(rawApplyUrl) ? rawApplyUrl : null;
    const extraModes = (role.otherModes ?? []).map((mode) => MODE_LABELS[mode]?.label ?? mode);
    const why = role.rationale ?? role.strongestHook ?? role.eligibility?.evidence ?? '';
    return `<article><h4>${html(role.title)} at ${html(role.company)}</h4><p>${html(role.location)}</p><p>Discovery URL: ${html(role.discoveryUrl ?? role.canonicalUrl ?? 'Not Verified')}; employer detail URL: ${html(role.employerDetailUrl ?? role.evidence?.detailUrl ?? 'Not Verified')}; final apply URL: ${html(role.finalApplyUrl ?? 'Not Verified')}</p><p>Posting date: ${html(role.postedAt ?? 'Not Verified')}; date evidence: ${html(dateEvidenceText(role.dateEvidence ?? role.evidence?.dateEvidence))}</p>${experienceEvidence}${role.selectionTier ? `<p>Selection tier: ${html(role.selectionTier)}</p>` : ''}${isShortlist ? `<p><strong>Why it fits:</strong> ${html(String(why || 'Not Verified').replace(/\s+/g, ' ').trim())}</p>` : ''}${labels.length ? `<p>Labels: ${labels.map(html).join(', ')}</p>` : ''}${extraModes.length ? `<p>Other modes: ${extraModes.map(html).join(', ')}</p>` : ''}${applyUrl ? `<p><a href="${html(applyUrl)}">Apply at employer</a></p>` : '<p>Apply link: Not Verified</p>'}</article>`;
  };
  const sections = modes.map(([mode, label]) => {
    const run = modeRuns[mode] ?? (result.mode === mode ? { results: result.results ?? [], shortlist: result.shortlist ?? [] } : {});
    return `<section data-mode="${mode}"><h2>${label}</h2><h3>Full results</h3>${(run.results ?? []).map((role) => roleCard(role, false)).join('') || '<p>None.</p>'}<h3>Shortlist</h3>${(run.shortlist ?? []).map((role) => roleCard(role, true)).join('') || '<p>None.</p>'}</section>`;
  }).join('');
  const targetRows = units.modes.map((mode) => {
    return `<tr><td>${mode.label}</td><td>${mode.roles ?? 'Not Verified'}/${mode.roleTarget}</td><td>${mode.employers ?? 'Not Verified'}/${mode.employerTarget}</td><td>${mode.strict ?? 'Not Verified'}</td><td>${targetShortfall(mode)}</td></tr>`;
  }).join('');
  const targets = `<section data-section="targets"><h2>Per-mode daily targets</h2><p>Cumulative completed allocations across modes and schedules for IST ${html(units.date)}.</p><p>Cumulative all-mode roles today: ${units.selectedToday ?? 'Not Verified'}/20 maximum. Remaining daily capacity: ${units.remaining ?? 'Not Verified'}. Cumulative Strict across modes today: ${units.strictToday ?? 'Not Verified'}, phase target 2.</p><p>Historical suppression evidence: ${units.historyVerified === true ? 'Verified' : 'Not Verified'}.</p><table><thead><tr><th>Mode</th><th>Roles / target</th><th>Employers / target</th><th>Strict</th><th>Shortfall</th></tr></thead><tbody>${targetRows}</tbody></table></section>`;
  const phaseRollup = result.phaseTargetRollup;
  const phaseSummaryRows = Object.entries(MODE_LABELS).map(([mode, config]) => {
    const summary = phaseRollup?.modes?.[mode];
    const status = summary?.phaseTargetMet ? 'Phase target met' : 'Phase target not met';
    return `<tr><td>${config.label}</td><td>${summary?.daysMet ?? 0}/7</td><td>${status}</td></tr>`;
  }).join('');
  const phaseDayRows = (phaseRollup?.days ?? []).map((day) => {
    const cells = Object.keys(MODE_LABELS).map((mode) => {
      const counts = day.modes?.[mode];
      return `<td>${counts ? `Roles ${counts.roles}, employers ${counts.employers}, Strict ${counts.strict}${counts.met ? ', target met' : ', target not met'}` : 'no run'}</td>`;
    }).join('');
    return `<tr><td>${html(day.date)}</td>${cells}<td>${day.strict ?? 'Not Verified'}</td><td>${day.historyVerified === true ? 'Verified' : 'Not Verified'}</td></tr>`;
  }).join('');
  const phaseTargets = phaseRollup ? `<section data-section="phase-target-rollup"><h2>Phase target, 5 of 7 consecutive IST days</h2><p>Seven-day window ending ${html(phaseRollup.endDate)}. Each day's counts combine completed allocations. Target attainment requires two Strict roles across modes and verified historical suppression evidence.</p><table><thead><tr><th>Mode</th><th>Days met / 7</th><th>Phase status</th></tr></thead><tbody>${phaseSummaryRows}</tbody></table><table><thead><tr><th>IST date</th><th>Pune</th><th>Startup</th><th>Remote</th><th>Strict across modes</th><th>Historical suppression evidence</th></tr></thead><tbody>${phaseDayRows}</tbody></table></section>` : '';
  const stretch = `<section data-section="stretch"><h2>Stretch</h2>${(result.stretch ?? []).map((role) => roleCard(role, true)).join('') || '<p>None.</p>'}</section>`;
  const separate = `<section data-section="separate-lanes"><h2>Separate lanes outside daily role targets</h2><p>This-run Stretch: ${units.separate.stretch}. EOR / Contract: ${units.separate.eorContract}. VerifyQueue: ${units.separate.verification}.</p></section>`;
  const verification = `<section data-section="verification"><h2>VerifyQueue</h2><p>These roles do not count toward daily targets.</p>${(result.verificationQueue ?? []).map((role) => roleCard(role, false)).join('') || '<p>None.</p>'}</section>`;
  const experienceDecisions = `<section data-section="experience-decisions"><h2>Experience decisions</h2>${(result.experienceDecisions ?? []).map(({ candidate, eligibility }) => {
    const decision = eligibility.experience;
    const excerpts = [...new Set((decision.requirements ?? []).map((item) => item.excerpt).filter(Boolean))];
    return `<article><h3>${html(candidate.title)} at ${html(candidate.company)}</h3><p>${html(decision.code)}; selected track: ${html(decision.selectedTrack || 'Not Verified')}</p><p>${html(decision.evidence || 'Not Verified')}</p>${excerpts.map((excerpt) => `<p>${html(excerpt)}</p>`).join('')}</article>`;
  }).join('') || '<p>None.</p>'}</section>`;
  const envelope = result.terminalEnvelope ?? {};
  const endStates = { ...(envelope.sourceEndStates ?? {}), ...(result.sourceEndStates ?? {}) };
  const coverage = envelope.sourceCoverage ?? result.sourceCoverage ?? {};
  const lastDurable = envelope.lastDurableSourceState ?? result.lastDurableSourceState ?? {};
  const coverageGroups = ['completed', 'interrupted', 'failed', 'not_started'];
  const sourceCoverage = coverageGroups.map((group) => {
    const sources = coverage[group] ?? lastDurable[group];
    return `<p><strong>${html(group.replace('_', ' '))}:</strong> ${Array.isArray(sources) && sources.length ? sources.map(html).join(', ') : Array.isArray(sources) ? 'None recorded' : 'Not Verified'}</p>`;
  }).join('');
  const durableDetail = Object.entries(lastDurable).filter(([key]) => !coverageGroups.includes(key))
    .map(([id, source]) => `<p>Last durable source state: ${html(id)}: ${html(source?.status)}; fetched ${html(source?.fetched)}.</p>`).join('');
  const endStateLines = Object.entries(endStates).map(([id, source]) => {
    const clause = snapshotClause(source.state, result.sourceSnapshotAges?.[id]);
    return `<p>${html(id)}: ${html(source.state)}${source.reason ? `, ${html(source.reason)}` : ''}${clause ? `; ${html(clause)}` : ''}</p>`;
  }).join('');
  const sourceFailures = `<section data-section="source-failures"><h2>Source coverage and end states</h2>${sourceCoverage}${durableDetail}${endStateLines || '<p>Source end states: Not Verified</p>'}</section>`;
  const errorItems = result.outcome?.errors ?? [];
  const fatalReason = envelope.fatalReason ?? result.outcome?.fatalReason ?? null;
  const runStatus = reportRunStatus(result);
  const runCause = fatalReason ?? (errorItems.map((error) => error?.message ?? error).filter(Boolean).join('; ') || 'Not Verified');
  const errors = `<section data-section="run-status"><h2>Run status</h2><p>Status: ${html(runStatus)}</p><p>Cause: ${html(runCause)}</p>${errorItems.length ? `<ul>${errorItems.map((error) => `<li>${html(error?.message ?? error)}</li>`).join('')}</ul>` : ''}</section>`;
  const hiringEvents = result.hiringEvents?.items ?? [];
  const events = `<section data-section="hiring-events"><h2>Hiring events</h2><p>Times use IST. Date-only entries have no verified time. Events do not count toward role targets.</p>${hiringEvents.length ? hiringEvents.map((item) => `<p>${html(item.title)}: ${html(eventDate(item.date))}. Deadline: ${html(eventDate(item.deadline))}.</p>`).join('') : '<p>Not Verified</p>'}</section>`;
  const yieldRows = (result.sourceYield?.sources ?? []).map((row) => {
    // Compare the retained board identity before using its request count.
    const matchesBoard = (entry) => `${entry.provider}:${entry.board}`.toLowerCase() === row.sourceId.toLowerCase();
    const matchingTelemetry = Object.entries(telemetry).find(([id, source]) => id === row.sourceId || source.detail?.sources?.some(matchesBoard));
    const boardTelemetry = matchingTelemetry?.[1].detail?.sources?.find(matchesBoard);
    const requests = boardTelemetry ? sourceRequests(boardTelemetry) : matchingTelemetry ? sourceRequests(matchingTelemetry[1]) : null;
    const rate = requests == null ? 'Not Verified' : `${row.applicationReady ?? 0} application-ready roles / ${requests} requests`;
    return `<tr><td>${html(row.sourceId)}</td><td>${row.fetched ?? 0}</td><td>${row.applicationReady ?? 0}</td><td>${requests ?? 'Not Verified'}</td><td>${rate}</td></tr>`;
  }).join('');
  const sourceYield = `<section data-section="source-yield"><h2>Source yield per request</h2>${result.sourceYieldScope === 'crawler-discovery' ? '<p>Discovery counts precede final enrichment and scoring. They exclude later tracked-source reads and do not measure delivered roles.</p>' : ''}${yieldRows ? `<table><thead><tr><th>Source</th><th>Fetched</th><th>Application-ready</th><th>Requests</th><th>Yield</th></tr></thead><tbody>${yieldRows}</tbody></table>` : '<p>Not Verified</p>'}</section>`;
  const driftSignals = dailyDriftSignals(result);
  const scoringRecovery = scoringRecoveryHtml(result.scoringRetry?.records ?? []);
  const drift = `<section data-section="drift"><h2>Drift signals</h2>${driftSignals.length ? `<ul>${driftSignals.map((signal) => `<li>${html(signal)}</li>`).join('')}</ul>` : '<p>None recorded.</p>'}</section>`;
  const receipt = result.dailyReceipt;
  const receiptSection = receipt ? `<section data-section="daily-stage-loss-receipt"><h2>Daily stage-loss receipt</h2><p>Raw observations: ${html(receipt.scopes.rawObservations.count)}. Unique requisitions: ${html(receipt.scopes.uniqueRequisitions.count)}. Verification: ${html(receipt.scopes.verification.count)}. Hard rejection: ${html(receipt.scopes.hardRejection.count)}. Scoring failure: ${html(receipt.scopes.scoringFailure.count)}. History suppression: ${html(receipt.scopes.historySuppression.count)}. Final selection: ${html(receipt.scopes.finalSelection.count)}. Confirmed delivery: ${html(receipt.scopes.confirmedDelivery.count)}.</p><p>Implementation state: ${html(receipt.provenance.implementationState)}. Implementation hash: ${html(receipt.provenance.implementationHash)}. Retained input hash: ${html(receipt.provenance.retainedInputHash)}. Release claim: none.</p><table><thead><tr><th>Requisition hash</th><th>Stage</th><th>Reason</th><th>Provider</th><th>Source provenance</th><th>Selected</th></tr></thead><tbody>${(Array.isArray(receipt.retained.identityRows) ? receipt.retained.identityRows : []).map((row) => {
    const provenance = row.provenance?.map((item) => [item.source, item.sourceId].filter(Boolean).join(' / ')).filter(Boolean).join(', ') || row.source;
    return `<tr><td>${html(row.identityHash)}</td><td>${html(row.stage)}</td><td>${html(row.reason)}</td><td>${html(row.provider)}</td><td>${html(provenance)}</td><td>${row.selected ? 'Yes' : 'No'}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Not Verified</td></tr>'}</tbody></table></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Launchpad daily report</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212f}section{border-top:1px solid #ccd3dc;padding:1rem 0}article{padding:.5rem 1rem;margin:.5rem 0;background:#f5f7fa}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem;border-bottom:1px solid #ccd3dc}h1,h2{margin-bottom:.3rem}@media(max-width:640px){body{margin:1rem auto;padding:0 .75rem}table{display:block;overflow-x:auto;white-space:nowrap}article{padding:.5rem .75rem}}</style></head><body><h1>Launchpad daily report</h1><p>Run time: ${html(eventDate(now))}</p>${errors}${['failed', 'partial'].includes(runStatus) ? sourceFailures : ''}<section data-section="focus-delivery"><h2>This-run allocation and focus delivery</h2><p>Requested-mode delivery focus: ${html(units.focus)}. This-run focus delivery: ${units.focusCount ?? 'Not Verified'} roles. This-run all-mode allocation: ${units.runRoles.length} roles.</p></section><section><h2>This-run funnel counts</h2><ul>${funnel.map(([label, value]) => `<li>${label}: ${value ?? 'Not Verified'}</li>`).join('')}</ul></section>${receiptSection}${scoringRecovery}${targets}${phaseTargets}${separate}${sections}${stretch}${verification}${experienceDecisions}${sourceYield}${['failed', 'partial'].includes(runStatus) ? '' : sourceFailures}${events}${drift}</body></html>`;
}

// Write the rendered daily report to the caller-selected local file.
export function writeLocalDailyHtmlReport(result, output, options = {}) {
  if (typeof output !== 'string' || !output.trim()) throw new TypeError('daily report output path is required');
  fs.writeFileSync(output, renderLocalDailyHtmlReport(result, options), 'utf8');
  return output;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4) throw new Error('Usage: node crawler/local-lead-report.mjs INPUT.json OUTPUT.md|OUTPUT.html');
  const result = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (path.extname(output).toLowerCase() === '.html') writeLocalDailyHtmlReport(result, output);
  else fs.writeFileSync(output, renderLocalLeadReport(result, { now: result.runAt ?? result.run?.startedAt }));
}
