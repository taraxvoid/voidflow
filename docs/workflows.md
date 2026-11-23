# Workflows and actions

The reusable CI, release and code-scanning workflows, and the deploy and preview actions. Pin each to a release SHA (see [Pinning](../README.md#pinning)).

## Site CI

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@<sha> # vX.Y.Z
```

`main` deploys to prod and PRs get previews; there are no other environment
branches. The `push` trigger validates direct pushes to `main`.

Scripts it runs, if defined:

| Script | When |
|---|---|
| `lint`, `check`, `build`, `test:unit` | always |
| `check:licenses` | lockfile or `scripts/` changed |
| `test:e2e:all` (or `test:e2e:full` if there's no `:all`) | code outside `e2e-ignore-paths` changed; always on `merge_group`, `schedule` and `workflow_dispatch` |
| `test:e2e:a11y`, `test:e2e:lighthouse` | `schedule` and `workflow_dispatch` only |

When workflows change it also runs jactionlint and
[zizmor](https://github.com/zizmorcore/zizmor) (`--min-severity medium`).
Draft PRs skip the job.

Inputs:

| Input | Default | |
|---|---|---|
| `runner` | `ubuntu-latest` | Runner label |
| `package-manager` | `bun` | `bun`, `pnpm` or `aube` |
| `build` | `true` | `false` if your e2e scripts already build |
| `build-env` | `{}` | JSON object of build env vars (not for secrets) |
| `code-paths` | all but Markdown, `docs/`, `LICENSE*`, issue templates | JSON array of globs that count as code |
| `e2e-scripts` | `[]` | JSON array of extra e2e scripts, run in order. Missing ones fail |
| `e2e-ignore-paths` | linter, git hook, Renovate, editor and vitest config | JSON array of globs whose changes alone skip e2e |
| `renovate-skip-e2e` | `true` | Skip e2e on Renovate PRs that only bump a devDependency outside `renovate-e2e-packages`. `false` opts out |
| `renovate-e2e-packages` | astro, Playwright, axe-core | JSON array of devDependency names whose Renovate bumps still run e2e (`@scope/` matches a scope) |
| `socket-scanner` | `false` | Run the bun install security scanner in CI |
| `red-audits` | `false` | A failed a11y or Lighthouse audit turns its CI job red |
| `playwright-install-with-deps` | `true` | Install Playwright system deps |

PRs that only touch non-code paths skip the work but still pass. The required
check is `validate / Validate`.

**Bun:** pin it with `.bun-version` or `"packageManager": "bun@x.y.z"`.
Without either, CI takes the latest Bun.

**pnpm / aube:** pnpm reads its version from `packageManager` and Node from
`engines`. aube must be pinned in `mise.toml` and reads Node from
`devEngines.runtime`. Both use `pnpm-lock.yaml`.

**Migrating from main/next/live:** drop `single-environment` from callers
(GitHub rejects unknown inputs). `branch-env-map` takes no inputs and fails on
`next`, `live` and pushes to other branches. a11y and Lighthouse no longer run
on PRs; add a `schedule` (below) to keep them.

**Migrating from `e2e-extra-paths`:** drop it (GitHub rejects unknown inputs).
e2e now runs for any code change outside `e2e-ignore-paths`, so paths you
listed there are already covered.

**Merge queue:** GitHub offers one on public repos owned by an organization,
and on private org repos only with Enterprise Cloud; personal repos and
private repos on other plans can't use one. Set `mergeQueue: true` in the
`rulesets` section of the repo's `voidflow.config.ts` (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#branch-rulesets)), apply it, and add
`merge_group:` to your `on:` so the required check reports on the queue's
branch.

**Scheduled a11y and Lighthouse:** jobs run on a schedule or manual
dispatch - by default a failed audit adds a warning annotation and
a job-summary line, uploads the failure reports, and leaves the run green. Set
`red-audits: true` to make a failed audit fail the run instead.

```yaml
on:
  schedule:
    - cron: '17 6 * * *'
```

**Socket scanner:** CI strips `install.security.scanner` from `bunfig.toml`
so a flaky API can't break the build; local installs still use it. Write it as
a plain `scanner = "..."` line; inline tables fail. Outside `site-ci.yml`, use
the composite action:

```yaml
- uses: oven-sh/setup-bun@<sha> # <version>
- uses: taraxvoid/voidflow/actions/bun-install@<sha> # vX.Y.Z
```

## Tool CI

For bun CLIs, TUIs and libraries: gitleaks, `lint`, `check`, `build`, `test`,
`check:licenses`, and jactionlint + [zizmor](https://github.com/zizmorcore/zizmor)
when workflows change. Reads tools from `mise.toml` and bun from
`.bun-version`. Inputs: `runner`, `socket-scanner`.

```yaml
name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/tool-ci.yml@<sha> # vX.Y.Z
```

## voidflow drift

`voidflow-drift.yml` checks GitHub against the caller's `voidflow.config.ts`
and keeps one issue, titled "voidflow: GitHub differs from voidflow.config.ts",
open while they differ, updating its body on each run and closing it once a
run is in sync. It always checks the default branch. A `check` job installs
the caller's dependencies from its lockfile (bun, pnpm or aube, detected as
the lefthook hooks do) and runs the voidflow it pins; a separate `report` job,
the only one with `issues: write`, edits the issue from that result, so the
token that writes issues never shares a job with installed code. Exit 2 (a
read failed, the token cannot read something, or the config does not load)
warns and leaves the issue alone; a failed install fails the run and leaves
it alone too. Inputs: `runner`, `socket-scanner` (as in tool-ci).
`voidflow init` writes this caller:

```yaml
name: voidflow drift
on:
  push:
    branches: [main]
  schedule:
    - cron: '17 5 * * 1'
  workflow_dispatch:

permissions: {}

jobs:
  drift:
    permissions:
      contents: read
      issues: write # the drift issue
      actions: read # environments
    uses: taraxvoid/voidflow/.github/workflows/voidflow-drift.yml@<sha> # vX.Y.Z
```

## Tool release

For tools published to npm: release-please on `main` (stable releases to
`latest`; canaries are cut from `main` on demand and published under `next`), then the packed
tarball is attested and staged with `npm stage publish`, so nothing goes live
until you approve it with 2FA, and the bytes on npm are the attested bytes.
Release-please reads `.release-please/main.json` and its
`main-manifest.json`. Needs a release bot GitHub App
(so the release PR's CI runs) and npm trusted publishing configured with
**your** workflow file (e.g. `release.yml`) and the `npm` environment.
Create that environment yourself and limit its deployment branches to
`main`: npm only checks the workflow
file and environment name, so an unrestricted environment would let any
branch's run of the caller publish.

```yaml
name: Release
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      tag: { type: string, required: true }
      dry-run: { type: boolean, default: false }

permissions: {}

jobs:
  release:
    uses: taraxvoid/voidflow/.github/workflows/tool-release.yml@<sha> # vX.Y.Z
    permissions:
      contents: write
      pull-requests: write
      id-token: write
      attestations: write
    with:
      release-bot-client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}
      tag: ${{ inputs.tag }}
      dry-run: ${{ inputs.dry-run == true }}
    secrets:
      release-bot-private-key: ${{ secrets.RELEASE_BOT_APP_PRIVATE_KEY }}
```

Inputs: `npm-environment` (default `npm`), `floating-tag` (move `v<major>` on
a stable release, default on), `runner`. voidflow's own release
(`release-please.yml`) still runs separately: it also publishes to JSR and an
unscoped mirror and back-merges `main` into `next`.

## Code scanning

Both CI workflows save gitleaks and zizmor results as a `voidflow-sarif`
artifact. To upload them to GitHub code scanning, add a job (it needs
`security-events: write`, so it's separate):

```yaml
  sarif:
    needs: validate
    if: ${{ !cancelled() && needs.validate.result != 'skipped' }}
    permissions:
      contents: read
      actions: read
      security-events: write
    uses: taraxvoid/voidflow/.github/workflows/upload-sarif.yml@<sha> # vX.Y.Z
```

Private repos need GitHub Code Security.

## Deploys

`actions/branch-env-map` maps `main` to `prod` and PRs to `preview`; any other
ref fails. Run it as the first step of the deploy job:

```yaml
jobs:
  deploy:
    name: Deploy
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # <version>
      - id: env
        uses: taraxvoid/voidflow/actions/branch-env-map@<sha> # vX.Y.Z
      - uses: taraxvoid/voidflow/actions/cloudflare-deploy@<sha> # vX.Y.Z
        with:
          env: ${{ steps.env.outputs.env }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

A job's `name:` and `environment:` can't read its own step outputs. For
GitHub deployment environments, use one deploy job for `main` and one for PRs,
each gated with an `if:`.

`cloudflare-deploy` runs `wrangler deploy --env <env>`, so `preview` needs a
matching env block in the wrangler config, or pass `command` to deploy previews
another way.

| Action | Inputs |
|---|---|
| `actions/cloudflare-deploy` | `env`, `cloudflare-api-token`, `cloudflare-account-id`, `migrate-d1`, `package-manager` (runs the migration: `bun`, `pnpm` or `aube`), `working-directory`, `command`, `token-fallback` ([details](../CONTRIBUTING.md)) |
| `actions/cloudflare-preview` | `cloudflare-api-token`, `cloudflare-account-id`, `working-directory`, `env` (wrangler environment for `--env`), `name` (default `pr-<number>`), `secrets` (dotenv lines), `github-token`, `delete` |

**Worker Previews:** `cloudflare-preview` runs `wrangler preview` per pull
request and outputs `preview-url` and `deployment-url`. With `github-token`
(and `pull-requests: write`) it keeps one PR comment with the URL, updated on
later pushes. Add `closed` to `on.pull_request.types` so the cleanup runs, and
skip forks, which get no secrets. Give the job `environment: preview` so it
reads the `preview` environment's token, not a repository secret every job can
read. A job with an environment still falls back to a repository secret of the
same name, so once the environment has its own token, delete the repo-wide
`CLOUDFLARE_API_TOKEN` (`voidflow apply tokens --prune` does).

The `preview` environment has to accept PR branches, so anyone who can push a
branch can write a job that reads its token. Previews of the prod Worker need
a token that can deploy to prod, so put them under a separate Worker instead:
add an `env.preview` block to the wrangler config (Worker `<name>-preview`, no
routes, its own `previews` block) and pass `env: preview`. Its token is then
scoped to that Worker only; both Workers can live in one account (see
[Where the secret goes](../CONTRIBUTING.md#where-the-secret-goes)).

```yaml
  preview:
    needs: validate
    if: >-
      github.event_name == 'pull_request'
      && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: preview
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@<sha> # <version>
      # install and build, unless the event is 'closed' (delete installs
      # Wrangler with npm, so it needs no setup-bun)
      - uses: taraxvoid/voidflow/actions/cloudflare-preview@<sha> # vX.Y.Z
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          env: preview # Previews under <name>-preview, not the prod Worker
          github-token: ${{ github.token }}
          delete: ${{ github.event.action == 'closed' }}
```
