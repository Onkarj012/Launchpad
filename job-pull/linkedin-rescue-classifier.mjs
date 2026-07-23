const HIRING_RE = /\b(hiring|we['’]?re hiring|we are hiring|recruiting|open role|job opening|vacancy|join our team|looking for .* engineer)\b/i;
const JOB_SEEKER_RE = /\b(open to work|open for work|seeking (?:a|my next|new)?\s*(?:role|opportunity|job)|looking for my next|available for hire|hire me)\b/i;
const PROMOTIONAL_RE = /\b(webinar|course|bootcamp|newsletter|ebook|e-book|discount|sale|promo(?:tion)?|book a demo|subscribe|launching soon|product launch)\b/i;
const CONTACT_RE = /\b(dm|direct message|message me|reach out|email me|referrals?|whatsapp)\b/i;

function evidenceFor(post, extra = {}) {
  return {
    postUrl: post.postUrl,
    authorName: post.authorName,
    authorProfileUrl: post.authorProfileUrl,
    authorRelationship: post.authorRelationship,
    timestampEvidence: post.timestampEvidence,
    postedAt: post.postedAt,
    observedAt: post.observedAt,
    rawHiringContext: post.rawHiringContext,
    jobLink: post.jobLink,
    formLink: post.formLink,
    contactInvitationEvidence: post.contactInvitationEvidence,
    ...extra,
  };
}

function report(post, code, detail = null) {
  const category = code.startsWith('PROMOTIONAL') ? 'promotional'
    : code.startsWith('JOB_SEEKER') ? 'job-seeker'
      : code.startsWith('STALE') ? 'stale'
        : code.startsWith('UNRESOLVED') || code.startsWith('ORIGINAL_APPLICATION') ? 'unresolved'
          : code.startsWith('AMBIGUOUS') || code.startsWith('TIMESTAMP') || code.startsWith('CONTACT') ? 'ambiguous-or-unverified'
            : 'reported';
  return { code, category, evidence: evidenceFor(post, detail ? { detail } : {}) };
}

export function classifyLinkedInRescuePost(post, { now, cutoffHours = 168 } = {}) {
  const reports = [];
  const raw = post.rawHiringContext || '';
  const isJobSeeker = JOB_SEEKER_RE.test(raw);
  const isPromotional = PROMOTIONAL_RE.test(raw) && !HIRING_RE.test(raw);
  const isHiring = HIRING_RE.test(raw) && !isJobSeeker;
  if (isJobSeeker) reports.push(report(post, 'JOB_SEEKER_POST'));
  if (isPromotional) reports.push(report(post, 'PROMOTIONAL_POST'));
  if (!isHiring && !isJobSeeker && !isPromotional) reports.push(report(post, 'AMBIGUOUS_UNVERIFIED_POST'));

  let ageHours = null;
  if (post.postedAt && now) ageHours = (Date.parse(now) - Date.parse(post.postedAt)) / 3_600_000;
  if (!post.postedAt) reports.push(report(post, 'TIMESTAMP_UNVERIFIED'));
  else if (!Number.isFinite(ageHours) || ageHours < 0) reports.push(report(post, 'TIMESTAMP_UNVERIFIED', { ageHours }));
  else if (ageHours > cutoffHours) reports.push(report(post, 'STALE_POST', { ageHours, cutoffHours }));

  const hasApplicationEvidence = Boolean(post.jobLink || post.formLink || post.originalApplicationResolution);
  if (isHiring && !post.jobLink && !post.formLink) reports.push(report(post, 'UNRESOLVED_POST_ONLY_LEAD'));
  if (isHiring && post.jobLink && !post.originalApplicationResolution) reports.push(report(post, 'ORIGINAL_APPLICATION_UNRESOLVED'));
  if (!post.company || !post.title || !post.location) reports.push(report(post, 'AMBIGUOUS_UNVERIFIED_ROLE', { missing: ['company', 'title', 'location'].filter((field) => !post[field]) }));
  if (post.contactInvitation && !CONTACT_RE.test(typeof post.contactInvitation === 'string' ? post.contactInvitation : JSON.stringify(post.contactInvitation))) {
    reports.push(report(post, 'CONTACT_CHANNEL_UNVERIFIED'));
  }
  return {
    isHiring,
    isJobSeeker,
    isPromotional,
    hasApplicationEvidence,
    ageHours,
    reports,
    codes: reports.map((item) => item.code),
    actionable: isHiring && !isJobSeeker && !isPromotional,
  };
}
