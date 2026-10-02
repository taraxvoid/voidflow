# voidflow

Shared CI and deploy pipeline for a small fleet of Astro sites on Cloudflare Workers. One set of reusable GitHub Actions workflows and composite actions keeps lint, type checks, license policy, Playwright and axe-core accessibility tests, Unlighthouse budgets, and deploys identical across every site.

- **SHA-pinned.** Every third-party action in this repo is pinned to a full commit SHA with a version comment.
- **Audited.** Workflows are checked with [zizmor](https://github.com/zizmorcore/zizmor), [actionlint](https://github.com/rhysd/actionlint), check-jsonschema and shellcheck on every change (see [Self-validation](#self-validation)).
- **In production.** It runs the pipelines for the sites listed under [Used by](#used-by), including the marketing site for [RavenFlight Industries, LLC](https://rvnflt.com/github).

It is semi-opinionated: the defaults match how my own sites are built (bun, Astro, Playwright).

## Used by

- [taraxvoid.net](https://taraxvoid.net), my portfolio
- [Queer Omaha](https://queeromaha.net), [Synth Omaha](https://synthomaha.net) and [Soundry](https://soundryomaha.net), free community sites for Omaha's queer and music scenes
- [ravenflight.io](https://ravenflight.io), RavenFlight's marketing site

## Usage

Point `uses` in your configuration at a workflow, e.g. in your `.github/workflows/ci.yml`. Pin to a release commit SHA with the version in a comment, the same way you would any third-party action (see [Versioning](#versioning)).

```yaml
name: CI
on:
  pull_request:
    branches: [main, next, live]
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@15caea203066d42cb7be021eedb6356fac6ffdec # v0.8.1
```

### Non-GitHub / self-hosted runners

Pass `runner` (defaults to GitHub runner `ubuntu-latest`)

```yaml
jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@15caea203066d42cb7be021eedb6356fac6ffdec # v0.8.1
    with:
      runner: my-hosted-runner
```

### pnpm sites, build env, extra e2e paths

```yaml
jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@<sha> # <version>
    with:
      package-manager: pnpm # default: bun
      e2e-extra-paths: '["wrangler.jsonc", "site.vars.json"]' # JSON array of globs
      build-env: ${{ format('{{"PUBLIC_SITE_URL":"https://example.com","GIT_SHA":"{0}"}}', github.sha) }}
```

With `pnpm`, the pnpm version comes from `packageManager` and Node from `volta`
or `engines` in `package.json`. The lockfile (`bun.lock` or `pnpm-lock.yaml`)
follows the package manager. `build-env` is a JSON object, visible in logs, so
no secrets.

## Workflow Types

### Validation / Checks

Runs lint, typecheck, check for GPL licenses, e2e with Playwright.

`site-ci.yml` runs these `package.json` scripts: `lint`, `check`, `build`,
`test:unit`, `check:licenses`, `test:e2e:full` (PRs into `main`),
`test:e2e:all` (PRs into `next` and `live`), `test:e2e:a11y` (`next` and
`live`), and `test:e2e:lighthouse` (`live`). A script the site does not define
is skipped with a notice, so none of them is required.

### Unlighthouse (performance / SEO budgets)

`site-ci.yml` runs `bun run test:e2e:lighthouse` on PRs into `live`. Sites
implement that script with the shared runner here, which serves the built
static directory on a free port and runs
[Unlighthouse](https://unlighthouse.dev/) against it, reusing Playwright's
Chromium. It exits non-zero if a category budget in the site's config fails.

In the site's `package.json` (pin the tag):

```json
"test:e2e:lighthouse": "bun run build && bunx --package @taraxvoid/voidflow@0.8.1 unlighthouse-runner --dir dist"
```

Options: `--dir` (default `dist`, use `dist/client` for Cloudflare adapter
builds), `--config` (default `unlighthouse.config.ts`), `--version` (pinned
Unlighthouse version). Start from
[`scripts/unlighthouse/unlighthouse.config.example.ts`](scripts/unlighthouse/unlighthouse.config.example.ts)
and add `.unlighthouse/` to the site's `.gitignore`.

### License policy

`site-ci.yml` runs `bun run check:licenses` when the lockfile or `scripts/`
change. Sites implement that script with the shared check, which runs
`license-checker` in the site's repo root and fails on GPL, AGPL, SSPL and
similar copyleft licenses (LGPL is allowed).

In the site's `package.json` (pin the tag):

```json
"check:licenses": "bunx --package @taraxvoid/voidflow@<version> check-licenses"
```

### Playwright preview config

Shared `playwright.config` for Astro sites that run e2e against
`astro preview`. It picks a free port outside CI, sets
`ASTRO_PREVIEW_BACKGROUND=false` (Astro backgrounds `preview` in agent
environments, which makes Playwright think the server exited), and drops the
`webServer` when `PLAYWRIGHT_BASE_URL` is set.

```sh
bun add -d @taraxvoid/voidflow   # or: pnpm add -D @taraxvoid/voidflow
```

```js
// playwright.config.js
import { definePreviewConfig } from '@taraxvoid/voidflow/playwright'

export default definePreviewConfig({ ciPort: 4141 })
```

The same release is also published unscoped as `voidflow` (identical code and
version, with a short pointer README), so `bun add -d voidflow` and
`import ... from 'voidflow/playwright'` work too. `@taraxvoid/voidflow` is the
canonical name.

Options: `ciPort` (required in CI), `runner` (default `bun`, e.g. `pnpm`),
`timeout` (default 30000), `projects` (default Pixel 7 and Desktop Chrome),
`testDir` (default `./test/e2e`). Requires `@playwright/test` in the site.

## Deployments

Example deployment job added to your workflow above. `resolve-env` maps the
branch to dev/staging/prod once, up front, so its output can be used both to
drive the deploy and to label the job (`Deploy [dev]`, `Deploy [staging]`,
`Deploy [prod]`). A job's `name:` can reference `needs.<job>.outputs.*` but
not a step output from within itself, hence the split:

```yaml
jobs:
  resolve-env:
    needs: validate
    if: github.event_name == 'push'
    uses: taraxvoid/voidflow/.github/workflows/resolve-env.yml@15caea203066d42cb7be021eedb6356fac6ffdec # v0.8.1

  deploy:
    name: Deploy [${{ needs.resolve-env.outputs.env }}]
    needs: resolve-env
    if: github.event_name == 'push'
    environment: ${{ needs.resolve-env.outputs.env }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: taraxvoid/voidflow/actions/cloudflare-deploy@15caea203066d42cb7be021eedb6356fac6ffdec # v0.8.1
        with:
          env: ${{ needs.resolve-env.outputs.env }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

Sites with a single production environment and per-PR previews (no `next` or
`live` branch) pass `with: { single-environment: true }` to `resolve-env.yml`
(or the same input on `actions/branch-env-map`). `main` then maps to `prod` and
`pull_request` events map to `preview`; any other ref fails.

### Versioning

This project uses semver, released with [release-please](https://github.com/googleapis/release-please)
([`release-please.yml`](.github/workflows/release-please.yml)). It keeps a standing
`chore(main): release X.Y.Z` PR open against `main`, updated as commits land. Merging it bumps
`package.json` and [`CHANGELOG.md`](CHANGELOG.md), tags `vX.Y.Z`, creates the GitHub release,
and publishes to npm. The PR is opened with the org's release-bot GitHub App token
(`RELEASE_BOT_CLIENT_ID` / `RELEASE_BOT_APP_PRIVATE_KEY`) so CI runs on it.

Commit messages should follow [Conventional Commits](https://www.conventionalcommits.org),
enforced loosely, as an advisory `commit-msg` hint (see
[`scripts/check-commit-msg.sh`](scripts/check-commit-msg.sh)), not a blocking check. They
drive the version bump and generated changelog.

Treat `@main` as unstable. Consumers should pin to the commit SHA of a release tag and
keep the version in a trailing comment, e.g. `@15caea2... # v0.8.1`, so a Renovate or
Dependabot config can bump it. There is no floating major-version tag (`@v1`) to track yet.

## Self-validation

This repo validates its own workflows and composite actions (`.github/workflows/ci.yml`):

- **actionlint**: workflow schema/logic; also shellchecks `run:` steps in `.github/workflows/*.yml` automatically (`shellcheck` ships on `ubuntu-latest`)
- **check-jsonschema**: schema-checks `actions/**/action.yml` and the workflow files against [SchemaStore](https://www.schemastore.org/)'s `github-action.json` / `github-workflow.json`
- **shellcheck** (`scripts/shellcheck-actions.ts`): checks `run:` steps inside `actions/**/action.yml`, which actionlint doesn't reach
- **zizmor**: security audit (unpinned refs, script injection via `${{ }}` in `run:`, excess permissions, etc.)

### Local dev setup

```sh
brew install just lefthook actionlint shellcheck bun act uv
lefthook install
```

- `just validate`: run everything CI runs, locally
- `just lint-workflows` / `lint-actions` / `lint-shell` / `security`: run one check at a time
- `just dry-run`: full local run of `ci.yml` via [`act`](https://github.com/nektos/act) (needs Docker running); pass extra args, e.g. `just dry-run -j validation`
- lefthook runs the fast checks (`lint-workflows`, `lint-actions`, `lint-shell`) on `pre-commit`, and `zizmor` on `pre-push`

**Colima users:** `.actrc` already disables the docker-socket mount (`--container-daemon-socket -`). `act` binds `/var/run/docker.sock` by default, which doesn't exist under Colima and fails with `operation not supported`. None of these workflow steps need docker-in-docker, so this is safe.

**Run `just dry-run` from a normal checkout, not a linked git worktree.** `act` copies the working tree via `docker cp` rather than a real clone, so a worktree's `.git` pointer back to the parent repo doesn't resolve inside the container, so `git ls-files`-based steps (schema validation, `scripts/shellcheck-actions.ts`) silently see zero files instead of erroring. Verified clean end-to-end (`🏁 Job succeeded`) from a plain clone.

Provided as is under the [MIT license](LICENSE). Issues and pull requests are welcome.
