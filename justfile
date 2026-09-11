set shell := ["bash", "-euo", "pipefail", "-c"]

zizmor_version := "1.30.1"
actionlint_version := "1.7.12"
check_jsonschema_version := "0.38.0"

# List available recipes
default:
    just --list

# Lint all

lint: lint-actions lint-shell lint-workflows
    
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
validate: lint security

# Full local dry-run of ci.yml via act (needs Docker running)
dry-run *ARGS:
    act pull_request -W .github/workflows/ci.yml {{ ARGS }}

# Install lefthook git hooks
install-hooks:
    lefthook install

# Show what the changelog would look like for unreleased commits
changelog-unreleased:
    git-cliff --config cliff.toml --unreleased

# Regenerate CHANGELOG.md up to the given tag (defaults to unreleased)
changelog TAG="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ TAG }}" ]; then
        git-cliff --config cliff.toml --tag "{{ TAG }}" -o CHANGELOG.md
    else
        git-cliff --config cliff.toml -o CHANGELOG.md
    fi
