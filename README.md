# Color Match (multiplayer)

Up to 30 players join a room with a 5-letter code and match the **same set of colors**
(5 or 10 rounds, 15 s to 1 minute each, or **unlimited time in solo games**). Scores are computed on the server from the CIEDE2000
color difference, and every pick is stored in SQLite. Each player has a personal
**history analysis page** (`/stats`): error by hue, lightness/saturation bias, speed vs.
accuracy, progress over time, and plain-language findings.

- **Client:** TypeScript + Vite, no framework (about 8 kB gzipped for the game, 5 kB more for the stats page), `vanilla-colorful` picker, hand-written SVG charts
- **Server:** Node + `ws`, rooms in memory, built-in `node:sqlite` (no native modules to compile)
- **Shared:** color generation and scoring (`chroma-js`), the wire protocol and its validation

Requires **Node 24 or newer** (developed and tested on Node 26.13.1).

## Run it locally

```bash
npm install
npm run build && npm start          # http://localhost:3000
```

For development with hot reload, use two terminals:

```bash
npm run dev:server                  # game server on :3000
npm run dev:client                  # Vite on http://localhost:5173 (proxies /ws to :3000)
```

To try it alone, create a room, then fill it with bots (the host still presses Start):

```bash
npm run simulate -- ABCDE 20        # 20 bots join room ABCDE
```

To preview the stats page with a believable history (written to a **separate** database,
`data/demo.db`, never your real one):

```powershell
npm run seed-demo
$env:DB_FILE = 'data/demo.db'; npm start
# in the browser console on http://localhost:3000 :
#   localStorage.setItem('cm.clientId', 'demo-client-0001')
# then open http://localhost:3000/stats
```

To check the round review without playing, run `npm run dev:client` and open
`http://localhost:5173/mockup-review.html` (two sample games and the saved image; dev only).

To act as several players in **one** browser, add `?profile=2`, `?profile=3`, ... to the URL;
each profile gets its own stored identity. Normal players never need this.

```bash
npm test                            # unit + 30-player websocket integration tests
npm run typecheck
```

## How a game works

1. The host creates a room; the server returns a code. Players join with it (or an invite link
   `/?room=CODE`). The lobby locks when the game starts.
2. The server picks a random seed and generates the colors from it. Hues are **stratified** (one
   color per hue sector, shuffled) so every game covers the whole wheel; this matters for the
   per-hue statistics later.
3. Each round the server sends only that round's color plus a deadline. Players lock in a pick;
   the round ends when everyone connected has locked in, or at the deadline plus a 1.5 s grace
   window for lag (the same for everyone). Missed rounds score 0.

   **Slow or far-away connections:** while a player is still choosing, their browser sends the color
   on screen to the server as a *draft* (at most 4 times a second; never shown to others). If the
   round ends before they lock in, the server scores their latest draft, as if they had locked in
   at the buzzer, so a late timer or a lagging phone can't turn a chosen color into a miss. A color
   the player never touched is never sent, so doing nothing still scores 0. Countdowns use a clock
   synced with a ping/pong exchange (the lowest-round-trip sample wins), so they stay accurate on a
   high-latency link. To test this yourself, put a phone on mobile data behind a VPN exit in
   another country.

   **Touch screens:** the picker area never scrolls the page (CSS `touch-action: none` on the whole
   picker plus a non-passive `touchstart`/`touchmove` handler for browsers that ignore it), the hue
   slider has a 44 px touch area around its 24 px visible bar, and the page uses `100dvh` so iPhones
   don't make a page scrollable that already fits. The picker is the `vanilla-colorful` web
   component; if touch problems persist, the next step is replacing it with a pointer-events
   picker (multi-touch safe), because the library follows `touches[0]`, the first finger on the
   whole screen.
4. After each round everyone sees all picks, ΔE, points and the standings. After the last round:
   podium and full table. The host can start another game.
