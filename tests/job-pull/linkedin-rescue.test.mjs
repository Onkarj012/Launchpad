import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLinkedInRescue, LinkedInRescueInvocationError } from '../../job-pull/linkedin-rescue-mode.mjs';
import { buildLinkedInRescueQueryPlan, LINKEDIN_RESCUE_QUERY_ALLOWLIST, LinkedInRescueBoundsError } from '../../job-pull/linkedin-rescue-query.mjs';
import { parseCapturedLinkedInPost } from '../../job-pull/linkedin-rescue-parser.mjs';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/linkedin-rescue');
const NOW = '2026-07-23T06:30:00.000Z';
const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

function run(capturedPosts, options = {}) {
  return runLinkedInRescue({ explicitInvocation: true, now: NOW, capturedPosts, ...options });
}

test('happy path emits both a Ready application lead and associated-person evidence', () => {
  const result = run([read('dual-output.json')]);
  assert.equal(result.applicationLeads.length, 1);
  assert.equal(result.applicationLeads[0].status, 'Ready');
  assert.equal(result.applicationLeads[0].ready, true);
  assert.equal(result.applicationLeads[0].originalApplicationUrl, 'https://jobs.acme.example/roles/ai-engineer');
  assert.equal(result.applicationLeads[0].postEvidence.rawHiringContext, read('dual-output.json').rawHiringContext);
  assert.equal(result.associatedPeople.length, 1);
  assert.equal(result.associatedPeople[0].personName, 'Jane Rao');
  assert.equal(result.associatedPeople[0].channel, 'linkedin-dm');
  assert.equal(result.associatedPeople[0].contactEvidence, 'DM me for a referral');
  assert.equal(result.reports.length, 0);
});

test('post-only hiring lead remains visible and cannot become an original active application', () => {
  const result = run([read('post-only.json')]);
  assert.equal(result.applicationLeads.length, 1);
  assert.equal(result.applicationLeads[0].status, 'Needs Verification');
  assert.equal(result.applicationLeads[0].ready, false);
  assert.equal(result.applicationLeads[0].originalApplicationUrl, null);
  assert.ok(result.reports.some((item) => item.code === 'UNRESOLVED_POST_ONLY_LEAD'));
  assert.ok(result.reports.some((item) => item.code === 'UNRESOLVED_ORIGINAL_APPLICATION'));
});

test('original application resolution, active liveness, freshness, eligibility, scoring, and shared readiness are all required', () => {
  const post = read('dual-output.json');
  const unresolved = run([{ ...post, originalApplicationResolution: undefined }]);
  assert.equal(unresolved.applicationLeads[0].ready, false);
  assert.ok(unresolved.reports.some((item) => item.code === 'UNRESOLVED_ORIGINAL_APPLICATION'));

  const noLiveness = run([{ ...post, liveness: { status: 'Not Verified', evidence: 'not checked' } }]);
  assert.equal(noLiveness.applicationLeads[0].ready, false);
  assert.ok(noLiveness.reports.some((item) => item.code === 'LIVENESS_UNVERIFIED'));

  const noScore = run([{ ...post, scoring: undefined }]);
  assert.equal(noScore.applicationLeads[0].ready, false);
  assert.equal(noScore.applicationLeads[0].score.status, 'Needs Normal Scoring');
  assert.ok(noScore.reports.some((item) => item.code === 'SCORING_UNVERIFIED'));
});

test('every rejection/report class is explicit and preserves post evidence', () => {
  const result = run([
    read('promotional.json'),
    read('job-seeker.json'),
    read('stale.json'),
    read('ineligible.json'),
    read('ambiguous.json'),
    read('invalid.json'),
  ]);
  const codes = new Set(result.reports.map((item) => item.code));
  for (const expected of ['PROMOTIONAL_POST', 'JOB_SEEKER_POST', 'STALE_POST', 'INELIGIBLE_ROLE', 'AMBIGUOUS_UNVERIFIED_ROLE', 'INVALID_POST']) {
    assert.equal(codes.has(expected), true, expected);
  }
  const report = result.reports.find((item) => item.code === 'STALE_POST');
  assert.equal(report.evidence.postUrl, 'https://www.linkedin.com/posts/old-hiring-654');
  assert.equal(report.evidence.timestampEvidence, '10d');
  assert.equal(report.evidence.observedAt, NOW);
  assert.equal(result.applicationLeads.some((lead) => lead.status === 'Ready'), false);
});

