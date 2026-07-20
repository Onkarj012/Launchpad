# Master Prompt — Job Search OS

> Single source of truth for targeting, scoring, resume tailoring, and outreach.
> Claude reads this file for every daily pull, every resume tailor, and every cold email.
> Resume **content** comes from `resumes/master/Master_Resume_ATS.tex`; **layout** comes from the frozen template `resumes/templates/Onkar_Template.tex`. This file holds the **rules**.

---

## 1. Identity Snapshot

- **Name:** Onkar Jadhav
- **Title:** AI / Full-Stack Software Engineer
- **Location:** Pune, Maharashtra, India
- **Education:** B.Tech Computer Science, PCCOE (9.17 CGPA), graduating Jun 2026
- **Email:** onkarj012@gmail.com · **GitHub:** github.com/Onkarj012 · **LinkedIn:** linkedin.com/in/onkarj012
- **Headline products:** Stride (shipped, in use), Lore Engine, StockXpert, GovBench, PromptForge

---

## 2. Targeting

> Used for **fit-scoring** at pull time. Edit freely — this drives which jobs get a high Match Score.
> Items marked `[CONFIRM]` are assumptions — correct them.
> Company **stage** (startup / mid / big tech) is intentionally varied at sourcing time via `companies.json` and the dork queries in `skills/daily-job-pull` — see § 6/§ 7. Role targets below stay fixed regardless of stage.

### Target titles
**Strict families:**
- AI / LLM / Generative AI / Agentic AI Engineer
- Machine Learning / Applied ML Engineer
- Full-Stack Engineer (AI-leaning)
- Backend / Python Engineer
- Software Engineer — New Grad / Graduate / Associate / Entry
- Paid engineering internships in the same families

**Shortage fallback only:** adjacent engineering titles such as Application, Platform, Data, Solutions, Forward-Deployed, or Research Engineer when the work is substantively aligned.

### Level
- **Strict:** Entry-level / Fresher / New-grad with a hard requirement of 0–1 yr (including `1+ year`).
- **Shortage fallback:** hard requirement up to 2 yrs. A hard minimum of 3+ yrs is never eligible.

### Work mode & location
- **Onsite / hybrid:** Pune metro only — Pune, Pimpri-Chinchwad/PCMC, Hinjawadi/Hinjewadi, Wakad, Baner, Kharadi, Magarpatta, Viman Nagar, Talawade, and nearby Pune tech corridors.
- **Remote:** must explicitly permit India, APAC/Asia-Pacific, or worldwide/global participation without excluding India. Bare `Remote` or US/Canada/EU/UK/LATAM-only → drop.

### Employment type & must-haves
- Full-time engineering roles or explicitly paid/stipended engineering internships.
- Real engineering work (AI/ML, backend, full-stack, or an approved adjacent fallback with substance).
- Unpaid, equity-only, commission-only, volunteer, part-time, and contract roles → drop.

### Hard gates (run first, every pull — fail any → drop, never written to Notion)
1. **Location authorization** — onsite/hybrid must offer Pune metro; remote eligibility must explicitly include India/APAC/worldwide-with-India-ok.
2. **Seniority** — hard minimum of 3+ yrs → drop. Two-year requirements are shortage fallback only.
3. **Employment / paid** — allow full-time or explicitly paid internship; disallowed/unknown-pay internships → drop.
4. **Freshness evidence** — freshness is a ranking class, not a 72h cliff. Classes: `Hot` 0–72h · `Active` >72h–7d · `Backfill` >7d–14d (eligible only if never surfaced before) · `VerifyQueue` undated (excluded from auto-selection, surfaced separately for manual date verification) · `Rejected` >14d → drop.
   - **Workday exception:** `*.myworkdayjobs.com` `postedOn` bumps on internal req refresh and does not reliably reflect true listing age. Workday-sourced `postedAt` without a corroborated original date is treated as undated → `VerifyQueue`. Ashby/Lever/Greenhouse dates stay trusted as-is.
