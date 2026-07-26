# Workday LIST `postedOn` probe

On 2026-07-25, a read-only probe compared Workday LIST `postedOn` labels with DETAIL `startDate` values across four tenants: Autodesk, Barclays, Finastra, and BP International. It read 80 LIST rows and fetched 16 corresponding DETAIL records.

| Tenant | LIST label | DETAIL `startDate` | Result |
| --- | --- | --- | --- |
| Autodesk | `Posted Today` | `2026-07-24` | MATCH |
| Autodesk | `Posted Yesterday` | `2026-07-23` | MATCH |
| Finastra | `Posted 2 Days Ago` | `2026-07-22` | MATCH |
| Finastra | `Posted 3 Days Ago` | `2026-07-21` | MATCH |

The full sample measured 16 matches, 0 mismatches, and 0 missing `startDate` values. A consistent offset of at most one day is explained by Workday rendering “today” in US Pacific while the probe was read in IST. This is well inside the 14-day freshness window.

The measured result supports treating a bounded Workday `postedOn` label as corroborating freshness evidence without a DETAIL request. The probe covered four tenants on one day and does not establish behavior for every Workday tenant. The unbounded `Posted 30+ Days Ago` label remains unusable for dating and must stay undated.
