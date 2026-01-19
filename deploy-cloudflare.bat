@echo off
REM UniWRTC Cloudflare Automated Setup Script (Windows)
REM Deploys the static demo to Cloudflare Pages.

setlocal enabledelayedexpansion

echo 🚀 UniWRTC Cloudflare Setup (Cloudflare Pages)
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

REM Project name
set PROJECT_NAME=signal-peer-ooo
if not "%~1"=="" set PROJECT_NAME=%~1

echo 📦 Building static site...
call npm run build

echo 🚀 Deploying to Cloudflare Pages project: %PROJECT_NAME%
echo.

REM Create project if needed (ignore errors)
call npx wrangler pages project create %PROJECT_NAME% --production-branch main >nul 2>nul

REM Deploy
call npx wrangler pages deploy dist --project-name %PROJECT_NAME%

echo.
echo ✅ Deployment Complete!
echo.
echo 🎉 Your Pages site is deployed.
echo Next step for custom domain (manual in Cloudflare UI):
echo   - Pages ^> %PROJECT_NAME% ^> Custom domains ^> add signal.peer.ooo
echo   - DNS: CNAME signal ^> %PROJECT_NAME%.pages.dev
echo.

endlocal
