# voidflow

Shared CI/CD, security checks and repo config for TypeScript projects.

## What this is

- **Reusable workflows** for sites (`site-ci.yml`) and bun tools (`tool-ci.yml`),
  plus SARIF upload
- **Deploy actions** for Netlify and Cloudflare Workers, per-PR Worker
  Previews, and branch-to-environment mapping
- **npm package** with Lighthouse budgets, a copyleft license check,
  Playwright and Biome configs, and fleet tools (branch rulesets and scoped
  Cloudflare deploy tokens as code)
- **Renovate preset** and **lefthook hooks**

Works with `bun` (default), `pnpm` and `aube`. CI runs whichever
`package.json` scripts your repo defines (`lint`, `test:unit`, `test:e2e:all`,
...) and skips the rest.

## Usage

### Pinning

Pin to a release SHA with the version in a comment. Renovate keeps it current.

```yaml
uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@<sha> # vX.Y.Z
```

Canary releases are tagged `vX.Y.Z-next.N`. See [`RELEASING.md`](RELEASING.md).
[`STABILITY.md`](STABILITY.md) says what minors, patches and majors may change
and how deprecations reach you before a removal.

### Site CI

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
| `socket-scanner` | `false` | Run the bun install security scanner in CI |
| `audits-informational` | `true` | A failed a11y or Lighthouse audit warns instead of failing the run |
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