5. **Liveness** — confirmed dead/expired → drop. Inconclusive checks stay `Not Verified`, never invented as Active.
6. **Cross-day suppression** (opportunity ledger, `career-ops/data/opportunity-ledger.tsv`) — applied/contacted/interviewing/rejected requisitions never resurface; surfaced-but-unactioned roles get a 7-day cooldown; a Workday refresh is the same requisition, not a new opportunity.

Mechanical values and aliases live in `config/job-pull.json`; this section is the human-readable policy. Everything else (stack fit, role flavor, pure-frontend-ness, etc.) is **soft** — it lowers Skill match / Domain relevance in § 3, not a gate.

### Salary
- `[CONFIRM]` Floor: ______ (LPA). Leave blank = don't filter on comp.

---

## 3. Scoring Rubric (0–100)

Hard gates (§ 2) run first and drop disqualified roles before scoring. Survivors get a weighted sum across 5 dimensions:

| Dimension | Weight | What it measures |
|---|---|---|
| **Skill match** | 35 | Overlap between JD's required skills and my stack (Python, TS, React/Next, FastAPI, RAG, agentic AI, ML, pgvector, etc.) |
| **Domain / role relevance** | 20 | Is the actual work AI/ML/backend/full-stack vs off-target |
| **Seniority fit** | 15 | Entry/fresher friendly = high; senior-only (but under the 3-yr gate) = low |
| **Location / remote fit** | 10 | Remote-India / Pune / hybrid = high; onsite-abroad = low |
| **Response Likelihood** | 20 | Small company (<200 ppl) + posted <48h + ≥70% skill match + ATS-direct source = high. Big company + stale posting + aggregator source = low. |

**Soft-score-down signals (drag Domain/Skill, not a gate):** pure frontend-only / pixel-pushing roles, non-technical/sales/support roles, hard requirement of a stack with zero overlap to mine that dominates the role.

- **Recency** is tracked separately via freshness classes: `Hot` 0–72h · `Active` 3–7d · `Backfill` 8–14d. Fresher class wins ranking ties; older classes fill shortages. Undated roles go to the `VerifyQueue` for manual verification; >14d fails the gate.
- Output per job: integer 0–100 + a one-line rationale + the **single strongest hook** to lead the resume/email with + an `Auto-Suggest` boolean (see rule below).
- Target **25–35 curated roles** (sprint volume), with **at least 10 Strict when inventory supports it**. Selection order: Strict Hot → Strict Active → Strict Backfill → Shortage Fallback Hot → Fallback Active → Fallback Backfill.
- Shortage fallback may relax only adjacent title and hard experience requirement up to 2 years. Display it separately with exact relaxation; never hide a strict shortfall.
- Diversity after scoring: maximum 2 roles per company; balance role families, aiming for ≥4 families and ≤40% from one family when eligible alternatives exist.
- **No auto-apply.** Present ranked list; Onkar reviews and picks ~7–8/day. `Apply?` checkbox is manual — never auto-checked.

**Score bands (guidance, not gates):**
- 80–100: strong fit, tailor immediately.
- 65–79: solid, tailor if hook is good.
- 50–64: stretch, only if low day-volume.
- <50: skip unless special reason.

