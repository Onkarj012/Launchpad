import { parseStipend } from './stipend.mjs';
import { integerInRange } from './match-scorer.mjs';
import { createHash } from 'node:crypto';
import { decodeEntities } from '../vendor/career-ops/providers/_html-entities.mjs';

export const CANDIDATE_SCHEMA_VERSION = 'CandidateV1';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMPLOYMENT_TYPES = new Map([
  ['full time', 'full-time'],
  ['full-time', 'full-time'],
  ['fulltime', 'full-time'],
  ['permanent', 'full-time'],
  ['intern', 'internship'],
  ['internship', 'internship'],
  ['paid internship', 'internship'],
  ['part time', 'part-time'],
  ['part-time', 'part-time'],
  ['contract', 'contract'],
  ['contractor', 'contract'],
  ['temporary', 'temporary'],
  ['volunteer', 'volunteer'],
]);

export class CandidateValidationError extends Error {
  constructor(errors) {
    super(`Invalid CandidateV1: ${errors.join('; ')}`);
    this.name = 'CandidateValidationError';
    this.errors = errors;
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function preserveText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function canonicalizeUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|source$|ref$)/i.test(key)) parsed.searchParams.delete(key);
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

function normalizePostedAt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))) return value;
  throw new CandidateValidationError(['postedAt must be a full ISO-8601 timestamp or null']);
}

function normalizeOptionalTimestamp(value, field) {
  if (value == null || value === '') return null;
  try {
    return normalizePostedAt(value);
  } catch {
    throw new CandidateValidationError([`${field} must be a full ISO-8601 timestamp or null`]);
  }
}

export function isIsoTimestamp(value) {
  return value == null || (typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value)));
}

function normalizeWorkMode(value) {
  const text = nonEmptyString(value)?.toLowerCase() || '';
  if (/remote|work from home|distributed|anywhere/.test(text)) return 'remote';
  if (/hybrid/.test(text)) return 'hybrid';
  if (/on[ -]?site|in[ -]?office|office based|office-based/.test(text)) return 'onsite';
  return null;
}

function normalizeEmploymentType(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return EMPLOYMENT_TYPES.get(key) || null;
}

