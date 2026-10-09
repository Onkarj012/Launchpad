# Master Prompt — Job Search OS

> Single source of truth for targeting, scoring, resume tailoring, and outreach policy.
> Claude reads this file for every daily pull, every resume tailor, and every requested outreach draft. Current execution status lives only in `docs/STATUS.md`.
> Resume **content** comes from `resumes/master/Master_Resume_ATS.tex`; **layout** comes from the frozen template `resumes/templates/Onkar_Template.tex`. This file holds the **rules**.

---

## 1. Identity Snapshot

- **Name:** Onkar Jadhav
- **Title:** AI / Full-Stack Software Engineer
- **Home location:** Pune, Maharashtra, India
- **Current employment:** Capgemini — A4 Analyst — Navi Mumbai — since 10 Aug 2026. In Java Full Stack (JFS) course training; no project or client work yet. Never describe this training as project, production, or client experience.
- **Education:** B.Tech Computer Science, PCCOE (9.17 CGPA), final result officially declared; degree certificate pending, 2026
- **Email:** onkarj012@gmail.com · **GitHub:** github.com/Onkarj012 · **LinkedIn:** linkedin.com/in/onkarj012
- **Headline products:** Stride (shipped, in use), Lore Engine, StockXpert, GovBench, PromptForge

---

## 2. Targeting

> Used for **fit-scoring** at pull time. Edit freely — this drives which jobs get a high Match Score.
> Company **stage** (startup / mid / big tech) is intentionally varied at sourcing time via `companies.json` and the dork queries in `.agents/skills/daily-job-pull` — see § 6/§ 7. Role targets below stay fixed regardless of stage.

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
- Preferred years never count as a hard minimum. Classification flags a hard minimum of exactly 3 years for later Stretch selection; this flag does not change Strict, Fallback, or the 3+ rejection.

### Work mode & location
- **Onsite / hybrid:** Pune-wide commute is acceptable. Pune, Pimpri-Chinchwad/PCMC, Hinjawadi/Hinjewadi, Wakad, Baner, Kharadi, Magarpatta, Viman Nagar, Talawade, Kalyani Nagar, Koregaon Park, Yerwada, Hadapsar, Mundhwa, Aundh, Pashan, Balewadi, Bavdhan, Kothrud, Shivajinagar, Senapati Bapat Road, Wagholi, Kondhwa, Undri, Pimpri, Chinchwad, Pimple Saudagar, Nigdi, Bhosari, Moshi, Sus, Maan, and Marunji count as Pune even without the word "Pune". Match whole names. Sus and Maan require Maharashtra, MH, or a six-digit 411xxx/412xxx pin code in the same location option. Chakan, Talegaon, Ranjangaon, and Shikrapur are excluded even when their address says Pune. Multi-city listings pass with a separate eligible Pune option.
- **Remote:** India and APAC/Asia-Pacific remain eligible. Remote roles marked worldwide, anywhere or global pass when the listing states no country limit and requires no foreign work authorization; label them `Remote: worldwide, no country limit`. US/Canada/EU/UK/LATAM-only roles and roles requiring foreign work authorization → drop. Bare `Remote` → drop. US or EU hours and overnight-only overlap are allowed with the label `Night hours (IST)`.
- **Shifts:** night and rotating shifts are allowed for Pune onsite/hybrid and remote roles with the label `Night hours (IST)`. A label never rejects a role.
- **Notice:** listings asking for immediate joiners or a notice of 30 days or less are allowed with the label `Notice risk`. A label never rejects a role.

### Employment type & must-haves
- Full-time engineering roles or explicitly paid/stipended engineering internships (stipend ≥ ₹40k/month with a stated PPO path). This bar also applies to the AICTE and NATS avenue.
- Real engineering work (AI/ML, backend, full-stack, or an approved adjacent fallback with substance).
- Unpaid, equity-only, commission-only, volunteer, part-time, freelance per-task, training-fee, bonded, and agency-resale-without-named-client roles → drop.
- EOR employment for a foreign company that hires in India is labelled `EOR` and shown only in the separate EOR/Contract lane.
- Long-term contracts are eligible only with full-time hours, ongoing or at least six months, stated fixed pay, and direct hire by the company. Label them `Contract` and show them only in the separate EOR/Contract lane. Explicitly missing fixed pay or terms that fail these conditions are dropped; unknown terms go to verification.
- EOR and Contract roles never enter the full-time or internship lanes or their targets.

