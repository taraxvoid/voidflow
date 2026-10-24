# Spec: `<usecase>-ci` workflows and fleet sync

Status: draft, 2026-10-17

## Problem

voidflow validates two kinds of repo: Astro sites (`site-ci.yml`) and bun
tools (`tool-ci.yml`). Everything else in the fleet hand-rolls its CI:

| Repo | Kind | Today |
|---|---|---|
| taraxvoid/rookery | Python (stdlib) + agent configs | own `nest-validate.yml`: `validate.py`, unittest, zizmor |
| taraxvoid/skills | Claude skills / plugin marketplace | no CI |

And the repos that do use voidflow drift apart. Observed 2026-10-16, latest
release v0.13.1:

| Repo | Workflow refs | `@taraxvoid/voidflow` devDep |
|---|---|---|
| queeromaha | v0.13.1 | 0.11.1 |
| soundry, synthomaha | v0.10.0 | 0.11.1 |
| taraxvoid.com | v0.11.1 (deploy action) | none |
| transbot | v0.13.0 | 0.13.0 |
| trailguide | hand-rolled | `^0.12.3` (range) |

Two causes. The shared Renovate preset files voidflow's workflow refs under
the `github actions` group and the npm package separately, so the two halves
of one upgrade land in different PRs on different days, or one is left
unmerged. And nothing reports the drift; voidlight now does (`voidflow` in
`/status.json`, the `voidflow` badge), but only after the fact.

## Goals

1. One reusable validate workflow per repo kind, sharing a contract so every
   repo reports the same required check and gets the same security gates.
2. Consumers move between voidflow releases in one step, workflow refs and
   package pin together, and drift is caught at PR time.

Non-goals: deploy workflows for non-site repos; replacing Renovate.

## The shared contract

Every `<usecase>-ci.yml`:

- is `workflow_call` only, one job `validate` named `Validate`, so the caller
  reports `validate / Validate` (the check `rulesets/index.ts` requires);
- asks for `contents: read` and `pull-requests: read` only (SARIF upload is
  the separate `upload-sarif.yml`);
- takes `runner` (default `ubuntu-latest`) and skips draft PRs;
- runs, in order: checkout (full history, no persisted credentials), the
  **Secrets Scan** step, paths-filter, **Lint CI workflows** and **Audit CI
  workflows** (zizmor) when workflows changed, mise when `mise.toml` exists,
  then the kind's own steps, then the three **SARIF** steps;
- runs a kind-specific step only when the repo defines it, with a notice when
  it's skipped (the `package.json` scripts pattern from `tool-ci.yml`).

The shared steps are byte-identical across files. `test/tool-ci.test.ts`
already enforces that for site-ci/tool-ci; it becomes
`test/usecase-ci.test.ts`, which globs `.github/workflows/*-ci.yml` and checks
every file against the contract, so a new workflow can't drift from day one.

## New workflows

### `python-ci.yml`

For rookery now, flock when it resumes.

- **Setup**: `uv` always. With `uv.lock`: `uv sync --frozen`; the Python
  version comes from `.python-version` or `requires-python`. Without
  `pyproject.toml`: stdlib mode, system Python from `.python-version`, no
  install.
- **Task contract**: `justfile` recipes, the Python analog of `package.json`
  scripts. For each of `lint`, `check`, `test`, `audit`: run `just <recipe>` if
  the justfile defines it (detected with `just --summary`), else the default:

  | Recipe | Default when not defined |
  |---|---|
  | `lint` | `uvx ruff@<pin> check` and `uvx ruff@<pin> format --check` |
  | `check` | skipped (mypy/pyright only when the repo opts in) |
  | `test` | `uv run pytest` with a uv project, else `python -m unittest discover -s tests` |
  | `audit` | `uv export --frozen \| uvx pip-audit@<pin> -r /dev/stdin` with a lockfile, else skipped |

- **Licenses**: `uvx pip-licenses@<pin>` against the same copyleft deny list
  as `check-licenses.ts`, when the lockfile changed. Stdlib repos skip it.
- **rookery adoption**: add a 3-line justfile (`test: python3 validate.py &&
  python3 -m unittest discover -s tests`), replace `nest-validate.yml` with a
  caller. Its extra zizmor job goes away (the contract runs zizmor).

### `skills-ci.yml`

For taraxvoid/skills and rookery's `skills/`.

- A bun script, `scripts/check-skills.ts`, shipped as the `check-skills` bin
  (like `check-licenses`) so the same check runs in lefthook. Input
  `skills-dir` (default `skills`).
