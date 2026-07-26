import { canonicalizeUrl, normalizedKey } from './candidate.mjs';

export const COMPANY_STAGES = Object.freeze(['Startup', 'Scale-up', 'Mid-size', 'Enterprise']);

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function iso(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateOnly(value) {
  const timestamp = iso(value);
  return timestamp ? timestamp.slice(0, 10) : null;
}

function canonicalDomain(value) {
  const url = canonicalizeUrl(value);
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; }
}

function stageValue(value) {
  const raw = text(value)?.toLowerCase().replace(/\s+/g, '-') || '';
  return COMPANY_STAGES.find((stage) => stage.toLowerCase() === raw) || null;
}

function verifiedAtFor(raw, runAt, fallbackAllowed = true) {
  const supplied = iso(raw?.verifiedAt ?? raw?.lastVerified ?? raw?.verificationTime);
  if (supplied && Date.parse(supplied) <= Date.parse(runAt)) return supplied;
  return fallbackAllowed ? runAt : null;
}

function stageFor(raw, lane, runAt) {
  const explicit = stageValue(raw?.stage ?? raw?.companyStage ?? raw?.company?.stage);
  if (explicit) return { value: explicit, evidence: text(raw?.stageEvidence ?? raw?.companyStageEvidence) || `explicit company stage: ${explicit}`, verifiedAt: verifiedAtFor(raw, runAt), explicit: true };
  const employees = number(raw?.employeeCount ?? raw?.headcount ?? raw?.company?.employeeCount);
  if (employees != null) {
    const value = employees >= 1000 ? 'Enterprise' : employees >= 100 ? 'Mid-size' : employees >= 20 ? 'Scale-up' : 'Startup';
    return { value, evidence: `employee count: ${employees}`, verifiedAt: verifiedAtFor(raw, runAt), explicit: true };
  }
  const evidence = text(raw?.stageEvidence ?? raw?.companyStageEvidence) || `startup source lane: ${lane || 'startup'}`;
  return { value: 'Startup', evidence, verifiedAt: verifiedAtFor(raw, runAt), explicit: false };
}

