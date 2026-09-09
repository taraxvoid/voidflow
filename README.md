# voidflow

Semi-opinionated GitHub Actions workflows for [RavenFlight Industries, LLC](https://rvnflt.com/github)

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

YMMV, caveat emptor, your satisfaction **not** guaranteed
