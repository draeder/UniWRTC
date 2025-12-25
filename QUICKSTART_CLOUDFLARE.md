# Quick Start - Deploy to Cloudflare in 30 seconds

## Prerequisites
- Cloudflare account (free tier works)
- Your domain on Cloudflare
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

## What the script does:
1. ✅ Checks Node.js and installs Wrangler
2. ✅ Authenticates with Cloudflare
3. ✅ Asks for your domain (e.g., `signal.peer.ooo`)
4. ✅ Updates `wrangler.toml`
5. ✅ Deploys to Cloudflare Workers
6. ✅ Gives you the live URL

## After deployment:

Update demo.html:
```javascript
const serverUrl = 'https://signal.peer.ooo/'; // Your domain
```

Then reload the demo and it will connect to your Cloudflare Workers signaling server! 🚀

## Testing

Test the server:
```bash
curl https://signal.peer.ooo/health
```

View logs:
```bash
wrangler tail --env production
```

Local development:
```bash
wrangler dev
```

That's it! Your WebRTC signaling is now on Cloudflare! 🎉
