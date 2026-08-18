import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DELIVERY_CANARY_EVALUATION_SCHEMA = 'LaunchpadDeliveryCanaryEvaluationV1';
export const DEFAULT_CANARY_RUNS = 7;
export const ROUTINE_DURATION_LIMIT_MS = 45 * 60 * 1000;

export const DEFAULT_CANARY_ENTRYPOINTS = Object.freeze([
  'crawler/daily-runner.mjs',
  'crawler/cli.mjs',
  'vendor/career-ops/runtime.mjs',
]);

const LOCAL_RESOLUTION_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs', '.json']);
const LOCAL_PARSE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

export const DEFAULT_CANARY_NON_CODE_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'config/career-ops-portals.yml',
  'vendor/career-ops/UPSTREAM.md',
  'vendor/career-ops/tracker-aliases.json',
  'config/crawler-v2.json',
  'config/reverse-warm-set.json',
  'config/vc-portfolio-watchlist.json',
  'config/job-pull.json',
  'config/conversion-plan.json',
  'config/board-registry.json',
  'config/match-score.schema.json',
]);

// Kept as a compatibility export for callers that only need the entrypoint
// names. The dependency inventory itself is always resolved recursively.
export const DEFAULT_CANARY_CODE_PATHS = DEFAULT_CANARY_ENTRYPOINTS;

function skipQuotedLiteral(source, start) {
  const quote = source[start];
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === quote) return index + 1;
  }
  return source.length;
}

function readQuotedLiteral(source, start) {
  const quote = source[start];
  let value = '';
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === quote) {
      return { value, end: index + 1 };
    } else {
      value += char;
    }
  }
  return null;
}

function skipTemplateLiteral(source, start) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '`') return index + 1;
  }
  return source.length;
}

function skipComment(source, start) {
  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2);
    return newline < 0 ? source.length : newline + 1;
  }
  const end = source.indexOf('*/', start + 2);
  return end < 0 ? source.length : end + 2;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) index += 1;
    else if (source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) index = skipComment(source, index);
    else break;
  }
  return index;
}

function skipRegexLiteral(source, start) {
  let inCharacterClass = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '[') inCharacterClass = true;
    else if (char === ']') inCharacterClass = false;
    else if (char === '/' && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/.test(source[index] ?? '')) index += 1;
      return index;
    } else if (char === '\n' || char === '\r') {
      return start + 1;
    }
  }
  return source.length;
}

function readIdentifier(source, start) {
  let end = start + 1;
  while (/[A-Za-z0-9_$]/.test(source[end] ?? '')) end += 1;
  return { value: source.slice(start, end), end };
}

function readDigits(source, start, isDigit) {
  let end = start;
  while (isDigit(source[end] ?? '') || source[end] === '_') end += 1;
  return end;
}

function readNumericLiteral(source, start) {
  const first = source[start];
  let end = start;
  if (first === '.') {
    if (!/[0-9]/.test(source[start + 1] ?? '')) return null;
    end = readDigits(source, start + 1, (char) => /[0-9]/.test(char));
  } else if (/[0-9]/.test(first ?? '')) {
    if (first === '0' && /[XxBbOo]/.test(source[start + 1] ?? '')) {
      const base = source[start + 1].toLowerCase();
      const isDigit = base === 'x'
        ? (char) => /[0-9A-Fa-f]/.test(char)
        : base === 'b'
          ? (char) => /[01]/.test(char)
          : (char) => /[0-7]/.test(char);
      end = readDigits(source, start + 2, isDigit);
      if (source[end] === 'n') end += 1;
      return end;
    }
    end = readDigits(source, start, (char) => /[0-9]/.test(char));
    if (source[end] === '.') end = readDigits(source, end + 1, (char) => /[0-9]/.test(char));
    if (/[Ee]/.test(source[end] ?? '')) {
      end += 1;
      if (/[+-]/.test(source[end] ?? '')) end += 1;
      end = readDigits(source, end, (char) => /[0-9]/.test(char));
    }
    if (source[end] === 'n') end += 1;
    return end;
  } else {
    return null;
  }
  return end;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char ?? '');
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

