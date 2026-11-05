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

const securityMd = `# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
https://github.com/{{repo}}/security/advisories/new

Do not open a public issue for a security problem. Expect an acknowledgement
within a few days.
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
    const tools = miseVersions(root)
    const mise = ['lefthook', 'gitleaks', 'jactionlint', 'bun']
        .map((n) => `${n} = "${need(tools[n], `mise.toml tool ${n}`)}"`)
        .join('\n')

    // voidflow's [install] and [install.security] blocks, without its [test] block.
    const bunfig = `${read(root, 'bunfig.toml')
        .split(/^\[test\]/m)[0]
        .trim()}\n`
    for (const want of [
        '[install]',
        'minimumReleaseAge',
        '[install.security]',
        'scanner = ',
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
    t.set('common/agentic-shadow.yml', agenticCaller(false))
    t.set('common/agentic-gate.yml', agenticCaller(true))

    t.set('tool/ci.yml', toolCi)
    t.set(
        'tool/tsconfig.json',
        json({
            compilerOptions: {
                target: 'ESNext',
                module: 'Preserve',
                moduleResolution: 'bundler',
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
            },
            devDependencies: {
                '@taraxvoid/voidflow': '{{version}}',
                '@biomejs/biome': biome,
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
                'test:e2e:all': 'playwright test',
                'test:e2e:a11y': 'playwright test --grep @a11y',
                'test:e2e:lighthouse':
                    'bun run build && unlighthouse-runner --dir dist',
            },
            devDependencies: {
                '@taraxvoid/voidflow': '{{version}}',
                '@biomejs/biome': biome,
                '@playwright/test': playwright,
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
