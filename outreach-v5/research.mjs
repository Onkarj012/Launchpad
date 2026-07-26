import { normalizeContactEvidence, ContactEvidenceError } from './evidence.mjs';

export const FREE_FIRST_SOURCE_ORDER = Object.freeze([
  'hiringAuthors',
  'companyTeamPages',
  'publicProfiles',
  'publicCompanyEmailEvidence',
  'apollo',
  'hunter',
  'vibe',
]);

const PAID_OR_CREDIT_SOURCES = new Set(['apollo', 'hunter', 'vibe']);

export class ContactResearchError extends Error {
  constructor(message, code = 'CONTACT_RESEARCH_ERROR', details = null) {
    super(message);
    this.name = 'ContactResearchError';
    this.code = code;
    this.details = details;
  }
}

function providerFunction(provider) {
  if (typeof provider === 'function') return provider;
  return provider?.research ?? provider?.discover ?? provider?.search ?? null;
}

function providerResult(result) {
  if (Array.isArray(result)) return result;
  if (result?.contact) return [result.contact];
  if (result?.name || result?.person || result?.Person) return [result];
  return result?.contacts ?? result?.candidates ?? result?.results ?? [];
}

function relevance(candidate, source, index) {
  const explicit = Number(candidate?.relevanceScore ?? candidate?.score);
  if (Number.isFinite(explicit)) return explicit;
  const role = String(candidate?.currentRole ?? candidate?.role ?? candidate?.title ?? '').toLocaleLowerCase('en-US');
  const roleSignal = /(recruit|talent|hiring|people|engineering|technical|founder|lead)/.test(role) ? 10 : 0;
  return roleSignal - index / 100 - FREE_FIRST_SOURCE_ORDER.indexOf(source) / 1000;
}

function candidateWithMetadata(candidate, source) {
  return { ...candidate, source: candidate?.source ?? source };
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new ContactResearchError('contact research clock is invalid', 'CLOCK_INVALID');
  return date.toISOString();
}

function providerApplication(application = {}) {
  return Object.freeze({
    id: application.id,
    role: application.role ?? application.Role ?? null,
    companyName: application.companyName ?? application.company ?? application.Company ?? null,
    originalApplicationUrl: application.originalApplicationUrl ?? application['Original Application URL'] ?? null,
    hiringPostUrl: application.hiringPostUrl ?? null,
    companyTeamUrl: application.companyEvidence?.careerPageUrl ?? application.companyTeamUrl ?? null,
    companyDomain: application.companyEvidence?.canonicalDomain ?? application.companyDomain ?? null,
  });
}

function paidApprovalValid({ allowPaid, paidApproval, runId }) {
  if (allowPaid !== true || paidApproval?.confirmed !== true) return false;
  if (!String(paidApproval.approvedBy ?? paidApproval.source ?? '').trim()) return false;
  const approvedRun = String(paidApproval.runId ?? '').trim();
  return Boolean(approvedRun && runId && approvedRun === String(runId));
}

function assertSourceOrder(sourceOrder) {
  const positions = sourceOrder.map((source) => FREE_FIRST_SOURCE_ORDER.indexOf(source));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new ContactResearchError('contact sources must preserve the documented free-first order', 'SOURCE_ORDER_INVALID');
  }
}

/**
 * Run contact providers in the documented free-first order. A provider is
 * optional and failures are recorded, never promoted into a send operation,
 * and never allowed to block the application path.
 */
export async function researchContact({ application, providers = {}, sourceOrder = FREE_FIRST_SOURCE_ORDER, allowPaid = false, paidApproval = null, runId = application?.runId ?? null, now = () => Date.now() } = {}) {
  if (!application?.id) throw new ContactResearchError('application id is required', 'APPLICATION_ID_REQUIRED');
  assertSourceOrder(sourceOrder);
  const attempts = [];
  const failures = [];
  const rejected = [];
  const candidates = [];
  const observedAt = nowIso(now);
  const approvedPaidRun = paidApprovalValid({ allowPaid, paidApproval, runId });

  for (const source of sourceOrder) {
    if (PAID_OR_CREDIT_SOURCES.has(source) && !approvedPaidRun) {
      attempts.push({ source, status: 'skipped', reason: allowPaid ? 'per-run-approval-required' : 'paid-provider-disabled' });
      continue;
    }
    const provider = providerFunction(providers[source]);
    if (!provider) {
      attempts.push({ source, status: 'unavailable', reason: 'provider-not-injected' });
      continue;
    }
    try {
      const result = await provider({ application: providerApplication(application), source, observedAt });
      const sourceCandidates = providerResult(result);
      attempts.push({ source, status: 'ok', candidates: sourceCandidates.length });
      for (const candidate of sourceCandidates) {
        try {
          const contact = normalizeContactEvidence({ ...candidateWithMetadata(candidate, source), observedAt: candidate?.observedAt ?? observedAt }, { application, source });
          candidates.push({ contact, source, score: relevance(candidate, source, candidates.length) });
        } catch (error) {
          if (error instanceof ContactEvidenceError) rejected.push({ source, code: error.code, message: error.message });
          else rejected.push({ source, code: 'CONTACT_NORMALIZATION_FAILED', message: error.message });
        }
      }
      // The first usable source wins. This preserves free-first behavior and
      // avoids spending paid credits after a usable public path is found.
      if (candidates.length) break;
    } catch (error) {
      failures.push({ source, code: error.code ?? 'PROVIDER_FAILED', message: error.message });
      attempts.push({ source, status: 'failed' });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.contact.name.localeCompare(right.contact.name));
  const ranked = candidates.slice(0, 2).map(({ contact, source, score }, index) => Object.freeze({ contact, source, score, recommended: index === 0 }));
  const recommendedCandidate = ranked[0]?.contact ?? null;
  return {
    status: recommendedCandidate ? 'found' : 'not-found',
    applicationId: application.id,
    contact: null,
    recommendedCandidate,
    candidates: ranked,
    attempts,
    failures,
    rejected,
    researchedAt: observedAt,
  };
}

export const researchOneContact = researchContact;
