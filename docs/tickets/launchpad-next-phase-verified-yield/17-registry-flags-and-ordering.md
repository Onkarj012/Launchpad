# 17: Registry relevance flags and probe order

**What to build:** Each registry board has `puneRelevant` and `indiaRelevant` flags and a probe record (when probed, how found, job count, India job count). All come from one public request per board. Pune-relevant boards are fetched first. US-only tenants with zero India yield over 7 days rotate out or pause. Production reads the registry file.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] One public request sets both flags and the probe record
- [ ] Pune-relevant boards are fetched first
- [ ] US-only tenant with zero India yield for 7 days rotates out or pauses
- [ ] Production run reads the registry file
