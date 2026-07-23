export const LINKEDIN_RESCUE_SCHEMA_VERSION = 'LinkedInRescuePlanV1';
export const MAX_LINKEDIN_RESCUE_QUERIES = 6;
export const MAX_LINKEDIN_RESCUE_POSTS_PER_QUERY = 25;
export const MAX_LINKEDIN_RESCUE_TOTAL_POSTS = 100;
export const DEFAULT_LINKEDIN_RESCUE_CUTOFF_HOURS = 168;
export const MIN_LINKEDIN_RESCUE_CUTOFF_HOURS = 24;
export const MAX_LINKEDIN_RESCUE_CUTOFF_HOURS = 336;

export const LINKEDIN_RESCUE_QUERY_ALLOWLIST = Object.freeze([
  'hiring "AI/LLM Engineer"',
  'hiring "Agentic AI Engineer"',
  'hiring "ML Engineer"',
  'hiring "Full-Stack AI Engineer"',
  'hiring "Backend Python Engineer"',
  'hiring "New Grad Software Engineer"',
]);

export class LinkedInRescueBoundsError extends Error {
  constructor(message, code = 'LINKEDIN_RESCUE_BOUNDS_INVALID') {
    super(message);
    this.name = 'LinkedInRescueBoundsError';
    this.code = code;
  }
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new LinkedInRescueBoundsError(`${field} must be an ISO timestamp`, 'LINKEDIN_RESCUE_TIMESTAMP_INVALID');
  }
  return value;
}

export function validateLinkedInRescuePlan(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LinkedInRescueBoundsError('rescue plan must be an object');
  }
  const queries = input.queries ?? [...LINKEDIN_RESCUE_QUERY_ALLOWLIST];
  const maxPostsPerQuery = input.maxPostsPerQuery ?? 20;
  const maxTotalPosts = input.maxTotalPosts ?? 60;
  const cutoffHours = input.cutoffHours ?? DEFAULT_LINKEDIN_RESCUE_CUTOFF_HOURS;
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_LINKEDIN_RESCUE_QUERIES) {
    throw new LinkedInRescueBoundsError(`query count must be 1-${MAX_LINKEDIN_RESCUE_QUERIES}`);
  }
  if (new Set(queries).size !== queries.length || queries.some((query) => !LINKEDIN_RESCUE_QUERY_ALLOWLIST.includes(query))) {
    throw new LinkedInRescueBoundsError('queries must be unique and exactly match the allowlist', 'LINKEDIN_RESCUE_QUERY_NOT_ALLOWLISTED');
  }
  if (!Number.isInteger(maxPostsPerQuery) || maxPostsPerQuery < 1 || maxPostsPerQuery > MAX_LINKEDIN_RESCUE_POSTS_PER_QUERY) {
    throw new LinkedInRescueBoundsError(`maxPostsPerQuery must be an integer from 1-${MAX_LINKEDIN_RESCUE_POSTS_PER_QUERY}`);
  }
  if (!Number.isInteger(maxTotalPosts) || maxTotalPosts < 1 || maxTotalPosts > MAX_LINKEDIN_RESCUE_TOTAL_POSTS) {
    throw new LinkedInRescueBoundsError(`maxTotalPosts must be an integer from 1-${MAX_LINKEDIN_RESCUE_TOTAL_POSTS}`);
  }
  if (maxTotalPosts < maxPostsPerQuery) {
    throw new LinkedInRescueBoundsError('maxTotalPosts cannot be lower than maxPostsPerQuery');
  }
  if (!Number.isInteger(cutoffHours) || cutoffHours < MIN_LINKEDIN_RESCUE_CUTOFF_HOURS || cutoffHours > MAX_LINKEDIN_RESCUE_CUTOFF_HOURS) {
    throw new LinkedInRescueBoundsError(`cutoffHours must be an integer from ${MIN_LINKEDIN_RESCUE_CUTOFF_HOURS}-${MAX_LINKEDIN_RESCUE_CUTOFF_HOURS}`);
  }
  const observedAt = iso(input.observedAt ?? new Date().toISOString(), 'observedAt');
  return Object.freeze({
    schemaVersion: LINKEDIN_RESCUE_SCHEMA_VERSION,
    queries: Object.freeze([...queries]),
    maxPostsPerQuery,
    maxTotalPosts,
    cutoffHours,
    observedAt,
  });
}

export function buildLinkedInRescueQueryPlan(options = {}) {
  return validateLinkedInRescuePlan(options);
}

