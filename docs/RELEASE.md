# Release process

Owner: HERALD (tags, GitHub Releases, closing superseded PRs). Only WARDEN merges to `main`. This file applies to both repos: `titan717/dawghwa` (app) and `titan717/dawghwa.api` (API); each keeps its own copy.

## Versions

- Semantic Versioning, separately per repo. Continue from the current `package.json` version and existing tags; never reset, move or reuse a tag.
- Baselines (cycle 0, 2026-11-23): app `v0.3.0`, API `v1.3.0`. Earlier versions (app 0.1.0 and 0.2.0, API 1.2.0) were declared in `package.json` but never tagged; their changes are listed in `CHANGELOG.md`.
- Cycle 1 ships a pre-release `vX.Y.0-rc.1` (marked pre-release on GitHub). Cycle 2 ships the final `vX.Y.0` (marked latest).

## Labels

Every merged PR gets exactly one label, used by `.github/release.yml` to group generated notes:

| Label | Use for |
|-------|---------|
| `feature` | new user-facing behaviour |
| `fix` | bug fixes |
| `security` | security, privacy or accessibility hardening |
| `docs` | documentation only |
| `chore` | CI, tooling, releases, refactors |

`skip-changelog` hides a PR from generated notes (for example a superseded PR).

## Cutting a release

1. Confirm `main` is green and the commit to release is live: the commit status with context `Vercel` on that sha is `success` (`gh api repos/titan717/<repo>/commits/<sha>/status`).
2. Release commit (via a PR that WARDEN merges): bump `version` in `package.json` and `package-lock.json`, move `[Unreleased]` in `CHANGELOG.md` into the new version with the date, and update the compare links. Android `versionName` and `versionCode` come from the tag in the APK workflow (`-PversionName`, `-PversionCode`), so `android/app/build.gradle` is not edited.
3. After the release commit is merged and its Vercel status is `success`, tag that exact commit on `main`:
   `git tag -a vX.Y.Z <full-sha> -m "Dawghwa vX.Y.Z"` then `git push origin vX.Y.Z`.
4. Publish the GitHub Release from the tag (`gh release create vX.Y.Z --verify-tag --notes-file ...`, add `--prerelease` for `-rc.N`, `--latest` for finals). Body sections: Highlights, What's new, Fixes, Behind flags, Known issues, Upgrade notes, Verification (CI run, Vercel deployment, cycle log), Full changelog (compare link).
5. Never name providers, sources, domains or source ids in release notes or the changelog.

## Android (app repo only)

`.github/workflows/release-apk.yml` runs on `v*` tag pushes. It builds the APK every time, but attaches it to the GitHub Release only when the release signing secrets exist (`DAWGHWA_KEYSTORE_BASE64`, `DAWGHWA_KEYSTORE_PASSWORD`, `DAWGHWA_KEY_ALIAS`, `DAWGHWA_KEY_PASSWORD`). Without them the debug build is kept as a workflow artifact only, and the release notes say "Android build pending signing keys" under Known issues. Never commit a keystore.

## Verification (every release)

- Clean checkout of the tag builds: `git worktree add /tmp/rel vX.Y.Z` with installed dependencies, then `npm run build`.
- `node -p "require('./package.json').version"` equals the tag without the `v`.
- The release page renders and every link resolves (HTTP 200).
- The release notes list every PR merged since the previous tag (`git log --first-parent <prev>..<tag>`).
- Results go in the cycle log `docs/loop/herald-c<N>.md`.

## Superseded PRs

A squash merge does not close the PRs it contains. After each cycle merge, close every included PR with a comment linking the commit permalink `https://github.com/titan717/<repo>/commit/<full-sha>`.
