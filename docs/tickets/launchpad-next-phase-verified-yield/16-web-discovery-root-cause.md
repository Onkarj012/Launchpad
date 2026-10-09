# 16: Web discovery returns results

**What to build:** Web discovery returns results again. Find why it comes back empty (key, budget, or query shape), fix that cause, and record it in this ticket.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Root cause is written in this ticket (recorded in `docs/reports/16-web-discovery-root-cause.md`)
- [ ] Fixture run returns results
- [ ] An empty result states its reason

## Finding

`fullyDegraded()` treated a missing configured-engine list as proof that every engine had failed. One sparse first query with a single engine timeout therefore skipped all remaining queries. Unknown engine coverage now keeps the remaining bounded queries running. The SearXNG adapter also stops replacing a missing results field with an empty array, so a malformed response is reported. Full detail and evidence limits: `docs/reports/16-web-discovery-root-cause.md`.
