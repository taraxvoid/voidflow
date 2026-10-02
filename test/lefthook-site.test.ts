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
})
