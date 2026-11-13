# voidflow

Secure-by-default CI/CD, GitHub repo settings and git hooks for TypeScript
repos, set up with one command:

```sh
npx @taraxvoid/voidflow init --kind site --apply    # an Astro site
npx @taraxvoid/voidflow init --kind tool --apply    # a bun CLI, TUI or library
```

Built for Astro sites, bun tools and Cloudflare deploys. Works with `bun`,
`pnpm`, `aube` and `npm`.

## What you get

- **CI** that runs your `lint`, `check`, `build` and test scripts on every PR,
  plus gitleaks, jactionlint and [zizmor](https://github.com/zizmorcore/zizmor)
  on workflow changes
- **Deploys** to Cloudflare Workers from `main`, with a Worker Preview per PR
- **Locked-down GitHub settings**: PRs and issues from collaborators only,
  Dependabot alerts and security updates, secret scanning with push protection,
  CodeQL
- **Branch rulesets** that protect `main` from pwn requests and agent
  misbehavior (opt-in)
- **Renovate** with a release-age delay and grouped weekly updates
- **A license check** that fails on copyleft and source-available dependencies
- **lefthook git hooks** that run the same checks before you push
- **Biome, Playwright and Lighthouse budgets**, preconfigured
- **(experimental) deps-review**, a [GitHub Agentic Workflow](https://github.github.com/gh-aw/)
  that judges dependency PRs so low-risk ones can merge themselves

## Quick start

`init` needs Node 24+ (or Bun), a git work tree, and the
[`gh` CLI](https://cli.github.com/) logged in with admin on the repo for the
settings half. `bunx @taraxvoid/voidflow init --kind tool --apply` works the same as
`npx`.

**New Astro site:**

```sh
bun create astro my-site
cd my-site
npx @taraxvoid/voidflow init --kind site --apply
```

Commit what it wrote and push.

**New tool:** run `git init`, add a `package.json`, then:

```sh
npx @taraxvoid/voidflow init --kind tool --apply
```

**Existing repo:** preview first. `init` is additive: it merges `.gitignore` and
`package.json`, and stops without writing anything if another file it would
write already exists with different content.

```sh
npx @taraxvoid/voidflow init --kind site                     # plans only
npx @taraxvoid/voidflow init --kind site --apply --skip renovate   # keep your own renovate.json
```

**After the first push**, add branch rulesets (they block direct pushes to
`main`, so they're never part of the default run) and re-run settings so
CodeQL has code to scan:

```sh
npx @taraxvoid/voidflow init --kind tool --preset rulesets --apply
npx @taraxvoid/voidflow init --preset settings --apply
```

Re-running is always safe: files and settings already as wanted are reported
`unchanged`. To pull in a newer voidflow's starter files, re-run with the new
version and `--force` to overwrite the ones that differ.

## `init` reference

`init` is experimental: its flags may change in a minor
([`STABILITY.md`](STABILITY.md#experimental)).

### Presets

| `--preset` | Does |
|---|---|
| `full` (default) | starter files and repo settings |
| `files` | starter files only |
| `settings` | repo settings only (no `--kind` needed) |
| `ci` | only `.github/workflows/ci.yml` |
| `codeowners` | only `.github/CODEOWNERS` |
| `rulesets` | only branch rulesets: `tool()` by default, or the repo's entry from your fleet map with `--config <module>` (required for sites) |

### Flags

| Flag | Effect |
|---|---|
| `--kind tool\|site` | which starter files to write; required except with `--preset settings` or `rulesets --config` |
| `--skip <name>` | leave one file or setting out (repeatable, [names below](#skip-names)) |
| `--config <file\|dir>` | the fleet rulesets config in your infra repo (a directory means its `rulesets.ts`). With `--preset rulesets`, apply this repo's entry from it instead of the default `tool()` (required for `--kind site`). Otherwise, add the repo to it (as `'owner/name': {},`, or under `orgs.<owner>.repos` in an [org-grouped](docs/fleet.md#config-shapes) config); comments and other entries are left as written. Review and commit that file, then run `voidflow plan rulesets` and `voidflow apply rulesets --repo <name>` |
| `--enable-pvr` | opt in: private vulnerability reporting, and a `SECURITY.md` pointing at it |
| `--enable-ai-scan` | opt in: AI Scan for pull requests (preview) |
| `--enable-agentic` | opt in, experimental: [deps-review](#deps-review) and the repo settings and labels it relies on. The `COPILOT_GITHUB_TOKEN` secret is a manual step: add it as an Actions secret and again as a Dependabot secret, since runs Dependabot triggers only see Dependabot secrets |
| `--agentic-stage shadow\|gate` | with `--enable-agentic`: `shadow` (default, nothing merges) or `gate` (adds the gate job and Renovate automerge). Automerge is only safe once `deps-review` is a required status check, which init does not set: add it to the repo's `checks` in your fleet rulesets config |
| `--repo owner/name` | the GitHub repo, if not the `origin` remote |
| `--owner @handle` | who owns the paths in `.github/CODEOWNERS`: `@user` or `@org/team` (default: the repo's owner when it is a user; an organization cannot be a code owner, so for org repos `init` writes `@OWNER` and asks for `--owner`) |
| `--apply` | write the files and change the settings. Without it `init` only plans and changes nothing |
| `-f`, `--force` | with `--apply`, overwrite files that differ |

### Skip names

`--skip` takes any file or setting name; `init --help` lists them all.

- **Files:** `lefthook`, `mise`, `renovate`, `bunfig`, `biome`, `gitignore`,
  `ci`, `codeowners`, `tsconfig` (tool), `playwright` and `unlighthouse`
  (site), `package`, `security` (with `--enable-pvr`), `agentic` (with
  `--enable-agentic`)
- **Settings:** `pr-policy`, `issue-policy`, `dependabot-alerts`,
  `dependabot-security-updates`, `secret-scanning`, `codeql`, `pvr`, `ai-scan`,
  and with `--enable-agentic`: `auto-merge`, `update-branch`,
  `delete-branch-on-merge`, `actions-permissions`

### Files

`lefthook.yml`, `mise.toml`, `renovate.json`, `bunfig.toml`, `biome.json`,
`.github/workflows/ci.yml` (the CI caller for the kind, pinned to the release
SHA), `.github/CODEOWNERS`, and `tsconfig.json` (tool) or
`playwright.config.js` and `unlighthouse.config.ts` (site). `.gitignore` and `package.json` are merged:
missing lines, scripts and devDependencies are added and the rest kept.

If any other file exists with different content, or `package.json` has a
script with a different value, `init` lists them, writes no files and exits 1;
`--force` overwrites. Each written file starts with a comment naming the
voidflow version that wrote it (`renovate.json` carries it in `description`).
There's no `dependabot.yml`: Renovate does version updates.

`.github/CODEOWNERS` puts the paths a misbehaving bot or a malicious pull
request would edit to change how the repo behaves (`.github/`, agent directives
such as `CLAUDE.md`, `AGENTS.md` and `.claude/`, tooling config, `package.json`
and lockfiles, `SECURITY.md`) under one owner. It only gates anything where the
branch ruleset requires code owner review (the `codeowners` flag, on for
`tool()`), and the owner should be someone other than the account the bot
pushes as. GitHub does not apply rulesets to a private repo on a plan without
them (free personal accounts): `init` probes for that and prints a note when
the file would not be enforced.

With `--enable-agentic`, `init` also installs deps-review with `gh aw add`
(pinned to this version, needs the gh-aw extension) and writes
`.github/workflows/agentic.yml`. Moving from `shadow` to `gate` merges both
files, no `--force` needed.

### Settings

Always applied: pull requests and issues limited to collaborators (bots with
write access count), Dependabot alerts and security updates, secret scanning
with push protection, and CodeQL default setup. Opt-ins are never turned off.

- On a private repo without GitHub Code Security, CodeQL and secret scanning
  are reported `skipped-plan`.
- Before the first push CodeQL has nothing to scan and is `skipped-no-code`;
  re-run `init --preset settings --apply` after it.
- `--enable-agentic` adds: allow auto-merge, always suggest updating PR
  branches, delete head branches on merge, a read-only workflow token with
  Actions unable to approve PRs, and the `low-risk` and `needs-you`
  labels.
- Settings with no API (Dependabot malware alerts, the AI previews, the
  `COPILOT_GITHUB_TOKEN` secret) are printed as manual steps with a link.

`--preset rulesets` applies the same rulesets as
[`voidflow rulesets`](#npm-package), creating or updating but never pruning. A
private repo on a plan without rulesets is `skipped-plan`.

### Exit codes

0 done, 1 a file conflict or a failed setting, 2 a usage error. None of the
`skipped-*` statuses set 1. A file conflict doesn't stop the settings, and a
missing `gh` or `origin` doesn't stop the files.

# Reference

Everything `init` writes points at the pieces below. Use them directly to wire
voidflow into a repo by hand, or to customize what `init` wrote.

## Pinning

Pin workflows and actions to a release SHA with the version in a comment;
Renovate keeps it current.

```yaml
uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@<sha> # vX.Y.Z
```

Canary releases are tagged `vX.Y.Z-next.N`. See [`RELEASING.md`](RELEASING.md)
for the release flow and [`STABILITY.md`](STABILITY.md) for what minors,
patches and majors may change and how deprecations reach you.

## CI workflows

### Trying a canary release

Canaries publish to the `next` dist-tag, so `npx @taraxvoid/voidflow@next init --kind tool --apply`
(or the `bunx` form, or `--kind site`) runs the newest one. If your npm config has a release-age
cooldown (`min-release-age` or `before`), a fresh canary is filtered
out and `@next` silently resolves to an older version. For the unscoped mirror
this fails with `could not determine executable to run`, because the old
release has no `voidflow` bin. Exempt voidflow in `~/.npmrc`, next to the
cooldown you already have:

```ini
min-release-age-exclude[]=voidflow
min-release-age-exclude[]=@taraxvoid/*
```

Only the matching packages are exempt; their dependencies still follow the
cooldown. To check what resolves, run `npm view @taraxvoid/voidflow@next version`.
Bun has the same idea in `bunfig.toml` (`minimumReleaseAgeExcludes`).

`npx` does not honor the exclusion in current npm releases
([npm/cli#9765](https://github.com/npm/cli/issues/9765)), and npm before 11.17
does not know the setting at all, so `npx` can still pick an older release.
Until that is fixed, turn the cutoff off for that one command:

```sh
npx --min-release-age=0 @taraxvoid/voidflow@next init --kind tool --apply
```

This also lifts the cooldown for the dependencies `npx` installs for that run.
If your cooldown is `before`, pass a `--before` date later than the canary's
publish date instead. `npm install` honors the exclusion.

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
private repos on other plans can't use one. Set `mergeQueue: true` on the
repo's entry in your fleet's rulesets config (in your infra repo, see
[`CONTRIBUTING.md`](CONTRIBUTING.md#branch-rulesets)), apply it, and add
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

### Tool release

For tools published to npm: release-please on branch channels (`main` →
`latest`, `next` → `next`, `release/N.x` → `release-N.x`), then the packed
tarball is attested and staged with `npm stage publish`, so nothing goes live
until you approve it with 2FA, and the bytes on npm are the attested bytes.
Each channel reads `.release-please/<main|next|maintenance>.json` and its
`-manifest.json`; a branch without one fails. Needs a release bot GitHub App
(so the release PR's CI runs) and npm trusted publishing configured with
**your** workflow file (e.g. `release.yml`) and the `npm` environment.
Create that environment yourself and limit its deployment branches to your
release branches (`main`, `next`, `release/*`): npm only checks the workflow
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
| `actions/cloudflare-deploy` | `env`, `cloudflare-api-token`, `cloudflare-account-id`, `migrate-d1`, `package-manager` (runs the migration: `bun`, `pnpm` or `aube`), `working-directory`, `command`, `token-fallback` ([details](CONTRIBUTING.md)) |
| `actions/cloudflare-preview` | `cloudflare-api-token`, `cloudflare-account-id`, `working-directory`, `name` (default `pr-<number>`), `secrets` (dotenv lines), `github-token`, `delete` |

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

## npm package

```sh
bun add -d @taraxvoid/voidflow   # or: pnpm add -D @taraxvoid/voidflow
```

Also published as `voidflow`. `check-licenses` and `unlighthouse-runner` need
`bun` on `PATH`; the `voidflow` CLI (below) runs under Bun or Node 24+. Each
npm tarball has a GitHub build attestation;
[`RELEASING.md`](RELEASING.md#verify-an-npm-tarball) shows how to check one.
Releases are immutable on GitHub, and `gh release verify v<version> --repo taraxvoid/voidflow`
checks it against GitHub's own attestation;
[`RELEASING.md`](RELEASING.md#verify-a-release) has the details and the limits.

**Lighthouse budgets** - runs [Unlighthouse](https://unlighthouse.dev/) against
the build and fails on a missed budget. Options: `--dir` (default `dist`, use
`dist/client` for the Cloudflare adapter), `--config` (default
`unlighthouse.config.ts`, see [example](scripts/unlighthouse/unlighthouse.config.example.ts)),
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
Cloudflare deploy tokens as code (and [`init`](#init-reference)). Run it with `bunx` or `npx` (Node 24+) from
an org's infra repo that holds the fleet map (`--config`) and pins the version;
no voidflow checkout needed. `rulesets` needs `gh` with admin on the repos; `tokens cf`
also needs `CF_TOKEN_ADMIN`. [`docs/fleet.md`](docs/fleet.md) covers the
infra repo, how the verbs find its config (including `~/.config/voidflow`) and
their targets; config shapes and flags are in
[`CONTRIBUTING.md`](CONTRIBUTING.md#fleet-config---config). Experimental while
they settle: the CLI's commands and flags and the `./cloudflare` and
`./rulesets` exports may change in a minor
([`STABILITY.md`](STABILITY.md#experimental)). Pin an exact version.

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

## Agentic workflows

A [gh-aw](https://github.github.com/gh-aw/) package in [`agentic/`](agentic/).
Each workflow is Markdown you install into your repo and compile there, so it
runs with your repo's permissions, secrets and (for private repos) private logs.
Copilot is the default engine; pass `--engine` to `gh aw add` for another.

```sh
gh extension install github/gh-aw --pin v1.0.1
gh aw add taraxvoid/voidflow/agentic@vX.Y.Z   # pin a release, like the workflows
gh aw compile && git add .github/workflows && git commit -m "ci: add voidflow agentic workflows"
```

`gh aw update` brings later releases in and refuses a major without `--major`.
Keep the locks honest with the reusable check, which recompiles with a pinned
gh-aw and fails when a committed `.lock.yml` is stale or missing:

```yaml
  agentic-locks:
    uses: taraxvoid/voidflow/.github/workflows/agentic-locks.yml@<sha> # vX.Y.Z
```

### deps-review

Reviews Renovate and Dependabot PRs beyond "CI passed". Two parts, so a
compromised package can't talk its way to a merge:

- **The agent** reads the release notes between the two versions, checks them
  against what your code actually uses, and leaves a comment with the evidence
  and a `low-risk` or `needs-you` label. It treats every upstream
  string as untrusted and proposes a verdict; it never approves, merges,
  pushes or posts the check.
- **The gate job** (deterministic, runs after the agent) recomputes the hard
  signals with the `deps-signals` bin, which reads no free text: update type
  (patch or minor on 1.0+ only), a publisher who didn't publish or maintain the
  previous version, added install scripts, dropped provenance, new
  dependencies, action pins that don't match their tag, lockfile-only changes,
  and any file outside `package.json`, lockfiles and workflows. It posts the
  `deps-review` check on the exact commit the agent reviewed: green only when
  the agent said low risk **and** `deps-signals` is clean. Anything it can't
  verify is red.

Human PRs never start it.

Secrets: `COPILOT_GITHUB_TOKEN` (fine-grained PAT, Copilot Requests: Read) as
an Actions secret, and the same value as a **Dependabot** secret, since runs
Dependabot triggers only see Dependabot secrets.

Roll it out in stages:

1. **Shadow.** Install it and read its verdicts for a few weeks. Nothing merges.
2. **Gate.** Make `deps-review` a required check, post it on everyone else's
   PRs with the gate workflow, and let Renovate automerge low-risk updates:

   ```yaml
     deps-review-gate:
       uses: taraxvoid/voidflow/.github/workflows/deps-review-gate.yml@<sha> # vX.Y.Z
       permissions:
         checks: write
         contents: read
         pull-requests: read
   ```

   The gate passes a PR that changes no lockfile and no dependency field of
   any `package.json`. One that does (an agent's or a contributor's) fails as
   "Needs you" with the files listed, since nothing reviewed those
   dependencies: review them, then merge with an admin bypass. It fails
   closed: a `package.json` it cannot read or parse is listed too, a PR near
   GitHub's 3000-file listing limit fails, and if the file list itself cannot
   be fetched the step errors and posts no check, so the required check stays
   unmet.

   ```json
   { "extends": ["github>taraxvoid/voidflow", "github>taraxvoid/voidflow:deps-review-automerge"] }
   ```

   The opt-in preset automerges patch, minor, digest and pin updates on 1.0+
   versions through GitHub auto-merge, which
   waits for every required check on the current head; a Renovate rebase is
   re-reviewed before it can merge. Enable "Allow auto-merge" in the repo.
   Dependabot can't automerge itself: run `gh pr merge --auto --squash` on its
   PRs from a workflow, and the required check still gates the merge.
3. **Wider.** Add update classes (0.x minors, grouped monorepos) only with
   evidence from stage 2. Majors stay human.

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
