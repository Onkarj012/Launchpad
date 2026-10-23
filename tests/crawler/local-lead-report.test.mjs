import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLocalLeadReport, renderLocalDailyHtmlReport } from '../../crawler/local-lead-report.mjs';

const NOW = '2026-10-12T20:00:00.000Z';
const LOADED_HISTORY = { status: 'loaded', generatedAt: NOW, rowCount: 3 };

// A score in the shape the mode-scoring boundary accepts as scored output.
function scored(matchScore) {
  return { matchScore, score: matchScore, scoreOrigin: 'explicit-scored-input', responseLikelihood: 10 };
}

// Return the one card for a role id, from its article to the next article.
function cardFor(html, id) {
  return html.split('<article>').find((card) => card.includes(`<h5>${id} Engineer at `)) ?? '';
}

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
    assert.match(report, /Requested: Not Verified/);
    assert.match(report, /Shortfall this run: Not Verified/);
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

test('an incomplete source without a retained snapshot says the snapshot is Not Verified', () => {
  const result = { runAt: NOW, modes: {}, sourceEndStates: {
    'ats-warm': { state: 'failed', reason: 'HTTP_503' },
    'ats-direct': { state: 'ok' },
  } };
  for (const report of [renderLocalLeadReport(result, { now: NOW }), renderLocalDailyHtmlReport(result)]) {
    assert.match(report, /ats-warm: failed.*last successful snapshot Not Verified/);
    assert.doesNotMatch(report, /ats-direct: ok; last successful/);
  }
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

const ALLOCATION_SENTENCE = 'Not provided; fetched row volume does not establish marginal useful yield.';
const ZERO_STAGES = { jdPresent: 0, hardEligibilityPassed: 0, validScore: 0, scoringFailed: 0, historySuppressed: 0, verification: 0, selected: 0 };
const NOT_VERIFIED_COST = { requests: 'Not Verified', durationMs: 'Not Verified', failures: 'Not Verified', truncated: 'Not Verified' };
const COUNT_LANGUAGE = /\b(increase|pause|drop|prioritize|allocate more|recommend)\w*/i;

// Build a useful-yield payload shaped like buildUsefulSourceYield output.
function usefulYield(sources) {
  return { schemaVersion: 'LaunchpadUsefulSourceYieldV1', scope: 'final-selection', identityCount: 2, sources, allocationRecommendation: ALLOCATION_SENTENCE };
}

test('useful yield renders per source in Markdown and HTML, with Not Verified for missing cost and no count-based recommendation', () => {
  const result = {
    runAt: NOW,
    usefulSourceYield: usefulYield([
      { sourceId: 'theirstack', queryId: 'q-ai', kind: 'discovery', referenceCount: 2, uniqueRequisitions: 2,
        stages: { ...ZERO_STAGES, jdPresent: 2, hardEligibilityPassed: 1, validScore: 1, selected: 1 },
        endState: 'ok', endReason: 'Not Verified', cost: { requests: 3, durationMs: 900, failures: 0, truncated: false } },
      { sourceId: 'ats-warm', queryId: 'Not Verified', kind: 'discovery', referenceCount: 5, uniqueRequisitions: 5,
        stages: { ...ZERO_STAGES, jdPresent: 5, hardEligibilityPassed: 5, validScore: 5 },
        endState: 'degraded', endReason: 'source-degraded', cost: NOT_VERIFIED_COST },
    ]),
  };
  const markdown = renderLocalLeadReport(result, { now: NOW });
  const markdownSection = markdown.slice(markdown.indexOf('## Useful yield by source'), markdown.indexOf('\n## ', markdown.indexOf('## Useful yield by source') + 1));
  assert.match(markdownSection, /theirstack \| q-ai \| discovery \| 2 \| 2 \|/);
  assert.match(markdownSection, /ats-warm \| Not Verified \| discovery \| 5 \| 5 \| .*Not Verified \|/);
  assert.match(markdownSection, new RegExp(ALLOCATION_SENTENCE.replace(/[.]/g, '\\.')));
  assert.doesNotMatch(markdownSection, COUNT_LANGUAGE);

  const html = renderLocalDailyHtmlReport(result);
  const htmlSection = html.slice(html.indexOf('<section data-section="useful-yield">'), html.indexOf('</section>', html.indexOf('<section data-section="useful-yield">')));
  assert.match(htmlSection, /<td>ats-warm<\/td><td>Not Verified<\/td><td>discovery<\/td>/);
  assert.match(htmlSection, new RegExp(ALLOCATION_SENTENCE.replace(/[.]/g, '\\.')));
  assert.doesNotMatch(htmlSection, COUNT_LANGUAGE);
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
  assert.match(markdown, /\| Acme \| AI Engineer \| selected \| scored-on-retry-and-shortlisted \| 2 \| 2026-10-12T20:00:00\.000Z \| Not Verified \|/);
  assert.match(markdown, /\| Gamma Works \| Backend Engineer \| pending \| awaiting-current-evidence \| 1 \| Not Verified \| 2026-10-12T22:00:00\.000Z \|/);

  const html = renderLocalDailyHtmlReport(result);
  assert.match(html, /data-section="scoring-recovery"/);
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

test('P11 item 1: cards sit under Pune, India-eligible remote, or other-location headings inside each mode', () => {
  const pune = role('pune', 'Pune Labs', { location: 'Pune, India' });
  const remote = role('remote', 'Remote Labs', { location: 'Remote, India', workplaceType: 'Remote',
    eligibility: { eligible: true, reasons: [], geo: { pass: true, code: 'GEO_REMOTE_INDIA_COMPATIBLE', mode: 'remote' } } });
  const other = role('other', 'Bengaluru Labs', { location: 'Bengaluru, India' });
  const html = renderLocalDailyHtmlReport({ runAt: NOW, modes: { normal: { results: [other, remote, pune], shortlist: [pune] } } });
  const section = html.slice(html.indexOf('<section data-mode="normal">'), html.indexOf('<section data-mode="startup">'));
  let last = -1;
  for (const marker of ['<h4>Pune and Pune-metro</h4>', 'pune Engineer', '<h4>India-eligible remote</h4>', 'remote Engineer', '<h4>Other location evidence</h4>', 'other Engineer']) {
    const index = section.indexOf(marker, last + 1);
    assert.ok(index > last, `${marker} appears after the previous group inside the normal section`);
    last = index;
  }
});

test('P11 item 2: cards show the country or residency constraint and liveness with its check time', () => {
  const restricted = role('restricted', 'Scope Labs', {
    location: 'Remote',
    workplaceType: 'Remote',
    eligibility: { geo: { code: 'GEO_REMOTE_REGION_RESTRICTED', evidence: 'Candidates must reside in Canada' }, reasons: [] },
    liveness: { status: 'Active', checkedAt: '2026-10-22T10:00:00.000Z' },
  });
  const bare = role('bare', 'Bare Labs', {});
  const html = renderLocalDailyHtmlReport({ runAt: NOW, modes: { remote: { results: [restricted, bare], shortlist: [] } } });
  assert.match(html, /Country or residency constraint: GEO_REMOTE_REGION_RESTRICTED \(Candidates must reside in Canada\)/);
  assert.match(html, /Liveness: Active; checked 2026-10-22 15:30:00 IST/);
  assert.match(html, /Country or residency constraint: Not Verified/);
  assert.match(html, /Liveness: Not Verified; checked Not Verified/);
});

test('P11 item 3: each card names its state, exact reasons, missing fields and next safe action', () => {
  const ready = role('ready', 'Ready Labs', { applicationReady: true, applicationReadiness: 'Ready', ...scored(82) });
  const promising = role('promising', 'Promising Labs', { reasons: ['LIVENESS_NOT_VERIFIED', 'ORIGINAL_APPLICATION_URL_MISSING'] });
  const rejected = role('rejected', 'Rejected Labs', { eligibility: { reasons: ['GEO_ONSITE_NOT_PUNE'] } });
  const html = renderLocalDailyHtmlReport({ runAt: NOW,
    modes: { normal: { results: [ready, rejected], shortlist: [] } },
    verificationQueue: [promising],
  });
  assert.match(html, /<h5>ready Engineer at Ready Labs<\/h5>[\s\S]*State: Ready and scored[\s\S]*Reasons: None recorded[\s\S]*Next safe action: Check the history snapshot/);
  assert.match(html, /<h5>rejected Engineer at Rejected Labs<\/h5>[\s\S]*State: Rejected[\s\S]*Reasons: GEO_ONSITE_NOT_PUNE[\s\S]*Next safe action: Manual review/);
  assert.match(html, /<h5>promising Engineer at Promising Labs<\/h5>[\s\S]*State: Promising, needs verification[\s\S]*Reasons: LIVENESS_NOT_VERIFIED, ORIGINAL_APPLICATION_URL_MISSING/);
  assert.match(html, /<details><summary>Missing fields<\/summary><ul><li>LIVENESS_NOT_VERIFIED<\/li><li>ORIGINAL_APPLICATION_URL_MISSING<\/li><\/ul><\/details>/);
  assert.match(html, /Next safe action: Re-check the employer page; Find the employer apply route/);
});

test('rejected cards use only rejection reasons and keep a manual-review fallback without codes', () => {
  const rejected = role('rejected', 'Rejected Labs', {
    eligibility: { eligible: false, reasons: ['EXPERIENCE_MIN_YEARS_EXCEEDED'] },
  });
  const withoutCodes = role('no-codes', 'No Codes Labs', { eligibility: { eligible: false, reasons: [] } });
  const html = renderLocalDailyHtmlReport({ runAt: NOW,
    modes: { normal: { results: [rejected, withoutCodes], shortlist: [] } },
  });
  const rejectedCard = cardFor(html, 'rejected');
  const noCodesCard = cardFor(html, 'no-codes');
  for (const card of [rejectedCard, noCodesCard]) {
    assert.match(card, /State: Rejected<\/p>/);
    assert.doesNotMatch(card, /SCORE_NOT_VERIFIED|HISTORY_NOT_VERIFIED|Re-run scoring|Check the history snapshot/);
  }
  assert.match(rejectedCard, /Next safe action: Read the full JD requirement<\/p>/);
  assert.match(rejectedCard, /Application readiness: Not application-ready: EXPERIENCE_MIN_YEARS_EXCEEDED<\/p>/);
  assert.match(noCodesCard, /Reasons: None recorded<\/p>/);
  assert.match(noCodesCard, /Next safe action: Manual review<\/p>/);
  assert.match(noCodesCard, /Application readiness: Not application-ready: READINESS_NOT_VERIFIED<\/p>/);
});

test('P11 item 4: each card shows exactly one novelty label, and New-market verified needs loaded history', () => {
  const recovered = role('recovered', 'Held Labs', { evidence: { recovery: { kind: 'held-lead-recovery' } } });
  const surfaced = role('surfaced', 'Ledger Labs', { ledgerSurfaced: true });
  const fresh = role('fresh', 'Verified Labs', {});
  const labels = ['New-market verified', 'First seen locally', 'Recovered existing lead', 'Already surfaced'];
  const labelsPerCard = (html) => (html.match(/<article>[\s\S]*?<\/article>/g) ?? [])
    .map((card) => labels.filter((label) => card.includes(`Novelty: ${label}`)));
  const render = (v4HistorySnapshot) => renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot,
    modes: { normal: { results: [recovered, surfaced, fresh], shortlist: [] } } });

  assert.deepEqual(labelsPerCard(render(LOADED_HISTORY)),[['Recovered existing lead'], ['Already surfaced'], ['New-market verified']]);
  for (const snapshot of [{ status: 'stale' }, { status: 'missing' }, undefined]) {
    const cards = labelsPerCard(render(snapshot));
    assert.deepEqual(cards, [['Recovered existing lead'], ['Already surfaced'], ['First seen locally']]);
  }
});

test('P11 item 5: counts show requested, eligible, selected, confirmed delivered and shortfall separately', () => {
  const picked = [
    role('a', 'A Labs', { applicationReady: true, applicationReadiness: 'Ready', matchScore: 80 }),
    role('b', 'B Labs', { applicationReady: true, applicationReadiness: 'Ready', matchScore: 81 }),
  ];
  const result = { runAt: NOW, requestedShortlistLimit: 5, counts: { eligible: 14 },
    modes: { normal: { results: picked, shortlist: picked } },
    deliveryReconciliation: { counts: { deliveredKeys: 2 } },
  };
  const html = renderLocalDailyHtmlReport(result);
  assert.match(html, /<section data-section="counts"><h2>Counts<\/h2><ul><li>Requested: 5<\/li><li>Eligible: 14<\/li><li>Selected: 2<\/li><li>Confirmed delivered: 2<\/li><li>Shortfall this run: 3<\/li><\/ul><\/section>/);
  assert.match(renderLocalLeadReport(result, { now: NOW }), /Requested: 5\. Eligible: 14\. Selected: 2\. Confirmed delivered: 2\. Shortfall this run: 3\./);

  const empty = renderLocalDailyHtmlReport({ runAt: NOW, modes: {} });
  assert.match(empty, /<li>Requested: Not Verified<\/li><li>Eligible: Not Verified<\/li><li>Selected: 0<\/li><li>Confirmed delivered: Not Verified<\/li><li>Shortfall this run: Not Verified<\/li>/);
});

test('P11 item 5: a card is Application-ready only with ready status, a valid score and loaded history', () => {
  const ready = role('ready', 'Ready Labs', { applicationReady: true, applicationReadiness: 'Ready', ...scored(82) });
  const unscored = role('unscored', 'Unscored Labs', { applicationReady: true, applicationReadiness: 'Ready' });
  const withoutHistory = renderLocalDailyHtmlReport({ runAt: NOW, modes: { normal: { results: [ready], shortlist: [] } } });
  assert.match(withoutHistory, /Application readiness: Not application-ready: HISTORY_NOT_VERIFIED/);
  assert.doesNotMatch(withoutHistory, /Application readiness: Application-ready/);

  const withHistory = renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot: LOADED_HISTORY, modes: { normal: { results: [ready], shortlist: [] } } });
  assert.match(withHistory, /Application readiness: Application-ready/);

  const unscoredHtml = renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot: LOADED_HISTORY, modes: { normal: { results: [unscored], shortlist: [] } } });
  assert.match(unscoredHtml, /Application readiness: Not application-ready: SCORE_NOT_VERIFIED/);
  assert.doesNotMatch(unscoredHtml, /Application readiness: Application-ready/);
});