### Company rules

- Capgemini roles are excluded, including AI and product engineering roles. Reason code: `COMPANY_EXCLUDED`.
- TCS, Infosys, Wipro, Cognizant, Accenture, HCL, Tech Mahindra and LTIMindtree pass only for AI/ML or product engineering titles. Generic services titles are rejected with `SERVICES_MAJOR_GENERIC_ROLE`, even when the description mentions AI or product work. Other companies are unaffected by this rule. All other gates still apply.

### Hard gates (run first, every pull — fail any → drop, never written to Notion)
1. **Location authorization** — onsite/hybrid must offer a Pune-wide location option; remote eligibility must explicitly include India or APAC, or be worldwide/anywhere/global without a country limit or foreign work-authorization requirement.
2. **Seniority** — hard minimum of 3+ yrs → drop. Two-year requirements are shortage fallback only.
3. **Employment / paid** — allow full-time roles and engineering internships with a stated stipend ≥ ₹40k/month and a stated PPO path in the full-time lanes. EOR and qualifying long-term contracts use their separate lane; contract terms that fail are dropped and unknown terms go to verification. Missing, unverified, or below-floor internship stipend and missing PPO path → drop.
4. **Freshness evidence** — freshness is a ranking class, not a 72h cliff. Classes: `Hot` 0–72h · `Active` >72h–7d · `Backfill` >7d–14d (eligible only if never surfaced before) · `VerifyQueue` undated (excluded from auto-selection, surfaced separately for manual date verification) · `Rejected` >14d → drop.
   - **Workday exception:** only a usable DETAIL `startDate` is trusted as Workday freshness evidence. LIST `postedOn`, including bounded labels such as `Posted Today`, is not sufficient and stays undated → `VerifyQueue`. Ashby/Lever/Greenhouse dates stay trusted as-is.
5. **Liveness** — confirmed dead/expired → drop. Inconclusive checks stay `Not Verified`, never invented as Active.
6. **Cross-day suppression** (opportunity ledger, `career-ops/data/opportunity-ledger.tsv`) — applied/contacted/interviewing/rejected requisitions never resurface; surfaced-but-unactioned roles get a 7-day cooldown; a Workday refresh of the same provider+requisition is the same opportunity, not a new one. Distinct requisitions at the same company/title/location stay distinct.
7. **Company** — apply the Company rules above before scoring.

Mechanical values and aliases live in `config/job-pull.json`; this section is the human-readable policy. Everything else (stack fit, role flavor, pure-frontend-ness, etc.) is **soft** — it lowers Skill match / Domain relevance in § 3, not a gate.

### Salary
- **Minimum compensation filter:** ₹5.5 LPA. Filter out roles with disclosed compensation below ₹5.5 LPA; undisclosed compensation remains `Not Verified`. Internships use the separate stipend and PPO bar above.

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
- Output per job: five integer component scores within their rubric weights, their deterministic sum 0–100 + a one-line rationale + the **single strongest hook** to lead the resume/email with + an `Auto-Suggest` boolean (see rule below).
- Selection Tier is `Strict` or `Fallback`; `Backfill` names only the 8–14-day freshness class. Target **10 minimum, 12 preferred, 20 maximum verified scored roles per IST day across modes and schedules**, with **at least 10 Strict when inventory supports it**. Selection order: Strict Hot → Strict Active → Strict Backfill → Fallback Hot → Fallback Active → Fallback Backfill.
- Shortage fallback may relax only adjacent title and hard experience requirement up to 2 years. Display it separately with exact relaxation; never hide a strict shortfall.
- Verified daily selection requires a retained JD and evidence of full-time employment or an internship meeting the stipend and PPO bar; summary-only records stay in verification. Unknown numeric experience may still be manual review when the JD passes the hard gates.
- Explicit `--scores-json` inputs remain a labelled manual scoring seam. Legacy totals require whole points and a valid Response Likelihood; missing JD caps them at 45. Source scores never establish model output. Runtime and cached model results require all five components, matching Response Likelihood, total, and JD-availability flag. Rationale and hook must refer to supplied JD and approved resume evidence. Structural validation does not prove semantic truth.
- Morning and midday share a cumulative 20-role daily ceiling. Completed local plans consume daily capacity; retries reuse their run allocation. A shortage never relaxes eligibility, verification, or scoring gates.
- One shared daily crawl and scoring pass feeds Pune (`normal`), Startup and Remote. Each mode returns its full verified results list and a shortlist. Assign each role once, with primary-mode order Startup, then Pune, then Remote; `otherModes` tags name any other modes it fits. The requested mode remains the delivery focus.
- Diversity after scoring: maximum 2 roles per company within each mode's shortlist, including earlier allocations in that mode on the same IST day; balance role families within each Strict/freshness band, aiming for ≥4 families and ≤40% from one family when eligible alternatives exist in that band. Exhaust the band before advancing.
- **No auto-apply.** Present ranked list; Onkar reviews the daily shortlist. `Make Resume` (build-selection) and `Applied?` (progress tally) checkboxes are manual — never auto-checked.

