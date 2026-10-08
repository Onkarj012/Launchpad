# Workday LIST `postedOn` probe

> **Current policy.** LIST `postedOn` is not trusted for selection. Every Workday LIST-only row, bounded or unbounded, stays in `VerifyQueue`; only a usable DETAIL `startDate` supplies freshness. See [`../STATUS.md`](../STATUS.md).

On 2026-07-25, a read-only probe compared Workday LIST `postedOn` labels with DETAIL `startDate` values across four tenants: Autodesk, Barclays, Finastra, and BP International. It read 80 LIST rows and fetched 16 corresponding DETAIL records.

| Tenant | LIST label | DETAIL `startDate` | Result |
| --- | --- | --- | --- |
| Autodesk | `Posted Today` | `2026-07-24` | MATCH |
| Autodesk | `Posted Yesterday` | `2026-07-23` | MATCH |
| Finastra | `Posted 2 Days Ago` | `2026-07-22` | MATCH |
| Finastra | `Posted 3 Days Ago` | `2026-07-21` | MATCH |

The full sample measured 16 matches, 0 mismatches, and 0 missing `startDate` values. A consistent offset of at most one day is explained by Workday rendering “today” in US Pacific while the probe was read in IST. This is well inside the 14-day freshness window.

Original dated conclusion: the measured result supported treating a bounded Workday `postedOn` label as corroborating freshness evidence without a DETAIL request. The probe covered four tenants on one day and did not establish behavior for every Workday tenant. The unbounded `Posted 30+ Days Ago` label remained unusable for dating and had to stay undated.

The probe measured agreement between LIST `postedOn` and DETAIL `startDate` in four tenants on one day. That observation does not change the policy. LIST data remains verification-only, and detail hydration is the point where a Workday date becomes trusted freshness evidence.
