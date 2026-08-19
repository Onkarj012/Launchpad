import { normalizeContactEvidence, ContactEvidenceError } from '../outreach-v5/evidence.mjs';
import { outreachDuplicateKey } from '../outreach-v5/idempotency.mjs';

const DEFAULTS = Object.freeze({
  maxApplications: 8,
  maxContactsPerApplication: 2,
  maxContacts: 10,
});

const SOURCE_ORDER = Object.freeze([
  'hiringAuthors',
  'recruiters',
  'companyTeamPages',
  'publicProfiles',
]);

const CONFIDENCE_SCORE = Object.freeze({ High: 30, Medium: 20, Low: 10 });

export class ContactResearchError extends Error {
  constructor(message, code = 'CONTACT_RESEARCH_ERROR', details = null) {
    super(message);
    this.name = 'ContactResearchError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  const valueText = String(value ?? '').normalize('NFKC').trim();
  return valueText || null;
}

function score(application) {
  return Number(application?.conversionScore ?? application?.matchScore ?? application?.score ?? 0) || 0;
}

function selected(application) {
  return application?.selected === true
    || application?.userSelected === true
    || String(application?.selectionStatus ?? '').toLowerCase() === 'selected';
}

function verified(application) {
  return application?.verified === true
    || application?.applicationReady === true
    || ['verified', 'application-ready', 'ready'].includes(String(application?.verificationStatus ?? application?.readiness ?? '').toLowerCase());
}

function eligible(application) {
  return Boolean(application?.id) && selected(application) && verified(application);
}

function providerFunction(provider) {
  if (typeof provider === 'function') return provider;
  return provider?.research ?? provider?.discover ?? provider?.search ?? null;
}

function providerCandidates(result) {
  if (Array.isArray(result)) return result;
  if (result?.contact) return [result.contact];
  if (result?.name || result?.person || result?.Person) return [result];
  return result?.contacts ?? result?.candidates ?? result?.results ?? [];
}

function guessedEmail(candidate) {
  if (!candidate?.email && !candidate?.publicEmail) return null;
  if (candidate.emailGuessed === true || candidate.guessedEmail === true || candidate.emailUnverified === true || candidate.emailVerified === false || String(candidate.emailStatus ?? '').toLowerCase() === 'unverified') {
    return text(candidate.email ?? candidate.publicEmail)?.toLowerCase() ?? null;
  }
  return null;
}

function candidateForNormalization(candidate, application, source) {
  const guess = guessedEmail(candidate);
  const evidence = candidate.publicEvidence ?? candidate.evidence ?? candidate.evidenceUrls ?? candidate.evidenceUrl;
  const prepared = {
    ...candidate,
    source: candidate.source ?? source,
    publicEvidence: evidence,
  };
  if (guess) {
    delete prepared.email;
    delete prepared.publicEmail;
    delete prepared.emailEvidence;
    delete prepared.emailSource;
    prepared.recommendedChannel = candidate.recommendedChannel === 'Email' ? 'LinkedIn' : candidate.recommendedChannel;
  }
  return { prepared, guess, application };
}

function roleRank(candidate) {
  if (candidate?.hiringPostAuthor === true || candidate?.isHiringPostAuthor === true) return { rank: 5, label: 'hiring-post author' };
  const role = String(candidate?.currentRole ?? candidate?.role ?? candidate?.title ?? '').toLowerCase();
  if (/recruit|talent acquisition|people partner|technical sourc/.test(role)) return { rank: 4, label: 'recruiter' };
  if (/engineering manager|hiring manager|people manager|head of engineering|vp engineering/.test(role)) return { rank: 3, label: 'engineering manager' };
  if (/team lead|tech lead|technical lead|lead engineer|principal|staff engineer|senior engineer/.test(role)) return { rank: 2, label: 'team lead or senior engineer' };
  if (/founder|co-founder|cto|chief technology/.test(role)) return { rank: 1, label: 'founder or CTO' };
  return { rank: 0, label: 'role-relevant contact' };
}

function relevance(candidate, source) {
  const role = roleRank(candidate);
  const explicit = Number(candidate?.relevanceScore ?? candidate?.relevance);
  const explicitScore = Number.isFinite(explicit) ? explicit : 0;
  const confidence = CONFIDENCE_SCORE[candidate?.confidence] ?? 0;
  const sourceBonus = Math.max(0, SOURCE_ORDER.length - SOURCE_ORDER.indexOf(source));
  return {
    score: role.rank * 1000 + explicitScore + confidence + sourceBonus,
    reason: text(candidate?.relevanceReason) ?? `${role.label}; evidence is tied to the application company or hiring team`,
  };
}

function duplicateKey(applicationId, contact) {
  return outreachDuplicateKey({ applicationId, person: contact, channel: contact.recommendedChannel });
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new ContactResearchError('contact research clock is invalid', 'CLOCK_INVALID');
  return date.toISOString();
}

function compare(left, right) {
  return right.rankScore - left.rankScore
    || String(left.contact.name).localeCompare(String(right.contact.name))
    || String(left.contact.personId).localeCompare(String(right.contact.personId));
}

/**
 * Prepare a bounded contact-research handoff from user-selected, verified
 * applications. Providers are injected and this function has no persistence
 * or sending seam by design.
 */
export async function runContactResearch({
  applications = [],
  providers = {},
  sourceOrder = SOURCE_ORDER,
  maxApplications = DEFAULTS.maxApplications,
  maxContactsPerApplication = DEFAULTS.maxContactsPerApplication,
  maxContacts = DEFAULTS.maxContacts,
  now = () => Date.now(),
} = {}) {
  const researchedAt = nowIso(now);
  const applicationLimit = Math.max(0, Number(maxApplications) || DEFAULTS.maxApplications);
  const perApplicationLimit = Math.max(0, Number(maxContactsPerApplication) || DEFAULTS.maxContactsPerApplication);
  const totalLimit = Math.max(0, Number(maxContacts) || DEFAULTS.maxContacts);
  const selectedApplications = applications.filter(eligible)
    .sort((left, right) => score(right) - score(left) || String(left.id).localeCompare(String(right.id)))
    .slice(0, applicationLimit);
  const researched = [];
  const failures = [];

  for (const application of selectedApplications) {
    const candidates = [];
    for (let sourceIndex = 0; sourceIndex < sourceOrder.length; sourceIndex += 1) {
      const source = sourceOrder[sourceIndex];
      const provider = providerFunction(providers[source]);
      if (!provider) continue;
      try {
        const rawCandidates = providerCandidates(await provider({ application, source, now: researchedAt }));
        for (let index = 0; index < rawCandidates.length; index += 1) {
          const raw = rawCandidates[index];
          try {
            const { prepared, guess } = candidateForNormalization(raw, application, source);
            const contact = normalizeContactEvidence(prepared, { application, source });
            const rank = relevance(raw, source);
            const enriched = guess
              ? { ...contact, guessedEmail: guess, emailStatus: 'unverified' }
              : contact;
            candidates.push({ contact: enriched, evidenceUrl: enriched.publicEvidence[0].url, confidence: enriched.confidence, relevance: rank.reason, rankScore: rank.score, source, sourceIndex, candidateIndex: index });
          } catch (error) {
            if (!(error instanceof ContactEvidenceError)) failures.push({ applicationId: application.id, source, code: 'CONTACT_NORMALIZATION_FAILED', message: error.message });
          }
        }
      } catch (error) {
        failures.push({ applicationId: application.id, source, code: error.code ?? 'PROVIDER_FAILED', message: error.message });
      }
    }
    const bestByKey = new Map();
    for (const candidate of candidates.sort(compare)) {
      const key = duplicateKey(application.id, candidate.contact);
      if (!bestByKey.has(key)) bestByKey.set(key, { ...candidate, duplicateKey: key });
    }
    researched.push({ application, contacts: [...bestByKey.values()].sort(compare).slice(0, perApplicationLimit) });
  }

  const contacts = [];
  for (const row of researched) {
    for (const contact of row.contacts) {
      if (contacts.length >= totalLimit) break;
      contacts.push({ applicationId: row.application.id, ...contact });
    }
    if (contacts.length >= totalLimit) break;
  }
  const contactsByApplication = researched.map((row) => ({
    applicationId: row.application.id,
    contacts: contacts.filter((item) => item.applicationId === row.application.id),
  })).filter((row) => row.contacts.length);

  return {
    schemaVersion: 'LaunchpadV5ContactResearchHandoffV1',
    status: failures.length ? 'partial' : 'planned',
    researchedApplicationIds: selectedApplications.map((application) => application.id),
    contacts,
    contactsByApplication,
    verifiedContactCount: contacts.filter((item) => !item.contact.emailStatus || item.contact.emailStatus !== 'unverified').length,
    failures,
    researchedAt,
    planningOnly: true,
    noAutoApply: true,
    noSend: true,
    actions: { writes: [], sends: [] },
  };
}

export const prepareContactResearch = runContactResearch;
export const contactResearch = runContactResearch;
export default runContactResearch;
