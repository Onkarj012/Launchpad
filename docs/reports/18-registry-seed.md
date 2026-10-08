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
