import { normalizeCandidate, stripHtmlToText } from '../job-pull/candidate.mjs';
import { loadConfig } from '../job-pull/config.mjs';
import { classifyExperience, classifyGeo, classifyTitle } from '../job-pull/eligibility.mjs';
import { classifyRemoteEligibility } from '../job-pull/remote-enrichment.mjs';
import { requestWithDeadline, throwIfNetworkWorkDisallowed } from './deadline.mjs';
import { applyOriginalListingResolution } from './original-listing-resolver.mjs';

// Read public HN JSON through the caller's bounded transport.
async function readJson(transport, url, options, telemetry) {
  throwIfNetworkWorkDisallowed(options.signal, options.deadline);
  telemetry.requests += 1;
  const response = await requestWithDeadline(transport, url, options, options);
  if (Number(response?.status ?? 200) !== 200) throw new Error(`hn-http-${response?.status}`);
  return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
}

// Convert an employer's top-level hiring comment into a source lead.
function leadFrom(comment, threadId, runAt, policy) {
  if (comment?.type !== 'comment' || comment.parent !== threadId || comment.deleted || comment.dead || !comment.text) return null;
  const description = stripHtmlToText(comment.text);
  const header = stripHtmlToText(comment.text.replace(/^\s*<p[^>]*>/i, '').split(/<p\b|<br\b|\n/i)[0]);
  const fields = header.split('|').map((part) => part.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const title = fields.slice(1).find((part) => classifyTitle({ title: part }).pass)
    || description.match(/\b(?:(?:junior|associate|graduate|senior|staff|lead|principal)\s+)?(?:software|backend|full[ -]?stack|AI|ML|machine learning)\s+(?:engineer|developer)\b/i)?.[0];
  if (!title) return null;
  const candidate = normalizeCandidate({
    url: `https://news.ycombinator.com/item?id=${comment.id}`,
    jobId: comment.id, company: fields[0], title,
    location: fields.slice(1).filter((part) => part !== title).join(' | '),
    workMode: /\bremote\b/i.test(header) ? 'remote' : null,
    description,
    postedAt: Number.isFinite(comment.time) ? new Date(comment.time * 1000).toISOString() : null,
    discoveredAt: runAt, crawledAt: runAt,
    provider: 'hn-discovery', sourceKind: 'aggregator',
    source: `https://news.ycombinator.com/item?id=${threadId}`,
    evidence: { threadId, commentId: comment.id, classification: 'lead', verified: false },
  }, { runAt });
  const geo = classifyGeo(candidate, policy);
  const experience = classifyExperience(candidate, policy);
  if (candidate.workMode === 'remote' && classifyRemoteEligibility(candidate).status === 'Not Eligible') return null;
  // A global claim cannot override a stated country or authorization restriction.
  const restriction = description.match(/\b(?:only\s+(?:in|within)|(?:limited|restricted)\s+to|(?:must|need to)\s+(?:reside|live|be based|be located)\s+in|(?:work authorization|authorized to work)\s+in)\s+(?:the\s+)?([^.!?;|]+)/i);
  if (restriction && !/^(?:India|APAC|Asia[ -]Pacific)\b/i.test(restriction[1])) return null;
  if (!geo.pass || !classifyTitle(candidate).pass || !experience.pass || experience.manualReview) return null;
  candidate.classification = 'lead';
  candidate.discoveryUrl = candidate.canonicalUrl;
  return candidate;
}

// Discover the current monthly hiring thread without treating comments as verified listings.
export async function discoverHnJobs({ transport, resolveOriginalListing, runAt, perThreadCommentCap = 100, signal = null, deadline = null } = {}) {
  if (typeof transport !== 'function') throw new TypeError('HN requires injected transport');
  const date = new Date(runAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError('HN requires a valid runAt');
  if (!Number.isInteger(perThreadCommentCap) || perThreadCommentCap < 1) throw new TypeError('HN comment cap must be a positive integer');
  const month = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const title = `Ask HN: Who is hiring? (${month})`;
  const query = new URL('https://hn.algolia.com/api/v1/search_by_date');
  query.searchParams.set('query', title);
  query.searchParams.set('tags', 'story,author_whoishiring');
  query.searchParams.set('hitsPerPage', '5');
  const telemetry = { requests: 0, fetched: 0, extracted: 0, filtered: 0, resolved: 0, unresolved: 0 };
  const options = { signal, deadline };
  const search = await readJson(transport, query.toString(), options, telemetry);
  if (!Array.isArray(search?.hits)) throw new Error('hn-search-hits-not-array');
  const hit = search.hits.find((item) => item.title === title && item.author === 'whoishiring' && /^\d+$/.test(item.objectID));
  const observations = [];
  const verificationQueue = [];
  let threadId = null;
  let recordsNotExamined = 0;
  if (hit) {
    threadId = Number(hit.objectID);
    const thread = await readJson(transport, `https://hacker-news.firebaseio.com/v0/item/${threadId}.json`, options, telemetry);
    if (thread?.id !== threadId || thread.type !== 'story' || thread.by !== 'whoishiring' || thread.title !== title || thread.deleted || thread.dead || !Array.isArray(thread.kids)) throw new Error('hn-invalid-monthly-thread');
    const policy = loadConfig();
    const discoveryPolicy = { ...policy, geo: { ...policy.geo, remoteAllowedScopes: [...policy.geo.remoteAllowedScopes, 'worldwide', 'global', 'anywhere'] } };
    const ids = [...new Set(thread.kids)];
    recordsNotExamined = Math.max(0, ids.length - perThreadCommentCap);
    for (const id of ids.slice(0, perThreadCommentCap)) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('hn-invalid-comment-id');
      const comment = await readJson(transport, `https://hacker-news.firebaseio.com/v0/item/${id}.json`, options, telemetry);
      if (comment?.id !== id) throw new Error('hn-invalid-comment');
      if (comment.parent !== threadId) continue;
      telemetry.fetched += 1;
      let candidate = leadFrom(comment, threadId, runAt, discoveryPolicy);
      if (!candidate) { telemetry.filtered += 1; continue; }
      if (typeof resolveOriginalListing === 'function') {
        const resolution = await resolveOriginalListing(candidate, options);
        candidate = applyOriginalListingResolution(candidate, resolution);
      }
      observations.push(candidate);
      if (candidate.classification === 'direct') telemetry.resolved += 1;
      else verificationQueue.push({ url: candidate.canonicalUrl, company: candidate.company, reason: 'original-listing', evidence: candidate.evidence });
    }
  }
  telemetry.extracted = observations.length;
  telemetry.unresolved = verificationQueue.length;
  return {
    observations, verificationQueue, telemetry,
    manifest: { schemaVersion: 'HnDiscoveryManifestV1', runAt, threadId, status: observations.length ? 'ok' : 'empty', reason: hit ? observations.length ? null : 'no-eligible-comments' : 'monthly-thread-not-found', telemetry, sampled: recordsNotExamined > 0, recordsNotExamined, naturalTerminal: true, noAutoApply: true },
  };
}
