# 07: EOR and long-term contract classes

**What to build:** Foreign-company roles that hire in India through an employer of record get the `EOR` label. Long-term contracts get the `Contract` label only when they have full-time hours, are ongoing or 6+ months, state fixed pay, and are hired directly by the company. A contract role missing any of these is dropped. Unknown contract terms go to verification, not the lane. EOR and Contract roles are eligible only for their own lane.

**Blocked by:** 02

**Status:** done

- [ ] EOR role gets the `EOR` label and is lane-only
- [ ] Full contract with all terms gets the `Contract` label and is lane-only
- [ ] Contract without fixed pay is dropped
- [ ] Contract with unknown terms goes to verification
- [ ] No EOR or Contract role is eligible for a full-time lane
