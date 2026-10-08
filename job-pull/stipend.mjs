const INR = /^(?:inr|₹|rs\.?|rupees?)$/i;

// Keep nonempty evidence strings without inventing missing values.
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Copy retained stipend evidence.
function copy(value) {
  return value == null ? value : structuredClone(value);
}

// Read a finite amount from provider numbers or formatted strings.
function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  if (!value.trim()) return null;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// Canonicalize stated INR currency without converting foreign currencies.
function currencyFrom(value) {
  const supplied = text(value);
  if (!supplied) return { currency: null, currencyRaw: null };
  return { currency: INR.test(supplied) ? 'INR' : supplied.toUpperCase(), currencyRaw: supplied };
}

// Convert only stated periods with a known monthly multiplier.
function periodFrom(value) {
  const raw = text(value);
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:month|monthly|per month|\/month|pm)$/.test(lower)) return { period: raw, periodUnit: 'month', multiplier: 1 };
  if (/^(?:year|yearly|annual|annually|per year|per annum|pa)$/.test(lower)) return { period: raw, periodUnit: 'year', multiplier: 1 / 12 };
  if (/^(?:week|weekly|per week|\/week)$/.test(lower)) return { period: raw, periodUnit: 'week', multiplier: 52 / 12 };
  return { period: raw, periodUnit: null, multiplier: null };
}

// Read stipend quantities while retaining ambiguous ranges.
function amountFromText(value) {
  const source = (text(value) || '').replace(/([\d,.]+)\s*k\b/gi, (_, amount) => String(number(amount) * 1000));
  const range = source.match(/(?:₹|INR|Rs\.?|rupees?\s*)?\s*([\d,]+(?:\.\d+)?)\s*(?:-|–|to)\s*(?:₹|INR|Rs\.?|rupees?\s*)?\s*([\d,]+(?:\.\d+)?)/i);
  if (range) return { amount: number(range[1]), maximum: number(range[2]), ambiguous: true };
  const match = source.match(/(?:₹|INR|Rs\.?|rupees?\s*)?\s*([\d,]+(?:\.\d+)?)/i);
  return { amount: match ? number(match[1]) : null, maximum: null, ambiguous: false };
}

// Parse stated INR stipend evidence and compare its monthly value with the internship floor.
export function parseStipend(raw) {
  const description = raw?.description ?? raw?.employment?.evidence ?? '';
  const stated = description.match(/\b(?:stipend|stipended|compensation)\s*[:=-]?\s*(?:₹|INR|Rs\.?)\s*[\d,.]+\s*k?\s*(?:-|–|to)?\s*[\d,.]*\s*k?\s*(?:\/|per\s+)?(?:month|monthly|year|yearly|annum|week|weekly)/i)?.[0];
  const supplied = raw?.stipend ?? raw?.stipendEvidence ?? stated ?? raw?.salary ?? null;
  const structured = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : null;
  const sourceText = typeof supplied === 'string' ? supplied : text(structured?.raw ?? raw?.stipendRaw ?? raw?.stipendText);
  const textAmount = amountFromText(sourceText);
  const minimum = number(structured?.minimum ?? structured?.min);
  const maximum = number(structured?.maximum ?? structured?.max);
  const explicitAmount = number(structured?.amount ?? structured?.value ?? raw?.stipendAmount);
  const amount = explicitAmount ?? minimum ?? textAmount.amount;
  const hasDifferentRange = minimum != null && maximum != null && minimum !== maximum;
  const ambiguous = structured?.ambiguous === true || textAmount.ambiguous || hasDifferentRange || (explicitAmount == null && minimum == null && maximum != null);
  const rawPeriod = structured?.period ?? raw?.stipendPeriod ?? (sourceText?.match(/(?:per\s+)?(?:month|monthly|year|yearly|annual|annually|week|weekly)/i)?.[0] ?? null);
  const period = periodFrom(rawPeriod);
  const detectedCurrency = sourceText?.match(/₹|INR|Rs\.?|rupees?/i)?.[0] ?? null;
  const { currency, currencyRaw } = currencyFrom(structured?.currency ?? raw?.stipendCurrency ?? detectedCurrency);
  const evidence = text(structured?.evidence ?? raw?.stipendEvidence ?? (typeof supplied === 'string' ? supplied : null));
  const rawValue = structured?.raw ?? raw?.stipendRaw ?? supplied;
  const explicitlyUnverified = structured?.verified === false || /^(?:unknown|unverified|not verified|ambiguous)$/i.test(text(structured?.status) || '');

  const result = {
    amount,
    currency,
    currencyRaw,
    period: period?.period ?? null,
    periodUnit: period?.periodUnit ?? null,
    monthlyAmount: period?.multiplier != null && amount != null ? Math.round(amount * period.multiplier * 100) / 100 : null,
    raw: copy(rawValue),
    evidence,
    ambiguous,
    verified: !explicitlyUnverified,
    tier: 'Needs Verification',
    status: 'Needs Verification',
    reason: null,
    conversion: period?.periodUnit && period.periodUnit !== 'month' ? `safe-${period.periodUnit}-to-month` : null,
  };

  if (explicitlyUnverified || ambiguous || amount == null || currency == null || !period?.periodUnit) {
    result.reason = explicitlyUnverified ? 'STIPEND_UNVERIFIED'
      : ambiguous ? 'STIPEND_AMBIGUOUS'
        : amount == null ? 'STIPEND_MISSING'
          : currency == null ? 'STIPEND_CURRENCY_MISSING'
            : !INR.test(currency) ? 'STIPEND_CURRENCY_NOT_INR'
              : 'STIPEND_PERIOD_NOT_SAFE_TO_CONVERT';
    return result;
  }
  if (!INR.test(currency)) {
    result.reason = 'STIPEND_CURRENCY_NOT_INR';
    return result;
  }
  if (result.monthlyAmount < 40000) {
    result.tier = 'Reject';
    result.status = 'Rejected';
    result.reason = 'STIPEND_BELOW_40000_INR_MONTHLY';
    return result;
  }
  result.tier = 'Preferred';
  result.status = 'Verified';
  return result;
}
