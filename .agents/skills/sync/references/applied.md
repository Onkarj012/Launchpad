# Applied? branch

Call `syncAppliedApplications({ gateway, suppression })`.

Reads Applications v5 filtered to `Applied? = true`, then filters again locally. May set derived `Status = Applied`, stamp `Applied At` only when none exists, record the Activity event, and persist the sync key.

Never set or clear `Applied?` or `Make Resume`. Do not infer submission from Ready, a resume artifact, outreach, Activity, status, a URL visit, or elapsed time.
