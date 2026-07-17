import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importPublicSearchCandidates } from './adapters/public-search.mjs';

export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunError';
  }
}

function parseValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return { help: argv.includes('--help') || argv.includes('-h'), input: parseValue(argv, '--in'), output: parseValue(argv, '--out') };
}

function readInput(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new RunError(`could not read JSON input: ${error.message}`); }
}

function recordsFromInput(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['offers', 'candidates', 'jobs', 'results']) if (Array.isArray(value?.[key])) return value[key];
  throw new RunError('input JSON must be an array or contain offers, candidates, jobs, or results');
}

const RELATIVE_UNIT_MS = { minute: 60000, min: 60000, hour: 3600000, hr: 3600000, h: 3600000, day: 86400000, d: 86400000, week: 604800000, w: 604800000, month: 2592000000 };

function postedAt(value, now = new Date()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) return text;
  const lower = text.toLowerCase().replace(/^posted\s+/, '').trim();
  if (lower === 'just now' || lower === 'now') return now.toISOString();
  if (lower === 'today') return now.toISOString();
  if (lower === 'yesterday') return new Date(now.getTime() - RELATIVE_UNIT_MS.day).toISOString();
  const match = lower.match(/^(\d+)\+?\s*(minute|min|hour|hr|h|day|d|week|w|month)s?\s+ago$/);
  if (match) {
    const amount = Number(match[1]);
    const unitMs = RELATIVE_UNIT_MS[match[2]];
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  return null;
}

export function prepareRecord(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    url: raw.url ?? raw.link ?? raw.jobUrl,
    company: raw.company ?? raw.org,
    title: raw.title ?? raw.position,
    postedAt: postedAt(raw.postedAt ?? raw.posted ?? raw.date, now),
    location: raw.location ?? null,
    description: raw.description ?? raw.snippet ?? null,
    source: 'public-search',
    sourceKind: raw.sourceKind ?? 'aggregator',
    ...(raw.workMode == null ? {} : { workMode: raw.workMode }),
    ...(raw.employment == null ? {} : { employment: raw.employment }),
    ...(raw.experience == null ? {} : { experience: raw.experience }),
  };
}

export function prepare(rawRecords) {
  const now = new Date();
  const kept = [];
  const skipped = [];
  rawRecords.forEach((raw, index) => {
    const record = prepareRecord(raw, now);
    if (!record) { skipped.push({ index, reason: 'record must be an object' }); return; }
    try {
      importPublicSearchCandidates([record]);
      kept.push(record);
    } catch (error) {
      skipped.push({ index, reason: error.message });
    }
  });
  return { kept, skipped };
}

export const HELP = `Usage: node job-pull/public-search-prepare.mjs --in FILE --out FILE

Normalize raw WebSearch/board records into the public-search input contract.`;

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (!options.input || !options.output) throw new RunError('--in FILE and --out FILE are required');
  const raw = recordsFromInput(readInput(options.input));
  const result = prepare(raw);
  writeFileSync(options.output, `${JSON.stringify(result.kept, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ in: raw.length, out: options.output, kept: result.kept.length, skipped: result.skipped }));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
