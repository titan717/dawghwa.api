# SCOUT, cycle 0

- Read docs/providers/* and docs/research/providers-*.md. The previous run had 0 providers pass.
- Light re-check on 2026-11-23 15:44–15:46 UTC: 28 GETs over 19 hosts (robots.txt plus known terms pages), with the identifying bot UA and no Referer/Origin. One 403 (comix.to robots.txt), where I stopped. Each provider file got a "Re-check 2026-11-23" section with evidence and a downloadable verdict.
- MangaDex: terms read in full. FAIL because the attribution requirement conflicts with hidden sources. Rate limits and client requirements are recorded. Downloadable: false.
- Licensed/open sources: Say Hello to Black Jack (author licence) and Pepper&Carrot (CC BY 4.0). Both FAIL on attribution, though offline would be allowed. Flagged for the owner.
- Added docs/providers/_names.json (deny-list), docs/research/providers-2026-11-23-recheck.md, and a summary table in docs/providers/README.md.
- Result: 0/20 pass. All flags OFF. All downloadable false.
- Handoffs: the leak hits listed in the research note go to SHIELD/RELAY. The UA/Referer/Origin defaults go to RELAY/JUDGE.
