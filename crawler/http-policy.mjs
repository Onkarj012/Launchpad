import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : null;
}

export function parseRobotsTxt(text = '') {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) { current = null; continue; }
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.hasRules) { current = { agents: [], rules: [], hasRules: false }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.hasRules = true;
      if (value) current.rules.push({ type: key, pattern: value });
    }
  }
  return groups.map(({ agents, rules }) => ({ agents, rules }));
}

function robotsPattern(pattern) {
  const end = pattern.endsWith('$');
  const source = pattern.replace(/\$$/, '').split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${end ? '$' : ''}`);
}

export function decideRobots(url, robots, userAgent = '*') {
  let parsed;
  try { parsed = new URL(url); } catch { return { allowed: false, reason: 'invalid-url' }; }
  const ua = String(userAgent).toLowerCase();
  const groups = Array.isArray(robots) ? robots : parseRobotsTxt(robots);
  const matching = groups.filter((group) => group.agents.some((agent) => agent === '*' || ua.includes(agent)));
  const specificity = matching.reduce((best, group) => Math.max(best, ...group.agents.filter((agent) => agent !== '*' && ua.includes(agent)).map((agent) => agent.length), 0), 0);
  const selected = matching.filter((group) => group.agents.some((agent) => agent !== '*' && ua.includes(agent) && agent.length === specificity));
  const effective = matching;
  const path = `${parsed.pathname}${parsed.search}`;
  const candidates = effective.flatMap((group) => group.rules.map((rule) => ({ ...rule, length: rule.pattern.replace(/[*$]/g, '').length })));
  if (!candidates.length) return { allowed: true, reason: 'no-rule' };
  const matches = candidates.filter((rule) => robotsPattern(rule.pattern).test(path)).sort((a, b) => b.length - a.length);
  const winner = matches[0];
  return winner ? { allowed: winner.type === 'allow', reason: winner.type, rule: winner.pattern } : { allowed: true, reason: 'no-match' };
}

export function validateResponse(response, { maxBytes = Infinity } = {}) {
  const status = Number(response?.status ?? 0);
  const length = Number(header(response?.headers, 'content-length'));
  if (Number.isFinite(length) && length > maxBytes) return { ok: false, kind: 'terminal', reason: 'response-too-large' };
  if (status >= 200 && status < 300) return { ok: true, kind: 'success' };
  if (status === 304) return { ok: true, kind: 'not-modified' };
  if (RETRYABLE_STATUS.has(status) || status >= 500) return { ok: false, kind: 'retryable', reason: 'http-status' };
  return { ok: false, kind: 'terminal', reason: 'http-status' };
}

export function classifyRetry({ response, error } = {}) {
  if (response) {
    const status = Number(response.status);
    if (status >= 200 && status < 400) return { kind: status === 304 ? 'not-modified' : 'success' };
    return { kind: RETRYABLE_STATUS.has(status) || status >= 500 ? 'retryable' : 'terminal', status };
  }
  const code = error?.code;
  return { kind: code && RETRYABLE_ERRORS.has(code) || error?.retryable === true ? 'retryable' : 'terminal', error };
}

export function retryDelay(attempt, { baseDelayMs = 250, maxDelayMs = 10_000, jitterRatio = 0.2, rng = Math.random } = {}) {
  const capped = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 1 + ((Math.max(0, Math.min(1, rng())) * 2) - 1) * jitterRatio;
  return Math.max(0, Math.round(Math.min(maxDelayMs, capped * jitter)));
}

export function createHostLimiter({ minSpacingMs = 1000, maxConcurrency = 1, clock = {} } = {}) {
  const hosts = new Map();
  const now = () => typeof clock.now === 'function' ? clock.now() : Date.now();
  const sleep = (ms, signal) => typeof clock.sleep === 'function' ? clock.sleep(ms, { signal }) : delay(ms, undefined, { signal });
  function pump(host, state) {
    if (state.pumping) return;
    state.pumping = true;
    (async () => {
      while (state.queue.length && state.active < maxConcurrency) {
        const item = state.queue.shift();
        try {
          item.signal?.throwIfAborted();
          const wait = Math.max(0, state.lastStart + minSpacingMs - now());
          if (wait) await sleep(wait, item.signal);
          item.signal?.throwIfAborted();
        } catch (error) { item.reject(error); continue; }
        state.lastStart = now(); state.active += 1;
        Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { state.active -= 1; pump(host, state); });
      }
      state.pumping = false;
      if (state.queue.length && state.active < maxConcurrency) pump(host, state);
    })();
  }
  return { run(host, task, { signal } = {}) {
    const key = String(host).toLowerCase();
    const state = hosts.get(key) ?? { active: 0, lastStart: -Infinity, queue: [], pumping: false };
    hosts.set(key, state);
    return new Promise((resolve, reject) => { state.queue.push({ task, resolve, reject, signal }); pump(key, state); });
  }, snapshot() { return new Map([...hosts].map(([host, state]) => [host, { active: state.active, queued: state.queue.length, lastStart: state.lastStart }])); } };
}

export { header as getHeader };
