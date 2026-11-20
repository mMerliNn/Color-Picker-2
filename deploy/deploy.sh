#!/usr/bin/env bash
# Update the running game to the latest commit. Run on the server as your
# normal (sudo-capable) user:  /opt/colormatch/deploy/deploy.sh
set -euo pipefail

cd /opt/colormatch
git pull --ff-only
npm ci
npm run build
sudo systemctl restart colormatch
sleep 1
curl -fsS http://127.0.0.1:3000/healthz && echo " <- colormatch is up"