- Per `skills/<name>/SKILL.md`: frontmatter parses; `name` equals the
  directory, kebab-case, at most 64 characters, not containing `claude` or
  `anthropic`; `description` present, at most 1024 characters, no angle
  brackets; relative links and referenced files resolve.
- `.claude-plugin/marketplace.json` and each `plugin.json`: valid JSON,
  plugin names unique, every `source` path exists, every skill directory
  belongs to some plugin (no orphans).
- The repo-agnostic checks in rookery's `validate.py` (frontmatter required
  fields, name matches file) move here; rookery keeps only its tier and
  permission rules.

### `iac-ci.yml` (sketched, deferred)

Written when flock resumes, so it's built against a live consumer:
`tofu fmt -check -recursive`, `tofu validate` per root (input `tofu-roots`),
tflint, `trivy config`, kubeconform with Flux CRD schemas over `k8s-paths`, and
a check that every file matching `.sops.yaml` rules is actually encrypted.

### Rulesets

`rulesets/index.ts` gains `python()` and `skills()` helpers alongside `site()`
and `tool()`, all requiring `validate / Validate`.

## Fleet sync

### 1. Renovate moves both halves together

In `default.json`, one rule for everything voidflow:

```json
{
  "description": "voidflow workflow refs and the package move in one PR",
  "matchPackageNames": ["@taraxvoid/voidflow", "voidflow", "taraxvoid/voidflow"],
  "groupName": "voidflow",
  "minimumReleaseAge": null,
  "schedule": ["at any time"],
  "rangeStrategy": "pin"
}
```

It sits after the `github actions` rule so it wins for voidflow's refs.
`rangeStrategy: pin` turns `^0.12.3` into an exact pin on the next update.
Patch releases automerge once the consumer's own `validate` passes
(`"matchUpdateTypes": ["patch"], "automerge": true`); minors wait for review.

### 2. A drift check at PR time

A step in every `<usecase>-ci.yml`, after install: compare the version of the
voidflow workflow being run (resolved from `job_workflow_sha` against voidflow's
release tags via `git ls-remote`) with the consumer's `@taraxvoid/voidflow`
devDep. On a mismatch it emits a warning annotation naming both versions. It
warns rather than fails, since a deliberate split (trying a prerelease
workflow) is legitimate. It also warns on a range (`^`, `~`) and on a voidflow
`uses:` ref that isn't a full SHA.

### 3. `just fleet-sync` for catching up

For when Renovate isn't enough: a repo that skipped several releases, or
pushing a security fix fleet-wide the same day.

```fish
just fleet-sync --check                  # read-only drift table, exit 1 on drift
just fleet-sync v0.14.0                  # bump every consumer
just fleet-sync v0.14.0 --repo soundry   # one repo
```

The fleet list comes from the same config the ruleset tool reads (voidflow's
`rulesets/index.ts`, or an infra repo's `rulesets.ts` with `--config`), so
there is one inventory. Per consumer it:

1. creates a worktree at `~/worktrees/<repo>/chore/voidflow-<version>`;
2. rewrites every `taraxvoid/voidflow/…@<ref> # vX.Y.Z` to the release
   commit's SHA and version comment (the commit comes from the tag, never a
   branch);
3. sets `@taraxvoid/voidflow` to the exact version and refreshes the lockfile
   with the repo's own package manager;
4. commits `chore(deps): update voidflow to vX.Y.Z`, pushes, and opens a PR
   (unless `--no-pr`).

It skips a repo with an open Renovate voidflow PR and reports it instead, so
the two never race. `--check` prints the same table voidlight serves, from the
repos directly.

### 4. Detection

voidlight's `voidflow` section and badge (`v0.13.1 · 6/8 current`) stay the
standing view.

## Phasing

| Phase | Ships | Bump |
|---|---|---|
| 1 | Renovate group rule; drift warning step; `usecase-ci.test.ts` | minor |
| 2 | `skills-ci.yml` + `check-skills` bin; skills repos adopt | minor |
| 3 | `python-ci.yml`; rookery adopts | minor |
| 4 | `just fleet-sync` | minor |
| later | `iac-ci.yml` with flock | minor |

## Acceptance

- Every non-archived repo in the fleet reports `validate / Validate` from a
  voidflow workflow.
- After a stable release, every consumer is current within a week with no
  hand edits (voidlight `current == consumers`).
- `just fleet-sync --check` and voidlight agree on drift.

## Open questions

- Should the drift warning fail on `main` pushes but warn on PRs?
- skills-ci on rookery: run as a second caller job, or should `python-ci`
  take a `skills-dir` input?