**Merge queue:** org-owned repos can use one (personal accounts can't). Set
`mergeQueue: true` on the repo's ruleset config and add `merge_group:` to
`on:` so the required check reports on the queue's branch.

**Scheduled a11y and Lighthouse:** these run only on a schedule or a manual
dispatch, and are informational: a failed audit adds a warning annotation and
a job-summary line, uploads the failure reports, and leaves the run green. Set
`audits-informational: false` to make a failed audit fail the run (the
behaviour before 1.0). The cron is the caller's; drop it to stop running them:

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

### Tool CI

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

### Code scanning

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

### Deploys

`actions/branch-env-map` maps `main` → `prod` and PRs → `preview`; any other
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
another way. `netlify-deploy` makes `prod` a production deploy and anything else
an alias deploy.

| Action | Inputs |
|---|---|
| `actions/cloudflare-deploy` | `env`, `cloudflare-api-token`, `cloudflare-account-id`, `migrate-d1`, `package-manager` (runs the migration: `bun`, `pnpm` or `aube`), `working-directory`, `command`, `token-fallback` ([details](CONTRIBUTING.md)) |
| `actions/cloudflare-preview` | `cloudflare-api-token`, `cloudflare-account-id`, `working-directory`, `name` (default `pr-<number>`), `secrets` (dotenv lines), `github-token`, `delete` |
| `actions/netlify-deploy` | `env`, `publish-dir`, `netlify-auth-token`, `netlify-site-id`, `working-directory`, `github-token` |

For Netlify, turn off the site's own GitHub auto-deploy or it will deploy twice.

**Worker Previews:** `cloudflare-preview` runs `wrangler preview` per pull
request and outputs `preview-url` and `deployment-url`. With `github-token`
(and `pull-requests: write`) it keeps one PR comment with the URL, updated on
later pushes. Add `closed` to `on.pull_request.types` so the cleanup runs, and
skip forks, which get no secrets:

```yaml
  preview:
    needs: validate
    if: >-
      github.event_name == 'pull_request'
      && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@<sha> # <version>
      # install and build, unless the event is 'closed'
      - uses: taraxvoid/voidflow/actions/cloudflare-preview@<sha> # vX.Y.Z
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          github-token: ${{ github.token }}
          delete: ${{ github.event.action == 'closed' }}
```

### npm package

```sh
bun add -d @taraxvoid/voidflow   # or: pnpm add -D @taraxvoid/voidflow
```

Also published as `voidflow`. The bins need `bun` on `PATH`. Each npm tarball
has a GitHub build attestation; [`RELEASING.md`](RELEASING.md#verify-an-npm-tarball)
shows how to check one.

**Lighthouse budgets** - runs [Unlighthouse](https://unlighthouse.dev/) against
the build and fails on a missed budget. Options: `--dir` (default `dist`, use
`dist/client` for the Cloudflare adapter), `--config` (default
`unlighthouse.config.ts`, see [example](scripts/unlighthouse/unlighthouse.config.example.ts)),
`--version`. Add `.unlighthouse/` to `.gitignore`.

```json
"test:e2e:lighthouse": "bun run build && unlighthouse-runner --dir dist"
```

**License check** - fails on GPL, AGPL, SSPL and similar. LGPL is allowed.

```json
"check:licenses": "check-licenses"
```

**Fleet tools** - the `voidflow` CLI, for branch rulesets and scoped
Cloudflare deploy tokens as code. Run it with `bunx` from an org's infra repo
that holds the fleet map (`--config`) and pins the version; no voidflow
checkout needed. `rulesets` needs `gh` with admin on the repos; `cf-tokens`
also needs `CF_TOKEN_ADMIN`. Config shapes and flags are in
[`CONTRIBUTING.md`](CONTRIBUTING.md#fleet-config---config). Experimental while
they settle: the CLI's commands and flags and the `./cloudflare` and
`./rulesets` exports may change in a minor
([`STABILITY.md`](STABILITY.md#experimental)). Pin an exact version.

```sh
bunx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts    # plan; --check, --apply, --prune
bunx @taraxvoid/voidflow@<version> cf-tokens --config cf-tokens.ts  # plan; --check, --apply, --rotate, --try
```

**Playwright** - for Astro sites testing against `astro preview`. Needs
`@playwright/test`. Options: `ciPort` (required in CI), `runner` (`bun`),
`timeout` (`30000`), `projects` (Pixel 7, Desktop Chrome), `testDir`
(`./test/e2e`). Skips `webServer` when `PLAYWRIGHT_BASE_URL` is set.

```js
// playwright.config.js
import { definePreviewConfig } from '@taraxvoid/voidflow/playwright'

export default definePreviewConfig({ ciPort: 4141 })
```

**Biome** (v2) - 4-space indent, width 80, single quotes, `recommended` rules.
Lists merge with the base; scalar values in your config win.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "extends": ["@taraxvoid/voidflow/biome"],
  "files": {
    "includes": ["**", "!**/bun.lock", "!public/admin/**"]
  }
}
```

### Renovate

Requires the Renovate GitHub App. Extends `config:best-practices` with a 3-day
release age, grouped `chore(deps):` updates on Monday mornings, and bumps for
lefthook `ref` and annotated `justfile` versions.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>taraxvoid/voidflow"]
}
```

### Git hooks

Shared lefthook hooks for bun, pnpm or aube repos (aube is detected from
`packageManager`). Each step runs your `package.json` script if it exists.

- `pre-commit`: dependency guard, `format`, `lint:actions`, `check`,
  `test:unit`, plus `check:licenses` / `audit` when the lockfile changed
- `commit-msg`: Conventional Commits hint (non-blocking)
- `pre-push`: stops if the remote is ahead, then `test:push`

```yaml
# lefthook.yml
remotes:
  - git_url: https://github.com/taraxvoid/voidflow
    ref: vX.Y.Z # a tag, not a SHA
    configs:
      - lefthook/base.yml
```

```toml
# mise.toml
[tools]
lefthook = "2.2.1"
gitleaks = "8.30.1"
jactionlint = "2.1.0"
```

```json
"prepare": "lefthook install || echo 'lefthook not installed (run mise install); git hooks skipped'"
```

Define `test:unit:precommit` or `check:precommit` (e.g. `bun test --changed`)
to run less on commit. Don't set `parallel: true` on `pre-commit`; it breaks
the shared steps' ordering.

Upgrading from `lefthook/site.yml` (≤ v0.13): switch `configs` to
`lefthook/base.yml`.

## Used by

[taraxvoid.net](https://taraxvoid.net), [Queer Omaha](https://queeromaha.net),
[Synth Omaha](https://synthomaha.net), [Soundry](https://soundryomaha.org).

Badge:

```html
<a href="https://github.com/taraxvoid/voidflow">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/CI-voidflow-8b8fd9?labelColor=2b2d3a&style=flat">
    <img alt="CI: voidflow" src="https://img.shields.io/badge/CI-voidflow-5a5fb8?labelColor=3a3d4d&style=flat">
  </picture>
</a>
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). MIT licensed.
