import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const wf: any = Bun.YAML.parse(read('.github/workflows/site-ci.yml'))
const inputs = wf.on.workflow_call.inputs
const validateStep = (name: string) => wf.jobs.validate.steps.find((s: any) => s.name === name)

describe('site-ci.yml Renovate e2e opt-out', () => {
    const step = validateStep('Renovate e2e opt-out')
    const pkg = (devDependencies: Record<string, string>, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ name: 'x', dependencies: { astro: '1.0.0' }, devDependencies, ...extra }, null, 2)

    // Builds a base commit and a PR commit, then a merge commit like actions/checkout does.
    const run = (before: string, after: string, env: Record<string, string> = {}, lockOnly = false) => {
        const dir = mkdtempSync(join(tmpdir(), 'site-ci-git-'))
        const git = (...args: string[]) => {
            const r = Bun.spawnSync(
                ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
                { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } },
            )
            if (r.exitCode !== 0) throw new Error(r.stderr.toString())
        }
        git('init', '-q', '-b', 'main')
        writeFileSync(join(dir, 'package.json'), before)
        writeFileSync(join(dir, 'bun.lock'), 'a')
        git('add', '.')
        git('commit', '-q', '-m', 'base')
        git('switch', '-q', '-c', 'pr')
        writeFileSync(join(dir, 'package.json'), lockOnly ? before : after)
        writeFileSync(join(dir, 'bun.lock'), 'b')
        git('commit', '-qam', 'bump')
        git('switch', '-q', 'main')
        writeFileSync(join(dir, 'README.md'), 'x')
        git('add', '.')
        git('commit', '-q', '-m', 'base moves')
        git('merge', '-q', '--no-ff', '-m', 'merge', 'pr')
        const out = join(dir, 'out')
        Bun.spawnSync(['bash', '-eo', 'pipefail', '-c', step.run as string], {
            cwd: dir,
            env: {
                AUTHOR: 'renovate[bot]',
                OTHER: 'false',
                PACKAGES: inputs['renovate-e2e-packages'].default,
                GITHUB_OUTPUT: out,
                PATH: process.env.PATH,
                HOME: dir,
                ...env,
            },
        })
        return existsSync(out) ? readFileSync(out, 'utf8').trim() : ''
    }

    test('is opt-out and only runs for pull requests that e2e would run on', () => {
        expect(inputs['renovate-skip-e2e'].default).toBe(true)
        expect(step.if).toBe(
            "inputs.renovate-skip-e2e && github.event_name == 'pull_request' && steps.changes.outputs.e2e == 'true'",
        )
        expect(validateStep('Resolve e2e relevance').env.SKIP).toBe('${{ steps.renovate-skip.outputs.skip }}')
    })

    test('skips for an unrelated devDependency bump', () => {
        expect(run(pkg({ lefthook: '1.0.0' }), pkg({ lefthook: '1.1.0' }))).toBe('skip=true')
    })

    test.each([
        ['an unrelated devDependency bump from a human', { AUTHOR: 'tara' }, { lefthook: '1.1.0' }],
        ['changes to other e2e files', { OTHER: 'true' }, { lefthook: '1.1.0' }],
        ['a Playwright bump', {}, { lefthook: '1.0.0', '@playwright/test': '1.1.0' }],
    ])('keeps e2e for %s', (_name, env, after) => {
        const before = { lefthook: '1.0.0', '@playwright/test': '1.0.0' }
        expect(run(pkg(before), pkg(after), env)).toBe('')
    })

    test('keeps e2e for a runtime dependency bump, a non-dependency field change and a lockfile-only change', () => {
        const dev = { lefthook: '1.0.0' }
        expect(run(pkg(dev), pkg(dev, { dependencies: { astro: '2.0.0' } }))).toBe('')
        expect(run(pkg(dev), pkg(dev, { scripts: { x: 'y' } }))).toBe('')
        expect(run(pkg(dev), pkg(dev), {}, true)).toBe('')
    })
})
