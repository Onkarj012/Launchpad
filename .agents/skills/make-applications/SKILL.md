---
name: make-applications
description: Prepare locally verified, JD-tailored resumes for the application rows the user has manually selected.
---

# Make applications

Prepare an explicit, manual apply queue. This skill never submits an application, checks `Apply?`, or changes an application outcome.

## Steps

1. **Receive the queue.** Ask for the manually selected Company, Role, and JD text/link for every row. Do not infer the queue from an unavailable Notion query.
   *Done when:* every requested row has a JD and an unambiguous source link or pasted text.

2. **Build each evidence pack.** Run `resume-latex` Steps 1–5 for each row: profile selection, matrix, provenance, template copy, content/JD gates, local compile, and artifact verification.
   *Done when:* every row has either a verifier-passed PDF and its two source sidecars or a visible failure reason.

3. **Prepare records.** Keep `.tex`, `.matrix.md`, and `.provenance.md` together in `resumes/sources/<YYYY-MM-DD>/`; keep only the PDF in `resumes/output/<YYYY-MM-DD>/`. Update a tracker only if the invoking workflow has tracker authority, without changing `Apply?`, status, or applied date.
   *Done when:* every ready item has a PDF path and every failure is retained as a failure, not silently skipped.

4. **Hand off.** Report Company, Role, original apply link, PDF path, selected profile, covered requirements, and real gaps. Remind the user to mark the row Applied only after submitting on the portal.
   *Done when:* the queue is reviewable and remains entirely user-controlled.
