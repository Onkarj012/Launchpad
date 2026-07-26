# Sprint plan: offer (or final rounds) by 2026-07-31

Synthesized 2026-07-18 from gpt-5.6-sol strategic review (read repo code) + gpt-5.6-luna web research (sources with links). Full raw reports: sol → strategy/pipeline critique; luna → channel research + 15 live leads (§ Leads below).

## Verdict

Discovery is NOT the bottleneck. Converting discovered roles into human conversations is. Current policy (72h hard gate, 7-8 applications/day, enterprise-heavy shortlist) gives <10% chance of an offer by Jul 31. Managed target: **human conversations by Jul 22-24**, 150 applications + 100 targeted messages over 14 days, 1-3 final-round processes as the realistic outcome, offer as stretch.

## P0 — pipeline bugs (confirmed in code)

1. **Undated ⇒ eligible:true** — `job-pull/freshness.mjs:23` returns eligible for undated records; `job-pull/select.mjs:134` has an explicit `undated` selection phase. Contradicts documented gate. Fix: freshness classes `Hot (0-72h) / Active (4-7d) / Backfill (8-14d) / Verify-queue (undated, manual verify before entry) / Rejected (>14d or dead)`.
2. **Geo tokens over-match** — `job-pull/eligibility.mjs:52` scans whole description for `global`/`anywhere`; "anywhere in the US" passed. Fix: parse structured location + the work-location sentence first; explicit US-only/US-auth denial hard-fails and overrides any generic token.
3. **Missing experience ⇒ Strict 0-1yr** — `job-pull/eligibility.mjs:135`. Fix: Strict only on positive evidence (fresher/graduate/entry/associate/junior/0-1yr); else `manual review`. Hard-reject Senior/Staff/Lead/Principal titles.
4. **Workday refresh ≠ new posting** — mark `Freshness: Unverified` unless original date corroborated.
5. **Identity conflict** — CLAUDE.md says CGPA 9.17; master_prompt.md:11 says 9.08 + "graduating". One verified value everywhere. **← Onkar must confirm.**

## P1 — sprint policy (for these 14 days)

- **Freshness = ranking signal, not hard gate.** 0-3d full score; 4-7d small penalty; 8-14d penalized but eligible if never surfaced; >14d reject (except open graduate drives).
- **Volume:** 25-35 new verified leads/day; **12-16 submitted applications/weekday** in tiers: A (4-5/day, bespoke resume + human outreach) · B (6-9/day, role-family variant) · C (2-3/day, apprenticeship/staffing/safe C2H).
- **Widen titles:** AI portfolio is the hook, not the filter — include backend Python, full-stack, general new-grad SWE, AI-application, data/platform-with-Python.
- **Controlled C2H lane:** ≥6 months, named payroll entity, written terms, no candidate fee/bond.
- **Startup quota → outreach target:** 30-40% of outbound messages to Indian startups; stop forcing stale listings into shortlist.
- **Cadence:** referral ask → remind after 2 business days; founder/EM/recruiter → follow up after 3; A-tier application → follow up after 3. (Replaces 4-day cold-email cadence for sprint.)
- **Cross-day suppression:** opportunity ledger (every canonical requisition, surfaced once) + action ledger (applied/contacted/interviewing). Surfaced-unapplied → 7-day cooldown. Applied → never re-surfaces. Workday refresh ≠ new opportunity.

## P2 — source rebalance

Add (luna verified actors exist with real posted-date fields):
- **Foundit** — `scrapesage~foundit-scraper`: posted/freshness/closing-date fields, `freshnessDays` input, region/locations/experience filters. Luna's best fresher-AI-Pune leads all came from Foundit.
- **Internshala** — `automation-lab~internshala-scraper` (245 users): `postedAt`, `searchMode: jobs|internships`. Separate paid-internship lane only.
- **Hirist** — `logiover~hirist-tech-scraper` (66 users): `postedAt`, experience band `0-2`, cities.
- **CutShort** — `getascraper~cutshort-scraper` exists but no postedAt (only scrapedAt) → treat like YC: leads-for-outreach, not dated inventory. Platform itself worth a candidate profile (claims 60-min priority shortlists).
- **Instahyre** — no Apify actor exists. Candidate-profile play only.
- **Naukri** — expand: 0-1 and 0-2 queried separately, 7-day window, add keywords `associate junior trainee graduate GenAI Python FastAPI Django backend software developer`. Daily profile refresh (recruiter DB searches reward freshness).

