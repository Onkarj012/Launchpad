import path from 'node:path';
import { evidenceUrls } from './evidence.mjs';
import { outreachDuplicateKey } from './idempotency.mjs';
import { assertContactApproval } from './review.mjs';
import { runOutreachTransaction } from './transaction.mjs';

export const OUTREACH_DEPTHS = Object.freeze(['deep', 'light']);

export class OutreachDraftError extends Error {
  constructor(message, code = 'OUTREACH_DRAFT_INVALID', details = null) {
    super(message);
    this.name = 'OutreachDraftError';
    this.code = code;
    this.details = details;
  }
}

function text(value) {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  return normalized || null;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '');
}

function words(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function paragraph(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } };
}

function heading(content) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content } }] } };
}

export function assertReadyResume({ application, resumeArtifact, attachmentExpected = false } = {}) {
  if (!attachmentExpected) return null;
  if (application?.resumeState !== 'Ready') throw new OutreachDraftError('an attachment requires the exact application Resume State = Ready', 'RESUME_NOT_READY');
  if (!resumeArtifact || typeof resumeArtifact !== 'object') throw new OutreachDraftError('the exact Ready resume artifact is required when an attachment is expected', 'RESUME_ARTIFACT_REQUIRED');
  if (resumeArtifact.state && resumeArtifact.state !== 'Ready') throw new OutreachDraftError('the attached resume artifact is not Ready', 'RESUME_ARTIFACT_NOT_READY');
  if (resumeArtifact.applicationId !== application.id) throw new OutreachDraftError('resume artifact does not belong to this application', 'RESUME_APPLICATION_MISMATCH');
  if (application.role && normalized(resumeArtifact.role) !== normalized(application.role)) throw new OutreachDraftError('resume artifact role does not match the application', 'RESUME_ROLE_MISMATCH');
  const company = application.companyName ?? application.company;
  if (company && normalized(resumeArtifact.company) !== normalized(company)) throw new OutreachDraftError('resume artifact company does not match the application', 'RESUME_COMPANY_MISMATCH');
  if (!resumeArtifact.pdfPath || path.extname(resumeArtifact.pdfPath).toLocaleLowerCase() !== '.pdf') throw new OutreachDraftError('a Ready resume artifact must point to a PDF', 'RESUME_PDF_REQUIRED');
  return resumeArtifact;
}

function subjectFor(application) {
  const role = text(application.role ?? application.Role) ?? 'the engineering role';
  const differentiator = text(application.outreachSubjectHook ?? application.hook ?? application.Hook) ?? 'relevant AI systems experience';
  return `${role} | ${differentiator.replace(/[.!?]+$/u, '')}`;
}

function deepBody({ application, contact, attachmentExpected }) {
  const name = contact.name;
  const role = text(application.role ?? application.Role) ?? 'the role';
  const company = text(application.companyName ?? application.company ?? application.Company) ?? 'your company';
  const hook = text(application.outreachHook ?? application.hook ?? application.Hook);
  const proof = text(application.bestProof ?? application.proof ?? application.projectProof);
  if (!hook) throw new OutreachDraftError('deep outreach requires an evidence-backed hook', 'HOOK_REQUIRED');
  if (!proof) throw new OutreachDraftError('deep outreach requires one evidence-backed proof point', 'PROOF_REQUIRED');
  const attachment = attachmentExpected ? ' I have attached the exact role-specific resume for context.' : '';
  return `Hi ${name},

${hook}

${proof}

I am reaching out about the ${role} opportunity at ${company} because the problem is close to the kind of systems I build and can explain in detail. I would value a practical conversation about the team’s priorities and where an early-career engineer could contribute.${attachment}

If you are involved in this search, would you be open to a brief 15-minute conversation? If someone else owns it, a pointer would be appreciated. I am happy to keep the conversation focused on the role and the evidence above.

Thanks,
Onkar Jadhav
onkarj012@gmail.com | github.com/Onkarj012`;
}

function lightBody({ application, contact }) {
  const role = text(application.role ?? application.Role) ?? 'the role';
  const company = text(application.companyName ?? application.company ?? application.Company) ?? 'your company';
  const hook = text(application.outreachHook ?? application.hook ?? application.Hook);
  if (!hook) throw new OutreachDraftError('light outreach requires an evidence-backed hook', 'HOOK_REQUIRED');
  return `Hi ${contact.name}, I’m reaching out about the ${role} role at ${company}. ${hook} Would you be the right person to ask about the search, or could you point me to the relevant contact? Thanks, Onkar`;
}

