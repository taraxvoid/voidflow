# npm package, Renovate preset and git hooks

The pieces a repo installs or extends directly.

## npm package

```sh
bun add -d @taraxvoid/voidflow   # or: pnpm add -D @taraxvoid/voidflow
```

Also published as `voidflow`. `check-licenses` and `unlighthouse-runner` need
`bun` on `PATH`; the `voidflow` CLI (below) runs under Bun or Node 24+. Each
npm tarball has a GitHub build attestation;
[`RELEASING.md`](../RELEASING.md#verify-an-npm-tarball) shows how to check one.
Releases are immutable on GitHub, and `gh release verify v<version> --repo taraxvoid/voidflow`
checks it against GitHub's own attestation;
[`RELEASING.md`](../RELEASING.md#verify-a-release) has the details and the limits.

**Lighthouse budgets** - runs [Unlighthouse](https://unlighthouse.dev/) against
the build and fails on a missed budget. Options: `--dir` (default `dist`, use
`dist/client` for the Cloudflare adapter), `--config` (default
`unlighthouse.config.ts`, see [example](../scripts/unlighthouse/unlighthouse.config.example.ts)),
`--version`. Add `.unlighthouse/` to `.gitignore`.

```json
"test:e2e:lighthouse": "bun run build && unlighthouse-runner --dir dist"
```

**License check** - fails on copyleft (GPL, AGPL, EUPL and similar) and
source-available licenses (SSPL, BUSL, Elastic, Commons Clause, PolyForm).
LGPL is allowed. Compound SPDX expressions count: an `AND` or `WITH` fails if
any part is blocked, an `OR` only if every choice is. A package whose license
is only `SEE LICENSE IN <file>` isn't read.

```json
"check:licenses": "check-licenses"
```

**Fleet tools** - the `voidflow` CLI, for branch rulesets and scoped
Cloudflare deploy tokens as code (and [`init`](init.md)). Run it with `bunx` or `npx` (Node 24+) from
an org's infra repo that holds the fleet map (`--config`) and pins the version;
no voidflow checkout needed. `rulesets` needs `gh` with admin on the repos; `tokens cf`
also needs `CF_TOKEN_ADMIN`. [`docs/fleet.md`](fleet.md) covers the
infra repo, how the verbs find its config (including `~/.config/voidflow`) and
their targets; config shapes and flags are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#fleet-config---config). Experimental while
they settle: the CLI's commands and flags and the `./cloudflare` and
`./rulesets` exports may change in a minor
([`STABILITY.md`](../STABILITY.md#experimental)). Pin an exact version.

```sh
bunx @taraxvoid/voidflow@<version> plan                             # both tools, config found from ~/.config/voidflow
bunx @taraxvoid/voidflow@<version> check rulesets                   # exit 1 on drift
bunx @taraxvoid/voidflow@<version> apply rulesets --repo transbot   # or --entire-fleet; no default target
bunx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts    # plan; --check, --apply, --prune
bunx @taraxvoid/voidflow@<version> tokens cf --config cf-tokens.ts  # plan; --check, --apply, --rotate, --try
npx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts     # the same, under Node 24+
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

## Renovate

Requires the Renovate GitHub App. Extends `config:best-practices` with a 3-day
release age, grouped `chore(deps):` updates on Monday mornings, and bumps for
lefthook `ref` and annotated `justfile` versions.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>taraxvoid/voidflow"]
}
```

## Git hooks

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

Upgrading from `lefthook/site.yml` (<= v0.13): switch `configs` to
`lefthook/base.yml`.
