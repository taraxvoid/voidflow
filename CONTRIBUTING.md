# Contributing

## Setup

```sh
mise install   # tools pinned in mise.toml
bun install    # prepare script runs `lefthook install`
```

## Checks

`just validate` runs everything CI (`.github/workflows/ci.yml`) runs:

- `just lint`: every linter below, plus gitleaks
  - `just lint-ts`: Biome lint and format check (`bun run lint`)
  - `just lint-workflows`: jactionlint, including shellcheck on workflow `run:` steps
  - `just lint-actions`: check-jsonschema on workflows and `actions/**/action.yml`
  - `just lint-shell`: shellcheck on `run:` steps in composite actions
    (`scripts/shellcheck-actions.ts`)
- `just check`: typecheck with tsc (`bun run check`)
- `just test`: unit tests (`bun run test`)
- `just security`: zizmor

`just format` applies Biome's fixes. The TypeScript steps are package.json
scripts named like a voidflow caller's (`lint` is Biome, `check` is the
typecheck), and the recipes wrap them.

lefthook runs Biome (fixing staged files), the typecheck and the workflow and
action linters on `pre-commit`, and zizmor and the tests on `pre-push`.

Pin every third-party action to a full commit SHA with a version comment.

### Running CI locally

`just dry-run` runs `ci.yml` under [`act`](https://github.com/nektos/act)
(needs Docker). Extra args pass through, e.g. `just dry-run -j validation`.

- Run it from a plain clone, not a git worktree. `act` copies the tree without
  resolving the worktree's `.git` pointer, so `git ls-files` steps see no files
  and pass vacuously.
- Colima works: `.actrc` already disables the docker socket mount.

## Starter templates

`voidflow init` copies the files under `templates/` (`common/`, `tool/`,
`site/`). They're generated: edit `scripts/build-templates.ts` (or a source it
reads, such as `mise.toml`, the README snippets or `bunfig.toml`), then run
`just templates`. `test/templates.test.ts` fails when the committed templates
differ from a fresh build. `.gitignore` templates are stored as `gitignore`
because `npm pack` drops files named `.gitignore`. `{{version}}`, `{{sha}}`,
`{{kind}}`, `{{cron_minute}}` and `{{repo}}` are filled in when `init` runs.

## Branches and commits

