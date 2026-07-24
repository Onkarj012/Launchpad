import { annotateFreshness } from './freshness.mjs';
import { loadConfig, loadConversionPlan } from './config.mjs';
import { classifyCandidate } from './eligibility.mjs';
import { scoreConversion } from './conversion-score.mjs';
import { applicationReadiness } from './normal-readiness.mjs';
import { candidateDedupKey, canonicalizeUrl, normalizeCandidate } from './candidate.mjs';
import { classifyLinkedInRescuePost } from './linkedin-rescue-classifier.mjs';
import { deduplicateLinkedInRescueOutputs } from './linkedin-rescue-dedup.mjs';
import { buildAssociatedPersonHandoff } from './linkedin-rescue-handoff.mjs';
import { parseCapturedLinkedInPost, LinkedInRescueParseError } from './linkedin-rescue-parser.mjs';
import { buildLinkedInRescueQueryPlan, validateLinkedInRescuePlan, LinkedInRescueBoundsError } from './linkedin-rescue-query.mjs';
import { filterHistoricalCandidates } from '../crawler/historical-suppression.mjs';

export const LINKEDIN_RESCUE_MODE_SCHEMA_VERSION = 'LaunchpadV5LinkedInRescueV1';

export class LinkedInRescueInvocationError extends Error {
  constructor(message = 'LinkedIn rescue requires explicit /linkedin-leads invocation') {
    super(message);
    this.name = 'LinkedInRescueInvocationError';
    this.code = 'EXPLICIT_INVOCATION_REQUIRED';
  }
}

function report(post, code, detail = null) {
  const category = code.startsWith('INVALID') ? 'invalid'
    : code.startsWith('STALE') || code.startsWith('FRESHNESS') ? 'stale'
      : code.startsWith('UNRESOLVED') ? 'unresolved'
        : code.startsWith('INELIGIBLE') ? 'ineligible'
          : code.startsWith('DUPLICATE') ? 'duplicate'
            : code.startsWith('SCORING') || code.startsWith('LIVENESS') || code.startsWith('QUERY') ? 'ambiguous-or-unverified'
              : 'reported';
  return {
    code,
    category,
    evidence: {
      postUrl: post?.postUrl ?? null,
      authorName: post?.authorName ?? null,
      authorProfileUrl: post?.authorProfileUrl ?? null,
      authorRelationship: post?.authorRelationship ?? null,
      timestampEvidence: post?.timestampEvidence ?? null,
      postedAt: post?.postedAt ?? null,
      observedAt: post?.observedAt ?? null,
      rawHiringContext: post?.rawHiringContext ?? null,
      jobLink: post?.jobLink ?? null,
      formLink: post?.formLink ?? null,
      contactInvitationEvidence: post?.contactInvitationEvidence ?? null,
      ...(detail ? { detail } : {}),
    },
  };
}

