import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyHistoryEvidence, dailyShortlistBudget, retainDailyShortlist, retainDailyPhaseTargetRun, selectDailyModes } from '../../crawler/daily-runner.mjs';
import { loadConfig } from '../../job-pull/config.mjs';
import { candidateDedupKey } from '../../job-pull/candidate.mjs';
import { OPPORTUNITY_COLUMNS } from '../../job-pull/opportunity-ledger.mjs';

const NOW = '2026-10-13T06:00:00Z';
const HISTORY = { verified: true, status: 'loaded fixture', scope: 'isolated test' };

// Create verified input entries with distinct retained identities.
function entry(mode, index, company = `${mode} Employer ${index}`) {
  return {
    candidate: { canonicalUrl: `https://jobs.example.test/${mode}/${index}`, company, title: 'AI Engineer',
      location: mode === 'remote' ? 'Remote - India' : 'Pune', matchScore: 85, responseLikelihood: 15,
      scoreOrigin: 'explicit-scored-input', roleFamily: 'ai-llm-agentic',
      ...(mode === 'startup' ? { companyStage: 'Startup', startupStageEvidenceRef: 'https://portfolio.example.test/startup' } : {}) },
    eligibility: { eligible: true, strict: true, tier: 'strict', roleFamily: 'ai-llm-agentic', employment: { lane: 'full-time' },
      geo: { mode: mode === 'remote' ? 'remote' : 'onsite', code: mode === 'remote' ? 'GEO_REMOTE_INDIA_COMPATIBLE' : 'GEO_PUNE_METRO' } },
    freshness: { eligible: true, window: 'Hot', ageHours: 1 }, readiness: { ready: true, evidence: {} },
  };
}

// Select using the production mode dispatcher and shared capacity contract.
function select(entries, maximum = 20, previousDailyCandidates = []) {
  return selectDailyModes(entries, { maximum, maximumPerCompany: 2, previousDailyCandidates, config: loadConfig() }, 'normal', { remaining: 3, otherKeys: [] });
}

// Collect only the three target mode allocations.
function allocated(result) {
  return ['startup', 'normal', 'remote'].flatMap((mode) => result.modes[mode].shortlist);
}

// Create an isolated state path for an allocation or acceptance regression.
function statePath(name) {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'daily-acceptance-')), name);
}

test('all-mode allocation has one 20 ceiling, retains all modes, and excludes prior same-day identities', () => {
  const entries = ['startup', 'normal', 'remote'].flatMap((mode) => Array.from({ length: 20 }, (_, i) => entry(mode, i)));
  const selected = select(entries);
  assert.deepEqual(['startup', 'normal', 'remote'].map((mode) => selected.modes[mode].shortlist.length), [5, 10, 5]);
  assert.equal(selected.selected.length, 10);
  const file = statePath('budget.json');
  const first = retainDailyShortlist(file, NOW, 'morning', allocated(selected));
  assert.equal(first.selectedToday, 20);
  assert.equal(first.cumulativeCandidates.length, 20);
  assert.equal(retainDailyShortlist(file, NOW, 'morning', allocated(selected)).selectedToday, 20);
  const budget = dailyShortlistBudget(file, NOW, 'midday');
  const later = select(entries.filter((item) => !budget.otherKeys.includes(candidateDedupKey(item.candidate))), budget.remaining, budget.previousCandidates);
  assert.equal(allocated(later).length, 0);
  assert.equal(dailyShortlistBudget(file, '2026-10-13T18:30:00Z', 'new-day').remaining, 20);
});

