import { readPropertyValue, V5_SCHEMA } from '../notion-v5/schema.mjs';

export const V5_APPLICATIONS_TARGET = 'applications';
export const MAKE_RESUME_FILTER = Object.freeze({
  property: V5_SCHEMA.stores.applications.properties.makeResume.name,
  checkbox: { equals: true },
});

export class ResumeQueueError extends Error {
  constructor(message, code = 'RESUME_QUEUE_ERROR') {
    super(message);
    this.name = 'ResumeQueueError';
    this.code = code;
  }
}

function valueFrom(row, key) {
  const definition = V5_SCHEMA.stores.applications.properties[key];
  const names = [key, definition?.name].filter(Boolean);
  for (const name of names) {
    if (row?.properties && Object.prototype.hasOwnProperty.call(row.properties, name)) return readPropertyValue(row.properties[name]);
    if (row && Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return null;
}

function booleanValue(value) {
  return value === true || value === 'true' || value === 'YES' || value === 'Yes';
}

function textValue(value) {
  if (value == null || Array.isArray(value) || typeof value === 'object') return null;
  return String(value).trim() || null;
}

function rejectLegacyTarget(gateway) {
  const version = gateway?.version ?? gateway?.notionVersion ?? gateway?.targetVersion;
  if (version && /(?:^|[^0-9])v[34](?:$|[^0-9])/i.test(String(version))) {
    throw new ResumeQueueError(`refusing legacy ${version} queue target`, 'LEGACY_TARGET_REFUSED');
  }
  if (gateway?.target && /(?:^|[^0-9])v[34](?:$|[^0-9])/i.test(String(gateway.target))) {
    throw new ResumeQueueError(`refusing legacy ${gateway.target} queue target`, 'LEGACY_TARGET_REFUSED');
  }
}

export function applicationFromPage(row) {
  if (!row?.id) throw new ResumeQueueError('v5 application row is missing its page id', 'ROW_ID_REQUIRED');
  const directRole = row.role ?? row.Role ?? null;
  const directCompany = row.companyName ?? row.CompanyName ?? null;
  const name = textValue(valueFrom(row, 'name'));
  const companyPageIds = valueFrom(row, 'company');
  return {
    id: row.id,
    role: textValue(directRole ?? valueFrom(row, 'role')),
    name,
    company: textValue(directCompany ?? name),
    companyName: textValue(directCompany ?? valueFrom(row, 'companyName') ?? valueFrom(row, 'company')),
    companyPageIds: Array.isArray(companyPageIds) ? companyPageIds : [],
    jdLink: textValue(valueFrom(row, 'jdLink')),
    originalApplicationUrl: textValue(valueFrom(row, 'originalApplicationUrl')),
    makeResume: booleanValue(valueFrom(row, 'makeResume')),
    applied: booleanValue(valueFrom(row, 'applied')),
    appliedAt: valueFrom(row, 'appliedAt'),
    status: textValue(valueFrom(row, 'status')),
    resumeState: textValue(valueFrom(row, 'resumeState')) || 'Not Started',
    syncKey: textValue(valueFrom(row, 'syncKey')),
    dedupKey: textValue(valueFrom(row, 'dedupKey')),
    canonicalUrl: textValue(valueFrom(row, 'canonicalUrl')),
    raw: row,
  };
}

export function assertV5ApplicationsGateway(gateway) {
  rejectLegacyTarget(gateway);
  if (!gateway || typeof gateway.listRows !== 'function') throw new ResumeQueueError('a v5 gateway with listRows is required', 'GATEWAY_REQUIRED');
  return gateway;
}

/**
 * Read the user-controlled Make Resume queue through the declared v5
 * Applications data source. The filter is intentionally fixed and is also
 * applied locally so an over-broad fake or connector cannot select a row.
 */
export async function readMakeResumeQueue({ gateway, pageSize = 100 } = {}) {
  assertV5ApplicationsGateway(gateway);
  const rows = await gateway.listRows(V5_APPLICATIONS_TARGET, { filter: MAKE_RESUME_FILTER, pageSize });
  if (!Array.isArray(rows)) throw new ResumeQueueError('v5 queue query returned a non-array result', 'QUEUE_RESULT_INVALID');
  return rows
    .map(applicationFromPage)
    .filter((application) => application.makeResume)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export async function readAppliedQueue({ gateway, pageSize = 100 } = {}) {
  assertV5ApplicationsGateway(gateway);
  const filter = { property: V5_SCHEMA.stores.applications.properties.applied.name, checkbox: { equals: true } };
  const rows = await gateway.listRows(V5_APPLICATIONS_TARGET, { filter, pageSize });
  if (!Array.isArray(rows)) throw new ResumeQueueError('v5 Applied? query returned a non-array result', 'QUEUE_RESULT_INVALID');
  return rows
    .map(applicationFromPage)
    .filter((application) => application.applied)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
