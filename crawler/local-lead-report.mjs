import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDedupKey, normalizeCandidate } from '../job-pull/candidate.mjs';
import { loadConfig, loadConversionPlan } from '../job-pull/config.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';
import { applicationReadiness } from '../job-pull/normal-readiness.mjs';

const cell = (value) => String(value ?? 'Not Verified').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

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

/** Render retained operator observations; never score or persist a lifecycle. */
export function renderLocalLeadReport(result, { now = result.run?.startedAt ?? new Date().toISOString(), policy = null } = {}) {
  const effectivePolicy = policy ?? { ...loadConfig(), salaryFloorLpa: loadConversionPlan().salaryFloorLpa };
  const buckets = { strictReady: [], fallbackReady: [], verification: [], rejected: [] };
  for (const raw of result.observations ?? []) {
    const candidate = normalizeCandidate(raw, { runAt: now });
    const eligibility = classifyCandidate(candidate, effectivePolicy);
    const freshness = classifyFreshness(candidate, { now, ...effectivePolicy.freshness });
    const readiness = applicationReadiness(candidate, eligibility);
    const reasons = [...eligibility.reasons, ...(freshness.eligible === false && freshness.window !== 'VerifyQueue' ? [freshness.code ?? 'FRESHNESS_REJECTED'] : [])];
    const row = { candidate, eligibility, freshness, readiness, reasons };
    if (reasons.length) buckets.rejected.push(row);
    else if (readiness.ready && freshness.eligible) buckets[eligibility.strict ? 'strictReady' : 'fallbackReady'].push(row);
    else buckets.verification.push(row);
  }
  const lines = ['# Local lead handoff', '', `Observed at ${now}. Public evidence only. No scores, applications, outreach or store delivery.`, '',
    `Strict ready: ${buckets.strictReady.length}. Shortage fallback ready: ${buckets.fallbackReady.length}. Needs verification: ${buckets.verification.length}. Rejected: ${buckets.rejected.length}.`, ''];
  if (result.modes && typeof result.modes === 'object') {
    const targets = { normal: { label: 'Pune (normal)', roleTarget: 10, employerTarget: 6 }, startup: { label: 'Startup', roleTarget: 5, employerTarget: 4 }, remote: { label: 'Remote', roleTarget: 5, employerTarget: 4 } };
    const modeRows = Object.entries(targets).map(([mode, target]) => {
      const selection = result.modes[mode] ?? {};
      const shortlist = Array.isArray(selection.shortlist) ? selection.shortlist : [];
      const verifiedKeys = new Set((selection.results ?? []).map(candidateDedupKey));
      const verified = shortlist.filter((candidate) => verifiedKeys.has(candidateDedupKey(candidate))).length;
      const employers = new Set(shortlist.map((candidate) => String(candidate.company ?? '').trim().toLowerCase()).filter(Boolean)).size;
      return { ...target, shortlist, verified, employers };
    });
    const strictCount = modeRows.flatMap(({ shortlist }) => shortlist).filter((candidate) => candidate.selectionTier === 'Strict').length;
    const allShortlists = modeRows.flatMap(({ shortlist }) => shortlist);
    const verifiedCount = modeRows.reduce((count, mode) => count + mode.verified, 0);
    lines.push(`## Per-mode daily targets (IST ${eventDate(now).slice(0, 10)})`, '',
      '| Mode | Roles / target | Employers / target | Verified shortlisted | Shortfall |',
      '| --- | ---: | ---: | ---: | --- |');
    for (const mode of modeRows) {
      const missingRoles = Math.max(0, mode.roleTarget - mode.shortlist.length);
      const employerShortfall = Math.max(0, mode.employerTarget - mode.employers);
      const shortfall = missingRoles || employerShortfall ? `${missingRoles} roles, ${employerShortfall} employers` : 'None';
      lines.push(`| ${mode.label} | ${mode.shortlist.length}/${mode.roleTarget} | ${mode.employers}/${mode.employerTarget} | ${mode.verified}/${mode.shortlist.length} | ${shortfall} |`);
    }
    lines.push('', `Strict across modes: ${strictCount}, target 2.`, `Verified shortlisted roles: ${verifiedCount}/${allShortlists.length}.`, '');
  }
  const table = (name, rows) => {
    lines.push(`## ${name}`, '');
    if (!rows.length) { lines.push('None.', ''); return; }
    lines.push('| Role / company | Public URL | JD excerpt | Portal date / freshness | Salary | Experience | Application / liveness / applied | Exact reasons |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const { candidate: c, eligibility: e, freshness: f, readiness: r } = row;
      const reasonList = row.reasons.length ? row.reasons : [...r.reasons,
        ...(e.experience.manualReview ? [e.experience.code] : []),
        ...(!c.description ? ['PORTAL_DESCRIPTION_MISSING'] : []),
        ...(c.evidence?.resolution?.reason ? [c.evidence.resolution.reason] : []),
        ...(f.eligible ? [] : [f.code ?? 'FRESHNESS_NOT_VERIFIED'])];
      lines.push(`| ${cell(c.title)} / ${cell(c.company)} | ${cell(c.discoveryUrl ?? c.canonicalUrl)} | ${cell(c.description || 'Not Verified').slice(0, 240)} | ${cell(c.postedAt)} / ${cell(f.window)} | ${cell(c.salary?.evidence || 'Not Verified')} | ${cell(e.experience.evidence || 'Not stated; manual review')} | ${cell(c.applicationResolution?.status)} / ${cell(c.liveness?.status)} / Applied?: Not Verified | ${cell([...new Set(reasonList)].join('; ') || 'Ready, unscored')} |`);
    }
    lines.push('');
  };
  table('Strict ready, unscored', buckets.strictReady);
  table('Shortage fallback ready, unscored', buckets.fallbackReady);
  table('Needs verification', buckets.verification);
  table('Rejected', buckets.rejected);
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
  if (result.error) lines.push(`- ${cell(result.error)}`);
  lines.push('');
  return lines.join('\n');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || process.argv.length !== 4) throw new Error('Usage: node crawler/local-lead-report.mjs INPUT.json OUTPUT.md');
  const result = JSON.parse(fs.readFileSync(input, 'utf8'));
  fs.writeFileSync(output, renderLocalLeadReport(result, { now: result.runAt ?? result.run?.startedAt }));
}