function cutoffMonths(runAt, months) {
  const date = new Date(runAt);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function signalEvidence(raw, lane, runAt) {
  const evidenceValue = raw?.fundingEvidence ?? raw?.evidence ?? raw?.announcementEvidence ?? null;
  const evidence = typeof evidenceValue === 'string' ? text(evidenceValue) : evidenceValue && typeof evidenceValue === 'object' ? { ...evidenceValue } : null;
  const sourceUrl = canonicalizeUrl(raw?.fundingSourceUrl ?? raw?.sourceUrl ?? raw?.announcementUrl ?? raw?.url);
  const explicitVerifiedAt = iso(raw?.verifiedAt ?? raw?.verifiedAtAt ?? raw?.checkedAt);
  const verifiedAt = explicitVerifiedAt && Date.parse(explicitVerifiedAt) <= Date.parse(runAt)
    ? explicitVerifiedAt
    : (evidence && sourceUrl ? runAt : null);
  return { evidence, sourceUrl, verifiedAt, source: text(raw?.source ?? raw?.provider ?? lane) };
}

export function normalizeFundingSignal(raw, { lane = 'funding-hiring-signals', runAt } = {}) {
  const fundingDate = dateOnly(raw?.fundingDate ?? raw?.fundedAt ?? raw?.announcementDate ?? raw?.roundDate);
  const evidence = signalEvidence(raw, lane, runAt);
  const verified = Boolean(evidence.verifiedAt && evidence.evidence && (evidence.sourceUrl || evidence.source));
  const runDate = dateOnly(runAt);
  const within18Months = verified && fundingDate != null && fundingDate <= runDate && fundingDate >= cutoffMonths(runAt, 18);
  const under6Months = within18Months && fundingDate >= cutoffMonths(runAt, 6);
  const hiringSignalValue = raw?.hiringSignal ?? raw?.hiringAnnouncement ?? raw?.hiringEvidence;
  const hiringEvidence = text(hiringSignalValue) || (raw?.activelyHiring === true ? 'actively hiring signal supplied by source' : null);
  const hiringVerifiedAt = hiringEvidence && evidence.verifiedAt ? evidence.verifiedAt : null;
  return {
    fundingDate,
    fundingEvidence: evidence.evidence,
    fundingSourceUrl: evidence.sourceUrl,
    verifiedAt: evidence.verifiedAt,
    verified,
    within18Months,
    under6Months,
    hiringSignal: hiringEvidence ? { active: Boolean(hiringVerifiedAt), evidence: hiringEvidence, verifiedAt: hiringVerifiedAt } : null,
    signalType: under6Months ? 'funded-under-6-months' : within18Months ? 'funded-within-18-months' : hiringEvidence ? 'verified-hiring-signal' : null,
  };
}

function companyName(raw) {
  return text(typeof raw === 'string' ? raw : raw?.company ?? raw?.companyName ?? raw?.name);
}

function companyKey(value) { return normalizedKey(value); }

export function normalizeStartupCompany(raw, { lane = 'startup', runAt } = {}) {
  const name = companyName(raw);
  if (!name) return null;
  const stage = stageFor(raw, lane, runAt);
  const signal = normalizeFundingSignal(raw, { lane, runAt });
  const careerPageUrl = canonicalizeUrl(raw?.careerPageUrl ?? raw?.careersUrl ?? raw?.careers);
  const atsBoardUrl = canonicalizeUrl(raw?.atsBoardUrl ?? raw?.atsUrl ?? raw?.jobsUrl);
  const sourceUrl = canonicalizeUrl(raw?.sourceUrl ?? raw?.evidenceUrl ?? raw?.fundingSourceUrl ?? raw?.announcementUrl);
  const source = text(raw?.source ?? raw?.provider ?? lane);
  const verifiedAt = stage.verifiedAt || signal.verifiedAt || runAt;
  return {
    name,
    companyKey: companyKey(name),
    canonicalDomain: canonicalDomain(raw?.canonicalDomain ?? raw?.domain ?? raw?.website ?? careerPageUrl ?? atsBoardUrl),
    careerPageUrl,
    atsProvider: text(raw?.atsProvider ?? raw?.provider),
    atsBoardUrl,
    stage: stage.value,
    stageEvidence: stage.evidence,
    stageExplicit: stage.explicit,
    fundingDate: signal.fundingDate,
    fundingEvidence: signal.fundingEvidence,
    fundingSourceUrl: signal.fundingSourceUrl,
    fundingSignal: signal,
    locations: Array.isArray(raw?.locations) ? raw.locations.filter(Boolean).map(String) : raw?.location ? [String(raw.location)] : [],
    remotePolicy: text(raw?.remotePolicy ?? raw?.remoteEligibility ?? raw?.remotePolicyEvidence),
    verificationState: verifiedAt ? 'Verified' : 'Not Verified',
    lastVerified: verifiedAt,
    source,
    sourceUrl,
    sourceLanes: [lane],
  };
}

function mergeCompany(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const signal = incoming.fundingSignal?.under6Months ? incoming.fundingSignal
    : existing.fundingSignal?.under6Months ? existing.fundingSignal
    : incoming.fundingSignal?.within18Months ? incoming.fundingSignal
    : existing.fundingSignal;
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([key, value]) => key !== 'stage' && key !== 'stageEvidence' && key !== 'stageExplicit' && value != null && value !== '' && (!Array.isArray(value) || value.length))),
    ...(incoming.stageExplicit || !existing.stageExplicit ? { stage: incoming.stage, stageEvidence: incoming.stageEvidence, stageExplicit: incoming.stageExplicit } : {}),
    sourceLanes: [...new Set([...(existing.sourceLanes || []), ...(incoming.sourceLanes || [])])],
    locations: [...new Set([...(existing.locations || []), ...(incoming.locations || [])])],
    fundingSignal: signal || null,
    fundingDate: signal?.fundingDate ?? existing.fundingDate ?? incoming.fundingDate ?? null,
    fundingEvidence: signal?.fundingEvidence ?? existing.fundingEvidence ?? incoming.fundingEvidence ?? null,
    fundingSourceUrl: signal?.fundingSourceUrl ?? existing.fundingSourceUrl ?? incoming.fundingSourceUrl ?? null,
  };
}

