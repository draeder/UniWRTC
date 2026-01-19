# UniWRTC Cloudflare Deployment Guide

## Deploy (Cloudflare Pages)

This repo’s current demo works client-side (Nostr), so you can deploy just the static site to Cloudflare Pages.

### Prerequisites

1. **Cloudflare Account** - Free tier is sufficient
2. **Wrangler CLI** - Install: `npm install -g wrangler` (or use `npx`)
3. **Node.js** - v16 or higher

### Deploy

```bash
npm install
npm run deploy:cf:pages
```

Notes:
- This deploys the `dist/` folder (static hosting).
- No server routes are deployed.

## Custom Domain (signal.peer.ooo)

To serve the Pages project at `https://signal.peer.ooo`:

1. Cloudflare Dashboard → Pages → your project → **Custom domains** → add `signal.peer.ooo`
2. Cloudflare DNS → set `signal` as a CNAME to `<your-pages-project>.pages.dev`

---

For more info: [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
