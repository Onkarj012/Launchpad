import { readFileSync } from 'node:fs';

const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

// Accept real calendar dates or timestamps with an explicit timezone.
function validDate(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day
    && Number.isFinite(Date.parse(value));
}

// Allow public web links without embedded credentials.
function validUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// Read local dated events separately from job candidates and selection.
export function readHiringEvents(file) {
  if (!file) return { items: [], quarantine: [] };
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(payload?.items)) throw new TypeError('hiring events must contain an items array');
  const items = [];
  const quarantine = [];
  for (const [index, record] of payload.items.entries()) {
    const errors = [];
    if (!['hiring-challenge', 'off-campus-drive'].includes(record?.kind)) errors.push('kind must be hiring-challenge or off-campus-drive');
    if (!clean(record?.title)) errors.push('title is required');
    if (!validUrl(record?.url)) errors.push('url must be a public HTTP or HTTPS link');
    if (!validDate(record?.date)) errors.push('date must be a valid calendar date or timestamp with timezone');
    if (record?.deadline != null && !validDate(record.deadline)) errors.push('deadline must be a valid calendar date or timestamp with timezone, or null');
    if (errors.length) { quarantine.push({ index, errors }); continue; }
    items.push({ kind: record.kind, title: clean(record.title), company: clean(record.company), url: record.url, date: record.date, deadline: record.deadline ?? null });
  }
  return { items, quarantine };
}
