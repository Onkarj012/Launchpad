/** A parsed-empty page needs positive no-results evidence. Login and challenge
 * responses often use HTTP 200, so transport status alone is insufficient.
 */
export function assertPortalPageHealth(html, { provider, records, allowEmptyFragment = false } = {}) {
  const markup = typeof html === 'string' ? html : '';
  const visible = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:access denied|verify (?:that )?you are (?:a )?human|security verification|unusual traffic|complete the captcha|sign in to (?:view|see|continue)|log in to (?:view|see|continue))\b/i.test(visible)
    || /<title[^>]*>[^<]*(?:sign in|log in|just a moment|attention required)/i.test(markup)
    || (!records?.length && /(?:cf-challenge|g-recaptcha|hcaptcha|authwall)/i.test(markup))) {
    throw new Error(`${provider}: PORTAL_ACCESS_BLOCKED`);
  }
  if (records?.length) return;
  if (allowEmptyFragment && !markup.trim()) return;
  if (/\b(?:no (?:matching )?(?:jobs?|results?|opportunities)(?: (?:found|available|match(?:ing)?))?|0 (?:jobs?|results?|opportunities)|we couldn['’]t find any (?:jobs?|results?)|your search (?:returned|did not match) (?:no|any) (?:jobs?|results?))\b/i.test(visible)) return;
  throw new Error(`${provider}: PORTAL_MARKUP_UNRECOGNIZED`);
}
