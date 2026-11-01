import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const wf: any = Bun.YAML.parse(read('.github/workflows/site-ci.yml'))
const inputs = wf.on.workflow_call.inputs
const { validate } = wf.jobs
const GATE = "steps.decide.outputs.validate == 'true'"
const changesStep = (id: string) => validate.steps.find((s: any) => s.id === id)
const validateStep = (name: string) => validate.steps.find((s: any) => s.name === name)

describe('site-ci.yml job shape', () => {
    test('is one job that still reports as "validate / Validate" (the required check name)', () => {
        expect(Object.keys(wf.jobs)).toEqual(['validate'])
        expect(validate.name).toBe('Validate')
        expect(validate.needs).toBeUndefined()
    })

    // Callers must grant at least this, so anything wider is forced on all of them.
    test('only reads: nothing in the job writes to the repo or PRs', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    })

    test('skips drafts and closed PRs, keeps full history for gitleaks', () => {
        expect(validate.if).toBe("github.event.pull_request.draft == false && github.event.action != 'closed'")
        expect(validate.steps[0].with['fetch-depth']).toBe(0)
        expect(validateStep('Secrets Scan')).toBeDefined()
    })

    // The trailing SARIF steps are the exception: they belong to the scan, so a
    // docs-only PR still keeps its gitleaks and zizmor SARIF (see tool-ci.test.ts).
    test('every step after decide is gated on it, so a docs-only PR stops after the scan', () => {
        const ids = validate.steps.map((s: any) => s.id)
        const after = validate.steps.slice(ids.indexOf('decide') + 1, -3)
        expect(validate.steps.slice(-3).map((s: any) => s.name)).toEqual(['Setup uv (SARIF)', 'zizmor SARIF', 'Keep SARIF'])
        expect(after.length).toBeGreaterThan(10)
        for (const s of after) expect(s.if).toContain(GATE)
    })

    test('workflow linting and zizmor run only when workflows changed', () => {
        for (const name of ['Lint CI workflows', 'Setup uv', 'Audit CI workflows']) {
            expect(validateStep(name).if).toBe(`${GATE} && steps.changes.outputs.workflows == 'true'`)
        }
    })

    test('zizmor gate uses the justfile pin', () => {
        const pinned = read('justfile').match(/^zizmor_version := "([^"]+)"/m)![1]
        expect(validateStep('Audit CI workflows').run).toBe(`uvx zizmor@${pinned} --min-severity medium .github`)
    })

    test('every action is pinned to a full SHA', () => {
        for (const s of validate.steps.filter((s: any) => s.uses)) {
            expect(s.uses).toMatch(/@[0-9a-f]{40}$/)
        }
    })
})

describe('site-ci.yml docs-only filtering', () => {
    const globs: string[] = JSON.parse(inputs['code-paths'].default)
    const includes = globs.filter((g) => !g.startsWith('!')).map((g) => new Bun.Glob(g))
    const excludes = globs.filter((g) => g.startsWith('!')).map((g) => new Bun.Glob(g.slice(1)))
    // paths-filter `some-with-excludes`: any include matches and no exclude does.
    const isCode = (file: string) =>
        includes.some((g) => g.match(file)) && !excludes.some((g) => g.match(file))

    test('filter step uses the excludes-aware quantifier', () => {
        expect(changesStep('changes').with['predicate-quantifier']).toBe('some-with-excludes')
        expect(changesStep('changes').with.filters).toContain('code: ${{ inputs.code-paths }}')
    })

    test.each(['README.md', 'docs/guide/setup.mdx', 'src/content/post.md', 'LICENSE', '.github/ISSUE_TEMPLATE/bug.yml'])(
        'treats %s as not code',
        (file) => expect(isCode(file)).toBe(false),
    )

    test.each([
        'src/pages/index.astro',
        'package.json',
        'bun.lock',
        '.github/workflows/ci.yml',
        'public/robots.txt',
        'wrangler.jsonc',
    ])('treats %s as code', (file) => expect(isCode(file)).toBe(true))

    describe('decide step', () => {
        const run = changesStep('decide').run as string
        const decide = (EVENT: string, CODE: string) => {
            const out = join(mkdtempSync(join(tmpdir(), 'site-ci-')), 'output')
            Bun.spawnSync(['bash', '-c', run], { env: { EVENT, CODE, GITHUB_OUTPUT: out, PATH: process.env.PATH } })
            return readFileSync(out, 'utf8').trim()
        }

        test('skips validate for a docs-only pull request', () => {
            expect(decide('pull_request', 'false')).toBe('validate=false')
        })

        test('validates a pull request that touches code', () => {
            expect(decide('pull_request', 'true')).toBe('validate=true')
        })

        test.each(['push', 'workflow_dispatch', 'schedule'])('always validates on %s', (event) => {
            expect(decide(event, 'false')).toBe('validate=true')
        })
    })
})

