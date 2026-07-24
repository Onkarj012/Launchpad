import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardPromotionProposals } from '../../crawler/board-promotion.mjs';

const discovery = (overrides = {}) => ({
  provider: 'greenhouse',
  company: 'Acme India',
  url: 'https://boards.greenhouse.io/acmeindia',
  discoveredAt: '2026-07-20T00:00:00Z',
  ...overrides,
});

test('a host seen once produces no proposal', () => {
  const result = buildBoardPromotionProposals([discovery()], {}, { runAt: '2026-07-20T00:00:00Z' });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.manifest.tracked, 1);
  assert.equal(result.state['greenhouse:boards.greenhouse.io'].occurrences, 1);
});

test('repeated discoveries across distinct dates clear the threshold and propose a board', () => {
  let state = {};
  ({ state } = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-20T00:00:00Z' })], state, { runAt: '2026-07-20T00:00:00Z' }));
  ({ state } = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-21T00:00:00Z' })], state, { runAt: '2026-07-21T00:00:00Z' }));
  const third = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-22T00:00:00Z' })], state, { runAt: '2026-07-22T00:00:00Z' });

  assert.equal(third.proposals.length, 1);
  const proposal = third.proposals[0];
  assert.equal(proposal.key, 'greenhouse:boards.greenhouse.io');
  assert.equal(proposal.occurrences, 3);
  assert.equal(proposal.distinctDates, 3);
  assert.equal(proposal.noAutoApply, true);
  assert.deepEqual(proposal.suggestedBoard, {
    provider: 'greenhouse', company: 'Acme India', url: 'https://boards.greenhouse.io/acmeindia', enabled: false, probeStatus: 'proposed',
  });
});

test('repeated same-day discoveries never propose without a second distinct date', () => {
  const result = buildBoardPromotionProposals([
    discovery({ discoveredAt: '2026-07-20T01:00:00Z' }),
    discovery({ discoveredAt: '2026-07-20T09:00:00Z' }),
    discovery({ discoveredAt: '2026-07-20T18:00:00Z' }),
  ], {}, { runAt: '2026-07-20T18:00:00Z' });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.state['greenhouse:boards.greenhouse.io'].occurrences, 3);
  assert.equal(result.state['greenhouse:boards.greenhouse.io'].dates.length, 1);
});

test('a proposed host is not re-proposed on a later run, and unrelated hosts are tracked independently', () => {
  let state = {};
  ({ state } = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-01T00:00:00Z' })], state));
  ({ state } = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-02T00:00:00Z' })], state));
  ({ state } = buildBoardPromotionProposals([discovery({ discoveredAt: '2026-07-03T00:00:00Z' })], state));
  const again = buildBoardPromotionProposals([
    discovery({ discoveredAt: '2026-07-04T00:00:00Z' }),
    discovery({ provider: 'lever', company: 'Other Co', url: 'https://jobs.lever.co/other', discoveredAt: '2026-07-04T00:00:00Z' }),
  ], state);

  assert.equal(again.proposals.length, 0);
  assert.equal(again.manifest.tracked, 2);
  assert.equal(again.state['lever:jobs.lever.co'].occurrences, 1);
});

test('malformed discoveries without a resolvable URL are skipped rather than throwing', () => {
  const result = buildBoardPromotionProposals([discovery({ url: null, canonicalUrl: undefined }), discovery()], {});
  assert.equal(result.manifest.tracked, 1);
});
