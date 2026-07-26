import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertContactApproval } from './review.mjs';
import { runOutreachTransaction } from './transaction.mjs';

export const OUTREACH_DELIVERY_CAPABILITIES = Object.freeze(['gmail.drafts.create', 'linkedin.copy-text']);

export class GmailDraftError extends Error {
  constructor(message, code = 'GMAIL_DRAFT_INVALID', details = null) {
    super(message);
    this.name = 'GmailDraftError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return normalized || null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value, code) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GmailDraftError('approval date is invalid', code);
  return date.toISOString();
}

function normalizeDigest(value) {
  return text(value)?.replace(/^sha256:/i, '').toLocaleLowerCase('en-US') ?? null;
}

export function approvedMessageDigest({ recipient, subject, body } = {}) {
  if (!text(recipient) || !text(subject) || !text(body)) throw new GmailDraftError('recipient, subject, and body are required for message approval', 'MESSAGE_REQUIRED');
  return sha256(JSON.stringify({ recipient: text(recipient).toLocaleLowerCase('en-US'), subject: text(subject), body: text(body) }));
}

function assertMessageApproval({ draft, approval }) {
  if (approval?.approved !== true) throw new GmailDraftError('Gmail draft creation requires explicit message approval', 'MESSAGE_APPROVAL_REQUIRED');
  if (!text(approval.approvedBy)) throw new GmailDraftError('message approval requires the approving user', 'MESSAGE_APPROVER_REQUIRED');
  iso(approval.approvedAt, 'MESSAGE_APPROVAL_DATE_REQUIRED');
  const expected = approvedMessageDigest({ recipient: draft.email, subject: draft.subject, body: draft.body });
  if (normalizeDigest(approval.messageDigest) !== expected) throw new GmailDraftError('approved message does not match the Gmail draft', 'MESSAGE_DIGEST_MISMATCH');
  return expected;
}

function assertDraftCreator(draftCreator) {
  if (!draftCreator || typeof draftCreator.createDraft !== 'function') throw new GmailDraftError('an injected drafts-only Gmail adapter is required', 'DRAFT_ADAPTER_REQUIRED');
  const capabilities = new Set([
    ...Object.keys(draftCreator),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(draftCreator) ?? {}),
  ].map((key) => key.toLocaleLowerCase('en-US')));
  if ([...capabilities].some((capability) => capability === 'send' || capability.includes('sendmessage') || capability.includes('sendmail'))) {
    throw new GmailDraftError('send-capable Gmail adapters are forbidden in outreach', 'SEND_CAPABILITY_FORBIDDEN');
  }
}

function mimeMessage({ recipient, subject, body, filename, pdf }) {
  const boundary = `launchpad-${sha256(Buffer.concat([Buffer.from(subject), pdf])).slice(0, 24)}`;
  return [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    pdf.toString('base64').replace(/.{1,76}/gu, '$&\r\n').trimEnd(),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export async function createApprovedGmailDraft({
  enabled = false,
  gateway,
  outreach,
  draft,
  messageApproval,
  draftCreator,
  readPdf = readFileSync,
} = {}) {
  if (enabled !== true) throw new GmailDraftError('Gmail draft creation is disabled by default', 'GMAIL_DRAFT_DISABLED');
  if (!outreach?.id) throw new GmailDraftError('stored Outreach row is required', 'OUTREACH_REQUIRED');
  if (!draft?.email) throw new GmailDraftError('an evidence-backed email address is required', 'EMAIL_REQUIRED');
  if (!['Email', 'Public Email'].includes(draft.channel)) throw new GmailDraftError('Gmail drafts require an approved email channel', 'EMAIL_CHANNEL_REQUIRED');
  assertContactApproval({
    application: { id: draft.applicationId },
    contact: { personId: draft.contactApproval?.personId },
    channel: draft.channel,
    approval: draft.contactApproval,
  });
  const messageDigest = assertMessageApproval({ draft, approval: messageApproval });
  assertDraftCreator(draftCreator);
  const artifact = draft.attachment;
  if (!draft.attachmentExpected || !artifact?.pdfPath || artifact.state !== 'Ready') throw new GmailDraftError('the exact verified role-specific PDF is required', 'VERIFIED_PDF_REQUIRED');
  const pdf = readPdf(artifact.pdfPath);
  if (!Buffer.isBuffer(pdf)) throw new GmailDraftError('PDF reader did not return exact bytes', 'PDF_READ_INVALID');
  const attachmentDigest = sha256(pdf);
  const verifiedDigest = normalizeDigest(artifact.digest ?? artifact.sha256);
  if (!verifiedDigest || verifiedDigest !== attachmentDigest) throw new GmailDraftError('PDF bytes do not match the verified resume digest', 'PDF_DIGEST_MISMATCH');
  const raw = Buffer.from(mimeMessage({
    recipient: draft.email,
    subject: draft.subject,
    body: draft.body,
    filename: path.basename(artifact.pdfPath),
    pdf,
  })).toString('base64url');
  const created = await draftCreator.createDraft({ raw });
  const gmailDraftId = text(created?.id ?? created?.draftId);
  if (!gmailDraftId) throw new GmailDraftError('Gmail draft response omitted the draft ID', 'DRAFT_ID_REQUIRED');
  await runOutreachTransaction({
    gateway,
    key: `gmail-draft:${draft.duplicateKey}:${gmailDraftId}`,
    target: 'outreach-gmail-draft',
    steps: [{
      name: 'store-gmail-draft',
      apply: () => gateway.updatePage('outreach', outreach.id, { gmailDraftId, attachmentDigest }),
      rollback: () => gateway.updatePage('outreach', outreach.id, {
        gmailDraftId: outreach.gmailDraftId ?? null,
        attachmentDigest: outreach.attachmentDigest ?? null,
      }),
    }],
  });
  return Object.freeze({ status: 'draft-created', gmailDraftId, attachmentDigest, messageDigest, raw });
}

export function createLinkedInCopyText({ draft } = {}) {
  if (draft?.channel !== 'LinkedIn') throw new GmailDraftError('copy-ready LinkedIn text requires the approved LinkedIn channel', 'LINKEDIN_CHANNEL_REQUIRED');
  if (!text(draft.body)) throw new GmailDraftError('copy-ready LinkedIn text is missing', 'MESSAGE_REQUIRED');
  return Object.freeze({ status: 'copy-ready', text: draft.body });
}
