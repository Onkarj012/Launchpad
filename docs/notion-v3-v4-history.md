# Notion v3 / v4 — historical record

Read-only history. Launchpad v5 is the sole active runtime contract; nothing below is a runtime, fallback, migration, archive, or delete target. These identifiers are retained so past evidence stays interpretable, not so anything writes to them.

Current v5 targets live in `config/notion-v5.manifest.json`, reached through `notion-v5/gateway.mjs`.

## v3 (archived)

- Workspace page: https://app.notion.com/p/3885c2b5d1b081458df2c68954540105
- Applications data source: `d8d525b0-e436-44b7-ae65-28c08a358684` — renamed "Applications (v3 archive)" when v4 landed.
- Companies data source: `9cb28730-1c2e-4e81-bb54-4cb1ac4b3a1d`
- Outreach data source: `bf40caf6-8b07-4c55-9d21-787b8033f454`

## v4 (historical snapshot, formerly current as of 2026-07-09)

Built per `NOTION_V4_SETUP.md` (since removed). All 44 open v3 rows were migrated in.

- Applications v4 data source: `7bc3de3a-91d9-4391-8b22-9e68b264e8d2` · DB page: https://app.notion.com/p/d7db471ca1fb4686868b4ca4c9f56824
- Activity data source: `76a31def-a145-45db-9b82-0c263b80ab1b` · DB page: https://app.notion.com/p/abe8d58130844fd480c24b4edb285dee
- Referrals data source: `346c1a15-3808-4e4a-bcb7-8d24f0ea597a` · DB page: https://app.notion.com/p/c72c4997616745428d28e7340336d32d
- Views: Today's Pull, To Apply, Follow-up Due, Pipeline (board), Archive on Applications v4; Due on Activity.

Added over v3: `Fingerprint`, `Liveness`, `Liveness Checked`, `Freshness`, `Next Follow-up`, `Follow-up Count`, `Last Activity`, `Hook`, `Rationale`, `Experience Asked`, `CTC/Salary`, `Work Mode`, and richer `Status` / `Resume Status`. The Activity DB replaced ad-hoc follow-up tracking with a dual-relation log.

### Conversion-plan additions (applied 2026-07-21, per `conversion/SCHEMA_PROPOSAL.md`)

- **Applications v4** gained `Original ATS URL`, `Original ATS Verified At`, `Application Readiness`, `Conversion Score`, `Resume Variant`, `Submitted Answers Path`, `Recruiter Contacted`, `Hiring Manager Contacted`, `Referral Requested`, `First Follow-up Date`, `Second Follow-up Date`, `First Human Response Date`, `Interview Stage`, `Rejection Timing`, `Rejection Reason`, `Source Category`, `Proof-of-Fit Path`, and a `Referrals` relation.
- **Outreach** gained `Contact Role`, `Contact Channel`, `Sequence Stage`, `Last Contact Date`, `Next Eligible Contact`, `Duplicate Guard`, `Response Outcome`.
- **Activity** gained `Source Category`, `Resume Variant`, `Rejection Timing`, `Evidence Link`, and its `Type` select expanded with `Recruiter Screen`, `Technical Interview`, `Assessment`, `Profile View`, `Resume Download`, `Rejection`.
- **Referrals** (new DB): `Person`, `Application` (dual relation), `Relationship Signal`, `Requested At`, `Response`, `Referral Submitted At`, `Outcome`, `Notes`.

The local TSV templates (`conversion/templates/*.tsv`) and `conversion/report.mjs` still work standalone and were never wired to write these fields automatically.
