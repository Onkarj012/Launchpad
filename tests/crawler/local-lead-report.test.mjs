import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLocalLeadReport, renderLocalDailyHtmlReport } from '../../crawler/local-lead-report.mjs';

const NOW = '2026-10-12T20:00:00.000Z';

// Make a retained role with a stable identity for report counting.
function role(id, company, overrides = {}) {
  return { title: `${id} Engineer`, company, canonicalUrl: `https://jobs.example.test/${id}`, selectionTier: 'Strict', ...overrides };
}

test('reports separate this-run focus delivery, all-mode allocation and cumulative IST-day targets', () => {
  const startup = role('startup-new', 'Startup Labs');
  const normal = role('normal-new', 'Pune Labs');
  const remote = role('remote-new', 'Remote Labs');
  const cumulativeCandidates = [
    ...Array.from({ length: 10 }, (_, index) => ({ key: `pune-${index}`, company: `Pune ${index % 6}`, tier: index < 2 ? 'Strict' : 'Fallback', primaryMode: 'normal' })),
    ...Array.from({ length: 5 }, (_, index) => ({ key: `startup-${index}`, company: `Startup ${index % 4}`, tier: 'Fallback', primaryMode: 'startup' })),
    { key: 'remote-0', company: 'Remote Labs', tier: 'Fallback', primaryMode: 'remote' },
  ];
  const result = { runAt: NOW, mode: 'startup', shortlist: [startup],
    modes: {
      normal: { results: [normal], shortlist: [normal] },
      startup: { results: [startup], shortlist: [startup] },
      remote: { results: [remote], shortlist: [remote] },
      eorContract: { shortlist: [role('eor', 'EOR Labs', { labels: ['EOR'] })] },
    },
    dailyShortlistBudget: { date: '2026-10-13', selectedToday: 16, strictSelected: 2, remaining: 4, cumulativeCandidates },
    phaseTargetRollup: { endDate: '2026-10-13', days: [{ date: '2026-10-13', strict: 2, historyVerified: true, modes: {} }], modes: {} },
    stretch: [role('stretch', 'Stretch Labs')], verificationQueue: [role('held', 'Held Labs')],
  };
  const markdown = renderLocalLeadReport(result, { now: NOW });
  const html = renderLocalDailyHtmlReport(result);
  for (const report of [markdown, html]) {
    assert.match(report, /Requested-mode delivery focus: Startup\. This-run focus delivery: 1 roles\./);
    assert.match(report, /This-run all-mode allocation: 3 roles\./);
    assert.match(report, /Cumulative all-mode roles today: 16\/20 maximum\. Remaining daily capacity: 4\./);
    assert.match(report, /Cumulative Strict across modes today: 2, phase target 2\./);
    assert.match(report, /Historical suppression evidence: Verified\./);
    assert.match(report, /This-run Stretch: 1\. EOR \/ Contract: 1\. VerifyQueue: 1\./);
  }
  assert.match(markdown, /\| Pune \(normal\) \| 10\/10 \| 6\/6 \| 2 \| None \|/);
  assert.match(markdown, /\| Startup \| 5\/5 \| 4\/4 \| 0 \| None \|/);
  assert.match(markdown, /\| Remote \| 1\/5 \| 1\/4 \| 0 \| 4 roles, 3 employers \|/);
  assert.match(html, /<td>Pune<\/td><td>10\/10<\/td><td>6\/6<\/td><td>2<\/td><td>None<\/td>/);
  assert.match(html, /Run time: 2026-10-13 01:30:00 IST/);
});

test('missing retained daily evidence stays unverified rather than relabeling this-run counts', () => {
  const normal = role('normal', 'Pune Labs');
  const result = { runAt: NOW, mode: 'normal', shortlist: [normal], modes: { normal: { results: [normal], shortlist: [normal] } } };
  for (const report of [renderLocalLeadReport(result, { now: NOW }), renderLocalDailyHtmlReport(result)]) {
    assert.match(report, /This-run all-mode allocation: 1 roles\./);
    assert.match(report, /Cumulative all-mode roles today: Not Verified\/20 maximum/);
    assert.match(report, /Not Verified\/10/);
  }
});

