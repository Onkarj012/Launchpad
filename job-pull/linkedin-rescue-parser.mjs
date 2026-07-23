import { canonicalizeUrl } from './candidate.mjs';

export class LinkedInRescueParseError extends Error {
  constructor(errors, evidence = null) {
    super(`Invalid captured LinkedIn post: ${errors.join('; ')}`);
    this.name = 'LinkedInRescueParseError';
    this.code = 'INVALID_POST';
    this.errors = errors;
    this.evidence = evidence;
  }
}

function first(...values) { return values.find((value) => value !== undefined && value !== null); }
function exactString(value) { return typeof value === 'string' && value.length ? value : null; }
function clone(value) {
  if (value == null) return null;
  try { return structuredClone(value); } catch { return value; }
}

function linkRows(input) {
  if (!Array.isArray(input)) return [];
  return input.map((link) => {
    if (typeof link === 'string') return { url: link, kind: null, text: null };
    return { url: exactString(link?.url), kind: exactString(link?.kind), text: exactString(link?.text) };
  }).filter((link) => link.url);
}

function firstLink(links, kinds) {
  return links.find((link) => link.kind && kinds.has(link.kind.toLowerCase()))?.url ?? null;
}

function iso(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null; }

/** Parse a captured, already-visible post. This function has no browser/network primitive. */
export function parseCapturedLinkedInPost(captured, { observedAt = null, query = null } = {}) {
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new LinkedInRescueParseError(['post capture must be an object'], captured);
  }
  const postUrl = first(captured.postUrl, captured.url);
  const rawHiringContext = first(captured.rawHiringContext, captured.rawPostText, captured.rawText, captured.snippet);
  const author = captured.author && typeof captured.author === 'object' ? captured.author : {};
  const links = linkRows(captured.links);
  const jobLink = first(captured.jobLink, captured.applicationLink, firstLink(links, new Set(['job', 'application', 'apply', 'job-link'])));
  const formLink = first(captured.formLink, firstLink(links, new Set(['form', 'application-form', 'google-form', 'typeform'])));
  const timestampEvidence = first(captured.timestampEvidence, captured.postedAtEvidence, captured.postedTimeEvidence);
  const postedAt = first(captured.postedAt, captured.publishedAt) ?? null;
  const actualObservedAt = first(captured.observedAt, observedAt);
  const errors = [];
  if (typeof postUrl !== 'string' || !/^https?:\/\//i.test(postUrl)) errors.push('postUrl must be an http(s) URL');
  if (typeof rawHiringContext !== 'string' || !rawHiringContext.length) errors.push('rawHiringContext is required');
  if (!iso(actualObservedAt)) errors.push('observedAt must be an ISO timestamp');
  if (postedAt != null && !iso(postedAt)) errors.push('postedAt must be an ISO timestamp when supplied');
  if (timestampEvidence != null && typeof timestampEvidence !== 'string') errors.push('timestampEvidence must be exact text');
  if (errors.length) throw new LinkedInRescueParseError(errors, { postUrl, rawHiringContext, timestampEvidence });
  return {
    schemaVersion: 'LinkedInRescueCapturedPostV1',
    query: first(captured.query, query),
    postUrl,
    canonicalPostUrl: canonicalizeUrl(postUrl),
    authorName: first(captured.authorName, author.name) ?? null,
    authorProfileUrl: first(captured.authorProfileUrl, author.profileUrl, author.url) ?? null,
    authorRelationship: first(captured.authorRelationship, author.relationship, author.role) ?? null,
    timestampEvidence: timestampEvidence ?? null,
    postedAt,
    observedAt: actualObservedAt,
    rawHiringContext,
    rawSnippet: first(captured.rawSnippet, captured.snippet) ?? null,
    links: clone(links),
    jobLink: jobLink ?? null,
    formLink: formLink ?? null,
    contactInvitation: clone(first(captured.contactInvitation, captured.contact, null)),
    contactInvitationEvidence: clone(first(captured.contactInvitationEvidence, captured.contactInvitation, captured.contact, null)),
    company: first(captured.company, captured.companyName) ?? null,
    title: first(captured.title, captured.role) ?? null,
    location: captured.location ?? null,
    employment: clone(captured.employment ?? null),
    experience: clone(captured.experience ?? null),
    originalApplicationResolution: clone(captured.originalApplicationResolution ?? captured.resolution ?? null),
    liveness: clone(captured.liveness ?? null),
    scoring: clone(captured.scoring ?? null),
    evidence: clone(captured.evidence ?? null),
  };
}

export function parseLinkedInRescueFixtures(captures, options = {}) {
  if (!Array.isArray(captures)) throw new LinkedInRescueParseError(['captures must be an array']);
  return captures.map((capture) => parseCapturedLinkedInPost(capture, options));
}
