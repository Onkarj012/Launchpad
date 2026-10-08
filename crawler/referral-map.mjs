import fs from 'node:fs';

// Parse quoted CSV cells, including escaped quotes and embedded newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (quoted) throw new Error('CSV input has an unclosed quoted field');
  const [headers = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header.trim(), record[index] ?? ''])));
}

// Read one input list as CSV or JSON.
function readPeople(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.json')) {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error(`Expected a contact array in ${file}`);
    return value;
  }
  return parseCsv(text);
}

// Normalize source-specific field names into one contact record.
function normalizePerson(person, source) {
  const first = person.firstName ?? person['First Name'] ?? '';
  const last = person.lastName ?? person['Last Name'] ?? '';
  const name = String(person.name ?? [first, last].filter(Boolean).join(' ')).trim();
  const company = String(person.company ?? person.Company ?? '').trim();
  const title = String(person.title ?? person.position ?? person.Position ?? '').trim();
  const rawDate = person.connectedDate ?? person['Connected On'] ?? '';
  return { name, company, title, connectedDate: normalizeDate(rawDate), source };
}

// Convert common LinkedIn connection date forms to ISO dates.
function normalizeDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const linkedInDate = raw.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  const slashDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (linkedInDate) {
    const month = new Date(`${linkedInDate[2]} 1, 2000`).getMonth();
    if (!Number.isNaN(month)) return new Date(Date.UTC(Number(linkedInDate[3]), month, Number(linkedInDate[1]))).toISOString().slice(0, 10);
  }
  if (slashDate) return new Date(Date.UTC(Number(slashDate[3]), Number(slashDate[1]) - 1, Number(slashDate[2]))).toISOString().slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

// Match case and punctuation variations without fuzzy employer guesses.
function companyKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Build local referral matches and unsent draft notes from supplied files.
export function buildReferralMapFromFiles({ connectionsPath, handwrittenPath, registryPath, shortlistPath } = {}) {
  const connections = readPeople(connectionsPath).map((person) => normalizePerson(person, 'linkedin'));
  const handwritten = handwrittenPath ? readPeople(handwrittenPath).map((person) => normalizePerson(person, 'handwritten')) : [];
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const shortlist = JSON.parse(fs.readFileSync(shortlistPath, 'utf8'));
  const boards = Array.isArray(registry) ? registry : registry.boards;
  if (!Array.isArray(boards) || !Array.isArray(shortlist)) throw new Error('Registry boards and shortlisted roles must be arrays');
  const people = [...connections, ...handwritten];
  const seen = new Set();
  return {
    schemaVersion: 'ReferralMapV1',
    people: people.filter((person) => {
      const key = [person.name, person.company, person.title].map(companyKey).join('|');
      if (!person.name || !person.company || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((person) => {
      const board = boards.find((entry) => companyKey(entry.company) === companyKey(person.company));
      const roles = board ? shortlist.filter((role) => companyKey(role.company) === companyKey(board.company)) : [];
      return {
        ...person,
        registryEmployer: board ? { id: board.id ?? null, company: board.company } : null,
        roles: roles.map((role) => ({ title: role.title, url: role.canonicalUrl ?? role.originalApplicationUrl ?? role.url ?? null, mode: role.primaryMode ?? null })),
        draftNotes: roles.map((role) => ({
          status: 'draft',
          sent: false,
          body: `Hi ${person.name}, I saw the ${role.title} role at ${board.company}. Would you be open to sharing any advice or referring me if you think my background fits? ${role.canonicalUrl ?? role.originalApplicationUrl ?? role.url ?? ''}`.trim(),
        })),
      };
    }),
  };
}
