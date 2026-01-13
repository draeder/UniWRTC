#!/bin/bash

# UniWRTC Cloudflare Automated Setup Script
# Run this to setup and deploy to Cloudflare

set -e

echo "🚀 UniWRTC Cloudflare Setup"
echo "============================"
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."

if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Please install Node.js v16+"
  exit 1
fi

if ! command -v wrangler &> /dev/null; then
  echo "📦 Installing Wrangler CLI..."
  npm install -g wrangler
fi

echo "✅ Prerequisites OK"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
cd "$(dirname "$0")"
npm install || true
echo "✅ Dependencies installed"
echo ""

# Check Cloudflare authentication
echo "🔐 Checking Cloudflare authentication..."
if ! wrangler whoami &> /dev/null; then
  echo "⚠️  Not logged in to Cloudflare. Running login..."
  wrangler login
fi
echo "✅ Authenticated with Cloudflare"
echo ""

# Domain configuration
DOMAIN="peer.ooo"
SUBDOMAIN="signal"

FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"

echo "📝 Updating wrangler.toml..."
cat > wrangler.toml << EOF
name = "uniwrtc"
main = "src/index.js"
compatibility_date = "2024-12-20"

assets = { directory = "./dist", binding = "ASSETS" }

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]

[env.production]
routes = [
  { pattern = "${FULL_DOMAIN}/*", zone_name = "${DOMAIN}" }
]

assets = { directory = "./dist", binding = "ASSETS" }

[[env.production.durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[build]
command = "npm install"
EOF

echo "✅ wrangler.toml updated"
echo ""

# Deploy
echo "🚀 Deploying to Cloudflare..."
echo ""
echo "Deploying to production..."
wrangler deploy --env production

echo ""
echo "✅ Deployment Complete!"
echo ""
echo "🎉 Your UniWRTC signaling server is live at:"
echo "   https://${FULL_DOMAIN}/"
echo ""
echo "📊 Test it:"
echo "   curl https://${FULL_DOMAIN}/health"
echo ""
echo "🧪 Local testing:"
echo "   wrangler dev"
echo ""
echo "📊 View logs:"
echo "   wrangler tail --env production"
echo ""
echo "🛠️  Next: Update demo.html to use:"
echo "   const serverUrl = 'https://${FULL_DOMAIN}/';"
echo ""
