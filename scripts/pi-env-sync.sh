#!/usr/bin/env bash
# Adds the variables a newer deploy/env/*.env.example has, and the Pi's
# /etc/verdant/*.env doesn't, with the example's defaults. Nothing already in
# a file changes: the missing variables, each with its comment from the
# example, are appended at the end. A variable that's there commented out
# (#NAME=...) counts as there. A service with no .env yet gets the example.
#
#   sudo bash /opt/verdant-os/scripts/pi-env-sync.sh
#
# Then rerun the deploy script: NEXT_PUBLIC_* values are fixed when the
# dashboard is built, and it restarts the services for the rest.
# ENV_DIR overrides /etc/verdant (for scripts/pi-env-sync-test.sh).

set -euo pipefail

EXAMPLES="$(cd "$(dirname "$0")/.." && pwd)/deploy/env"
ENV_DIR=${ENV_DIR:-/etc/verdant}

if [[ ! -w $ENV_DIR ]]; then
  echo "Can't write $ENV_DIR: run with sudo." >&2
  exit 1
fi

added=0
for example in "$EXAMPLES"/*.env.example; do
  name=$(basename "$example" .example)
  env="$ENV_DIR/$name"

  if [[ ! -e $env ]]; then
    # As in docs/PI-SERVICES.md step 4: readable by root and the farm user only
    install -m 640 "$example" "$env"
    if getent group farm > /dev/null; then chown root:farm "$env"; fi
    echo "$name: created from its example"
    continue
  fi

  missing=()
  while IFS= read -r var; do
    grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?$var=" "$env" || missing+=("$var")
  done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$example" | tr -d '=')

  if (( ${#missing[@]} == 0 )); then
    echo "$name: up to date"
    continue
  fi

  # Each missing variable's line, with the comment block right above it in the example
  {
    printf '\n# Added by scripts/pi-env-sync.sh on %s, with the example'"'"'s defaults\n' "$(date +%F)"
    for var in "${missing[@]}"; do
      awk -v var="$var" '
        /^#/ { comment = comment $0 "\n"; next }
        index($0, var "=") == 1 { printf "%s%s\n", comment, $0; exit }
        { comment = "" }
      ' "$example"
    done
  } >> "$env"
  echo "$name: added ${missing[*]}"
  added=$((added + ${#missing[@]}))
done

if (( added > 0 )); then
  echo
  echo "Check the values above, then rerun the deploy script so they take effect:"
  echo "  sudo bash /opt/verdant-os/scripts/pi-deploy.sh"
fi
