import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeIdentity } from './idempotency.mjs';

export class GmailOutreachError extends Error {
  constructor(message, code = 'GMAIL_OUTREACH_INVALID', details = null) {
    super(message);
    this.name = 'GmailOutreachError';
    this.code = code;
    this.details = details;
  }
}

function requiredText(value, message, code) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) throw new GmailOutreachError(message, code);
  return text;
}

function validEmail(value) {
  const email = requiredText(value, 'a recipient email is required', 'RECIPIENT_EMAIL_REQUIRED').toLocaleLowerCase('en-US');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GmailOutreachError('recipient email is invalid', 'RECIPIENT_EMAIL_INVALID');
  return email;
}

function providerIds(value = {}) {
  const receipt = value.receipt ?? value.binding ?? value;
  const draft = receipt.draft ?? value.draft ?? {};
  const message = receipt.message ?? value.message ?? {};
  return {
    gmailDraftId: receipt.gmailDraftId ?? receipt.draftId ?? draft.id ?? null,
    gmailMessageId: receipt.gmailMessageId ?? receipt.messageId ?? message.id ?? null,
    gmailThreadId: receipt.gmailThreadId ?? receipt.threadId ?? message.threadId ?? null,
  };
}

function bindingFrom(value = {}, fallback = {}) {
  const ids = providerIds(value);
  return Object.freeze({
    outreachId: value.outreachId ?? fallback.outreachId ?? null,
    applicationId: value.applicationId ?? fallback.applicationId ?? null,
    duplicateKey: value.duplicateKey ?? fallback.duplicateKey ?? null,
    idempotencyKey: value.idempotencyKey ?? fallback.idempotencyKey ?? null,
    gmailDraftId: ids.gmailDraftId,
    gmailMessageId: ids.gmailMessageId,
    gmailThreadId: ids.gmailThreadId,
    digest: value.digest ?? fallback.digest ?? null,
  });
}

