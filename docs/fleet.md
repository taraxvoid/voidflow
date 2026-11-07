# Fleet config and the plan, check and apply verbs

voidflow holds the code for two fleet tools: branch rulesets (`rulesets`) and
scoped Cloudflare deploy tokens (`cf-tokens`). Which repos they cover, and
how, lives in your org's own private infra repo. This page covers that repo's
shape, how voidflow finds it, and the `plan`, `check` and `apply` verbs that
run both tools from a pinned release, with no voidflow checkout and no
justfile.

Experimental: commands, flags and config shapes may change in a minor
([`STABILITY.md`](../STABILITY.md#experimental)). Pin an exact version.

## The infra repo

One module per tool at the repo root:

```
infra/
  rulesets.ts     # which repos get which branch rulesets
  cf-tokens.ts    # which repos get which Cloudflare deploy tokens
  package.json    # optional: pins @taraxvoid/voidflow for typed configs
```

A repo can hold either file or both. To run the verbs from anywhere, link the
checkout to voidflow's config directory:

```sh
ln -s ~/src/infra ~/.config/voidflow
```

The config shapes, tiers and token options are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#fleet-config---config).

## Discovery

Each tool's file is looked for in this order; the first hit wins:

1. `--config <file|dir>`
2. `VOIDFLOW_CONFIG` (a file or a directory)
3. `$XDG_CONFIG_HOME/voidflow`, by default `~/.config/voidflow` (may be a symlink)
4. the current directory and each one above it, nearest first, holding the
   tool's file (so running inside the infra checkout finds it)

A directory means the tool's file in it (`rulesets.ts` or `cf-tokens.ts`). A
leading `~/` expands to your home directory, and a relative value resolves
from `VOIDFLOW_CONFIG_BASE` when that is set, else the current directory.

The first source that is set decides on its own. If `--config` or
`VOIDFLOW_CONFIG` names a path that does not exist, or
`~/.config/voidflow` is a symlink to a missing path, the run stops with
exit 2 naming it; it does not quietly try the next source. A config
directory that holds only one tool's file is fine: a verb with no tool named
skips the other tool with a note, and a verb that names it fails saying where
it looked.

```sh
voidflow plan                                  # ~/.config/voidflow, both tools
voidflow plan rulesets --config ../infra       # ../infra/rulesets.ts
VOIDFLOW_CONFIG=~/src/infra voidflow check     # both tools from there
voidflow plan cf-tokens --config ./cf-tokens.ts
```

`voidflow rulesets --config <module>` and `voidflow cf-tokens --config
<module>` keep working as before, with no discovery.

## Config shapes

Each module exports its map as `REPOS` or as the default export. Both shapes
load; pick one per file.

Flat, one `owner/name` key per repo:

```ts
// rulesets.ts
export default {
    'taraxvoid/voidflow': { tiers: ['main', 'prerelease'] },
    'taraxvoid/transbot': {},
    'queeromaha/queeromaha.net': {},
}
```

Org-grouped, so the owner is not repeated on every key:

```ts
// rulesets.ts
export default {
    orgs: {
        taraxvoid: {
            repos: {
                voidflow: { tiers: ['main', 'prerelease'] },
                transbot: {},
            },
        },
        queeromaha: { repos: { 'queeromaha.net': {} } },
    },
}
```

The loader turns the grouped shape into the flat one before checking it, so
both tools, `--repo` matching and `init --config` treat them the same. An
`orgs` file may hold nothing else at the top level, an org block holds only
`repos`, and a repo name has no `/`. Problems are reported by path, all at
once, e.g. `orgs.taraxvoid.repos."a/b": name has a slash`.

`voidflow init --config <file|dir>` adds the repo it sets up to the rulesets
config: as `'owner/name': {},` in a flat file, or under `orgs.<owner>.repos`
(adding the owner block if needed) in a grouped one.

## Verbs and targets

```sh
voidflow plan  [rulesets|cf-tokens] [--repo <name>]   # read-only: what apply would change
voidflow check [rulesets|cf-tokens] [--repo <name>]   # read-only: exit 1 on drift
voidflow apply  rulesets|cf-tokens  (--repo <name> | --entire-fleet)
```

- `plan` and `check` cover every repo by default; `--repo` narrows to one
  (an `owner/name`, or a bare name, which matches it under every owner).
  With no tool named they run each configured tool, rulesets first, and a
  failing tool does not stop the next one.
- `apply` writes, so it takes exactly one tool and exactly one target:
  `--repo <name>`, which must name a single repo (a bare name in two orgs is
  refused with both listed), or `--entire-fleet`. With neither, it lists the
  repos and stops. There is no default target: running it from a site
  checkout never infers that site.
- Other flags go to the tool: `--prune`, and `--rotate` for cf-tokens. See
  `voidflow rulesets --help` and `voidflow cf-tokens --help`. The verbs set
  `--check` and `--apply` themselves and refuse them; `--try` and `--groups`
  stay on `voidflow cf-tokens`.

Every run prints one header line per tool to stderr before the tool runs:

```
voidflow 1.0.0-next.4 apply rulesets | config /Users/you/.config/voidflow/rulesets.ts (xdg) | scope repo taraxvoid/transbot
```

It names the version, verb, tool, the config file and which source found it
(`flag`, `env`, `xdg` or `cwd`), and the scope: `fleet (read-only)`,
`repo <name> (read-only)`, `repo <owner/name>` or `entire fleet`. It never
prints a credential.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | no drift, or applied cleanly |
| 1 | drift (`check`), or a failure while planning or applying |
| 2 | config, usage or auth error |

With several tools the worst code wins, 2 over 1 over 0.

## Runtimes

The bin runs under Node 24+ and Bun 1.4+, and installs with npm, bun, pnpm
or aube. Run it without installing:

```sh
bunx @taraxvoid/voidflow@<version> plan
npx @taraxvoid/voidflow@<version> plan
pnpm dlx @taraxvoid/voidflow@<version> plan
aube dlx @taraxvoid/voidflow@<version> plan
```

Config modules stay TypeScript under either runtime; Node loads them by
stripping types, so keep them to erasable syntax (see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#fleet-config---config)).

## Moving an infra justfile to the verbs

Recipes that shelled into a voidflow checkout, or passed `--config` to the
bin, become one-liners. With the infra checkout linked at
`~/.config/voidflow`, or run from inside it, they need no `--config` at all:

```just
vf := "bunx @taraxvoid/voidflow@<version>"

plan *args:
    {{ vf }} plan {{ args }}

check *args:
    {{ vf }} check {{ args }}

# just apply rulesets --repo transbot
apply tool *args:
    {{ vf }} apply {{ tool }} {{ args }}
```

Keep supplying `CF_TOKEN_ADMIN` the way you do now (fnox, 1Password, the
environment) for cf-tokens.

## What belongs here, and what does not

A concern belongs in voidflow only if it is:

1. stateless: desired state in config plus read-only live queries, no state
   file;
2. one API per reconciler: get, diff, put, idempotent, with a read-only plan,
   and live identity derived from config (a name or tag), never a stored id;
3. about making a repo safe to ship from (branch protection, repo security
   settings, deploy credentials), not what the repo deploys onto;
4. a small flat record per entry.

Anything else (creating Workers, DNS records, D1 databases or buckets, or
anything that needs a dependency graph) belongs in Terraform, OpenTofu,
[Alchemy](https://alchemy.run) or wrangler. The Cloudflare Terraform provider
can manage API tokens too (`cloudflare_api_token`, `cloudflare_account_token`),
but token values then live in Terraform state; voidflow keeps no state, so
values go straight from the API into GitHub secrets.
