import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = new URL('../lefthook/base.yml', import.meta.url).pathname
const hasLefthook = Bun.which('lefthook') !== null
// Git exports GIT_DIR, GIT_INDEX_FILE and friends to hooks. Under pre-push
// they would point this test's git and lefthook calls at the invoking repo.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

const runPreCommit = async (withDeps: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'lefthook-deps-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { format: 'echo FORMAT-RAN' } }))
    if (withDeps) mkdirSync(join(dir, 'node_modules'))
    for (const args of [['init', '-q'], ['add', '.']]) {
        await Bun.spawn(['git', ...args], { cwd: dir, env }).exited
    }
    const proc = Bun.spawn(['lefthook', 'run', 'pre-commit', '--force'], {
        cwd: dir,
        env: { ...env, LEFTHOOK_CONFIG: config },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { output: out + err, code }
}

describe('lefthook/base.yml pre-commit without node_modules', () => {
    test.skipIf(!hasLefthook)('fails on the deps message and runs no later step', async () => {
        const { output, code } = await runPreCommit(false)
        expect(code).not.toBe(0)
        expect(output).toContain("'node_modules' is missing")
        expect(output).not.toContain('FORMAT-RAN')
    })

    test.skipIf(!hasLefthook)('runs the later steps once node_modules exists', async () => {
        const { output } = await runPreCommit(true)
        expect(output).not.toContain("'node_modules' is missing")
        expect(output).toContain('FORMAT-RAN')
    })
})
