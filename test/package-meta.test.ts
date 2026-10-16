import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('package.json', () => {
    test('describes the whole fleet, not only sites', () => {
        expect(pkg.description).toBe('Shared workflows, hooks and tooling for @taraxvoid repos')
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

describe('mise.toml', () => {
    test('pins every contributor tool to an exact version', () => {
        expect(existsSync(new URL('../mise.toml', import.meta.url))).toBe(true)
        const tools = Bun.TOML.parse(read('mise.toml')).tools as Record<string, string>
        for (const t of ['just', 'lefthook', 'jactionlint', 'shellcheck', 'bun', 'act', 'uv']) {
            expect(tools[t]).toMatch(/^\d+\.\d+\.\d+$/)
        }
    })
})
