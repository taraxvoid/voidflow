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
| npm / JSR package | `exports` entries and their options (`./playwright`, `./biome`), `bin` names and their flags |
| Biome config (`./biome`) | The rules and formatter options it sets on top of Biome's own (Biome itself is your dependency, so its upgrades are yours) |
| Renovate preset (`default.json`) | That it validates and extends `config:best-practices` |
| lefthook config (`lefthook/base.yml`) | Its path, the hooks it installs, the script names each runs |
| Supported runtimes | Package managers (`bun`, `pnpm`, `aube`), minimum Bun and Node versions, runner OS (`ubuntu-latest`) |
| Tags | `vX.Y.Z` release tags, the floating `vN` major tag |

Not covered: anything the README doesn't document, `scripts/` other than the
published bins, `rulesets/`, `cloudflare/`, tests, this repo's own CI, and
prerelease `-next.N` versions, which may change or break between prereleases.

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
