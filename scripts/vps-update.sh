#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

git pull --ff-only
npm ci --omit=dev
npm run prod:check
npm run deploy
pm2 startOrRestart ecosystem.config.cjs --env production
pm2 save
pm2 status xiaoji-discord-bot
