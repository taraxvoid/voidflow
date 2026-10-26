import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const CLI = join(ROOT, 'scripts/cli.ts')

async function voidflow(args: string[], cwd = ROOT) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
        cwd,
        env: { ...process.env, CF_TOKEN_ADMIN: '', VOIDFLOW_CONFIG_BASE: '' },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    return { code, out, err }
}

describe('voidflow bin', () => {
    test('without a command, prints usage and exits 2', async () => {
        const r = await voidflow([])
        expect(r.code).toBe(2)
        expect(r.out).toContain('cf-tokens')
        expect(r.out).toContain('rulesets')
    })

    test('--help exits 0', async () => {
        expect((await voidflow(['--help'])).code).toBe(0)
    })

    test('an unknown command exits 2', async () => {
        const r = await voidflow(['nope'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('unknown command "nope"')
    })

    test('hands the remaining flags to the script', async () => {
        for (const c of ['rulesets', 'cf-tokens']) {
            const r = await voidflow([c])
            expect(r.code).toBe(2)
            expect(r.err).toContain('needs --config')
        }
    })

    test('a relative --config resolves from the current directory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-cli-'))
        writeFileSync(
            join(dir, 'rulesets.ts'),
            "export const REPOS = { 'o/r': { tiers: ['nope'] } }",
        )
        const r = await voidflow(['rulesets', '--config', 'rulesets.ts'], dir)
        expect(r.code).toBe(2)
        expect(r.err).toContain(`${join(dir, 'rulesets.ts')}:`)
        expect(r.err).toContain('unknown tier "nope"')
    })
})

describe('package files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const shipped = (file: string) =>
        (pkg.files as string[]).some(
            (f) => file === f || file.startsWith(`${f}/`),
        )

    // Every file a bin reaches through relative imports, the bin included.
    function reach(file: string, seen = new Set<string>()): Set<string> {
        if (seen.has(file)) return seen
        seen.add(file)
        const src = readFileSync(file, 'utf8')
        // Any quoted relative .ts path, so cli.ts's dispatch table counts too.
        for (const m of src.matchAll(/['"](\.{1,2}\/[^'"\s]+\.ts)['"]/g)) {
            reach(resolve(dirname(file), m[1]), seen)
        }
        return seen
    }

    test('every bin ships with everything it imports', () => {
        for (const bin of Object.values(pkg.bin as Record<string, string>)) {
            for (const f of reach(join(ROOT, bin))) {
                expect({
                    bin,
                    file: relative(ROOT, f),
                    shipped: shipped(relative(ROOT, f)),
                }).toEqual({
                    bin,
                    file: relative(ROOT, f),
                    shipped: true,
                })
            }
        }
    })
})