export function bodyBlocks({ body, contact, application, attachment = null } = {}) {
  const blocks = [heading('Outreach draft'), paragraph(body), heading('Evidence')];
  const links = evidenceUrls(contact);
  if (attachment?.pdfPath) blocks.push(paragraph(`Attachment expected: ${attachment.pdfPath}`));
  if (links.length) blocks.push(...links.map((url) => paragraph(url)));
  blocks.push(paragraph(`Application: ${application.id}`));
  return blocks;
}

export function buildOutreachDraft({ application, contact, approval, depth = 'deep', channel = contact?.recommendedChannel, attachmentExpected = false, resumeArtifact = null, body = null } = {}) {
  if (!application?.id) throw new OutreachDraftError('application id is required', 'APPLICATION_ID_REQUIRED');
  if (!contact?.name) throw new OutreachDraftError('contact is required', 'CONTACT_REQUIRED');
  if (!OUTREACH_DEPTHS.includes(depth)) throw new OutreachDraftError(`unsupported outreach depth: ${depth}`, 'DEPTH_INVALID');
  assertContactApproval({ application, contact, channel, approval });
  const attachment = assertReadyResume({ application, resumeArtifact, attachmentExpected });
  const fullBody = text(body) ?? (depth === 'deep' ? deepBody({ application, contact, attachmentExpected }) : lightBody({ application, contact }));
  if (!fullBody) throw new OutreachDraftError('draft body is required', 'BODY_REQUIRED');
  const company = application.companyName ?? application.company;
  const duplicateKey = outreachDuplicateKey({ applicationId: application.id, person: contact, channel });
  const preview = fullBody.replace(/\s+/gu, ' ').trim().slice(0, 240);
  return Object.freeze({
    applicationId: application.id,
    person: contact.name,
    channel,
    depth,
    subject: subjectFor(application),
    body: fullBody,
    wordCount: words(fullBody),
    preview,
    duplicateKey,
    contactUrl: contact.contactUrl,
    email: contact.email,
    evidenceUrl: evidenceUrls(contact)[0] ?? null,
    attachmentExpected: Boolean(attachmentExpected),
    attachment,
    contactApproval: approval,
    values: {
      name: `${company ?? 'Company'} | ${contact.name} | ${channel}`,
      application: [application.id],
      person: contact.name,
      channel,
      contactUrl: contact.contactUrl,
      preview,
      sent: false,
      duplicateKey,
      evidenceUrl: evidenceUrls(contact)[0] ?? null,
      draftState: 'Draft',
      email: contact.email,
    },
    children: bodyBlocks({ body: fullBody, contact, application, attachment }),
  });
}

function duplicateFilter(key) {
  return { property: 'Duplicate Key', rich_text: { equals: key } };
}

/** Store compact properties plus full body through the injected v5 gateway. */
export async function storeOutreachDraft({ gateway, draft } = {}) {
  if (!gateway || typeof gateway.createPage !== 'function') throw new OutreachDraftError('an injected v5 gateway is required', 'GATEWAY_REQUIRED');
  if (!draft?.duplicateKey) throw new OutreachDraftError('draft duplicate key is required', 'DUPLICATE_KEY_REQUIRED');
  if (typeof gateway.listRows === 'function') {
    const existing = await gateway.listRows('outreach', { filter: duplicateFilter(draft.duplicateKey) });
    if (existing?.length) return { status: 'duplicate', duplicateKey: draft.duplicateKey, page: existing[0], draft };
  }
  const transaction = await runOutreachTransaction({
    gateway,
    key: `outreach-create:${draft.duplicateKey}`,
    target: 'outreach',
    steps: [{
      name: 'create-outreach',
      apply: () => gateway.createPage('outreach', draft.values, { children: draft.children }),
      verify: (page) => Boolean(page?.id ?? page?.pageId),
    }],
  });
  const page = transaction.results[0];
  return { status: 'created', duplicateKey: draft.duplicateKey, page, draft };
}

export const prepareOutreachDraft = buildOutreachDraft;
