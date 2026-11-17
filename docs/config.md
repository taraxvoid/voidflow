# The per-repo config (`voidflow.config.ts`)

A repo says what voidflow manages for it in a checked-in file at its root,
`voidflow.config.ts`. It holds no secrets, so it is reviewed, checked and
rolled back like any other change in the repo, and the voidflow version the
repo pins is the version that reads it.

Experimental: the file's shape and the commands that read it may change in a
minor ([`STABILITY.md`](../STABILITY.md#experimental)). Pin an exact version.

## The file

Plain data, so it loads under Bun or Node 24 without the package installed.
Use `import type` for the type; nothing is imported at run time.
`voidflow init --kind <k>` writes it holding only `kind`; a re-run keeps an
existing one unless `--force`.

```ts
import type { VoidflowConfig } from '@taraxvoid/voidflow/config'

export default {
    kind: 'site',
    rulesets: { checks: ['validate / Validate'] },
} satisfies VoidflowConfig
```

- `kind` is required: `'site'` or `'tool'`. It selects the defaults below.
- `rulesets` is optional. It overrides the kind's defaults with any field of
  the rulesets `RepoConfig` (see [`rulesets/index.ts`](../rulesets/index.ts):
  `tiers`, `checks`, `codeowners`, `linearHistory`, `mergeQueue`, `bypass`,
  `aka`, `retire`, `environments`), or spells the rulesets out in full as
  `{ rulesets: Ruleset[], retire: string[] }` for protection that does not fit
  the tiers. Unknown fields are errors, reported by path.
- `cloudflare` is optional: the repo's scoped Cloudflare deploy tokens, for
  `voidflow plan|check|apply tokens` (see [Cloudflare tokens](#cloudflare-tokens)).

There is no `owner/name` key. The repo is the `origin` remote of the checkout,
or `GITHUB_REPOSITORY` (set in Actions) when the checkout has no GitHub origin.
If both exist and differ, voidflow exits 2 naming both, so a stale variable or
a job that checked out a second repo cannot send writes to the wrong repo.

## Defaults

The running voidflow release defines what `kind` means, so a repo gets new
defaults by changing the version it pins, and the changelog says when they
change. A field you set replaces the default for that field.

<!-- defaults:start -->
| kind | tiers | checks | codeowners | linearHistory | mergeQueue | retire |
|------|-------|--------|------------|---------------|------------|--------|
| site | main | validate / Validate | true | true | false | next (staging), live (prod) |
| tool | main | validate / Validate | true | true | false | none |
<!-- defaults:end -->

A site's `retire` list names the old `next` and `live` rulesets from before
sites ran a single `main`. They are deleted only with `--prune`.

## Cloudflare tokens

The `cloudflare` section has the shape of a fleet `cf-tokens.ts` entry (see
[`cloudflare/tokens.ts`](../cloudflare/tokens.ts) for every `envs` field), plus
the name of the variable holding the admin token:

```ts
export default {
    kind: 'site',
    cloudflare: {
        account: '0123456789abcdef0123456789abcdef',
        adminTokenEnv: 'CF_TOKEN_ADMIN_EXAMPLE',
        envs: [
            { env: 'prod' },
            { env: 'preview', secret: 'repo', zones: [] },
        ],
    },
} satisfies VoidflowConfig
```

- `account` is the repo's Cloudflare account id (32 hex characters): the
  default for its envs and `retire` names.
- `adminTokenEnv` names the variable that holds the admin token, never the
  token itself. Default: `CF_TOKEN_ADMIN`. Give each Cloudflare account its own
  variable, so repos in different accounts each use a token for their own.
- `envs` is required and lists the tokens: one per env, named
  `voidflow:<owner/name>:<env>`, its value set as that GitHub environment's
  `CLOUDFLARE_API_TOKEN` (or the repo's, with `secret: 'repo'`).
- `retire` lists pre-voidflow token names to delete with `--prune`. Default:
  none.

The admin token can mint tokens, so it stays on a maintainer's machine:
token commands run locally, never from CI. Like a fleet run, a plan needs `gh`
with admin on the repo; it reads the wrangler config from the default branch.

## Running it

From inside the repo, with no `--config` and no `VOIDFLOW_CONFIG`:

```sh
voidflow plan rulesets      # what apply would change, read-only
voidflow check rulesets     # exit 1 on drift
voidflow apply rulesets     # make GitHub match the file
voidflow plan tokens        # the cloudflare section's tokens (tokens means tokens cf)
voidflow apply tokens       # create, update and rotate them; set each env's secret
voidflow apply tokens --prune    # also delete `retire` tokens
voidflow tokens cf --repo-config voidflow.config.ts --try prod -- bunx wrangler deploy
```

voidflow looks for `voidflow.config.ts` from the current directory up to the
repo's git root. Every run prints a header line with the config path, the
voidflow version, the repo, and the name of the credential `gh` uses (never its
value; for tokens, the name of the admin token variable). `apply` writes only
the repo the file sits in, so `--repo` and `--entire-fleet` are refused.

A bare `voidflow plan` or `check` runs rulesets, then tokens when the file has
a `cloudflare` section and its admin token variable is set. Otherwise it says
that tokens were skipped and why, and exits with the rulesets result, so a
repo's CI (which has no admin token) still checks rulesets. Passing
`--config`, or setting `VOIDFLOW_CONFIG`, selects a fleet config instead, and
so does naming tokens in a repo whose file has no `cloudflare` section. Fleet
configs are deprecated and are removed once each repo has its own file; see
[`fleet.md`](fleet.md). To move a repo's tokens over, copy its `cf-tokens.ts`
entry into the `cloudflare` section, run `voidflow plan tokens` in the repo
(it should show no changes), then delete the fleet entry.

A file that does not load, or fails validation, exits 2 naming the file, before
anything is sent to GitHub.
