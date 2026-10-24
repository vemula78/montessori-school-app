#!/bin/sh
# Backup of the school's cloud database: table definitions, ALL rows (including the sign-in accounts in auth.users)
# and database roles, sealed in an AES-256 encrypted disk image with the date in its name. docs/GO-LIVE.md, step 15.
#
#   sh scripts/backup.sh <folder>       e.g. sh scripts/backup.sh /Volumes/SchoolBackup
#   sh scripts/backup.sh --count <data.sql>   rows per table in a data dump (used by the restore check)
#
# Runs on the Mac where `supabase link` was done (the project folder), with Docker running (`supabase db dump` uses it).
# The database password is asked for by the Supabase tool when needed; this script never stores it. The disk image
# password is asked for by macOS (hdiutil); keep it in the password manager. Photos (Storage) are NOT in a dump.
# The plain-text dump exists only in a private temporary folder and is removed when the script ends.
set -eu

count_rows() {
  # COPY <table> (...) FROM stdin; ... \.   (pg_dump --use-copy format) → "<schema.table> <rows>"
  awk '
    /^COPY / { t = $2; gsub(/"/, "", t); n = 0; inside = 1; next }
    inside && $0 == "\\." { print t, n; inside = 0; next }
    inside { n++ }
  ' "$1"
}

if [ "${1:-}" = "--count" ]; then
  [ -f "${2:-}" ] || { echo "Usage: sh scripts/backup.sh --count <data.sql>" >&2; exit 2; }
  count_rows "$2"
  exit 0
fi

DEST="${1:-}"
if [ -z "$DEST" ]; then
  echo "Usage: sh scripts/backup.sh <folder for the encrypted backup>" >&2
  echo "Use an external disk or a folder that is NOT synced to iCloud, Google Drive, Dropbox or OneDrive." >&2
  exit 2
fi
case "$DEST" in
  *"Mobile Documents"*|*CloudStorage*|*"Google Drive"*|*Dropbox*|*OneDrive*|*iCloud*|*/Desktop*|*/Documents*)
    echo "Refused: $DEST looks like a synced folder (iCloud also syncs Desktop and Documents when that option is on)." >&2
    echo "The backup holds every child's record; keep it on an external disk or another folder that is not synced." >&2
    exit 2 ;;
esac
[ -d "$DEST" ] || { echo "No such folder: $DEST" >&2; exit 2; }
for tool in supabase hdiutil awk; do command -v "$tool" >/dev/null 2>&1 || { echo "Missing tool: $tool" >&2; exit 2; }; done

cd "$(dirname "$0")/.."
STAMP=$(date +%Y-%m-%d)
OUT="$DEST/school-backup-$STAMP.dmg"
[ ! -e "$OUT" ] || { echo "Already exists: $OUT (one backup per day; move or rename the old one first)" >&2; exit 2; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/school-backup.XXXXXX")
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT INT TERM

echo "1/4 table definitions"; supabase db dump --linked -f "$WORK/schema.sql"
echo "2/4 all rows (public, auth and the other schemas the tool includes)"; supabase db dump --linked --data-only --use-copy -f "$WORK/data.sql"
echo "3/4 database roles"; supabase db dump --linked --role-only -f "$WORK/roles.sql"

count_rows "$WORK/data.sql" > "$WORK/row-counts.txt"
echo "Rows per table in this backup:"; cat "$WORK/row-counts.txt"
problem=""
grep -q '^auth\.users ' "$WORK/row-counts.txt" || problem="$problem auth.users (sign-in accounts) is not in the dump;"
grep -Eq '^public\.students [1-9]' "$WORK/row-counts.txt" || problem="$problem public.students has no rows;"
if [ -n "$problem" ]; then
  echo "STOP: this backup is incomplete:$problem nothing was saved. Send this message (not the files) to the developer." >&2
  exit 1
fi

echo "4/4 sealing into an encrypted disk image (macOS asks for a NEW password for it: save it in the password manager)"
hdiutil create -quiet -srcfolder "$WORK" -volname "school-backup-$STAMP" -encryption AES-256 -format UDZO "$OUT"
echo "Saved: $OUT"
echo "Photos are not in this backup (see docs/GO-LIVE.md, step 15)."