test('additional same-day runs enforce two per company per mode and share spare capacity', () => {
  const file = statePath('budget.json');
  const first = select(['startup', 'normal', 'remote'].map((mode) => entry(mode, 0, 'Shared Employer')));
  retainDailyShortlist(file, NOW, 'morning', allocated(first));
  const budget = dailyShortlistBudget(file, NOW, 'midday');
  const next = select(['startup', 'normal', 'remote'].flatMap((mode) => [entry(mode, 1, 'Shared Employer'), entry(mode, 2, 'Shared Employer')]), budget.remaining, budget.previousCandidates);
  assert.deepEqual(['startup', 'normal', 'remote'].map((mode) => next.modes[mode].shortlist.length), [1, 1, 1]);
  const retained = retainDailyShortlist(file, NOW, 'midday', allocated(next));
  assert.equal(retained.selectedToday, 6);
  assert.throws(() => retainDailyShortlist(file, NOW, 'third', [{ ...entry('remote', 3, 'Shared Employer').candidate, primaryMode: 'remote' }]), /company capacity/);
  assert.throws(() => retainDailyShortlist(file, NOW, 'morning', [{ ...allocated(first)[0], primaryMode: 'normal' }]), /conflicting daily shortlist retry/);
});

test('cross-mode observations allocate a unique role to Startup before Pune or Remote', () => {
  const startup = entry('startup', 0);
  const remote = entry('remote', 0);
  remote.candidate.canonicalUrl = startup.candidate.canonicalUrl;
  const selected = select([remote, startup, startup]);
  assert.equal(allocated(selected).length, 1);
  assert.equal(allocated(selected)[0].primaryMode, 'startup');
});

test('seven-day acceptance combines runs, deduplicates modes, and requires shared Strict plus each mode target', () => {
  const file = statePath('rollup.json');
  let result;
  for (let day = 7; day <= 13; day++) {
    const date = `2026-10-${day.toString().padStart(2, '0')}T06:00:00Z`;
    const roles = select(['startup', 'normal', 'remote'].flatMap((mode) => Array.from({ length: mode === 'normal' ? 10 : 5 }, (_, i) => entry(mode, i))));
    const missingStrict = day < 9;
    for (const mode of Object.values(roles.modes)) for (const role of mode.shortlist) role.selectionTier = missingStrict ? 'Fallback' : 'Strict';
    const split = (start, end) => Object.fromEntries(['normal', 'startup', 'remote'].map((mode) => [mode, { shortlist: roles.modes[mode].shortlist.slice(start, end) }]));
    retainDailyPhaseTargetRun(file, date, 'morning', split(0, 3), HISTORY);
    result = retainDailyPhaseTargetRun(file, date, 'midday', split(3), HISTORY);
    result = retainDailyPhaseTargetRun(file, date, 'midday', split(3), HISTORY);
  }
  assert.equal(result.phaseTargetMet, true);
  for (const mode of Object.values(result.modes)) assert.equal(mode.daysMet, 5);
  assert.equal(result.days[0].selectedToday, 20);
  assert.equal(result.days[5].modes.normal.countsMet, true);
  assert.equal(result.days[5].modes.normal.met, false);
});

test('legacy counts and missing history never become unique combined-job proof', () => {
  const file = statePath('rollup.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 'DailyPhaseTargetRollupV1', days: { '2026-10-13': { legacy: { modes: { normal: { roles: 10, employers: 10, strict: 2, met: true } } } } } }));
  const selected = select(Array.from({ length: 10 }, (_, i) => entry('normal', i)));
  const legacy = retainDailyPhaseTargetRun(file, NOW, 'new', selected.modes, HISTORY);
  assert.equal(legacy.days[0].identitiesVerified, false);
  assert.equal(legacy.days[0].modes.normal.met, false);
  const missingFile = statePath('missing.json');
  const missing = retainDailyPhaseTargetRun(missingFile, NOW, 'morning', selected.modes);
  assert.equal(missing.days[0].historyVerified, false);
  assert.equal(missing.days[0].modes.normal.met, false);
  const retry = retainDailyPhaseTargetRun(missingFile, NOW, 'morning', selected.modes, HISTORY);
  assert.equal(retry.days[0].historyVerified, false);
  assert.equal(Object.keys(JSON.parse(readFileSync(missingFile)).days).length, 1);
});

test('missing stale malformed or injected history cannot establish acceptance evidence', () => {
  const ledger = statePath('ledger.tsv');
  const snapshot = { status: 'loaded', generatedAt: NOW, rows: [] };
  assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, false);
  writeFileSync(ledger, `${OPPORTUNITY_COLUMNS.join('\t')}\n`);
  assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, true);
  for (const status of ['missing', 'stale', 'malformed']) assert.equal(dailyHistoryEvidence({ ...snapshot, status }, ledger).verified, false);
  assert.equal(dailyHistoryEvidence({ ...snapshot, generatedAt: null }, ledger).verified, false);
  assert.equal(dailyHistoryEvidence({ ...snapshot, rows: [{}] }, ledger).verified, false);
  assert.equal(dailyHistoryEvidence(snapshot, ledger, true).verified, false);
  writeFileSync(ledger, 'malformed');
  assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, false);
});