**Score bands (guidance, not gates):**
- 80–100: strong fit, tailor immediately.
- 65–79: solid, tailor if hook is good.
- 50–64: stretch, only if low day-volume.
- <50: skip unless special reason.

**Auto-Suggest rule:** `score ≥ 80 AND Freshness Window ∈ {Hot, Active} AND Selection Tier = Strict AND Response-Likelihood sub-score ≥ 14/20`. Retain this opinion in the local report. The current v5 store schema does not declare an `Auto-Suggest` property, so planning must flag that limitation and omit the unsupported field; it never sets `Make Resume` or `Applied?`; the user always confirms manually.

---

## 4. Resume Tailoring Rules

### Quality objective
- Preserve the current visual template and its typography, spacing, and overall character. Improve the writing and evidence system, not the preferred look.
- Every final resume must still extract in a clean, linear ATS reading order. Visual styling may never detach a title, organization, date, location, or bullet from its section in extracted text.
- The deliverable is a final **PDF**. The `.tex` source remains editable in `resumes/sources/`, but a tailoring run is not complete until its PDF passes every gate below.

### Structure (fixed)
1. **Heading** — unchanged.
2. **Summary** — rewritten per JD to lead with the strongest truthful hook and the role's highest-value language without becoming a keyword list.
3. **Experience** — two entries, current employment first:
   - **Capgemini** — A4 Analyst — Navi Mumbai — Aug 2026 – Present. Frozen block: one line stating Java Full Stack (JFS) training. Never tailored per JD, never given achievement, metric, client, or project bullets, and never described as project or production experience until real assigned work exists.
   - **Stride is ALWAYS here** (it's a shipped product in use):
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
- Total substantive slots on page = **3** (1 Stride experience block + 2 projects), plus the compact frozen Capgemini employment block. Never more, never fewer.
- **Publications** (`PUBLICATIONS` slot): include **only** for research / ML-research / applied-science / quant JDs, or when a JD names publications/papers as a plus. For all other JDs, empty the slot so no `\section{Publications}` header prints. When included it competes for the one-page budget: tighten spacing or trim the weakest project bullet to stay at exactly one page — never drop a mandatory project slot or pad to fit. Two approved papers, both stock/trading deep-learning work (co-author): (1) *HybridSwingNet…* — Scientific Reports (Nature Portfolio), accepted/in press 2026; (2) *Stock Recommendations Leveraging AI/ML…* — ICT4SD 2025 (Scopus-indexed, Springer). Print exactly as in the master source; do not upgrade "accepted, in press" to "published", claim first authorship, or invent a DOI.
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
- **Output:** evidence-backed draft text and, when explicitly authorized, v5 Outreach draft state. A Gmail draft-only adapter is not currently guaranteed or implemented in the active workflow; never claim a Gmail draft exists unless an authorized adapter returns evidence. Onkar always reviews and sends manually.

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

### Follow-up (cold email)
- **Graduated** cadence, not fixed intervals (increasing gaps read as human, static ones read as automated): Day 0 initial → +3 → +7 → +7, i.e. touches on days 0, 3, 10, 17.
- **Max 2 follow-ups** per contact, then stop. Stop immediately on any reply or a "no". Mirrors the Outreach DB `Sequence Stage` (Cold → Follow-up 1 → Follow-up 2).
- Keep each follow-up 1–2 lines + one small new detail (a project update, a relevant stat) — never repeat the whole pitch.
- Seeded only after Onkar confirms he sent the initial email. Surfaced as a flagged list by `/followups`; Onkar reviews, Claude drafts, Onkar sends. Never auto-sent.
- Best send window: Tue–Thu, 8–10 AM the recipient's local time; avoid Fri evening/weekends.
- (This is the cold-email cadence. Portal-application follow-ups are separate: day 7 then day 14, max 2. That policy currently lives only here — `career-ops/followup-cadence.mjs` sits in ignored runtime state and no runtime module imports it, so treat this line as the rule.)

---

## 6. Workflow Commands (chat triggers)

| Say | Claude does |
|---|---|
| "morning" / `/morning` | Unified daily path, Normal by default; explicit Startup or Remote source emphasis. One shared crawl → shared gates/scoring/suppression → all three mode results and shortlists → requested mode's final-shortlist handoff. Never applies or sends |
| "pull today's jobs" / `/daily-job-pull` | Tracked + warm reverse ATS + public sources + optional Indeed → normalize → gate → freshness/dedup → Match and Conversion Score → a diagnostic local lead pool plus the shared 10–20 verified scored daily shortlist when inventory supports it |
| "follow-ups?" / `/followups` | Read v5 Outreach/Activity cadence evidence → draft only on request, never send |
| "make applications" / `/make-applications` | Local-only: build an evidence-backed, verifier-passed PDF for each user-checked `Make Resume` row; never check `Make Resume` or `Applied?` |
| "run outreach" / `/outreach` | Free-first contact research and evidence-backed draft preparation; persist only through an explicitly authorized v5 path. No Gmail draft or send guarantee |
| "linkedin leads" / `/linkedin-leads` | Explicit read-only hiring-post rescue. Never invoked automatically and never sends/connects/messages |
| "sync" / `/sync` | Observe user-set `Applied?` and confirmed outcomes, then synchronize idempotent v5 state. Never sets `Applied?` itself |
| "tailor for <row/company>" / `/resume-latex` | Read JD → select profile and two supported projects → create matrix/provenance sidecars → compile and verify one-page PDF |
| "check my resume" / `/resume-check` | Brutal recruiter review of the `.tex` source vs a pasted JD (or generic fallback) → per-section gaps + rewrites + overall verdict |
| "quick add this job" / `/quick-add` | Capture → gate/dedup → Match and Conversion Score → propose a local lead record with explicit readiness status |
| "draft cold email for <company/contact>" | Draft one evidence-backed human message only when requested; never send, claim delivery, or claim contact without evidence |

- **Pull sources:** tracked `vendor/career-ops/scan.mjs`; full reverse `vendor/career-ops/scan-ats-full.mjs` across Greenhouse/Lever/Ashby/Workday; YC/a16z and dated public feeds; WebSearch across ATS domains, LinkedIn, Naukri, Wellfound, Instahyre, and company careers; every `companies.json` slug; Indeed MCP when connected. Unavailable sources are reported, never assumed.
- **HN and YC trials:** seven IST dates from each configured `trialStartDate`, morning only. HN reads the current monthly "Who is hiring" thread and retains early-career Pune, India/APAC-remote and unrestricted global-remote leads. Global claims with country or foreign work-authorization restrictions do not pass the source filter. YC searches India or remote, including individual company job pages. Both require original employer evidence and the shared gates before application readiness. Global discovery alone does not change the location authorization gate. A local one-week report requires evidence on all seven dates for each source; keep/drop is advisory and never changes configuration.
- **Canonical local daily commands:** `node crawler/cli.mjs daily morning|midday --mode normal|startup|remote --location-preset india|pune`. The implementation performs one shared crawl and returns all three mode results and shortlists, with delivery focused on the requested mode; Midday Remote skips native remote feeds. `/morning` delegates to this surface.
- **Scheduling:** local launchd generation/install support exists for morning and midday. Do not claim it is installed, enabled, healthy, or production-verified without retained machine evidence. Cloud scheduling is not the active contract.
- **Discovery restrictions:** no email ingestion, logged-in/computer-use portal browsing, application submission, outreach send, or user-owned checkbox change.
- **Dedup:** canonical URL → provider+Job ID → normalized company/title/location → local write ledger → JD fingerprint where description exists. `vendor/career-ops/fingerprint-core.mjs` supplies SimHash. A separate repost-pattern report exists as `career-ops/detect-reposts.mjs`, which is ignored runtime state rather than release code; run it ad hoc, never as a pipeline dependency.
- **Watchlist growth:** propose a verified ATS+slug addition for manual approval; never alter `companies.json` as a side effect of a lead or application state.
- **Selection checkboxes (Applications v5):** `Make Resume` = Onkar's pick of rows for Claude to build resumes for (read by `/make-applications` and outreach preparation, never set by an agent). `Applied?` = Onkar's post-submission progress tally, observed by `/sync`, never set by any skill. `Auto-Suggest` = system opinion only.
- **Runtime generation:** v5 is current. v3/v4 are historical read-only systems and may supply bounded identity/history evidence only; no write, migration, fallback, archive, or delete action is permitted.

---

## 7. Pointers

### Resume
- Content SoT: `resumes/master/Master_Resume_ATS.tex` · layout SoT (frozen, copy-then-edit-slots): `resumes/templates/Onkar_Template.tex`
- Role-family profiles: `resumes/profiles/` · evidence contract and sidecar shapes: `resumes/evidence/README.md` · stable locators: `resumes/evidence/approved-evidence.md`
- Tailored `.tex` sources: `resumes/sources/<YYYY-MM-DD>/` · compile scratch: `resumes/sources/build/` · final PDFs (PDF-only): `resumes/output/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.pdf`
- Artifact verifier: `node tests/resume/verify.mjs <source.tex> <output.pdf>`

### Discovery
- Sourcing watchlist: `companies.json` — manually approved company/ATS/slug list, changed only by explicit request
- Mechanical gate values and aliases: `config/job-pull.json` (§ 2 is the human-readable policy over it)
- Opportunity ledger (cross-day suppression): `job-pull/opportunity-ledger.mjs`, backed by `career-ops/data/opportunity-ledger.tsv`
- Vendored discovery library — **release code lives in `vendor/career-ops/`**; root `career-ops/` is gitignored mutable config and run cache, never imported as release code:
  - Tracked scan: `node vendor/career-ops/scan.mjs --dry-run --json`
  - Full reverse ATS: `node vendor/career-ops/scan-ats-full.mjs --ats greenhouse,lever,ashby,workday --since 3 --dry-run --json`
  - Browserless liveness: `vendor/career-ops/liveness-browser.mjs` and `vendor/career-ops/liveness-core.mjs`
  - Fingerprint dedup primitive: `vendor/career-ops/fingerprint-core.mjs`
  - User-layer config (survives updates): `career-ops/portals.yml`, `career-ops/config/profile.yml`, `career-ops/cv.md` (stub — resume SoT stays the `.tex` masters)

### Tracking
- Launchpad v5 Applications, Companies, Outreach, Activity, and Referrals are the sole active runtime stores. Targets: `config/notion-v5.manifest.json`; gateway: `notion-v5/gateway.mjs`.
- v3/v4 identifiers, migration history, and field lists: `docs/notion-v3-v4-history.md` — read-only history, never a runtime or fallback target.
- Conversion measurement standalone tools: `conversion/report.mjs`, `conversion/templates/*.tsv`

### Skills and docs
- Skills live in `.agents/skills/`; start at the router `.agents/skills/launchpad/SKILL.md`. Guardrail vocabulary: `AGENTS.md`.
- Executable contract: `docs/SYSTEM-REFERENCE.md` · current status and open gates: `docs/STATUS.md`
- Reference prompt, run occasionally, not a skill: `prompts/deep-job-search.md`
