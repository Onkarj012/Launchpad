---
name: resume-check
description: Brutal recruiter-grade review of Onkar's resume against a target JD (or a generic "most common requirements" fallback when no JD is supplied). Four modes — Diagnoser, Recruiter, Rewriter, Hiring-Manager. Reads the .tex source. Use when the user says "resume check", "/resume-check", "review my resume", "roast my CV", "is my resume good enough for this JD", "what's wrong with my resume", or asks for red-pen feedback before applying.
---

# Resume Check

Red-pen, recruiter-grade review. No flattery. Green only when earned. The job is to find weaknesses **before** a real recruiter does — so the tone is a senior recruiter who has seen 10,000 CVs and is out of patience.

## Source of truth
- **Read the `.tex` source, not a PDF.** Default: `resumes/master/Master_Resume_ATS.tex`. If reviewing a specific tailored output, read its source in `resumes/sources/Onkar_Jadhav_<Company>_<Role>.tex`. Review targets the editable content so fixes are directly applicable.
- `master_prompt.md` § 2-4 — Targeting, Scoring Rubric, and Resume Rules give the bar the resume is held to.

## Input & JD handling
- **JD-specific (primary):** user pastes a JD → review every section against what *that* JD demands. This is the default and highest-value mode.
- **Generic fallback (no JD):** if no JD is supplied, review against the **most common requirements** for Onkar's target titles (from `master_prompt.md` § 2 — AI/LLM Engineer, ML Engineer, Full-Stack, Backend Python, New-grad SWE). State explicitly at the top that this is a generic pass and JD-specific review would be sharper.

## Modes
One skill, four lenses. Default to **Recruiter** unless the user names a mode.
- **Diagnoser** — clinical gap analysis. For each JD requirement: is it present, weak, or missing? Output a requirement-coverage table.
- **Recruiter** — the primary mode. The brutal 6-second-scan recruiter. Held to the full report structure below as its quality bar.
- **Rewriter** — for each weak/missing section, produce a concrete rewritten version (truthful — only reframing/reordering what's already in the master, never inventing).
- **Hiring-Manager** — "would I bring this person in?" Judges substance and signal over keywords: does the work look real, senior, and owned?

## Report structure (Recruiter mode — the quality bar)
**Per section** (Summary, Experience/Stride, each Project, Technical Skills, Education):
- **What the JD demands** — the concrete requirement(s) this section should satisfy.
- **What the CV says** — quote/paraphrase the current content.
- **Gap diagnosis** — the specific miss (missing keyword, vague bullet, no metric, buried lede, off-target framing).
- **Verdict** — one of 🔴 (critical, will get filtered) · 🟠 (weak, fix before sending) · 🟢 (strong, leave it) · 🔵 (over-engineered / cut or trim).
- **Rewritten version** — the fixed line/bullet, truthful to the master.

**Then an overall verdict:**
- **ATS score estimate** (0-100) with the keyword misses that cost points.
- **6-second impression** — what a recruiter concludes in the first glance.
- **Top-3 critical fixes** (🔴 — do these or don't send).
- **Top-3 quick wins** (🟠 — cheap, high-leverage).
- **Honest hire-probability** — blunt call on whether this CV, as-is, clears the screen for this role.

## Tone rules
- Red-pen recruiter. No warm-up, no compliment sandwich, no "great start!". 
- 🟢 only when a section genuinely needs nothing.
- Every 🔴/🟠 must come with the concrete rewrite — criticism without a fix is noise.
- Truthful only: rewrites reframe/reorder/select from the master resume. Never invent a metric, skill, employer, or date to close a gap — if a gap can't be closed truthfully, say so and name it as a real weakness.

## Steps
1. Read the target `.tex` source (default `resumes/master/Master_Resume_ATS.tex`).
2. If a JD was supplied, extract its hard requirements + top keywords; else load the generic requirement set for the target titles and flag the pass as generic.
3. Run the requested mode (default Recruiter) section-by-section per the structure above.
4. Emit the overall verdict block.
5. Offer to hand the rewrites to `resume-latex` to regenerate the tailored PDF.
