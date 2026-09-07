# voidflow

Personal re-usable GitHub Actions workflows, shared across the Astro/bun/Playwright
site repos (soundry, queeromaha, synthomaha).

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

### Script contract

`site-ci.yml` calls these `bun run <script>` names — the caller repo's
`package.json` must define all of them for the workflow to succeed:

| script                 | purpose                                                    |
| ---------------------- | ----------------------------------------------------------- |
| `lint:actions`         | actionlint over `.github/workflows/*.yml`                  |
| `lint`                 | Biome                                                       |
| `check`                | `astro check`                                               |
| `test:unit`            | vitest (no build prefix — build already ran earlier in CI) |
| `build`                | `astro build`                                               |
| `check:licenses`       | GPL-family license gate (`scripts/check-licenses.ts`)      |
| `test:e2e:full`        | Playwright, mobile-chrome only, all specs — runs on PRs into `main` |
| `test:e2e:all`         | Playwright, every project, all specs — runs on PRs into `next`/`live` |
| `test:a11y`            | axe-core a11y spec — runs on PRs into `next`/`live`         |
| `test:e2e:lighthouse`  | Lighthouse CI (`scripts/run-lhci.ts`) — runs on PRs into `live` only |

Not part of CI, but part of the same naming contract (used by local
pre-commit/pre-push hooks instead, since `bun audit` hits a remote DB and can
hang CI on a slow/offline runner — Socket's install-time scanner covers this
in CI instead):

| script      | purpose                                                        |
| ----------- | ---------------------------------------------------------------- |
| `audit`     | `bun audit`, gated to package.json/bun.lock changes             |
| `test:push` | build + audit + check + test:unit + `test:e2e:smoke`, run from `.husky/pre-push` |
| `test:e2e:smoke` | Playwright, mobile-chrome only, just the smoke spec — the fast local/pre-push tier |

`test:e2e:full` vs `test:e2e:smoke` is a spec-breadth distinction (all specs
vs. just the smoke spec), both scoped to the mobile-chrome project only.
`test:e2e:all` is the only tier that also runs the desktop-chrome project.

### Versioning

Callers currently pin `@main`. Move to a tagged ref (`@v1`) once more than
one repo depends on this and unpinned changes become risky to roll out
across all of them at once.
