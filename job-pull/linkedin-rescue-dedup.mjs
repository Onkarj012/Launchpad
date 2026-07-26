import { canonicalizeUrl, normalizedKey } from './candidate.mjs';

function personKey(person) {
  if (person?.personUrl) return `url:${canonicalizeUrl(person.personUrl)}`;
  return `name:${normalizedKey(person?.personName)}|company:${normalizedKey(person?.company)}`;
}

export function canonicalLinkedInRescueKeys({ post = null, application = null, person = null } = {}) {
  const postUrl = canonicalizeUrl(post?.canonicalPostUrl ?? post?.postUrl ?? post?.postUrlEvidence);
  const applicationUrl = canonicalizeUrl(application?.originalApplicationUrl ?? application?.applicationUrl ?? application?.jobLink);
  const personIdentity = personKey(person);
  const channel = normalizedKey(person?.channel || 'linkedin-post').replace(/ /g, '-');
  return {
    postKey: postUrl ? `post:${postUrl}` : null,
    applicationKey: applicationUrl ? `application:${applicationUrl}` : null,
    personKey: personIdentity,
    duplicateKey: `${applicationUrl ? `application:${applicationUrl}` : postUrl ? `post:${postUrl}` : 'application:unresolved'}|${personIdentity}|channel:${channel}`,
  };
}

function mergeProvenance(target, source) {
  const posts = [...(target.provenance?.postUrls ?? []), ...(source.provenance?.postUrls ?? [])].filter(Boolean);
  const queries = [...(target.provenance?.queries ?? []), ...(source.provenance?.queries ?? [])].filter(Boolean);
  target.provenance = { ...(target.provenance ?? {}), postUrls: [...new Set(posts)], queries: [...new Set(queries)] };
  return target;
}

/** Stable first-wins dedup with merged provenance and explicit duplicate reports. */
export function deduplicateLinkedInRescueOutputs({ applicationLeads = [], associatedPeople = [] } = {}) {
  const duplicateReports = [];
  const keptApplications = [];
  const applicationByKey = new Map();
  for (const lead of applicationLeads) {
    const keys = canonicalLinkedInRescueKeys({ post: lead.postEvidence, application: lead });
    const key = keys.applicationKey || keys.postKey || `unresolved:${keptApplications.length}`;
    const prior = applicationByKey.get(key);
    if (prior) {
      mergeProvenance(prior, lead);
      duplicateReports.push({ code: 'DUPLICATE_APPLICATION', category: 'duplicate', duplicateKey: key, evidence: { duplicatePostUrl: lead.postUrl, keptPostUrl: prior.postUrl, applicationUrl: lead.originalApplicationUrl || lead.applicationUrl } });
    } else {
      const kept = { ...lead, provenance: { ...(lead.provenance ?? {}), postUrls: [...new Set(lead.provenance?.postUrls ?? [lead.postUrl])], queries: [...new Set(lead.provenance?.queries ?? [])] } };
      applicationByKey.set(key, kept);
      keptApplications.push(kept);
    }
  }
  const keptPeople = [];
  const peopleByKey = new Map();
  for (const person of associatedPeople) {
    const keys = canonicalLinkedInRescueKeys({ post: person.postEvidence, application: person, person });
    const prior = peopleByKey.get(keys.duplicateKey);
    if (prior) {
      mergeProvenance(prior, person);
      duplicateReports.push({ code: 'DUPLICATE_PERSON_CHANNEL', category: 'duplicate', duplicateKey: keys.duplicateKey, evidence: { duplicatePostUrl: person.evidenceUrl, keptPostUrl: prior.evidenceUrl, personName: person.personName, channel: person.channel } });
    } else {
      const kept = { ...person, duplicateKey: keys.duplicateKey, provenance: { ...(person.provenance ?? {}), postUrls: [...new Set(person.provenance?.postUrls ?? [person.evidenceUrl])], queries: [...new Set(person.provenance?.queries ?? [])] } };
      peopleByKey.set(keys.duplicateKey, kept);
      keptPeople.push(kept);
    }
  }
  return { applicationLeads: keptApplications, associatedPeople: keptPeople, duplicateReports };
}
