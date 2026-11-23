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

Third-party actions are pinned by `.github/workflows/actions.lock`, not inline
SHAs: reference a full version tag (`@v1.2.3`) and run `gh actions-lock` after
adding or changing any `uses:`, then commit `actions.lock` with the workflow.
`verify-lockfile.yml` runs `gh actions-lock --verify` on pull requests and
weekly. Use `--relock` to advance moved refs, and never run `--accept-moved`
from automation. zizmor requires a ref pin (`.github/zizmor.yml`) and Renovate
bumps the tags; digest pinning is off in the preset because the lockfile holds
the commits.

`verify-lockfile.yml` and `relock-actions.yml` are also the source of the
caller templates `init --enable-actions-lock` / `--enable-actions-relock`
write: run `just templates` after changing either.

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

Feature PRs target `main`. Use [Conventional Commits](https://www.conventionalcommits.org);
they drive version bumps and the changelog. See [`RELEASING.md`](RELEASING.md)
for the release flow.

## Branch rulesets

[`rulesets/index.ts`](rulesets/index.ts) holds the ruleset shape and the plan
logic. Each repo says what it wants in the `rulesets` section of its own
[`voidflow.config.ts`](docs/config.md): its `kind`'s defaults with any field
overridden, or its rulesets spelled out in full when its protection doesn't
fit the tiers. A repo without the file is never touched. Run the verbs inside
the repo, with `gh` as an admin of it:

```sh
vf="bunx @taraxvoid/voidflow@<version>"
$vf plan rulesets             # diff the repo against its config
$vf check rulesets            # exit 1 on drift
$vf apply rulesets            # create/update to match
$vf apply rulesets --prune    # also delete rulesets listed under `retire`
```

To require a merge queue on `main`, set `mergeQueue: true` in the `rulesets`
section. GitHub only offers merge queues on public repos owned by an
organization, and on private org repos with Enterprise Cloud, so leave it off
elsewhere. The repo's CI must also run on `merge_group`, or the required
checks never report and the queue stalls. `apply rulesets` refuses, before
writing anything, a repo that asks for a queue but isn't org-owned; a private
org repo without Enterprise Cloud is left to GitHub's API to reject.

To limit which branches can deploy to a GitHub environment, list it under
`environments` with the tiers whose branches may use it:

```ts
// voidflow.config.ts
export default {
    kind: 'tool',
    rulesets: {
        tiers: ['main', 'prerelease', 'maintenance'],
        environments: { npm: ['main', 'prerelease', 'maintenance'] },
    },
} satisfies VoidflowConfig
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
Applying stays a manual `apply` from the repo's checkout.

## Cloudflare deploy tokens as code

[`cloudflare/tokens.ts`](cloudflare/tokens.ts) holds the config shape and the
plan logic; each repo lists its account and envs in the `cloudflare` section
of its own [`voidflow.config.ts`](docs/config.md#cloudflare-tokens), one
token per env. Each token is owned by its env's account and scoped to
one Worker (the Workers Editor role on it), plus Workers Routes Write on the
zones of its routes only, with a 90-day expiry. An env whose Worker lives in
another account sets its own `account`; otherwise it uses the repo's. A
separate account is not needed to keep a preview token off prod: a separate
Worker in the same account is enough (see
[Where the secret goes](#where-the-secret-goes)).

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
reading the prod token. `apply tokens` does not set that policy; list the env
under `rulesets.environments` in the same file (see
[Branch rulesets](#branch-rulesets)) so `plan rulesets` reports it. That is the recommended shape: one deploy job for
`main` with `environment: prod`, one for pull requests with
`environment: preview`.

```ts
envs: [
    { env: 'prod' },                // Worker and zones from wrangler.jsonc
    { env: 'preview', zones: [] },  // env.preview's Worker, no routes
],
```

A repo that deploys without environments sets `secret: 'repo'` on one env: its
token goes into the repository secret, which every job reads. Only one env
per repo can do that. When every env uses environments, a plan reports a
leftover repository `CLOUDFLARE_API_TOKEN` (a pre-voidflow token that jobs
without an environment still deploy with), and `--prune` deletes it along
with the `retire` tokens.

The `preview` environment has to accept PR branches, so anyone who can push
a branch can read its token. Cloudflare has no Preview-only permission, so
what that token can reach is set by which Worker it is scoped to:

- **Previews of the prod Worker** (no `env.preview` block in wrangler):
  the token is scoped to the prod Worker and can deploy to prod.
- **Previews of a separate Worker** (recommended): add an `env.preview`
  block, with no routes and its own `previews` block, and pass
  `env: preview` to `cloudflare-preview`. The Previews then live under
  `<name>-preview` (`wrangler preview --env preview`), and the token above
  resolves to that Worker from the same block, so it has no rights on the
  prod Worker. Both Workers can stay in one account.

```jsonc
// wrangler.jsonc
{
    "name": "site",
    "routes": [{ "pattern": "example.com", "custom_domain": true }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "<prod id>" }],
    "env": {
        "preview": {
            // Worker "site-preview": no routes, and nothing bound to prod data
            "kv_namespaces": [{ "binding": "CACHE", "id": "<preview id>" }],
            "previews": {
                "kv_namespaces": [{ "binding": "CACHE", "id": "<preview id>" }]
            }
        }
    }
}
```

Point every binding in `env.preview` and its `previews` block at separate
resources. That keeps preview code off prod data, but it does not narrow a
token: Cloudflare grants KV and D1 for the whole account (R2 can be granted
per bucket), so a token with D1 Write (`d1: true`) can write the prod
databases whatever its Worker. Leave `d1` off for `preview`.

The token is scoped by the Worker's id, so `<name>-preview` has to exist
before the first apply: create it once with your own login
(`wrangler deploy --env preview`), then apply. A Worker the dashboard shows
with only Previews and no deployed script does not count: the scripts list
the plan reads leaves it out. Pin `account_id` in the wrangler config to the
account voidflow manages, so that deploy (which otherwise uses your login's
account) lands there; a plan warns when the two differ. The plan reads the
wrangler config from the default branch, so an `env.preview` block on an
unmerged branch is not seen yet (it warns when the local file resolves
differently): merge it first, or set `worker` and `zones` on the env.

The token commands need an admin token, in the variable the section's
`adminTokenEnv` names (default `CF_TOKEN_ADMIN`): a user-owned token
(account-owned tokens reach only their own account) covering the repo's
account, with a short expiry and an IP filter, and these on the account:

- Account API Tokens Edit
- Workers Scripts Read, shown in the dashboard as Workers Metadata Read-Only
  (account-wide, or on every Worker the config scopes a token to)
- Zone Read

Give each Cloudflare account its own variable, so repos in different accounts
each use a token for their own. Cloudflare answers a list the token lacks the
permission for with an empty list, not an error, so a plan that sees no
Workers or no zones in an account says the token likely lacks that
permission. The token can mint deploy tokens, so it stays on a maintainer's
machine and never goes into CI. [fnox](https://github.com/jdx/fnox) can
supply it: voidflow's own [`fnox.toml`](fnox.toml) shows the shape, declaring
the secret with no value and a `cf-admin` provider backed by the macOS
Keychain. Store the value once with
`fnox set -k voidflow-cf-token-admin CF_TOKEN_ADMIN` (it prompts with hidden
input); to use another fnox provider (age, 1Password, `pass`...), redefine
`[providers.cf-admin]` in a gitignored `fnox.local.toml`. Run the verbs
behind `fnox proxy run`: voidflow sees a placeholder, and fnox puts the real
token into the `Authorization` header only on calls to
`api.cloudflare.com/client/v4` (the `[proxy]` table in `fnox.toml`), so the
token never reaches the `bun` process or its dependencies. The secret has
`env = false`, so the fnox shell hook doesn't export it into your shell
either. `voidflow init --kind site` writes a repo-owned sample `fnox.toml`;
[Keeping the admin token out of voidflow](docs/config.md#keeping-the-admin-token-out-of-voidflow)
covers it and a YubiKey (`fido2`) override.

Run the verbs inside the repo, with that variable set (or behind
`fnox proxy run --`):

```sh
vf="bunx @taraxvoid/voidflow@<version>"
$vf plan tokens               # read-only: diff the repo's tokens against the config
$vf check tokens              # exit 1 on drift or a token within 14 days of expiry
$vf apply tokens              # create/update, rotate tokens due, set CLOUDFLARE_API_TOKEN per env
$vf apply tokens --rotate     # rotate its tokens now
$vf apply tokens --prune      # also delete `retire` tokens and a leftover repo-wide secret
$vf plan tokens --groups      # live names of the permission group ids the config uses
```

The plan prints when each token was last used, so a CI deploy shows up there.
To prove a token's policies are enough before CI depends on them, run the
deploy with a throwaway token that has the same policies:

```sh
bunx @taraxvoid/voidflow@<version> try tokens prod -- bunx wrangler deploy
```

The real token can't be used locally (its value only exists in GitHub), and
a shell holding a wider token (an admin token, `wrangler login`) would hide a
missing grant. The command gets the throwaway token as `CLOUDFLARE_API_TOKEN`,
with `CF_TOKEN_ADMIN` and the section's `adminTokenEnv` variable removed, and
the token is deleted afterwards (it expires within the hour regardless).

A plan needs `gh` as well as the admin token: it reads the repo's wrangler
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

To move a repo onto voidflow tokens, list its pre-voidflow token names under
`retire`, run `voidflow apply tokens`, deploy, then
`voidflow apply tokens --prune` to delete the old ones.

## The `voidflow` bin

The package's `voidflow` bin runs `init` and the verbs from a pinned release,
under Bun or Node 24+ (`bunx` or `npx`); the package ships it built to
`dist/`. In this repo, `bun scripts/cli.ts` runs the same entry point from the
checkout. The config file stays TypeScript under either runtime. Node 24 loads
it by stripping types, which covers erasable syntax only: type annotations,
`type` / `interface`, `as` and `satisfies`, but no `enum`, `namespace` or
constructor parameter properties. Write it as plain data plus types.

If you run a canary (`@next`) with an npm release-age cooldown set, add
`min-release-age-exclude[]=voidflow` and `min-release-age-exclude[]=@taraxvoid/*`
to your `.npmrc`, or `@next` resolves to an older release. `npx` ignores the
exclusion in current npm releases, and npm before 11.17 does not know it, so
run `npx --min-release-age=0 @taraxvoid/voidflow@next ...` instead (this also
lifts the cooldown for that run's dependencies). See
[Trying a canary release](docs/init.md#trying-a-canary-release).
