import { defineConfig } from 'astro/config';
import tailwind from '@tailwindcss/vite';

import cloudflare from "@astrojs/cloudflare";

// Public URL of the marketing site. Override at build time via SITE env if you
// need preview deploys with the right canonical URL (e.g. SITE=https://staging.tunnex.app).
const site = process.env.SITE || 'https://tunnex.app';

export default defineConfig({
  site,
  vite: { plugins: [tailwind()] },
  build: { inlineStylesheets: 'auto' },
  output: "hybrid",
  adapter: cloudflare()
});