test('P11 item 6: reports never show Applied? or Make Resume values, and the only action link is the employer apply link', () => {
  const ready = role('ready', 'Ready Labs', { applicationReady: true, applicationReadiness: 'Ready', matchScore: 82, originalApplicationUrl: 'https://careers.example.test/ready' });
  const noRoute = role('noroute', 'No Route Labs', { reasons: ['ORIGINAL_APPLICATION_URL_MISSING'] });
  const observation = { title: 'AI Engineer', company: 'Gate Labs', location: 'Bengaluru, India', canonicalUrl: 'https://jobs.example.test/gate',
    description: 'Full-time AI Engineer role.', postedAt: NOW, employment: { type: 'full-time' }, experience: { minYears: 0, maxYears: 1 },
    liveness: { status: 'Expired' } };
  const result = { runAt: NOW, mode: 'normal', shortlist: [ready], observations: [observation],
    modes: { normal: { results: [ready, noRoute], shortlist: [ready] } }, verificationQueue: [noRoute] };
  const markdown = renderLocalLeadReport(result, { now: NOW });
  const html = renderLocalDailyHtmlReport(result);
  for (const report of [markdown, html]) {
    assert.doesNotMatch(report, /Applied\?/);
    assert.doesNotMatch(report, /Make Resume/);
  }
  assert.doesNotMatch(html, /<(button|form|input|select|textarea)\b|mailto:|Send|Message/);
  assert.equal(html.match(/<a /g)?.length ?? 0, html.match(/>Apply at employer<\/a>/g)?.length ?? 0);
});

