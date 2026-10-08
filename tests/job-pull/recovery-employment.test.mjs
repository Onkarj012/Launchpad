import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../job-pull/config.mjs';
import { classifyEmployment } from '../../job-pull/eligibility.mjs';

const policy = loadConfig();
const role = (description, employment = { type: 'full-time', paid: true }) => ({ title: 'AI Engineer', description, employment });
test('benefits and hybrid location language do not reclassify paid employment', () => {
  for (const description of [
    'Benefits: 2 paid volunteer days per year.',
    'You receive paid time off to volunteer for community causes.',
    'Hybrid role, work-from-home part-time and office for the remaining days.',
    'Hybrid working from home on a part-time basis.',
    'Support volunteer developers in our open source community.',
    'Develop smart contract infrastructure.',
    'Unpaid leave is available after paid leave runs out.',
  ]) assert.equal(classifyEmployment(role(description), policy).pass, true, description);
  assert.equal(classifyEmployment(role('Stipend: INR 40,000 per month. PPO based on performance. Paid volunteer days.', { type: 'internship', paid: true }), policy).code, 'EMPLOYMENT_PAID_INTERNSHIP');
});
test('actual unpaid and excluded employment cannot borrow paid benefits or structured full-time', () => {
  for (const description of [
    'This is an unpaid internship. Paid volunteer days are a benefit.',
    'Volunteer developer position.',
    'Part-time remote developer role working from home.',
    'Work from home part-time basis.',
    'This position is a contract.',
    'Employment type: contract.',
    'Contract engineer role with salary.',
    'Temporary position with paid holidays.',
    'Commission-only compensation.',
    'Equity-only compensation.',
  ]) assert.equal(classifyEmployment(role(description), policy).pass, false, description);
  for (const type of ['part-time', 'contract', 'temporary', 'volunteer']) {
    assert.equal(classifyEmployment(role('Paid holidays.', { type, paid: true }), policy).pass, false, type);
  }
  assert.equal(classifyEmployment(role('Benefits only.', { type: 'internship', paid: null }), policy).pass, false);
});
