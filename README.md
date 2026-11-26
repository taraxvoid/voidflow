# voidflow

Secure-by-default CI/CD, GitHub repo settings and git hooks for TypeScript
repos, set up with one command. Built for Astro sites, bun tools and
Cloudflare deploys; works with `bun`, `pnpm`, `aube` and `npm`.

```sh
npx @taraxvoid/voidflow init --kind site --apply    # an Astro site
npx @taraxvoid/voidflow init --kind tool --apply    # a bun CLI, TUI or library
```

## What you get

- **CI** running your `lint`, `check`, `build` and test scripts on every PR,
  plus gitleaks, jactionlint and [zizmor](https://github.com/zizmorcore/zizmor)
  when workflows change
- **Cloudflare Workers deploys** from `main`, with a Worker Preview per PR
- **Locked-down GitHub settings**: PRs and issues from collaborators only,
  Dependabot alerts and security updates, secret scanning with push
  protection, CodeQL
- **Branch rulesets** protecting `main` from pwn requests and agent
  misbehavior (opt-in)
- **Renovate** with a release-age delay and grouped weekly updates
- **A license check** that fails on copyleft and source-available dependencies
- **lefthook git hooks** running the same checks before you push
- **Biome, Playwright and Lighthouse budgets**, preconfigured
- **deps-review** (experimental), an agentic workflow that judges dependency
  PRs so low-risk ones can merge themselves

## Quick start

- Node 24+ or Bun
- [`gh` CLI](https://cli.github.com/) with a repo-admin token

```sh
# New Astro site
bun create astro my-site && cd my-site
npx @taraxvoid/voidflow init --kind site --apply

# New tool: git init and add a package.json first
npx @taraxvoid/voidflow init --kind tool --apply
```

Commit what it wrote and push. Then, once `main` has code on GitHub:

```sh
npx @taraxvoid/voidflow init --kind tool --preset rulesets --apply   # protect main
npx @taraxvoid/voidflow init --preset settings --apply               # so CodeQL has code to scan
```

Rulesets block direct pushes to `main`, which is why the default run leaves
them out.

### Existing repos

Leave off `--apply` to see the plan without changing anything. `init` is
additive: it merges `.gitignore` and `package.json`, and if any other file it
would write already exists with different content, it lists the conflicts and
writes nothing.

```sh
npx @taraxvoid/voidflow init --kind site                           # plan only
npx @taraxvoid/voidflow init --kind site --apply --skip renovate   # keep your own renovate.json
```

### Updating

Re-running is always safe: anything already as wanted is reported
`unchanged`. To pick up a newer voidflow's starter files, run the new version
with `--apply --force` to overwrite the files that differ.

## Common options

| Option | Effect |
|---|---|
| `--apply` | write files and change settings (otherwise plan only) |
| `--preset files\|settings\|ci\|rulesets` | do only part of the setup |
| `--skip <name>` | leave out one file or setting (repeatable) |
| `--only <name>` | do just one file or setting (repeatable; not with `--skip`) |
| `--repo owner/name` | target repo, if not the `origin` remote |
| `--enable-pvr` | private vulnerability reporting and a `SECURITY.md` |
| `--enable-actions-lock` | lock this repo's own workflow actions with `actions.lock` |
| `--enable-agentic` | install deps-review (experimental) |
| `-f`, `--force` | with `--apply`, overwrite files that differ |

Everything else, including exactly what `init` writes and changes, is in
[docs/init.md](docs/init.md). `init` is experimental: its flags may change in
a minor ([`STABILITY.md`](STABILITY.md#experimental)).

## Documentation

| Topic | Doc |
|---|---|
| Every `init` flag, file, setting and exit code; trying canaries | [docs/init.md](docs/init.md) |
| Reusable CI, release and code-scanning workflows; deploy and preview actions | [docs/workflows.md](docs/workflows.md) |
| npm package (license check, Lighthouse, Playwright, Biome), Renovate preset, git hooks | [docs/tools.md](docs/tools.md) |
| deps-review and the other agentic workflows | [docs/agentic.md](docs/agentic.md) |
| The per-repo `voidflow.config.ts` | [docs/config.md](docs/config.md) |
| Releases, verifying tarballs, what versions may change | [`RELEASING.md`](RELEASING.md), [`STABILITY.md`](STABILITY.md) |

## Pinning

Pin workflows and actions to a release SHA with the version in a comment;
Renovate keeps it current.

```yaml
uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@<sha> # vX.Y.Z
```

Canary releases are tagged `vX.Y.Z-next.N` and published to the `next`
dist-tag; if you use an npm release-age cooldown, see
[Trying a canary release](docs/init.md#trying-a-canary-release).

## Used by

[taraxvoid.net](https://taraxvoid.net), [Queer Omaha](https://queeromaha.net),
[Synth Omaha](https://synthomaha.net), [Soundry](https://soundryomaha.org).

Badge:

```html
<a href="https://github.com/taraxvoid/voidflow">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/CI-voidflow-8b8fd9?labelColor=2b2d3a&style=flat">
    <img alt="CI: voidflow" src="https://img.shields.io/badge/CI-voidflow-5a5fb8?labelColor=3a3d4d&style=flat">
  </picture>
</a>
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). MIT licensed.
