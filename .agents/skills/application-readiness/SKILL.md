---
name: application-readiness
description: Verify a job before application work.
disable-model-invocation: true
---

# Application Readiness

Turn one discovered role into a **ready** or **blocked** manual application packet. A role is ready only when the original application page is currently accepting applications and its company evidence is coherent.

Read `references/readiness-gate.md` before checking a role. Read `config/conversion-plan.json` only to label source category; it never overrides targeting gates in `master_prompt.md`.

## Steps

1. **Resolve** — start from the source URL and find the company-owned careers page or original ATS requisition. Preserve both URLs and do not guess a redirect destination.
   *Done when:* the original ATS URL is captured, or the role is `blocked: original ATS unresolved`.

2. **Verify** — inspect the original page, company website, company presence, company-domain contact evidence, and whether applications remain open. Check for payment, training fee, bond, or anonymous-staffing signals.
   *Done when:* every readiness check is `verified`, `failed`, or `Not Verified` with a source/time.

3. **Reconcile** — compare company, title, location, work authorization, employment type, experience, salary where disclosed, and posting/requisition identifiers between lead and original page. Apply the master hard gates again.
   *Done when:* each material discrepancy has an outcome and no unknown is silently upgraded.

4. **Decide** — mark `ready` only if all required checks pass; otherwise mark `blocked` or `verify manually`. A ready role can proceed to resume tailoring, not automatic submission.
   *Done when:* the status, source evidence, timestamp, and next manual action are visible in the application record.