test('shared waterfall exhausts Strict inventory before any cross-mode Fallback reservation', () => {
  const strict = Array.from({ length: 20 }, (_, i) => entry('startup', i));
  const fallback = ['normal', 'remote'].flatMap((mode) => Array.from({ length: 10 }, (_, i) => {
    const row = entry(mode, i);
    row.eligibility.strict = false;
    row.eligibility.tier = 'fallback';
    return row;
  }));
  const selected = select([...strict, ...fallback]);
  assert.equal(allocated(selected).length, 20);
  assert.equal(allocated(selected).filter((role) => role.selectionTier === 'Strict').length, 20);
  assert.equal(selected.modes.normal.results.length, 10);
});

test('malformed ledger cooldown state and future snapshots cannot qualify a daily phase', () => {
  const ledger = statePath('ledger.tsv');
  const snapshot = { status: 'loaded', generatedAt: NOW, rows: [] };
  writeFileSync(ledger, '');
  assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, false);
  writeFileSync(ledger, `${OPPORTUNITY_COLUMNS.join('\t')}\nurl|https://jobs.example.test/1\tEmployer\tAI Engineer\thttps://jobs.example.test/1\tgreenhouse\t${NOW}\tbroken\t1\tnone\t\n`);
  assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, false);
  writeFileSync(ledger, `${OPPORTUNITY_COLUMNS.join('\t')}\n`);
  assert.equal(dailyHistoryEvidence({ ...snapshot, generatedAt: '2099-01-01T00:00:00Z' }, ledger).verified, false);
});

test('family diversity uses the actual mode reservation within a shared waterfall band', () => {
  const startup = Array.from({ length: 20 }, (_, i) => {
    const row = entry('startup', i);
    row.candidate.canonicalUrl = `https://jobs.example.test/startup/${String(i).padStart(2, '0')}`;
    row.candidate.roleFamily = i < 10 ? 'ai-llm-agentic' : ['ml', 'full-stack-ai', 'backend-python'][i % 3];
    row.eligibility.roleFamily = row.candidate.roleFamily;
    return row;
  });
  const others = ['normal', 'remote'].flatMap((mode) => Array.from({ length: mode === 'normal' ? 10 : 5 }, (_, i) => entry(mode, i)));
  const selected = select([...startup, ...others]);
  const families = selected.modes.startup.shortlist.map((role) => role.roleFamily);
  assert.equal(families.length, 5);
  assert.equal(new Set(families).size, 4);
  assert.equal(Math.max(...[...new Set(families)].map((family) => families.filter((value) => value === family).length)), 2);
});

test('truncated raw ledger rows never gain default none action evidence', () => {
  const ledger = statePath('ledger.tsv');
  const snapshot = { status: 'loaded', generatedAt: NOW, rows: [] };
  const prefix = `url|https://jobs.example.test/1\tEmployer\tAI Engineer\thttps://jobs.example.test/1\tgreenhouse\t${NOW}\t${NOW}\t1`;
  for (const row of [prefix, `${prefix}\t\t`]) {
    writeFileSync(ledger, `${OPPORTUNITY_COLUMNS.join('\t')}\n${row}\n`);
    assert.equal(dailyHistoryEvidence(snapshot, ledger).verified, false);
  }
});