describe('site-ci.yml Bun version', () => {
    test('comes from the caller: .bun-version if present, else setup-bun reads package.json', () => {
        expect(validateStep('Setup Bun').with['bun-version-file']).toBe(
            "${{ hashFiles('.bun-version') != '' && '.bun-version' || '' }}",
        )
        expect(validateStep('Setup Bun').with['bun-version']).toBeUndefined()
    })
})

describe('site-ci.yml e2e relevance', () => {
    const build = changesStep('e2e-filter')
    const globsFor = (CODE: string, IGNORE: string) => {
        const out = join(mkdtempSync(join(tmpdir(), 'site-ci-')), 'output')
        const r = Bun.spawnSync(['bash', '-c', build.run], {
            env: { CODE, IGNORE, GITHUB_OUTPUT: out, PATH: process.env.PATH },
        })
        if (r.exitCode !== 0) throw new Error(r.stderr.toString())
        return JSON.parse(readFileSync(out, 'utf8').trim().replace(/^globs=/, '')) as string[]
    }
    const matcher = (globs: string[]) => {
        const includes = globs.filter((g) => !g.startsWith('!')).map((g) => new Bun.Glob(g))
        const excludes = globs.filter((g) => g.startsWith('!')).map((g) => new Bun.Glob(g.slice(1)))
        return (file: string) => includes.some((g) => g.match(file)) && !excludes.some((g) => g.match(file))
    }
    const isE2e = matcher(globsFor(inputs['code-paths'].default, inputs['e2e-ignore-paths'].default))

    test('the e2e filter is code-paths plus each ignore path as an exclude', () => {
        expect(build.env).toEqual({ CODE: '${{ inputs.code-paths }}', IGNORE: '${{ inputs.e2e-ignore-paths }}' })
        expect(globsFor('["**", "!docs/**"]', '["biome.json", "!lefthook.yml"]')).toEqual([
            '**',
            '!docs/**',
            '!biome.json',
            '!lefthook.yml',
        ])
        expect(changesStep('changes').with.filters).toContain('e2e: ${{ steps.e2e-filter.outputs.globs }}')
    })

    test('e2e-extra-paths is gone', () => {
        expect(inputs['e2e-extra-paths']).toBeUndefined()
    })

    // Files the old allowlist missed: a denylist runs e2e for anything unlisted.
    test.each([
        'src/pages/index.astro',
        'wrangler.jsonc',
        'mise.toml',
        'bunfig.toml',
        'pnpm-workspace.yaml',
        'netlify/functions/form.ts',
        'seed/seed.json',
        'worker/index.ts',
        '.github/workflows/ci.yml',
    ])('runs e2e when %s changes', (file) => expect(isE2e(file)).toBe(true))

    test.each(['README.md', 'biome.json', 'lefthook.yml', 'renovate.json', 'vitest.config.ts', '.vscode/settings.json'])(
        'skips e2e when only %s changes',
        (file) => expect(isE2e(file)).toBe(false),
    )

    describe('resolve step', () => {
        const run = validateStep('Resolve e2e relevance').run as string
        const resolve = (event: string, CHANGED: string) => {
            const out = join(mkdtempSync(join(tmpdir(), 'site-ci-')), 'output')
            const ALWAYS = String(['merge_group', 'schedule', 'workflow_dispatch'].includes(event))
            Bun.spawnSync(['bash', '-c', run], { env: { ALWAYS, CHANGED, GITHUB_OUTPUT: out, PATH: process.env.PATH } })
            return readFileSync(out, 'utf8').trim()
        }

        test('follows the e2e filter on pull requests and pushes', () => {
            expect(resolve('pull_request', 'true')).toBe('relevant=true')
            expect(resolve('pull_request', 'false')).toBe('relevant=false')
            expect(resolve('push', 'false')).toBe('relevant=false')
        })

        test.each(['merge_group', 'schedule', 'workflow_dispatch'])('always runs on %s', (event) => {
            expect(resolve(event, '')).toBe('relevant=true')
        })
    })
})

