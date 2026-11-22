# Supported sources

Generated from the registry by `npm run docs:sources`. 96 adapters: 69 active, 13 unstable, 14 shut down.

- **Active**: maintained adapter, expected to work (may still be blocked by anti-bot protection from some networks).
- **Unstable**: known to fail intermittently (upstream-reported); results are returned when the site responds.
- **Shut down**: the site is gone or the adapter no longer works. These are never called; requests return `SOURCE_UNAVAILABLE` instead of empty results.

Live reachability from a specific machine is in [SOURCE_STATUS.md](./SOURCE_STATUS.md) (`npm run health:report`) and at `GET /api/health`.

| Source | ID | Base URL | Type | Status | Capabilities | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Arven Comics | `arven-comics` | https://arvencomics.com | scanlator | Shut down | search, chapters | Site shut down (upstream) |
| Arya Scans | `arya-scans` | https://brainrotcomics.com | scanlator | Unstable | search, chapters |  |
| Asmodeus Scans | `asmodeus-scans` | https://asmotoon.com | scanlator | Active | search, chapters |  |
| AsuraScan | `asurascan` | https://asurascans.com | scanlator | Active | search, chapters, client-only |  |
| Athrea Scans | `athrea-scans` | https://athreascans.com | scanlator | Active | search, chapters |  |
| AtsuMoe | `atsumoe` | https://atsu.moe | aggregator | Unstable | search, chapters |  |
| BaeToon | `baetoon` | https://baetoon.com | aggregator | Active | search, chapters |  |
| Bato | `bato` | https://bato.to | aggregator | Shut down | search, chapters | Adapter no longer works (upstream) |
| Chikari | `chikari` | https://chikari.moe | aggregator | Active | search, chapters |  |
| Comix | `comix` | https://comix.to | aggregator | Unstable | search, chapters, frontpage | Experimental, off by default (`EXPERIMENTAL_PROVIDERS`); blocked: 403 anti-bot, terms unreadable. See [providers/comix-study.md](./providers/comix-study.md) |
| Danke fürs Lesen | `danke-furs-lesen` | https://danke.moe | scanlator | Active | search, chapters |  |
| DemonicScans | `demonicscans` | https://demonicscans.org | scanlator | Active | search, chapters |  |
| Diva Scans | `diva-scans` | https://divascans.org | scanlator | Unstable | search, chapters |  |
| Drake Scans | `drake-scans` | https://drakecomic.net | scanlator | Active | search, chapters |  |
| Dynasty Reader | `dynasty-reader` | https://dynasty-scans.com | aggregator | Active | search, chapters |  |
| Elf Toon | `elf-toon` | https://elftoon.net | scanlator | Active | search, chapters |  |
| Eva Scans | `eva-scans` | https://evascans.net | scanlator | Active | search, chapters |  |
| Falcon Scans | `falcon-scans` | https://falconscans.com | scanlator | Shut down | search, chapters | Site shut down (upstream) |
| Firescans | `firescans` | https://firescans.xyz | scanlator | Shut down | search, chapters | Site shut down (upstream); HTTP 502 when probed 2026-11-16 |
| FlameComics | `flamecomics` | https://flamecomics.xyz | scanlator | Active | search, chapters |  |
| Galaxy Degen Scans | `galaxy-degen-scans` | https://gdscans.com | scanlator | Active | search, chapters |  |
| Genz Toons | `genz-toons` | https://genztoons.org | scanlator | Active | search, chapters |  |
| Greed Scans | `greed-scans` | https://greedscans.org | scanlator | Unstable | search, chapters |  |
| Hachirumi | `hachirumi` | https://hachirumi.com | scanlator | Active | search, chapters |  |
| Hades Scans | `hades-scans` | https://hadesscans.com | scanlator | Shut down | search, chapters | Site shut down (upstream) |
| Hive Toon | `hive-toon` | https://hivetoons.org | scanlator | Active | search, chapters |  |
| KaliScan | `kaliscan` | https://kaliscan.com | aggregator | Shut down | search, chapters | Domain no longer resolves (probed 2026-11-16) |
| KappaBeast | `kappabeast` | https://kappabeast.com | scanlator | Active | search, chapters |  |
| Kayn Scans | `kayn-scans` | https://kaynscans.com | scanlator | Active | search, chapters |  |
| KDT Scans | `kdt-scans` | https://silentquill.net | scanlator | Unstable | search, chapters |  |
| Kenscans | `kenscans` | https://kencomics.com | scanlator | Active | search, chapters |  |
| Kero Scans | `kero-scans` | https://keroscans.net | scanlator | Active | search, chapters |  |
| KS Group | `ks-group` | https://ksgroupscans.com | scanlator | Active | search, chapters |  |
| KuraManga | `kuramanga` | https://kuramanga.com | aggregator | Active | search, chapters |  |
| LagoonScans | `lagoonscans` | https://lagoonscans.com | scanlator | Active | search, chapters |  |
| LHTranslation | `lhtranslation` | https://lhtranslation.net | scanlator | Active | search, chapters |  |
| LikeManga | `likemanga` | https://likemanga.in | aggregator | Shut down | search, chapters | Site shut down (upstream); HTTP 502 when probed 2026-11-16 |
| Lua Comic | `lua-comic` | https://luacomic.org | scanlator | Active | search, chapters |  |
| Luminare Translations | `luminare-translations` | https://luminaretranslations.com | scanlator | Active | search, chapters |  |
| Madarascans | `madarascans` | https://madarascans.net | scanlator | Active | search, chapters |  |
| Magus Manga | `magus-manga` | https://magustoon.org | scanlator | Active | search, chapters |  |
| Mangaball | `mangaball` | https://mangaball.com | aggregator | Active | search, chapters |  |
| MangaCloud | `mangacloud` | https://mangacloud.org | aggregator | Unstable | search, chapters |  |
| MangaDex | `mangadex` | https://mangadex.org | aggregator | Active | search, chapters, pages |  |
| Mangago | `mangago` | https://www.mangago.zone | aggregator | Active | search, chapters |  |
| MangaK | `mangak` | https://mangak.io | aggregator | Active | search, chapters |  |
| MangaKatana | `mangakatana` | https://mangakatana.com | aggregator | Active | search, chapters |  |
| Mangaloom | `mangaloom` | https://mangaloom.com | aggregator | Shut down | search, chapters | Domain no longer resolves (probed 2026-11-16) |
| MangaPark | `mangapark` | https://mangapark.io | aggregator | Shut down | search, chapters | Site shut down (upstream); HTTP 502 when probed 2026-11-16 |
| MangaRead | `mangaread` | https://www.mangaread.org | aggregator | Active | search, chapters |  |
| Mangasushi | `mangasushi` | https://mangasushi.org | scanlator | Active | search, chapters |  |
| Mangataro | `mangataro` | https://mangataro.org | aggregator | Active | search, chapters |  |
| Mangayy | `mangayy` | https://mangayy.org | aggregator | Shut down | search, chapters | Domain no longer resolves (probed 2026-11-16) |
| Manhuaplus | `manhuaplus` | https://manhuaplus.top | aggregator | Active | search, chapters |  |
| Manhuaus | `manhuaus` | https://manhuaus.club | aggregator | Unstable | search, chapters |  |
| Mgeko | `mgeko` | https://www.mgeko.cc | aggregator | Active | search, chapters |  |
| Mist Scans | `mist-scans` | https://mistscans.com | scanlator | Active | search, chapters |  |
| MKissa | `mkissa` | https://mkissa.to | aggregator | Active | search, chapters |  |
| NovelCool | `novelcool` | https://www.novelcool.com | aggregator | Active | search, chapters |  |
| Nyx Scans | `nyx-scans` | https://nyxscans.com | scanlator | Active | search, chapters |  |
| Orion Scans | `orion-scans` | https://orion-scans.com | scanlator | Active | search, chapters |  |
| Philia Scans | `philia-scans` | https://philiascans.org | scanlator | Unstable | search, chapters |  |
| Project Suki | `project-suki` | https://projectsuki.com | aggregator | Active | search, chapters |  |
| Qi Scans | `qi-scans` | https://qimanga.com | scanlator | Unstable | search, chapters |  |
| Rage Scans | `rage-scans` | https://ragescans.com | scanlator | Unstable | search, chapters |  |
| Raven Scans | `raven-scans` | https://ravenscans.org | aggregator | Unstable | search, chapters |  |
| RD Scans | `rd-scans` | https://rdscans.com | scanlator | Active | search, chapters |  |
| ReiManga | `reimanga` | https://reimanga.net | aggregator | Active | search, chapters |  |
| Rinko Comics | `rinko-comics` | https://rinkocomics.com | scanlator | Active | search, chapters |  |
| Ritharscans | `ritharscans` | https://ritharscans.com | scanlator | Active | search, chapters |  |
| Rizz Fables | `rizz-fables` | https://rizzfables.com | scanlator | Active | search, chapters |  |
| Rokari Comics | `rokari-comics` | https://rokaricomics.com | scanlator | Active | search, chapters |  |
| RoliaScan | `roliascan` | https://roliascan.com | aggregator | Active | search, chapters |  |
| Sana Scans | `sana-scans` | https://sanascans.com | scanlator | Active | search, chapters |  |
| Scythe Scans | `scythe-scans` | https://scythescans.com | scanlator | Active | search, chapters |  |
| Siren Scans | `siren-scans` | https://sirenscans.com | scanlator | Active | search, chapters |  |
| Spider Scans | `spider-scans` | https://spiderscans.xyz | scanlator | Active | search, chapters |  |
| Stonescape | `stonescape` | https://stonescape.xyz | scanlator | Active | search, chapters |  |
| Swarm | `swarm` | https://swarm.ws | aggregator | Active | search, chapters |  |
| TCB Scans | `tcb-scans` | https://tcbonepiecechapters.com | scanlator | Active | search, chapters |  |
| Temple Scan | `temple-scan` | https://templetoons.com | scanlator | Unstable | search, chapters |  |
| Thunderscans | `thunderscans` | https://en-thunderscans.com | scanlator | Active | search, chapters |  |
| TopManhua | `topmanhua` | https://manhuatop.org | aggregator | Active | search, chapters |  |
| UTOON | `utoon` | https://utoon.net | scanlator | Shut down | search, chapters | Site shut down (upstream) |
| Valir Scans | `valir-scans` | https://valirscans.org | scanlator | Active | search, chapters |  |
| Violetscans | `violetscans` | https://violetscans.org | scanlator | Active | search, chapters |  |
| Vortex Scans | `vortex-scans` | https://vortexscans.org | scanlator | Active | search, chapters |  |
| WEBTOON | `webtoon` | https://www.webtoons.com | aggregator | Active | search, chapters |  |
| WebtoonClub | `webtoonclub` | https://webtoonclub.com | aggregator | Active | search, chapters |  |
| WeebCentral | `weebcentral` | https://weebcentral.com | aggregator | Active | search, chapters, client-only |  |
| Weebdex | `weebdex` | https://weebdex.org | aggregator | Shut down | search, chapters | Domain no longer resolves (probed 2026-11-16) |
| WitchScans | `witchscans` | https://witchscans.com | scanlator | Shut down | search, chapters | Site shut down (upstream); HTTP 502 when probed 2026-11-16 |
| Writers' Scans | `writers'-scans` | https://writerscans.com | scanlator | Active | search, chapters |  |
| XComic | `xcomic` | https://xcomic.me | aggregator | Active | search, chapters |  |
| Yaksha Comics | `yaksha-comics` | https://yakshacomics.com | scanlator | Active | search, chapters |  |
| Yaksha Scans | `yaksha-scans` | https://yakshascans.com | aggregator | Shut down | search, chapters | Site shut down (upstream) |