test('P11 r1 finding 1: the retained gate outcome decides Rejected or Promising for the four reason codes', () => {
  const cases = [
    ['undated', 'Promising, needs verification', role('undated', 'Undated Labs', {
      eligibility: { eligible: true, reasons: [] },
      freshness: { eligible: false, window: 'VerifyQueue', verifyQueue: true, code: 'FRESHNESS_UNDATED_VERIFY_QUEUE' } })],
    ['contract', 'Promising, needs verification', role('contract', 'Contract Labs', {
      eligibility: { eligible: false, reasons: ['EMPLOYMENT_CONTRACT_TERMS_UNVERIFIED'],
        employment: { pass: false, code: 'EMPLOYMENT_CONTRACT_TERMS_UNVERIFIED', verificationRequired: true } } })],
    ['stipend', 'Rejected', role('stipend', 'Stipend Labs', {
      eligibility: { eligible: false, reasons: ['STIPEND_MISSING'], employment: { pass: false, code: 'STIPEND_MISSING' } } })],
    ['ppo', 'Rejected', role('ppo', 'PPO Labs', {
      eligibility: { eligible: false, reasons: ['INTERNSHIP_PPO_NOT_STATED'], employment: { pass: false, code: 'INTERNSHIP_PPO_NOT_STATED' } } })],
  ];
  for (const [id, state, item] of cases) {
    const card = cardFor(renderLocalDailyHtmlReport({ runAt: NOW, modes: { normal: { results: [item], shortlist: [] } } }), id);
    assert.match(card, new RegExp(`State: ${state}<`), `${id} state`);
  }
});

