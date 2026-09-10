set shell := ["bash", "-euo", "pipefail", "-c"]

zizmor_version := "1.30.1"
actionlint_version := "1.7.12"

# List available recipes
default:
    just --list

# Lint .github/workflows/*.yml (schema + built-in shellcheck)
lint-workflows:
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v actionlint >/dev/null; then
        actionlint -color
    else
        curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7/scripts/download-actionlint.bash \
            | bash -s -- {{ actionlint_version }} /tmp
        /tmp/actionlint -color
    fi

# Validate actions/**/action.yml and workflow schemas
lint-actions:
    action-validator --verbose $(git ls-files -- 'actions/**/action.yml' 'actions/**/action.yaml' '.github/workflows/*.yml' '.github/workflows/*.yaml')

# Shellcheck the run: blocks inside composite action.yml files
lint-shell:
    ./scripts/shellcheck-actions.sh

# Security audit for unpinned refs, script injection, excess permissions, etc.
security:
    #!/usr/bin/env bash
    set -euo pipefail
    # matches ci.yml: online mode (GH_TOKEN) verifies some findings that
    # otherwise get flagged more conservatively offline.
    export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
    uvx zizmor@{{ zizmor_version }} --min-severity medium .

# Run everything ci.yml runs, locally
validate: lint-workflows lint-actions lint-shell security

# Full local dry-run of ci.yml via act (needs Docker running)
dry-run *ARGS:
    act pull_request -W .github/workflows/ci.yml {{ ARGS }}

# Install lefthook git hooks
install-hooks:
    lefthook install
