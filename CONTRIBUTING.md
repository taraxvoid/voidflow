# Contributing

## Setup

```sh
mise install   # tools pinned in mise.toml
bun install    # prepare script runs `lefthook install`
```

## Checks

`just validate` runs everything CI (`.github/workflows/ci.yml`) runs:

- `just lint-workflows`: jactionlint, including shellcheck on workflow `run:` steps
- `just lint-actions`: check-jsonschema on workflows and `actions/**/action.yml`
- `just lint-shell`: shellcheck on `run:` steps in composite actions
  (`scripts/shellcheck-actions.ts`)
- `just security`: zizmor

lefthook runs the first three on `pre-commit` and zizmor on `pre-push`.

Pin every third-party action to a full commit SHA with a version comment.

### Running CI locally

`just dry-run` runs `ci.yml` under [`act`](https://github.com/nektos/act)
(needs Docker). Extra args pass through, e.g. `just dry-run -j validation`.

- Run it from a plain clone, not a git worktree. `act` copies the tree without
  resolving the worktree's `.git` pointer, so `git ls-files` steps see no files
  and pass vacuously.
- Colima works: `.actrc` already disables the docker socket mount.

## Branches and commits

Feature PRs target `next`. Use [Conventional Commits](https://www.conventionalcommits.org);
they drive version bumps and the changelog. See [`RELEASING.md`](RELEASING.md)
for the release flow.

## Branch rulesets

Rulesets for the fleet's repos are defined in
[`rulesets/index.ts`](rulesets/index.ts). Sites use `site()`, tools use
`tool()`. Needs `gh` with admin on the repos.

```sh
just rulesets-plan                  # diff every repo against the config
just rulesets-plan --repo soundry
just rulesets-plan --check          # exit 1 on drift
just rulesets-apply                 # create/update to match
just rulesets-apply --prune         # also delete rulesets listed under `retire`
```

Rulesets not in the config are reported and left alone. Repos where the API
returns 403 (private repos on a plan without rulesets) are skipped and listed.

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

### Where the secret goes

By default each env's token goes into an environment secret,
`CLOUDFLARE_API_TOKEN` in the GitHub environment named like the env. Only
jobs with `environment: <env>` read it, so the environment's deployment
branch policy (`main` only for `prod`) is what keeps a pull request job from
reading the prod token. That is the recommended shape: one deploy job for
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

From the infra repo, whose recipes pass its config to these:

```sh
just cf-tokens-plan                 # read-only: diff every repo's tokens against the config
just cf-tokens-plan --check         # exit 1 on drift or a token within 14 days of expiry
just cf-tokens-apply                # create/update, rotate tokens due, set CLOUDFLARE_API_TOKEN per env
just cf-tokens-apply --rotate       # rotate every token now
just cf-tokens-apply --prune        # also delete `retire` tokens and a leftover repo-wide secret
just cf-tokens-groups               # live names of the permission group ids the config uses
```

The plan prints when each token was last used, so a CI deploy shows up there.
To prove a token's policies are enough before CI depends on them, run the
deploy with a throwaway token that has the same policies. From the site's
checkout:

```sh
just -f ../infra/justfile cf-tokens-try transbot prod bunx wrangler deploy
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

Cut over one repo at a time: `just cf-tokens-apply --repo <name>`, deploy, then
`just cf-tokens-apply --repo <name> --prune` to delete its old token. Repo
tooling, not part of the published package.

## Fleet config (`--config`)

voidflow holds the tools; each org keeps its fleet map (repo names, account
ids, envs) in its own private infra repo, e.g. `taraxvoid/infra`, as modules
that export `REPOS` (or a default). The infra repo's justfile wraps voidflow's
recipes with `--config` pointing at them. `cf-tokens-*` requires it;
`rulesets-*` still falls back to the built-in `REPOS` in `rulesets/index.ts`
until that moves out too.

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

```just
# justfile in the org's infra repo
voidflow := env_var_or_default("VOIDFLOW", home_directory() / "projects/personal/voidflow")
vf := "just -f " + quote(voidflow / "justfile")
tokens := justfile_directory() / "cf-tokens.ts"

cf-tokens-plan *args:
    {{ vf }} cf-tokens-plan --config {{ quote(tokens) }} {{ args }}

# [no-cd]: the command runs in the site checkout `just -f` was called from
[no-cd]
cf-tokens-try repo env +cmd:
    {{ vf }} cf-tokens-try {{ quote(tokens) }} {{ repo }} {{ env }} {{ cmd }}
```

A rulesets config can use the tier model, where any field left out takes
`tool()`'s value (main only, the `validate` check, CODEOWNERS, linear
history, so `{}` is a valid repo) and an unknown field is an error. Or it can
spell a repo's rulesets out in full as `{ rulesets: [...], retire: [...] }` when its protection doesn't fit
the tiers. A snapshot of what GitHub has now (`gh api
repos/<repo>/rulesets/<id>`, keeping `name`, `target`, `enforcement`,
`conditions`, `bypass_actors` and `rules`) plans with no drift.

A relative path resolves from the directory `just` runs in. Each config is
checked before any API call, and every problem is reported by its path.
`CF_TOKEN_ADMIN` then needs to cover that org's accounts, and `gh` needs admin
on its repos.
