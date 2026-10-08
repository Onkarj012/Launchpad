import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDedupKey, normalizeCandidate } from '../job-pull/candidate.mjs';
import { loadConfig, loadConversionPlan } from '../job-pull/config.mjs';
import { classifyCandidate } from '../job-pull/eligibility.mjs';
import { classifyFreshness } from '../job-pull/freshness.mjs';
import { applicationReadiness } from '../job-pull/normal-readiness.mjs';

const cell = (value) => String(value ?? 'Not Verified').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const html = (value) => String(value ?? 'Not Verified').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Read request counts from source telemetry without inferring missing requests.
function sourceRequests(source) {
  const details = source.detail ?? source;
  const candidates = [source.requests, details.requests, details.telemetry?.requests];
  return candidates.find(Number.isFinite) ?? null;
}

// Render only drift signals supported by retained run evidence.
function dailyDriftSignals(result) {
  const signals = [];
  const telemetry = result.sourceTelemetry ?? {};
  const textFor = (source) => JSON.stringify(source).toLowerCase();
  for (const [id, source] of Object.entries(telemetry)) {
    const evidence = textFor(source);
    if (/linkedin/.test(id.toLowerCase()) && /429|rate.limit/.test(evidence)) signals.push(`LinkedIn 429: ${id}`);
    if (/glassdoor/.test(id.toLowerCase()) && /403|forbidden/.test(evidence)) signals.push(`Glassdoor 403: ${id}`);
    const failedBoards = Number(source.boardsFailed ?? source.failed ?? source.detail?.boardsFailed ?? source.detail?.failed ?? source.detail?.telemetry?.boardsFailed ?? source.detail?.telemetry?.failed ?? source.detail?.failures?.length ?? 0);
    if (failedBoards > 0) signals.push(`${id}: ${failedBoards} board failure${failedBoards === 1 ? '' : 's'}`);
  }
  for (const [id, endState] of Object.entries(result.sourceEndStates ?? {})) {
    const evidence = `${endState.state ?? ''} ${endState.reason ?? ''}`.toLowerCase();
    if (/linkedin/.test(id.toLowerCase()) && /429|rate.limit/.test(evidence)) signals.push(`LinkedIn 429: ${id}`);
    if (/glassdoor/.test(id.toLowerCase()) && /403|forbidden/.test(evidence)) signals.push(`Glassdoor 403: ${id}`);
    if (/failed|http_[45]|transport/.test(evidence) && !/linkedin|glassdoor/.test(id.toLowerCase())) signals.push(`${id}: board failure`);
  }
  for (const entry of result.scorerVariance ?? result.scoring?.variance ?? []) {
    const previous = entry.previous ?? entry.previousScore;
    const current = entry.current ?? entry.currentScore;
    if (Number.isFinite(previous) && Number.isFinite(current)) signals.push(`Scorer variance: ${entry.role ?? entry.title ?? 'Role'} ${previous} to ${current}`);
  }
  return [...new Set(signals)];
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

// Render daily mode results and their shortlists without changing run state.
export function renderLocalDailyHtmlReport(result, { now = result.runAt ?? result.run?.startedAt ?? new Date().toISOString() } = {}) {
  const targetModes = [
    ['normal', 'Pune'], ['startup', 'Startup'], ['remote', 'Remote'],
  ];
  const modes = [...targetModes, ['eorContract', 'EOR / Contract']];
  const modeRuns = result.modes ?? {};
  const telemetry = result.sourceTelemetry ?? {};
  const uniqueResults = new Map(modes.flatMap(([mode]) => (modeRuns[mode]?.results ?? []).map((role) => [role.canonicalUrl ?? role.url, role])));
  const allShortlists = targetModes.flatMap(([mode]) => modeRuns[mode]?.shortlist ?? (result.mode === mode ? result.shortlist ?? [] : []));
  const uniqueShortlist = [...new Map(allShortlists.map((role) => [role.canonicalUrl ?? role.url, role])).values()];
  const lifecycle = result.funnel?.lifecycle ?? {};
  const counts = result.counts ?? {};
  const readCount = (...values) => values.find((value) => Number.isFinite(value)) ?? 0;
  const strictCount = uniqueShortlist.filter((role) => role.selectionTier === 'Strict' || role.eligibility?.strict === true).length;
  const employers = new Set(uniqueShortlist.map((role) => String(role.company ?? '').trim().toLowerCase()).filter(Boolean));
  const funnel = [
    ['Fetched', readCount(counts.fetched, lifecycle.fetched, uniqueResults.size)],
    ['Eligible', readCount(counts.eligible, lifecycle.eligible)],
    ['Passed gates', readCount(counts.gatePassing, lifecycle.gatePassing, lifecycle.eligible)],
    ['Ready', readCount(counts.ready, lifecycle.ready)],
    ['Scored', readCount(counts.scored, lifecycle.scored)],
    ['Shortlisted', uniqueShortlist.length],
    ['Employers represented', employers.size],
    ['Strict', strictCount],
  ];
  const htmlTargetModes = [
    ['normal', 'Pune', 10, 6], ['startup', 'Startup', 5, 4], ['remote', 'Remote', 5, 4],
  ];
  const roleCard = (role, isShortlist) => {
    const labels = [...new Set([...(role.labels ?? []), ...(role.eligibility?.labels ?? [])])];
    const rawApplyUrl = role.originalApplicationUrl ?? null;
    const applyUrl = typeof rawApplyUrl === 'string' && /^https?:\/\//i.test(rawApplyUrl) ? rawApplyUrl : null;
    const extraModes = (role.otherModes ?? []).map((mode) => ({ normal: 'Pune', startup: 'Startup', remote: 'Remote' })[mode] ?? mode);
    const why = role.rationale ?? role.strongestHook ?? role.eligibility?.evidence ?? '';
    return `<article><h4>${html(role.title)} at ${html(role.company)}</h4><p>${html(role.location)}</p>${isShortlist ? `<p><strong>Why it fits:</strong> ${html(String(why || 'Not Verified').replace(/\s+/g, ' ').trim())}</p>` : ''}${labels.length ? `<p>Labels: ${labels.map(html).join(', ')}</p>` : ''}${extraModes.length ? `<p>Other modes: ${extraModes.map(html).join(', ')}</p>` : ''}${applyUrl ? `<p><a href="${html(applyUrl)}">Apply at employer</a></p>` : '<p>Apply link: Not Verified</p>'}</article>`;
  };
  const sections = modes.map(([mode, label]) => {
    const run = modeRuns[mode] ?? (result.mode === mode ? { results: result.results ?? [], shortlist: result.shortlist ?? [] } : {});
    return `<section data-mode="${mode}"><h2>${label}</h2><h3>Full results</h3>${(run.results ?? []).map((role) => roleCard(role, false)).join('') || '<p>None.</p>'}<h3>Shortlist</h3>${(run.shortlist ?? []).map((role) => roleCard(role, true)).join('') || '<p>None.</p>'}</section>`;
  }).join('');
  const targetRows = htmlTargetModes.map(([mode, label, roleTarget, employerTarget]) => {
    const shortlist = modeRuns[mode]?.shortlist ?? [];
    const verified = shortlist.filter((role) => (modeRuns[mode]?.results ?? []).some((candidate) => (candidate.canonicalUrl ?? candidate.url) === (role.canonicalUrl ?? role.url))).length;
    const employerCount = new Set(shortlist.map((role) => String(role.company ?? '').trim().toLowerCase()).filter(Boolean)).size;
    return `<tr><td>${label}</td><td>${shortlist.length}/${roleTarget}</td><td>${employerCount}/${employerTarget}</td><td>${verified}/${shortlist.length}</td><td>${Math.max(0, roleTarget - shortlist.length)} roles, ${Math.max(0, employerTarget - employerCount)} employers</td></tr>`;
  }).join('');
  const targets = `<section data-section="targets"><h2>Per-mode daily targets</h2><table><thead><tr><th>Mode</th><th>Roles / target</th><th>Employers / target</th><th>Verified shortlisted</th><th>Shortfall</th></tr></thead><tbody>${targetRows}</tbody></table></section>`;
  const stretch = `<section data-section="stretch"><h2>Stretch</h2>${(result.stretch ?? []).map((role) => roleCard(role, true)).join('') || '<p>None.</p>'}</section>`;
  const yieldRows = (result.sourceYield?.sources ?? []).map((row) => {
    const matchingTelemetry = Object.entries(telemetry).find(([id, source]) => id === row.sourceId || `${row.provider}:${row.board}` === row.sourceId || source.detail?.sources?.some((entry) => `${entry.provider}:${entry.board}` === row.sourceId));
    const boardTelemetry = matchingTelemetry?.[1].detail?.sources?.find((entry) => `${entry.provider}:${entry.board}` === row.sourceId);
    const requests = boardTelemetry ? sourceRequests(boardTelemetry) : matchingTelemetry ? sourceRequests(matchingTelemetry[1]) : null;
    const rate = requests == null ? 'Not Verified' : `${row.applicationReady ?? 0} application-ready roles / ${requests} requests`;
    return `<tr><td>${html(row.sourceId)}</td><td>${row.fetched ?? 0}</td><td>${row.applicationReady ?? 0}</td><td>${requests ?? 'Not Verified'}</td><td>${rate}</td></tr>`;
  }).join('');
  const sourceYield = `<section data-section="source-yield"><h2>Source yield per request</h2>${yieldRows ? `<table><thead><tr><th>Source</th><th>Fetched</th><th>Application-ready</th><th>Requests</th><th>Yield</th></tr></thead><tbody>${yieldRows}</tbody></table>` : '<p>Not Verified</p>'}</section>`;
  const driftSignals = dailyDriftSignals(result);
  const drift = `<section data-section="drift"><h2>Drift signals</h2>${driftSignals.length ? `<ul>${driftSignals.map((signal) => `<li>${html(signal)}</li>`).join('')}</ul>` : '<p>None recorded.</p>'}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Launchpad daily report</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212f}section{border-top:1px solid #ccd3dc;padding:1rem 0}article{padding:.5rem 1rem;margin:.5rem 0;background:#f5f7fa}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem;border-bottom:1px solid #ccd3dc}h1,h2{margin-bottom:.3rem}</style></head><body><h1>Launchpad daily report</h1><p>Run time: ${html(now)}</p><section><h2>Funnel counts</h2><ul>${funnel.map(([label, value]) => `<li>${label}: ${value}</li>`).join('')}</ul></section>${targets}${sections}${stretch}${sourceYield}${drift}</body></html>`;
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
