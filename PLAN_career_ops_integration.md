# Plan — career-ops × Job Search OS integration (v4)

> Decision: **do not migrate into career-ops.** Keep Job Search OS as the brain
> (master_prompt.md rubric, Notion tracker-of-record, LaTeX resume pipeline).
> Use career-ops as a discovery/hygiene **engine library**. career-ops `data/*`
> is engine cache only — never a tracker.

## Why not migrate
- career-ops tracker-of-record = `data/applications.md` (files canonical); its Notion
  plugin is one-way mirror with no URL round-trip → conflicts with "Notion is tracker of record".
- Scoring is 1–5 with six senior/strategic archetypes (LLMOps, AI PM, Transformation) —
  no fresher/new-grad archetype. Our 0–100 rubric + hard gates already fresher-tuned.
- Its CV pipeline: `cv.md` markdown → fixed template, **no one-page enforcement**.
  Ours: `.tex` master + project picker + page-count verify. Ours wins.
- Its example `title_filter.negative` excludes "Junior"/"Intern" — opposite of our target.

## What we harvest from career-ops
| Component | Use |
|---|---|
| `scan.mjs` + `providers/` (~55) | Layer 0 zero-token discovery: ATS APIs (Greenhouse/Ashby/Lever/Workday/SmartRecruiters/Workable…) + remote boards (remoteok, remotive, himalayas, echojobs, hackernews Who-is-hiring) |
| `check-liveness.mjs` | Pre-scoring liveness gate (ATS API rung → Playwright rung). Never score dead posts. |
| `detect-reposts.mjs` | SimHash fingerprint → catches agency cross-listings our company+title+location hash misses |
| `followup-cadence.mjs` (logic) | Cadence rules for /followups: applied day 7, +7, max 2; responded 1d/3d; thank-you 1d |
| `data/scan-history.tsv` | Persistent dedup memory + `recheck_after_days` repost signal |

Known engine gaps we cover ourselves:
- No India boards (Naukri/Instahyre/Cutshort) in providers → keep dorks (L1) + Indeed MCP (L3).
- No posted-within-N-days filter in scan.mjs → filter by Posted Date in skill layer (drop >5d).
- `classify-tier.mjs` defaults unlabeled titles to `mid` → use `skip_tiers: [senior]` only; never rely on it to *find* entry roles.

## Morning architecture (one command)
```
07:00 IST  /morning
 L0  node career-ops/scan.mjs        (portals.yml → ATS APIs + remote boards, zero-token)
 L1  WebSearch dorks                 (existing — India coverage)
 L2  companies.json ATS JSON         (existing watchlist)
 L3  Indeed MCP fallback             (existing)
 → merge → dedup (Dedup Key + SimHash) → check-liveness.mjs → drop dead
 → hard gates (master_prompt §2) → score 0–100 (§3) → top 15–20, all <5d
 → write Notion Applications v4 rows + run summary → present ranked list
User: Apply? ✓ on 5–7 → /make-applications → 1-page verified PDFs → applies manually
→ Status=Applied → follow-up auto-seeded → /followups surfaces due items daily
```

## Notion v4 design
**Applications v4** (new DB; old one archived after migration):
- Identity: Role (title) · Company (relation) · JD Link · Job ID · Dedup Key · Fingerprint
- Sourcing: Source · Source Rarity · Posted Date · Date Pulled · Freshness (A/B/C) ·
  Liveness (Active/Expired/Not Verified) · Liveness Checked
- Fit: Match Score (0–100) · Rationale · Hook · Response Likelihood · Auto-Suggest ☐ ·
  Experience Asked · CTC/Salary (verbatim or blank)
- Decision: Apply? ☐ (manual only) · Status · Priority
- Execution: Resume Status · Resume PDF · Applied Date · Applied Via (Portal/Email/Referral)
- Follow-up: Next Follow-up · Follow-up Count · Last Activity
- Misc: Location · Work Mode · Notes

Status select: Discovered → Shortlisted → Resume Ready → Applied → Followed Up →
Responded → Interview → Offer → Rejected → Dropped

**Activity DB (new):** Application (relation) · Type (Applied/Follow-up/Reply/Interview/
Thank-you/Note) · Date · Due · Done ☐ · Notes/Draft link.

Views: Today's Pull · To Apply · Follow-up Due · Pipeline board (by Status) · Archive.
Companies + Outreach DBs unchanged.

## Build phases
1. **Engine config** (career-ops user layer only — survives `update-system.mjs`):
   - `career-ops/portals.yml`: positive = AI Engineer/ML/LLM/Agentic/Backend Python/
     Full Stack/Software Engineer/New Grad/Associate; NO Junior/Intern in negative;
     `skip_tiers: [senior]`; location allow India/Pune/Remote; boards: remoteok,
     remotive, himalayas, echojobs, hackernews; tracked_companies seeded from companies.json.
   - Minimal `career-ops/config/profile.yml` + `cv.md` stub so doctor/scan run clean
     (CV content SoT stays `resumes/master/*.tex`).
2. **Notion v4**: create Applications v4 + Activity DBs + views; migrate open rows; archive old DB.
3. **Skills**: daily-job-pull v4 (adds L0 + liveness + SimHash, writes v4 schema);
   new /followups (cadence vs Activity DB); new /morning (single entry command);
   make-applications stamps Resume PDF + Activity row; master_prompt.md §6/§7 updated.
4. **Later (optional)**: Naukri/Instahyre provider in `career-ops/plugins.local/`;
   scheduled cloud pull stays discovery-only.

## Guardrails (unchanged, non-negotiable)
No auto-apply · Apply? always manual · discovery-only in cloud · LaTeX compile local-only ·
PDF-only output dir · never fabricate · Notion schema changes need user approval before
touching live data.
