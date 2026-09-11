#!/usr/bin/env bash
# Friendly nudge toward Conventional Commits (https://www.conventionalcommits.org).
# This is advisory only — it never blocks a commit, it just prints a hint.
# Drives the changelog/release automation (cliff.toml).
set -euo pipefail

msg_file="$1"
first_line=$(head -n1 "$msg_file")

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+'

if [[ ! "$first_line" =~ $pattern ]]; then
  echo ""
  echo "commit-msg: this commit message doesn't look like a Conventional Commit."
  echo "            (this is just a friendly heads-up — the commit still went through)"
  echo ""
  echo "  e.g. \"feat: add reusable e2e workflow\" or \"fix(cloudflare-deploy): correct env mapping\""
  echo "  see https://www.conventionalcommits.org for the full format"
  echo ""
fi

exit 0
