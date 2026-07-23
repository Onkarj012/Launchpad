import { canonicalizeUrl, normalizedKey } from './candidate.mjs';

function channelFor(invitation) {
  const raw = typeof invitation === 'string' ? invitation : invitation?.channel ?? invitation?.type ?? '';
  const value = normalizedKey(raw);
  if (value.includes('email')) return 'email';
  if (value.includes('whatsapp')) return 'whatsapp';
  if (value.includes('referral')) return 'referral';
  if (value.includes('dm') || value.includes('message')) return 'linkedin-dm';
  return 'linkedin-post';
}

/** Build an evidence-only shape matching v5 Outreach/Referrals identity fields. */
export function buildAssociatedPersonHandoff({ post, applicationLead = null } = {}) {
  if (!post?.authorName) return null;
  const channel = channelFor(post.contactInvitation);
  const applicationUrl = canonicalizeUrl(applicationLead?.originalApplicationUrl ?? applicationLead?.applicationUrl);
  const applicationIdentity = applicationUrl ? `application:${applicationUrl}` : `post:${canonicalizeUrl(post.postUrl)}`;
  const personIdentity = post.authorProfileUrl
    ? `person-url:${canonicalizeUrl(post.authorProfileUrl)}`
    : `person-name:${normalizedKey(post.authorName)}|company:${normalizedKey(applicationLead?.company ?? post.company)}`;
  return {
    application: applicationIdentity,
    applicationKey: applicationIdentity,
    applicationUrl,
    person: post.authorName,
    personName: post.authorName,
    personUrl: post.authorProfileUrl,
    authorRelationship: post.authorRelationship,
    company: applicationLead?.company ?? post.company,
    role: applicationLead?.title ?? post.title,
    channel,
    contactUrl: post.authorProfileUrl,
    contactInvitation: post.contactInvitation,
    contactEvidence: post.contactInvitationEvidence,
    evidenceUrl: post.postUrl,
    evidence: post.contactInvitationEvidence,
    preview: post.contactInvitationEvidence,
    source: 'linkedin-rescue',
    status: 'Evidence Only',
    sent: false,
    sendAllowed: false,
    duplicateKey: `${applicationIdentity}|${personIdentity}|${channel}`,
    postEvidence: post,
    provenance: { postUrls: [post.postUrl], queries: post.query ? [post.query] : [] },
  };
}
