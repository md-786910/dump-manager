# Release workflow

## How releasing works end-to-end

```
git tag v0.1.1 && git push --tags
        │
        ▼
GitHub Actions (release.yml) ───┬──► ubuntu-latest  → .AppImage + .deb + latest-linux.yml ──► R2
                                ├──► windows-latest → .exe + latest.yml                    ──► R2
                                └──► macos-latest   → .dmg (x64 + arm64) + latest-mac.yml  ──► R2

After R2 upload, the Linux job alone POSTs the Cloudflare Pages deploy hook ─► site rebuilds
                                                                              ─► /download
                                                                                shows new version

Installed apps poll latest-*.yml hourly ─► in-app "Update v0.1.1 ready" banner ─► one-click restart
```

Total wall-clock from `git push --tags` to a user seeing the update banner: ~10–15 minutes.

## One-time setup

In **GitHub → repo → Settings → Secrets and variables → Actions → New repository secret**, create:

| Name | Value | Source |
|---|---|---|
| `R2_ACCESS_KEY_ID` | 32-char hex | Cloudflare R2 → Manage R2 API Tokens |
| `R2_SECRET_ACCESS_KEY` | 64-char hex | Cloudflare R2 → Manage R2 API Tokens |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | R2 token page |
| `R2_BUCKET` | `dbmanager-releases` (or your bucket name) | R2 bucket |
| `CF_PAGES_DEPLOY_HOOK` | Full URL | Cloudflare Pages → project → Settings → Builds & deployments → Deploy hooks |

Token permissions: **Object Read & Write** on the release bucket only.

## Cutting a release

```bash
# 1. Make sure main is green and clean.
git status

# 2. Bump version (this also tags HEAD as v<x.y.z> and pushes the tag).
npm version patch      # 0.1.0 → 0.1.1
# or:  npm version minor    (0.1.0 → 0.2.0)
# or:  npm version major    (0.1.0 → 1.0.0)

git push --follow-tags
```

The tag push triggers `.github/workflows/release.yml`. Watch progress in the **Actions** tab.

## Manual / ad-hoc release

If you need to re-run for a specific OS or fire a release without a new version bump:

- **GitHub UI:** Actions tab → Release → Run workflow → pick branch → Run.
- **Locally:** `npm run release` (host OS only) or `npm run release -- all` (Linux + Win + Mac, needs Wine for Win and macOS for Mac).

## Cost & runner notes

- **macOS runners** are the priciest line on GitHub-hosted runners (~$0.08/min). A full Mac build takes ~6–8 minutes → roughly $0.50–0.65 per release.
- **Windows** runners are ~$0.016/min, Linux ~$0.008/min. Both are negligible.
- **Public/OSS repos:** all runner minutes are free.

If cost becomes a concern, you can:
- Self-host a macOS runner (free, requires a Mac that stays online).
- Move `macos-latest` to manual-only by removing it from the `matrix.include` list and triggering it via `workflow_dispatch` on demand.

## Troubleshooting

**"Missing R2_ACCESS_KEY_ID env var (CI: set as a repo secret)."**
A secret isn't set on the repo. Check Settings → Secrets and variables → Actions.

**Mac job fails with `Code signing is required` / `signing identity not found`.**
We pass `CSC_IDENTITY_AUTO_DISCOVERY=false` in the workflow to skip signing. If you see this anyway, electron-builder probably picked up a stray cert from the runner — open the failed job's logs and add the matching `CSC_*` skip variable. For unsigned beta this is harmless.

**The Linux job uploaded but the site didn't rebuild.**
Check the `trigger site rebuild` line in the Linux job's logs. Common causes:
1. `CF_PAGES_DEPLOY_HOOK` secret isn't set on the repo.
2. The Pages project's deploy hook URL was rotated; create a new one in Pages → Settings → Builds & deployments → Deploy hooks.

**Installed app doesn't show the update banner.**
1. `curl -I https://pub-...r2.dev/releases/latest-linux.yml` should return 200 + a recent `Last-Modified`.
2. In the app, the update poll runs at startup + every 60 min. Quit and relaunch to force an immediate check.
3. Check the in-app logs panel for `updater: …` lines.
