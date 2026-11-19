#!/usr/bin/env sh
# Builds and starts Obelus from the source folder, on Linux. Needs Node.js on PATH and `npm install` run once.
set -e
cd "$(dirname "$0")"
npx electron-vite build
npx electron .