test('current IST-day phase counts can report cumulative totals without candidate records', () => {
  const result = { runAt: NOW, modes: {},
    phaseTargetRollup: { endDate: '2026-10-13', days: [
      { date: '2026-10-12', strict: 9, modes: { normal: { roles: 10, employers: 6, strict: 9 } } },
      { date: '2026-10-13', strict: 2, historyVerified: false, modes: { normal: { roles: 8, employers: 5, strict: 2 } } },
    ], modes: {} },
  };
  const report = renderLocalLeadReport(result, { now: NOW });
  assert.match(report, /\| Pune \(normal\) \| 8\/10 \| 5\/6 \| 2 \| 2 roles, 1 employers \|/);
  assert.match(report, /Cumulative Strict across modes today: 2/);
  assert.match(report, /Historical suppression evidence: Not Verified/);
});

test('retained phase counts take precedence over reconstructed employer names', () => {
  const report = renderLocalDailyHtmlReport({ runAt: NOW, modes: {},
    dailyShortlistBudget: { date: '2026-10-13', cumulativeCandidates: [
      { key: 'one', company: 'Acme, Inc.', tier: 'Strict', primaryMode: 'normal' },
      { key: 'two', company: 'Acme Inc', tier: 'Strict', primaryMode: 'normal' },
    ] },
    phaseTargetRollup: { days: [{ date: '2026-10-13', modes: { normal: { roles: 2, employers: 1, strict: 2 } } }], modes: {} },
  });
  assert.match(report, /<td>Pune<\/td><td>2\/10<\/td><td>1\/6<\/td><td>2<\/td>/);
});

test('separate and unresolved roles never contribute to this-run target counts', () => {
  const candidates = [
    role('ready', 'Ready Labs'),
    role('stretch', 'Stretch Labs', { selectionTier: 'Stretch' }),
    role('eor', 'EOR Labs', { labels: ['EOR'] }),
    role('contract', 'Contract Labs', { employmentCategory: 'Contract' }),
    role('unresolved', 'Unresolved Labs', { freshness: { window: 'VerifyQueue' } }),
  ];
  const report = renderLocalDailyHtmlReport({ runAt: NOW, mode: 'normal', shortlist: candidates,
    modes: { normal: { shortlist: candidates } },
  });
  assert.match(report, /This-run focus delivery: 1 roles/);
  assert.match(report, /This-run all-mode allocation: 1 roles/);
  assert.match(report, /<li>Shortlisted: 1<\/li>/);
});

test('roles without URLs remain separate identities while cross-mode copies count once', () => {
  const first = { title: 'AI Engineer', company: 'First Labs', location: 'Pune', selectionTier: 'Strict' };
  const second = { title: 'AI Engineer', company: 'Second Labs', location: 'Pune', selectionTier: 'Strict' };
  const report = renderLocalDailyHtmlReport({ runAt: NOW, modes: {
    normal: { shortlist: [first, second] }, startup: { shortlist: [first] },
  } });
  assert.match(report, /This-run all-mode allocation: 2 roles/);
  assert.match(report, /<li>Employers represented: 2<\/li>/);
  assert.match(report, /<li>Strict: 2<\/li>/);
});

test('HTML renders source failures and incomplete end states even after nonzero fetches', () => {
  const result = { runAt: NOW, modes: {}, sourceEndStates: {
    partial: { state: 'failed', reason: 'HTTP 503 after one page' },
    capped: { state: 'truncated', reason: 'candidate cap' },
    stopped: { state: 'interrupted', reason: 'deadline' },
  } };
  for (const report of [renderLocalLeadReport(result, { now: NOW }), renderLocalDailyHtmlReport(result)]) {
    assert.match(report, /partial: failed/);
    assert.match(report, /capped: truncated/);
    assert.match(report, /stopped: interrupted/);
  }
});

test('daily terminal envelope source failures remain visible in HTML Markdown and drift signals', () => {
  const result = { runAt: '2026-10-13T06:00:00Z', modes: { normal: { results: [], shortlist: [] } }, terminalEnvelope: { sourceEndStates: { 'ats-warm': { state: 'failed', reason: 'HTTP_503' } } } };
  const rendered = renderLocalDailyHtmlReport(result);
  assert.match(rendered, /ats-warm: failed/);
  assert.match(rendered, /HTTP_503/);
  assert.match(rendered, /ats-warm: board failure/);
  assert.match(renderLocalLeadReport(result, { now: result.runAt }), /ats-warm: failed/);
});

