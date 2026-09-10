#!/usr/bin/env bash
# Shellchecks the `run:` blocks inside composite action.yml files.
# actionlint already shellchecks .github/workflows/*.yml; it doesn't touch action.yml.
set -euo pipefail

status=0

while IFS= read -r -d '' file; do
  count=$(yq '.runs.steps // [] | length' "$file")
  for ((i = 0; i < count; i++)); do
    shell=$(yq ".runs.steps[$i].shell // \"\"" "$file")
    case "$shell" in
      bash | sh) ;;
      *) continue ;;
    esac

    script=$(yq ".runs.steps[$i].run // \"\"" "$file")
    [[ -z "$script" ]] && continue

    # ${{ ... }} is substituted by the Actions runner before the shell ever
    # sees it; shellcheck doesn't know that syntax, so swap it for a
    # placeholder var (preserves quoting context, so real SC2086-type issues
    # around it still get caught).
    script=$(sed -E 's/\$\{\{[^}]*\}\}/$GHA_EXPR/g' <<<"$script")

    if ! shellcheck -s "$shell" - <<<"$script"; then
      echo "::error file=$file::shellcheck failed on runs.steps[$i]"
      status=1
    fi
  done
done < <(git ls-files -z -- '*/action.yml' '*/action.yaml')

exit "$status"
