# LinkedIn detail fixtures

These three slim JobPosting fixtures retain the identity, description, exact portal date, employment and explicit experience fields from the parent's public captures in `.local/recovery-2026-10-02/first-pass/`. They include each page's canonical link because LinkedIn's identifier often names an employer and may contain an employer requisition ID rather than the LinkedIn job ID. Logos, tracking, other scripts, and page furniture were removed. The full saved pages are exercised by the local operator replay.

- 4473136187: Woodfrog NLP/LLM role, no explicit minimum experience or salary.
- 4473131541: Rasta.Ai role, minimum 3 years; JD explicitly discloses CTC of 6–8 LPA.
- 4433878985: Cognologix role, 3–5 years; existing experience extraction also finds 5 years of hands-on experience.

`empty-shell.html` is synthetic. Missing captures in the offline replay receive an injected HTTP 404. That is replay coverage metadata, not a live liveness finding.
