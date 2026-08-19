export const OUTREACH_FIXTURE_NOW = '2026-07-23T12:00:00.000Z';

export function application(id, score = 90, overrides = {}) {
  return {
    id,
    role: 'AI Engineer',
    companyName: `Company ${id}`,
    status: 'Ready',
    resumeState: 'Ready',
    conversionScore: score,
    hook: 'Your team is hiring for an AI system that turns a real product problem into a measurable user workflow.',
    bestProof: 'I built Lore Engine, a hybrid-retrieval RAG system, and can explain its retrieval and evaluation trade-offs from implementation experience.',
    ...overrides,
  };
}

export function contact(id, overrides = {}) {
  return {
    personId: id,
    name: `Person ${id}`,
    currentRole: 'Engineering Manager',
    companyRelationship: 'Leads the engineering team hiring for this role',
    contactUrl: `https://www.linkedin.com/in/${id}`,
    publicEvidence: [{ url: `https://example.com/team/${id}`, title: 'Company team page' }],
    recommendedChannel: 'LinkedIn',
    confidence: 'High',
    ...overrides,
  };
}

export function providersFor({ includeEmail = false, failure = false } = {}) {
  const calls = [];
  return {
    calls,
    hiringAuthors: async ({ application: current }) => { calls.push(['hiringAuthors', current.id]); return []; },
    companyTeamPages: async ({ application: current }) => {
      calls.push(['companyTeamPages', current.id]);
      if (failure) throw new Error('optional team-page provider unavailable');
      return [];
    },
    publicProfiles: async ({ application: current }) => {
      calls.push(['publicProfiles', current.id]);
      return [contact(current.id, includeEmail ? { email: `person-${current.id}@example.com`, emailEvidence: 'public company contact page', recommendedChannel: 'Public Email' } : {})];
    },
    apollo: async ({ application: current }) => { calls.push(['apollo', current.id]); throw new Error('Apollo is optional and unavailable'); },
    hunter: async ({ application: current }) => { calls.push(['hunter', current.id]); return []; },
    vibe: async ({ application: current }) => { calls.push(['vibe', current.id]); return []; },
  };
}

function valueFrom(row, key) {
  if (row.values?.[key] !== undefined) return row.values[key];
  const property = row.properties?.[key] ?? row.properties?.[key.replace(/[A-Z]/gu, (match) => ` ${match}`)];
  return property?.rich_text?.[0]?.plain_text ?? property?.title?.[0]?.plain_text ?? property?.select?.name ?? property?.date?.start ?? property?.checkbox ?? null;
}

export function createFakeGateway() {
  const pages = { applications: [], outreach: [], activity: [], companies: [] };
  const calls = [];
  let sequence = 0;
  return {
    pages,
    calls,
    async listRows(target, { filter } = {}) {
      calls.push({ method: 'listRows', target, filter });
      const rows = pages[target] ?? [];
      const expected = filter?.rich_text?.equals ?? filter?.title?.equals ?? null;
      if (!expected) return rows;
      return rows.filter((row) => Object.values(row.values ?? {}).some((value) => value === expected) || Object.values(row.properties ?? {}).some((property) => valueFrom({ properties: { value: property } }, 'value') === expected));
    },
    async createPage(target, values, { children = [] } = {}) {
      const page = { id: `${target}-${++sequence}`, target, values: { ...values }, children, properties: {} };
      pages[target] ??= [];
      pages[target].push(page);
      calls.push({ method: 'createPage', target, values, children });
      return page;
    },
    async updatePage(target, id, values) {
      const page = pages[target]?.find((candidate) => candidate.id === id);
      if (!page) throw new Error(`missing fixture page ${target}/${id}`);
      Object.assign(page.values, values);
      calls.push({ method: 'updatePage', target, id, values });
      return page;
    },
  };
}
