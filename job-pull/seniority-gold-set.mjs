const LABELS = new Set(['eligible', 'ineligible']);

export function validateSeniorityGoldSet(goldSet) {
  const errors = [];
  if (!goldSet || typeof goldSet !== 'object') return { valid: false, errors: ['gold set must be an object'] };
  if (goldSet.humanReviewRequired !== true) errors.push('humanReviewRequired must be true');
  if (goldSet.ratesTrusted !== false && goldSet.humanReviewed !== true) errors.push('unreviewed ratesTrusted must be false');
  if (!Array.isArray(goldSet.cases) || !goldSet.cases.length) errors.push('cases must be a non-empty array');
  for (const [index, entry] of (goldSet.cases || []).entries()) {
    if (typeof entry?.id !== 'string' || !entry.id) errors.push(`cases[${index}].id is required`);
    if (typeof entry?.jdText !== 'string' || !entry.jdText) errors.push(`cases[${index}].jdText is required`);
    if (!LABELS.has(entry?.label)) errors.push(`cases[${index}].label must be eligible or ineligible`);
    if (typeof entry?.humanReviewed !== 'boolean') errors.push(`cases[${index}].humanReviewed must be boolean`);
  }
  return {
    valid: errors.length === 0,
    reviewComplete: goldSet.humanReviewed === true
      && (goldSet.cases || []).every((entry) => entry.humanReviewed === true),
    errors,
  };
}

export async function evaluateSeniorityGoldSet(goldSet, classify) {
  const validation = validateSeniorityGoldSet(goldSet);
  if (typeof classify !== 'function') throw new TypeError('classify must be a function');
  const predictions = [];
  for (const entry of goldSet?.cases || []) {
    predictions.push({ id: entry.id, label: entry.label, decision: await classify(entry.jdText) });
  }
  if (!validation.valid || !validation.reviewComplete || goldSet.ratesTrusted !== true) {
    return {
      trusted: false,
      validation,
      predictions,
      falsePositiveRate: null,
      falseNegativeRate: null,
      uncertainRate: predictions.length
        ? predictions.filter((entry) => entry.decision === 'uncertain').length / predictions.length
        : null,
    };
  }
  const eligible = predictions.filter((entry) => entry.label === 'eligible');
  const ineligible = predictions.filter((entry) => entry.label === 'ineligible');
  return {
    trusted: true,
    validation,
    predictions,
    falsePositiveRate: eligible.length
      ? eligible.filter((entry) => entry.decision === 'ineligible').length / eligible.length
      : null,
    falseNegativeRate: ineligible.length
      ? ineligible.filter((entry) => entry.decision === 'eligible').length / ineligible.length
      : null,
    uncertainRate: predictions.length
      ? predictions.filter((entry) => entry.decision === 'uncertain').length / predictions.length
      : null,
  };
}
