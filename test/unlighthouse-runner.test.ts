import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runner = new URL('../scripts/unlighthouse/run.ts', import.meta.url)
    .pathname

async function run(cwd: string, ...args: string[]) {
    const proc = Bun.spawn(['bun', runner, ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { stderr, code }
}

describe('unlighthouse-runner argument checks', () => {
    test('exits 2 when the build directory is missing', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'voidflow-'))
        const { code, stderr } = await run(cwd)
        expect(code).toBe(2)
        expect(stderr).toContain('dist directory not found')
    })

    test('exits 2 when the config file is missing', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'voidflow-'))
        writeFileSync(join(cwd, 'index.html'), '')
        const { code, stderr } = await run(cwd, '--dir', '.')
        expect(code).toBe(2)
        expect(stderr).toContain('unlighthouse config not found')
    })
})
