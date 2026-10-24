set shell := ["bash", "-euo", "pipefail", "-c"]

# renovate: datasource=github-releases depName=zizmorcore/zizmor
zizmor_version := "1.30.1"
# renovate: datasource=github-releases depName=jdx/jactionlint
jactionlint_version := "2.1.0"
# renovate: datasource=pypi depName=check-jsonschema
check_jsonschema_version := "0.38.2"

# List available recipes
default:
    just --list

# Lint all

lint: gitleaks lint-actions lint-shell lint-workflows
    
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

# Apply zizmor's auto-fixes (e.g. pin unpinned action refs to hashes)
security-fix:
    #!/usr/bin/env bash
    set -euo pipefail
    export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
    uvx zizmor@{{ zizmor_version }} --min-severity medium --fix=all .

# Run everything ci.yml runs, locally
validate: lint security

# Full local dry-run of ci.yml via act (needs Docker running)
dry-run *ARGS:
    act pull_request -W .github/workflows/ci.yml {{ ARGS }}

# Install lefthook git hooks
install-hooks:
    lefthook install

# Verify required tools are installed
doctor:
    @command -v shellcheck >/dev/null && echo "shellcheck:  $(shellcheck --version | sed -n 2p)" || echo "shellcheck:  NOT FOUND (needed for jactionlint)"
    @command -v lefthook >/dev/null && echo "lefthook:  $(lefthook version)" || echo "lefthook:  NOT FOUND (needed to run git hooks - run 'just doctor' then 'lefthook install')"
    @command -v gitleaks >/dev/null && echo "gitleaks:  $(gitleaks version)" || echo "gitleaks:  NOT FOUND (needed for 'just lint')"
    @command -v act >/dev/null && echo "act:  $(act --version)" || echo "act:  NOT FOUND (needed for local dry-run - not a blocker to commit/push)"
    @command -v fnox >/dev/null && echo "fnox:  $(fnox --version)" || echo "fnox:  NOT FOUND (run 'mise install'; holds CF_TOKEN_ADMIN for 'just cf-tokens-*')"
    @command -v fnox >/dev/null && { fnox check >/dev/null 2>&1 && echo "CF_TOKEN_ADMIN:  resolvable via fnox" || echo "CF_TOKEN_ADMIN:  not resolvable (run 'fnox check'; see README)"; } || true

# So a relative --config (another repo's fleet map) resolves from where `just`
# was run, not this directory. See scripts/lib/config.ts.
config_base := "env VOIDFLOW_CONFIG_BASE=" + quote(invocation_directory())

# Show how each repo's branch rulesets differ from rulesets/index.ts (read-only)
rulesets-plan *args:
    {{ config_base }} bun scripts/apply-rulesets.ts {{ args }}

# Create/update branch rulesets to match rulesets/index.ts (needs repo admin via gh)
rulesets-apply *args:
    {{ config_base }} bun scripts/apply-rulesets.ts --apply {{ args }}

# CF_TOKEN_ADMIN comes from fnox (fnox.toml) unless already in the environment.
cf_admin := if env_var_or_default("CF_TOKEN_ADMIN", "") == "" { "fnox exec --" } else { "" }
cf_tokens := cf_admin + " " + config_base + " bun scripts/cf-tokens.ts"

# The cf-tokens-* recipes all take --config <module>: the fleet map in your
# infra repo (e.g. taraxvoid/infra), whose justfile wraps these.

# Show how each repo's Cloudflare deploy tokens differ from the config (read-only; needs CF_TOKEN_ADMIN and gh)
cf-tokens-plan *args:
    {{ cf_tokens }} {{ args }}

# Create/update/rotate deploy tokens and set each repo's env secret (needs CF_TOKEN_ADMIN and gh)
cf-tokens-apply *args:
    {{ cf_tokens }} --apply {{ args }}

# Print the live names of the permission group ids cloudflare/tokens.ts uses
cf-tokens-groups *args:
    {{ cf_tokens }} --groups {{ args }}

# Run a command from the invoking directory with a throwaway token scoped like <repo>'s <env> token, e.g. `cf-tokens-try ../infra/cf-tokens.ts transbot prod bunx wrangler deploy`
cf-tokens-try config repo env +cmd:
    {{ cf_tokens }} --config {{ quote(config) }} --repo {{ repo }} --try {{ env }} -- {{ cmd }}

# Open the next -> main promotion PR, set to auto-merge with a merge commit
promote:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch origin main next --quiet
    url=$(gh pr create --base main --head next \
        --title "chore: promote next to main" \
        --body "$(printf 'Commits promoted from next:\n\n%s\n\nAuto-merges with a merge commit once checks pass, so each Conventional Commit reaches release-please. Do not squash it: main would get the changes from next without its commits, and every back-merge after it conflicts.\n' "$(git log --format='- %s' origin/main..origin/next)")")
    echo "$url"
    # The main ruleset allows squash for hotfixes, so a merge button click
    # would default to it; auto-merge pins the method to a merge commit.
    gh pr merge "$url" --auto --merge

# Cut release/N.x from a stable tag in a new worktree (e.g. v0.9.3 release/0.9.x); push it yourself
cut-maintenance tag branch:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="{{ tag }}"
    branch="{{ branch }}"
    if ! bun scripts/release-channel.ts "$branch" | rg -q '^kind=maintenance$'; then
        echo "branch must look like release/0.9.x or release/1.x" >&2
        exit 1
    fi
    git fetch origin main --tags --quiet
    dir="$HOME/worktrees/voidflow/${branch//\//-}"
    git worktree add -b "$branch" "$dir" "$tag"
    # A branch cut from an older tag still runs that tag's workflows, so bring
    # the current release tooling with it or releases from it would publish
    # without dist-tags (or not run at all).
    for f in .github/workflows/release-please.yml .github/workflows/ci.yml scripts/release-channel.ts .release-please/maintenance.json; do
        mkdir -p "$dir/$(dirname "$f")"
        git show "origin/main:$f" > "$dir/$f"
    done
    jq -n --arg v "${tag#v}" '{".": $v}' > "$dir/.release-please/maintenance-manifest.json"
    git -C "$dir" add .github scripts .release-please
    git -C "$dir" commit -q -m "chore: release tooling and release-please config for ${branch}"
    echo "Created ${branch} at ${dir}. Review, then: git -C ${dir} push -u origin ${branch}"