function assertBinding(binding, { requireDraft = false } = {}) {
  requiredText(binding?.outreachId, 'Outreach ID is required', 'OUTREACH_ID_REQUIRED');
  requiredText(binding?.duplicateKey, 'Outreach duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  requiredText(binding?.idempotencyKey, 'Gmail idempotency key is required', 'IDEMPOTENCY_KEY_REQUIRED');
  if (requireDraft) {
    requiredText(binding?.gmailDraftId, 'Gmail draft ID is required', 'GMAIL_DRAFT_ID_REQUIRED');
    requiredText(binding?.gmailMessageId, 'Gmail message ID is required', 'GMAIL_MESSAGE_ID_REQUIRED');
  }
  requiredText(binding?.gmailThreadId, 'Gmail thread ID is required', 'GMAIL_THREAD_ID_REQUIRED');
  return binding;
}

export function gmailDraftIdempotencyKey({ outreachId, duplicateKey } = {}) {
  const exactOutreachId = requiredText(outreachId, 'Outreach ID is required', 'OUTREACH_ID_REQUIRED');
  const exactDuplicateKey = requiredText(duplicateKey, 'Outreach duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  return `launchpad-v5:gmail-draft:${normalizeIdentity(exactOutreachId)}:${normalizeIdentity(exactDuplicateKey)}`;
}

function metadataFor({ outreachId, duplicateKey, idempotencyKey }) {
  return Object.freeze({
    outreachId,
    duplicateKey,
    idempotencyKey,
    launchpadOutreachId: outreachId,
    launchpadDuplicateKey: duplicateKey,
    launchpadIdempotencyKey: idempotencyKey,
  });
}

async function readAttachment(draft) {
  if (!draft.attachmentExpected) return null;
  const artifact = draft.attachment;
  if (!artifact || artifact.state !== 'Ready' || artifact.applicationId !== draft.applicationId || !artifact.pdfPath) {
    throw new GmailOutreachError('attachmentExpected requires the exact Ready resume artifact bound to the draft', 'ATTACHMENT_ARTIFACT_REQUIRED');
  }
  if (path.extname(artifact.pdfPath).toLocaleLowerCase() !== '.pdf') {
    throw new GmailOutreachError('the bound resume artifact must be a PDF', 'ATTACHMENT_PDF_REQUIRED');
  }
  const file = await stat(artifact.pdfPath);
  if (!file.isFile()) throw new GmailOutreachError('the bound resume artifact must be a regular file', 'ATTACHMENT_FILE_REQUIRED');
  const bytes = await readFile(artifact.pdfPath);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return Object.freeze({
    filename: path.basename(artifact.pdfPath),
    mimeType: 'application/pdf',
    digest,
    bytes,
  });
}

/** Create or replay one Gmail draft through injected, draft-only transport functions. */
export async function createGmailDraft({ transport, outreachId, draft } = {}) {
  if (!transport || typeof transport.lookupDraftByIdempotencyKey !== 'function' || typeof transport.createDraft !== 'function') {
    throw new GmailOutreachError('injected Gmail lookup and draft transport functions are required', 'TRANSPORT_REQUIRED');
  }
  const exactOutreachId = requiredText(outreachId, 'Outreach ID is required', 'OUTREACH_ID_REQUIRED');
  const applicationId = requiredText(draft?.applicationId, 'prepared Outreach application ID is required', 'APPLICATION_ID_REQUIRED');
  const duplicateKey = requiredText(draft?.duplicateKey, 'prepared Outreach duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  const to = validEmail(draft?.email);
  const subject = requiredText(draft?.subject, 'prepared Outreach subject is required', 'SUBJECT_REQUIRED');
  const body = requiredText(draft?.body, 'prepared Outreach body is required', 'BODY_REQUIRED');
  const idempotencyKey = gmailDraftIdempotencyKey({ outreachId: exactOutreachId, duplicateKey });
  const metadata = metadataFor({ outreachId: exactOutreachId, duplicateKey, idempotencyKey });
  const existing = await transport.lookupDraftByIdempotencyKey({ idempotencyKey, outreachId: exactOutreachId, duplicateKey });
  if (existing) {
    const binding = assertBinding(bindingFrom(existing, { outreachId: exactOutreachId, applicationId, duplicateKey, idempotencyKey }));
    return { status: 'replay', ...binding };
  }

  const attachment = await readAttachment(draft);
  const request = {
    outreachId: exactOutreachId,
    applicationId,
    duplicateKey,
    idempotencyKey,
    to,
    subject,
    body,
    metadata,
    headers: {
      'X-Launchpad-Outreach-Id': exactOutreachId,
      'X-Launchpad-Duplicate-Key': duplicateKey,
      'X-Launchpad-Idempotency-Key': idempotencyKey,
    },
  };
  if (attachment) request.attachment = attachment;
  const created = await transport.createDraft(request);
  const binding = assertBinding(bindingFrom(created, { outreachId: exactOutreachId, applicationId, duplicateKey, idempotencyKey }));
  return { status: 'created', ...binding, digest: attachment?.digest ?? null };
}

function messageMetadata(message = {}) {
  const metadata = message.metadata ?? message.providerMetadata ?? message.headers ?? {};
  if (Array.isArray(metadata)) {
    return Object.fromEntries(metadata.map((header) => [String(header.name ?? '').toLocaleLowerCase('en-US'), header.value]));
  }
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key.toLocaleLowerCase('en-US'), value]));
}

function metadataValue(message, names) {
  const metadata = messageMetadata(message);
  for (const name of names) {
    const direct = message[name];
    if (direct != null) return direct;
    const value = metadata[name.toLocaleLowerCase('en-US')];
    if (value != null) return value;
    const header = metadata[`x-launchpad-${name.replace(/[A-Z]/gu, (match) => `-${match.toLocaleLowerCase('en-US')}`)}`];
    if (header != null) return header;
  }
  return null;
}

