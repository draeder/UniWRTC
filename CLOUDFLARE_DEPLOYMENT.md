# UniWRTC Cloudflare Deployment Guide

## Prerequisites

1. **Cloudflare Account** - Free tier is sufficient
2. **Wrangler CLI** - Install: `npm install -g wrangler`
3. **Node.js** - v16 or higher
4. **Your Domain** - Domain must be on Cloudflare (e.g., `peer.ooo`)

## Setup Steps

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

This will open your browser to authorize the CLI.

### 3. Update wrangler.toml

Replace the zone configuration with your domain:

```toml
[env.production]
routes = [
  { pattern = "signal.peer.ooo/*", zone_name = "peer.ooo" }
]
```

### 4. Deploy to Cloudflare

```bash
# Deploy to production
wrangler publish --env production

# Or deploy to staging first
wrangler publish
```

### 5. Access Your Signaling Server

Your server will be available at:
- **Production**: `https://signal.peer.ooo/`
- **Development**: `https://uniwrtc.<subdomain>.workers.dev/`

## Using with UniWRTC Demo

Update the demo to use your Cloudflare endpoint:

```javascript
// In demo.html or client
const serverUrl = 'https://signal.peer.ooo/';
const roomId = 'my-room';

const client = new UniWRTCClient(serverUrl, { 
  roomId: roomId,
  customPeerId: 'optional-id' 
});

await client.connect();
```

## How It Works

1. **Durable Objects** - One per room, manages peer discovery
2. **WebSocket** - Browsers connect for signaling
3. **Signaling Only** - Offers/answers/ICE via Worker
4. **P2P Data** - WebRTC data channels bypass Cloudflare
5. **Free Tier** - Plenty of capacity for small deployments

## Cost

- **Requests**: 100,000 free per day (signaling only)
- **Compute**: Included in free tier
- **Durable Objects**: ~$0.15/million operations (minimal for signaling)
- **Total**: Free to very low cost

## Monitoring

Check deployment status:

```bash
wrangler tail --env production
```

View real-time logs from your Worker.

## Local Development

Test locally before deploying:

```bash
wrangler dev
```

Your local server will run at `http://localhost:8787`

Update demo to test:
```javascript
const serverUrl = 'http://localhost:8787/';
```

## Troubleshooting

**WebSocket errors**: Ensure your domain is on Cloudflare with SSL enabled

**Connection refused**: Check the Worker route pattern in `wrangler.toml`

**Durable Objects not found**: Run `wrangler publish` with migrations enabled

## Next Steps

1. Deploy the Worker
2. Update demo.html to use your Cloudflare endpoint
3. Test with multiple browsers
4. Scale up!

---

For more info: [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
