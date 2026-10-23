# Contributing

## Setup

```sh
mise install   # tools pinned in mise.toml
bun install    # prepare script runs `lefthook install`
```

## Checks

`just validate` runs everything CI (`.github/workflows/ci.yml`) runs:

- `just lint-workflows`: jactionlint, including shellcheck on workflow `run:` steps
- `just lint-actions`: check-jsonschema on workflows and `actions/**/action.yml`
- `just lint-shell`: shellcheck on `run:` steps in composite actions
  (`scripts/shellcheck-actions.ts`)
- `just security`: zizmor

lefthook runs the first three on `pre-commit` and zizmor on `pre-push`.

Pin every third-party action to a full commit SHA with a version comment.

### Running CI locally

`just dry-run` runs `ci.yml` under [`act`](https://github.com/nektos/act)
(needs Docker). Extra args pass through, e.g. `just dry-run -j validation`.

- Run it from a plain clone, not a git worktree. `act` copies the tree without
  resolving the worktree's `.git` pointer, so `git ls-files` steps see no files
  and pass vacuously.
- Colima works: `.actrc` already disables the docker socket mount.

## Branches and commits

Feature PRs target `next`. Use [Conventional Commits](https://www.conventionalcommits.org);
they drive version bumps and the changelog. See [`RELEASING.md`](RELEASING.md)
for the release flow.

## Branch rulesets

Rulesets for the fleet's repos are defined in
[`rulesets/index.ts`](rulesets/index.ts). Sites use `site()`, tools use
`tool()`. Needs `gh` with admin on the repos.

```sh
just rulesets-plan                  # diff every repo against the config
just rulesets-plan --repo soundry
just rulesets-plan --check          # exit 1 on drift
just rulesets-apply                 # create/update to match
just rulesets-apply --prune         # also delete rulesets listed under `retire`
```

Rulesets not in the config are reported and left alone. Repos where the API
returns 403 (private repos on a plan without rulesets) are skipped and listed.