describe('site-ci.yml aube', () => {
    test('documents aube among the package managers and accepts it', () => {
        expect(inputs['package-manager'].description).toContain('aube')
        const check = validate.steps.find((s: any) => s.name === 'Check package manager')
        expect(check.run).toContain('bun | pnpm | aube')
    })

    test('aube shares pnpm-lock.yaml; only bun has its own lockfile', () => {
        expect(validate.env.LOCKFILE).toBe("${{ inputs.package-manager == 'bun' && 'bun.lock' || 'pnpm-lock.yaml' }}")
    })

    test('installs through mise and a frozen `aube ci`', () => {
        const setup = validateStep('Setup aube')
        expect(setup.if).toBe(`${GATE} && inputs.package-manager == 'aube'`)
        expect(setup.uses).toMatch(/^jdx\/mise-action@[0-9a-f]{40}$/)
        const install = validateStep('Install NPM Dependencies (aube)')
        expect(install.if).toBe(`${GATE} && inputs.package-manager == 'aube'`)
        expect(install.run).toContain('aube ci')
    })

    test('Playwright installs through `aube exec` rather than npx', () => {
        expect(validateStep('Install Playwright').run).toContain('aube exec playwright install')
    })
})

describe('site-ci.yml Playwright cache', () => {
    const cache = validate.steps.find((s: any) => s.with?.path === '~/.cache/ms-playwright')

    test('is keyed on the Playwright version, not the lockfile or package.json', () => {
        expect(cache.with.key).toBe(
            '${{ runner.os }}-${{ runner.arch }}-playwright-${{ steps.playwright.outputs.version }}',
        )
        expect(cache.with['restore-keys']).toBeUndefined()
    })

    test('runs after dependencies are installed so the version can be read', () => {
        const order = validate.steps.map((s: any) => s.id ?? s.name)
        expect(order.indexOf('install')).toBeLessThan(order.indexOf('playwright'))
    })
})

describe('site-ci.yml extra e2e scripts and build', () => {
    test('e2e-scripts defaults to none and runs listed scripts in order', () => {
        expect(inputs['e2e-scripts'].default).toBe('[]')
        const step = validateStep('E2E - Extra scripts')
        expect(step.if).toBe(`${GATE} && steps.e2e.outputs.relevant == 'true' && inputs.e2e-scripts != '[]'`)
        expect(step.env.SCRIPTS).toBe('${{ inputs.e2e-scripts }}')
        expect(step.run).not.toContain('inputs.')
    })

    test('build can be turned off', () => {
        expect(inputs.build.default).toBe(true)
        expect(validateStep('Build Code').if).toBe(`${GATE} && steps.scripts.outputs.build == 'true' && inputs.build`)
    })
})

// Scheduled a11y and Lighthouse audits warn instead of failing the run unless
// the caller sets red-audits: true.
describe('site-ci.yml informational audits', () => {
    const audits = [
        ['E2E - Accessibility', 'a11y'],
        ['E2E - Lighthouse', 'lighthouse'],
    ] as const

    test('red-audits is a boolean that defaults to false', () => {
        expect(inputs['red-audits'].type).toBe('boolean')
        expect(inputs['red-audits'].default).toBe(false)
    })

    test.each(audits)('%s continues on error when informational', (name, id) => {
        const step = validateStep(name)
        expect(step.id).toBe(id)
        expect(step['continue-on-error']).toBe('${{ !inputs.red-audits }}')
    })

    test('a failed audit becomes a warning and a summary line', () => {
        const step = validateStep('Report informational audit failures')
        // No status function, so it only runs while the job is still green:
        // with red-audits true the failure already failed the job.
        expect(step.if).toBe(`${GATE} && (steps.a11y.outcome == 'failure' || steps.lighthouse.outcome == 'failure')`)
        expect(step.env).toEqual({ A11Y: '${{ steps.a11y.outcome }}', LIGHTHOUSE: '${{ steps.lighthouse.outcome }}' })
        expect(step.run).toContain('::warning ')
        expect(step.run).toContain('$GITHUB_STEP_SUMMARY')
        const names = validate.steps.map((s: any) => s.name)
        for (const [audit] of audits) expect(names.indexOf(audit)).toBeLessThan(names.indexOf(step.name))
    })

    test('failure reports upload after an informational audit failure too', () => {
        expect(validateStep('Upload failure reports').if).toBe(
            `${GATE} && (failure() || steps.a11y.outcome == 'failure' || steps.lighthouse.outcome == 'failure')`,
        )
    })

    test('the report step prints a warning per failed audit and exits 0', () => {
        const dir = mkdtempSync(join(tmpdir(), 'site-ci-audits-'))
        const summary = join(dir, 'summary.md')
        const r = Bun.spawnSync(['bash', '-eo', 'pipefail', '-c', validateStep('Report informational audit failures').run], {
            env: { PATH: process.env.PATH, A11Y: 'success', LIGHTHOUSE: 'failure', GITHUB_STEP_SUMMARY: summary },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        expect(r.exitCode).toBe(0)
        expect(r.stdout.toString()).toContain('::warning title=E2E - Lighthouse failed::')
        expect(r.stdout.toString()).not.toContain('Accessibility')
        expect(readFileSync(summary, 'utf8')).toContain('**E2E - Lighthouse** failed')
    })
})
