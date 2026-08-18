import { fingerprintText, similarity } from '../career-ops/fingerprint-core.mjs';
import { candidateDedupKey, candidateRequisitionKey, canonicalizeUrl, companyTitleLocationKey, normalizedKey } from './candidate.mjs';

const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby', 'workday']);

export function sourceQuality(candidate) {
  const kind = normalizedKey(candidate.sourceKind).replace(/ /g, '-');
  const provider = normalizedKey(candidate.provider);
  const source = normalizedKey(candidate.source);
  if (kind === 'ats-direct' || kind === 'ats' || ATS_PROVIDERS.has(provider) || /greenhouse|lever|ashby|workday/.test(source)) return 3;
  if (kind === 'niche-public' || kind === 'public' || /public|search|jobicy|working-nomads|muse|glints|jobstreet/.test(source)) return 2;
  return 1;
}

export function providerJobKey(candidate) {
  if (!candidate.provider || !candidate.jobId) return null;
  return `${normalizedKey(candidate.provider)}|${normalizedKey(candidate.jobId)}`;
}

export function canonicalCandidateKeys(candidate) {
  return {
    url: canonicalizeUrl(candidate.canonicalUrl || candidate.url),
    providerJob: providerJobKey(candidate) || candidateRequisitionKey(candidate),
    companyTitleLocation: companyTitleLocationKey(candidate),
    durable: candidateDedupKey(candidate),
  };
}

function ledgerRows(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  return [];
}

function ledgerCollision(candidate, rows) {
  const keys = canonicalCandidateKeys(candidate);
  for (const row of rows) {
    if (!row || (row.state && !['pending', 'committed'].includes(row.state))) continue;
    const rowKey = normalizedKey(row.dedup_key ?? row.dedupKey);
    if (keys.durable && rowKey === normalizedKey(keys.durable)) return { row, key: 'durable' };
    if (keys.providerJob && rowKey === normalizedKey(keys.providerJob)) return { row, key: 'providerJob' };
    if (candidate.jobId && row.job_id != null && String(row.job_id) === String(candidate.jobId)) return { row, key: 'jobId' };
    const rowUrl = canonicalizeUrl(row.url ?? row.canonical_url ?? row.canonicalUrl);
    if (keys.url && rowUrl && rowUrl === keys.url) return { row, key: 'url' };
    // Legacy rows stored company|title|location. Match that only when the
    // candidate has no requisition id and no distinguishing URL.
    if (!keys.providerJob && keys.companyTitleLocation && rowKey === normalizedKey(keys.companyTitleLocation)) {
      if (!keys.url || !rowUrl || keys.url === rowUrl) return { row, key: 'companyTitleLocation' };
    }
  }
  return null;
}

function candidateOrder(a, b) {
  const quality = sourceQuality(b) - sourceQuality(a);
  if (quality) return quality;
  const aPosted = Date.parse(a.postedAt || '') || 0;
  const bPosted = Date.parse(b.postedAt || '') || 0;
  if (bPosted !== aPosted) return bPosted - aPosted;
  const aScore = Number(a.score ?? a.matchScore ?? 0);
  const bScore = Number(b.score ?? b.matchScore ?? 0);
  if (bScore !== aScore) return bScore - aScore;
  return `${a.canonicalUrl}\0${a.company}\0${a.title}`.localeCompare(`${b.canonicalUrl}\0${b.company}\0${b.title}`);
}

function duplicateResult(candidate, winner, code, evidence) {
  return { candidate, winner, code, evidence: evidence ?? null };
}

export function deduplicateCandidates(candidates, options = {}) {
  const rows = ledgerRows(options.ledgerRows ?? options.ledger);
  const useSimHash = options.useSimHash ?? true;
  const threshold = options.simHashSimilarity ?? 0.93;
  const sorted = [...candidates].sort(candidateOrder);
  const kept = [];
  const duplicates = [];
  let fingerprinted = 0;

  for (const original of sorted) {
    const candidate = { ...original };
    if (!candidate.fingerprint && typeof candidate.description === 'string' && candidate.description.trim()) {
      candidate.fingerprint = fingerprintText(candidate.description) || null;
    }
    if (candidate.fingerprint) fingerprinted++;

    const ledgerMatch = ledgerCollision(candidate, rows);
    if (ledgerMatch) {
      duplicates.push(duplicateResult(candidate, null, 'DEDUP_EXISTING_LEDGER', ledgerMatch.key));
      continue;
    }
    const keys = canonicalCandidateKeys(candidate);
    let winner = null;
    let code = null;
    let matchEvidence = null;
    for (const prior of kept) {
      const priorKeys = canonicalCandidateKeys(prior);
      if (keys.url && priorKeys.url && keys.url === priorKeys.url) {
        winner = prior;
        code = 'DEDUP_CANONICAL_URL';
        matchEvidence = keys.url;
        break;
      }
      if (keys.providerJob && priorKeys.providerJob && keys.providerJob === priorKeys.providerJob) {
        winner = prior;
        code = 'DEDUP_PROVIDER_JOB_ID';
        matchEvidence = keys.providerJob;
        break;
      }
      // Company+title+location is last-resort only. Distinct requisitions
      // at the same desk stay distinct.
      if (
        !keys.providerJob && !priorKeys.providerJob
        && keys.companyTitleLocation && priorKeys.companyTitleLocation
        && keys.companyTitleLocation === priorKeys.companyTitleLocation
      ) {
        winner = prior;
        code = 'DEDUP_COMPANY_TITLE_LOCATION';
        matchEvidence = keys.companyTitleLocation;
        break;
      }
      if (useSimHash && candidate.fingerprint && prior.fingerprint) {
        const score = similarity(candidate.fingerprint, prior.fingerprint);
        if (score >= threshold) {
          winner = prior;
          code = 'DEDUP_SIMHASH';
          matchEvidence = score;
          break;
        }
      }
    }
    if (winner) duplicates.push(duplicateResult(candidate, winner, code, matchEvidence));
    else kept.push(candidate);
  }
  return {
    kept,
    duplicates,
    fingerprintCoverage: { fingerprinted, totalWithDescription: candidates.filter((candidate) => typeof candidate.description === 'string' && candidate.description.trim()).length },
  };
}
