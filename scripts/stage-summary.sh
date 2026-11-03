#!/usr/bin/env bash
# Usage: stage-summary.sh <npm-stage-publish-log>
# Reads the `+ name@version (staged with id <uuid>)` line that `npm stage
# publish` prints and adds the approve command to the job summary. Trusted
# publishing tokens cannot run `npm stage list`, so the log is the only source
# of the id. Prints nothing and exits 0 when the log has no such line (a dry
# run, or a 409 for a version that is already staged).
set -euo pipefail
log=${1:?usage: stage-summary.sh <log>}
line=$(grep -E '^\+ .+ \(staged with id [0-9a-f-]+\)' "$log" | tail -n1 || true)
[ -n "$line" ] || exit 0
spec=$(sed -E 's/^\+ (.+) \(staged with id .*/\1/' <<<"$line")
id=$(sed -E 's/.*staged with id ([0-9a-f-]+)\).*/\1/' <<<"$line")
echo "::notice::${spec} staged (id ${id}); approve with 2FA: npm stage approve ${id}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Staged on npm: \`${spec}\`"
    echo
    echo "Not live until approved (2FA)."
    echo
    echo '```bash'
    echo "npm stage approve ${id}"
    echo '```'
    echo
    echo "Or use the [Staged Packages tab](https://www.npmjs.com/settings/${GITHUB_REPOSITORY_OWNER:-}/staged-packages/)."
  } >> "$GITHUB_STEP_SUMMARY"
fi