test('P11 r1 finding 1: a contract role with unverified terms waits in Needs verification, not Rejected', () => {
  const observation = { title: 'AI Engineer', company: 'Contract Labs', location: 'Remote, India', workplaceType: 'Remote', canonicalUrl: 'https://jobs.example.test/contract',
    description: 'Contract role for 12 months, fixed monthly pay, direct hire, full-time.', postedAt: NOW, employment: { type: 'contract', evidence: 'Contract' },
    experience: { minYears: 0, maxYears: 1 }, liveness: { status: 'Active' } };
  const markdown = renderLocalLeadReport({ runAt: NOW, mode: 'normal', observations: [observation], modes: {} }, { now: NOW });
  const review = markdown.slice(markdown.indexOf('## Needs verification'), markdown.indexOf('## Rejected'));
  assert.match(review, /Contract Labs \|/);
  assert.match(review, /Promising, needs verification \| EMPLOYMENT_CONTRACT_TERMS_UNVERIFIED/);
});

test('P11 r1 finding 2: only a usable match score makes a card Ready and scored', () => {
  const item = (id, extra) => role(id, `${id} Labs`, { applicationReady: true, applicationReadiness: 'Ready', ...extra });
  const usable = renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot: LOADED_HISTORY, modes: { normal: { results: [item('usable', scored(82))], shortlist: [] } } });
  assert.match(cardFor(usable, 'usable'), /State: Ready and scored<\/p>[\s\S]*Application readiness: Application-ready/);

  const unusable = [
    ['negative', { matchScore: -1, score: -1, scoreOrigin: 'explicit-scored-input', responseLikelihood: 10 }],
    ['over', { matchScore: 101, score: 101, scoreOrigin: 'explicit-scored-input', responseLikelihood: 10 }],
    ['failed', { ...scored(82), scoringFailed: true }],
  ];
  for (const [id, extra] of unusable) {
    const card = cardFor(renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot: LOADED_HISTORY, modes: { normal: { results: [item(id, extra)], shortlist: [] } } }), id);
    assert.doesNotMatch(card, /State: Ready and scored/, `${id} is not scored`);
    assert.doesNotMatch(card, /Application readiness: Application-ready/, `${id} is not application-ready`);
  }
});

