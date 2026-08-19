# Confirmed-outcome branch

Call `syncConfirmedOutcome({ gateway, application, outcome, evidence, suppression })`.

Accepted outcomes: `Interviewing`, `Offer`, `Rejected`, `Withdrawn`, `Not Pursuing`, `Closed/Expired`. Require `evidence.confirmed === true` plus `source`, `url`, `connector`, or `recordId`.

Updates application status and appends one Confirmed Activity event. Never manufacture an outcome from email, outreach, dates, or silence.
