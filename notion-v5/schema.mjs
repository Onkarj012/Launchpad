export const NOTION_V5_SCHEMA_VERSION = 'LaunchpadV5SchemaV1';

export class NotionV5SchemaError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'NotionV5SchemaError';
    this.code = 'INVALID_SCHEMA';
    this.details = details;
  }
}

const field = (name, type, options = {}) => Object.freeze({ name, type, ...options });
const relation = (name, target, reciprocal) => field(name, 'relation', { target, reciprocal });

export const V5_STORE_KEYS = Object.freeze(['applications', 'companies', 'outreach', 'activity', 'referrals']);

export const V5_STORE_NAMES = Object.freeze({
  applications: 'Applications v5',
  companies: 'Companies v5',
  outreach: 'Outreach v5',
  activity: 'Activity v5',
  referrals: 'Referrals v5',
});

export const V5_SCHEMA = Object.freeze({
  schemaVersion: NOTION_V5_SCHEMA_VERSION,
  stores: Object.freeze({
    applications: Object.freeze({
      name: V5_STORE_NAMES.applications,
      properties: Object.freeze({
        name: field('Name', 'title'), role: field('Role', 'rich_text'), company: relation('Company', 'companies', 'Applications'),
        outreach: relation('Outreach', 'outreach', 'Application'), activity: relation('Activity', 'activity', 'Application'), referrals: relation('Referrals', 'referrals', 'Application'),
        jdLink: field('JD Link', 'url'), originalApplicationUrl: field('Original Application URL', 'url'),
        applicationResolution: field('Application Resolution', 'select', { options: ['Direct ATS', 'Resolved Original', 'Unresolved'] }),
        applicationReady: field('Application Ready', 'checkbox'), postedDate: field('Posted Date', 'date'),
        discoveredAt: field('Discovered At', 'date'), crawledAt: field('Crawled At', 'date'), freshnessTier: field('Freshness Tier', 'select'),
        status: field('Status', 'select', { options: ['Ready', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not Pursuing', 'Closed/Expired'] }),
        makeResume: field('Make Resume', 'checkbox'), applied: field('Applied?', 'checkbox'),
        appliedAt: field('Applied At', 'date'), resumeState: field('Resume State', 'select', { options: ['Not Started', 'Building', 'Ready', 'Failed', 'Stale'] }),
        outreachState: field('Outreach State', 'select'), nextAction: field('Next Action', 'select'), employmentCategory: field('Employment Category', 'select'),
        selectionTier: field('Selection Tier', 'select', { options: ['Strict', 'Backfill'] }), relaxation: field('Relaxation', 'multi_select'),
        roleFamily: field('Role Family', 'select'), companyStage: field('Company Stage', 'select'), workMode: field('Work Mode', 'select'),
        location: field('Location', 'rich_text'), matchScore: field('Match Score', 'number'), conversionScore: field('Conversion Score', 'number'),
        responseLikelihood: field('Response Likelihood', 'number'), source: field('Source', 'select'), provider: field('Provider', 'select'),
        sourceJobId: field('Source Job ID', 'rich_text'), originalApplicationEvidence: field('Original Application Evidence', 'rich_text'),
        liveness: field('Liveness', 'select'), requirementsEvidence: field('Requirements Evidence', 'rich_text'), relaxationEvidence: field('Relaxation Evidence', 'rich_text'),
        rationale: field('Rationale', 'rich_text'), hook: field('Hook', 'rich_text'), runId: field('Run ID', 'rich_text'), dedupKey: field('Dedup Key', 'rich_text'),
        syncKey: field('Sync Key', 'rich_text'),
        stipendAmount: field('Stipend Amount', 'number'), stipendCurrency: field('Stipend Currency', 'select'),
        stipendPeriod: field('Stipend Period', 'select'), stipendMonthlyAmount: field('Stipend Monthly Amount', 'number'),
        stipendRaw: field('Stipend Raw', 'rich_text'), stipendEvidence: field('Stipend Evidence', 'rich_text'),
        stipendTier: field('Stipend Tier', 'select', { options: ['Preferred', 'Lower-Stipend'] }),
        freshness: field('Freshness', 'rich_text'), readiness: field('Readiness', 'rich_text'),
      }),
    }),
    companies: Object.freeze({
        name: V5_STORE_NAMES.companies,
      properties: Object.freeze({
        name: field('Name', 'title'), applications: relation('Applications', 'applications', 'Company'), canonicalDomain: field('Canonical Domain', 'rich_text'), careerPageUrl: field('Career Page URL', 'url'),
        atsProvider: field('ATS Provider', 'select'), atsBoardUrl: field('ATS Board URL', 'url'), stage: field('Stage', 'select', { options: ['Startup', 'Scale-up', 'Mid-size', 'Enterprise'] }),
        fundingDate: field('Funding Date', 'date'), fundingEvidence: field('Funding Evidence', 'rich_text'), locations: field('Locations', 'multi_select'),
        remotePolicy: field('Remote Policy', 'select'), verificationState: field('Verification State', 'select'), companyKey: field('Company Key', 'rich_text'),
        lastVerified: field('Last Verified', 'date'),
      }),
    }),
    outreach: Object.freeze({
      name: V5_STORE_NAMES.outreach,
      properties: Object.freeze({
        name: field('Name', 'title'), application: relation('Application', 'applications', 'Outreach'), person: field('Person', 'rich_text'),
        channel: field('Channel', 'select'), contactUrl: field('Contact URL', 'url'), preview: field('Preview', 'rich_text'), sent: field('Sent?', 'checkbox'),
        sentAt: field('Sent At', 'date'), response: field('Response', 'select'), outcome: field('Outcome', 'select'), nextEligibleContact: field('Next Eligible Contact', 'date'),
        duplicateKey: field('Duplicate Key', 'rich_text'), evidenceUrl: field('Evidence URL', 'url'), draftState: field('Draft State', 'select'), email: field('Email', 'email'),
      }),
    }),
    activity: Object.freeze({
      name: V5_STORE_NAMES.activity,
      properties: Object.freeze({
        name: field('Name', 'title'), application: relation('Application', 'applications', 'Activity'), eventType: field('Event Type', 'select'), eventAt: field('Event At', 'date'),
        dueAt: field('Due At', 'date'), idempotencyKey: field('Idempotency Key', 'rich_text'), actionState: field('Action State', 'select'), notes: field('Notes', 'rich_text'),
      }),
    }),
    referrals: Object.freeze({
      name: V5_STORE_NAMES.referrals,
      properties: Object.freeze({
        name: field('Name', 'title'), application: relation('Application', 'applications', 'Referrals'), person: field('Person', 'rich_text'), personUrl: field('Person URL', 'url'),
        channel: field('Channel', 'select'), status: field('Status', 'select'), requestedAt: field('Requested At', 'date'), outcome: field('Outcome', 'select'),
        duplicateKey: field('Duplicate Key', 'rich_text'), evidence: field('Evidence', 'rich_text'),
      }),
    }),
  }),
});

// Runtime additions are intentionally separate from the provisioned v5
// manifest contract. The live databases require a separately approved schema
// update before these fields can be used against Notion.
export const V5_RUNTIME_PROPERTIES = Object.freeze({
  outreach: Object.freeze({
    initialSentAt: field('Initial Sent At', 'date'),
  }),
  activity: Object.freeze({
    outreachKey: field('Outreach Key', 'rich_text'),
  }),
});

export const V5_VIEW_DEFINITIONS = Object.freeze([
  { name: 'Ready', store: 'applications', filter: { all: [{ property: 'applicationReady', checkbox: { equals: true } }, { property: 'status', select: { equals: 'Ready' } }] } },
  { name: 'Backfill', store: 'applications', filter: { property: 'selectionTier', select: { equals: 'Backfill' } } },
  { name: 'Internship', store: 'applications', filter: { property: 'employmentCategory', select: { equals: 'Internship' } } },
  { name: 'Startup', store: 'applications', filter: { property: 'companyStage', select: { equals: 'Startup' } } },
  { name: 'Remote', store: 'applications', filter: { property: 'workMode', select: { equals: 'Remote' } } },
  { name: 'Verification', store: 'applications', filter: { property: 'applicationResolution', select: { equals: 'Unresolved' } } },
  { name: 'Resume', store: 'applications', filter: { property: 'makeResume', checkbox: { equals: true } } },
  { name: 'Applied', store: 'applications', filter: { property: 'applied', checkbox: { equals: true } } },
  { name: 'Outreach', store: 'applications', filter: { property: 'outreachState', select: { is_not_empty: true } } },
  { name: 'Follow-up', store: 'applications', filter: { property: 'nextAction', select: { is_not_empty: true } } },
  { name: 'Pipeline', store: 'applications', filter: { property: 'status', select: { is_not_empty: true } } },
  { name: 'Archive', store: 'applications', filter: { or: [{ property: 'status', select: { equals: 'Closed/Expired' } }, { property: 'status', select: { equals: 'Rejected' } }] } },
]);

function getStore(storeKey) {
  if (!V5_STORE_KEYS.includes(storeKey)) throw new NotionV5SchemaError(`unknown v5 store: ${storeKey}`);
  return V5_SCHEMA.stores[storeKey];
}

function resolveProperty(storeKey, key) {
  const store = getStore(storeKey);
  if (store.properties[key]) return [key, store.properties[key]];
  const runtime = V5_RUNTIME_PROPERTIES[storeKey] ?? {};
  if (runtime[key]) return [key, runtime[key]];
  const match = Object.entries({ ...store.properties, ...runtime }).find(([, definition]) => definition.name === key);
  if (match) return match;
  throw new NotionV5SchemaError(`unknown property ${key} for ${store.name}`);
}

function dateValue(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return { start: String(value) };
}

function richTextValue(value) {
  return [{ type: 'text', text: { content: String(value) } }];
}

export function propertyContract(storeKey) {
  return Object.fromEntries(Object.entries(getStore(storeKey).properties).map(([key, definition]) => [key, { name: definition.name, type: definition.type }]));
}

export function expectedPropertyKeys(storeKey) {
  return Object.keys(getStore(storeKey).properties);
}

export function buildDatabaseProperties(storeKey, { relationIds = {}, includeRelations = true, onlyRelations = false } = {}) {
  const store = getStore(storeKey);
  const output = {};
  for (const definition of Object.values(store.properties)) {
    if (onlyRelations && definition.type !== 'relation') continue;
    if (!includeRelations && definition.type === 'relation') continue;
    if (definition.type === 'relation') {
      const targetId = relationIds[definition.target];
      if (!targetId) throw new NotionV5SchemaError(`relation ${storeKey}.${definition.name} requires target ${definition.target}`);
      output[definition.name] = { relation: { data_source_id: targetId, ...(definition.reciprocal ? { dual_property: { synced_property_name: definition.reciprocal } } : { single_property: {} }) } };
    } else if (definition.type === 'title') output[definition.name] = { title: {} };
    else if (definition.type === 'select' || definition.type === 'multi_select') {
      output[definition.name] = { [definition.type]: definition.options?.length ? { options: definition.options.map((name) => ({ name })) } : {} };
    } else output[definition.name] = { [definition.type]: {} };
  }
  return output;
}

function propertyPayload(definition, value) {
  if (value == null) return null;
  if (definition.type === 'title') return { title: richTextValue(value) };
  if (definition.type === 'rich_text') return { rich_text: richTextValue(value) };
  if (definition.type === 'url') return { url: String(value) };
  if (definition.type === 'email') return { email: String(value) };
  if (definition.type === 'checkbox') return { checkbox: Boolean(value) };
  if (definition.type === 'number') return { number: Number(value) };
  if (definition.type === 'date') return { date: dateValue(value) };
  if (definition.type === 'select') return { select: { name: String(value) } };
  if (definition.type === 'multi_select') return { multi_select: (Array.isArray(value) ? value : [value]).map((item) => ({ name: String(item) })) };
  if (definition.type === 'relation') return { relation: (Array.isArray(value) ? value : [value]).map((id) => ({ id: String(id) })) };
  throw new NotionV5SchemaError(`unsupported property type ${definition.type}`);
}

export function mapProperties(storeKey, values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new NotionV5SchemaError('property values must be an object');
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    const [, definition] = resolveProperty(storeKey, key);
    const mapped = propertyPayload(definition, value);
    if (mapped) output[definition.name] = mapped;
  }
  return output;
}

export function readPropertyValue(property) {
  if (!property || typeof property !== 'object') return null;
  const type = property.type;
  const value = property[type];
  if (type === 'title' || type === 'rich_text') return Array.isArray(value) ? value.map((item) => item.plain_text ?? item.text?.content ?? '').join('') : null;
  if (type === 'relation') return Array.isArray(value) ? value.map((item) => item.id).filter(Boolean) : [];
  if (type === 'date') return value?.start ?? null;
  if (type === 'select') return value?.name ?? null;
  if (type === 'multi_select') return Array.isArray(value) ? value.map((item) => item.name) : [];
  return value ?? null;
}

export function validateViewDefinitions(views = V5_VIEW_DEFINITIONS) {
  const errors = [];
  const names = new Set();
  for (const view of views) {
    if (!view || typeof view.name !== 'string' || !view.name.trim()) errors.push('view name is required');
    if (names.has(view.name)) errors.push(`duplicate view ${view.name}`);
    names.add(view.name);
    try { getStore(view.store); } catch (error) { errors.push(error.message); continue; }
    const properties = new Set(expectedPropertyKeys(view.store));
    const walk = (filter) => {
      if (filter?.all || filter?.or) for (const child of [...(filter.all ?? []), ...(filter.or ?? [])]) walk(child);
      else if (!properties.has(filter?.property)) errors.push(`view ${view.name} references unknown property ${filter?.property}`);
    };
    walk(view.filter);
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidViewDefinitions(views = V5_VIEW_DEFINITIONS) {
  const result = validateViewDefinitions(views);
  if (!result.valid) throw new NotionV5SchemaError(result.errors.join('; '), result.errors);
  return views;
}

export function storeKeyForTarget(target) {
  const match = V5_STORE_KEYS.find((key) => key === target || V5_STORE_NAMES[key] === target);
  if (!match) throw new NotionV5SchemaError(`unknown v5 target: ${target}`);
  return match;
}
