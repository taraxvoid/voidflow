# voidflow

Semi-opinionated GitHub Actions workflows for my personal sites and consultancy shop [RavenFlight Industries, LLC](https://rvnflt.com/github)

## Usage

Point `uses`  in your configuration to a workflow, e.g. in your `.github/workflows/ci.yml` 

```yaml
name: CI
on:
  pull_request:
    branches: [main, next, live]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@main
```

### Non-GitHub / self-hosted runners

Pass `runner` (defaults to GitHub runner `ubuntu-latest`)

```yaml
jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@main
    with:
      runner: my-hosted-runner
```

## Workflow Types

### Validation / Checks

Runs lint, typecheck, check for GPL licenses, e2e with Playwright

## Deployments

Example deployment job added to your workflow above:

```yaml
jobs:
  deploy:
    needs: validate
    if: github.event_name == 'push'
    environment: ${{ github.ref_name == 'main' && 'dev' || github.ref_name == 'next' && 'staging' || 'prod' }}
    steps:
      - uses: actions/checkout@v7.0.1
      - id: env
        uses: taraxvoid/voidflow/actions/branch-env-map@main
      - uses: taraxvoid/voidflow/actions/cloudflare-deploy@main
        with:
          env: ${{ steps.env.outputs.env }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### Versioning

This project uses semver, released manually in two steps (`main` requires PRs, so nothing
can push straight to it — not even Actions):

1. Dispatch [`release.yml`](.github/workflows/release.yml) (`workflow_dispatch`, with a
   `version` input) — it regenerates [`CHANGELOG.md`](CHANGELOG.md) via git-cliff, validates,
   and opens a `chore(release): prepare for vX.Y.Z` PR.
2. Merging that PR triggers [`tag-release.yml`](.github/workflows/tag-release.yml), which
   tags the merge commit and publishes the GitHub release. (Tag pushes aren't covered by
   `main`'s branch protection, only branch pushes are.)

Commit messages should follow [Conventional Commits](https://www.conventionalcommits.org) —
enforced loosely, as an advisory `commit-msg` hint (see
[`scripts/check-commit-msg.sh`](scripts/check-commit-msg.sh)), not a blocking check. They
drive the generated changelog.

Treat `@main` as unstable. Consumers should pin to an exact release tag, e.g. `@v0.3.0` —
there is no floating major-version tag (`@v1`) to track yet.

## Self-validation

This repo validates its own workflows and composite actions (`.github/workflows/ci.yml`):

- **actionlint** — workflow schema/logic; also shellchecks `run:` steps in `.github/workflows/*.yml` automatically (`shellcheck` ships on `ubuntu-latest`)
- **check-jsonschema** — schema-checks `actions/**/action.yml` and the workflow files against [SchemaStore](https://www.schemastore.org/)'s `github-action.json` / `github-workflow.json`
- **shellcheck** (`scripts/shellcheck-actions.sh`) — checks `run:` steps inside `actions/**/action.yml`, which actionlint doesn't reach
- **zizmor** — security audit (unpinned refs, script injection via `${{ }}` in `run:`, excess permissions, etc.)

### Local dev setup

```sh
brew install just lefthook actionlint shellcheck yq act uv
lefthook install
```

- `just validate` — run everything CI runs, locally
- `just lint-workflows` / `lint-actions` / `lint-shell` / `security` — run one check at a time
- `just dry-run` — full local run of `ci.yml` via [`act`](https://github.com/nektos/act) (needs Docker running); pass extra args, e.g. `just dry-run -j validation`
- lefthook runs the fast checks (`lint-workflows`, `lint-actions`, `lint-shell`) on `pre-commit`, and `zizmor` on `pre-push`

**Colima users:** `.actrc` already disables the docker-socket mount (`--container-daemon-socket -`) — `act` binds `/var/run/docker.sock` by default, which doesn't exist under Colima and fails with `operation not supported`. None of these workflow steps need docker-in-docker, so this is safe.

**Run `just dry-run` from a normal checkout, not a linked git worktree.** `act` copies the working tree via `docker cp` rather than a real clone, so a worktree's `.git` pointer back to the parent repo doesn't resolve inside the container — `git ls-files`-based steps (schema validation, `scripts/shellcheck-actions.sh`) silently see zero files instead of erroring. Verified clean end-to-end (`🏁 Job succeeded`) from a plain clone.

YMMV, caveat emptor, your satisfaction **not** guaranteed
