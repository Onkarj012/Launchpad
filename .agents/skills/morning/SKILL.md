---
name: morning
description: Manual daily discovery and conversion handoff.
disable-model-invocation: true
---

# Morning

Run one manual daily discovery pass, then hand the shortlisted leads to the conversion layer. It never applies, sends outreach, changes `Apply?`, reads email, or uses browser automation.

`master_prompt.md` and `config/job-pull.json` govern discovery. `config/conversion-plan.json` governs only the post-discovery composition check and handoff.

## Steps

1. **Check state** — if a successful pull exists for today, show its summary and stop unless Onkar explicitly asks for a forced rerun.
   *Done when:* the run decision is explicit.

2. **Discover** — invoke `/daily-job-pull` under its own documented process.
   *Done when:* the pull's full source, gate, freshness, dedup, and selection report exists.

3. **Present** — show Strict roles first, shortage fallback separately, and all known liveness/ATS evidence. Do not call an aggregator role ready to apply.
   *Done when:* every presented role preserves its source link and verification state.

4. **Check composition** — compare the user-selected ten-role intent against `conversion-plan.json`: role-family targets, at least four direct/VC, at least three Indian niche, at most two broad remote, at most one stretch. Report a shortfall; do not silently substitute candidates.
   *Done when:* every known composition category is counted and unknown categories are named.

5. **Hand off** — ask Onkar to select roles manually, then run `/application-readiness` for each selected role before `/make-applications` or `/application-agent`.
   *Done when:* there is a clear manual next action and `Apply?` remains untouched.

6. **Surface** — run `/followups` in read-only mode and offer drafts only if asked.
   *Done when:* the current follow-up evidence or its absence is stated truthfully.