test('v4 historical identity match is suppressed before the shortlist/Notion-planning handoff', () => {
  const post = read('dual-output.json');
  const historicalV4Rows = [{ company: 'Acme AI', title: 'AI Engineer', location: 'Pune, India (Hybrid)', state: 'applied' }];

  const baseline = run([post]);
  assert.equal(baseline.applicationLeads.length, 1);
  assert.equal(baseline.historicalSuppressions.length, 0);

  const suppressed = run([post], { historicalV4Rows });
  assert.equal(suppressed.applicationLeads.length, 0);
  assert.equal(suppressed.historicalSuppressions.length, 1);
  assert.equal(suppressed.historicalSuppressions[0].company, 'Acme AI');
  assert.equal(suppressed.counts.applicationLeads, 0);
  assert.equal(suppressed.counts.historicalSuppressed, 1);
  assert.ok(suppressed.reports.some((item) => item.code === 'SUPPRESSED_HISTORICAL'));
});

test('bounds fail closed for query allowlist, per-query posts, total posts, and stale-window input', () => {
  assert.throws(() => buildLinkedInRescueQueryPlan({ queries: ['free-form hiring query'], observedAt: NOW }), LinkedInRescueBoundsError);
  assert.throws(() => buildLinkedInRescueQueryPlan({ queries: [...LINKEDIN_RESCUE_QUERY_ALLOWLIST, 'hiring "AI/LLM Engineer"'], observedAt: NOW }), /query count|unique/);
  assert.throws(() => buildLinkedInRescueQueryPlan({ queries: [LINKEDIN_RESCUE_QUERY_ALLOWLIST[0]], maxPostsPerQuery: 26, observedAt: NOW }), /maxPostsPerQuery/);
  assert.throws(() => buildLinkedInRescueQueryPlan({ queries: [LINKEDIN_RESCUE_QUERY_ALLOWLIST[0]], maxTotalPosts: 101, observedAt: NOW }), /maxTotalPosts/);
  assert.throws(() => buildLinkedInRescueQueryPlan({ queries: [LINKEDIN_RESCUE_QUERY_ALLOWLIST[0]], cutoffHours: 23, observedAt: NOW }), /cutoffHours/);
  const capture = read('post-only.json');
  assert.throws(() => run([capture, { ...capture, postUrl: `${capture.postUrl}-2` }], { queryPlan: { queries: [capture.query], maxPostsPerQuery: 1, maxTotalPosts: 2, observedAt: NOW } }), /maxPostsPerQuery/);
});

test('explicit invocation and read-only/no-auto-run contract are enforced', () => {
  assert.throws(() => runLinkedInRescue({ now: NOW, capturedPosts: [] }), LinkedInRescueInvocationError);
  const result = run([read('dual-output.json')]);
  assert.equal(result.invocation.command, 'linkedin-leads');
  assert.equal(result.invocation.autoRun, false);
  assert.deepEqual(Object.values(result.sideEffects).every((value) => value === false), true);
  assert.equal(result.associatedPeople[0].sent, false);
  assert.equal(result.associatedPeople[0].sendAllowed, false);
});

test('duplicate post/application/person records are deterministic and merge provenance', () => {
  const captures = read('duplicate-posts.json');
  const result = run(captures);
  assert.equal(result.applicationLeads.length, 1);
  assert.equal(result.associatedPeople.length, 1);
  assert.equal(result.applicationLeads[0].provenance.postUrls.length, 2);
  assert.ok(result.reports.some((item) => item.code === 'DUPLICATE_POST'));
  assert.ok(result.reports.some((item) => item.code === 'DUPLICATE_APPLICATION'));
  assert.ok(result.reports.some((item) => item.code === 'DUPLICATE_PERSON_CHANNEL'));
  assert.equal(result.applicationLeads[0].postEvidence.postUrl, captures[0].postUrl);
});

test('parser preserves exact evidence and does not invent missing values', () => {
  const capture = read('dual-output.json');
  const post = parseCapturedLinkedInPost(capture);
  assert.equal(post.postUrl, capture.postUrl);
  assert.equal(post.authorName, capture.author.name);
  assert.equal(post.authorProfileUrl, capture.author.profileUrl);
  assert.equal(post.authorRelationship, capture.author.relationship);
  assert.equal(post.timestampEvidence, capture.timestampEvidence);
  assert.equal(post.observedAt, capture.observedAt);
  assert.equal(post.rawHiringContext, capture.rawHiringContext);
  assert.deepEqual(post.contactInvitation, capture.contactInvitation);
  assert.equal(post.jobLink, capture.jobLink);
  assert.equal(post.formLink, capture.formLink);
  const missing = parseCapturedLinkedInPost({ postUrl: 'https://www.linkedin.com/posts/missing', rawHiringContext: 'We are hiring', observedAt: NOW });
  assert.equal(missing.company, null);
  assert.equal(missing.authorName, null);
  assert.equal(missing.jobLink, null);
});