test('P11 r1 finding 3: history counts as loaded only with a valid generation time and retained rows', () => {
  const ready = role('history', 'History Labs', { applicationReady: true, applicationReadiness: 'Ready', ...scored(82) });
  const render = (v4HistorySnapshot) => cardFor(renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot,
    modes: { normal: { results: [ready], shortlist: [] } } }), 'history');
  assert.match(render(LOADED_HISTORY), /Novelty: New-market verified/);
  for (const snapshot of [{ status: 'loaded' }, { status: 'loaded', rowCount: 0 }, { status: 'loaded', generatedAt: 'not-a-date', rowCount: 3 },
    { ...LOADED_HISTORY, status: 'stale' }]) {
    const card = render(snapshot);
    assert.match(card, /Novelty: First seen locally/, JSON.stringify(snapshot));
    assert.doesNotMatch(card, /Application readiness: Application-ready/, JSON.stringify(snapshot));
  }
});

test('P11 r1 finding 4: a role rejected on geography never sits under the India-eligible remote heading', () => {
  const canada = role('canada', 'Canada Labs', { location: 'Remote', workplaceType: 'Remote',
    eligibility: { eligible: false, reasons: ['GEO_REMOTE_REGION_RESTRICTED'], geo: { pass: false, code: 'GEO_REMOTE_REGION_RESTRICTED', mode: 'remote', evidence: 'Candidates must reside in Canada' } } });
  const india = role('india', 'India Labs', { location: 'Remote', workplaceType: 'Remote',
    eligibility: { eligible: true, reasons: [], geo: { pass: true, code: 'GEO_REMOTE_INDIA_COMPATIBLE', mode: 'remote' } } });
  const unknown = role('unknown', 'Unknown Labs', { location: 'Remote', workplaceType: 'Remote' });
  const html = renderLocalDailyHtmlReport({ runAt: NOW, modes: { remote: { results: [canada, india, unknown], shortlist: [] } } });
  const section = html.slice(html.indexOf('<section data-mode="remote">'), html.indexOf('<section data-mode="eorContract">'));
  const remoteHeading = section.indexOf('<h4>India-eligible remote</h4>');
  const otherHeading = section.indexOf('<h4>Other location evidence</h4>');
  assert.ok(remoteHeading >= 0 && otherHeading > remoteHeading, 'both headings render');
  assert.ok(section.indexOf('<h5>india Engineer at ') > remoteHeading && section.indexOf('<h5>india Engineer at ') < otherHeading);
  assert.ok(section.indexOf('<h5>canada Engineer at ') > otherHeading, 'Canada-only role sits under other location evidence');
  assert.ok(section.indexOf('<h5>unknown Engineer at ') > otherHeading, 'remote wording without a passing geography gate is not India-eligible');
});

