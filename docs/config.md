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
  `{ raw: Ruleset[], retire?: string[] }` for protection that does not fit
  the tiers. A snapshot of what GitHub has now (`gh api
  repos/<owner>/<repo>/rulesets/<id>`, keeping `name`, `target`,
  `enforcement`, `conditions`, `bypass_actors` and `rules`) plans with no
  drift. Unknown fields are errors, reported by path.
- `cloudflare` is optional: the repo's scoped Cloudflare deploy tokens, for
  `voidflow plan|check|apply tokens` (see [Cloudflare tokens](#cloudflare-tokens)).
- `settings` is optional: the repo settings to check on top of the baseline,
  for `voidflow plan|check|apply settings` (see [Settings](#settings)).

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

The `cloudflare` section lists the repo's scoped deploy tokens (see
[`cloudflare/tokens.ts`](../cloudflare/tokens.ts) for every `envs` field), and
names the variable holding the admin token:

```ts
export default {
    kind: 'site',
    cloudflare: {
        account: '0123456789abcdef0123456789abcdef',
        adminTokenEnv: 'CF_TOKEN_ADMIN_EXAMPLE',
        envs: [
            { env: 'prod' },
            { env: 'preview', zones: [] },
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
  `CLOUDFLARE_API_TOKEN` (or the repo's, with `secret: 'repo'`). Keep each
  env's token in its environment: a repository secret is readable by every
  job, and a Worker Preview token can deploy to the prod Worker (see
  [Where the secret goes](../CONTRIBUTING.md#where-the-secret-goes)).
- `retire` lists pre-voidflow token names to delete with `--prune`. Default:
  none.

The admin token can mint tokens, so it stays on a maintainer's machine:
token commands run locally, never from CI. A plan needs `gh` with admin on the
repo; it reads the wrangler config from the default branch,
prints where each env's Worker and zones came from, and warns when the
checkout's wrangler file resolves differently or its `account_id` is not the
env's account. `--local-wrangler <env>` reads the checkout's file for that env
instead, for a first preview whose `env.preview` block is not merged yet: until then
`preview` resolves to the prod Worker (see
[First preview](../CONTRIBUTING.md#first-preview)). The admin token's permissions are listed in
[Cloudflare deploy tokens as code](../CONTRIBUTING.md#cloudflare-deploy-tokens-as-code).

### Keeping the admin token out of voidflow

`voidflow init --kind site` writes a sample `fnox.toml` (and gitignores
`fnox.local.toml`); like `voidflow.config.ts`, the repo owns it, and an
existing one is kept. It declares the admin token in the macOS Keychain for
[fnox](https://fnox.jdx.dev), without its value, plus a proxy rule. Store the
token once, then run the token verbs behind `fnox proxy run`, with the
voidflow your `package.json` pins (`bun run` never downloads one):

```sh
fnox set -k "voidflow-cf-token-admin:<owner/name>" CF_TOKEN_ADMIN  # hidden input
fnox proxy run -- bun run voidflow plan tokens
fnox proxy run -- bun run voidflow apply tokens
```

voidflow (and every dependency it loads) sees a placeholder, and fnox puts
the real token into the `Authorization` header only on calls to
`api.cloudflare.com/client/v4`. The secret has `env = false`, so the fnox
shell hook doesn't export it into your shell, where voidflow would read the
real value. If `adminTokenEnv` names another variable, rename the secret and
the rule's `secret` to match.

Egress is strict: the proxy refuses every host but `api.cloudflare.com` and
`api.github.com` (the verbs call `gh`). That binds only clients that honor
`HTTPS_PROXY`; the token is safe either way, since only the proxy holds it.

`try tokens` works behind the proxy too: the command gets the throwaway
token, which fnox passes through untouched (it replaces only the
placeholder). The command shares the proxy's limits, though. On
`api.cloudflare.com` only the rule's methods and paths get through, and
request bodies need a `Content-Length` and stay under 10 MiB; other hosts it
needs, such as `registry.npmjs.org` for a `bunx` that downloads, are refused.
To allow more, restate the whole `[proxy]` table in `fnox.local.toml` with
them added (a `[proxy]` there replaces the committed one).

To keep the token behind a YubiKey touch, redefine it in `fnox.local.toml`
with fnox's `fido2` provider:

```sh
fnox -c fnox.local.toml provider add cf-admin fido2   # PIN if set, two touches
fnox -c fnox.local.toml set CF_TOKEN_ADMIN --provider cf-admin
```

Then add `env = false` to that secret in `fnox.local.toml` (an entry there
replaces the one in `fnox.toml` whole, and the shell hook can't run `fido2`),
run `plan tokens` once, and delete the Keychain copy (`security
delete-generic-password -s fnox -a <the value in fnox.toml>`). Keep the
provider named `cf-admin`, because the name is part of key derivation. The
ciphertext only decrypts with the key, so copying `fnox.local.toml` into a
new worktree is fine. Leave `fnox daemon` off: it caches resolved values, so
after one touch any process of yours could read the token from it.

## Settings

GitHub repo settings (the ones `voidflow init` applies) are checked like
rulesets. Every repo gets the baseline; `settings` adds opt-in groups and
leaves settings out:

```ts
export default {
    kind: 'tool',
    settings: {
        enable: ['agentic', 'actions-relock'],
        skip: ['codeql'],
    },
} satisfies VoidflowConfig
```

- `enable` names opt-in groups by their `init` flag: `--enable-agentic` is
  `agentic`. `actions-relock` implies `actions-lock`, which has no settings of
  its own (it adds files only).
- `skip` names settings to leave alone. A skipped setting must be in the
  baseline or an enabled group.
- `init` writes both: a fresh config records the run's `--enable-*` flags and
  setting `--skip`s. In a repo that already has a config, the file's settings
  run along with the flags', and when the flags add any, `init` writes the file
  back from its data, but only when the file is exactly what `init` would
  write for that data. A file with comments or its own layout is kept as it
  is, and `init` prints the lines to add instead, as it does with
  `--skip config`. `--force` overwrites it anyway.

<!-- settings:start -->
| group | settings |
|-------|----------|
| baseline | `pr-policy`, `issue-policy`, `dependabot-alerts`, `dependabot-security-updates`, `secret-scanning`, `codeql` |
| pvr | `pvr` |
| ai-scan | `ai-scan` |
| agentic | `auto-merge`, `update-branch`, `delete-branch-on-merge`, `actions-permissions`, `fork-pr-approval`, `label-low-risk`, `label-needs-you` |
| actions-lock | none (files only) |
| actions-relock | `label-relock-actions` |
<!-- settings:end -->

Settings are enable-only. Each has one target state, and taking a group out
of `enable` stops checking it without turning anything off.

Reading them needs `gh` authenticated as an admin of the repo. voidflow checks
that first: without admin, a 403 would look like a plan limit and hide drift.
A private repo without GitHub Code Security or Secret Protection cannot use
`codeql` or `secret-scanning`, and AI Scan needs a public repo owned by an
organization or Code Security; those settings show as `skipped-plan` and
never count as drift. `codeql` shows `skipped-no-code` until the first push.
Some settings have no API (Dependabot malware alerts, the Require lockfile
policy, code scanning for AI applications); `apply settings` prints them as
manual steps.

## Running it

From inside the repo, as `voidflow <verb> <preset>`:

```sh
voidflow plan rulesets      # what apply would change, read-only
voidflow check rulesets     # exit 1 on drift
voidflow apply rulesets     # make GitHub match the file
voidflow plan settings      # the settings section, on top of the baseline
voidflow apply settings     # turn on the settings that differ
voidflow plan tokens        # the cloudflare section's tokens
voidflow apply tokens       # create, update and rotate them; set each env's secret
voidflow apply tokens --prune    # also delete `retire` tokens
voidflow plan tokens --groups    # the live names of the permission groups used
voidflow validate           # load and check the file, with no network calls
voidflow try tokens prod -- bunx wrangler deploy   # a throwaway token scoped like prod's
```

voidflow reads the `voidflow.config.ts` found from the current directory up to
the repo's git root, and only that file: there is no flag or variable that
points it elsewhere, and it writes only the repo the file belongs to. Without
one, every verb exits 2 pointing at `voidflow init`. Every run prints a header
line per preset with the voidflow version, the config path, the repo, and the
name of the credential it uses (never its value: `gh`'s for rulesets and
settings, the admin token variable for tokens).

A bare `voidflow plan` or `check` runs rulesets, then settings, then tokens
when the file has a `cloudflare` section and its admin token variable is set.
Settings are skipped, with the reason, when `gh` lacks admin on the repo (or
is missing); tokens are skipped, with the reason, otherwise. Neither skip
changes the exit code, so a repo's CI (which has neither) still checks
rulesets. Naming the preset (`voidflow check settings`) makes a missing admin
an error (exit 2) instead, and so does naming tokens in a file without a
`cloudflare` section. `apply` always names one preset, shows its plan and asks before writing (`--yes` skips the question).

| Code | Meaning |
|---|---|
| 0 | in sync, or applied cleanly |
| 1 | drift (`check`), or a failed write (`apply`) |
| 2 | config, usage or auth error, or a read that failed, so a check that could not finish never reads as drift |

With several presets the worst code wins, 2 over 1 over 0.

Up to 1.2, voidflow also read fleet configs (`rulesets.ts` and
`cf-tokens.ts` in an infra repo, found with `--config`, `VOIDFLOW_CONFIG` or
`~/.config/voidflow`) and had per-tool commands (`voidflow rulesets`,
`voidflow tokens cf`, `voidflow settings`). Those are gone, and the old
commands exit 2 naming their replacement. To move a repo over, copy its fleet
entries into its `voidflow.config.ts` (the rulesets entry into `rulesets`,
the `cf-tokens.ts` entry into `cloudflare`, adding `adminTokenEnv` if its
account's admin token is not `CF_TOKEN_ADMIN`), run `voidflow plan` in the
repo (it should show no changes), then delete the fleet entries.

### Reviewing and applying a change

A change to `voidflow.config.ts` goes through a PR like any other: reviewed
as a plan there, applied after merge, and checked for drift from then on.

1. **On the PR**, CI (`tool-ci.yml`, `site-ci.yml`) runs `voidflow validate`,
   which fails the job on a file that does not load or validate (and warns,
   without failing, when a wrangler config deploys a Worker without
   `observability.enabled: true`, or turns it or its logs off in an env), then
   `voidflow plan` against live GitHub, printed in the job summary. Drift
   never fails CI: the PR's config is not applied yet, and drift someone made
   in the GitHub UI is not the PR's problem. Exit 1 or 2 from the plan (a read
   failed, or the default token cannot read something) is a warning.
2. **After merge**, run `voidflow apply <preset>` from an up-to-date checkout
   of `main`. It shows the plan and asks before writing; `--yes` writes
   without asking, and without a terminal `apply` refuses unless given
   `--yes`.
3. **On `main`**, the `voidflow-drift` workflow (`init` writes its caller,
   `.github/workflows/voidflow-drift.yml`) runs `voidflow check` after each
   push and weekly, and keeps one issue open while GitHub differs from the
   file, closing it once a later run is in sync. It installs from the
   lockfile and runs the voidflow version `package.json` pins, on the
   default branch.

Both CI steps run only when the repo defines a `check:voidflow` script (the
templates add `voidflow check`) and `node_modules/.bin/voidflow` is
installed. CI and the drift workflow use `GITHUB_TOKEN`, which is not an
admin: settings are skipped and rulesets are compared without their
`bypass_actors`. The summary says so: rulesets end with `in sync for what was
compared` and a `partial:` line naming how many rulesets went uncompared, and
settings print `settings not checked (...): partial check`. Neither counts as
drift. A token that can read both is tracked in #492. Without the Cloudflare admin token a bare `voidflow check`
cannot list tokens, so it checks only the expiry `voidflow apply tokens`
records in the `VOIDFLOW_CF_TOKEN_EXPIRY` repo variable (JSON, env name to
date): a token within 14 days of expiry, or an env with no record, is drift.
The drift workflow passes that variable from the `vars` context, so its
weekly run opens the drift issue in time to rotate the token locally with
`voidflow apply tokens` behind `fnox proxy run --`.

The `pre-push` hook in `lefthook/base.yml` runs when the pushed commits
change `voidflow.config.ts`, on any branch: `voidflow validate` blocks the
push on a bad file, and `voidflow plan` prints what applying would change
without blocking. It then runs the repo's optional `try:deploy` script, so a
missing token grant shows up before CI depends on it:

```json
"try:deploy": "voidflow try tokens prod -- bunx wrangler deploy --dry-run"
```

`try` creates and deletes a real Cloudflare token, so guard the script on
the admin token being set.

A file that does not load, or fails validation, exits 2 naming the file, before
anything is sent to GitHub.
