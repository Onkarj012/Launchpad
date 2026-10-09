# Startup careers site probes

Probed on 9 October 2026 (IST). Each listed company received one direct, unauthenticated public careers-page GET through the page reader. No login or browser session was used. The reader returned HTML page content; it does not expose the HTTP status code. The probes confirm page access and readable content, not a successful role extraction by Launchpad.

| Company | Careers page | Readable evidence |
|---|---|---|
| Truein | https://truein.com/careers | B2B SaaS careers page with open positions |
| CrelioHealth | https://creliohealth.com/careers/ | Careers page links to current openings |
| AgroStar | https://corporate.agrostar.in/join-us | Pune office and current job links |
| Easebuzz | https://easebuzz.in/careers/ | Fintech careers content; Pune listed as a location |
| The Machine Learning Company | https://careers.tmlc.in/ | AI engineering roles in Pune |
| Frep | https://www.frep.ai/careers | Pune AI product engineering openings |
| StoreStory | https://storestory.in/careers | Pune SaaS careers page |
| Orvera AI | https://orvera.ai/careers | AI engineering careers page; Pune listed |
| Globalion Technology Solutions | https://www.globalion.in/careers/ | Pune AI engineering careers page |
| AdElement | https://tyroo.adelement.com/company/jobs | Pune software engineering roles |
| XBT Ventures | https://www.xbtventures.com/careers | Deep-tech careers page; Mumbai, Pune and Bengaluru listed |
| Vizuara AI Labs | https://openings.vizuara.ai/ | Pune AI engineering role page |
| Sigmoid AI Solutions | https://sigmoidai.co.in/careers | Pune AI careers page |
| Sarvatra Technologies | https://sarvatra.tech/careers/ | Pune fintech careers page with engineering openings |
| Hushh | https://careers.hushh.ai/ | AI careers page; Pune office and internships listed |
| RadialBrain | https://www.radialbrain.com/careers/ | Early-stage AI company; remote India engineering roles |
| VIVA360 | https://viva360.ai/careers | AI careers page; remote India roles |
| GammaMoney | https://www.gammamoney.in/careers | Fintech careers page; remote India roles |
| LOOP | https://loopindia.ai/careers | Fintech careers page; remote-friendly roles |
| BrowserStack | https://www.browserstack.com/careers | Remote-first developer-tools careers page |

The 20 selected employer names were checked against `config/board-registry.json`; none matched an existing employer name there. BrowserStack's page links to a Workday job page, but BrowserStack has no entry in the current registry.

Other attempts: `curl` to Mindtickle could not resolve DNS in this shell, so it was not added. The public page reader returned no extracted lines for VRS Mindcraft and ElasticRun; neither was added. The page reader made requests in batches of up to five distinct hosts. No page was retried. The direct response code and raw response headers were unavailable, and the crawler itself was not run against these sites to avoid extra live requests.
