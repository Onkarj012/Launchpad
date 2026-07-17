---
name: application-agent
description: Run the application workflow for a single role — company research, fit scoring, tailored resume, and (on explicit request) a cold email — updating the Notion Applications row as it goes. Use whenever the user says "run the application agent", "apply to [company]", "prep my application for [role]", "let's go after this one", or picks a specific job from the tracker to pursue.
---

# Application Agent

Prepare an application package for one role. The user reviews and approves everything; **nothing sends autonomously, no auto-apply.**

Inputs: company, role, JD (link or text). If an Applications row exists, update it as you go; else create one (+ Companies row).

When the user asks "what should I apply to" or similar without naming a role, surface the **Auto-Suggested** Notion view first (score ≥ 80, fresh, high Response Likelihood — see `master_prompt.md` § 3) as the day's recommended picks, then let the user pick. `Auto-Suggest` is the cloud's opinion only — never treat it as a green light to skip user confirmation.

For a batch of already `Apply?`-checked rows (the user says "make applications" / "build resumes for today's picks"), hand off to the `make-applications` skill instead of running Steps 1-3 below one row at a time.

## Source of truth
Read `master_prompt.md` for Targeting, Scoring Rubric, Resume Rules, and Email Templates. Resume layout: `resumes/templates/Onkar_Template.tex` (single canonical template, frozen outside its tailor slots). Resume content/evidence: `resumes/master/Master_Resume_ATS.tex`.

## Steps
1. **Company research** — Indeed company data (ratings, salary, culture) + web search for recent news, funding, product, and the relevant engineering/hiring lead. Write findings to the Companies row + Notes.
2. **Fit scoring** — score 0-100 per the rubric (master_prompt.md § 3). Top 3 fit reasons, main gaps, single strongest hook. Write Match Score + the hook → Positioning.
3. **Tailored resume** — invoke the `resume-latex` skill: copy `resumes/templates/Onkar_Template.tex` into `resumes/sources/<YYYY-MM-DD>/`, edit only inside its tailor slots for Stride-in-Experience + 2 JD-picked projects, compile to one filled page, verify with `tests/resume/verify.mjs`, PDF-only to `resumes/output/<YYYY-MM-DD>/Onkar_Jadhav_<Company>_<Role>.pdf`. Set Resume Status = Tailored and paste the output PDF path/link → Resume PDF.
4. **Cold email (ONLY if the user explicitly asks)** — build from the template in master_prompt.md § 5 (120-150 words: hook → 1 proof point → soft CTA). Create a **Gmail draft** (never send). Log an Outreach row: Contact Name, Company/Application relations, Type = Cold, Gmail Draft link, Status = Draft. Do not auto-generate drafts on every application — only on request.
5. **Update tracker** — Status, Date Applied (when the user confirms applied), and any contact info the user supplies.

## House rules
- No auto-apply, no autonomous send. Draft only; user approves.
- Cold email is opt-in per request, not a default step.
- Contact emails: use only what the user supplies or a clearly-public address. Do not guess pattern emails (deferred for now).
- One follow-up only, 4 days after send (see Outreach / master_prompt.md § 5).
- Never invent contacts, emails, salaries, or company facts. Unverified → "Not Verified".

## Proof point / hook
"AI/full-stack engineer (B.Tech CS, PCCOE, 9.17 CGPA) who shipped Stride (an AI-first wellness product, live with early users) plus production AI systems solo — hybrid-retrieval RAG (Lore Engine), a deep-learning equity engine across 100 NSE stocks (StockXpert), and an open-source LLM governance benchmark (GovBench)."