test('fatal HTML reports show escaped causes, retained coverage, unknown counts, and event dates', () => {
  const result = {
    runAt: NOW,
    outcome: { status: 'fatal', errors: [{ message: 'Scorer <offline> & timed out' }] },
    terminalEnvelope: {
      status: 'failed',
      fatalReason: 'Scorer <offline> & timed out',
      sourceCoverage: { completed: [], interrupted: ['workday'], failed: ['ats-warm'], not_started: ['career-sites'] },
      sourceEndStates: { 'ats-warm': { state: 'failed', reason: 'HTTP <503>' } },
      lastDurableSourceState: { completed: ['greenhouse'] },
    },
    hiringEvents: { items: [{ title: 'Campus drive', date: '2026-10-20' }] },
  };
  const report = renderLocalDailyHtmlReport(result);
  assert.match(report, /Status: failed/);
  assert.match(renderLocalLeadReport(result, { now: NOW }), /Status: failed/);
  assert.match(report, /Cause: Scorer &lt;offline&gt; &amp; timed out/);
  assert.match(report, /completed:<\/strong> None recorded/);
  assert.match(report, /interrupted:<\/strong> workday/);
  assert.match(report, /failed:<\/strong> ats-warm/);
  assert.match(report, /not started:<\/strong> career-sites/);
  assert.match(report, /ats-warm: failed, HTTP &lt;503&gt;/);
  assert.match(report, /Fetched: Not Verified/);
  assert.match(report, /Campus drive: 2026-10-20/);

  const degraded = {
    runAt: NOW,
    outcome: { status: 'degraded', errors: [{ stage: 'transaction', message: 'delivery transaction incomplete: aborted' }] },
    terminalEnvelope: { status: 'completed', deliveryReconciliation: { status: 'degraded' } },
  };
  for (const rendered of [renderLocalDailyHtmlReport(degraded), renderLocalLeadReport(degraded, { now: NOW })]) {
    assert.match(rendered, /Status: degraded/);
    assert.match(rendered, /delivery transaction incomplete: aborted/);
    assert.doesNotMatch(rendered, /Status: completed/);
  }

  const successful = { outcome: { status: 'ok' }, terminalEnvelope: { status: 'completed' } };
  for (const rendered of [renderLocalDailyHtmlReport(successful), renderLocalLeadReport(successful, { now: NOW })]) {
    assert.match(rendered, /Status: completed/);
  }

  const successfulPartialEnvelope = { outcome: { status: 'ok' }, terminalEnvelope: { status: 'partial' } };
  for (const rendered of [renderLocalDailyHtmlReport(successfulPartialEnvelope), renderLocalLeadReport(successfulPartialEnvelope, { now: NOW })]) {
    assert.match(rendered, /Status: partial/);
  }

  const unknown = { outcome: { status: 'unknown' }, terminalEnvelope: { status: 'completed' } };
  for (const rendered of [renderLocalDailyHtmlReport(unknown), renderLocalLeadReport(unknown, { now: NOW })]) {
    assert.match(rendered, /Status: Not Verified/);
  }

  const partial = { outcome: { status: 'partial' }, terminalEnvelope: { status: 'partial' } };
  for (const rendered of [renderLocalDailyHtmlReport(partial), renderLocalLeadReport(partial, { now: NOW })]) {
    assert.match(rendered, /Status: partial/);
  }
});

test('source yield uses the matching board request evidence and keeps unknown boards unverified', () => {
  const report = renderLocalDailyHtmlReport({ sourceYieldScope: 'crawler-discovery',
    sourceYield: { sources: [
      { sourceId: 'greenhouse:acme', provider: 'greenhouse', board: 'acme', applicationReady: 2 },
      { sourceId: 'greenhouse:missing', provider: 'greenhouse', board: 'missing', applicationReady: 1 },
    ] },
    sourceTelemetry: { unrelated: { requests: 99 } },
    crawlerV2Telemetry: { warm: { detail: { sources: [{ provider: 'greenhouse', board: 'Acme', requests: 4 }] } } },
    terminalEnvelope: { lastDurableSourceState: { warm: { status: 'succeeded', fetched: 2, detail: { description: 'x'.repeat(100_000) } } } },
  });
  assert.match(report, /2 application-ready roles \/ 4 requests/);
  assert.doesNotMatch(report, /99 requests|100000|x{100}/);
  assert.match(report, /greenhouse:missing<\/td><td>0<\/td><td>1<\/td><td>Not Verified/);
  assert.match(report, /Discovery counts precede final enrichment and scoring/);
});