Reduce: EchoJobs (weekly probe until 403 fixed) · Wellfound (2×/week) · YC (undated → founder-outreach leads) · LinkedIn bulk (focus Entry/Associate/Graduate tags; main value = finding the humans attached to roles) · full reverse-ATS (weekly; warm scan daily) · rebuild watchlist India-first.

Never weaken: geo authorization, true 3+yr rejection, no unpaid/fee roles, no fabrication, no auto-apply.

## Channels ranked for 14-day conversion (luna + sol agree)

1. Warm referrals / PCCOE alumni + TPO + faculty (apply directly if no response in 12h)
2. Startup founders/EMs — demo-led message (Stride/Lore Engine hook + 15-min CTA)
3. Naukri — same-day applies, phone reachable 09:30-19:00, return recruiter calls <15 min
4. Direct company ATS (necessary, slow — don't expect close in 10 working days)
5. Staffing/C2H — TeamLease Digital, Randstad; Appia (claims 48-72h onboarding, Pune AI/Python)
6. Walk-ins (Naukri walk-ins, Foundit Pune walk-ins, Freshersworld — check daily) + NCS/NATS drives
7. LinkedIn applications (lowest priority as applications; highest as people-finder)

## 14-day cadence (compressed)

| Phase | Days | Apps/day | Outreach/day | Focus |
|---|---|---|---|---|
| Setup | Jul 18-19 | 8 | 10 | Fix profile facts, 4 role-family resumes, 60-company target list, all platform profiles (Naukri/CutShort/Instahyre/NCS/NATS), founder messages |
| Push 1 | Jul 20-21 | 16 | 12 | Submit before noon; referral asks w/ requisition IDs; recruiter contact on A-tier |
| Checkpoint | Jul 22 | 14 | 8 | <3 screens ⇒ double Naukri/alumni/staffing/founders, cut generic ATS |
| Staffing + gate | Jul 23-24 | 12 | 6-8 | C2H day; week-1 gate: 86 apps, 66 msgs, ≥5 screens or shift 40% to backend/general SWE |
| Startup wknd | Jul 25-26 | 6-8 | 4-8 | Demo-led founder outreach; rejection-pattern review; interview prep |
| Push 2 | Jul 27-28 | 12-14 | 8-10 | Follow-ups; protect interview time; confirm staffing terms |
| Final gate | Jul 29 | 10 | 6 | 136 apps/94 msgs cumulative; no final-stage ⇒ concentrate on urgent startup/staffing/drives |
| Close | Jul 30-31 | 6-8 | 2-4 | Next-steps asks, documents ready, offer verification (employer, comp, bond, notice) |

Daily rhythm: 07:30-09 triage · 09-12 A-tier + referrals · 12-14 B/C-tier · 14-19 calls/interviews (reachable) · 19-21 prep · 21-21:30 tracker.

Outreach message = exact role + one proof point + one link + 15-min CTA. One hook per message (Stride=shipped product; Lore Engine=backend/RAG; StockXpert=ML; GovBench=eval; PromptForge=agentic).

## Immediate leads (luna, verify before applying)

Priority: **Keywords Studios/Helpshift** (AI Engineer fresher, Pune, ~10d old, RAG/LangChain) · **VISDIN Solutions** (Junior AI Agent Dev, Pune, posted Jul 6, apply-by Aug 5) · **Onelab Ventures** (AI Native Engineer, Pune, fresher, RAG/agents) · **ergobite** (AI/ML Engineer, Pune, RAG/agentic) · **Setoo** (AI/ML intern → conversion, Pune) · **StatusNeo** (Junior AI/ML remote, 2026 grads, unverified). Full list with links in luna report.

## Safety

Never pay any application/training/placement fee. Verify recruiter identity. Written terms only for C2H.
