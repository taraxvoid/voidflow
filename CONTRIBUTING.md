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

Deploy tokens for the fleet live in [`cloudflare/tokens.ts`](cloudflare/tokens.ts):
per repo and GitHub environment, the Worker it deploys and the zones of its
custom domains. An env can set its own `account` (say dev/staging in a
separate account from prod); otherwise it uses the repo's. Each token is owned
by its env's account and scoped to that one Worker (the
Workers Editor role on it), plus Workers Routes Write on those zones only, with
a 90-day expiry.

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

```sh
just cf-tokens-plan                 # read-only: diff every repo's tokens against the config
just cf-tokens-plan --check         # exit 1 on drift or a token within 14 days of expiry
just cf-tokens-apply                # create/update, rotate tokens due, set CLOUDFLARE_API_TOKEN per env
just cf-tokens-apply --rotate       # rotate every token now
just cf-tokens-apply --prune        # also delete the old tokens a repo lists under `retire`
just cf-tokens-groups               # live names of the permission group ids the config uses
```

New values go straight from the API into `gh secret set CLOUDFLARE_API_TOKEN
--env <env>` and are never printed. A rotation creates the new token, sets the
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
  prints it, and `apply` sets the env variable `CF_TOKEN_FALLBACK`. Pass that
  to the deploy action so every deploy warns:

  ```yaml
  - uses: taraxvoid/voidflow/actions/cloudflare-deploy@<sha> # <version>
    with:
      env: ${{ needs.resolve-env.outputs.env }}
      cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      token-fallback: ${{ vars.CF_TOKEN_FALLBACK }}
  ```

Cut over one repo at a time: `just cf-tokens-apply --repo <name>`, deploy, then
`just cf-tokens-apply --repo <name> --prune` to delete its old token. Repo
tooling, not part of the published package.

## Another org's fleet (`--config`)

The built-in configs for rulesets and Cloudflare tokens cover taraxvoid repos.
Another org keeps its fleet map in its own (private) repo, as modules that
export `REPOS` (or a default) of the same shape, and passes them with
`--config` to `rulesets-*` or `cf-tokens-*`:

```ts
// cf-tokens.ts in the org's own repo
const DEV = '<dev account id>' // dev and staging
const PROD = '<prod account id>'

export const REPOS = {
    'example-org/site': {
        account: PROD,
        envs: [
            { env: 'dev', worker: 'site-dev', zones: [], account: DEV },
            { env: 'prod', worker: 'site', zones: ['example.com'] },
        ],
        retire: [],
    },
}
```

```sh
just -f ../voidflow/justfile cf-tokens-plan --config cf-tokens.ts
just -f ../voidflow/justfile rulesets-plan --config rulesets.ts
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
