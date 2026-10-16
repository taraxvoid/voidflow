import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

// Renovate bumps only `ref:` in consumers' lefthook.yml, and lefthook skips a
// missing remote config silently, so a bare rename would drop every hook.
// site.yml stays as a stub whose hooks fail with the fix instead.
const path = new URL('../lefthook/site.yml', import.meta.url).pathname
const hasLefthook = Bun.which('lefthook') !== null

describe('lefthook/site.yml tombstone', () => {
    test('still exists so old configs entries do not go silent', () => {
        expect(existsSync(path)).toBe(true)
    })

    test.skipIf(!hasLefthook)('is a valid lefthook config', async () => {
        const proc = Bun.spawn(['lefthook', 'validate'], {
            env: { ...process.env, LEFTHOOK_CONFIG: path },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        expect(await proc.exited).toBe(0)
    })

    test.each(['pre-commit', 'pre-push'])('%s fails and points at base.yml', async (hook) => {
        const cfg: any = Bun.YAML.parse(readFileSync(path, 'utf8'))
        const commands = Object.values(cfg[hook].commands) as Array<{ run: string }>
        expect(commands).toHaveLength(1)
        const proc = Bun.spawn(['sh', '-c', commands[0].run], { stdout: 'pipe', stderr: 'pipe' })
        expect(await proc.exited).toBe(1)
        expect(await new Response(proc.stderr).text()).toContain('lefthook/base.yml')
    })
})
