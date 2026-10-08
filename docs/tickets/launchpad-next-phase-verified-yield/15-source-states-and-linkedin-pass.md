# 15: Source end states and LinkedIn guest pass

**What to build:** Every configured source ends a run as `ok`, as `empty` with a reason, or as `disabled` by decision. LinkedIn gets one guest pass per run. After a 429, LinkedIn is paused for the rest of the day, and the same page is never retried.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] Every source ends with one of the three states
- [ ] An `empty` source states its reason
- [ ] LinkedIn makes one guest pass per run
- [ ] A 429 pauses LinkedIn for the rest of the day
- [ ] The same page is not retried
