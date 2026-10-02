import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

const config = new URL('../lefthook/site.yml', import.meta.url).pathname
const hasLefthook = Bun.which('lefthook') !== null

describe('lefthook/site.yml', () => {
    test.skipIf(!hasLefthook)('is a valid lefthook config', async () => {
        const proc = Bun.spawn(['lefthook', 'validate'], {
            env: { ...process.env, LEFTHOOK_CONFIG: config },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const code = await proc.exited
        expect(code).toBe(0)
    })

    test('exists', () => {
        expect(existsSync(config)).toBe(true)
    })

    test('defines the three hooks every site gets', async () => {
        const text = await Bun.file(config).text()
        for (const hook of ['pre-commit:', 'commit-msg:', 'pre-push:']) {
            expect(text).toContain(`\n${hook}`)
        }
    })
    test('pre-commit unit step prefers test:unit:precommit when a site defines it', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('grep -q \'"test:unit:precommit"\' package.json')
        expect(text).toContain('{pm} run test:unit:precommit')
        expect(text).toContain('{pm} run --if-present test:unit')
    })

    test('picks the package manager from the lockfile instead of hardcoding bun', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('pnpm-lock.yaml ]; then echo pnpm; else echo bun')
        expect(text).not.toMatch(/\bbun run\b/)
    })
})
