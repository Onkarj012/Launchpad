function keyOf(operation) { return String(operation?.dedupKey ?? operation?.payload?.dedupKey ?? operation?.payload?.['Dedup Key'] ?? ''); }

const REDACTED = '[REDACTED]';

function sensitiveKey(key) { return /token|secret|password|authorization|credential|api[-_]?key/i.test(String(key)); }

function redactSensitive(value, secrets = []) {
  const secretValues = secrets.filter(Boolean).map((secret) => String(secret));
  if (typeof value === 'string') {
    let output = value;
    for (const secret of secretValues) output = output.split(secret).join(REDACTED);
    return output.replace(/(Bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`).replace(/((?:token|secret|password|authorization|api[-_]?key)\s*[:=]\s*)[^\s,;}]+/gi, `$1${REDACTED}`);
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, secretValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? REDACTED : redactSensitive(item, secretValues)]));
  return value;
}

function structuredError(error) {
  const secrets = error?.redactionSecrets ?? [];
  return redactSensitive({
    code: error?.code ?? 'UNKNOWN_ERROR',
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stage: error?.stage ?? 'transaction',
    status: error?.status ?? null,
    target: error?.target ?? null,
    details: error?.details ?? null,
  }, secrets);
}

function verificationError() {
  const error = new Error('verification did not confirm the written row');
  error.name = 'NotionV5TransactionError';
  error.code = 'TRANSACTION_FAILED';
  return error;
}

/** A deterministic, in-memory v5 gateway for explicit transactional rehearsal. */
export function createFakeTransactionalGateway({ failOn = null, verifyFailureOn = null, commitFailure = false } = {}) {
  const events = [];
  const plans = [];
  const committed = new Map();
  let sequence = 0;
  const shouldFail = (rule, operation) => typeof rule === 'function' ? rule(operation) : rule != null && String(rule) === keyOf(operation);
  const gateway = {
    kind: 'fake-transactional-v5',
    events,
    plans,
    committed,
    planWrites(request) {
      const operations = structuredClone(request?.operations || []);
      plans.push(structuredClone(request));
      return { status: 'planned', operations };
    },
    async executeWrites({ operations = [] } = {}) {
      if (!Array.isArray(operations)) throw new Error('transaction items must be an array');
      const unique = [];
      const seen = new Set();
      for (const operation of operations) {
        const key = keyOf(operation);
        if (!seen.has(key)) { seen.add(key); unique.push(operation); }
      }
      if (!unique.length) return { status: 'noop', newlyCommitted: [], alreadyCommitted: [], failed: [], recovery: [], deliveredKeys: [] };

      events.push({ stage: 'reserve', keys: unique.map(keyOf) });
      const committedKeys = new Set(committed.keys());
      const skipped = unique.filter((operation) => committedKeys.has(keyOf(operation)));
      const verified = [];
      const failed = [];

      for (const operation of unique) {
        if (committedKeys.has(keyOf(operation))) continue;
        try {
          events.push({ stage: 'write', key: keyOf(operation) });
          if (shouldFail(failOn, operation)) throw new Error(`injected write failure for ${keyOf(operation)}`);
          const result = { id: `fake-page-${++sequence}`, key: keyOf(operation), operation: structuredClone(operation) };
          events.push({ stage: 'verify', key: keyOf(operation) });
          const verification = shouldFail(verifyFailureOn, operation) ? false : result.key === keyOf(operation);
          if (verification !== true) throw verificationError();
          verified.push({ item: operation, result, verification });
        } catch (error) {
          failed.push({ key: keyOf(operation), error: structuredError(error) });
          events.push({ stage: 'abort', keys: [keyOf(operation)], error: structuredError(error) });
        }
      }

      let committedRows = [];
      if (verified.length) {
        events.push({ stage: 'commit', keys: verified.map(({ item }) => keyOf(item)) });
        try {
          if (commitFailure) throw new Error('injected commit failure');
          for (const row of verified) committed.set(keyOf(row.item), row.result);
          committedRows = verified;
        } catch (error) {
          failed.push({ key: null, error: structuredError(error) });
          events.push({ stage: 'abort', keys: verified.map(({ item }) => keyOf(item)), error: structuredError(error) });
        }
      }

      const newlyCommitted = committedRows.map(({ item }) => keyOf(item));
      const alreadyCommitted = skipped.map(keyOf);
      const delivered = new Set([...newlyCommitted, ...alreadyCommitted]);
      return {
        status: alreadyCommitted.length === unique.length
          ? 'replayed'
          : failed.length ? (newlyCommitted.length ? 'partial' : 'aborted') : 'committed',
        newlyCommitted,
        alreadyCommitted,
        failed,
        recovery: [],
        deliveredKeys: unique.map(keyOf).filter((key) => delivered.has(key)),
      };
    },
  };
  gateway.execute = gateway.executeWrites;
  return gateway;
}
