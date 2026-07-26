# Proof packet specification and inventory

## Packet standard

For a selected project, a shareable packet contains only verified items:

1. One-sentence problem and audience.
2. One architecture or implementation decision, with a link to supporting code or document.
3. One demonstrable behavior, with a demo link or a labeled `Not Verified` status.
4. One measured result only when the approved source supports it.
5. A limitation, maturity note, or known boundary.

Never substitute a planned asset, private URL, local-only repository, or unverified statistic for a shareable proof. Record it as `Not Verified` instead.

## Inventory

| Project | Best role connection | Candidate proof | Public link | Verification status | Evidence / limitation | Next audit |
|---|---|---|---|---|---|---|
| Stride | AI product, full-stack, multi-agent systems | architecture note, product walkthrough, selected implementation link | Not Verified | Not Verified | Resume evidence supports production and private-cohort wording only; public asset status has not been audited | Confirm public-safe demo and repository visibility |
| Lore Engine | RAG, retrieval, backend, evaluation | retrieval architecture, eval-harness explanation, ingestion flow | Not Verified | Not Verified | Resume evidence supports hybrid retrieval and stated evaluation harness; demo/link status is unknown | Verify repository, demo, and reproducible evidence |
| StockXpert | applied ML, forecasting, full-stack ML serving | model/evaluation note, dashboard walkthrough, experiment summary | Not Verified | Not Verified | Resume evidence supports stated benchmark and serving claims; public artifact status is unknown | Verify code, data disclosure safety, and demo |
| GovBench | AI evaluation, governance, safety | framework README, benchmark methodology, result summary | Not Verified | Not Verified | Resume says open-sourced, but this packet does not verify the current repository URL or release state | Verify repository, licensing, and result reproducibility |

## Role selection rule

Choose one packet whose verified evidence covers the highest-value JD requirement. If no packet has a verified public asset, use a truthful text-only proof-of-fit note and label the link status `Not Verified`.