function isOutbound(message, binding) {
  const labels = new Set((message.labelIds ?? message.labels ?? []).map((label) => String(label).toLocaleLowerCase('en-US')));
  return message.id === binding.gmailMessageId
    || message.gmailDraftId === binding.gmailDraftId
    || message.direction === 'outbound'
    || message.outbound === true
    || message.type === 'draft'
    || labels.has('draft')
    || labels.has('sent');
}

function observedAt(message) {
  const value = message.observedAt ?? message.internalDate ?? message.date ?? message.timestamp;
  if (value == null) throw new GmailOutreachError('inbound Gmail message timestamp is required', 'REPLY_TIMESTAMP_REQUIRED');
  const date = new Date(typeof value === 'number' && value > 1e12 ? value : value);
  if (Number.isNaN(date.getTime())) throw new GmailOutreachError('inbound Gmail message timestamp is invalid', 'REPLY_TIMESTAMP_INVALID');
  return date.toISOString();
}

/** Inspect a bound Gmail thread through read-only list/read transport functions. */
export async function observeGmailReplies({ transport, binding, seenMessageIds = [] } = {}) {
  if (!transport || typeof transport.listMessages !== 'function' || typeof transport.readMessage !== 'function') {
    throw new GmailOutreachError('injected Gmail list and read transport functions are required', 'TRANSPORT_REQUIRED');
  }
  const exactBinding = assertBinding(binding, { requireDraft: true });
  const seen = new Set(seenMessageIds instanceof Set ? seenMessageIds : seenMessageIds);
  const listed = await transport.listMessages({
    threadId: exactBinding.gmailThreadId,
    outreachId: exactBinding.outreachId,
    duplicateKey: exactBinding.duplicateKey,
    idempotencyKey: exactBinding.idempotencyKey,
  });
  const summaries = Array.isArray(listed) ? listed : listed?.messages ?? [];
  const replies = [];
  const dedupedMessageIds = [];
  const inspected = new Set();
  for (const summary of summaries) {
    const messageId = summary?.id ?? summary?.gmailMessageId ?? null;
    if (!messageId || inspected.has(messageId)) continue;
    inspected.add(messageId);
    if (seen.has(messageId)) {
      dedupedMessageIds.push(messageId);
      continue;
    }
    const message = await transport.readMessage({
      messageId,
      threadId: exactBinding.gmailThreadId,
      outreachId: exactBinding.outreachId,
      duplicateKey: exactBinding.duplicateKey,
    });
    if (!message) continue;
    const threadId = message.threadId ?? message.gmailThreadId;
    const outreachId = metadataValue(message, ['outreachId', 'launchpadOutreachId']);
    const duplicateKey = metadataValue(message, ['duplicateKey', 'launchpadDuplicateKey']);
    if (threadId !== exactBinding.gmailThreadId || outreachId !== exactBinding.outreachId || duplicateKey !== exactBinding.duplicateKey) continue;
    if (isOutbound({ ...summary, ...message, id: message.id ?? messageId }, exactBinding)) continue;
    replies.push(Object.freeze({
      outreachId: exactBinding.outreachId,
      applicationId: exactBinding.applicationId ?? null,
      duplicateKey: exactBinding.duplicateKey,
      idempotencyKey: exactBinding.idempotencyKey,
      gmailMessageId: message.id ?? messageId,
      gmailThreadId: threadId,
      observedAt: observedAt(message),
      from: message.from ?? null,
      subject: message.subject ?? null,
      body: message.body ?? message.text ?? null,
    }));
  }
  return { status: replies.length ? 'observed' : 'none', binding: exactBinding, replies, dedupedMessageIds };
}

export function observedReplyActivityKey({ duplicateKey, gmailMessageId } = {}) {
  const exactDuplicateKey = requiredText(duplicateKey, 'Outreach duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  const exactMessageId = requiredText(gmailMessageId, 'Gmail reply message ID is required', 'GMAIL_MESSAGE_ID_REQUIRED');
  return `launchpad-v5:gmail-reply:${exactDuplicateKey}:${exactMessageId}`;
}
