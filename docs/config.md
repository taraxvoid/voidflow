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
- `cloudflare` is reserved: `{ account, adminTokenEnv }`. It is checked for
  shape and reported, but nothing applies it yet. `account` is the repo's own
  Cloudflare account id and `adminTokenEnv` names the variable that holds the
  admin token, never the token itself.

There is no `owner/name` key. The repo is `GITHUB_REPOSITORY` when that is set
(as in Actions), otherwise the `origin` remote of the checkout.

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

## Running it

From inside the repo, with no `--config` and no `VOIDFLOW_CONFIG`:

```sh
voidflow plan rulesets      # what apply would change, read-only
voidflow check rulesets     # exit 1 on drift
voidflow apply rulesets     # make GitHub match the file
```

voidflow looks for `voidflow.config.ts` from the current directory up to the
repo's git root. Every run prints a header line with the config path, the
voidflow version, the repo, and the name of the credential `gh` uses (never its
value). `apply` writes only the repo the file sits in, so `--repo` and
`--entire-fleet` are refused.

A bare `voidflow plan` runs rulesets only here and says that tokens were
skipped. Passing `--config`, or setting `VOIDFLOW_CONFIG`, selects a fleet
config instead, and so does naming a tokens tool (`plan tokens cf`). Fleet
configs for rulesets are deprecated and are removed once each repo has its own
file; see [`fleet.md`](fleet.md).

A file that does not load, or fails validation, exits 2 naming the file, before
anything is sent to GitHub.