5. **Review my rounds** (final screen, or tap a color chip to open it at that round): one row per
   round with the target beside your pick, points and ΔE, and three mini sliders for **hue,
   saturation and brightness**. Each slider shows the target as a tick and your pick as a dot on
   top of it, so you can see which way you were off and by how much. All three bars use the same
   100-unit scale (hue shows the target ±50°). A tip at the top sums up the game ("You tend to
   pick colors too muted."), counting a miss under 5 units as good. **Save as image** draws the
   same review into a PNG (the share sheet on phones, a download elsewhere). The bars use HSV, the
   same model as the picker; scoring still uses ΔE.
   The server sends each player only their own rounds (`yourRounds` in the `final` message).

Scoring: `points = round(100 * exp(-ΔE / 18))` per round. Ties are broken by total time.

**Time per round:** 15, 20, 30 or 60 seconds, or **Unlimited (solo only)**. An unlimited round has no
timer and ends when the player locks in. It exists only for single-player games: with two or more
players one person could stall everyone, so the server refuses it (`solo_only`), the lobby disables
the option while others are connected, and a lobby set to unlimited falls back to 20 seconds when a
second player joins. A solo player who closes the tab mid-round can resume; the room is cleaned up
after about 10 minutes with nobody connected. Unlimited games are stored with `round_seconds = 0`,
and the time recorded for a pick is capped at one hour. They also count in the stats page, so long,
careful picks show up in the "time taken" bands.

**Reconnecting:** the browser keeps an anonymous id (`localStorage`) and the room code
(`sessionStorage`). Refreshing or losing the connection puts you back in your seat, including
mid-round. Opening the game in a second tab takes over the seat.

**Honest limitation:** the target color has to reach the browser to be displayed, so a determined
player can read it from dev tools and type the exact hex. The server fixes what it can (it scores,
it never sends future colors, picks are hidden until the reveal) but this is a game for friends
and classrooms, not a tournament. A "memory mode" would not change that.

## Stored data

`data/colormatch.db` (override with `DB_FILE`). `client_id` is the player's anonymous private id;
it is never sent to other players.

```
games(id, room_code, seed, rounds, round_seconds, player_count, started_at, ended_at)
picks(id, game_id, round, client_id, player_name, target_hex, pick_hex, delta_e, score, time_ms,
      target_l, target_c, target_h, pick_l, pick_c, pick_h, created_at)
```

`*_l/c/h` are CIE LCH values (hue is NULL for near-grays). Missed rounds have `pick_hex = NULL`.
Examples for the future analysis page:

```sql
-- Average color error by hue sector (12 bins) for one player
SELECT CAST(target_h / 30 AS INTEGER) AS hue_bin, COUNT(*) AS n, ROUND(AVG(delta_e), 1) AS avg_de
FROM picks WHERE client_id = ? AND pick_hex IS NOT NULL AND target_h IS NOT NULL
GROUP BY hue_bin ORDER BY hue_bin;

-- Systematic bias: positive = picks are lighter / more saturated than the target
SELECT ROUND(AVG(pick_l - target_l), 1) AS lightness_bias, ROUND(AVG(pick_c - target_c), 1) AS chroma_bias
FROM picks WHERE client_id = ? AND pick_hex IS NOT NULL;

-- Hue drift needs the wrapped difference (see hueDiff() in src/shared/colors.ts)
```

## History analysis page (`/stats`)

Every player gets a private page about their own play, linked from the home and final screens.
It is computed on the server from the pick log (`src/server/stats.ts`, a pure function with
tests) and drawn in the browser with small hand-written SVG/HTML charts (`src/client/charts.ts`).

- **Headline numbers:** average error (ΔE) next to everyone's average, rounds, points per round, best game.
- **What stands out:** plain-language findings that only appear when there is enough data and the
  effect is big enough to matter (hardest/easiest hue, "you pick too light", "you drift toward
  violet on blues", "slower picks are better", "you are improving", too many missed rounds).
- **Error by hue:** 12 sectors of the color wheel, with the "everyone" average as a tick.
  Sectors with fewer than 5 picks are drawn faded; comparisons with everyone need 50+ picks per sector.
- **Do you miss in one direction?** Signed lightness and saturation bias.
- **Where it gets harder:** error by target lightness, target saturation and time taken.
- **Progress over time:** error per game for the last 30 games.
- **Every chart has a "Show as table" twin** and keyboard-focusable marks with the same tooltip as hover.

Privacy and security: the page identifies you by the random id the browser keeps in `localStorage`
(no account). It is sent in a POST body, never in a URL. Other players' ids are never exposed; asking
for an unknown id returns an empty history. "Delete my history" removes all of a player's picks.
Simulated bots (`bot-...` ids) are excluded from the "everyone" numbers. The API endpoints are
`POST /api/stats` and `POST /api/delete` (rate limited, 512-byte bodies, no CORS headers).
Limitation: anyone who obtains a player's id (for example from their browser) can read that player's
history; this is the price of having no accounts. Clearing browser data starts a fresh history.

## Checking who has played (for you, the admin)

On the server, one command makes a fresh backup and prints a report from it:

```bash
colormatch-report        # last 7 days
colormatch-report 30     # last 30 days
```

It shows an overview (players, new and active players, games, unlimited-time games), new players
in the period, all players (names, games, finished games, rounds, missed rounds, average ΔE,
points, first/last seen), recent games and activity per day. Times are UTC. A "player" is one
browser, not a person, and names are whatever people typed. Only the first 6 characters of each
private id are shown. The script is `deploy/colormatch-report.sh`; `deploy.sh` installs it as
`/usr/local/bin/colormatch-report`. It reads the backup copy, never the live database, and it asks
for your sudo password because the database folder is root-only.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to play from phones on your LAN |
| `DB_FILE` | `data/colormatch.db` | SQLite file |
| `STATIC_DIR` | `dist/client` | Built client |
| `ALLOWED_ORIGINS` | *(empty = any)* | Comma-separated websocket origins, e.g. `https://colorpick.fun` |

## Deploy on a Vultr VPS (Ubuntu LTS)

Plan: **Cloud Compute, Regular Performance, 1 vCPU / 1 GB RAM, with an IPv4 address** (not the
IPv6-only tier). Check the checkout page for current prices.

1. **DNS.** Add `A` records for `@` and `www` pointing at the server's IPv4 address.
2. **First login and user** (as root):
   ```bash
   adduser deploy && usermod -aG sudo deploy
   rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
   ```
   Log in as `deploy` from now on (optionally disable root and password SSH login).
3. **Install Node 24 and Caddy** (as `deploy`):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs git debian-keyring debian-archive-keyring apt-transport-https curl
   # Caddy: follow https://caddyserver.com/docs/install#debian-ubuntu-raspbian
   ```
4. **Get the code and build it:**
   ```bash
   sudo mkdir /opt/colormatch && sudo chown deploy:deploy /opt/colormatch
   git clone <your repo url> /opt/colormatch
   cd /opt/colormatch && npm ci && npm run build
   ```
5. **Run it as a service** (edit `ALLOWED_ORIGINS` and your domain first):
   ```bash
   sudo cp deploy/colormatch.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now colormatch
   curl http://127.0.0.1:3000/healthz        # -> ok
   ```
6. **HTTPS reverse proxy:**
   ```bash
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile      # edit the domain first
   sudo systemctl reload caddy
   ```
   Caddy fetches the certificate automatically once DNS points at the server. Open your domain.
7. **Update later:** `/opt/colormatch/deploy/deploy.sh` (pull, install, build, restart).
8. **Back up the database** (the game history is the only state worth keeping):
   ```bash
   sudo apt-get install -y sqlite3
   # crontab -e :
   0 4 * * * sqlite3 /var/lib/colormatch/colormatch.db ".backup '/home/deploy/colormatch-$(date +\%F).db'"
   ```
   Then copy those files off the server now and then (Vultr's paid backups work too).

Moving from GitHub Pages: after the new site works, delete the old repo's `CNAME` file and
turn off Pages there, so the domain is not claimed twice.

Logs: `journalctl -u colormatch -f`. Capacity: rooms live in memory and messages are tiny;
the 1 GB plan comfortably handles many simultaneous 30-player rooms. The server caps rooms at 500,
and each connection is rate limited.

## Project layout

```
src/shared/    protocol.ts (messages + validation), colors.ts (seeded colors, ΔE, scoring), review.ts (round review: HSV bars, tip), labels.ts, stats.ts (stats types)
src/server/    room.ts (game state machine), game-server.ts (rooms, rate limits), db.ts, stats.ts (analysis), app.ts (http, ws, /api)
src/client/    main.ts + views.ts (the game), review.ts (review sheet + saved image), stats.ts + charts.ts (the stats page), identity.ts, net.ts, dom.ts, styles.css
               mockup-review.* (dev-only preview of the review with sample data)
test/          unit tests (fake clock), stats tests, API tests, and a real-websocket 30-player game
scripts/       simulate.ts (bots), seed-demo.ts (fake history for the stats page)
deploy/        Caddyfile, systemd unit, deploy.sh
```

## Ideas not built yet

Daily challenge (a date-based seed), a memory mode, accounts so history survives clearing browser
data (and so a stolen id cannot read someone's page), spectator view, per-hue lightness/hue-drift
charts on the stats page (the numbers are already in the table view).