**Auto-Suggest rule:** `score ≥ 80 AND Freshness Window ∈ {Hot, Active} AND Selection Tier = Strict AND Response-Likelihood sub-score ≥ 14/20`. This sets the `Auto-Suggest` checkbox (cloud's pick opinion) — it never sets `Apply?`; the user always confirms manually.

---

## 4. Resume Tailoring Rules

### Quality objective
- Preserve the current visual template and its typography, spacing, and overall character. Improve the writing and evidence system, not the preferred look.
- Every final resume must still extract in a clean, linear ATS reading order. Visual styling may never detach a title, organization, date, location, or bullet from its section in extracted text.
- The deliverable is a final **PDF**. The `.tex` source remains editable in `resumes/sources/`, but a tailoring run is not complete until its PDF passes every gate below.

### Structure (fixed)
1. **Heading** — unchanged.
2. **Summary** — rewritten per JD to lead with the strongest truthful hook and the role's highest-value language without becoming a keyword list.
3. **Experience** — **Stride is ALWAYS here** (it's a shipped product in use):
   - Title: **Lead Engineer**
   - Dates: **April 2026 – Present**
   - Lead bullet states traction (production, active trial users) — see content rules.
4. **Projects** — **exactly 2**, picked from the pool by best JD-keyword match:
   - Pool: **Lore Engine, StockXpert, GovBench, PromptForge**
   - (Vaani excluded — too little owned detail.)
5. **Technical Skills** — reorder so JD-relevant categories surface first; never invent skills not on the master.

### Role-family base profile
- Select one structured starting profile from `resumes/profiles/` before drafting: `ai-product-full-stack`, `full-stack-backend`, or `applied-ml-ai`.
- Profiles govern selection and ordering only. They are not resume templates, do not override the JD matrix, and never authorize a claim outside `resumes/master/Master_Resume_ATS.tex`.
- Record the selected profile in the requirement-matrix and claim-provenance sidecars described in `resumes/evidence/README.md`.

### JD requirement matrix (mandatory and dominant)
Before selecting projects or rewriting any line, build an auditable matrix with one row per distinct JD requirement:

| Exact JD phrase | Required / preferred | Category | Approved evidence source | Target section | Resume wording | Covered / missing |
|---|---|---|---|---|---|---|

- Categories must distinguish hard skill/tool, responsibility, domain language, qualification, outcome, and role/title language.
- `Approved evidence source` must identify the exact master-resume bullet or skill entry that supports the wording. A vague project-level reference is insufficient.
- Cover **every truthfully supportable hard requirement**. Put the highest-value required keywords in evidence-bearing Experience or Project bullets when the master supports them; listing a keyword only in Technical Skills is not substantive coverage.
- Use the JD's exact phrase once when truthful and natural, then use clear variants only when useful. Keyword matching never overrides readability or truth.
- Mark unsupported or ambiguous requirements `Missing`, report them as real gaps, and never fabricate a skill, achievement, metric, responsibility, qualification, or keyword to close them.
- Retain the completed matrix beside the tailored source as `<stem>.matrix.md`, using the exact contract in `resumes/evidence/README.md`. The matrix is complete only when every distinct requirement has a `Covered` or `Missing` decision.

### Claim provenance and truthfulness
- Every tailored achievement and capability claim must map to an approved bullet or skill in `resumes/master/Master_Resume_ATS.tex`.
- Reframe, reorder, shorten, or combine only when the resulting meaning remains equivalent to the source evidence.
- Do not convert a target, design capacity, prototype, benchmark, planned feature, or tool familiarity into a shipped achievement or production result. This is **capability-to-achievement inflation** and is forbidden.
- Never strengthen qualifiers or scope. Examples: `designed to scale to` cannot become `scales to`; `prototype` cannot become `production`; `supported` cannot become `owned`.
- If a stronger JD-aligned statement lacks approved evidence, leave the requirement missing and report it.
- Retain `<stem>.provenance.md` beside the tailored source. It maps each factual summary sentence, bullet, and skills claim to the stable evidence locator in `resumes/evidence/approved-evidence.md`; the locator's master anchor must still exist at verification time.

### Human writing and language pass (mandatory)
- Write like a precise engineer describing work they personally understand. Prefer concrete actions, decisions, constraints, and outcomes over promotional commentary.
- Use perfect grammar, spelling, punctuation, tense, capitalization, and parallel structure. Use **consistent US English** throughout.
- **Do not use em dashes in any resume bullet point or sentence.** Rewrite with a period, comma, colon, semicolon, or parentheses. The final source scan must reject both the Unicode em dash (`—`) and LaTeX triple hyphen (`---`) anywhere in resume prose.
- Run both lexical and semantic repetition passes across Summary, Experience, Projects, and Technical Skills. Remove repeated claims even when paraphrased.
- The same opening verb may appear at most twice across all achievement bullets. Replace generic repeated openers with accurate, specific verbs.
- Do not repeat the same technology list in the Summary, multiple bullets, and Technical Skills. Mention a stack where it proves an action, then keep the canonical inventory in Technical Skills.
- Avoid AI-writing habits: inflated verbs without evidence, adjective stacks, unnecessary explanatory tails, self-congratulatory claims, JD commentary, repeated `demonstrating`/`showcasing`/`enabling` clauses, and mechanically uniform bullet structures.
- Prefer one core achievement per bullet. Keep sentences direct and interview-defensible; split or trim overloaded bullets rather than stacking multiple claims.

### Hard constraints
- **Exactly ONE visually balanced page.** No conspicuous dead zone, overflow, crowding, or tiny type. Never lengthen a bullet, add a weak claim, repeat a keyword, or pad the summary solely to occupy space. If overfull, trim the weakest content first; if underfilled, improve selection and spacing within the liked template without inventing or padding content.
- Total project slots on page = **3** (1 Stride experience block + 2 projects). Never more, never fewer.
- Never fabricate. Only reframe / reorder / select from the approved master sources with claim provenance.
- Mirror the JD's vocabulary where truthful and evidence-backed.

### Project picker logic
1. Extract JD's core themes (RAG / retrieval → Lore Engine; ML/DL/quant → StockXpert; AI safety/eval/governance → GovBench; agentic/prompt pipelines → PromptForge).
2. Rank 4 projects by keyword overlap with JD.
3. Take top 2. Tie-break toward variety (don't show two near-identical projects).

### Quality gates (all mandatory)
1. **Content gate**
   - Every claim has approved master-bullet or skill provenance in a complete provenance sidecar, and no capability-to-achievement inflation.
   - Human-writing, perfect-grammar, consistent-US-English, no-em-dash, lexical-repetition, and semantic-repetition passes succeed.
   - Opening verbs and repeated technology lists satisfy the rules above.
2. **JD gate**
   - The requirement-matrix sidecar is complete and records its selected role-family profile.
   - Every truthfully supportable hard requirement is covered in natural, evidence-bearing wording.
   - Unsupported requirements are explicitly reported as missing rather than inserted.
3. **Artifact gate**
   - Compile locally and pass `node tests/resume/verify.mjs <source.tex> <output.pdf>`, which checks template conformance, evidence-sidecar shape and locators, source/PDF freshness, exact page count, page fill, text extraction, expected links, embedded fonts, and glyph anomalies.
   - Render the PDF and inspect it visually for spacing, clipping, collisions, detached bullets, stray glyphs, and broken links.
   - Extract the PDF text and verify clean linear reading order, section order, contact details, title/organization/date/location association, and JD coverage.
   - Check clickable links, embedded/substituted fonts, glyph rendering, and compilation-log warnings. Treat text-extraction, font, glyph, or layout warnings as failures until explained and resolved.
   - Run the grammar and repetition checks again on extracted PDF text, including the Unicode `—` and LaTeX-source `---` scan.
   - Promote only the verified PDF, then delete all scratch artifacts.

### ATS reporting
- An internally derived assessment must be labeled **ATS readiness**, not an ATS score, and must explain its evidence and limitations.
- Report a numeric ATS score only when it comes from a named external parser such as Enhancv. Record the tool, target JD, date, and result so comparisons use the same conditions.

### Output
- Editable source: `resumes/sources/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.tex`, with same-directory `.matrix.md` and `.provenance.md` audit sidecars.
- Final PDF (PDF-only folder): `resumes/output/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.pdf`
- Compile locally (BasicTeX) into `resumes/sources/build/` scratch, pass the content, JD, and artifact gates before declaring done, copy only the final `.pdf` to `resumes/output/`, then delete all build artifacts (`.aux/.log/.out` and the scratch PDF). `resumes/output/` holds `.pdf` only.

---

## 5. Outreach

> Cold email only on **explicit request** ("draft cold email for X"). Never auto-generate drafts.

### Cold email template
- **Length:** 120–150 words.
- **Structure:**
  1. **Hook** — specific to their company/role/product (not generic).
  2. **Proof** — ONE best-matching project, one sentence, concrete result.
  3. **Soft CTA** — 15-min chat, low pressure.
- **Tone:** direct, no fluff, no over-flattery.
- **Output:** Gmail draft via `create_draft` (Onkar reviews + sends manually). Log link in Outreach DB.

**Skeleton:**
```
Subject: <Role> — <one sharp differentiator>

Hi <Name>,

<1 sentence: specific thing about their team/product + why it pulls me.>

<1 sentence: strongest matching project + a number/result.>

<1 sentence: soft ask — open to a 15-min chat?>

Thanks,
Onkar
<phone> · github.com/Onkarj012
```

### Follow-up
- Trigger: **4 days** after send, no reply.
- **One** follow-up only, then drop. Keep it 2–3 sentences, reference the original.
- Surfaced as a flagged list; Onkar reviews, Claude drafts.
- (Follow-up tracking configured now; primarily used for cold-email flow.)

---

## 6. Workflow Commands (chat triggers)

| Say | Claude does |
|---|---|
| "morning" / `/morning` | Manual once-daily routine: discovery leads → Strict and fallback sections → readiness/composition handoff → due-follow-up evidence. Discovery and surfacing only, never applies |
| "pull today's jobs" / `/pull-jobs` | Tracked + warm reverse ATS + public sources + optional Indeed → normalize → gate → freshness/dedup → Match and Conversion Score → 25–35 local leads plus a verified-original-ATS ten-role shortlist when inventory supports it |
| "follow-ups?" / `/followups` | Read user-supplied tracker/ledger evidence against the 3/7-day application, 4-day outreach, and 1/3-day conversation cadence → draft only on request, never send |
| "make applications" / `/make-applications` | Local-only: build an evidence-backed, verifier-passed PDF for each manually selected JD; leave application state and tracker changes to the user |
| "tailor for <row/company>" / `/resume-latex` | Read JD → select profile and two supported projects → create matrix/provenance sidecars → compile and verify one-page PDF |
| "check my resume" / `/resume-check` | Brutal recruiter review of the `.tex` source vs a pasted JD (or generic fallback) → per-section gaps + rewrites + overall verdict |
| "quick add this job" / `/quick-add` | Capture → gate/dedup → Match and Conversion Score → propose a local lead record with explicit readiness status |
| "draft cold email for <company/contact>" | Draft one evidence-backed human message only when requested; never send or claim contact |

- **Pull sources:** tracked `career-ops/scan.mjs`; full reverse `scan-ats-full.mjs` across Greenhouse/Lever/Ashby/Workday; YC/a16z and dated public feeds; WebSearch across ATS domains, LinkedIn, Naukri, Wellfound, Instahyre, and company careers; every `companies.json` slug; Indeed MCP when connected. Unavailable sources are reported, never assumed.
- **Trigger:** manual once daily — run `/morning` or `/pull-jobs`. No cron is configured. Add automation only when Onkar asks later.
- **Discovery restrictions:** no email ingestion, logged-in/computer-use portal browsing, application submission, or outreach action.
- **Dedup:** canonical URL → provider+Job ID → normalized company/title/location → local write ledger → JD fingerprint where description exists. `fingerprint-core.mjs` supplies SimHash; `detect-reposts.mjs` is a separate repost-pattern report.
- **Watchlist growth:** propose a verified ATS+slug addition for manual approval; never alter `companies.json` as a side effect of a lead or application state.

---

## 7. Pointers

- Resume content SoT: `resumes/master/Master_Resume_ATS.tex` · layout SoT (frozen, cp-then-edit-slots): `resumes/templates/Onkar_Template.tex`
- Tailored `.tex` sources: `resumes/sources/<YYYY-MM-DD>/` · compile scratch: `resumes/sources/build/`
- Final PDFs (PDF-only): `resumes/output/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.pdf`
- Sourcing watchlist: `companies.json` (project root) — manually approved company/ATS/slug list for Layer 2 fetch
- Discovery/hygiene engine (harvested from career-ops — library, **not** a tracker; `career-ops/data/*` is run cache only):
  - Config (user layer, survives `update-system.mjs`): `career-ops/portals.yml`, `career-ops/config/profile.yml`, `career-ops/cv.md` (stub — resume SoT stays the `.tex` masters)
  - Tracked scan: from `career-ops/`, `node scan.mjs --dry-run --json`
  - Full reverse ATS: `node scan-ats-full.mjs --ats greenhouse,lever,ashby,workday --since 3 --dry-run --json`
  - Browserless liveness: `node check-liveness.mjs --api-only --json ...`
  - Fingerprint dedup primitive: `career-ops/fingerprint-core.mjs`; repost pattern report: `node detect-reposts.mjs --summary`
  - Follow-up cadence logic: `career-ops/followup-cadence.mjs`
- Tracking: Notion `Job Search` page → Companies / Applications / Outreach DBs
  - Page: https://app.notion.com/p/3885c2b5d1b081458df2c68954540105
  - Applications data source (v3, archived — read-only history, no new writes): `d8d525b0-e436-44b7-ae65-28c08a358684`
  - Companies data source: `9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d`
  - Outreach data source: `bf40caf6-8b07-4c55-9d21-787b8033f454`
  - **Applications v4 (current, source of truth as of 2026-07-09):** built per `NOTION_V4_SETUP.md`, all 44 open v3 rows migrated in, v3 DB renamed "Applications (v3 archive)".
    - Applications v4 data source: `7bc3de3a-91d9-4391-8b22-9e68b264e8d2` (DB page: https://app.notion.com/p/d7db471ca1fb4686868b4ca4c9f56824)
    - Activity data source: `76a31def-a145-45db-9b82-0c263b80ab1b` (DB page: https://app.notion.com/p/abe8d58130844fd480c24b4edb285dee)
    - Adds vs v3: `Fingerprint`, `Liveness`, `Liveness Checked`, `Freshness`, `Next Follow-up`, `Follow-up Count`, `Last Activity`, `Hook`, `Rationale`, `Experience Asked`, `CTC/Salary`, `Work Mode`, richer `Status`/`Resume Status`; `Activity` DB replaces ad-hoc follow-up tracking with a dual-relation log.
    - Views: Today's Pull, To Apply, Follow-up Due, Pipeline (board), Archive (Applications v4); Due (Activity).
  - **Conversion-plan additions (approved and applied 2026-07-21, see `conversion/SCHEMA_PROPOSAL.md`):** Applications v4 gained `Original ATS URL`, `Original ATS Verified At`, `Application Readiness`, `Conversion Score`, `Resume Variant`, `Submitted Answers Path`, `Recruiter Contacted`, `Hiring Manager Contacted`, `Referral Requested`, `First Follow-up Date`, `Second Follow-up Date`, `First Human Response Date`, `Interview Stage`, `Rejection Timing`, `Rejection Reason`, `Source Category`, `Proof-of-Fit Path`, and a `Referrals` relation. Outreach gained `Contact Role`, `Contact Channel`, `Sequence Stage`, `Last Contact Date`, `Next Eligible Contact`, `Duplicate Guard`, `Response Outcome`. Activity gained `Source Category`, `Resume Variant`, `Rejection Timing`, `Evidence Link`, and its `Type` select expanded with `Recruiter Screen`, `Technical Interview`, `Assessment`, `Profile View`, `Resume Download`, `Rejection`.
    - **Referrals (new, dedicated DB):** `Person`, `Application` (dual relation to Applications v4), `Relationship Signal`, `Requested At`, `Response`, `Referral Submitted At`, `Outcome`, `Notes`. Data source: `346c1a15-3808-4e4a-bcb7-8d24f0ea597a` (DB page: https://app.notion.com/p/c72c4997616745428d28e7340336d32d).
    - The local TSV templates (`conversion/templates/*.tsv`) and `conversion/report.mjs` still work standalone; nothing in the pipeline writes to these new Notion fields automatically yet — skills that populate Applications v4 rows should start filling them in going forward.
- Skills (project-scoped, single-slash): `.agents/skills/morning`, `.agents/skills/daily-job-pull`, `.agents/skills/application-readiness`, `.agents/skills/make-applications`, `.agents/skills/conversion-ops`, `.agents/skills/proof-of-fit`, `.agents/skills/interview-loop`, `.agents/skills/followups`, `.agents/skills/application-agent`, `.agents/skills/resume-latex`, `.agents/skills/resume-check`, `.agents/skills/quick-add`
- Integration plan: `PLAN_career_ops_integration.md` (why harvest-not-migrate + build phases)
- Reference prompt (not a skill): `prompts/deep-job-search.md`
