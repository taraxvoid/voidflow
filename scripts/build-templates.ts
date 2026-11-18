#!/usr/bin/env bun
/**
 * Regenerates templates/ (the starter files `voidflow init` writes) from
 * voidflow's own sources of truth: mise.toml, package.json devDependencies,
 * bunfig.toml, the unlighthouse example config. Run via `just templates`.
 * Init-time placeholders are filled in by `voidflow init`, not here.
 */
import {
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageRoot } from './lib/package-root.ts'
import { json, TEMPLATE_PLACEHOLDERS } from './lib/template-format.ts'

export { TEMPLATE_PLACEHOLDERS }

const read = (root: string, p: string) => readFileSync(join(root, p), 'utf8')

function miseVersions(root: string): Record<string, string> {
    const out: Record<string, string> = {}
    let inTools = false
    for (const line of read(root, 'mise.toml').split('\n')) {
        if (/^\s*\[/.test(line)) inTools = /^\s*\[tools\]\s*$/.test(line)
        const m = inTools && line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/)
        if (m) out[m[1]] = m[2]
    }
    return out
}

function need<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new Error(`build-templates: ${what} not found`)
    return v
}

const sarifJob = `# Uncomment to upload gitleaks/zizmor results to code scanning (public repos, or private with GitHub Code Security).
#   sarif:
#     needs: validate
#     if: \${{ !cancelled() && needs.validate.result != 'skipped' }}
#     permissions:
#       contents: read
#       actions: read
#       security-events: write
#     uses: taraxvoid/voidflow/.github/workflows/upload-sarif.yml@{{sha}} # v{{version}}
`

const toolCi = `name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  # Add \`merge_group:\` here if you use a merge queue.
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/tool-ci.yml@{{sha}} # v{{version}}

${sarifJob}`

const siteCi = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
  # Add \`merge_group:\` here if you use a merge queue.
  schedule:
    - cron: '{{cron_minute}} 6 * * *'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: read

jobs:
  validate:
    uses: taraxvoid/voidflow/.github/workflows/site-ci.yml@{{sha}} # v{{version}}

${sarifJob}`

const agenticCaller = (gate: boolean) => `name: Agentic

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  agentic-locks:
    uses: taraxvoid/voidflow/.github/workflows/agentic-locks.yml@{{sha}} # v{{version}}
${
    gate
        ? `
  deps-review-gate:
    permissions:
      checks: write
      contents: read
      pull-requests: read
    uses: taraxvoid/voidflow/.github/workflows/deps-review-gate.yml@{{sha}} # v{{version}}
`
        : ''
}`

const lefthook = `remotes:
  - git_url: https://github.com/taraxvoid/voidflow
    ref: v{{version}} # a tag, not a SHA
    configs:
      - lefthook/base.yml
`

const codeowners = `# Paths a misbehaving bot or a malicious pull request would edit to change how
# the repo, CI or an agent behaves. Require review from Code Owners (the
# branch ruleset's require_code_owner_review) makes a change here need an
# approval from the owner below, who must not be the account the bot pushes as.
# Last match wins; add narrower rules below to hand a path to someone else.

# CI, workflows, actions.lock and this file
/.github/ {{owner}}

# Agent and editor directives
/CLAUDE.md {{owner}}
/AGENTS.md {{owner}}
/GEMINI.md {{owner}}
/.claude/ {{owner}}
/.cursor/ {{owner}}
/.cursorrules {{owner}}
/.mcp.json {{owner}}

# Tooling and hooks
/renovate.json {{owner}}
/lefthook.yml {{owner}}
/mise.toml {{owner}}
/biome.json {{owner}}
/bunfig.toml {{owner}}

# Scripts, dependencies and lockfiles
/package.json {{owner}}
/bun.lock {{owner}}
/package-lock.json {{owner}}
/pnpm-lock.yaml {{owner}}
/yarn.lock {{owner}}

/SECURITY.md {{owner}}
`

const securityMd = `# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
https://github.com/{{repo}}/security/advisories/new

Do not open a public issue for a security problem. Expect an acknowledgement
within a few days.
`

/**
 * Pins the actions-lock templates share with voidflow's own verify-lockfile
 * and relock-actions workflows, so Renovate bumps there carry over.
 */
function lockPins(root: string) {
    const verify = read(root, '.github/workflows/verify-lockfile.yml')
    const relock = read(root, '.github/workflows/relock-actions.yml')
    const version =
        /^\s*VERSION: (v\S+) # renovate: datasource=github-releases depName=github\/gh-actions-lock$/m
    return {
        lockVersion: need(
            version.exec(verify)?.[1],
            'verify-lockfile.yml gh-actions-lock VERSION',
        ),
        checkout: need(
            /uses: actions\/checkout@(\S+)/.exec(verify)?.[1],
            'verify-lockfile.yml actions/checkout',
        ),
        appToken: need(
            /uses: actions\/create-github-app-token@(\S+)/.exec(relock)?.[1],
            'relock-actions.yml actions/create-github-app-token',
        ),
    }
}

type LockPins = ReturnType<typeof lockPins>

const versionLine = (v: string) =>
    `VERSION: ${v} # renovate: datasource=github-releases depName=github/gh-actions-lock`