const REGEX_AFTER_IDENTIFIERS = new Set([
  'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield', 'await',
]);

function canEndExpression(previousToken) {
  if (!previousToken) return false;
  if (previousToken.type === 'literal') return true;
  if (previousToken.type === 'identifier') return !REGEX_AFTER_IDENTIFIERS.has(previousToken.value);
  return [')', ']', '}'].includes(previousToken.value);
}

function readExpressionEndingToken(source, start, previousToken) {
  const numericEnd = readNumericLiteral(source, start);
  if (numericEnd !== null) return { end: numericEnd, token: { type: 'literal', value: 'number' } };
  if (canEndExpression(previousToken) && ((source[start] === '+' && source[start + 1] === '+')
    || (source[start] === '-' && source[start + 1] === '-'))) {
    return { end: start + 2, token: { type: 'literal', value: 'update' } };
  }
  return null;
}

function canStartRegex(previousToken) {
  if (!previousToken) return true;
  if (previousToken.type === 'identifier') return REGEX_AFTER_IDENTIFIERS.has(previousToken.value);
  if (previousToken.type === 'literal') return false;
  return ![')', ']', '}'].includes(previousToken.value);
}

function parseModuleSpecifier(source, start, keyword) {
  let index = skipTrivia(source, start);
  if (keyword === 'import' && source[index] === '(') {
    index = skipTrivia(source, index + 1);
    if (source[index] !== "'" && source[index] !== '"') return null;
    const literal = readQuotedLiteral(source, index);
    if (!literal || !isLocalSpecifier(literal.value)) return null;
    index = skipTrivia(source, literal.end);
    return source[index] === ')' ? { specifiers: [literal.value], end: index + 1 } : null;
  }

  if (keyword === 'import' && (source[index] === "'" || source[index] === '"')) {
    const literal = readQuotedLiteral(source, index);
    return literal && isLocalSpecifier(literal.value)
      ? { specifiers: [literal.value], end: literal.end }
      : null;
  }

  let previousToken = null;
  while (index < source.length) {
    index = skipTrivia(source, index);
    if (index >= source.length || source[index] === ';') return null;
    if (source[index] === "'" || source[index] === '"') {
      index = skipQuotedLiteral(source, index);
      previousToken = { type: 'literal', value: 'string' };
      continue;
    }
    if (source[index] === '`') {
      index = skipTemplateLiteral(source, index);
      previousToken = { type: 'literal', value: 'template' };
      continue;
    }
    const expressionEndingToken = readExpressionEndingToken(source, index, previousToken);
    if (expressionEndingToken) {
      index = expressionEndingToken.end;
      previousToken = expressionEndingToken.token;
      continue;
    }
    if (source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] === '/' && canStartRegex(previousToken)) {
      index = skipRegexLiteral(source, index);
      previousToken = { type: 'literal', value: 'regex' };
      continue;
    }
    if (isIdentifierStart(source[index])) {
      const identifier = readIdentifier(source, index);
      if (identifier.value === 'from') {
        const literalStart = skipTrivia(source, identifier.end);
        if (source[literalStart] === "'" || source[literalStart] === '"') {
          const literal = readQuotedLiteral(source, literalStart);
          if (literal && isLocalSpecifier(literal.value)) {
            return { specifiers: [literal.value], end: literal.end };
          }
        }
      }
      previousToken = { type: 'identifier', value: identifier.value };
      index = identifier.end;
      continue;
    }
    previousToken = { type: 'punctuation', value: source[index] };
    index += 1;
  }
  return null;
}

