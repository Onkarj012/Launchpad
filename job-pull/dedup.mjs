import { fingerprintText, similarity } from '../career-ops/fingerprint-core.mjs';
import { candidateDedupKey, canonicalizeUrl, normalizedKey } from './candidate.mjs';

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

export function requisitionKey(candidate) {
  const requisitionId = candidate.requisitionId || null;
  if (!requisitionId) return null;
  return `${normalizedKey(candidate.provider || candidate.company)}|${normalizedKey(requisitionId)}`;
}

export function canonicalCandidateKeys(candidate) {
  return {
    url: canonicalizeUrl(candidate.canonicalUrl || candidate.url),
    requisition: requisitionKey(candidate),
    providerJob: providerJobKey(candidate),
    companyTitleLocation: candidateDedupKey(candidate),
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
    if (keys.companyTitleLocation && normalizedKey(row.dedup_key ?? row.dedupKey) === normalizedKey(keys.companyTitleLocation)) return { row, key: 'companyTitleLocation' };
    if (candidate.requisitionId && String(row.requisition_id ?? row.requisitionId ?? '') === String(candidate.requisitionId)) return { row, key: 'requisitionId' };
    if (candidate.jobId && row.job_id != null && String(row.job_id) === String(candidate.jobId)) return { row, key: 'jobId' };
    const rowUrl = canonicalizeUrl(row.url ?? row.canonical_url ?? row.canonicalUrl);
    if (keys.url && rowUrl && rowUrl === keys.url) return { row, key: 'url' };
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

function identityAlias(candidate) {
  return {
    provider: candidate.provider || null,
    jobId: candidate.jobId || null,
    requisitionId: candidate.requisitionId || null,
    canonicalUrl: candidate.canonicalUrl || null,
    source: candidate.source || null,
  };
}

function sourceProvenance(candidate) {
  return {
    source: candidate.source || null,
    sourceKind: candidate.sourceKind || null,
    provider: candidate.provider || null,
    canonicalUrl: candidate.canonicalUrl || null,
    jobId: candidate.jobId || null,
    requisitionId: candidate.requisitionId || null,
    quality: sourceQuality(candidate),
  };
}

function readPath(candidate, field) {
  return field.split('.').reduce((value, key) => value?.[key], candidate);
}

function writePath(candidate, field, value) {
  const keys = field.split('.');
  let target = candidate;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

function missing(value) {
  return value == null || value === '' || typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((entry) => entry == null || entry === '');
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function factRank(field, candidate, value) {
  let rank = sourceQuality(candidate) * 100;
  if (field === 'description') rank += Math.min(50, String(value || '').length / 100);
  if (field === 'liveness') {
    if (value?.status === 'Expired') rank += 40;
    else if (value?.status === 'Active') rank += 30;
  }
  if (field === 'originalApplicationUrl' && /greenhouse|lever|ashby|workday|smartrecruiters|workable/i.test(String(value || ''))) rank += 30;
  if (['jobId', 'requisitionId'].includes(field) && sourceQuality(candidate) === 3) rank += 30;
  return rank;
}

const MERGE_FIELDS = Object.freeze([
  'description',
  'postedAt',
  'location',
  'employment',
  'experience',
  'liveness',
  'jobId',
  'requisitionId',
  'originalApplicationUrl',
  'applicationResolution',
  'originalApplicationEvidence',
  'verifiedAt',
]);

function mergeCandidateEvidence(winner, loser, code, matchEvidence) {
  const changedFields = [];
  const conflicts = [];
  const facts = { ...(winner.evidence?.dedup?.facts || {}) };
  for (const field of MERGE_FIELDS) {
    const current = readPath(winner, field);
    const incoming = readPath(loser, field);
    if (missing(incoming) || sameValue(current, incoming)) continue;
    const useIncoming = missing(current) || factRank(field, loser, incoming) > factRank(field, winner, current);
    if (!missing(current)) {
      conflicts.push({
        field,
        kept: useIncoming ? incoming : current,
        discarded: useIncoming ? current : incoming,
        decision: useIncoming ? 'REPLACED_WITH_HIGHER_QUALITY_EVIDENCE' : 'KEPT_HIGHER_QUALITY_EVIDENCE',
      });
    }
    if (!useIncoming) continue;
    writePath(winner, field, structuredClone(incoming));
    facts[field] = sourceProvenance(loser);
    changedFields.push(field);
  }

  const aliases = [...(winner.identityAliases || [identityAlias(winner)]), ...(loser.identityAliases || [identityAlias(loser)])];
  winner.identityAliases = aliases.filter((alias, index) => aliases.findIndex((entry) => sameValue(entry, alias)) === index);
  const priorDedup = winner.evidence?.dedup || {};
  const decision = {
    code,
    matchEvidence,
    winnerUrl: winner.canonicalUrl,
    duplicateUrl: loser.canonicalUrl,
    changedFields,
    conflicts,
  };
  winner.evidence = {
    ...winner.evidence,
    dedup: {
      ...priorDedup,
      sources: [...(priorDedup.sources || [sourceProvenance(winner)]), sourceProvenance(loser)],
      facts,
      merges: [...(priorDedup.merges || []), decision],
      conflicts: [...(priorDedup.conflicts || []), ...conflicts],
    },
  };
  if (!winner.fingerprint && typeof winner.description === 'string' && winner.description.trim()) {
    winner.fingerprint = fingerprintText(winner.description) || null;
  }
  return decision;
}

function simHashCompatible(left, right) {
  return normalizedKey(left.company) === normalizedKey(right.company)
    && normalizedKey(left.title) === normalizedKey(right.title);
}

export function deduplicateCandidates(candidates, options = {}) {
  const rows = ledgerRows(options.ledgerRows ?? options.ledger);
  const useSimHash = options.useSimHash ?? true;
  const threshold = options.simHashSimilarity ?? 0.93;
  const sorted = [...candidates].sort(candidateOrder);
  const kept = [];
  const duplicates = [];
  const decisions = [];
  let fingerprinted = 0;

  for (const original of sorted) {
    const candidate = structuredClone(original);
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
      if (keys.requisition && priorKeys.requisition && keys.requisition === priorKeys.requisition) {
        winner = prior;
        code = 'DEDUP_REQUISITION_ID';
        matchEvidence = keys.requisition;
        break;
      }
      if (keys.providerJob && priorKeys.providerJob && keys.providerJob === priorKeys.providerJob) {
        winner = prior;
        code = 'DEDUP_PROVIDER_JOB_ID';
        matchEvidence = keys.providerJob;
        break;
      }
      if (keys.companyTitleLocation && priorKeys.companyTitleLocation && keys.companyTitleLocation === priorKeys.companyTitleLocation) {
        winner = prior;
        code = 'DEDUP_COMPANY_TITLE_LOCATION';
        matchEvidence = keys.companyTitleLocation;
        break;
      }
      if (useSimHash && candidate.fingerprint && prior.fingerprint && simHashCompatible(candidate, prior)) {
        const score = similarity(candidate.fingerprint, prior.fingerprint);
        if (score >= threshold) {
          winner = prior;
          code = 'DEDUP_SIMHASH';
          matchEvidence = score;
          break;
        }
      }
    }
    if (winner) {
      const decision = mergeCandidateEvidence(winner, candidate, code, matchEvidence);
      decisions.push(decision);
      duplicates.push({ ...duplicateResult(candidate, winner, code, matchEvidence), merge: decision });
    } else {
      candidate.identityAliases = [identityAlias(candidate)];
      kept.push(candidate);
    }
  }
  return {
    kept,
    duplicates,
    decisions,
    fingerprintCoverage: { fingerprinted, totalWithDescription: candidates.filter((candidate) => typeof candidate.description === 'string' && candidate.description.trim()).length },
  };
}