function inlineCompany(candidate, runAt) {
  const raw = candidate?.companyRecord ?? candidate?.companyEvidence ?? null;
  return raw ? normalizeStartupCompany(raw, { lane: candidate.startupLaneId || 'startup', runAt }) : null;
}

function collectCompanyRecords(sourceResults, runAt) {
  const byKey = new Map();
  for (const source of sourceResults) {
    const lane = source.manifest?.sourceId || 'startup';
    const records = [
      ...(source.companyRecords || []),
      ...(source.fundingSignals || []),
      ...(source.hiringSignals || []),
    ];
    for (const raw of records) {
      const company = normalizeStartupCompany(raw, { lane, runAt });
      if (!company) continue;
      byKey.set(company.companyKey, mergeCompany(byKey.get(company.companyKey), company));
    }
  }
  return byKey;
}

function enrichCandidate(candidate, company, runAt) {
  const inline = inlineCompany(candidate, runAt);
  const merged = mergeCompany(company, inline);
  const record = merged || normalizeStartupCompany({ company: candidate.company }, { lane: candidate.startupLaneId || 'startup', runAt });
  const sourceLanes = [...new Set([candidate.startupLaneId, ...(record?.sourceLanes || [])].filter(Boolean))];
  const funding = record?.fundingSignal || null;
  const activeHiring = funding?.hiringSignal?.active === true;
  const startupPriority = Number(candidate.startupSourcePriority || 0)
    + (funding?.under6Months ? 30 : funding?.within18Months ? 15 : 0)
    + (activeHiring ? 10 : 0);
  return {
    ...candidate,
    companyStage: record?.stage || null,
    companyStageEvidence: record?.stageEvidence || null,
    companyVerifiedAt: record?.lastVerified || runAt,
    companyRecord: record,
    fundingDate: record?.fundingDate || null,
    fundingEvidence: record?.fundingEvidence || null,
    fundingSignal: funding,
    hiringSignal: funding?.hiringSignal || null,
    startupSource: candidate.discoverySource || candidate.source || candidate.startupLaneId,
    startupSourceLanes: sourceLanes,
    startupPriority,
    careerPageUrl: record?.careerPageUrl || null,
    atsProvider: record?.atsProvider || candidate.provider || null,
    atsBoardUrl: record?.atsBoardUrl || null,
    remotePolicy: record?.remotePolicy || null,
    companyLocations: record?.locations || [],
    evidence: {
      ...(candidate.evidence || {}),
      startup: {
        source: candidate.discoverySource || candidate.source || candidate.startupLaneId,
        sourceLanes,
        stage: record?.stage || null,
        stageEvidence: record?.stageEvidence || null,
        verifiedAt: record?.lastVerified || runAt,
        funding: funding || null,
        careerPageUrl: record?.careerPageUrl || null,
        atsProvider: record?.atsProvider || candidate.provider || null,
        atsBoardUrl: record?.atsBoardUrl || null,
        remotePolicy: record?.remotePolicy || null,
      },
    },
  };
}

export function enrichStartupSources(sourceResults, { runAt } = {}) {
  const companies = collectCompanyRecords(sourceResults, runAt);
  const enrichedSources = sourceResults.map((source) => ({
    ...source,
    candidates: source.candidates.map((candidate) => enrichCandidate(candidate, companies.get(companyKey(candidate.company)), runAt)),
  }));
  for (const source of enrichedSources) {
    for (const candidate of source.candidates) {
      const company = candidate.companyRecord;
      if (company) companies.set(company.companyKey, mergeCompany(companies.get(company.companyKey), company));
    }
  }
  const companyRecords = [...companies.values()].sort((left, right) => left.companyKey.localeCompare(right.companyKey));
  return { sources: enrichedSources, companyRecords };
}

export function enrichStartupCandidates(candidates, companyRecords = [], { runAt } = {}) {
  const sources = candidates.map((candidate) => ({ candidates: [candidate], manifest: { sourceId: candidate.startupLaneId || 'startup' } }));
  const records = companyRecords.map((record) => ({ companyRecords: [record], manifest: { sourceId: 'startup-enrichment' } }));
  const result = enrichStartupSources([...sources, ...records], { runAt });
  return result.sources.filter((source) => source.candidates.length).flatMap((source) => source.candidates);
}
