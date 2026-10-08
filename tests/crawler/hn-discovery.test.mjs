import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePlans } from '../../crawler/operator.mjs';
import { createOriginalListingResolver } from '../../crawler/original-listing-resolver.mjs';

test('monthly HN source keeps India and unrestricted global early-career leads without promoting them', async () => {
  const comments = [
    'Deccan | Junior Backend Engineer | Pune, India | Full-time. New grads welcome.',
    'Orbit | Software Engineer | REMOTE worldwide | Full-time. Required: 0-2 years of experience.',
    'Cloud | Junior AI Engineer | REMOTE anywhere | Full-time. Work from anywhere.',
    'West | Junior Backend Engineer | REMOTE worldwide | US only. New grads welcome.',
    'Auth | Junior AI Engineer | REMOTE global | Must be authorized to work in the United States.',
    'SeniorCo | Senior Software Engineer | India | Minimum 5 years of experience.',
    'Unknown | Software Engineer | REMOTE | Full-time.',
    'Reply | Junior Backend Engineer | India | Full-time.',
    'Restricted | Junior AI Engineer | REMOTE worldwide | Candidates must reside in Canada.',
    'Permit | Junior AI Engineer | REMOTE worldwide | US work permit required.',
    'Exclude | Junior AI Engineer | REMOTE worldwide | Available everywhere except India.',
  ].map((text, index) => ({ id: index + 100, type: 'comment', parent: index === 7 ? 100 : 42, time: 1791408600, text: `<p>${text}</p>` }));
  const calls = [];
  const plans = buildSourcePlans({
    config: { sources: { hn: { enabled: true, trialStartDate: '2026-10-08', perThreadCommentCap: 20 } } },
    runAt: '2026-10-08T08:00:00.000Z', schedule: 'morning', profile: { mode: 'normal' },
    transport: async (url) => {
      calls.push(url);
      if (url.includes('search_by_date')) return { status: 200, body: { hits: [
        { objectID: '41', title: 'Ask HN: Who wants to be hired? (October 2026)', author: 'whoishiring' },
        { objectID: '40', title: 'Ask HN: Who is hiring? (September 2026)', author: 'whoishiring' },
        { objectID: '42', title: 'Ask HN: Who is hiring? (October 2026)', author: 'whoishiring' },
      ] } };
      const comment = comments.find(({ id }) => url.endsWith(`/item/${id}.json`));
      if (comment) return { status: 200, body: comment };
      return { status: 200, body: { id: 42, type: 'story', title: 'Ask HN: Who is hiring? (October 2026)', by: 'whoishiring', kids: comments.map(({ id }) => id) } };
    },
  });
  const plan = plans.find(({ id }) => id === 'hn-discovery');
  assert.ok(plan, 'HN must be reachable from the morning source plan');
  // Fetch the real-shaped Firebase item responses through the same injected transport.
  const result = await plan.fetch();
  assert.deepEqual(result.observations.map(({ company }) => company), ['Deccan', 'Orbit', 'Cloud']);
  assert.ok(result.observations.every((row) => row.classification === 'lead' && row.originalApplicationUrl === null));
  assert.equal(result.verificationQueue.length, 3);
  assert.equal(result.manifest.threadId, 42);
  assert.equal(result.telemetry.filtered, 7);
  assert.ok(calls[0].includes('author_whoishiring'));
});

test('HN resolves a kept comment to employer evidence before it can count as a direct role', async () => {
  const runAt = '2026-10-08T08:00:00.000Z';
  const commentUrl = 'https://news.ycombinator.com/item?id=100';
  const atsUrl = 'https://jobs.ashbyhq.com/deccan/123';
  const transport = async (url) => {
    if (url.includes('search_by_date')) return { status: 200, body: { hits: [{ objectID: '42', title: 'Ask HN: Who is hiring? (October 2026)', author: 'whoishiring' }] } };
    if (url.endsWith('/item/42.json')) return { status: 200, body: { id: 42, by: 'whoishiring', title: 'Ask HN: Who is hiring? (October 2026)', type: 'story', kids: [100] } };
    if (url.endsWith('/item/100.json')) return { status: 200, body: { id: 100, parent: 42, type: 'comment', text: '<p>Deccan | Junior Backend Engineer | Pune, India | Full-time</p>' } };
    if (url === commentUrl) return { status: 200, body: `<a href="${atsUrl}">Apply for Junior Backend Engineer</a>` };
    assert.equal(url, atsUrl);
    return { status: 200, body: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Junior Backend Engineer', hiringOrganization: { name: 'Deccan' }, description: 'Full-time backend engineering. New grads welcome.', jobLocation: { address: { addressLocality: 'Pune' } }, employmentType: 'FULL_TIME', datePosted: '2026-10-07' })}</script>` };
  };
  const plan = buildSourcePlans({
    config: { sources: { hn: { enabled: true, trialStartDate: '2026-10-08' } } },
    runAt, transport, schedule: 'morning', profile: { mode: 'normal' },
    resolver: createOriginalListingResolver({ transport, runAt }),
  }).find(({ id }) => id === 'hn-discovery');
  const result = await plan.fetch();
  assert.equal(result.observations[0].originalApplicationUrl, atsUrl);
  assert.equal(result.observations[0].classification, 'direct');
  assert.equal(result.verificationQueue.length, 0);
  assert.equal(result.telemetry.resolved, 1);
});

test('HN reports its bounded comment sample so a completed sample remains usable yield evidence', async () => {
  const result = await buildSourcePlans({
    config: { sources: { hn: { enabled: true, trialStartDate: '2026-10-08', perThreadCommentCap: 1 } } },
    runAt: '2026-10-08T08:00:00.000Z', schedule: 'morning', profile: { mode: 'normal' },
    transport: async (url) => {
      if (url.includes('search_by_date')) return { status: 200, body: { hits: [{ objectID: '42', title: 'Ask HN: Who is hiring? (October 2026)', author: 'whoishiring' }] } };
      if (url.endsWith('/item/42.json')) return { status: 200, body: { id: 42, type: 'story', by: 'whoishiring', title: 'Ask HN: Who is hiring? (October 2026)', kids: [100, 101] } };
      assert.ok(url.endsWith('/item/100.json'));
      return { status: 200, body: { id: 100, type: 'comment', parent: 42, text: 'Deccan | Junior Backend Engineer | Pune, India | Full-time' } };
    },
  }).find(({ id }) => id === 'hn-discovery').fetch();
  assert.equal(result.manifest.sampled, true);
  assert.equal(result.manifest.recordsNotExamined, 1);
  assert.equal(result.manifest.naturalTerminal, true);
  assert.equal(result.telemetry.requests, 3);
});
