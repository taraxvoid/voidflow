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

This project uses semver. Treat `@main` as unstable. Pin to a specific version or digest eg (`@v1`)

## Self-validation

This repo validates its own workflows and composite actions (`.github/workflows/ci.yml`):

- **actionlint** — workflow schema/logic; also shellchecks `run:` steps in `.github/workflows/*.yml` automatically (`shellcheck` ships on `ubuntu-latest`)
- **action-validator** — schema-checks `actions/**/action.yml` and the workflow files
- **shellcheck** (`scripts/shellcheck-actions.sh`) — checks `run:` steps inside `actions/**/action.yml`, which actionlint doesn't reach
- **zizmor** — security audit (unpinned refs, script injection via `${{ }}` in `run:`, excess permissions, etc.)

### Local dev setup

```sh
brew install just lefthook actionlint action-validator shellcheck yq act uv
lefthook install
```

- `just validate` — run everything CI runs, locally
- `just lint-workflows` / `lint-actions` / `lint-shell` / `security` — run one check at a time
- `just dry-run` — full local run of `ci.yml` via [`act`](https://github.com/nektos/act) (needs Docker running); pass extra args, e.g. `just dry-run -j validation`
- lefthook runs the fast checks (`lint-workflows`, `lint-actions`, `lint-shell`) on `pre-commit`, and `zizmor` on `pre-push`

**Colima users:** `.actrc` already disables the docker-socket mount (`--container-daemon-socket -`) — `act` binds `/var/run/docker.sock` by default, which doesn't exist under Colima and fails with `operation not supported`. None of these workflow steps need docker-in-docker, so this is safe.

**Known `act` gaps on this repo (not bugs in the workflow itself):**
- Run `just dry-run` from a normal checkout, not a linked git worktree — `act` copies the working tree via `docker cp` rather than a real clone, so a worktree's `.git` pointer back to the parent repo doesn't resolve inside the container, and `git ls-files`-based steps (action-validator's own script, `scripts/shellcheck-actions.sh`) silently see zero files instead of erroring.
- `astral-sh/setup-uv`'s step currently crashes under `act`'s bundled Node 20 (`webidl.util.markAsUncloneable is not a function`) — a known Node-version mismatch between `act`'s embedded JS runtime and newer actions' dependencies, not something this repo can fix. actionlint and action-validator's schema check do run correctly under `act`; the zizmor step doesn't get reached until that's resolved upstream.

YMMV, caveat emptor, your satisfaction **not** guaranteed