test('E: the scoring recovery section shows counts, retry rows, and Not Verified for a missing attempt time', () => {
  const result = {
    runAt: NOW,
    outcome: { status: 'completed' },
    scoringRetry: { schemaVersion: 1, records: [
      { company: 'Acme', title: 'AI Engineer', outcome: 'selected', outcomeReason: 'scored-on-retry-and-shortlisted', attemptCount: 2, attemptedAt: NOW, nextEligibleAt: null },
      { company: 'Beta Labs', title: 'ML Engineer', outcome: 'pending', outcomeReason: 'scoring-failed', attemptCount: 1, attemptedAt: NOW, nextEligibleAt: '2026-10-12T22:00:00.000Z' },
      { company: 'Gamma Works', title: 'Backend Engineer', outcome: 'pending', outcomeReason: 'awaiting-current-evidence', attemptCount: 1, attemptedAt: null, nextEligibleAt: '2026-10-12T22:00:00.000Z' },
      { company: 'Delta Co', title: 'Full Stack Engineer', outcome: 'terminal', outcomeReason: 'scoring-retry-exhausted', attemptCount: 3, attemptedAt: NOW, nextEligibleAt: null },
    ] },
  };

  const markdown = renderLocalLeadReport(result, { now: NOW });
  assert.match(markdown, /## Scoring recovery/);
  assert.match(markdown, /Recovered: 0\. Selected: 1\. Scoring failed: 1\. Failed again: 1\. Waiting for current evidence: 1\. Terminal: 1\./);
  assert.match(markdown, /\| Acme \| AI Engineer \| selected \| scored-on-retry-and-shortlisted \| 2 \| 2026-10-12T20:00:00\.000Z \| Not scheduled \|/);
  assert.match(markdown, /\| Gamma Works \| Backend Engineer \| pending \| awaiting-current-evidence \| 1 \| Not Verified \| 2026-10-12T22:00:00\.000Z \|/);

  const html = renderLocalDailyHtmlReport(result);
  assert.match(html, /data-section="scoring-recovery"/);
  assert.match(html, /<td>Acme<\/td><td>AI Engineer<\/td><td>selected<\/td><td>scored-on-retry-and-shortlisted<\/td><td>2<\/td><td>2026-10-12T20:00:00\.000Z<\/td><td>Not scheduled<\/td>/);
  assert.match(html, /Selected: 1\. Scoring failed: 1\. Failed again: 1\. Waiting for current evidence: 1\. Terminal: 1\./);
  assert.match(html, /<td>Gamma Works<\/td><td>Backend Engineer<\/td><td>pending<\/td><td>awaiting-current-evidence<\/td><td>1<\/td><td>Not Verified<\/td>/);
});

test('F: scoring recovery splits first failures from repeat failures and marks the retry column as not enforced', () => {
  const result = {
    runAt: NOW,
    outcome: { status: 'completed' },
    scoringRetry: { schemaVersion: 1, records: [
      { company: 'Acme', title: 'AI Engineer', outcome: 'pending', outcomeReason: 'scoring-failed', attemptCount: 1, attemptedAt: NOW, nextEligibleAt: '2026-10-12T22:00:00.000Z' },
      { company: 'Beta Labs', title: 'ML Engineer', outcome: 'pending', outcomeReason: 'scoring-failed', attemptCount: 2, attemptedAt: NOW, nextEligibleAt: '2026-10-13T00:00:00.000Z' },
    ] },
  };

  const markdown = renderLocalLeadReport(result, { now: NOW });
  assert.match(markdown, /Scoring failed: 1\. Failed again: 1\./);
  assert.match(markdown, /\| Earliest retry \(not enforced\) \|/);

  const html = renderLocalDailyHtmlReport(result);
  assert.match(html, /Scoring failed: 1\. Failed again: 1\./);
  assert.match(html, /<th>Earliest retry \(not enforced\)<\/th>/);
});

test('G: a selection carried from an earlier run is not counted as this run selection', () => {
  const result = {
    runAt: NOW,
    outcome: { status: 'completed' },
    shortlist: [],
    scoringRetry: { schemaVersion: 1, records: [
      { company: 'Acme', title: 'AI Engineer', outcome: 'selected', outcomeReason: 'shortlisted-previous-run', attemptCount: 2, attemptedAt: NOW, nextEligibleAt: null, carried: true },
    ] },
  };

  const markdown = renderLocalLeadReport(result, { now: NOW });
  assert.match(markdown, /Recovered: 0\. Selected: 0\./);
  assert.match(markdown, /\| Acme \| AI Engineer \| selected \| previous run: shortlisted \|/);

  const html = renderLocalDailyHtmlReport(result);
  assert.match(html, /Recovered: 0\. Selected: 0\./);
  assert.match(html, /<td>previous run: shortlisted<\/td>/);
});
