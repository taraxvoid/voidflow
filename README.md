# voidflow

Personal re-usable GitHub Actions workflows, shared across the Astro/bun/Playwright
repos — both the public sites (soundry, queeromaha, synthomaha), on
GitHub-hosted runners, and the private ravenflight repos (rvnflt, rvnflt.com,
ravenflight.io), on their own self-hosted runners. Public, since none of
this holds secret values — every secret is passed in by the caller at call
time — which also makes it reusable/marketing-adjacent for anyone else who
wants the same setup.

## site-ci.yml

A `workflow_call` reusable workflow implementing the single "Validate" CI job
shared by those repos: lint, typecheck, unit tests, build, GPL license gate,
and a branch-tiered e2e/a11y/lighthouse suite.

### Using it

A caller repo's `.github/workflows/ci.yml` stays thin — it owns the triggers,
`site-ci.yml` owns the job:

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

### Self-hosted runners

`runner` (default `ubuntu-latest`) lets a caller run validate on its own
fleet instead of GitHub-hosted:

```yaml
jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@main
    with:
      runner: rvnflt-com
```

This is the only difference between the public-site and ravenflight-repo use
of this workflow — everything else (script contract, actionlint, license
gate, e2e tiers) is identical, so there's one file rather than two near-
duplicates. A repo whose stack doesn't match the script contract below (a
plain API service with no Playwright/e2e, say) doesn't fit this workflow —
that's a case for a different reusable workflow, not a new input here.

## Deploy actions

Deploy is deliberately **not** part of `site-ci.yml` — it varies too much
per app (build steps, binding verification, D1 migrations, post-deploy
checks) and touches production secrets, so it stays a job the caller repo
owns. These composite actions cover the part that actually repeats across
repos, following one convention: branches `main`/`next`/`live` map to
environments `dev`/`staging`/`prod`.

- **`actions/branch-env-map`** — resolves `github.ref_name` to `dev`/
  `staging`/`prod` (outputs `env`), failing loudly on any other branch.
  Use this once per deploy job, then feed its `env` output to whichever
  deploy action(s) below the job needs.
- **`actions/cloudflare-deploy`** — wraps `cloudflare/wrangler-action`
  with an optional D1-migration step first. Takes the resolved `env`,
  builds a default `deploy --env <env>` command (override via `command`
  for cases like ravenflight.io's `--config dist/server/wrangler.json`).
- **`actions/netlify-deploy`** — wraps `nwtgck/actions-netlify`; `prod`
  is a real production deploy, `dev`/`staging` are alias deploys. **Not
  yet wired into queeromaha/synthomaha/soundry** — those currently deploy
  via Netlify's own GitHub App on push to `main`, not from Actions. Using
  this action means turning that auto-deploy off first (both racing on
  the same site double-deploys), and picking a site topology (one site
  with alias deploys per env, vs. three separate sites) before it's
  wired into any repo's CI.

Example deploy job:

```yaml
jobs:
  deploy:
    needs: validate
    runs-on: rvnflt-com
    if: github.event_name == 'push'
    environment: ${{ github.ref_name == 'main' && 'dev' || github.ref_name == 'next' && 'staging' || 'prod' }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - id: env
        uses: taraxvoid/voidflow/actions/branch-env-map@main
      - uses: taraxvoid/voidflow/actions/cloudflare-deploy@main
        with:
          env: ${{ steps.env.outputs.env }}
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          migrate-d1: 'true'
```

### Workflow linting

`site-ci.yml` lints `.github/workflows/*.yml` itself, via
[reviewdog/action-actionlint](https://github.com/reviewdog/action-actionlint)
(reporter `local`, so no extra permissions needed) wrapping the real
[actionlint](https://github.com/rhysd/actionlint) binary — not a per-repo
script. Caller repos don't need a `lint:actions` script, a workflow copy, or
an `actionlint` devDependency; drop all three if a repo still has them.

For fast local/pre-commit feedback (optional — CI doesn't need it), use the
[`github-actionlint`](https://www.npmjs.com/package/github-actionlint) npm
package instead of the `actionlint` npm package: it downloads and runs the
real binary rather than reimplementing it in WASM, so error messages on
genuinely broken YAML match what CI reports instead of going opaque.

### Script contract

`site-ci.yml` calls these `bun run <script>` names — the caller repo's
`package.json` must define all of them for the workflow to succeed:

| script                 | purpose                                                    |
| ---------------------- | ----------------------------------------------------------- |
| `lint`                 | Biome                                                       |
| `check`                | `astro check`                                               |
| `test:unit`            | vitest (no build prefix — build already ran earlier in CI) |
| `build`                | `astro build`                                               |
| `check:licenses`       | GPL-family license gate (`scripts/check-licenses.ts`)      |
| `test:e2e:full`        | Playwright, mobile-chrome only, all specs — runs on PRs into `main` |
| `test:e2e:all`         | Playwright, every project, all specs — runs on PRs into `next`/`live` |
| `test:e2e:a11y`            | axe-core a11y spec — runs on PRs into `next`/`live`         |
| `test:e2e:lighthouse`  | Lighthouse CI (`scripts/run-lhci.ts`) — runs on PRs into `live` only |

Not part of CI, but part of the same naming contract (used by local
pre-commit/pre-push hooks instead, since `bun audit` hits a remote DB and can
hang CI on a slow/offline runner — Socket's install-time scanner covers this
in CI instead):

| script      | purpose                                                        |
| ----------- | ---------------------------------------------------------------- |
| `audit`     | `bun audit` — run from `.husky/pre-commit`, gated on package.json/bun.lock changes, same as `check:licenses` |
| `test`      | build + check + test:unit + `test:e2e:full` — the manual, thorough local run |
| `test:push` | build + check + test:unit + `test:e2e:smoke`, run from `.husky/pre-push` — no audit here, pushes are more frequent than manual `bun run test` so this tier stays cheap |
| `test:e2e:smoke` | Playwright, mobile-chrome only, just the smoke spec — the fast local/pre-push tier |

`test:e2e:full` vs `test:e2e:smoke` is a spec-breadth distinction (all specs
vs. just the smoke spec), both scoped to the mobile-chrome project only.
`test:e2e:all` is the only tier that also runs the desktop-chrome project.

### Versioning

Callers currently pin `@main`. Move to a tagged ref (`@v1`) once more than
one repo depends on this and unpinned changes become risky to roll out
across all of them at once.
