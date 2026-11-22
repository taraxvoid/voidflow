# `voidflow init`

Every preset, flag, skip name, file and setting `init` handles, and how to try a canary release.

`init` is experimental: its flags may change in a minor
([`STABILITY.md`](../STABILITY.md#experimental)).

## Presets

| `--preset` | Does |
|---|---|
| `full` (default) | starter files and repo settings |
| `files` | starter files only |
| `settings` | repo settings only (no `--kind` needed) |
| `ci` | only `.github/workflows/ci.yml` |
| `codeowners` | only `.github/CODEOWNERS` |
| `rulesets` | only branch rulesets: from the repo's `voidflow.config.ts` when it has one, else the `--kind` defaults |

## Flags

| Flag | Effect |
|---|---|
| `--kind tool\|site` | which starter files to write; required except with `--preset settings`, or `--preset rulesets` in a repo with a `voidflow.config.ts` |
| `--skip <name>` | leave one file or setting out (repeatable, [names below](#skip-names)) |
| `--enable-pvr` | opt in: private vulnerability reporting, and a `SECURITY.md` pointing at it |
| `--enable-ai-scan` | opt in: AI Scan for pull requests and for the repository (`repository_scan`, preview) |
| `--enable-agentic` | opt in, experimental: [deps-review](agentic.md#deps-review) and the repo settings and labels it relies on. The `COPILOT_GITHUB_TOKEN` secret is a manual step: add it as an Actions secret and again as a Dependabot secret, since runs Dependabot triggers only see Dependabot secrets |
| `--agentic-stage shadow\|gate` | with `--enable-agentic`: `shadow` (default, nothing merges) or `gate` (adds the gate job and Renovate automerge). Automerge is only safe once `deps-review` is a required status check, which init does not set: add it to `rulesets.checks` in the repo's `voidflow.config.ts` |
| `--enable-actions-lock` | opt in: [actions.lock](#actionslock) for the repo's own workflows. Writes `verify-lockfile.yml`, then runs `gh actions-lock` once |
| `--enable-actions-relock` | opt in, implies `--enable-actions-lock`: also writes [`relock-actions.yml`](#relock-actions), which relocks and pushes `actions.lock` on Renovate PRs and PRs labelled `relock-actions`. Needs a GitHub App |
| `--repo owner/name` | the GitHub repo, if not the `origin` remote |
| `--owner @handle` | who owns the paths in `.github/CODEOWNERS`: `@user` or `@org/team` (default: the repo's owner when it is a user; an organization cannot be a code owner, so for org repos, or with no repo to read, a full run skips CODEOWNERS with a note and `--preset codeowners` fails until you pass `--owner`) |
| `--apply` | write the files and change the settings. Without it `init` only plans and changes nothing |
| `-f`, `--force` | with `--apply`, overwrite files that differ |

## Skip names

`--skip` takes any file or setting name; `init --help` lists them all.

- **Files:** `lefthook`, `mise`, `renovate`, `bunfig`, `biome`, `gitignore`,
  `ci`, `codeowners`, `config`, `drift`, `tsconfig` (tool), `playwright` and
  `unlighthouse` (site), `package`, `security` (with `--enable-pvr`), `agentic`
  (with `--enable-agentic`), `actions-lock` and `actions-relock` (with
  `--enable-actions-lock` / `--enable-actions-relock`)
- **Settings:** `pr-policy`, `issue-policy`, `dependabot-alerts`,
  `dependabot-security-updates`, `secret-scanning`, `codeql`, `pvr`, `ai-scan`,
  and with `--enable-agentic`: `auto-merge`, `update-branch`,
  `delete-branch-on-merge`, `actions-permissions`, `fork-pr-approval`,
  `label-low-risk`, `label-needs-you`; with `--enable-actions-relock`:
  `label-relock-actions`

The `--enable-*` groups and the settings you skip are recorded in
`voidflow.config.ts` (`settings`), so `voidflow check` keeps covering them; see
[docs/config.md](config.md#settings).

## Files

`lefthook.yml`, `mise.toml`, `renovate.json`, `bunfig.toml`, `biome.json`,
`.github/workflows/ci.yml` (the CI caller for the kind, pinned to the release
SHA), `.github/CODEOWNERS`, `voidflow.config.ts` (the repo's
[per-repo config](config.md), holding only `kind`),
`.github/workflows/voidflow-drift.yml` (the [drift check](config.md#reviewing-and-applying-a-change)
on `main`), and `tsconfig.json`
(tool) or `playwright.config.js` and `unlighthouse.config.ts` (site).
`.gitignore` and `package.json` are merged: missing lines, scripts and
devDependencies are added and the rest kept. `voidflow.config.ts` belongs to
the repo: an existing one is kept as it is unless `--force`, and carries no
version comment.

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

## actions.lock

A caller's [`actions.lock`](https://gh.io/actions-lockfile) covers its own
workflows' `uses:` steps (the call into voidflow's reusable workflows is not
locked, an upstream limitation). With the Require lockfile policy on, a stale
lock fails the run at startup with no jobs and no logs, so keep it current.

`--enable-actions-lock` writes `.github/workflows/verify-lockfile.yml`, which
runs `gh actions-lock --verify` on pull requests, pushes to `main` and weekly,
then runs `gh actions-lock` once so every workflow, the new one included, is
locked; commit `.github/workflows`. Without the
[gh-actions-lock](https://github.com/github/gh-actions-lock) extension the run
is a `manual` row with the command to run; any other failure exits 1. `init`
prints the Require lockfile policy as a manual step: turn it on once the lock
is committed and verify passes (Evaluate first where your plan offers it).

### relock-actions

Verify only fails the PR. `--enable-actions-relock` also writes
`.github/workflows/relock-actions.yml`, which fixes it: on a pull request that
touches `.github/workflows/` and is opened by `renovate[bot]` or labelled
`relock-actions`, it runs `gh actions-lock` and pushes the result to the PR
branch. Same-repo pull requests only.

- **GitHub App.** The push uses an App token, since a push with
  `GITHUB_TOKEN` would not re-trigger CI. The App needs Contents and Workflows
  read and write on the repo. Set its client ID as the `RELEASE_BOT_CLIENT_ID`
  Actions variable and its private key as the `RELEASE_BOT_APP_PRIVATE_KEY`
  secret (repo or organization level). `init` checks for both and prints a
  setup note when either is missing; it does not fail.
- **The `relock-actions` label.** The settings half creates it. Add it to any
  non-Renovate pull request that changes a `uses:` line, such as a hand edit
  or a rebase that moved one.
- **Renovate.** The hosted Renovate app has no `postUpgradeTasks`, so it
  cannot run `gh actions-lock` itself; relock-actions runs on its PRs instead.
  The shared preset bumps the pinned gh-actions-lock version in both workflows.
- **Safety.** Only the lockfile tooling runs: nothing from the pull request is
  installed or executed, the checkout keeps no credentials, and it never passes
  `--accept-moved` (check why a pin moved before accepting it, by hand).
- **`pull_request_target`.** The workflow runs as it is on the base branch,
  against the base branch's `actions.lock`. Under `pull_request`, a PR that
  bumps an action relock-actions itself uses would have the Require lockfile
  policy refuse the relock run at startup. The PR head is checked out by SHA as
  data, and fork PRs never run it. zizmor's `dangerous-triggers` finding is
  ignored inline with that reason.
- **gh-aw.** If the repo has gh-aw workflows (a `*.lock.yml`, or
  `--enable-agentic`), both workflows and the one-off run are limited to the
  repo's other workflows, listed by name when `init` runs: `gh actions-lock`
  rewrites SHA pins to tags, and gh-aw's compiled locks must stay as gh-aw
  wrote them. Add a workflow you create later to both lists by hand. Without
  gh-aw workflows nothing is listed and every run covers the whole directory.

## Settings

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
- `--enable-actions-relock` adds the `relock-actions` label.
- Settings with no API (Dependabot malware alerts, the AI previews, the
  `COPILOT_GITHUB_TOKEN` secret) are printed as manual steps with a link.

`--preset rulesets` applies the same rulesets as
`voidflow apply rulesets`, creating or updating but never pruning. A
private repo on a plan without rulesets is `skipped-plan`.

## Exit codes

0 done, 1 a file conflict, a failed setting or a failed `gh actions-lock`
run, 2 a usage error. None of the
`skipped-*` statuses set 1. A file conflict doesn't stop the settings, and a
missing `gh` or `origin` doesn't stop the files.

## Trying a canary release

Canaries are published on demand, not on every merge, to the `next` dist-tag, so `npx @taraxvoid/voidflow@next init`
(or the `bunx` form) runs the newest one. If your npm config has a release-age
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
