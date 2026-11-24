#!/usr/bin/env bash
# Color Match: who has played? Run it on the server:
#
#   colormatch-report          # last 7 days
#   colormatch-report 30       # last 30 days
#
# It makes a fresh backup of the database, then reads that copy (never the live
# database). Players are anonymous: a "player" is one browser, and names are
# whatever people typed. Times are UTC. Simulated bots (ids "bot-...") are left out.
#
# Install (done automatically by deploy.sh):
#   sudo install -m 755 /opt/colormatch/deploy/colormatch-report.sh /usr/local/bin/colormatch-report
set -euo pipefail

DAYS="${1:-7}"
case "$DAYS" in
  '' | *[!0-9]*)
    echo "usage: colormatch-report [days]   (a whole number, default 7)"
    exit 1
    ;;
esac

BACKUP_DIR="${COLORMATCH_BACKUP_DIR:-/var/backups/colormatch}"
BACKUP_SCRIPT="${COLORMATCH_BACKUP_SCRIPT:-/etc/cron.daily/colormatch-backup}"

# The database folder is readable by root only, so run as root.
if [ "$(id -u)" -ne 0 ] && [ -z "${COLORMATCH_NO_SUDO:-}" ]; then
  exec sudo "$0" "$@"
fi

# Fresh backup, then read today's copy.
if [ -x "$BACKUP_SCRIPT" ]; then "$BACKUP_SCRIPT"; fi
DB="$BACKUP_DIR/colormatch-$(date +%F).db"
if [ ! -f "$DB" ]; then
  echo "No backup found at $DB"
  exit 1
fi

NOW_S=$(date +%s)
SINCE=$(((NOW_S - DAYS * 86400) * 1000)) # milliseconds, like the stored timestamps
SINCE14=$(((NOW_S - 14 * 86400) * 1000))

q() {
  echo
  echo "== $1"
  sqlite3 -readonly -header -column "$DB" "$2"
}

echo "Color Match report, $(date -u '+%Y-%m-%d %H:%M') UTC, period: last $DAYS day(s)"

q "Overview" "
WITH p AS (
  SELECT client_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at, COUNT(*) AS rounds
  FROM picks WHERE client_id NOT LIKE 'bot-%' GROUP BY client_id
)
SELECT COUNT(*) AS players_total,
       COALESCE(SUM(first_at >= $SINCE), 0) AS new_in_period,
       COALESCE(SUM(last_at >= $SINCE), 0) AS active_in_period,
       COALESCE(SUM(rounds), 0) AS rounds_total,
       datetime(MIN(first_at) / 1000, 'unixepoch') AS first_activity_utc,
       datetime(MAX(last_at) / 1000, 'unixepoch') AS last_activity_utc
FROM p;"

q "Games" "
SELECT COUNT(*) AS games_started,
       COALESCE(SUM(ended_at IS NOT NULL), 0) AS games_finished,
       COALESCE(SUM(round_seconds = 0), 0) AS unlimited_time_games,
       COALESCE(SUM(mode = 'rapid'), 0) AS rapid_games,
       COALESCE(SUM(mode = 'memory'), 0) AS memory_games,
       COALESCE(SUM(mode = 'memory-rapid'), 0) AS memory_rapid_games
FROM games
WHERE id IN (SELECT game_id FROM picks WHERE client_id NOT LIKE 'bot-%');"

# One row per player. 'finished' counts games that reached the end; 'missed' is
# rounds where they never locked in; id_start is only the first 6 characters of
# the private id (the full id works like a key to that player's stats page).
PLAYERS="
SELECT GROUP_CONCAT(DISTINCT p.player_name) AS names,
       COUNT(DISTINCT p.game_id) AS games,
       COUNT(DISTINCT CASE WHEN g.ended_at IS NOT NULL THEN p.game_id END) AS finished,
       COUNT(*) AS rounds,
       SUM(p.pick_hex IS NULL) AS missed,
       ROUND(AVG(p.delta_e), 1) AS avg_de,
       SUM(p.score) AS points,
       datetime(MIN(p.created_at) / 1000, 'unixepoch') AS first_seen_utc,
       datetime(MAX(p.created_at) / 1000, 'unixepoch') AS last_seen_utc,
       substr(p.client_id, 1, 6) AS id_start
FROM picks p JOIN games g ON g.id = p.game_id
WHERE p.client_id NOT LIKE 'bot-%'
GROUP BY p.client_id"

q "New players (first seen in the last $DAYS day(s))" "$PLAYERS
HAVING MIN(p.created_at) >= $SINCE
ORDER BY MIN(p.created_at) DESC;"

q "All players (most recently active first, up to 50)" "$PLAYERS
ORDER BY MAX(p.created_at) DESC
LIMIT 50;"

q "Recent games (up to 15)" "
SELECT datetime(g.started_at / 1000, 'unixepoch') AS started_utc,
       g.room_code AS room,
       g.rounds,
       CASE WHEN g.mode LIKE 'memory%' THEN g.mode || ' ' || g.memorize_seconds || 's' ELSE g.mode END AS mode,
       CASE g.round_seconds WHEN 0 THEN 'unlimited' ELSE g.round_seconds || 's' END AS time_limit,
       g.player_count AS players,
       CASE WHEN g.ended_at IS NULL THEN 'no' ELSE 'yes' END AS finished,
       (SELECT GROUP_CONCAT(DISTINCT player_name) FROM picks
         WHERE game_id = g.id AND client_id NOT LIKE 'bot-%') AS names
FROM games g
WHERE g.id IN (SELECT game_id FROM picks WHERE client_id NOT LIKE 'bot-%')
ORDER BY g.started_at DESC
LIMIT 15;"

q "Activity per day (last 14 days)" "
SELECT date(created_at / 1000, 'unixepoch') AS day_utc,
       COUNT(DISTINCT client_id) AS players,
       COUNT(DISTINCT game_id) AS games,
       COUNT(*) AS rounds
FROM picks
WHERE client_id NOT LIKE 'bot-%' AND created_at >= $SINCE14
GROUP BY day_utc
ORDER BY day_utc DESC;"

echo