function localImportSpecifiers(source) {
  const specs = new Set();
  let index = 0;
  let previousToken = null;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      index = skipQuotedLiteral(source, index);
      previousToken = { type: 'literal', value: 'string' };
      continue;
    }
    if (source[index] === '`') {
      index = skipTemplateLiteral(source, index);
      previousToken = { type: 'literal', value: 'template' };
      continue;
    }
    const expressionEndingToken = readExpressionEndingToken(source, index, previousToken);
    if (expressionEndingToken) {
      index = expressionEndingToken.end;
      previousToken = expressionEndingToken.token;
      continue;
    }
    if (source[index] === '/' && canStartRegex(previousToken)) {
      index = skipRegexLiteral(source, index);
      previousToken = { type: 'literal', value: 'regex' };
      continue;
    }
    if (isIdentifierStart(source[index])) {
      const identifier = readIdentifier(source, index);
      if ((identifier.value === 'import' || identifier.value === 'export')
        && previousToken?.value !== '.') {
        const parsed = parseModuleSpecifier(source, identifier.end, identifier.value);
        for (const specifier of parsed?.specifiers ?? []) specs.add(specifier);
        if (parsed) index = parsed.end;
        else index = identifier.end;
      } else {
        index = identifier.end;
      }
      previousToken = { type: 'identifier', value: identifier.value };
      continue;
    }
    previousToken = { type: 'punctuation', value: source[index] };
    index += 1;
  }
  return [...specs];
}

