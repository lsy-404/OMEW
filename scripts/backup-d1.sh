#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s dump <directory> | restore <directory>\n' "$0" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
action=$1
directory=$2
database=${OMEW_D1_DATABASE:-openmew}
config="server/wrangler.jsonc"
tables=(
  users instances instance_keys guest_identity guest_member_state user_link archive_index
  instance_config invite_codes stronghold_member_index media emote_packs emotes
  stronghold_applications server_groups user_server_groups webauthn_credentials
  used_challenges totp_attempts stronghold_slug_index stronghold_feature_overrides
  stronghold_directory_index oidc_identities oidc_login_completions oidc_sessions
  user_blocks direct_messages archive_document room_backup
)

case "$action" in
  dump)
    mkdir -p "$directory"
    for table in "${tables[@]}"; do
      pnpm exec wrangler d1 export "$database" --config "$config" --remote --table "$table" --no-schema --output "$directory/$table.sql"
    done
    printf 'database=%s\nmigrations=repository-current\n' "$database" > "$directory/manifest.txt"
    ;;
  restore)
    [[ -d "$directory" ]] || { printf 'Backup directory not found: %s\n' "$directory" >&2; exit 1; }
    printf 'Restore into an empty D1 database named %s. Type the database name to continue: ' "$database" >&2
    IFS= read -r confirmation
    [[ "$confirmation" == "$database" ]] || { printf 'Restore cancelled.\n' >&2; exit 1; }
    pnpm exec wrangler d1 migrations apply "$database" --config "$config" --remote
    for table in "${tables[@]}"; do
      [[ -f "$directory/$table.sql" ]] || { printf 'Missing table dump: %s.sql\n' "$table" >&2; exit 1; }
      [[ -s "$directory/$table.sql" ]] || continue
      pnpm exec wrangler d1 execute "$database" --config "$config" --remote --yes --file "$directory/$table.sql"
    done
    pnpm exec wrangler d1 execute "$database" --config "$config" --remote --yes \
      --command "INSERT INTO archive_search(archive_search) VALUES ('rebuild')"
    ;;
  *) usage ;;
esac
