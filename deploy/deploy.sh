#!/usr/bin/env bash
# Update the running game to the latest commit. Run on the server as your
# normal (sudo-capable) user:  /opt/colormatch/deploy/deploy.sh
set -euo pipefail

cd /opt/colormatch
git pull --ff-only
npm ci
npm run build
# Keep the "who has played" report command (colormatch-report) up to date too.
sudo install -m 755 deploy/colormatch-report.sh /usr/local/bin/colormatch-report
sudo systemctl restart colormatch
sleep 1
curl -fsS http://127.0.0.1:3000/healthz && echo " <- colormatch is up"