/*
 * The actions-lock lines below are exact: `voidflow init` rewrites them to
 * name the caller's workflows when it has gh-aw ones (scripts/init/actions-lock.ts).
 */
const verifyLockfile = (
    p: LockPins,
) => `# Fails when .github/workflows/actions.lock is out of sync with this repo's
# workflows, or a locked pin no longer verifies upstream. The weekly run
# catches tags that were re-pointed upstream after they were locked.
#
# Relock locally with \`gh actions-lock\` (or \`--relock\` to advance moved refs)
# and commit .github/workflows. Never run \`--accept-moved\` from automation.
# Docs: https://gh.io/actions-lockfile

name: verify-lockfile

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '{{cron_minute}} 7 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: \${{ github.token }}
      ${versionLine(p.lockVersion)}
    steps:
      - uses: actions/checkout@${p.checkout}
        with:
          persist-credentials: false
      - run: gh extension install github/gh-actions-lock --pin "$VERSION"
      - run: gh actions-lock --verify
`

const relockActions = (
    p: LockPins,
) => `# Keeps .github/workflows/actions.lock in step with workflow edits that
# cannot run gh actions-lock themselves. Renovate (the hosted app has no
# postUpgradeTasks) bumps an action tag; this relocks and pushes the result
# so verify-lockfile passes without a human.
#
# Runs for pull requests opened by renovate[bot], or any same-repo pull
# request carrying the \`relock-actions\` label (apply it after a rebase or a
# hand edit). The push uses a GitHub App token so the new commit triggers CI;
# commits pushed with GITHUB_TOKEN would not. The app needs Contents and
# Workflows read and write on this repo; set its client ID as the
# RELEASE_BOT_CLIENT_ID variable and its private key as the
# RELEASE_BOT_APP_PRIVATE_KEY secret.
#
# Only the lockfile tooling runs here; nothing from the pull request is
# executed. Never run \`gh actions-lock --accept-moved\` from automation.

name: relock-actions

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
    paths:
      - '.github/workflows/**'

permissions: {}

concurrency:
  group: relock-actions-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  relock:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      (github.event.pull_request.user.login == 'renovate[bot]' ||
      contains(github.event.pull_request.labels.*.name, 'relock-actions'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      ${versionLine(p.lockVersion)}
      HEAD_REF: \${{ github.event.pull_request.head.ref }}
      REPO: \${{ github.repository }}
    steps:
      - name: Generate App token
        id: app-token
        uses: actions/create-github-app-token@${p.appToken}
        with:
          client-id: \${{ vars.RELEASE_BOT_CLIENT_ID }}
          private-key: \${{ secrets.RELEASE_BOT_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-workflows: write

      - uses: actions/checkout@${p.checkout}
        with:
          ref: \${{ github.event.pull_request.head.ref }}
          persist-credentials: false

      - name: Install gh-actions-lock
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh extension install github/gh-actions-lock --pin "$VERSION"

      - name: Relock
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh actions-lock

      - name: Commit and push
        env:
          TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          # --porcelain also lists an untracked actions.lock (a first lock).
          if [ -z "$(git status --porcelain -- .github/workflows)" ]; then
            echo "Lockfile already in step."
            exit 0
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add .github/workflows
          git commit -m "chore(deps): relock workflow actions"
          git push "https://x-access-token:\${TOKEN}@github.com/\${REPO}.git" "HEAD:refs/heads/\${HEAD_REF}"
`

const PREPARE =
    "lefthook install || echo 'lefthook not installed (run mise install); git hooks skipped'"