test('P11 r1 finding 5: card titles render at least as large as body text', () => {
  const html = renderLocalDailyHtmlReport({ runAt: NOW, modes: {} });
  assert.match(html, /article h5\{font-size:1\.05rem;margin:\.25rem 0\}/);
});

test('P11 r1 finding 6: roles that share one apply route keep separate cards and name the shared route', () => {
  const route = 'https://careers.example.test/apply';
  const shared = [role('route-a', 'Route Labs', { originalApplicationUrl: route }), role('route-b', 'Route Two Labs', { originalApplicationUrl: route })];
  const own = role('route-c', 'Own Labs', { originalApplicationUrl: 'https://own.example.test/apply' });
  const html = renderLocalDailyHtmlReport({ runAt: NOW, modes: { normal: { results: [...shared, own], shortlist: [] } } });
  const cards = html.split('<article>').slice(1);
  assert.equal(cards.length, 3, 'no card is merged');
  for (const id of ['route-a', 'route-b']) {
    assert.match(cardFor(html, id), /SHARED_APPLY_ROUTE/, `${id} names the shared route`);
    assert.match(cardFor(html, id), /Verify each role&#39;s own employer listing/, `${id} next step`);
  }
  assert.doesNotMatch(cardFor(html, 'route-c'), /SHARED_APPLY_ROUTE/);
});

test('P11 r1 finding 8: a ready card shows the requirement excerpt from the retained experience decision', () => {
  const ready = role('excerpt', 'Excerpt Labs', { applicationReady: true, applicationReadiness: 'Ready', ...scored(82),
    eligibility: { eligible: true, reasons: [], experience: { pass: true, code: 'EXPERIENCE_EARLY_CAREER', selectedTrack: 'early-career',
      evidence: 'Early-career track', requirements: [{ excerpt: 'Requires 0-1 years of experience' }] } } });
  const html = renderLocalDailyHtmlReport({ runAt: NOW, v4HistorySnapshot: LOADED_HISTORY, modes: { normal: { results: [ready], shortlist: [] } } });
  assert.match(cardFor(html, 'excerpt'), /Experience: EXPERIENCE_EARLY_CAREER[^<]*Requires 0-1 years of experience/);
});
