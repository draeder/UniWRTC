#!/bin/bash

# UniWRTC Cloudflare Automated Setup Script
# Deploys the static demo to Cloudflare Pages.

set -e

echo "🚀 UniWRTC Cloudflare Setup (Cloudflare Pages)"
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

PROJECT_NAME=${1:-"signal-peer-ooo"}

echo "📦 Building static site..."
npm run build

echo "🚀 Deploying to Cloudflare Pages project: ${PROJECT_NAME}"

# Create the project if it doesn't exist (ignore error if it already exists)
npx wrangler pages project create "${PROJECT_NAME}" --production-branch main 2>/dev/null || true

# Deploy the built assets
npx wrangler pages deploy dist --project-name "${PROJECT_NAME}"

echo ""
echo "✅ Deployment Complete!"
echo ""
echo "🎉 Your Pages site is deployed."
echo "Next step for custom domain (manual in Cloudflare UI):"
echo "  - Pages → ${PROJECT_NAME} → Custom domains → add signal.peer.ooo"
echo "  - DNS: CNAME signal → ${PROJECT_NAME}.pages.dev"
echo ""
