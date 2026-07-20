# Measurement

Record confirmed events in `outcomes.tsv`: application, contact sent, referral requested, reply, profile view, resume download, assessment, recruiter screen, technical interview, offer, withdrawal, or rejection. A rejection is `hours`, `1-4 days`, `5-14 days`, or `unknown` only when timestamps support it.

Interpretation: hours suggests knockout answers or eligibility; 1–4 days points to recruiter/resume/positioning; 14 days of silence is inactive for reporting; recruiter screens without technical progress calls for introduction, offer/salary/location answers, and project communication; technical interview failures shift effort to fundamentals, live coding, system design, and project depth.

Generate the report with `node conversion/report.mjs --outcomes PATH --applications PATH --referrals PATH --out PATH`. It reports applications and human activity by source, resume variant, rejection timing, and referral outcomes. At 50 targeted applications with no screens, audit gates, positioning, source mix, and knockout answers. At 70–100 with no interviews, stop creating resume variants; inspect human activity, proof page, project bullets, and title mix. Completion: the report names all missing evidence and each checkpoint action is tied to the observed condition.