function scoreInput(post) {
  const scoring = post.scoring && typeof post.scoring === 'object' ? post.scoring : {};
  const value = Number(scoring.matchScore ?? scoring.score);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function applicationRaw(post, runAt) {
  const resolution = post.originalApplicationResolution && typeof post.originalApplicationResolution === 'object'
    ? post.originalApplicationResolution
    : null;
  const resolutionAccepted = Boolean(resolution?.url)
    && resolution.status !== 'Unresolved'
    && typeof resolution.evidence === 'string'
    && resolution.evidence.length > 0;
  const score = scoreInput(post);
  return {
    url: post.postUrl,
    source: 'linkedin-rescue',
    provider: 'linkedin',
    sourceKind: 'aggregator',
    sourceCategory: 'aggregator',
    company: post.company,
    title: post.title,
    location: post.location,
    description: post.rawHiringContext,
    postedAt: post.postedAt,
    discoveredAt: post.observedAt || runAt,
    crawledAt: post.observedAt || runAt,
    employment: post.employment ?? null,
    experience: post.experience ?? null,
    liveness: post.liveness ?? null,
    // A post link is discovery evidence. Resolution is only authoritative when
    // a captured original URL and evidence are supplied separately.
    applicationUrl: resolutionAccepted ? resolution.url : post.jobLink ?? null,
    originalApplicationEvidence: resolutionAccepted ? resolution.evidence : null,
    evidence: {
      linkedinRescue: {
        postUrl: post.postUrl,
        jobLink: post.jobLink,
        formLink: post.formLink,
        timestampEvidence: post.timestampEvidence,
        observedAt: post.observedAt,
        rawHiringContext: post.rawHiringContext,
      },
      originalApplication: resolutionAccepted ? resolution.evidence : null,
      originalApplicationLiveness: post.liveness ?? null,
      ...(post.evidence && typeof post.evidence === 'object' ? post.evidence : {}),
    },
    matchScore: score,
    rationale: post.scoring?.rationale ?? null,
    hook: post.scoring?.hook ?? null,
    responseLikelihood: post.scoring?.responseLikelihood ?? null,
    conversionSignals: {
      humanContact: Boolean(post.contactInvitation),
      projectConnection: post.scoring?.projectConnection === true,
    },
  };
}

function leadFromPost(post, classification, { runAt, config, conversionPlan }) {
  if (!classification.actionable) return { lead: null, person: null, reports: [] };
  const leadReports = [];
  const raw = applicationRaw(post, runAt);
  let candidate;
  try {
    candidate = normalizeCandidate(raw, { runAt });
  } catch (error) {
    return {
      lead: null,
      person: null,
      reports: [report(post, 'INVALID_APPLICATION_EVIDENCE', { errors: error.errors ?? [error.message] })],
    };
  }
  const eligibility = classifyCandidate(candidate, { ...config, salaryFloorLpa: conversionPlan.salaryFloorLpa });
  const freshness = annotateFreshness(candidate, {
    now: runAt,
    hotMaximumHours: config.freshness.hotMaximumHours,
    activeMaximumDays: config.freshness.activeMaximumDays,
    backfillMaximumDays: config.freshness.backfillMaximumDays,
  }).freshness;
  const conversion = scoreConversion(candidate, {
    freshnessWindow: freshness.window,
    eligibility,
    policy: conversionPlan.conversionScore,
  });
  const sharedReadiness = applicationReadiness(candidate, eligibility);
  const scoreValue = scoreInput(post);
  const scoreReady = scoreValue != null && conversion.tier !== 'skip';
  const withinRescueCutoff = Number.isFinite(classification.ageHours) && classification.ageHours <= (config.linkedinRescueCutoffHours ?? 168);
  const ready = Boolean(sharedReadiness.ready && freshness.eligible && withinRescueCutoff && scoreReady);
  if (!eligibility.eligible) leadReports.push(report(post, 'INELIGIBLE_ROLE', { reasons: eligibility.reasons, evidenceCodes: eligibility.evidenceCodes }));
  if (classification.codes.includes('STALE_POST')) leadReports.push(report(post, 'STALE_POST', { ageHours: classification.ageHours }));
  if (!freshness.eligible) leadReports.push(report(post, 'FRESHNESS_UNVERIFIED_OR_REJECTED', { code: freshness.code, evidence: freshness.evidence }));
  if (!sharedReadiness.evidence.resolution.ready) leadReports.push(report(post, 'UNRESOLVED_ORIGINAL_APPLICATION', { reasons: sharedReadiness.evidence.resolution.reasons }));
  if (!sharedReadiness.evidence.liveness.pass) leadReports.push(report(post, 'LIVENESS_UNVERIFIED', { status: sharedReadiness.evidence.liveness.status, evidence: sharedReadiness.evidence.liveness.evidence }));
  if (scoreValue == null) leadReports.push(report(post, 'SCORING_UNVERIFIED', { message: 'lead requires the normal scoring pipeline before Ready' }));
  else if (conversion.tier === 'skip') leadReports.push(report(post, 'SCORE_BELOW_MANUAL_INSPECT', { conversionScore: conversion.score, tier: conversion.tier }));
  const lead = {
    leadType: 'application',
    status: ready ? 'Ready' : 'Needs Verification',
    ready,
    company: post.company,
    title: post.title,
    location: post.location,
    postUrl: post.postUrl,
    applicationUrl: post.jobLink,
    formUrl: post.formLink,
    originalApplicationUrl: sharedReadiness.evidence.resolution.ready ? candidate.originalApplicationUrl : null,
    originalApplicationEvidence: candidate.applicationResolution?.evidence ?? null,
    applicationResolution: sharedReadiness.evidence.resolution,
    liveness: sharedReadiness.evidence.liveness,
    freshness,
    eligibility,
    score: { matchScore: candidate.matchScore, conversionScore: conversion.score, tier: conversion.tier, factors: conversion.factors, status: scoreValue == null ? 'Needs Normal Scoring' : 'Scored' },
    readiness: { ...sharedReadiness, ready, status: ready ? 'Ready' : 'Needs Verification' },
    dedupKey: candidateDedupKey(candidate),
    source: 'linkedin-rescue',
    postEvidence: post,
    provenance: { postUrls: [post.postUrl], queries: post.query ? [post.query] : [], observedAt: post.observedAt },
  };
  return { lead, person: buildAssociatedPersonHandoff({ post, applicationLead: lead }), reports: leadReports };
}

function validateCaptureBounds(captures, plan) {
  if (!Array.isArray(captures)) throw new LinkedInRescueBoundsError('capturedPosts must be an array', 'LINKEDIN_RESCUE_INPUT_INVALID');
  if (captures.length > plan.maxTotalPosts) throw new LinkedInRescueBoundsError(`capturedPosts exceeds maxTotalPosts=${plan.maxTotalPosts}`, 'LINKEDIN_RESCUE_TOTAL_POST_LIMIT');
  const perQuery = new Map();
  for (const capture of captures) {
    const query = capture?.query;
    if (query == null) continue;
    if (!plan.queries.includes(query)) throw new LinkedInRescueBoundsError(`capture query is not in the plan: ${query}`, 'LINKEDIN_RESCUE_QUERY_NOT_ALLOWLISTED');
    const count = (perQuery.get(query) ?? 0) + 1;
    perQuery.set(query, count);
    if (count > plan.maxPostsPerQuery) throw new LinkedInRescueBoundsError(`query exceeds maxPostsPerQuery=${plan.maxPostsPerQuery}: ${query}`, 'LINKEDIN_RESCUE_QUERY_POST_LIMIT');
  }
}

/**
 * Process only captured post records from an explicit manual invocation. It
 * intentionally has no fetch, browser, Notion, application, or send callback.
 */
export function runLinkedInRescue({
  explicitInvocation = false,
  invokedBy = null,
  now = new Date().toISOString(),
  runId = `linkedin-rescue-${now}`,
  queryPlan = null,
  capturedPosts = [],
  config = null,
  conversionPlan = null,
  historicalV4Rows = [],
} = {}) {
  if (explicitInvocation !== true && invokedBy !== 'linkedin-leads') throw new LinkedInRescueInvocationError();
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) throw new LinkedInRescueBoundsError('now must be an ISO timestamp', 'LINKEDIN_RESCUE_TIMESTAMP_INVALID');
  const plan = validateLinkedInRescuePlan(queryPlan ? { ...queryPlan, observedAt: queryPlan.observedAt ?? now } : buildLinkedInRescueQueryPlan({ observedAt: now }));
  validateCaptureBounds(capturedPosts, plan);
  const policy = config || loadConfig();
  const scoringPolicy = conversionPlan || loadConversionPlan();
  const reports = [];
  const parsedPosts = [];
  const seenPosts = new Set();
  for (const captured of capturedPosts) {
    let post;
    try {
      post = parseCapturedLinkedInPost(captured, { observedAt: plan.observedAt });
    } catch (error) {
      reports.push({ code: 'INVALID_POST', category: 'invalid', evidence: error.evidence ?? captured, detail: error.errors ?? [error.message] });
      continue;
    }
    if (!post.query) reports.push(report(post, 'QUERY_UNVERIFIED'));
    const postKey = canonicalizeUrl(post.postUrl);
    if (seenPosts.has(postKey)) reports.push(report(post, 'DUPLICATE_POST', { duplicateKey: `post:${postKey}` }));
    seenPosts.add(postKey);
    parsedPosts.push(post);
  }
  const applicationLeads = [];
  const associatedPeople = [];
  for (const post of parsedPosts) {
    const classification = classifyLinkedInRescuePost(post, { now, cutoffHours: plan.cutoffHours });
    reports.push(...classification.reports);
    const output = leadFromPost(post, classification, { runAt: now, config: { ...policy, linkedinRescueCutoffHours: plan.cutoffHours }, conversionPlan: scoringPolicy });
    if (output.lead) applicationLeads.push(output.lead);
    if (output.person) associatedPeople.push(output.person);
    reports.push(...output.reports);
  }
  const deduped = deduplicateLinkedInRescueOutputs({ applicationLeads, associatedPeople });
  reports.push(...deduped.duplicateReports);
  // v4 identity matches are suppressed before they reach the shortlist/Notion planning
  // handoff. Read-only against v4 rows: never migrates, mutates, or deletes historical data.
  const { kept: nonHistoricalLeads, suppressed: historicalSuppressions } = filterHistoricalCandidates(deduped.applicationLeads, historicalV4Rows);
  for (const suppression of historicalSuppressions) {
    reports.push({
      code: 'SUPPRESSED_HISTORICAL',
      category: 'duplicate',
      evidence: { company: suppression.company, title: suppression.title, jobLink: suppression.canonicalUrl, historicalIdentity: suppression.historicalIdentity, historicalRowIndex: suppression.historicalRowIndex, matchTypes: suppression.matchTypes },
    });
  }
  return {
    schemaVersion: LINKEDIN_RESCUE_MODE_SCHEMA_VERSION,
    runId,
    runAt: now,
    invoked: true,
    invocation: { explicit: true, command: 'linkedin-leads', autoRun: false },
    queryPlan: plan,
    applicationLeads: nonHistoricalLeads,
    associatedPeople: deduped.associatedPeople,
    reports,
    historicalSuppressions,
    counts: {
      captured: capturedPosts.length,
      parsed: parsedPosts.length,
      applicationLeads: nonHistoricalLeads.length,
      ready: nonHistoricalLeads.filter((lead) => lead.ready).length,
      needsVerification: nonHistoricalLeads.filter((lead) => !lead.ready).length,
      associatedPeople: deduped.associatedPeople.length,
      historicalSuppressed: historicalSuppressions.length,
      reports: reports.length,
    },
    sideEffects: {
      browserAutomation: false,
      network: false,
      loginAutomation: false,
      applicationSubmission: false,
      formSubmission: false,
      connect: false,
      follow: false,
      react: false,
      comment: false,
      message: false,
      dm: false,
      notionMutation: false,
      outreachSend: false,
    },
  };
}
