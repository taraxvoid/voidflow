import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const wf: any = Bun.YAML.parse(read('.github/workflows/site-ci.yml'))
const inputs = wf.on.workflow_call.inputs
const { changes, validate } = wf.jobs
const changesStep = (id: string) => changes.steps.find((s: any) => s.id === id)
const validateStep = (name: string) => validate.steps.find((s: any) => s.name === name)

describe('site-ci.yml job split', () => {
    test('validate still reports as "validate / Validate" (the required check name)', () => {
        expect(validate.name).toBe('Validate')
    })

    test('validate waits for changes and only runs when it says so', () => {
        expect(validate.needs).toBe('changes')
        expect(validate.if).toBe("needs.changes.outputs.validate == 'true'")
    })

    test('changes skips drafts and keeps full history for gitleaks', () => {
        expect(changes.if).toBe('github.event.pull_request.draft == false')
        expect(changes.steps[0].with['fetch-depth']).toBe(0)
        expect(changes.steps.some((s: any) => s.name === 'Secrets Scan')).toBe(true)
    })

    test('validate uses a shallow checkout and no longer scans for secrets', () => {
        expect(validate.steps[0].with['fetch-depth']).toBeUndefined()
        expect(validateStep('Secrets Scan')).toBeUndefined()
    })

    test('every action in both jobs is pinned to a full SHA', () => {
        for (const s of [...changes.steps, ...validate.steps].filter((s: any) => s.uses)) {
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

describe('site-ci.yml aube', () => {
    test('documents aube among the package managers and accepts it', () => {
        expect(inputs['package-manager'].description).toContain('aube')
        const check = changes.steps.find((s: any) => s.name === 'Check package manager')
        expect(check.run).toContain('bun | pnpm | aube')
    })

    test('aube shares pnpm-lock.yaml; only bun has its own lockfile', () => {
        for (const job of [changes, validate]) {
            expect(job.env.LOCKFILE).toBe("${{ inputs.package-manager == 'bun' && 'bun.lock' || 'pnpm-lock.yaml' }}")
        }
    })

    test('installs through mise and a frozen `aube ci`', () => {
        const setup = validateStep('Setup aube')
        expect(setup.if).toBe("inputs.package-manager == 'aube'")
        expect(setup.uses).toMatch(/^jdx\/mise-action@[0-9a-f]{40}$/)
        const install = validateStep('Install NPM Dependencies (aube)')
        expect(install.if).toBe("inputs.package-manager == 'aube'")
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
        expect(step.if).toBe("needs.changes.outputs.e2e == 'true' && inputs.e2e-scripts != '[]'")
        expect(step.env.SCRIPTS).toBe('${{ inputs.e2e-scripts }}')
        expect(step.run).not.toContain('inputs.')
    })

    test('build can be turned off', () => {
        expect(inputs.build.default).toBe(true)
        expect(validateStep('Build Code').if).toBe("steps.scripts.outputs.build == 'true' && inputs.build")
    })
})
