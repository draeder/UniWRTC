@echo off
REM UniWRTC Cloudflare Automated Setup Script (Windows)

setlocal enabledelayedexpansion

echo 🚀 UniWRTC Cloudflare Setup
echo ============================
echo.

REM Check Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo ❌ Node.js not found. Please install Node.js v16+
  exit /b 1
)

REM Check/Install Wrangler
where wrangler >nul 2>nul
if errorlevel 1 (
  echo 📦 Installing Wrangler CLI...
  call npm install -g wrangler
)

echo ✅ Prerequisites OK
echo.

REM Install dependencies
echo 📦 Installing dependencies...
call npm install
echo ✅ Dependencies installed
echo.

REM Check authentication
echo 🔐 Checking Cloudflare authentication...
call wrangler whoami >nul 2>nul
if errorlevel 1 (
  echo ⚠️  Not logged in to Cloudflare. Running login...
  call wrangler login
)
echo ✅ Authenticated with Cloudflare
echo.

REM Ask for domain
echo 🌐 Domain Configuration
echo =====================
set /p DOMAIN="Enter your Cloudflare domain (e.g., peer.ooo): "
set /p SUBDOMAIN="Enter subdomain for signaling (e.g., signal): "

if "!DOMAIN!"=="" (
  echo ❌ Domain required
  exit /b 1
)

if "!SUBDOMAIN!"=="" (
  echo ❌ Subdomain required
  exit /b 1
)

set FULL_DOMAIN=!SUBDOMAIN!.!DOMAIN!

REM Update wrangler.toml
echo 📝 Updating wrangler.toml...
(
  echo name = "uniwrtc"
  echo main = "src/index.js"
  echo compatibility_date = "2024-12-20"
  echo.
  echo [env.production]
  echo routes = [
  echo   { pattern = "!FULL_DOMAIN!/*", zone_name = "!DOMAIN!" }
  echo ]
  echo.
  echo [[durable_objects.bindings]]
  echo name = "ROOMS"
  echo class_name = "Room"
  echo.
  echo [durable_objects]
  echo migrations = [
  echo   { tag = "v1", new_classes = ["Room"] }
  echo ]
  echo.
  echo [build]
  echo command = "npm install"
) > wrangler.toml

echo ✅ wrangler.toml updated
echo.

REM Deploy
echo 🚀 Deploying to Cloudflare...
echo.
call wrangler deploy --env production

echo.
echo ✅ Deployment Complete!
echo.
echo 🎉 Your UniWRTC signaling server is live at:
echo    https://!FULL_DOMAIN!/
echo.
echo 📊 Test it:
echo    curl https://!FULL_DOMAIN!/health
echo.
echo 🧪 Local testing:
echo    wrangler dev
echo.
echo 📊 View logs:
echo    wrangler tail --env production
echo.
echo 🛠️  Next: Update demo.html to use:
echo    const serverUrl = 'https://!FULL_DOMAIN!/';
echo.

endlocal
