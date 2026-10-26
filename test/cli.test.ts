import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
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

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

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

    test('a flag before the command says the command comes first', async () => {
        const r = await voidflow(['--config', 'rulesets.ts', 'rulesets'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('the command comes before its flags, got "--config"')
    })

    test('hands the remaining flags to the script', async () => {
        for (const c of ['rulesets', 'cf-tokens']) {
            const r = await voidflow([c])
            expect(r.code).toBe(2)
            expect(r.err).toContain('needs --config')
        }
    })

    test("a command's --help lists its flags, without needing --config", async () => {
        for (const [c, flag] of [
            ['rulesets', '--prune'],
            ['cf-tokens', '--try <env>'],
        ]) {
            for (const h of ['--help', '-h']) {
                const r = await voidflow([c, h])
                expect(r.code).toBe(0)
                expect(r.out).toContain(`usage: voidflow ${c} --config <module>`)
                expect(r.out).toContain(flag)
            }
        }
    })

    test('an unknown flag prints usage, not a stack trace', async () => {
        const r = await voidflow(['rulesets', '--nope'])
        expect(r.code).toBe(2)
        expect(r.err).toContain("Unknown option '--nope'")
        expect(r.err).toContain('usage: voidflow rulesets')
        expect(r.err).not.toContain('    at ')
    })

    test('a relative --config resolves from the current directory', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-cli-'))
        roots.push(dir)
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
    // npm packs package.json whatever `files` says.
    const shipped = (file: string) =>
        file === 'package.json' ||
        (pkg.files as string[]).some(
            (f) => file === f || file.startsWith(`${f}/`),
        )
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    // devDependencies don't install with the package, so a bare import must
    // be a builtin, a dependency or a peer.
    const installed = (spec: string) => {
        if (/^(node|bun):/.test(spec) || builtinModules.includes(spec)) return true
        const parts = spec.split('/')
        const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        return name in { ...pkg.dependencies, ...pkg.peerDependencies }
    }

    // Every file a module reaches through its static and dynamic imports, as
    // Bun resolves them, the module included. Comments and type-only imports
    // don't count: neither is loaded at run time.
    function reach(file: string, seen = new Set<string>()): Set<string> {
        if (seen.has(file)) return seen
        seen.add(file)
        // Only code imports anything; .json and .d.ts files are leaves.
        if (!/\.[cm]?[jt]s$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return seen
        const src = readFileSync(file, 'utf8').replace(/^#!.*/, '')
        for (const { path } of transpiler.scanImports(src)) {
            if (path.startsWith('.')) {
                reach(Bun.resolveSync(path, dirname(file)), seen)
            } else {
                const from = relative(ROOT, file)
                expect({ from, path, installed: installed(path) }).toEqual({
                    from,
                    path,
                    installed: true,
                })
            }
        }
        return seen
    }

    const entries = (): string[] => [
        ...Object.values(pkg.bin as Record<string, string>),
        ...Object.values(pkg.exports as Record<string, string | Record<string, string>>).flatMap(
            (e) => (typeof e === 'string' ? [e] : Object.values(e)),
        ),
    ]

    test('every bin and export ships with everything it imports', () => {
        for (const entry of entries()) {
            for (const f of reach(join(ROOT, entry))) {
                const file = relative(ROOT, f)
                expect({ entry, file, shipped: shipped(file) }).toEqual({
                    entry,
                    file,
                    shipped: true,
                })
            }
        }
    })

    test('the fleet config modules are exported', async () => {
        const rulesets = await import('@taraxvoid/voidflow/rulesets')
        const cloudflare = await import('@taraxvoid/voidflow/cloudflare')
        expect(typeof rulesets.tool).toBe('function')
        expect(typeof cloudflare.checkRepos).toBe('function')
    })
})
