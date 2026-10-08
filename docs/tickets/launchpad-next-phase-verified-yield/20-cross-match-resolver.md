# 20: Portal lead cross-match

**What to build:** A portal lead (LinkedIn, Glassdoor, Instahyre, Wellfound) whose company matches a registry employer is searched on that employer's own board by title. It is promoted only when employer, title, and location match, plus requisition when one exists. With no match, the lead stays in verification. The resolver budget rises only after verified routes per request are measured.

**Blocked by:** 17

**Status:** done

- [ ] Matching employer, title and location promotes the lead
- [ ] No match leaves the lead in verification
- [ ] Wrong title or wrong location is not promoted
- [ ] Requisition is checked when present
- [ ] Budget change is backed by a recorded measurement
