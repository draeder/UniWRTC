# Quick Start - Deploy to Cloudflare

## Option A (No Durable Objects): Cloudflare Pages (static)

This repo’s current demo works client-side (Nostr), so you can deploy just the static site to Cloudflare Pages.

### Prerequisites
- Cloudflare account (free tier works)
- Node.js installed
- Wrangler CLI authenticated (`npx wrangler login`)

### Deploy
```bash
npm install
npm run deploy:cf:no-do
```

Wrangler will prompt you to pick/create a Pages project the first time.

## Prerequisites
- Cloudflare account (free tier works)
- Node.js installed

## Deploy

### macOS / Linux
```bash
chmod +x deploy-cloudflare.sh
./deploy-cloudflare.sh
```

### Windows
```bash
deploy-cloudflare.bat
```

## What this does
1. ✅ Builds the Vite site into `dist/`
2. ✅ Deploys `dist/` to Cloudflare Pages

## After deployment:

Then set your custom domain in Cloudflare Pages (and point `signal` to `<project>.pages.dev`).

That's it! Your demo is now on Cloudflare Pages (no Durable Objects).
