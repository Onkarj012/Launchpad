import { normalizeContactEvidence, ContactEvidenceError } from './evidence.mjs';

export const FREE_FIRST_SOURCE_ORDER = Object.freeze([
  'hiringAuthors',
  'companyTeamPages',
  'publicProfiles',
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

/**
 * Run contact providers in the documented free-first order. A provider is
 * optional and failures are recorded, never promoted into a send operation,
 * and never allowed to block the application path.
 */
export async function researchContact({ application, providers = {}, sourceOrder = FREE_FIRST_SOURCE_ORDER, allowPaid = true, now = () => Date.now() } = {}) {
  if (!application?.id) throw new ContactResearchError('application id is required', 'APPLICATION_ID_REQUIRED');
  const attempts = [];
  const failures = [];
  const rejected = [];
  const candidates = [];

  for (const source of sourceOrder) {
    if (PAID_OR_CREDIT_SOURCES.has(source) && !allowPaid) {
      attempts.push({ source, status: 'skipped', reason: 'optional-provider-disabled' });
      continue;
    }
    const provider = providerFunction(providers[source]);
    if (!provider) {
      attempts.push({ source, status: 'unavailable', reason: 'provider-not-injected' });
      continue;
    }
    try {
      const result = await provider({ application, source, now });
      const sourceCandidates = providerResult(result);
      attempts.push({ source, status: 'ok', candidates: sourceCandidates.length });
      for (const candidate of sourceCandidates) {
        try {
          const contact = normalizeContactEvidence(candidateWithMetadata(candidate, source), { application, source });
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
  const selected = candidates[0]?.contact ?? null;
  return {
    status: selected ? 'found' : 'not-found',
    applicationId: application.id,
    contact: selected,
    candidates: candidates.map(({ contact, source, score }) => ({ contact, source, score })),
    attempts,
    failures,
    rejected,
    researchedAt: new Date(typeof now === 'function' ? now() : now).toISOString(),
  };
}

export const researchOneContact = researchContact;