function normalizedRelative(value) {
  return path.normalize(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function insideRoot(root, resolved) {
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveLocalImport(importer, specifier, root) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const imported = normalizedRelative(path.join(path.dirname(importer), cleanSpecifier));
  const candidates = [imported];
  for (const extension of LOCAL_RESOLUTION_EXTENSIONS) candidates.push(`${imported}${extension}`);
  for (const extension of LOCAL_RESOLUTION_EXTENSIONS) candidates.push(path.join(imported, `index${extension}`));
  for (const candidate of candidates) {
    const resolved = path.resolve(root, candidate);
    if (!insideRoot(path.resolve(root), resolved)) continue;
    try {
      if (fs.statSync(resolved).isFile()) return normalizedRelative(path.relative(root, resolved));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(`canary fingerprint unresolved local import: ${importer} -> ${specifier}`);
}

function readTrackedFile(relative, root) {
  const resolved = path.resolve(root, relative);
  try {
    if (!fs.statSync(resolved).isFile()) throw new Error('not a file');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.message === 'not a file') {
      throw new Error(`canary fingerprint missing tracked file: ${relative}`);
    }
    throw error;
  }
  return { path: normalizedRelative(relative), bytes: fs.readFileSync(resolved) };
}

export function collectTrackedModuleInventory(entrypoints = DEFAULT_CANARY_ENTRYPOINTS, { root = process.cwd() } = {}) {
  const files = new Map();
  const queue = entrypoints.map(normalizedRelative);
  while (queue.length) {
    const relative = queue.pop();
    if (files.has(relative)) continue;
    const tracked = readTrackedFile(relative, root);
    files.set(relative, tracked);
    if (!LOCAL_PARSE_EXTENSIONS.includes(path.extname(relative))) continue;
    for (const specifier of localImportSpecifiers(tracked.bytes.toString('utf8'))) {
      queue.push(resolveLocalImport(relative, specifier, path.resolve(root)));
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function collectTrackedModuleGraph(entrypoints = DEFAULT_CANARY_ENTRYPOINTS, options = {}) {
  return collectTrackedModuleInventory(entrypoints, options).map((file) => file.path);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function computeCanaryVersion({
  config = {},
  root = process.cwd(),
  codePaths,
  entrypoints = DEFAULT_CANARY_ENTRYPOINTS,
  nonCodePaths = DEFAULT_CANARY_NON_CODE_PATHS,
} = {}) {
  const inventoryByPath = new Map();
  const addToInventory = (relative, bytes = null) => {
    const normalized = normalizedRelative(relative);
    if (!inventoryByPath.has(normalized)) {
      inventoryByPath.set(normalized, bytes ? { path: normalized, bytes } : readTrackedFile(normalized, root));
    }
  };
  if (codePaths) {
    for (const relative of codePaths) addToInventory(relative);
  } else {
    for (const file of collectTrackedModuleInventory(entrypoints, { root })) addToInventory(file.path, file.bytes);
    for (const relative of nonCodePaths) addToInventory(relative);
  }
  const inventory = [...inventoryByPath.values()];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(stable(config)));
  for (const { path: relative, bytes } of inventory.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(relative);
    hash.update(String(bytes.byteLength));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function orderedRuns(input) {
  return (Array.isArray(input) ? input : input?.runs ?? [])
    .slice()
    .sort((left, right) => String(left.runAt).localeCompare(String(right.runAt)));
}

const DISCOVERY_PROFILE_FIELDS = Object.freeze(['schedule', 'mode', 'locationPreset']);
const DISCOVERY_PROFILE_VALUES = Object.freeze({
  schedule: new Set(['morning', 'midday']),
  mode: new Set(['normal', 'startup', 'remote']),
  locationPreset: new Set(['india', 'pune']),
});

export function normalizeCanaryDiscoveryProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const normalized = {};
  for (const field of DISCOVERY_PROFILE_FIELDS) {
    if (typeof profile[field] !== 'string') return null;
    const value = profile[field].trim().toLowerCase();
    if (!DISCOVERY_PROFILE_VALUES[field].has(value)) return null;
    normalized[field] = value;
  }
  return normalized;
}

function sameDiscoveryProfile(left, right) {
  return DISCOVERY_PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function utcDate(runAt) {
  const date = new Date(runAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function distinctUtcDates(runs) {
  return [...new Set(runs.map((run) => utcDate(run?.runAt)).filter(Boolean))].sort();
}

function currentVersionStreak(runs) {
  if (!runs.length) return { version: null, discoveryProfile: null, runs: [], invalidRunIds: [] };
  const latest = runs.at(-1);
  const version = latest?.codeConfigVersion ?? null;
  const discoveryProfile = normalizeCanaryDiscoveryProfile(latest?.discoveryProfile);
  const streak = [];
  const invalidRunIds = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const runProfile = normalizeCanaryDiscoveryProfile(run?.discoveryProfile);
    if (run?.valid !== true || !discoveryProfile || !runProfile
      || (run.codeConfigVersion ?? null) !== version
      || !sameDiscoveryProfile(runProfile, discoveryProfile)) {
      if (run?.valid !== true || !runProfile) invalidRunIds.push(run?.runId ?? null);
      break;
    }
    streak.unshift(run);
  }
  return { version, discoveryProfile, runs: streak, invalidRunIds: invalidRunIds.filter(Boolean) };
}

function versionChanges(runs) {
  const changes = [];
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1];
    const current = runs[index];
    if (previous.codeConfigVersion === current.codeConfigVersion) continue;
    changes.push({
      fromRunId: previous.runId,
      toRunId: current.runId,
      fromVersion: previous.codeConfigVersion ?? null,
      toVersion: current.codeConfigVersion ?? null,
    });
  }
  return changes;
}

function zeroGate(id, description, runs, field) {
  const failing = runs.filter((run) => !Number.isFinite(Number(run.engineering?.[field])) || Number(run.engineering[field]) !== 0);
  return {
    id,
    description,
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      observed: Object.fromEntries(runs.map((run) => [run.runId, Number.isFinite(Number(run.engineering?.[field])) ? Number(run.engineering[field]) : null])),
      required: 0,
    },
  };
}

function durationGate(runs, limitMs) {
  const failing = runs.filter((run) => (
    !Number.isFinite(Number(run.engineering?.durationMs))
    || Number(run.engineering.durationMs) >= limitMs
  ));
  return {
    id: 'routine-duration',
    description: 'Every routine valid run completes in under 45 minutes.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      durationMsByRun: Object.fromEntries(runs.map((run) => [run.runId, run.engineering?.durationMs ?? null])),
      limitMs,
      comparison: 'strictly-less-than',
    },
  };
}

function reportGate(runs) {
  const failing = runs.filter((run) => run.engineering?.reportComplete !== true);
  return {
    id: 'complete-local-report',
    description: 'Every valid run has a committed Markdown report and JSON sidecar.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      reports: Object.fromEntries(runs.map((run) => [run.runId, {
        complete: run.engineering?.reportComplete === true,
        paths: run.engineering?.reportPaths ?? { markdown: null, json: null },
      }])),
    },
  };
}

