# Tunnex marketing site

Static site built with Astro 4 + Tailwind v4. Deploys to Cloudflare Pages.

## Local dev

From the repo root:

```bash
npm run site          # http://localhost:4321
npm run site:build    # produces website/dist
npm run site:preview  # serves the built dist locally
```

Or directly:

```bash
cd website
npm install
npm run dev
```

## How the live download buttons stay current

`src/lib/releases.ts` fetches `latest-{linux,mac,}.yml` from the R2 release
bucket **at build time** and bakes the version + filename + size + SHA-512
straight into the HTML. No runtime fetches.

The `[data-os]` attribute is set by a 30-line inline script in `Base.astro`
based on `navigator.userAgentData` / `navigator.platform`, and the hero CTA
uses pure CSS selectors to show the matching button. Zero JS framework.

## Deploy (one-time setup)

1. Push the repo to GitHub.
2. Cloudflare → **Pages** → Create application → connect repo.
3. Build settings:
   - **Framework preset:** Astro
   - **Build command:** `cd website && npm ci && npm run build`
   - **Build output directory:** `website/dist`
   - **Environment variables:** none required (R2 manifests are public).
4. First deploy → site lives at `tunnex.pages.dev`.
5. **Custom domain:** Pages → settings → custom domains → add `tunnex.app`
   and `www.tunnex.app`. Cloudflare handles cert + DNS automatically.

## Auto-redeploy on app releases

Pages → settings → Builds & deployments → **Deploy hooks** → create a hook
named `release`. Copy the URL into your repo-root `.env`:

```
CF_PAGES_DEPLOY_HOOK=https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/...
```

`scripts/release.js` will POST to this URL after every successful R2 upload,
so the marketing site rebuilds with the new version automatically.

## Screenshots

Drop captures at `public/screenshots/<slug>.png` and update the
`ScreenshotFrame` `src=` prop on the relevant page. Recommended size:
1440×900, lossless WebP or PNG.

## Files of interest

- `astro.config.mjs` — site URL, Tailwind plugin.
- `src/styles/global.css` — design tokens (mirrors the desktop app).
- `src/lib/releases.ts` — R2 manifest fetcher.
- `src/lib/platforms.ts` — OS-detect inline script.
- `src/components/DownloadCTA.astro` — the hero download button + tray.
- `src/pages/*.astro` — one file per route.
