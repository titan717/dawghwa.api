# Terms check (do this before any endpoint request)

## Documents to read, in order
1. `/robots.txt`, including any `Content-Signal` lines and comments that state conditions of access.
2. Terms of service or terms of use. Look for links in the footer. Only request pages that are linked or that you can see in public search results. Do not guess paths.
3. API terms or developer policy, if the site has a public API.
4. DMCA or copyright policy, and content licence.
5. Privacy policy, which matters if responses contain user data.

If a page is blocked (403, challenge), don't try to get around it. Record that it was unreachable, and use public search-engine results only to find out whether such a page exists. Label anything from third parties as secondary and unverified.

## What to look for
| Question | Typical wording | Effect |
|---|---|---|
| Automated access banned? | "robots, spiders, scrapers", "automated means", "data mining" | Blocked |
| API use limited? | "personal, non-commercial", "rate limits", "API key required" | Follow the limits exactly. If a key is required, a human must get one |
| Caching allowed? | "may not store", "cache for no longer than" | Set the cache TTL to match, or don't cache |
| Metadata or image reuse? | "may not reproduce, redistribute, hotlink" | Show links only, don't relay images |
| Third-party apps? | "unofficial clients", "interfaces other than ours" | Blocked for enabling |
| AI use? | `ai-train=no`, "machine learning" | Never use for training |

## Verdict wording
Write one of these, followed by the quoted reason:
- `allowed`: nothing prohibits the planned use.
- `allowed with limits`: list each limit and where it's enforced in code.
- `unclear`: no terms found or readable. Default to keeping the provider behind an off-by-default flag, and a human decides.
- `blocked: terms`: a clause prohibits the use.
- `blocked: access`: a 403, challenge or CAPTCHA was served. This is a stop condition even if the terms look permissive.

Also note whether the content seems to be offered without a licence. That's a separate legal risk from the access question, so mention it but don't speculate.