function manualInventoryGate(runs) {
  const failing = runs.filter((run) => run.engineering?.manualInventoryMatch !== true);
  return {
    id: 'manual-inventory-match',
    description: 'Every valid run matches the manually verified delivery inventory.',
    passed: runs.length > 0 && failing.length === 0,
    evidence: {
      evaluatedRunIds: runs.map((run) => run.runId),
      failingRunIds: failing.map((run) => run.runId),
      observed: Object.fromEntries(runs.map((run) => [run.runId, run.engineering?.manualInventoryMatch === true])),
      required: true,
    },
  };
}

export function evaluateDeliveryCanary(input = [], {
  requiredRuns = DEFAULT_CANARY_RUNS,
  durationLimitMs = ROUTINE_DURATION_LIMIT_MS,
} = {}) {
  const allRuns = orderedRuns(input);
  const streak = currentVersionStreak(allRuns);
  const runs = streak.runs;
  const changes = versionChanges(allRuns);
  const gates = [
    zeroGate('fatal-scorer-infrastructure', 'Zero fatal scorer infrastructure failures.', runs, 'fatalScorerInfrastructureFailures'),
    zeroGate('source-outage-truthfulness', 'Zero source outages reported as healthy.', runs, 'sourceOutagesReportedHealthy'),
    zeroGate('selected-suppression', 'Zero selected roles already suppressed.', runs, 'selectedSuppressedRoles'),
    zeroGate('post-commit-surfacing', 'Zero roles surfaced before delivery commit.', runs, 'rolesSurfacedBeforeCommit'),
    zeroGate('duplicate-requisition', 'Zero duplicate requisition collisions.', runs, 'duplicateRequisitionCollisions'),
    zeroGate('funnel-reconciliation', 'Zero unattributed funnel loss.', runs, 'unattributedFunnelLoss'),
    durationGate(runs, durationLimitMs),
    reportGate(runs),
    manualInventoryGate(runs),
    {
      id: 'seven-consecutive-valid-runs',
      description: 'Seven consecutive valid runs share one recorded code/config version and normalized discovery profile.',
      passed: runs.length >= requiredRuns
        && distinctUtcDates(runs).length >= requiredRuns
        && Boolean(streak.version)
        && Boolean(streak.discoveryProfile),
      evidence: {
        requiredRuns,
        consecutiveRuns: runs.length,
        dayCount: distinctUtcDates(runs).length,
        dates: distinctUtcDates(runs),
        runIds: runs.map((run) => run.runId),
        version: streak.version,
        discoveryProfile: streak.discoveryProfile,
        versionChanges: changes,
      },
    },
  ];
  return {
    schemaVersion: DELIVERY_CANARY_EVALUATION_SCHEMA,
    passed: gates.every((gate) => gate.passed),
    streak: {
      count: runs.length,
      required: requiredRuns,
      dayCount: distinctUtcDates(runs).length,
      dates: distinctUtcDates(runs),
      distinctValidUtcDates: distinctUtcDates(runs),
      version: streak.version,
      discoveryProfile: streak.discoveryProfile,
      runIds: runs.map((run) => run.runId),
      invalidRunIds: streak.invalidRunIds,
      evaluatedRunCount: allRuns.length,
    },
    gates,
  };
}

export default evaluateDeliveryCanary;
