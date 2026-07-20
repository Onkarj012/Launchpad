#!/usr/bin/env node
import fs from 'node:fs';

function argumentsMap(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    result[value.slice(2)] = values[index + 1]?.startsWith('--') ? true : values[index + 1];
    if (result[value.slice(2)] !== true) index += 1;
  }
  return result;
}

function readTsv(file) {
  if (!file) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).filter(Boolean).map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split('\t')[index] ?? ''])));
}

function countBy(rows, value) {
  return Object.entries(rows.reduce((counts, row) => {
    const key = value(row) || 'Not Verified';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
}

function table(rows, headings) {
  if (!rows.length) return '_No confirmed records._';
  return [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

function isInRange(value, since, until) {
  if (!value) return true;
  const date = value.slice(0, 10);
  return (!since || date >= since) && (!until || date <= until);
}

const options = argumentsMap(process.argv.slice(2));
if (!options.applications || !options.outcomes) {
  console.error('Usage: node conversion/report.mjs --applications PATH --outcomes PATH [--referrals PATH] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--out PATH]');
  process.exitCode = 2;
} else {
  const applications = readTsv(options.applications).filter((row) => row.applied_at && isInRange(row.applied_at, options.since, options.until));
  const outcomes = readTsv(options.outcomes).filter((row) => isInRange(row.event_at, options.since, options.until));
  const referrals = readTsv(options.referrals).filter((row) => isInRange(row.requested_at, options.since, options.until));
  const humanEvents = new Set(['reply', 'profile view', 'resume download', 'assessment', 'recruiter screen', 'technical interview']);
  const sourceRows = countBy(applications, (row) => row.source_category).map(([source, applied]) => {
    const keys = new Set(applications.filter((row) => (row.source_category || 'Not Verified') === source).map((row) => row.application_key));
    const events = outcomes.filter((row) => keys.has(row.application_key));
    return [source, applied, events.filter((row) => row.event_type === 'reply').length, events.filter((row) => row.event_type === 'recruiter screen').length, events.filter((row) => row.event_type === 'technical interview').length];
  });
  const variants = countBy(applications, (row) => row.resume_variant).map(([variant, applied]) => {
    const keys = new Set(applications.filter((row) => (row.resume_variant || 'Not Verified') === variant).map((row) => row.application_key));
    return [variant, applied, outcomes.filter((row) => keys.has(row.application_key) && humanEvents.has(row.event_type)).length];
  });
  const rejectionTiming = countBy(outcomes.filter((row) => row.event_type === 'rejection'), (row) => row.rejection_timing).map(([timing, count]) => [timing, count]);
  const referralOutcomes = countBy(referrals, (row) => row.outcome || row.status).map(([outcome, count]) => [outcome, count]);
  const screens = outcomes.filter((row) => row.event_type === 'recruiter screen').length;
  const interviews = outcomes.filter((row) => row.event_type === 'technical interview').length;
  const checkpoint = applications.length >= 70 && applications.length <= 100 && interviews === 0
    ? '70–100 checkpoint: pause new resume variants; audit human activity, proof packet, project bullets, source mix, and broaden title mix.'
    : applications.length >= 50 && screens === 0
      ? '50-application checkpoint: audit hard-gate accuracy, positioning, direct/VC source mix, and confirmed knockout answers.'
      : 'No checkpoint trigger from the supplied records.';
  const report = [
    '# Weekly conversion report', '',
    `Period: ${options.since || 'all recorded'} to ${options.until || 'today'}  `,
    `Confirmed applications: ${applications.length}  `,
    `Confirmed recruiter screens: ${screens}  `,
    `Confirmed technical interviews: ${interviews}`, '',
    '## Applications and human activity by source', '', table(sourceRows, ['Source category', 'Applied', 'Replies', 'Screens', 'Technical interviews']), '',
    '## Resume variants', '', table(variants, ['Resume variant', 'Applied', 'Human activity']), '',
    '## Rejection timing', '', table(rejectionTiming, ['Timing', 'Rejections']), '',
    '## Referral outcomes', '', table(referralOutcomes, ['Outcome/status', 'Count']), '',
    '## Diagnostic action', '', checkpoint, '',
    'Data quality: all counts are local confirmed ledger records. Missing dates, source categories, resume variants, or outcomes are reported as `Not Verified` and must not be interpreted as zero activity.'
  ].join('\n');
  if (options.out) fs.writeFileSync(options.out, `${report}\n`);
  else process.stdout.write(`${report}\n`);
}
