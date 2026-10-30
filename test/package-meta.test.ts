import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('package.json', () => {
    test('has good keywords', () => {
        expect(pkg.keywords).not.toContain('astro')
        for (const k of ['lefthook', 'renovate', 'bun']) expect(pkg.keywords).toContain(k)
    })

    test('prepare succeeds without a lefthook binary (CI images)', async () => {
        const proc = Bun.spawn(['/bin/sh', '-c', pkg.scripts.prepare], {
            env: { PATH: '/nonexistent' },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        expect(await proc.exited).toBe(0)
        expect(await new Response(proc.stdout).text()).toContain('git hooks skipped')
    })
})

// Every published entry point is either covered or explicitly experimental, so
// a new bin or export can't ship without a stability decision.
describe('STABILITY.md', () => {
    const stability = read('STABILITY.md')
    const experimental = stability.slice(stability.indexOf('### Experimental'))
    const covered = stability.slice(0, stability.indexOf('### Experimental'))

    test.each(Object.keys(pkg.bin))('classifies bin %s', (name) => {
        expect(covered.includes(`\`${name}\``) || experimental.includes(`\`${name}\``)).toBe(true)
    })

    test.each(Object.keys(pkg.exports).filter((e) => e !== './package.json'))('classifies export %s', (name) => {
        expect(covered.includes(`\`${name}\``) || experimental.includes(`\`${name}\``)).toBe(true)
    })

    test('the fleet tools are experimental, not covered', () => {
        for (const name of ['voidflow', './cloudflare', './rulesets']) {
            expect(experimental).toContain(`\`${name}\``)
            expect(covered).not.toContain(`\`${name}\``)
        }
    })
})

describe('mise.toml', () => {
    test('pins every contributor tool to an exact version', () => {
        expect(existsSync(new URL('../mise.toml', import.meta.url))).toBe(true)
        const tools = Bun.TOML.parse(read('mise.toml')).tools as Record<string, string>
        for (const t of ['just', 'lefthook', 'jactionlint', 'shellcheck', 'bun', 'act', 'uv']) {
            expect(tools[t]).toMatch(/^\d+\.\d+\.\d+$/)
        }
    })
})
