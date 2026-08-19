# Applications v4 history snapshot refresh

The unified daily run reads the historical snapshot from
`career-ops/data/v4-history-snapshot.json`. Applications v4 remains
historical-only: this procedure reads an export and writes only the local
snapshot. It never writes to, migrates, archives, or deletes v4.

## Repeatable refresh

1. Export Applications v4 using a read-only export. Keep the export outside
   the repository or in a disposable local path; do not put credentials or
   secrets in it.
2. Convert each exported application row to this exact shape, preserving
   values from the export and leaving unknown values `null` or omitted:

   ```json
   {
     "provider": "greenhouse",
     "provider_job_id": "12345",
     "canonical_url": "https://job-boards.greenhouse.io/acme/jobs/12345",
     "company": "Acme",
     "title": "AI Engineer",
     "location": "Pune, India",
     "state": "applied"
   }
   ```

   `provider`, `provider_job_id`, `canonical_url`, `company`, `title`,
   `location`, and `state` are identity/suppression evidence only. Do not
   infer an identity, date, company, or outcome that the export does not
   contain.
3. Write the rows as an envelope at
   `career-ops/data/v4-history-snapshot.json`:

   ```json
   {
     "generatedAt": "<UTC ISO-8601 timestamp for this export>",
     "rows": ["<converted rows>"]
   }
   ```

4. Validate the local file without contacting v4 or any live gateway:

   ```sh
   node --input-type=module -e "import { readV4HistorySnapshot } from './crawler/v4-history-snapshot.mjs'; console.log(readV4HistorySnapshot().status)"
   ```

   The expected result is `loaded`. `stale` is usable but warns and should be
   refreshed; `missing` and `malformed` supply zero historical rows and do not
   fail the daily run.

5. Record the export date and source path in the operator handoff. Never
   commit the raw export, credentials, or a fabricated replacement snapshot.