export function buildTemplates(root: string): Map<string, string> {
    const pkg = JSON.parse(read(root, 'package.json'))
    const dev: Record<string, string> = pkg.devDependencies ?? {}
    const biome = need(
        dev['@biomejs/biome'],
        'devDependencies["@biomejs/biome"]',
    )
    const playwright = need(
        dev['@playwright/test'],
        'devDependencies["@playwright/test"]',
    )
    const scanner = need(
        dev['@socketsecurity/bun-security-scanner'],
        'devDependencies["@socketsecurity/bun-security-scanner"]',
    )
    const tools = miseVersions(root)
    const mise = ['lefthook', 'gitleaks', 'jactionlint', 'bun']
        .map((n) => `${n} = "${need(tools[n], `mise.toml tool ${n}`)}"`)
        .join('\n')

    // voidflow's [install] and [install.security] blocks, without its [test] block.
    // Consumers also exempt voidflow itself from the release-age gate, so a
    // fresh voidflow release installs without waiting out the 3 days.
    const bunfig = `${read(root, 'bunfig.toml')
        .split(/^\[test\]/m)[0]
        .replace(
            /^(minimumReleaseAgeExcludes = \[)/m,
            '$1"@taraxvoid/voidflow", ',
        )
        .trim()}\n`
    for (const want of [
        '[install]',
        'minimumReleaseAge',
        '[install.security]',
        'scanner = ',
        '"@taraxvoid/voidflow"',
    ]) {
        if (!bunfig.includes(want))
            throw new Error(`build-templates: bunfig.toml lacks ${want}`)
    }

    const t = new Map<string, string>()
    t.set('common/lefthook.yml', lefthook)
    t.set('common/mise.toml', `[tools]\n${mise}\n`)
    t.set(
        'common/renovate.json',
        json({
            $schema: 'https://docs.renovatebot.com/renovate-schema.json',
            extends: ['github>taraxvoid/voidflow'],
        }),
    )
    t.set('common/bunfig.toml', bunfig)
    t.set(
        'common/biome.json',
        json({
            $schema: `https://biomejs.dev/schemas/${biome}/schema.json`,
            extends: ['@taraxvoid/voidflow/biome'],
            files: { includes: ['**', '!**/bun.lock'] },
        }),
    )
    t.set('common/gitignore', 'node_modules/\ndist/\n.env*\n')
    t.set('common/SECURITY.md', securityMd)
    t.set('common/CODEOWNERS', codeowners)
    // Repo-owned: init writes it once, with no marker.
    t.set(
        'common/voidflow.config.ts',
        `// voidflow settings for this repo; \`kind\` picks the defaults: https://github.com/taraxvoid/voidflow/blob/main/docs/config.md

import type { VoidflowConfig } from '@taraxvoid/voidflow/config'

export default { kind: '{{kind}}' } satisfies VoidflowConfig
`,
    )
    // The gh-aw version agentic-locks.yml compiles with; init tells you to match it.
    const ghAw = /default:\s*(v\d[\w.-]*)/.exec(
        read(root, '.github/workflows/agentic-locks.yml'),
    )?.[1]
    t.set(
        'common/gh-aw-version',
        `${need(ghAw, 'agentic-locks.yml gh-aw-version default')}\n`,
    )
    t.set('common/agentic-shadow.yml', agenticCaller(false))
    t.set('common/agentic-gate.yml', agenticCaller(true))
    const pins = lockPins(root)
    t.set('common/verify-lockfile.yml', verifyLockfile(pins))
    t.set('common/relock-actions.yml', relockActions(pins))

    t.set('tool/ci.yml', toolCi)
    t.set(
        'tool/tsconfig.json',
        json({
            compilerOptions: {
                target: 'ESNext',
                module: 'Preserve',
                moduleResolution: 'bundler',
                allowImportingTsExtensions: true,
                strict: true,
                skipLibCheck: true,
                noEmit: true,
                types: ['bun'],
            },
        }),
    )
    t.set(
        'tool/package.json',
        json({
            scripts: {
                prepare: PREPARE,
                lint: 'biome check .',
                check: 'tsc --noEmit',
                test: 'bun test',
                'check:licenses': 'check-licenses',
                'check:voidflow': 'voidflow check',
            },
            devDependencies: {
                '@taraxvoid/voidflow': '{{version}}',
                '@biomejs/biome': biome,
                '@socketsecurity/bun-security-scanner': scanner,
                typescript: dev.typescript ?? '5.9.3',
                '@types/bun': dev['@types/bun'] ?? '1.4.4',
            },
        }),
    )

    t.set('site/ci.yml', siteCi)
    t.set(
        'site/playwright.config.js',
        `import { definePreviewConfig } from '@taraxvoid/voidflow/playwright'

export default definePreviewConfig({ ciPort: 4141 })
`,
    )
    t.set(
        'site/unlighthouse.config.ts',
        read(root, 'scripts/unlighthouse/unlighthouse.config.example.ts'),
    )
    t.set(
        'site/package.json',
        json({
            scripts: {
                prepare: PREPARE,
                lint: 'biome check .',
                'check:licenses': 'check-licenses',
                'check:voidflow': 'voidflow check',
                'test:e2e:all': 'playwright test',
                'test:e2e:a11y': 'playwright test --grep @a11y',
                'test:e2e:lighthouse':
                    'bun run build && unlighthouse-runner --dir dist',
            },
            devDependencies: {
                '@taraxvoid/voidflow': '{{version}}',
                '@biomejs/biome': biome,
                '@playwright/test': playwright,
                '@socketsecurity/bun-security-scanner': scanner,
            },
        }),
    )
    t.set(
        'site/gitignore',
        '.unlighthouse/\ntest-results/\nplaywright-report/\n',
    )

    return new Map([...t].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function listFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
    )
}

/** Write the built map to <root>/templates, deleting files no longer built. */
export function writeTemplates(root: string): void {
    const out = join(root, 'templates')
    const built = buildTemplates(root)
    try {
        for (const f of listFiles(out)) {
            if (!built.has(relative(out, f))) rmSync(f)
        }
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    for (const [path, content] of built) {
        mkdirSync(dirname(join(out, path)), { recursive: true })
        writeFileSync(join(out, path), content)
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    writeTemplates(packageRoot())
}
