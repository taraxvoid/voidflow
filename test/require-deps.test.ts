import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDeps, depsMessage } from './require-deps'

const repo = join(import.meta.dir, '..')

describe('require-deps preload', () => {
    test('checkDeps flags a root without node_modules', () => {
        const root = mkdtempSync(join(tmpdir(), 'voidflow-deps-'))
        expect(checkDeps(root)).toBe(depsMessage)
        mkdirSync(join(root, 'node_modules'))
        expect(checkDeps(root)).toBeNull()
    })

    test('bun test exits non-zero with the message when node_modules is missing', async () => {
        // A copy with the bunfig and preload but no node_modules, running a
        // trivial test file so only the preload can make it fail.
        const root = mkdtempSync(join(tmpdir(), 'voidflow-deps-'))
        cpSync(join(repo, 'bunfig.toml'), join(root, 'bunfig.toml'))
        mkdirSync(join(root, 'test'))
        cpSync(
            join(repo, 'test/require-deps.ts'),
            join(root, 'test/require-deps.ts'),
        )
        await Bun.write(
            join(root, 'test/noop.test.ts'),
            "import { test } from 'bun:test'\ntest('noop', () => {})\n",
        )
        const proc = Bun.spawn(['bun', 'test'], {
            cwd: root,
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        expect(code).not.toBe(0)
        expect(out + err).toContain("'node_modules' is missing")
    })
})
