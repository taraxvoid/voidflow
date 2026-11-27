set shell := ["bash", "-euo", "pipefail", "-c"]

# renovate: datasource=github-releases depName=zizmorcore/zizmor
zizmor_version := "1.32.0"
# renovate: datasource=github-releases depName=jdx/jactionlint
jactionlint_version := "2.3.0"
# renovate: datasource=pypi depName=check-jsonschema
check_jsonschema_version := "0.38.2"

# List available recipes
default:
    just --list

# The TypeScript steps live in package.json (lint, format, check, test), named
# like a voidflow caller's, so tool-ci and lefthook/base.yml conventions hold
# here too. The recipes below wrap them with the repo-only checks.

# Every linter: Biome, workflows, action schemas, action shell, secrets
lint: lint-ts lint-workflows lint-actions lint-shell gitleaks

# Biome lint and format check (`bun run lint`)
lint-ts:
    bun run lint

# Apply Biome fixes and formatting
format:
    bun run format

# Typecheck with tsc
check:
    bun run check

# Unit tests
test:
    bun run test

# Scan the git history for secrets
gitleaks:
    gitleaks detect --source . --redact -v --no-banner

# Lint .github/workflows/*.yml (schema + built-in shellcheck)
lint-workflows:
    #!/usr/bin/env bash
    set -euo pipefail
    # `jactionlint --version`, not `command -v`: a mise shim with no version set is on PATH but fails.
    if jactionlint --version >/dev/null 2>&1; then
        jactionlint --color
    else
        dir="${TMPDIR:-/tmp}/jactionlint-{{ jactionlint_version }}"
        if [[ ! -x "$dir/jactionlint" ]]; then
            os=$(uname -s | tr '[:upper:]' '[:lower:]')
            case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac
            tarball="jactionlint_{{ jactionlint_version }}_${os}_${arch}.tar.gz"
            mkdir -p "$dir"
            gh release download --repo jdx/jactionlint --pattern "$tarball" "v{{ jactionlint_version }}" --dir "$dir" --clobber
            gh attestation verify -R jdx/jactionlint "$dir/$tarball"
            tar xf "$dir/$tarball" -C "$dir" jactionlint
        fi
        "$dir/jactionlint" --color
    fi

# Validate actions/**/action.yml and workflow schemas against SchemaStore
lint-actions:
    #!/usr/bin/env bash
    set -euo pipefail
    action_files=()
    while IFS= read -r f; do action_files+=("$f"); done < <(git ls-files -- 'actions/**/action.yml' 'actions/**/action.yaml')
    uvx check-jsonschema@{{ check_jsonschema_version }} --builtin-schema vendor.github-actions "${action_files[@]}"
    workflow_files=()
    while IFS= read -r f; do workflow_files+=("$f"); done < <(git ls-files -- '.github/workflows/*.yml' '.github/workflows/*.yaml')
    uvx check-jsonschema@{{ check_jsonschema_version }} --builtin-schema vendor.github-workflows "${workflow_files[@]}"

# Shellcheck the run: blocks inside composite action.yml files
lint-shell:
    ./scripts/shellcheck-actions.ts

# Security audit for unpinned refs, script injection, excess permissions, etc.
security:
    #!/usr/bin/env bash
    set -euo pipefail
    # matches ci.yml: online mode (GH_TOKEN) verifies some findings that
    # otherwise get flagged more conservatively offline.
    export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
    uvx zizmor@{{ zizmor_version }} --min-severity medium .

# Offline zizmor, for the pre-push hook: online mode panics in Claude's sandbox
# (zizmor's HTTP client can't read the macOS proxy settings there). CI runs the
# online audit via `just security`.
security-offline:
    uvx zizmor@{{ zizmor_version }} --offline --min-severity medium .

# Apply zizmor's auto-fixes. Action pins live in actions.lock (gh actions-lock), so review the diff and re-run `gh actions-lock` if any `uses:` changed.
security-fix:
    #!/usr/bin/env bash
    set -euo pipefail
    export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
    uvx zizmor@{{ zizmor_version }} --min-severity medium --fix=all .

# Run everything ci.yml runs, locally
validate: lint check test security

# Full local dry-run of ci.yml via act (needs Docker running)
dry-run *ARGS:
    act pull_request -W .github/workflows/ci.yml {{ ARGS }}

# Regenerate templates/ (the files `voidflow init` writes) from their sources
templates:
    bun scripts/build-templates.ts

# Install lefthook git hooks
install-hooks:
    lefthook install

# Verify required tools are installed
doctor:
    @command -v shellcheck >/dev/null && echo "shellcheck:  $(shellcheck --version | sed -n 2p)" || echo "shellcheck:  NOT FOUND (needed for jactionlint)"
    @command -v lefthook >/dev/null && echo "lefthook:  $(lefthook version)" || echo "lefthook:  NOT FOUND (needed to run git hooks - run 'just doctor' then 'lefthook install')"
    @command -v gitleaks >/dev/null && echo "gitleaks:  $(gitleaks version)" || echo "gitleaks:  NOT FOUND (needed for 'just lint')"
    @command -v act >/dev/null && echo "act:  $(act --version)" || echo "act:  NOT FOUND (needed for local dry-run - not a blocker to commit/push)"
    @command -v fnox >/dev/null && echo "fnox:  $(fnox --version)" || echo "fnox:  NOT FOUND (run 'mise install'; supplies an admin token for 'voidflow apply tokens', see CONTRIBUTING.md)"
    @# `fnox proxy rules` validates the config without resolving the secret (a fido2 provider would need a touch)
    @command -v fnox >/dev/null && { fnox proxy rules >/dev/null 2>&1 && echo "fnox proxy:  config valid (not the stored token: 'fnox check' resolves CF_TOKEN_ADMIN)" || echo "fnox proxy:  config invalid (run 'fnox proxy rules'; see CONTRIBUTING.md)"; } || true

# Show how GitHub differs from this repo's voidflow.config.ts, from the checkout (read-only; needs gh)
plan *args:
    bun scripts/cli.ts plan {{ args }}

# Make GitHub match one preset (rulesets or settings) of this repo's voidflow.config.ts (needs repo admin via gh)
apply preset *args:
    bun scripts/cli.ts apply {{ preset }} {{ args }}

# Cut a canary X.Y.Z-next.N from main's tip and publish it under @next (approve both staged packages on npm after); run `just canary true` to only resolve the version
canary dry-run="false":
    gh workflow run release-please.yml --ref main -f canary=true -f dry-run={{ dry-run }}

# After approving a stable release on npm, move @next to it (checks it is latest and above next; needs an npm session)
sync-next version:
    bun scripts/sync-next.ts {{ version }}