Feature PRs target `next`. Use [Conventional Commits](https://www.conventionalcommits.org);
they drive version bumps and the changelog. See [`RELEASING.md`](RELEASING.md)
for the release flow.

## Branch rulesets

[`rulesets/index.ts`](rulesets/index.ts) holds the config shape and the plan
logic; the fleet (which repos, tiers, checks and bypasses) lives in the org's
own infra repo (see [Fleet config](#fleet-config---config)). A tiered repo's
missing fields take `tool()`'s defaults; a repo whose protection doesn't fit
the tiers spells out its rulesets in full. Needs `gh` with admin on the repos.
With the infra repo at `~/.config/voidflow`, or from inside its checkout (see
[`docs/fleet.md`](docs/fleet.md) for discovery and the verbs):

```sh
vf="bunx @taraxvoid/voidflow@<version>"
$vf plan rulesets                         # diff every repo against the config
$vf plan rulesets --repo soundry
$vf check rulesets                        # exit 1 on drift
$vf apply rulesets --repo soundry         # create/update one repo to match
$vf apply rulesets --entire-fleet         # every repo in the config
$vf apply rulesets --repo soundry --prune # also delete rulesets listed under `retire`
```

Fleet keys are `owner/name`, or grouped under `orgs` (see
[`docs/fleet.md`](docs/fleet.md#config-shapes)), so one infra repo can cover
repos under several owners. A repo not listed in the fleet is never touched, so repos whose rulesets
are managed by hand can stay out of it.

To require a merge queue on `main`, set `mergeQueue: true` on the repo's entry
(`tool({ mergeQueue: true })`). GitHub only offers merge queues on public repos
owned by an organization, and on private org repos with Enterprise Cloud, so
leave it off elsewhere. The repo's CI must also run on `merge_group`, or the
required checks never report and the queue stalls. `rulesets` refuses, before
writing anything, a repo that asks for a queue but isn't org-owned; a private org
repo without Enterprise Cloud is left to GitHub's API to reject.

To limit which branches can deploy to a GitHub environment, list it under
`environments` with the tiers whose branches may use it:

```ts
'taraxvoid/transbot': tool({ environments: { prod: ['main'] } }),
'taraxvoid/voidflow': {
    // ...
    environments: { npm: ['main', 'prerelease', 'maintenance'] },
},
```

The plan compares each one against an explicit branch list (`main` resolves
to the repo's default branch, `maintenance` to `release/*`); apply creates a
missing environment, sets "selected branches", adds and deletes branch
policies to match, and keeps the environment's wait timer, reviewers and
admin bypass. It never uses "protected branches only": GitHub decides that
from classic branch protection, not rulesets, and lets every branch deploy
when a repo has none, which is the case for every repo whose protection
comes from here. Environments not listed are left alone.

Rulesets not in the config are reported and left alone. Repos where the API
returns 403 (private repos on a plan without rulesets) are skipped and listed.

Drift shows up when someone runs `check`; nothing applies on its own.
Applying stays a manual `apply` with an explicit target.

## Cloudflare deploy tokens as code

[`cloudflare/tokens.ts`](cloudflare/tokens.ts) holds the config shape and the
plan logic; the fleet (repos, accounts, envs) lives in the org's own infra
repo (see [Fleet config](#fleet-config---config)), one token per repo and
env. Each token is owned by its env's account and scoped to
one Worker (the Workers Editor role on it), plus Workers Routes Write on the
zones of its routes only, with a 90-day expiry. An env whose Worker lives in
another account (say a separate preview Worker kept apart from prod) sets its
own `account`; otherwise it uses the repo's.

The Worker and zones come from the repo's own wrangler config on its default
branch (`wrangler.jsonc`, or the env's `wrangler` path), read the way wrangler
reads it: the `env.<name>` block named like the env if there is one (or
`wranglerEnv`), else the top level. Each route's host maps to the account zone
it sits in, so a route added to wrangler shows up as drift on the next plan,
and a host in none of the account's zones fails the plan. An env can still
spell out `worker` and `zones` instead; `zones: []` grants none, e.g. for a
Worker Preview token, which deploys no routes.

### D1 migrations

A deploy that runs `wrangler d1 migrations apply` (the deploy action's
`migrate-d1: "true"`) needs D1 Write, which the Workers Editor role does not
include: without it the migration fails with error 7403. Set `d1: true` on
that env only:

```ts
envs: [
    { env: 'prod', d1: true },          // prod migrates
    { env: 'preview', zones: [] },      // no D1: a PR job never gets it
],
```

Cloudflare scopes D1 Write to the account, not to a database, so the token can
write every D1 database in its env's account. It is off by default because a
preview env usually shares the prod wrangler config, and its token would
otherwise write the production database. A repo that needs the narrower grant
should keep its databases in a separate account and set that env's `account`.

### Where the secret goes

By default each env's token goes into an environment secret,
`CLOUDFLARE_API_TOKEN` in the GitHub environment named like the env. Only
jobs with `environment: <env>` read it, so the environment's deployment
branch policy (`main` only for `prod`) is what keeps a pull request job from
reading the prod token. `tokens cf` does not set that policy; list the env under
the repo's `environments` in the rulesets config (see
[Branch rulesets](#branch-rulesets)) so `plan rulesets` reports it. That is the recommended shape: one deploy job for
`main` with `environment: prod`, one for pull requests with
`environment: preview`.

```ts
envs: [
    { env: 'prod' },                // Worker and zones from wrangler.jsonc
    { env: 'preview', zones: [] },  // Worker Previews: same Worker, no routes
],
```

A repo that deploys without environments sets `secret: 'repo'` on one env: its
token goes into the repository secret, which every job reads. Only one env
per repo can do that. When every env uses environments, a plan reports a
leftover repository `CLOUDFLARE_API_TOKEN` (a pre-voidflow token that jobs
without an environment still deploy with), and `--prune` deletes it along
with the `retire` tokens.

A Worker Preview runs on the same Worker as prod, so unless Cloudflare grows a
preview-only permission, the preview token can deploy to prod too. Keeping it
in its own environment still scopes and rotates it on its own.

The targets need `CF_TOKEN_ADMIN`: a user-owned token (account-owned tokens
reach only their own account) that includes every account in the config, with
Account API Tokens Edit, Workers Scripts Read and Zone Read on each, a short
expiry and an IP filter. Adding a repo in a new account means adding that
account to this token. It can mint
deploy tokens, so it stays on a maintainer's machine and never goes into CI.
[fnox](https://github.com/jdx/fnox) (installed by `mise install`) supplies
it: the committed [`fnox.toml`](fnox.toml) declares the secret, but no value,
and a `cf-admin` provider backed by the macOS Keychain. Store the value once
with `fnox set -k voidflow-cf-token-admin CF_TOKEN_ADMIN` (it prompts with
hidden input), and confirm with `just doctor`. To use another fnox provider
(age, 1Password, `pass`...), redefine `[providers.cf-admin]` in a gitignored
`fnox.local.toml` at the repo root (one per checkout or worktree). If
`CF_TOKEN_ADMIN` is already in the environment, the targets use it and skip
fnox.

With the infra repo found as in [`docs/fleet.md`](docs/fleet.md#discovery):

```sh
vf="bunx @taraxvoid/voidflow@<version>"
$vf plan tokens cf                           # read-only: diff every repo's tokens against the config
$vf check tokens cf                          # exit 1 on drift or a token within 14 days of expiry
$vf apply tokens cf --repo example_project   # create/update, rotate tokens due, set CLOUDFLARE_API_TOKEN per env
$vf apply tokens cf --entire-fleet           # the same for every repo
$vf apply tokens cf --repo example_project --rotate  # rotate its tokens now
$vf apply tokens cf --repo example_project --prune   # also delete `retire` tokens and a leftover repo-wide secret
$vf tokens cf --config ~/.config/voidflow/cf-tokens.ts --groups  # live names of the permission group ids the config uses
```

The plan prints when each token was last used, so a CI deploy shows up there.
To prove a token's policies are enough before CI depends on them, run the
deploy with a throwaway token that has the same policies. From the site's
checkout:

```sh
bunx @taraxvoid/voidflow@<version> tokens cf --config ~/.config/voidflow/cf-tokens.ts \
    --repo example_project --try prod -- bunx wrangler deploy
```

The real token can't be used locally (its value only exists in GitHub), and
a shell holding a wider token (an admin token, `wrangler login`) would hide a
missing grant. The command gets the throwaway token as `CLOUDFLARE_API_TOKEN`,
with `CF_TOKEN_ADMIN` removed, and the token is deleted afterwards (it
expires within the hour regardless).

A plan needs `gh` as well as `CF_TOKEN_ADMIN`: it reads each repo's wrangler
config and secret names. New values go straight from the API into `gh secret
set` and are never printed. A rotation creates the new token, sets the
secret, then deletes the old token, so a deploy in between still works. If
the secret can't be set, the new token is deleted again. A run that stops
partway can leave two tokens with one name, and nothing says which one GitHub
holds, so the next run rotates: a fresh token into the secret, then both old
ones deleted. Policy drift is fixed in place without changing the value.

Limits worth knowing:

- Per-Worker grants apply only to Workers that exist. A Worker's first deploy
  needs an admin token; the tool refuses to plan for a Worker it cannot find.
- Custom Domains do not support per-Worker roles yet. If a deploy fails on the
  domain with only the zone grant, add `fallback: { reason, since }` to that
  env. Its token then also gets account-wide Workers Scripts Write, every plan
  prints it, and `apply` sets the variable `CF_TOKEN_FALLBACK` next to the
  secret. Pass that to the deploy action so every deploy warns:

  ```yaml
  - uses: taraxvoid/voidflow/actions/cloudflare-deploy@<sha> # <version>
    with:
      env: prod
      cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      token-fallback: ${{ vars.CF_TOKEN_FALLBACK }}
  ```

Cut over one repo at a time: `voidflow apply tokens cf --repo <name>`, deploy,
then `voidflow apply tokens cf --repo <name> --prune` to delete its old token.

## Fleet config (`--config`)

voidflow holds the tools; each org keeps its fleet map (repo names, account
ids, envs) in its own private infra repo, e.g. `taraxvoid/infra`, as modules
that export `REPOS` (or a default). The package's `voidflow` bin runs both
tools, so the infra repo needs a pinned release rather than a voidflow
checkout. The `plan`, `check` and `apply` verbs find the config themselves
(`--config`, `VOIDFLOW_CONFIG`, `~/.config/voidflow`, then the directories up
from here); the tool commands `rulesets` and `tokens <provider>` require `--config`.
[`docs/fleet.md`](docs/fleet.md) covers discovery, the org-grouped shape, the
verbs and their exit codes.

```sh
bunx @taraxvoid/voidflow@<version> check rulesets
npx @taraxvoid/voidflow@<version> apply tokens cf --repo example_project
bunx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts --check   # the tool command
```

Each tool command takes its script's flags (`scripts/apply-rulesets.ts`,
`scripts/cf-tokens.ts`) and lists them with `--help`. The bin runs under Bun or
Node 24+ (`bunx` or `npx`); the package ships it built to `dist/`. In this repo,
the `rulesets-*` and `cf-tokens-*` recipes run the same entry point
(`scripts/cli.ts`) from the checkout.

If you run a canary (`@next`) with an npm release-age cooldown set, add
`min-release-age-exclude[]=voidflow` and `min-release-age-exclude[]=@taraxvoid/*`
to your `.npmrc`, or `@next` resolves to an older release. `npx` ignores the
exclusion in current npm releases, and npm before 11.17 does not know it, so
run `npx --min-release-age=0 @taraxvoid/voidflow@next ...` instead (this also
lifts the cooldown for that run's dependencies). See
[Trying a canary release](README.md#trying-a-canary-release).

The config modules stay TypeScript under either runtime. Node 24 loads them by
stripping types, which covers erasable syntax only: type annotations, `type` /
`interface`, `as` and `satisfies`, but no `enum`, `namespace` or constructor
parameter properties. Write configs as plain data plus types, as below.

With `@taraxvoid/voidflow` as a devDependency of the infra repo (the same
version the recipes pin), a config module can type its map against its
shapes and use its helpers (`tool()` for rulesets, say). Type-only imports
need nothing at run time; value imports resolve from the infra repo's
`node_modules`:

```ts
import type { RepoConfig } from '@taraxvoid/voidflow/cloudflare'
import { tool, type Fleet } from '@taraxvoid/voidflow/rulesets'
```

```ts
// cf-tokens.ts in the org's infra repo
export const REPOS = {
    'example-org/site': {
        account: '<account id>',
        envs: [
            { env: 'prod' }, // env.prod in its wrangler.jsonc, else the top level
            { env: 'preview', zones: [] },
        ],
        retire: [],
    },
}
```

An infra repo needs no justfile. If you keep one, say to wrap runs in fnox
for `CF_TOKEN_ADMIN`, its recipes call the verbs and pass `--config` as the
recipe's own directory:

```just
# justfile in the org's infra repo
vf := "bunx @taraxvoid/voidflow@<version>"
# CF_TOKEN_ADMIN from fnox unless already set. fnox.toml is a copy of
# voidflow's; -c finds it from a [no-cd] recipe too.
fnox := "fnox -c " + quote(justfile_directory() / "fnox.toml") + " exec -- "
cf := if env_var_or_default("CF_TOKEN_ADMIN", "") == "" { fnox + vf } else { vf }
cfg := quote(justfile_directory())

plan *args:
    {{ cf }} plan --config {{ cfg }} {{ args }}

apply tool *args:
    {{ cf }} apply {{ tool }} --config {{ cfg }} {{ args }}

# [no-cd]: the command runs in the site checkout `just -f` was called from
[no-cd]
cf-tokens-try repo env +cmd:
    {{ cf }} tokens cf --config {{ quote(justfile_directory() / "cf-tokens.ts") }} --repo {{ repo }} --try {{ env }} -- {{ cmd }}
```

A rulesets config can use the tier model, where any field left out takes
`tool()`'s value (main only, the `validate` check, CODEOWNERS, linear
history, so `{}` is a valid repo) and an unknown field is an error. Or it can
spell a repo's rulesets out in full as `{ rulesets: [...], retire: [...] }` when its protection doesn't fit
the tiers. A snapshot of what GitHub has now (`gh api
repos/<repo>/rulesets/<id>`, keeping `name`, `target`, `enforcement`,
`conditions`, `bypass_actors` and `rules`) plans with no drift.

A relative `--config` (or `VOIDFLOW_CONFIG`) resolves from
`VOIDFLOW_CONFIG_BASE` when that is set, else the current directory. This
repo's recipes set it to the directory `just` was run from; the bin doesn't,
so with the infra justfile above a relative path resolves from the infra repo,
or from the site checkout for the `[no-cd]` recipe (hence
`justfile_directory()`). `--try` runs its command
in the same directory. Each config is
checked before any API call, and every problem is reported by its path.
`CF_TOKEN_ADMIN` then needs to cover that org's accounts, and `gh` needs admin
on its repos.
