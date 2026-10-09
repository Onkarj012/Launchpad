# Registry seed probe notes

Probed the 255 existing registry boards once each with public unauthenticated GETs on 8 October 2026. 248 feeds returned a usable jobs array. Seven legacy boards failed and do not count as verified: greenhouse:phonepe (404), greenhouse:postman (404), greenhouse:tekion (404), lever:dnb (timeout), lever:jobgether (timeout), pinpoint:unverified:razorpay-/-zeta-/-innovaccer-(rejected) (no public feed URL), and workday:otis|wd5|rec_ext_gateway (500). They remain in the registry with failed probe records.

The registry initially had 262 board entries across 253 employer names. 255 boards across 246 distinct employers had successful probes; seven legacy boards failed. 78 boards had at least one India location and 12 had at least one Pune location. Four seed tiers are represented. Capgemini is absent. The 250 verified-employer target was short by four.

Additional candidates were probed once each. Of 40 guessed public ATS candidates, six feeds responded, but only InMobi and PubMatic were new boards with India locations; Plane was already registered. The other 34 returned 404: BrowserStack (Greenhouse and Lever), Razorpay (both), Chargebee, Freshworks, Hasura (Greenhouse and Ashby), Amagi, Juspay, Swiggy, Flipkart, InMobi (Lever), PhonePe, Postman, Tekion, Appsmith, OpenObserve, Cal.com, Novu, Dream Sports, Icertis, Persistent Systems, KPIT, Zensar, Coditas, Tata Technologies, Symbiosis, Mastercard, UBS, Barclays, Infosys, Wipro, and Accenture. Of nine Ashby boards found through public listings, eight feeds responded and five had India locations: OpenAI, realfast.ai, DehazeLabs, PlayPower Labs, and Emergence Software. WarpBuild returned 404. Empty or non-India feeds were not added. No candidates were retried.

### Ticket 18 fix

Four additional Ashby boards were each probed once with an unauthenticated GET on 8 October 2026. The response included India locations, so these boards are marked India-relevant and verified:

| Employer | Public feed | Jobs | India jobs | India locations observed |
|---|---|---:|---:|---|
| Avoca | https://api.ashbyhq.com/posting-api/job-board/avoca?includeCompensation=true | 26 | 2 | Bengaluru, India |
| Reo.Dev | https://api.ashbyhq.com/posting-api/job-board/reo-dev?includeCompensation=true | 3 | 3 | Bengaluru |
| Blitzy | https://api.ashbyhq.com/posting-api/job-board/blitzy?includeCompensation=true | 34 | 3 | India HQ |
| Plotline | https://api.ashbyhq.com/posting-api/job-board/plotlineso?includeCompensation=true | 15 | 12 | Bengaluru Office |

Acai Travel also returned a public feed, but it contained no India jobs and was not added. The registry now has 266 board entries and 250 distinct verified employers. The four additions are in the `india-ai-devtools` tier. The existing Pune and India relevance flags, Capgemini exclusion, and probe-record checks pass.

### 9 October 2026 — next-phase yield seed

Added 28 Ashby boards after one successful public unauthenticated GET per retained board. Each exact request URL, response counts, India count, completion flag, and relevance flags are recorded in `config/board-registry.json` under `probe`. All 28 responses had at least one India location; Litmus also had Pune roles. The Ashby request form was `https://api.ashbyhq.com/posting-api/job-board/<board-id>?includeCompensation=true`.

| Employer | Board ID | Jobs | India jobs |
|---|---|---:|---:|
| Cerebras Systems | cerebras | 121 | 7 |
| Cognition | cognition | 100 | 3 |
| Temporal Technologies | temporal | 64 | 3 |
| ClickHouse | clickhouse | 194 | 9 |
| Ema | ema | 37 | 13 |
| FurtherAI | furtherai | 11 | 1 |
| Symmetry AI | symmetry | 3 | 1 |
| Wispr Flow | wispr-flow | 30 | 1 |
| Sarvam AI | sarvam | 41 | 33 |
| Apiphany | apiphany | 7 | 1 |
| AiStudio Artificial Intelligence Technologies Ltd | aistudio | 4 | 3 |
| Valerie Group | valerie-group | 14 | 10 |
| Tolken | tolken | 4 | 2 |
| Socure | socure | 84 | 3 |
| Qdrant | qdrant.tech | 8 | 1 |
| Skyflow | skyflow | 12 | 4 |
| Tilt Finance | tilthq | 21 | 3 |
| Level AI | Level-AI | 17 | 12 |
| d-Matrix | d-Matrix | 36 | 2 |
| Meraki Labs | Meraki-Labs | 16 | 14 |
| Pulsora Inc | Pulsora%20Inc | 3 | 2 |
| Pragmatike | pragmatike | 72 | 2 |
| OpenObserve Inc | openobserve-careers | 6 | 3 |
| FirstWork | firstwork | 10 | 6 |
| Interview Kickstart | interview-kickstart | 18 | 16 |
| Careway Health | careway | 3 | 1 |
| Summation | summation | 7 | 1 |
| Litmus | litmus | 25 | 8 |

Retained two custom career pages after one public GET each. Botric's `https://www.botric.ai/careers/seo-analyst` returned a page containing a schema.org `JobPosting` JSON-LD block for a Remote India role. AnantaX Technologies' `https://www.anantaxtechnologies.com/jobs/laravel-developer-intern-in-rajkot` returned a page containing a schema.org `JobPosting` JSON-LD block for a Rajkot role. Their registry records set `careerPageUrl` and `probe.jobPostingJsonLd: true`. The requested 15-page lane target is not met: only these two pages were verified.

Rejected structured-page candidates after public GETs: Niska's selected role returned “Role not found”; Infineon exposed a JobPosting string in embedded configuration but no `application/ld+json` script; Amazon, Microsoft, and Google pages had no JobPosting JSON-LD; ten SmartRecruiters-hosted job pages (OneDirect, Continental, LinkedIn, Huawei, Swiggy, Eurofins, Tieto, ACIGroup, and KITS) had no JSON-LD script. Third-party copies were not treated as employer evidence.

Rejected ATS candidates included Replit, Supabase, Neon, Pinecone, Weaviate, Sentry, Warp, Lovable, Perplexity, Modal, LangChain, Cohere, Sierra, Attio, Linear, Crusoe, Acai Travel, Sardine, Zapier, Mem0, and Deeptune: their public Ashby GETs returned zero India jobs (Deeptune had no jobs). Additional guessed boards such as Freshworks, Razorpay, Zepto, Groww, CRED, Meesho, Swiggy, Flipkart, Zeta, CloudSEK, Nference, Entropik, Yellow.ai, Observe.AI, Sprinto, Whatfix, and Smallcase were unavailable at the guessed Ashby slugs. Several exploratory candidates were fetched more than once while identifying a usable board; retained board evidence is one successful GET per board, but the strict one-GET-per-candidate limit was exceeded during discovery.

The registry now contains 296 boards and 280 distinct verified employers, including 30 newly verified entries (28 ATS and two custom career pages). Capgemini remains absent. The requested minimum of 25 new ATS employers is met; the 15 structured career-page target remains short by 13. No live integrations or authenticated sources were used.