function finiteYears(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Keep the strictest finite minimum when source representations disagree.
function strictestYears(...values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

const HARD_EXPERIENCE_CUE_RE = /\b(?:minimum(?:\s+of)?|at\s+least|must\s+have|require(?:d|s)?|requirements?:|experience:)(?=[^A-Za-z]|$)/i;
const PREFERENCE_RE = /\b(?:preferred|nice\s+to\s+have|bonus|desirable|advantage)\b/i;
const EXPERIENCE_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const EXPERIENCE_VALUE = String.raw`(?:\d+(?:\.\d+)?|(?:${EXPERIENCE_WORDS.join('|')})(?:\s*\(\d+\))?)`;
const EXPERIENCE_UNIT = String.raw`(?:years?|yrs?)(?:\(s\))?(?![A-Za-z])`;
// A match must start at the lower bound, never at the tail of a range.
const EXPERIENCE_NUMBER = String.raw`(?<![\d.])(?<lower>${EXPERIENCE_VALUE})(?:\s*(?<plus>\+)|\s*(?<separator>to|[-–—])\s*(?<upper>${EXPERIENCE_VALUE})(?<upperPlus>\s*\+)?)?`;
const ROLE_EXAMPLES_TAIL = String.raw`\(\s*(?:solutions engineering|forward deployed engineering|implementation engineering|technical consulting|technical pm)(?:\s*,\s*(?:solutions engineering|forward deployed engineering|implementation engineering|technical consulting|technical pm))*(?:\s*,?\s+or similar)?\s*\)`;

// Accept only a complete role qualification or an explicit mandatory ending.
function hasCompleteRoleTenureEnding(match, line) {
  const suffix = line.slice((match.index ?? 0) + match[0].length).trim();
  return /^(?:[.!?]|[.!?]\s*)*$/.test(suffix)
    || /^(?:(?:is|are)\s+)?(?:required|mandatory)[.!?]*$/i.test(suffix)
    || new RegExp(String.raw`^${ROLE_EXAMPLES_TAIL}[.!?]*$`, 'i').test(suffix);
}

// Accept role tenure only when it begins a qualification line or list item.
function isRoleTenureRequirement(match) {
  const prefix = match.input?.slice(0, match.index ?? 0) ?? '';
  return /^\s*(?:(?:[-*•]\s+)?(?:\[\s*[x ]\s*\]\s*)?)?$/i.test(prefix);
}

// Remove emphasis for matching while keeping only real list markers.
function roleTenureMatchLine(line) {
  const prefix = line.match(/^\s*(?:(?:[-*•]\s+)?(?:\[\s*[x ]\s*\]\s*)|(?:[-*•]\s+))?/)?.[0] ?? '';
  return prefix + line.slice(prefix.length).replace(/[*_]{1,3}/g, '');
}

// Normalize a possible section heading before looking at adjacent lines.
function roleTenureSectionHeading(line) {
  return line.replace(/^\s*(?:(?:[-*•]\s*)|(?:\[\s*[x ]\s*\]\s*))?(?:#{1,6}\s*)?/, '').replace(/[*_]{1,3}/g, '').replace(/[-–—]+/g, ' ').trim();
}

// Classify supported qualification headings without reading ordinary bullets as sections.
function roleTenureHeadingType(line) {
  const explicitHeading = /^\s*#{1,6}\s/.test(line);
  const listItem = /^\s*(?:[-*•]\s+|\[\s*[x ]\s*\]\s*)/.test(line);
  const formattedHeading = /^\s*(?:[-*•]\s+)?(?:\*\*[^*]+\*\*|__[^_]+__)\s*:?$/.test(line);
  const original = roleTenureSectionHeading(line);
  const heading = original.replace(/&/g, ' and ').replace(/[():]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^\([^)]*\)$/.test(original)) return null;
  const cue = String.raw`(?:preferred|desired|optional|desirable|bonus|advantage|nice\s+to\s+have|required|minimum|basic|essential)`;
  const subject = String.raw`(?:qualifications?|skills?|experience)`;
  const token = String.raw`(?:${cue}|${subject}|requirements?|and|includes?)`;
  const shape = new RegExp(String.raw`^(?=.*\b(?:${cue})\b)(?:\s*${token}\s*)+$`, 'i');
  const cueOnlyHeading = new RegExp(String.raw`^(?:(?:strongly|highly)\s+)?${cue}$`, 'i');
  const explicitBulletLabel = /:\s*(?:[*_~]{1,3})?\s*$/.test(line);
  if (listItem && !explicitHeading && !explicitBulletLabel && !formattedHeading) return null;
  if (/^requirements?\s*$/i.test(heading)) return 'required';
  if (/^(?:qualifications?|skills?|experience)$/i.test(heading)) return 'neutral';
  const bulletLabel = explicitBulletLabel
    && (/^requirements?$/i.test(heading) || /^(?:qualifications?|skills?|experience)$/i.test(heading));
  const bulletHeading = listItem && (explicitBulletLabel || formattedHeading)
    && (shape.test(heading) || cueOnlyHeading.test(heading) || bulletLabel);
  if (listItem && !explicitHeading && !bulletHeading) return null;
  const headingCue = new RegExp(String.raw`\b(?:optional|preferred|desired|nice\s+to\s+have|desirable|bonus|advantage)\b`, 'i');
  const requiredCue = new RegExp(String.raw`\b(?:required|minimum|basic|essential)\b`, 'i');
  if (shape.test(heading)) return headingCue.test(heading) ? 'preferred' : 'required';
  const hasExplicitLabel = explicitHeading || bulletHeading || /:\s*(?:[*_]{1,3})?\s*$/.test(line) || cueOnlyHeading.test(heading);
  if (!hasExplicitLabel || /\d|[.!?;]/.test(original) || original.split(/\s+/).length > 8) return null;
  if (cueOnlyHeading.test(heading) && headingCue.test(heading)) return 'preferred';
  if (cueOnlyHeading.test(heading) && requiredCue.test(heading)) return 'required';
  return null;
}

// Identify a visible boundary after a role-tenure line.
function isRoleTenureBoundary(line, roleRequirement) {
  if (!line) return true;
  if (roleTenureHeadingType(line)) return true;
  const matchLine = roleTenureMatchLine(line);
  if (/^\s*(?:[-*•]\s+|\[\s*[x ]\s*\]\s*)/.test(matchLine)) return true;
  return [...matchLine.matchAll(roleRequirement)].some(isRoleTenureRequirement)
    || new RegExp(String.raw`^\s*(?:\[\s*[x ]\s*\]\s*)?${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}\b`, 'i').test(matchLine);
}

// Keep a future verb lead open until its quantity arrives or a new item starts.
function isOpenFutureRoleLead(line) {
  return /^(?:(?:you|(?:(?:the|this|your)\s+)?(?:role|position|candidate|applicant|engineer|developer)|candidates?|applicants?|engineers?|developers?)\s+(?:will|would|should|must))\s+(?:be\s+)?(?:spend|spending|work|working)$/i.test(line.trim());
}

// Keep a bachelor-degree alternative open across its paragraph boundary.
function isOpenBachelorDegreeAlternative(line) {
  const bachelorDegree = /\b(?:bachelor(?:['’]s)?|b\.?\s?tech|b\.?\s?e\.?|b\.?\s?s\.?|b\.?\s?sc\.?|undergraduate|graduate\s+degree)\b/i;
  const advancedDegree = /\b(?:master(?:['’]s|s)?|m\.?\s?tech|m\.?\s?s\.?|mba|ph\.?\s?d\.?|doctorate)\b/i;
  return /\bdegree\b[^.!?;]*\bor(?:\s+equivalent)?\s*$/i.test(line.trim())
    && bachelorDegree.test(line)
    && !advancedDegree.test(line);
}

// Ignore a flattened heading match when a future lead still owns its number.
function hasOpenFutureLeadBefore(match, text) {
  const numberStart = (match.index ?? 0) + match[0].lastIndexOf(match.groups?.lower ?? '');
  const context = text.slice(Math.max(0, numberStart - 120), numberStart).trim();
  const lead = context.match(/\b((?:(?:you|(?:(?:the|this|your)\s+)?(?:role|position|candidate|applicant|engineer|developer)|candidates?|applicants?|engineers?|developers?)\s+(?:will|would|should|must))\s+(?:(?:be|have)\s+)?[a-z]+)$/i)?.[1];
  return lead ? isOpenFutureRoleLead(lead) : false;
}

// Convert an experience quantity without changing the retained JD evidence.
function experienceNumber(value) {
  const quantity = value.toLowerCase().replace(/\s*\(\d+\)$/, '');
  const word = EXPERIENCE_WORDS.indexOf(quantity);
  return word >= 0 ? word : Number(quantity);
}

/** Convert provider HTML/encoded text into the plain text used by parsers. */
export function stripHtmlToText(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Preserve requirement boundaries while removing HTML from a job description.
function stripHtmlToRequirementText(value) {
  if (typeof value !== 'string') return '';
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:li|p|div|section|article|h[1-6])\s*>/gi, '\n')
    .replace(/<(?:li|p|div|section|article|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Read bounded section and track headings that apply at one JD offset.
function requirementHeadingContext(text, offset) {
  let preferred = false;
  let track = null;
  for (const line of text.slice(0, offset).split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const headingType = roleTenureHeadingType(value);
    if (headingType === 'preferred') {
      preferred = true;
      track = null;
      continue;
    }
    if (headingType === 'required' || headingType === 'neutral') {
      preferred = false;
      track = null;
      continue;
    }
    const heading = value.match(/^\s*(?:#{1,6}\s*)?(junior|entry[ -]?level|senior|staff|principal)\s+(?:experience\s+)?(?:track|level)\s*:?\s*$/i);
    if (heading) {
      track = heading[1].toLowerCase().replace(/[ -]/g, '-');
      continue;
    }
    if (/\b(?:all\s+candidates|everyone|regardless\s+of\s+level)\b/i.test(value)) track = null;
  }
  return { preferred, track };
}

// Keep applicant requirements and discard education, tenure, and preferences.
function experienceMatch(match, text, textOffset = 0) {
  const groups = match.groups || {};
  const lower = experienceNumber(groups.lower);
  const upper = groups.upper == null || groups.upperPlus ? (groups.plus || groups.upperPlus ? null : lower) : experienceNumber(groups.upper);
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const numberStart = start + match[0].indexOf(groups.lower);
  if (/\d\s*(?:[-–—]|to)\s*$/i.test(text.slice(0, numberStart))) return null;
  const clauseStart = [...text.slice(0, start).matchAll(/(?<!\b(?:B\.E|B\.S|M\.S))\.\s|[!?;\n]/gi)].at(-1)?.index ?? -1;
  const prefix = text.slice(Math.max(clauseStart + 1, numberStart - 180), numberStart);
  const contextClauseStart = [...text.slice(0, numberStart).matchAll(/(?<!\b(?:B\.E|B\.S|M\.S))\.\s|[!?;]/gi)].at(-1)?.index ?? -1;
  const contextPrefix = text.slice(Math.max(contextClauseStart + 1, numberStart - 180), numberStart);
  const headingContext = requirementHeadingContext(text, numberStart);
  const suffix = text.slice(end).replace(/^\.(?=\s)/, '').split(/[.!?;,]/, 1)[0].slice(0, 60);
  const requirementTail = text.slice(numberStart).split(/[.!?;,]/, 1)[0].slice(0, 140);
  if (/\b(?:education(?:al)?|qualification|school(?:ing)?|academic|degree)\b/i.test(match[0].slice(0, match[0].indexOf(groups.lower)))
    || /^\s*(?:of\s+)?(?:(?:full[ -]?time|formal|academic)\s+)*(?:education(?:al)?|schooling|study|studies)\b/i.test(suffix)) return null;
  const bachelorDegree = /\b(?:bachelor(?:['’]s)?|b\.?\s?tech|b\.?\s?e\.?|b\.?\s?s\.?|b\.?\s?sc\.?|undergraduate|graduate\s+degree)\b/i;
  const advancedDegree = /\b(?:master(?:['’]s|s)?|m\.?\s?tech|m\.?\s?s\.?|mba|ph\.?\s?d\.?|doctorate)\b/i;
  const degreeClause = text.slice(contextClauseStart + 1).split(/(?<!\b(?:B\.E|B\.S|M\.S))\.\s|[!?;]/i, 1)[0];
  if (/\bdegree\b[^.!?;]*\bor\s+(?:equivalent\s+)?$/i.test(contextPrefix)
    && bachelorDegree.test(contextPrefix) && !advancedDegree.test(degreeClause)) return null;
  const cue = [...prefix.slice(-80).matchAll(new RegExp(HARD_EXPERIENCE_CUE_RE.source, 'gi'))].at(-1);
  const preference = [...prefix.slice(-80).matchAll(new RegExp(PREFERENCE_RE.source, 'gi'))].at(-1);
  const preferenceSection = [...prefix.matchAll(/\b(?:preferred|optional|desired|nice\s+to\s+have|bonus)\s+(?:qualifications?|requirements?|experience|skills)\b/gi)].at(-1);
  const requiredSection = [...prefix.matchAll(/\b(?:(?:required|minimum|essential)\s+(?:qualifications?|requirements?|experience|skills)|requirements?)\b\s*:?/gi)].at(-1);
  const mandatorySuffix = text.slice(end).split(/[.!?;,\n]/, 1)[0];
  const explicitMandatoryClause = /\b(?:required|must\s+have|mandatory|minimum|at\s+least)\b/i.test(`${prefix} ${mandatorySuffix}`);
  if ((headingContext.preferred && !explicitMandatoryClause)
    || (preferenceSection && (!requiredSection || preferenceSection.index > requiredSection.index) && !explicitMandatoryClause)) return null;
  const afterPreference = /^\s*(?:(?:is|are|would\s+be|will\s+be)\s+)?(?:preferred|desirable|a\s+(?:bonus|plus|nice\s+to\s+have)|an?\s+advantage|nice\s+to\s+have)\b/i.test(suffix);
  const experiencePreference = /\bexperience\b(?:(?!\b(?:required|must|mandatory|and|but)\b)[^.!?;,]){0,60}\b(?:preferred|desirable|bonus|advantage|nice\s+to\s+have)\b/i.test(requirementTail);
  const beforePreference = preference && (!cue || preference.index > cue.index);
  if (afterPreference || experiencePreference || beforePreference) return null;
  if (/\b(?:supported|warrantied)\s+for\s*$/i.test(prefix)) return null;
  // Company tenure is evidence about the employer, not the applicant.
  if (/\b(?:we|company|organisation|organization|corporation|group|business|firm|team)\b[^.!?;]*\b(?:has|have|with|brings?|boasts?|spanning)\b[^.!?;]*$/i.test(contextPrefix)
    && !/\b(?:you|candidate|applicant|engineer|developer|seeking|looking|expect|requires?|requirements?|must\s+have)\b[^.!?;]*$/i.test(contextPrefix)) return null;
  return { minYears: lower, maxYears: upper, evidence: match[0].trim().replace(/\s+/g, ' '), start: textOffset + numberStart, end: textOffset + end };
}

// Collect applicant experience matches while retaining the full JD context.
function collectExperienceYears(text) {
  const cleaned = stripHtmlToRequirementText(text);
  if (!cleaned) return [];
  const matches = [];
  const forward = new RegExp(
    String.raw`(?:minimum(?:\s+of)?|at\s+least|must\s+have|require(?:d|s)?|requirements?:|experience:)(?=[^A-Za-z]|$)[^\d.!?;]{0,40}?\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}`,
    'gi',
  );
  for (const match of cleaned.matchAll(forward)) {
    if (hasOpenFutureLeadBefore(match, cleaned)) continue;
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }

  const reverse = new RegExp(
    String.raw`\b${EXPERIENCE_NUMBER}(?:\s+[A-Za-z][A-Za-z'/-]*){0,4}\s+${EXPERIENCE_UNIT}(?:\s+[A-Za-z][A-Za-z'/-]*){0,4}\s+experience(?:d)?\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(reverse)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }

  const activityRequirement = new RegExp(
    String.raw`\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}(?:\s+of)?(?:\s+(?:professional|hands-on|relevant|industry))?(?:\s+[A-Za-z][A-Za-z+.#/-]*){0,3}\s+(?:experience|development|engineering|building|developing|designing|working|programming|coding|implementing|maintaining)\b`,
    'gi',
  );
  for (const match of cleaned.matchAll(activityRequirement)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }
  const handsOnRequirement = new RegExp(
    String.raw`\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}\s+(?:of\s+)?hands[ -]on\s+(?:experience\s+)?(?:with|using|on)\s+[A-Za-z][A-Za-z0-9+.#/-]*`,
    'gi',
  );
  for (const match of cleaned.matchAll(handsOnRequirement)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }
  const roleTextInput = typeof text === 'string' ? text : '';
  const hasHtml = /<\/?[a-z][^>]*>/i.test(roleTextInput);
  const hasNestedLists = /<(ul|ol)\b[^>]*>(?:(?!<\/?\1\b)[\s\S])*<(?:ul|ol)\b/i.test(roleTextInput);
  const roleText = (hasHtml ? roleTextInput : roleTextInput.replace(/\r?\n[\t ]*\r?\n/g, '\u0001'))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<h[1-6]\b[^>]*>/gi, '\n# ')
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\u0002\n')
    .replace(/<li\b[^>]*>[\s\S]*?<\/li\s*>/gi, (item) => item
      .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, '**$1**')
      .replace(/\u0002/g, ' ')
      .replace(/<\/(?:br|div|p)\b[^>]*>/gi, ' ')
      .replace(/<(?:br|div|p)\b[^>]*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^<li\b[^>]*>/i, '\n- ')
      .replace(/<\/li\s*>$/i, '\u0000\n'))
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/div\s*>\s*<div\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>|<\/li\s*>/gi, '\n')
    .replace(/<\/?(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const roleBlocks = decodeEntities(roleText).replace(/\n(?:[\t ]*\n)+/g, '\n').replace(/\u0001/g, '\n\n');
  const roleRequirement = new RegExp(
    String.raw`^\s*(?:(?:[-*•]\s+)?(?:\[\s*[x ]\s*\]\s*)?)?${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}\s+in\s+(?:(?:a|an|the)\s+)?(?:[A-Za-z][A-Za-z/-]*\s+){0,5}?(?:role|position)\b`,
    'gi',
  );
  let preferredSection = false;
  let qualificationSection = false;
  let roleSearchOffset = 0;
  for (const item of (hasNestedLists ? [] : roleBlocks.split('\u0000'))) {
    const itemLines = item.split(/\r?\n/).map((value) => value.replace(/\s+/g, ' ').trim());
    let priorLineIsBoundary = true;
    for (let lineIndex = 0; lineIndex < itemLines.length; lineIndex += 1) {
      const requirementLine = itemLines[lineIndex];
      if (!requirementLine) {
        priorLineIsBoundary = true;
        continue;
      }
      if (requirementLine === '\u0002') {
        const previousLine = roleTenureMatchLine(itemLines[lineIndex - 1] ?? '');
        if (qualificationSection && !isOpenFutureRoleLead(previousLine) && !isOpenBachelorDegreeAlternative(previousLine)) priorLineIsBoundary = true;
        continue;
      }
      if (/~~[^]*?~~/.test(requirementLine)) continue;
      const headingType = roleTenureHeadingType(requirementLine);
      if (headingType === 'preferred') {
        preferredSection = true;
        qualificationSection = /\b(?:requirements?|qualifications?|skills?|experience)\b/i.test(roleTenureSectionHeading(requirementLine));
        priorLineIsBoundary = true;
        continue;
      }
      if (headingType === 'required') {
        preferredSection = false;
        qualificationSection = /\b(?:requirements?|qualifications?|skills?|experience)\b/i.test(roleTenureSectionHeading(requirementLine));
        priorLineIsBoundary = true;
        continue;
      }
      if (headingType === 'neutral') {
        preferredSection = false;
        qualificationSection = true;
        priorLineIsBoundary = true;
        continue;
      }
      if (/^\s*#{1,6}\s/.test(requirementLine)) qualificationSection = false;
      if (preferredSection) continue;
      const matchLine = roleTenureMatchLine(requirementLine);
      const roleRequirementMatches = [...matchLine.matchAll(roleRequirement)];
      const currentLineIsExplicitItem = /^\s*(?:[-*•]\s+|\[\s*[x ]\s*\]\s*)/.test(matchLine);
      const isStandaloneRequirement = roleRequirementMatches.some(isRoleTenureRequirement);
      const contextProvesNewItem = currentLineIsExplicitItem || priorLineIsBoundary;
      let nextLineIndex = lineIndex + 1;
      while (itemLines[nextLineIndex] === '\u0002') nextLineIndex += 1;
      const nextLine = roleTenureMatchLine(itemLines[nextLineIndex] ?? '');
      const nextLineIsContinuation = /^\s*\([^)]*\)\s*$/.test(nextLine)
        || /^\s*(?:is|are)\s+(?:not\b|(?:(?:strongly|highly)\s+)?(?:optional|preferred|desirable|a\s+(?:bonus|plus)|nice\s+to\s+have|not\s+(?:required|a\s+prerequisite)))/i.test(nextLine);
      const nextLineIsBoundary = !nextLineIsContinuation && isRoleTenureBoundary(nextLine, roleRequirement);
      const isCompleteRequirement = roleRequirementMatches.some((match) => hasCompleteRoleTenureEnding(match, matchLine));
      for (const match of roleRequirementMatches) {
        if (!contextProvesNewItem || !nextLineIsBoundary || !isRoleTenureRequirement(match) || !hasCompleteRoleTenureEnding(match, matchLine)) continue;
        const parsed = experienceMatch(match, matchLine);
        if (parsed) {
          const occurrenceText = match[0].replace(/^\s*[-*•]\s+/, '');
          const occurrenceAt = cleaned.indexOf(occurrenceText, roleSearchOffset);
          if (occurrenceAt >= 0) {
            const numberAt = occurrenceText.indexOf(match.groups?.lower ?? parsed.evidence);
            matches.push({ ...parsed, start: occurrenceAt + numberAt, end: occurrenceAt + occurrenceText.length });
            roleSearchOffset = occurrenceAt + match[0].length;
          } else {
            matches.push({ ...parsed, start: null, end: null });
          }
        }
      }
      priorLineIsBoundary = (isStandaloneRequirement && contextProvesNewItem && nextLineIsBoundary && isCompleteRequirement)
        || (/[.!?]$/.test(matchLine) && !nextLineIsContinuation);
    }
  }
  const requiredYears = new RegExp(String.raw`\b${EXPERIENCE_NUMBER}\s*${EXPERIENCE_UNIT}\s+(?:is\s+)?required\b`, 'gi');
  for (const match of cleaned.matchAll(requiredYears)) {
    const parsed = experienceMatch(match, cleaned);
    if (parsed) matches.push(parsed);
  }
  return matches;
}

// Return the strictest mandatory experience requirement from the full JD.
export function extractExperienceYears(text) {
  const matches = collectExperienceYears(text);
  if (!matches.length) return null;
  return matches.reduce((best, current) => current.minYears > best.minYears ? current : best);
}

// Retain bounded mandatory requirements while preserving full JD context.
export function extractExperienceRequirements(text, sourceEvidence = '') {
  const cleaned = stripHtmlToRequirementText(text);
  const requirements = [];
  const occurrences = new Map();
  let fallbackOffset = 0;
  for (const parsed of collectExperienceYears(text)) {
    const at = Number.isInteger(parsed.start) ? parsed.start : cleaned.indexOf(parsed.evidence, fallbackOffset);
    if (at < 0) continue;
    fallbackOffset = at + parsed.evidence.length;
    const occurrenceKey = `${at}:${parsed.minYears}:${parsed.maxYears}`;
    if (occurrences.has(occurrenceKey)) continue;
    occurrences.set(occurrenceKey, { ...parsed, start: at });
  }
  const parsedOccurrences = [...occurrences.values()].sort((left, right) => left.start - right.start);
  for (const [occurrenceIndex, parsed] of parsedOccurrences.entries()) {
    const at = parsed.start;
    const context = cleaned.slice(Math.max(0, at - 100), Math.min(cleaned.length, at + parsed.evidence.length + 100));
    const clauseStart = Math.max(cleaned.lastIndexOf(';', at), cleaned.lastIndexOf('.', at), cleaned.lastIndexOf('!', at), cleaned.lastIndexOf('?', at), cleaned.lastIndexOf('\n', at)) + 1;
    const clauseEndings = [';', '.', '!', '?', '\n'].map((mark) => cleaned.indexOf(mark, parsed.end)).filter((index) => index >= 0);
    const clauseEnd = clauseEndings.length ? Math.min(...clauseEndings) : cleaned.length;
    const clause = cleaned.slice(clauseStart, clauseEnd);
    const before = clause.slice(0, Math.max(0, at - clauseStart));
    const trackMatches = [...before.matchAll(/\b(junior|entry[ -]?level|senior|staff|principal)\s+(?:experience\s+)?(?:track|level)\b|\b(?:track|level)\s*(?:is|:|=)?\s*(junior|entry[ -]?level|senior|staff|principal)\b/gi)];
    const trailingRequirementEnd = Math.min(parsedOccurrences[occurrenceIndex + 1]?.start ?? clauseEnd, clauseEnd);
    const trailingRequirement = cleaned.slice(parsed.end, trailingRequirementEnd);
    const trailingUniversal = [...trailingRequirement.matchAll(/\b(?:all\s+candidates|everyone|regardless\s+of\s+level)\b/gi)].some((match) => {
      const preceding = trailingRequirement.slice(0, match.index);
      const following = trailingRequirement.slice((match.index ?? 0) + match[0].length);
      return /\b(?:required|must\s+have|mandatory|minimum|at\s+least)\b/i.test(preceding)
        || !/\b(?:required|must\s+have|mandatory|minimum|at\s+least)\b/i.test(following);
    });
    const universalBoundary = trailingUniversal
      ? Number.POSITIVE_INFINITY
      : [...before.matchAll(/\b(?:all\s+candidates|everyone|regardless\s+of\s+level)\b/gi)].at(-1)?.index ?? -1;
    const applicableTrack = trackMatches.filter((match) => (match.index ?? -1) > universalBoundary).at(-1);
    const track = trailingUniversal
      ? null
      : applicableTrack?.[1] || applicableTrack?.[2]
        ? (applicableTrack[1] || applicableTrack[2]).toLowerCase().replace(/[ -]/g, '-')
        : requirementHeadingContext(cleaned, at).track;
    const localContext = clause;
    const scope = /\b(overall|total|general)\s+(?:professional\s+)?experience\b/i.test(localContext)
      ? 'overall'
      : /\b(?:hands[ -]?on|with|using)\s+[A-Z][A-Za-z0-9+.#/-]*\b/.test(localContext) ? 'specialized' : 'unspecified';
    requirements.push({
      minYears: parsed.minYears,
      maxYears: parsed.maxYears,
      scope,
      track,
      evidence: parsed.evidence,
      excerpt: context.trim().slice(0, 300),
    });
  }
  const selectionPatterns = [
    /^\s*(?:this|the)\s+(?:opening|position|role)\s+is\s+(?:for\s+)?(?:the\s+)?(junior|entry[ -]?level|senior|staff|principal)\s+(?:track|level)\s*[.!?]?\s*$/i,
    /^\s*(?:applicable|selected|hired|opening|position|role)\s+(?:experience\s+)?(?:track|level)\s*(?:is|:|=|will be|selected as)?\s*(junior|entry[ -]?level|senior|staff|principal)\s*[.!?]?\s*$/i,
  ];
  const selectionClauses = [cleaned, stripHtmlToRequirementText(sourceEvidence)]
    .filter(Boolean)
    .flatMap((text) => text.split(/[;.!?\n]+/));
  const selections = selectionClauses.flatMap((clause) => {
    const match = selectionPatterns.map((pattern) => clause.match(pattern)).find(Boolean);
    return match ? [{ 0: clause.trim(), 1: match[1] }] : [];
  });
  const selectedNames = [...new Set(selections.map((match) => (match[1] || match[2]).toLowerCase().replace(/[ -]/g, '-')))];
  const selection = selectedNames.length === 1 ? selections.find((match) => (match[1] || match[2]).toLowerCase().replace(/[ -]/g, '-') === selectedNames[0]) : null;
  const selectedTrack = selectedNames.length === 1 ? selectedNames[0] : null;
  const hasUnassignedAlternative = /\b\d+(?:\s*[-–—]\s*\d+)?(?:\s*years?)?\s+or\s+\d+\s*\+?(?:\s*years?)?[^.!?;]{0,120}\b(?:depending on|based on)\s+(?:the\s+)?(?:level|experience)\b/i.test(cleaned)
    && !selectedTrack;
  const tracks = [...new Set(requirements.map((item) => item.track).filter(Boolean))];
  const conflict = hasUnassignedAlternative || selectedNames.length > 1 || (tracks.length > 1 && !selectedTrack)
    ? { code: 'EXPERIENCE_NOT_VERIFIED_CONFLICT', evidence: cleaned.match(/[^.!?;]{0,160}\b(?:track|level|depending on)\b[^.!?;]{0,160}/i)?.[0]?.trim().slice(0, 600) || cleaned.slice(0, 600) }
    : null;
  return { requirements, selectedTrack, selectionEvidence: selection?.[0] ?? null, conflict };
}

// Detect recruiting on a client's behalf without mistaking client work for hiring.
export function hiringEmployerConflict(description) {
  const cleaned = stripHtmlToText(description);
  const applicant = String.raw`(?:[A-Za-z-]+\s+){0,6}(?:candidates?|applicants?|engineers?|developers?|professionals?|talent)\b`;
  const recruiting = cleaned.match(new RegExp(String.raw`\b(?:our|the|a|an)\s+client\s+(?:is|are)\s+(?:currently\s+)?(?:hiring|recruiting|(?:looking\s+for|seeking)\s+${applicant})\b|\b(?:hiring|recruiting)\s+(?:on\s+behalf\s+of|for)\s+(?:(?:our|a|an|the)\s+)?client\b|\bseeking\s+${applicant}\s+for\s+(?:(?:our|a|an|the)\s+)?client\b`, 'i'));
  return recruiting ? { reason: 'destination-hiring-employer-unverified', evidence: recruiting[0] } : null;
}

// Normalize explicit experience text without promoting preferred years.
function parseExperienceString(value) {
  const text = nonEmptyString(value);
  if (!text) return { minYears: null, maxYears: null, evidence: null };
  if (PREFERENCE_RE.test(text)) return extractExperienceYears(text) || { minYears: null, maxYears: null, evidence: text };
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i);
  if (range) return { minYears: Number(range[1]), maxYears: Number(range[2]), evidence: text };
  const plus = text.match(/(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)/i);
  if (plus) return { minYears: Number(plus[1]), maxYears: null, evidence: text };
  const one = text.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i);
  if (one) return { minYears: Number(one[1]), maxYears: Number(one[1]), evidence: text };
  return { minYears: null, maxYears: null, evidence: text };
}

// Preserve supplied experience evidence and distinguish hard requirements from preferences.
function normalizeExperience(raw) {
  const sourceEvidence = typeof raw?.experience === 'object' && raw.experience !== null ? raw.experience.evidence : raw?.experienceEvidence;
  const description = raw?.description ?? raw?.descriptionPlain ?? raw?.jd ?? raw?.body;
  const requirements = extractExperienceRequirements(description || raw?.title, sourceEvidence);
  const requirementTracks = new Set(requirements.requirements.map((item) => item.track).filter(Boolean));
  const derived = requirementTracks.size > 1
    ? { minYears: null, maxYears: null, evidence: null }
    : extractExperienceYears(description || raw?.title) || { minYears: null, maxYears: null, evidence: null };
  const value = raw?.experience;
  if (typeof value === 'string') {
    const parsed = parseExperienceString(value);
    return { ...parsed, sourceMinYears: parsed.minYears, sourceMaxYears: parsed.maxYears, requirements };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const explicit = {
      minYears: finiteYears(value.minYears ?? value.minimumYears ?? value.min),
      maxYears: finiteYears(value.maxYears ?? value.maximumYears ?? value.max),
      evidence: preserveText(value.evidence),
    };
    if (explicit.evidence && PREFERENCE_RE.test(explicit.evidence)) {
      const recovered = parseExperienceString(explicit.evidence);
      const recoveredMin = recovered.minYears;
      return {
        ...recovered,
        sourceMinYears: Object.hasOwn(value, 'sourceMinYears') ? finiteYears(value.sourceMinYears) : recoveredMin == null ? null : strictestYears(explicit.minYears, recoveredMin),
        sourceMaxYears: Object.hasOwn(value, 'sourceMaxYears') ? finiteYears(value.sourceMaxYears) : recoveredMin == null ? null : explicit.maxYears,
        sourceMaxUnbounded: value.sourceMaxUnbounded === true,
        requirements,
      };
    }
    if (explicit.minYears != null || explicit.maxYears != null || explicit.evidence) return { ...explicit, sourceMinYears: Object.hasOwn(value, 'sourceMinYears') ? finiteYears(value.sourceMinYears) : explicit.minYears, sourceMaxYears: Object.hasOwn(value, 'sourceMaxYears') ? finiteYears(value.sourceMaxYears) : explicit.maxYears, sourceMaxUnbounded: value.sourceMaxUnbounded === true, requirements };
    return { ...(requirementTracks.size > 1 ? derived : extractExperienceYears(description) || explicit), sourceMinYears: null, requirements };
  }
  const explicit = {
    minYears: finiteYears(raw?.minYears ?? raw?.minimumYears ?? raw?.experienceMinYears),
    maxYears: finiteYears(raw?.maxYears ?? raw?.maximumYears ?? raw?.experienceMaxYears),
    evidence: preserveText(raw?.experienceEvidence),
  };
  if (explicit.evidence && PREFERENCE_RE.test(explicit.evidence)) {
    const recovered = parseExperienceString(explicit.evidence);
    const recoveredMin = recovered.minYears;
    return {
      ...recovered,
      sourceMinYears: Object.hasOwn(raw, 'sourceMinYears') ? finiteYears(raw.sourceMinYears) : recoveredMin == null ? null : strictestYears(explicit.minYears, recoveredMin),
      sourceMaxYears: Object.hasOwn(raw, 'sourceMaxYears') ? finiteYears(raw.sourceMaxYears) : recoveredMin == null ? null : explicit.maxYears,
      sourceMaxUnbounded: raw.sourceMaxUnbounded === true,
      requirements,
    };
  }
  if (explicit.minYears != null || explicit.maxYears != null || explicit.evidence) return {
    ...explicit,
    sourceMinYears: Object.hasOwn(raw, 'sourceMinYears') ? finiteYears(raw.sourceMinYears) : explicit.minYears,
    sourceMaxYears: Object.hasOwn(raw, 'sourceMaxYears') ? finiteYears(raw.sourceMaxYears) : explicit.maxYears,
    sourceMaxUnbounded: raw.sourceMaxUnbounded === true,
    requirements,
  };
  return { ...derived, sourceMinYears: null, requirements };
}

function normalizeEmployment(raw) {
  const value = raw?.employment;
  const type = normalizeEmploymentType(typeof value === 'string' ? value : value?.type ?? raw?.employmentType ?? raw?.type);
  const paidValue = typeof value === 'object' && value !== null ? value.paid : raw?.paid;
  const paid = typeof paidValue === 'boolean' ? paidValue : null;
  const evidence = preserveText(typeof value === 'object' && value !== null ? value.evidence : raw?.employmentEvidence ?? raw?.payEvidence);
  return { type, paid, evidence };
}

function normalizeLiveness(raw, { runAt = null, currentFeedIsLive = false } = {}) {
  const value = raw?.liveness;
  let status = null;
  let checkedAt = null;
  let evidence = null;
  if (typeof value === 'string') status = value;
  else if (value && typeof value === 'object') {
    status = value.status;
    checkedAt = value.checkedAt;
    evidence = value.evidence;
  }
  status = nonEmptyString(status);
  if (status) {
    const canonical = /^(active|live)$/i.test(status) ? 'Active' : /^(expired|dead)$/i.test(status) ? 'Expired' : 'Not Verified';
    checkedAt = checkedAt == null ? null : normalizePostedAt(checkedAt);
    return { status: canonical, checkedAt, evidence: preserveText(evidence) };
  }
  if (currentFeedIsLive) {
    return {
      status: 'Active',
      checkedAt: runAt == null ? null : normalizePostedAt(runAt),
      evidence: 'current-feed-record',
    };
  }
  return { status: 'Not Verified', checkedAt: null, evidence: null };
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeSourceCategory(value, sourceKind) {
  const raw = nonEmptyString(value)?.toLowerCase();
  const aliases = new Map([
    ['direct', 'direct-company'],
    ['direct-company', 'direct-company'],
    ['ats-direct', 'direct-company'],
    ['vc', 'vc-portfolio'],
    ['vc-portfolio', 'vc-portfolio'],
    ['india-niche', 'india-niche'],
    ['niche-public', 'india-niche'],
    ['broad-remote', 'broad-remote'],
    ['aggregator', 'aggregator'],
  ]);
  if (raw && aliases.has(raw)) return aliases.get(raw);
  if (sourceKind === 'ats-direct') return 'direct-company';
  if (sourceKind === 'niche-public') return 'india-niche';
  return 'aggregator';
}

function normalizeSalary(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const minimum = Number(source.minimum ?? source.min ?? raw?.salaryMin);
  const maximum = Number(source.maximum ?? source.max ?? raw?.salaryMax);
  return {
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null,
    currency: nonEmptyString(source.currency ?? raw?.salaryCurrency),
    period: nonEmptyString(source.period ?? raw?.salaryPeriod),
    evidence: preserveText(source.evidence ?? (typeof value === 'string' ? value : raw?.salaryEvidence)),
  };
}

function normalizeRemoteEligibility(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supplied = source.status ?? value ?? raw?.remoteEligible;
  let status = 'Not Verified';
  if (supplied === true || /^(india[- ]?eligible|eligible|yes|allowed)$/i.test(String(supplied ?? ''))) status = 'India Eligible';
  if (supplied === false || /^(not[- ]?eligible|ineligible|no|denied)$/i.test(String(supplied ?? ''))) status = 'Not Eligible';
  return { status, evidence: preserveText(source.evidence ?? raw?.remoteEligibilityEvidence) };
}

function normalizeBooleanEvidence(value, evidenceValue) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const supplied = source.available ?? source.value ?? value;
  const available = typeof supplied === 'boolean' ? supplied : null;
  return { available, evidence: preserveText(source.evidence ?? evidenceValue) };
}

function normalizeTimezoneOverlap(value, raw) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hours = Number(source.minimumHours ?? source.hours ?? raw?.timezoneOverlapHours);
  return {
    status: nonEmptyString(source.status ?? (typeof value === 'string' ? value : null)) || 'Not Verified',
    minimumHours: Number.isFinite(hours) ? hours : null,
    evidence: preserveText(source.evidence ?? raw?.timezoneOverlapEvidence),
  };
}

function normalizeApplicationResolution(raw, sourceKind, canonicalUrl) {
  const supplied = raw?.originalApplicationUrl ?? raw?.originalApplyUrl ?? raw?.applicationUrl ?? raw?.applyUrl;
  const originalApplicationUrl = canonicalizeUrl(supplied);
  const rawResolution = raw?.applicationResolution && typeof raw.applicationResolution === 'object' ? raw.applicationResolution : {};
  const direct = sourceKind === 'ats-direct';
  const status = originalApplicationUrl ? 'Resolved Original' : direct ? 'Direct ATS' : 'Unresolved';
  return {
    originalApplicationUrl: originalApplicationUrl || (direct ? canonicalUrl : null),
    resolution: {
      status,
      evidence: preserveText(rawResolution.evidence ?? raw?.originalApplicationEvidence),
    },
  };
}

export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { valid: false, errors: ['candidate must be an object'] };
  if (candidate.schemaVersion !== CANDIDATE_SCHEMA_VERSION) errors.push('schemaVersion must be CandidateV1');
  for (const field of ['canonicalUrl', 'company', 'title']) {
    if (!nonEmptyString(candidate[field])) errors.push(`${field} is required`);
  }
  if (candidate.canonicalUrl && !/^https?:\/\//i.test(candidate.canonicalUrl)) errors.push('canonicalUrl must be http(s)');
  if (!isIsoTimestamp(candidate.postedAt)) errors.push('postedAt must be a full ISO-8601 timestamp or null');
  for (const field of ['discoveredAt', 'crawledAt', 'firstSeenAt']) {
    if (!isIsoTimestamp(candidate[field])) errors.push(`${field} must be a full ISO-8601 timestamp or null`);
  }
  if (candidate.jobId != null && typeof candidate.jobId !== 'string') errors.push('jobId must be a string or null');
  if (candidate.provider != null && typeof candidate.provider !== 'string') errors.push('provider must be a string or null');
  if (candidate.source != null && typeof candidate.source !== 'string') errors.push('source must be a string or null');
  if (candidate.description != null && typeof candidate.description !== 'string') errors.push('description must be a string or null');
  if (!candidate.employment || typeof candidate.employment !== 'object') errors.push('employment is required');
  if (!candidate.experience || typeof candidate.experience !== 'object') errors.push('experience is required');
  if (!candidate.liveness || typeof candidate.liveness !== 'object') errors.push('liveness is required');
  if (candidate.fingerprint != null && !/^[0-9a-f]{16}$/.test(candidate.fingerprint)) errors.push('fingerprint must be 16 lowercase hex characters or null');
  if (candidate.matchScore != null && (!Number.isInteger(candidate.matchScore) || candidate.matchScore < 0 || candidate.matchScore > 100)) errors.push('matchScore must be 0-100 or null');
  if (candidate.responseLikelihood != null && (!Number.isInteger(candidate.responseLikelihood) || candidate.responseLikelihood < 0 || candidate.responseLikelihood > 20)) errors.push('responseLikelihood must be 0-20 or null');
  if (candidate.conversionScore != null && (!Number.isFinite(candidate.conversionScore) || candidate.conversionScore < 0 || candidate.conversionScore > 100)) errors.push('conversionScore must be 0-100 or null');
  if (candidate.originalApplicationUrl != null && !/^https?:\/\//i.test(candidate.originalApplicationUrl)) errors.push('originalApplicationUrl must be http(s) or null');
  return { valid: errors.length === 0, errors };
}

export function assertCandidate(candidate) {
  const result = validateCandidate(candidate);
  if (!result.valid) throw new CandidateValidationError(result.errors);
  return candidate;
}

export function normalizeCandidate(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CandidateValidationError(['candidate input must be an object']);
  const source = typeof raw.source === 'string' ? raw.source : options.source ?? null;
  const provider = typeof raw.provider === 'string' ? raw.provider : options.provider ?? null;
  const originalUrl = raw.url ?? raw.canonicalUrl;
  const canonicalUrl = canonicalizeUrl(originalUrl);
  const description = preserveText(raw.description ?? raw.descriptionPlain ?? raw.jd ?? raw.body);
  const postedAt = normalizePostedAt(raw.postedAt ?? raw.firstPublished ?? raw.createdAt);
  const experience = normalizeExperience(raw);
  const employment = normalizeEmployment(raw);
  const sourceKind = nonEmptyString(raw.sourceKind ?? options.sourceKind) || 'aggregator';
  const application = normalizeApplicationResolution(raw, sourceKind, canonicalUrl);
  const candidate = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    canonicalUrl,
    url: nonEmptyString(originalUrl),
    source,
    provider,
    jobId: raw.jobId == null && raw.id == null ? null : String(raw.jobId ?? raw.id),
    identityAliases: Array.isArray(raw.identityAliases) ? raw.identityAliases.filter((alias) => typeof alias === 'string' && alias.trim()) : [],
    firstSeenAt: normalizeOptionalTimestamp(raw.firstSeenAt ?? raw.first_seen_at, 'firstSeenAt'),
    company: nonEmptyString(raw.company ?? raw.companyName),
    title: nonEmptyString(raw.title ?? raw.role),
    location: preserveText(raw.location),
    workMode: normalizeWorkMode(raw.workMode ?? raw.work_mode ?? raw.location),
    description,
    evidence: normalizeEvidence(raw.evidence),
    postedAt,
    discoveredAt: normalizeOptionalTimestamp(raw.discoveredAt ?? options.discoveredAt ?? options.runAt, 'discoveredAt'),
    crawledAt: normalizeOptionalTimestamp(raw.crawledAt ?? raw.scrapedAt ?? options.crawledAt, 'crawledAt'),
    employment,
    experience,
    liveness: normalizeLiveness(raw, options),
    fingerprint: /^[0-9a-f]{16}$/.test(raw.fingerprint || '') ? raw.fingerprint : null,
    sourceKind,
    sourceCategory: normalizeSourceCategory(raw.sourceCategory ?? options.sourceCategory, sourceKind),
    originalApplicationUrl: application.originalApplicationUrl,
    applicationResolution: application.resolution,
    remoteEligibility: normalizeRemoteEligibility(raw.remoteEligibility, raw),
    salary: normalizeSalary(raw.salary, raw),
    stipend: parseStipend(raw),
    timezoneOverlap: normalizeTimezoneOverlap(raw.timezoneOverlap, raw),
    eor: normalizeBooleanEvidence(raw.eor, raw.eorEvidence),
    equipment: normalizeBooleanEvidence(raw.equipment, raw.equipmentEvidence),
    matchScore: null,
    scoreOrigin: 'source-input',
    componentScores: raw.componentScores ?? null,
    descriptionAvailable: typeof raw.descriptionAvailable === 'boolean' ? raw.descriptionAvailable : null,
    scoringFailed: raw.scoringFailed === true || raw.scoringStatus === 'scoring-failed' || (raw.responseLikelihood != null && String(raw.responseLikelihood).trim() !== '' && integerInRange(raw.responseLikelihood, 0, 20) === null) || (raw.matchScore != null && String(raw.matchScore).trim() !== '' && integerInRange(raw.matchScore, 0, 100) === null) || (raw.score != null && String(raw.score).trim() !== '' && integerInRange(raw.score, 0, 100) === null),
    scoringFailureReason: raw.scoringFailureReason ?? null,
    scoringStatus: raw.scoringStatus ?? null,
    rationale: preserveText(raw.rationale),
    hook: preserveText(raw.hook ?? raw.strongestHook),
    responseLikelihood: integerInRange(raw.responseLikelihood, 0, 20),
    conversionScore: Number.isFinite(Number(raw.conversionScore)) ? Number(raw.conversionScore) : null,
    conversionFactors: raw.conversionFactors && typeof raw.conversionFactors === 'object' ? { ...raw.conversionFactors } : null,
    conversionSignals: raw.conversionSignals && typeof raw.conversionSignals === 'object'
      ? { ...raw.conversionSignals }
      : {
        humanContact: raw.humanContact === true,
        projectConnection: raw.projectConnection === true,
      },
    autoSuggest: false,
  };
  return assertCandidate(candidate);
}

// Remove scoring claims at every discovery lane boundary.
export function discoveryCandidate(candidate) {
  return { ...assertCandidate(candidate), matchScore: null, score: null, scoreOrigin: 'source-input', autoSuggest: false };
}

export function normalizedKey(value) {
  return String(value ?? '')
    .toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function companyTitleLocationKey(candidate) {
  return [candidate.company, candidate.title, candidate.location].map(normalizedKey).join('|');
}

// Normalize Workday URL slugs and previously normalized ledger IDs alike.
export function normalizeRequisitionId(provider, value) {
  const id = String(value ?? '');
  if (normalizedKey(provider) !== 'workday') return id;
  return id.match(/(?:^|[_ ])([A-Za-z]{1,4}[- ]?\d{3,}|\d{5,})(?:[- ]\d+)?$/)?.[1] ?? id;
}

// Normalize a provider identity without changing keys for other providers.
export function normalizeIdentityKey(value) {
  const parts = String(value ?? '').split('|');
  if (parts.length !== 2) return String(value ?? '');
  return `${normalizedKey(parts[0])}|${normalizedKey(normalizeRequisitionId(parts[0], parts[1]))}`;
}

// Return the current identity and every proven pre-resolution identity.
export function candidateIdentityKeys(candidate) {
  return [...new Set([candidateDedupKey(candidate), ...(candidate.identityAliases || [])].map(normalizeIdentityKey).filter(Boolean))];
}

// Compare employer names while allowing missing names and common company suffixes.
export function companiesCompatible(left, right) {
  if (!String(left ?? '').trim() || !String(right ?? '').trim()) return true;
  const suffixes = /\b(?:inc|ltd|limited|pvt|private|llc|corp|corporation|technologies|technology|solutions|india|co)\b/g;
  const a = normalizedKey(left).replace(suffixes, '').replace(/\s+/g, ' ').trim();
  const b = normalizedKey(right).replace(suffixes, '').replace(/\s+/g, ' ').trim();
  return a === b || Boolean(a && b && (a.includes(b) || b.includes(a)));
}

// Match current or retained identities against either ledger generation.
export function candidateMatchesLedgerRow(candidate, row) {
  if (!companiesCompatible(candidate.company, row.company)) return false;
  const keys = candidateIdentityKeys(candidate);
  const rowKeys = [row.dedup_key ?? row.dedupKey, candidateRequisitionKey({ provider: row.provider, jobId: row.job_id ?? row.jobId ?? row.provider_job_id })];
  return rowKeys.some((key) => key && keys.includes(normalizeIdentityKey(key)));
}

export function candidateRequisitionKey(candidate) {
  const provider = normalizedKey(candidate.provider);
  const jobId = normalizedKey(normalizeRequisitionId(provider, candidate.jobId ?? candidate.providerJobId ?? candidate.requisitionId));
  if (provider && jobId) return `${provider}|${jobId}`;
  return null;
}

/**
 * Durable identity prefers provider + requisition/job id so two Workday
 * requisitions at the same company/title/location stay distinct. Canonical
 * URL is the next fallback; company|title|location is last-resort only.
 */
export function candidateDedupKey(candidate) {
  const requisition = candidateRequisitionKey(candidate);
  if (requisition) return requisition;
  const url = canonicalizeUrl(candidate.canonicalUrl || candidate.url);
  if (url) return `url|${url}`;
  return companyTitleLocationKey(candidate);
}

export function buildPayloadRecord(candidate, selection = {}) {
  assertCandidate(candidate);
  return {
    Role: candidate.title,
    Company: candidate.company,
    'JD Link': candidate.canonicalUrl,
    'Original Application URL': candidate.originalApplicationUrl,
    'Application Resolution': candidate.applicationResolution?.status ?? 'Unresolved',
    'Application Resolution Evidence': candidate.applicationResolution?.evidence ?? null,
    'Application Ready': candidate.applicationReady === true,
    Location: candidate.location,
    'Posted Date': candidate.postedAt,
    'Posted At': candidate.postedAt,
    'Discovered At': candidate.discoveredAt,
    'Crawled At': candidate.crawledAt,
    'JD Text': candidate.description,
    'Job ID': candidate.jobId,
    Source: candidate.source,
    'Source Rarity': candidate.sourceKind,
    'Source Category': candidate.sourceCategory,
    'Source Provider': candidate.provider,
    Liveness: candidate.liveness.status,
    'Match Score': candidate.matchScore,
    'Conversion Score': candidate.conversionScore,
    'Conversion Factors': candidate.conversionFactors,
    Rationale: candidate.rationale,
    Hook: candidate.hook,
    'Response Likelihood': candidate.responseLikelihood,
    'Auto-Suggest': candidate.autoSuggest,
    'Experience Asked': candidate.experience.evidence,
    'Remote Eligibility': candidate.remoteEligibility?.status ?? 'Not Verified',
    'Remote Eligibility Evidence': candidate.remoteEligibility?.evidence ?? null,
    Salary: candidate.salary,
    'Timezone Overlap': candidate.timezoneOverlap,
    EOR: candidate.eor,
    Equipment: candidate.equipment,
    'Apply?': false,
    Status: 'Discovered',
    'Resume Status': 'Not Started',
    'Selection Tier': selection.tier ?? null,
    'Freshness Window': selection.freshnessWindow ?? null,
    'Role Family': selection.roleFamily ?? null,
    Relaxations: Array.isArray(selection.relaxations) ? [...selection.relaxations] : [],
    'Employment Type': candidate.employment.type,
    'Eligibility Evidence': Array.isArray(selection.evidenceCodes) ? [...selection.evidenceCodes] : [],
    'Run ID': selection.runId ?? null,
  };
}

export function validatePayloadRecord(payload) {
  const errors = [];
  for (const field of ['Role', 'Company', 'JD Link', 'Status', 'Resume Status']) {
    if (payload?.[field] == null || payload[field] === '') errors.push(`${field} is required`);
  }
  if (payload?.['Apply?'] !== false) errors.push('Apply? must remain false');
  if (payload?.Status !== 'Discovered') errors.push('Status must remain Discovered');
  if (payload?.['Resume Status'] !== 'Not Started') errors.push('Resume Status must remain Not Started');
  return { valid: errors.length === 0, errors };
}

export function stableCandidateId(candidate) {
  return createHash('sha256').update(`${candidate.canonicalUrl}\0${candidate.jobId ?? ''}\0${candidateDedupKey(candidate)}`).digest('hex').slice(0, 16);
}
