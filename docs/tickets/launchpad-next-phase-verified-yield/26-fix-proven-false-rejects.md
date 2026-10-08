# 26: Fix proven false rejects

**What to build:** Only false rejects proven in ticket 25 are fixed. Each fix has a regression test built from the real listing that exposed it. Gates do not loosen by accident.

**Blocked by:** 01, 02, 03, 04, 05, 25

**Status:** ready-for-agent

- [ ] Each fix traces to a false reject labelled in ticket 25
- [ ] Each fix has a regression test from the real listing
- [ ] Other reject outcomes are unchanged
