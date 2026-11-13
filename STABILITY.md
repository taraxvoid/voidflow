# Stability

From 1.0, voidflow follows [Semantic Versioning](https://semver.org). This page
says what the version number promises: what counts as the public surface, what
a patch, minor or major release may change, and how something is removed.

The short version: **a repo that passes on `vX.Y.Z` keeps passing on any later
`vX.*` without changing its own files**, unless a security exception below
applies.

## Public surface

Covered by this policy:

| Part | What's covered |
|---|---|
| Reusable workflows (`site-ci.yml`, `tool-ci.yml`, `upload-sarif.yml`) | Workflow paths, inputs and their defaults, secrets, outputs, job names (the required check `validate / Validate`), artifact names (`voidflow-sarif`) |
| Composite actions (`actions/*`) | Action paths, inputs and their defaults, outputs |
| `package.json` scripts CI runs | The script names CI looks for (`lint`, `test:unit`, `test:e2e:all`, ...) and when each runs |
| npm / JSR package | The `./playwright` and `./biome` exports and their options; the `unlighthouse-runner`, `check-licenses` and `deps-signals` bins and their flags (`deps-signals`: its JSON output and which signals it flags) |
| Biome config (`./biome`) | The rules and formatter options it sets on top of Biome's own (Biome itself is your dependency, so its upgrades are yours) |
| Renovate preset (`default.json`) | That it validates and extends `config:best-practices` |
| lefthook config (`lefthook/base.yml`) | Its path, the hooks it installs, the script names each runs |
| Supported runtimes | Package managers (`bun`, `pnpm`, `aube`), minimum Bun and Node versions, runner OS (`ubuntu-latest`) |
| Agentic package (`agentic/`) | Workflow paths in `aw.yml`, their triggers, the check run and label names posted (`deps-review`, `low-risk`, `needs-you`), the safe outputs the model may use, and what each verdict means. The `deps-review` check is posted by a deterministic job, never by the model |
| Reusable workflows for agentic repos (`agentic-locks.yml`, `deps-review-gate.yml`) | Paths, inputs and defaults, job names, required permissions |
| Opt-in Renovate preset (`deps-review-automerge.json`) | The update types it automerges and that it merges through GitHub auto-merge |
| Tags | `vX.Y.Z` release tags, the floating `vN` major tag |

Not covered: anything the README doesn't document, `scripts/` other than the
covered bins, the experimental parts below, tests, this repo's own CI, and
prerelease `-next.N` versions, which may change or break between prereleases.

### Experimental

The fleet tools are published but outside this policy: the `voidflow` CLI
(`plan`, `check`, `apply`, `tokens`, `rulesets`, `init`, how config files
are discovered, and the starter files `init` writes) and the `./cloudflare`
and `./rulesets` exports that type their configs. The
`init --enable-agentic` opt-in is the least settled of these. They're new and
still settling, so their commands, flags and config shapes may change in any
minor. The changelog says when. Pin an exact version where you run them.

**Pinning your runtime is your job.** voidflow sets minimums, not versions.
Pin Bun with a `.bun-version` file or `"packageManager": "bun@x.y.z"` in
`package.json` (`tool-ci.yml` also honors a `bun` entry in `mise.toml`).
Without a pin, CI installs the latest Bun, so a Bun release can change your CI
without a voidflow release. pnpm and aube versions already come from
`packageManager`, and Node from `engines`/`volta` or `devEngines.runtime` (see
the README).

## What each release may change

**Patch** (`1.2.3` to `1.2.4`): bug fixes, docs, pinned dependency bumps that
don't change behavior. A fix that makes a gate catch what it was always meant
to catch is a patch (e.g. gitleaks wasn't scanning a path it should have).

**Minor** (`1.2.x` to `1.3.0`):

- New inputs, outputs, actions, bins, exports or package-manager support, with
  defaults that keep current behavior.
- **New gates ship off by default**, behind an input. They turn on by default
  in the next major.
- Deprecations (see below).
- Renovate preset changes to schedule, grouping or release age: they change
  what PRs you get, not whether CI passes.
- Biome rules added at `warn`, never `error`.
- Scanner bumps (gitleaks, zizmor, actionlint, Grype) within the scanner's own
  minor line. These can surface new findings on code that passed before; the
  changelog calls each one out under **May surface new findings**. A clean repo
  stays clean, and treating a scanner's new detections as a voidflow major would
  mean shipping weaker scans for months.

**Major** (`1.x` to `2.0.0`):

- Removing or renaming anything in the public surface, or changing a default.
- Turning a gate on by default, or making a `warn` an `error`.
- Requiring a new Biome major, or changing the formatter options it sets.
- Tightening Lighthouse budgets or license policy defaults.
- Dropping a package manager, raising a minimum runtime, or changing the
  required check name.

Every major ships a migration section in its release notes: each change, why,
and the exact edit a caller makes.

### Agentic workflow prompts

An agentic workflow's prompt is behavior, even when its frontmatter doesn't
change, so prompt edits are versioned like code:

- **Patch:** wording, typos, clearer instructions that don't change a verdict.
- **Minor:** new evidence or checks, a stricter verdict (something that was low
  risk can become needs-you), a new optional label or comment section.
- **Major:** a looser verdict (something that needed you can merge on its own),
  renamed or removed check runs or labels (they break required checks and
  filters), new write powers (approve, merge, push), letting the model post a
  gating check, or a new default engine. Loosening `deps-signals` (flagging
  less) is a major too.

A model reads text an attacker can write (release notes, package metadata),
so prompt wording is never the control. The `deps-review` check comes from a
deterministic job: green only when the model says low risk *and*
`deps-signals`, which reads no free text, finds nothing. The model can only
make the gate stricter.

## Deprecation

Nothing in the public surface is removed in the release that deprecates it.

1. **Deprecate in a minor.** The thing keeps working. The README and its own
   description say "Deprecated" with the replacement, and the changelog lists
   it under **Deprecations**.
2. **Warn where callers will see it.** Workflows and actions emit a
   `::warning title=voidflow deprecation::` annotation when the deprecated
   input, secret or path is used. Bins print the same to stderr.
3. **Remove in the next major**, and no sooner than 30 days after the
   deprecating release. The major's migration notes list it again.

When a rename would otherwise fail silently, the old name stays as a stub
that fails loudly with the fix, as `lefthook/site.yml` does for
`lefthook/base.yml`.

Inputs and secrets that become no-ops are kept and accepted until the next
major (GitHub rejects unknown ones, so removing one breaks every caller that
passes it).

## Security exception

voidflow runs with callers' tokens and secrets. If keeping a behavior means
leaving callers exposed (a script-injection path, an over-broad token
permission, a compromised dependency), the fix ships in a patch or minor even
if it breaks callers. The release notes say so under **Security (breaking)**
with the reason and the caller-side fix, and a GitHub security advisory is
published when callers need to act.

## Support

| Line | Gets |
|---|---|
| Latest major | Features, fixes, security fixes |
| Previous major | Security and critical fixes for 90 days after the next major ships, on `release/N.x` (see [RELEASING.md](RELEASING.md#backport-to-an-older-line)) |
| Older | Nothing |
| `0.x` | Nothing once 1.0 ships. Migrate to 1.x |

## Pinning

Pin a release commit SHA with the version in a comment and let Renovate move
it ([Pinning](README.md#pinning)). The floating `vN` tag follows the newest
stable release on major N, so a `@v1` reference picks up minors and patches
without review; it's there for trying voidflow, not for production. Prerelease
`-next.N` tags carry no stability promise.
