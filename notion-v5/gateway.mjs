import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLiveManifest, isLegacyNotionId, isNotionIdentifier, isPlaceholderIdentifier, loadManifest, normalizeNotionId, targetFor } from './manifest.mjs';
import { assertValidViewDefinitions, buildDatabaseProperties, mapProperties, readPropertyValue, storeKeyForTarget, V5_SCHEMA, V5_STORE_KEYS } from './schema.mjs';
import { createTransactionJournal, redactSensitive, runDurableTransaction, runReservedBatch, structuredError } from './transaction.mjs';

export const NOTION_V5_API_VERSION = '2025-09-03';
export const NOTION_V5_API_BASE = 'https://api.notion.com/v1';
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class NotionV5Error extends Error {
  constructor(message, { code = 'NOTION_V5_ERROR', status = null, stage = 'gateway', target = null, details = null, retryable = false, redactionSecrets = [] } = {}) {
    const secrets = redactionSecrets.filter(Boolean).map(String);
    super(redactSensitive(message, secrets));
    this.name = 'NotionV5Error';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.target = target;
    this.details = redactSensitive(details, secrets);
    this.retryable = retryable;
    this.redactionSecrets = secrets;
  }
}

function retryAfterMs(headers, now = Date.now()) {
  const value = headers?.get?.('retry-after') ?? headers?.get?.('Retry-After') ?? null;
  if (value == null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function responseHeaders(response) { return response?.headers ?? new Map(); }
function responseBody(_response, text) { try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; } }
function nonEmpty(value, fallback = null) { const text = String(value ?? '').trim(); return text || fallback; }
function pageId(page) { return page?.id ?? page?.results?.[0]?.id ?? null; }
function notionId(value) { return isNotionIdentifier(value) ? normalizeNotionId(value) : null; }

export function loadExternalCredential(filePath) {
  if (!filePath || !String(filePath).trim()) throw new NotionV5Error('an external credential file path is required', { code: 'CREDENTIAL_FILE_REQUIRED', stage: 'preflight' });
  const resolved = path.resolve(String(filePath));
  if (resolved === REPOSITORY_ROOT || resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) throw new NotionV5Error('credential file must be outside the repository', { code: 'CREDENTIAL_LOCATION_INVALID', stage: 'preflight' });
  let stats;
  try {
    const canonical = realpathSync(resolved);
    if (canonical === REPOSITORY_ROOT || canonical.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) throw new NotionV5Error('credential file must be outside the repository', { code: 'CREDENTIAL_LOCATION_INVALID', stage: 'preflight' });
    stats = statSync(canonical);
  } catch (error) {
    if (error instanceof NotionV5Error) throw error;
    throw new NotionV5Error('unable to load external credential file', { code: 'CREDENTIAL_LOAD_FAILED', stage: 'preflight' });
  }
  if (!stats.isFile()) throw new NotionV5Error('external credential path must be a regular file', { code: 'CREDENTIAL_FILE_INVALID', stage: 'preflight' });
  if ((stats.mode & 0o077) !== 0) throw new NotionV5Error('external credential file must not be group/world readable', { code: 'CREDENTIAL_PERMISSIONS_INVALID', stage: 'preflight' });
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new NotionV5Error('external credential file must be owned by the current user', { code: 'CREDENTIAL_OWNER_INVALID', stage: 'preflight' });
  try {
    const credential = readFileSync(resolved, 'utf8').trim();
    if (!credential) throw new Error('empty');
    return credential;
  } catch { throw new NotionV5Error('unable to load external credential file', { code: 'CREDENTIAL_LOAD_FAILED', stage: 'preflight' }); }
}

function textValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function canonicalDomain(value) {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').replace(/\.$/, ''); }
}

function applicationValues(application = {}) {
  const role = application.role ?? application.Role;
  const company = application.companyName ?? application.Company;
  const status = application.status ?? application.Status;
  return {
    name: application.name ?? application.Name ?? [role, company].filter(Boolean).join(' — '), role,
    jdLink: application.jdLink ?? application['JD Link'], originalApplicationUrl: application.originalApplicationUrl ?? application['Original Application URL'],
    applicationResolution: application.applicationResolution ?? application['Application Resolution'], applicationReady: application.applicationReady ?? application['Application Ready'],
    postedDate: application.postedDate ?? application['Posted Date'] ?? application['Posted At'], discoveredAt: application.discoveredAt ?? application['Discovered At'], crawledAt: application.crawledAt ?? application['Crawled At'],
    freshnessTier: application.freshnessTier ?? application['Freshness Tier'] ?? application['Freshness Window'], status: status === 'Discovered' ? 'Ready' : status,
    makeResume: application.makeResume ?? application['Make Resume'] ?? false, applied: application.applied ?? application['Applied?'] ?? false, appliedAt: application.appliedAt ?? application['Applied At'],
    resumeState: application.resumeState ?? application['Resume State'] ?? application['Resume Status'], outreachState: application.outreachState ?? application['Outreach State'], nextAction: application.nextAction ?? application['Next Action'],
    employmentCategory: application.employmentCategory ?? application['Employment Category'] ?? application['Employment Type'], selectionTier: application.selectionTier ?? application['Selection Tier'], relaxation: application.relaxation ?? application.Relaxation ?? application.Relaxations,
    roleFamily: application.roleFamily ?? application['Role Family'], companyStage: application.companyStage ?? application['Company Stage'], workMode: application.workMode ?? application['Work Mode'], location: application.location ?? application.Location,
    matchScore: application.matchScore ?? application['Match Score'], conversionScore: application.conversionScore ?? application['Conversion Score'], responseLikelihood: application.responseLikelihood ?? application['Response Likelihood'],
    source: application.source ?? application.Source, provider: application.provider ?? application.Provider ?? application['Source Provider'], sourceJobId: application.sourceJobId ?? application['Source Job ID'] ?? application['Job ID'],
    originalApplicationEvidence: application.originalApplicationEvidence ?? application['Original Application Evidence'] ?? application['Application Resolution Evidence'], liveness: application.liveness ?? application.Liveness,
    requirementsEvidence: application.requirementsEvidence ?? application['Requirements Evidence'] ?? ([application['JD Text'], application['Experience Asked'], application['Eligibility Evidence']].filter(Boolean).map(textValue).join('\n') || null),
    relaxationEvidence: application.relaxationEvidence ?? application['Relaxation Evidence'], rationale: application.rationale ?? application.Rationale, hook: application.hook ?? application.Hook,
    runId: application.runId ?? application['Run ID'], dedupKey: application.dedupKey ?? application['Dedup Key'], syncKey: application.syncKey ?? application['Sync Key'],
    stipendAmount: application.stipendAmount ?? application['Stipend Amount'], stipendCurrency: application.stipendCurrency ?? application['Stipend Currency'],
    stipendPeriod: application.stipendPeriod ?? application['Stipend Period'], stipendMonthlyAmount: application.stipendMonthlyAmount ?? application['Stipend Monthly Amount'],
    stipendRaw: application.stipendRaw ?? application['Stipend Raw'], stipendEvidence: application.stipendEvidence ?? application['Stipend Evidence'],
    stipendTier: application.stipendTier ?? application['Stipend Tier'], freshness: application.freshness ?? application.Freshness, readiness: application.readiness ?? application.Readiness,
  };
}

export class NotionV5Gateway {
  constructor({ manifest = loadManifest(), token = null, credentialFile = null, live = false, provisioning = false, authorizedParentId = null, testOnly = false, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), apiBase = NOTION_V5_API_BASE, maxRetries = 3, maxPages = 100, retryDelayCapMs = 30000, journalPath = null, journal = null } = {}) {
    this.manifest = manifest;
    this.live = Boolean(live);
    this.testOnly = Boolean(testOnly);
    if (this.live && token && !this.testOnly) throw new NotionV5Error('direct token injection is test-only; use an external credential file', { code: 'DIRECT_TOKEN_FORBIDDEN', stage: 'preflight' });
    this.token = this.live ? (this.testOnly ? token : credentialFile ? loadExternalCredential(credentialFile) : null) : null;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.maxRetries = maxRetries;
    this.maxPages = maxPages;
    this.retryDelayCapMs = retryDelayCapMs;
    this.journalPath = journalPath;
    this.journal = journal ?? (this.live && journalPath ? createTransactionJournal({ journalPath }) : null);
    this.activeJournal = null;
    this.activeTransactionKey = null;
    this.provisioning = Boolean(provisioning);
    this.authorizedParentId = authorizedParentId;
    this.runtimeIds = new Map();
    assertValidViewDefinitions();
    if (this.live) {
      if (!this.fetchImpl) throw new NotionV5Error('live gateway requires a transport', { code: 'FETCH_REQUIRED', stage: 'preflight' });
      if (!nonEmpty(this.token)) throw new NotionV5Error('live gateway requires an external credential provider', { code: 'CREDENTIAL_REQUIRED', stage: 'preflight' });
      if (this.provisioning) {
        if (!notionId(this.authorizedParentId ?? this.manifest.parent?.id) || isLegacyNotionId(this.authorizedParentId ?? this.manifest.parent?.id)) throw new NotionV5Error('provisioning requires a real authorized v5 parent page id', { code: 'PARENT_REQUIRED', stage: 'preflight' });
      } else assertLiveManifest(this.manifest);
    }
  }

  registerRuntimeId(id, kind) {
    if (!notionId(id)) throw new NotionV5Error(`${kind} identifier is invalid`, { code: 'INVALID_ID', stage: 'scope', target: kind });
    if (isLegacyNotionId(id)) throw new NotionV5Error(`${kind} identifier is an audited legacy object`, { code: 'LEGACY_ID_REFUSED', stage: 'scope', target: kind });
    this.runtimeIds.set(notionId(id), { id, kind });
    return id;
  }

  #manifestContains(id, kind) {
    const normalized = notionId(id);
    if (!normalized) return false;
    if (kind === 'parent' || kind === 'page') if (notionId(this.manifest.parent?.id) === normalized) return true;
    for (const key of V5_STORE_KEYS) {
      const target = this.manifest.targets?.[key];
      if (kind === 'database' && notionId(target?.databaseId) === normalized) return true;
      if (kind === 'data_source' && notionId(target?.dataSourceId) === normalized) return true;
    }
    return false;
  }

  assertScopedId(id, kind, { allowRuntime = true } = {}) {
    if (!notionId(id)) throw new NotionV5Error(`${kind} identifier is invalid`, { code: 'INVALID_ID', stage: 'scope', target: kind });
    if (isLegacyNotionId(id)) throw new NotionV5Error(`${kind} identifier is an audited legacy object`, { code: 'LEGACY_ID_REFUSED', stage: 'scope', target: kind });
    const runtime = allowRuntime ? this.runtimeIds.get(notionId(id)) : null;
    if (!this.#manifestContains(id, kind) && !runtime) throw new NotionV5Error(`${kind} identifier is unknown or undeclared`, { code: 'UNKNOWN_ID_REFUSED', stage: 'scope', target: kind });
    if (runtime && runtime.kind !== kind && !(kind === 'page' && runtime.kind === 'page')) throw new NotionV5Error(`${kind} identifier is registered under another object type`, { code: 'ID_TYPE_MISMATCH', stage: 'scope', target: kind });
    return id;
  }

  assertProvisionParent(id) {
    if (!notionId(id) || isLegacyNotionId(id) || notionId(id) !== notionId(this.authorizedParentId ?? this.manifest.parent?.id)) throw new NotionV5Error('provisioning parent is not the authorized v5 parent', { code: 'PARENT_SCOPE_REFUSED', stage: 'scope' });
  }

  assertWriteJournal() {
    if (!this.live) return null;
    if (!this.activeJournal && !this.journal) throw new NotionV5Error('live write requires an explicit external journal path', { code: 'JOURNAL_PATH_REQUIRED', stage: 'preflight' });
    return this.activeJournal ?? this.journal;
  }

  assertWriteReservation() {
    const journal = this.assertWriteJournal();
    if (this.live && (!this.activeTransactionKey || journal?.get(this.activeTransactionKey)?.state !== 'pending')) throw new NotionV5Error('live page writes require a durable reservation before the remote call', { code: 'JOURNAL_RESERVATION_REQUIRED', stage: 'preflight' });
    return journal;
  }

  planWrites({ operations = [] } = {}) {
    if (!Array.isArray(operations)) throw new NotionV5Error('planned operations must be an array', { code: 'INVALID_PLAN', stage: 'plan' });
    for (const operation of operations) {
      if (operation?.resource !== 'application' || operation?.operation !== 'create') throw new NotionV5Error('only application create operations are supported', { code: 'INVALID_PLAN', stage: 'plan' });
      if (operation.payload) mapProperties('applications', applicationValues(operation.payload));
    }
    return { status: 'planned', live: this.live, operations };
  }

  #validatePathScope(requestPath) {
    const parts = requestPath.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    if (parts[0] === 'pages' && parts[1]) this.assertScopedId(parts[1], 'page');
    if (parts[0] === 'blocks' && parts[1]) this.assertScopedId(parts[1], 'page');
    if (parts[0] === 'databases' && parts[1]) this.assertScopedId(parts[1], 'database');
    if (parts[0] === 'data_sources' && parts[1]) this.assertScopedId(parts[1], 'data_source');
  }

  #validateRequestBodyScope(requestPath, body) {
    if (!body || typeof body !== 'object') return;
    const parent = body.parent;
    if (parent?.database_id) throw new NotionV5Error('database_id page parents are unsupported under the pinned data-source API model', { code: 'API_MODEL_MISMATCH', stage: 'scope' });
    if (parent?.data_source_id) this.assertScopedId(parent.data_source_id, 'data_source');
    if (parent?.page_id) this.provisioning ? this.assertProvisionParent(parent.page_id) : this.assertScopedId(parent.page_id, 'parent');
    const relationIds = [];
    for (const property of Object.values(body.properties ?? {})) {
      if (property?.relation?.data_source_id) relationIds.push({ id: property.relation.data_source_id, kind: 'data_source' });
      for (const relation of property?.relation ?? []) relationIds.push({ id: relation.id, kind: 'page' });
    }
    for (const { id, kind } of relationIds) this.assertScopedId(id, kind);
  }

  async request(requestPath, { method = 'GET', body = undefined, target = null, stage = 'http' } = {}) {
    if (!this.live) throw new NotionV5Error('live Notion access is disabled; pass live: true explicitly', { code: 'LIVE_OPT_IN_REQUIRED', stage });
    this.#validatePathScope(requestPath);
    this.#validateRequestBodyScope(requestPath, body);
    const url = `${this.apiBase}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url, { method, headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_V5_API_VERSION, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch (error) {
        if (attempt < this.maxRetries) { await this.sleep(Math.min(this.retryDelayCapMs, 100 * (attempt + 1))); continue; }
        throw new NotionV5Error(`Notion request failed: ${error.message}`, { code: 'NETWORK_ERROR', stage, target, retryable: true, redactionSecrets: [this.token] });
      }
      const text = await response.text();
      if (response.ok) return responseBody(response, text);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const delay = Math.min(this.retryDelayCapMs, retryAfterMs(responseHeaders(response)) || 100 * (attempt + 1));
        await this.sleep(delay);
        continue;
      }
      const parsed = responseBody(response, text);
      throw new NotionV5Error(parsed.message || `Notion request returned HTTP ${response.status}`, { code: `HTTP_${response.status}`, status: response.status, stage, target, details: parsed, retryable, redactionSecrets: [this.token] });
    }
    throw new NotionV5Error('Notion request retry budget exhausted', { code: 'RETRY_EXHAUSTED', stage, target, retryable: true });
  }

  async listRows(target, { filter = undefined, sorts = undefined, pageSize = 100 } = {}) {
    const resolved = targetFor(this.manifest, target);
    this.assertScopedId(resolved.dataSourceId, 'data_source', { allowRuntime: false });
    const rows = [];
    let cursor;
    for (let page = 0; page < this.maxPages; page++) {
      const body = { page_size: Math.min(100, Math.max(1, pageSize)), ...(filter ? { filter } : {}), ...(sorts ? { sorts } : {}), ...(cursor ? { start_cursor: cursor } : {}) };
      const response = await this.request(`/data_sources/${encodeURIComponent(resolved.dataSourceId)}/query`, { method: 'POST', body, target: resolved.key, stage: 'query' });
      for (const row of response.results ?? []) if (row.id) this.registerRuntimeId(row.id, 'page');
      rows.push(...(response.results ?? []));
      if (!response.has_more) return rows;
      cursor = response.next_cursor;
      if (!cursor) throw new NotionV5Error('Notion pagination response omitted next_cursor', { code: 'PAGINATION_INVALID', stage: 'query', target: resolved.key });
    }
    throw new NotionV5Error(`pagination exceeded ${this.maxPages} pages`, { code: 'PAGINATION_LIMIT', stage: 'query', target: resolved.key });
  }

  #validatePageRelationValues(storeKey, values) {
    for (const [key, definition] of Object.entries(V5_SCHEMA.stores[storeKey].properties)) {
      if (definition.type !== 'relation' || values[key] == null) continue;
      for (const id of (Array.isArray(values[key]) ? values[key] : [values[key]])) this.assertScopedId(id, 'page');
    }
  }

  async createPage(target, values, { children = undefined } = {}) {
    const resolved = targetFor(this.manifest, target);
    this.#validatePageRelationValues(resolved.key, values);
    this.assertWriteReservation();
    const body = { parent: { type: 'data_source_id', data_source_id: resolved.dataSourceId }, properties: mapProperties(resolved.key, values), ...(children ? { children } : {}) };
    const page = await this.request('/pages', { method: 'POST', body, target: resolved.key, stage: 'write' });
    if (!pageId(page)) throw new NotionV5Error('Notion create page response omitted id', { code: 'RESPONSE_INVALID', stage: 'write', target: resolved.key });
    this.registerRuntimeId(page.id, 'page');
    return page;
  }

  async updatePage(target, pageId, values) {
    const resolved = targetFor(this.manifest, target);
    this.assertScopedId(pageId, 'page');
    this.#validatePageRelationValues(resolved.key, values);
    const write = async () => {
      this.assertWriteReservation();
      const page = await this.request(`/pages/${encodeURIComponent(pageId)}`, {
        method: 'PATCH',
        body: { properties: mapProperties(resolved.key, values) },
        target: resolved.key,
        stage: 'write',
      });
      if (!page?.id) throw new NotionV5Error('Notion update page response omitted id', { code: 'RESPONSE_INVALID', stage: 'write', target: resolved.key });
      this.registerRuntimeId(page.id, 'page');
      return page;
    };
    if (!this.live || this.activeTransactionKey) return write();

    const journal = this.journal ?? (this.journalPath ? createTransactionJournal({ journalPath: this.journalPath }) : null);
    if (!journal) throw new NotionV5Error('live page update requires an explicit external journal path', { code: 'JOURNAL_PATH_REQUIRED', stage: 'preflight' });
    const key = `page-update:${resolved.key}:${pageId}:${JSON.stringify(values)}`;
    const reservation = journal.reserve([{ key, target: resolved.key }]);
    if (reservation.committedKeys.includes(key)) return { id: pageId, skipped: true };
    if (reservation.pendingKeys.includes(key) || reservation.verifiedKeys.includes(key)) throw new NotionV5Error('page update journal entry requires explicit recovery before retry', { code: 'JOURNAL_RECOVERY_REQUIRED', stage: 'preflight', target: resolved.key });
    this.activeJournal = journal;
    this.activeTransactionKey = key;
    try {
      const page = await write();
      journal.recordTarget(key, page);
      journal.markVerified(key);
      journal.markCommitted(key);
      return page;
    } catch (error) {
      journal.markAborted(key, error);
      throw error;
    } finally {
      this.activeTransactionKey = null;
      this.activeJournal = null;
    }
  }

  async runTransaction({ key, target = 'applications', work } = {}) {
    const durableJournal = this.journal ?? (this.live && this.journalPath ? createTransactionJournal({ journalPath: this.journalPath }) : null);
    if (!durableJournal) throw new NotionV5Error('durable transaction requires an explicit external journal path', { code: 'JOURNAL_PATH_REQUIRED', stage: 'preflight', target });
    return runDurableTransaction({
      journal: durableJournal,
      key,
      target,
      work: async (context) => {
        this.activeJournal = durableJournal;
        this.activeTransactionKey = String(key);
        try { return await work(context); }
        finally {
          this.activeTransactionKey = null;
          this.activeJournal = null;
        }
      },
    });
  }

  async findOrCreateCompany(company = {}) {
    const name = nonEmpty(company.name ?? company.Name ?? company.company ?? company.Company);
    if (!name) throw new NotionV5Error('company name is required', { code: 'COMPANY_REQUIRED', stage: 'company' });
    const domain = canonicalDomain(company.canonicalDomain ?? company['Canonical Domain'] ?? company.domain ?? company.careerPageUrl ?? company['Career Page URL']);
    const filter = domain ? { property: V5_SCHEMA.stores.companies.properties.canonicalDomain.name, rich_text: { equals: domain } } : { property: V5_SCHEMA.stores.companies.properties.name.name, title: { equals: name } };
    const matches = await this.listRows('companies', { filter });
    if (matches.length) {
      const page = [...matches].sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
      return { page, id: page.id, created: false, canonicalDomain: domain };
    }
    const values = { name, canonicalDomain: domain, careerPageUrl: company.careerPageUrl ?? company['Career Page URL'] ?? null, atsProvider: company.atsProvider ?? company['ATS Provider'] ?? null, atsBoardUrl: company.atsBoardUrl ?? company['ATS Board URL'] ?? null, stage: company.stage ?? company.Stage ?? null, remotePolicy: company.remotePolicy ?? company['Remote Policy'] ?? null, verificationState: company.verificationState ?? company['Verification State'] ?? null, companyKey: domain ?? name.toLocaleLowerCase('en-US').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() };
    const page = await this.createPage('companies', values);
    return { page, id: page.id, created: true, canonicalDomain: domain };
  }

  async writeApplication({ application = {}, company = {} } = {}) {
    const companyResult = await this.findOrCreateCompany({ name: company.name ?? company.Name ?? application.Company ?? application.company, ...company });
    this.assertScopedId(companyResult.id, 'page');
    const page = await this.createPage('applications', { ...applicationValues(application), company: [companyResult.id] });
    const verification = await this.verifyRelation({ pageId: page.id, store: 'applications', property: 'company', expectedPageId: companyResult.id });
    return { page, company: companyResult, relationVerified: verification.verified };
  }

  async verifyRelation({ pageId: id, store = 'applications', property = 'company', expectedPageId }) {
    this.assertScopedId(id, 'page');
    this.assertScopedId(expectedPageId, 'page');
    const resolvedProperty = V5_SCHEMA.stores[store]?.properties[property];
    if (!resolvedProperty || resolvedProperty.type !== 'relation') throw new NotionV5Error(`relation property ${store}.${property} is not defined`, { code: 'RELATION_UNDECLARED', stage: 'verify', target: store });
    const page = await this.request(`/pages/${encodeURIComponent(id)}`, { target: store, stage: 'verify' });
    const received = readPropertyValue(page.properties?.[resolvedProperty.name]);
    const verified = received.includes(expectedPageId) || received.map(normalizeNotionId).includes(normalizeNotionId(expectedPageId));
    if (!verified) throw new NotionV5Error(`relation ${resolvedProperty.name} does not contain the expected v5 page`, { code: 'RELATION_VERIFICATION_FAILED', stage: 'verify', target: store, details: { received } });
    return { verified: true, pageId: id, property: resolvedProperty.name, relatedPageId: expectedPageId };
  }

  async appendPageBody(id, blocks) {
    this.assertScopedId(id, 'page');
    this.assertWriteReservation();
    if (!Array.isArray(blocks) || !blocks.length) throw new NotionV5Error('page id and non-empty block array are required', { code: 'INVALID_BODY', stage: 'write' });
    return this.request(`/blocks/${encodeURIComponent(id)}/children`, { method: 'PATCH', body: { children: blocks }, stage: 'write' });
  }

  async writeApplications(operations, transaction = {}) {
    const planned = this.planWrites({ operations });
    const durableJournal = transaction.journal ?? this.journal ?? (this.live ? createTransactionJournal({ journalPath: transaction.journalPath ?? this.journalPath }) : null);
    if (this.live && !durableJournal) throw new NotionV5Error('live write requires an explicit external journal path', { code: 'JOURNAL_PATH_REQUIRED', stage: 'preflight' });
    this.activeJournal = durableJournal;
    try {
      return await runReservedBatch({
        items: planned.operations,
        journal: durableJournal,
        reserve: transaction.reserve ?? (async (items) => ({ reserved: items, committedKeys: [] })),
        write: async (operation) => {
          this.activeTransactionKey = String((transaction.keyOf ?? ((item) => item.dedupKey ?? item.idempotencyKey ?? JSON.stringify(item)))(operation));
          try { return await this.writeApplication({ application: operation.payload ?? operation, company: operation.company ?? {} }); }
          finally { this.activeTransactionKey = null; }
        },
        verify: async (_operation, result) => result.relationVerified === true,
        commit: transaction.commit ?? (async (rows) => rows),
        abort: transaction.abort ?? (async () => {}),
        keyOf: transaction.keyOf,
      });
    } finally { this.activeJournal = null; }
  }

  async createDatabase(storeKey, { parentId, relationIds = {}, includeRelations = false } = {}) {
    storeKeyForTarget(storeKey);
    if (this.provisioning) this.assertProvisionParent(parentId);
    else this.assertScopedId(parentId, 'parent');
    for (const id of Object.values(relationIds)) this.assertScopedId(id, 'data_source');
    this.assertWriteReservation();
    const body = { parent: { type: 'page_id', page_id: parentId }, title: [{ type: 'text', text: { content: V5_SCHEMA.stores[storeKey].name } }], initial_data_source: { properties: buildDatabaseProperties(storeKey, { relationIds, includeRelations }) } };
    const result = await this.request('/databases', { method: 'POST', body, target: storeKey, stage: 'provision' });
    const databaseId = result?.id;
    const dataSourceId = result?.data_sources?.[0]?.id;
    if (!databaseId || !dataSourceId || !isNotionIdentifier(databaseId) || !isNotionIdentifier(dataSourceId)) throw new NotionV5Error('Notion database response omitted a database page id or data-source id', { code: 'RESPONSE_INVALID', stage: 'provision', target: storeKey });
    this.registerRuntimeId(databaseId, 'database');
    this.registerRuntimeId(dataSourceId, 'data_source');
    this.runtimeIds.set(notionId(databaseId), { id: databaseId, kind: 'database', dataSourceId: notionId(dataSourceId) });
    return { ...result, id: databaseId, databaseId, dataSourceId };
  }

  async updateDataSourceRelations(storeKey, dataSourceId, relationIds) {
    storeKeyForTarget(storeKey);
    this.assertScopedId(dataSourceId, 'data_source');
    for (const id of Object.values(relationIds)) this.assertScopedId(id, 'data_source');
    this.assertWriteReservation();
    return this.request(`/data_sources/${encodeURIComponent(dataSourceId)}`, { method: 'PATCH', body: { properties: buildDatabaseProperties(storeKey, { relationIds, onlyRelations: true }) }, target: storeKey, stage: 'provision' });
  }

  async updateDatabaseRelations(storeKey, databaseId, relationIds) {
    this.assertScopedId(databaseId, 'database');
    const runtime = this.runtimeIds.get(notionId(databaseId));
    const dataSourceId = runtime?.dataSourceId ?? [...this.runtimeIds.values()].find((entry) => entry.kind === 'data_source' && entry.databaseId === notionId(databaseId))?.id ?? databaseId;
    return this.updateDataSourceRelations(storeKey, dataSourceId, relationIds);
  }
}

export function createNotionV5Gateway(options = {}) { return new NotionV5Gateway(options); }
export { assertValidViewDefinitions, structuredError };
