import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Gh } from '../scripts/init/gh.ts'
import { main, PRESETS } from '../scripts/init.ts'

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

/** A stateful fake: everything starts off, writes turn it on. */
function fakeGh(opts: { unavailable?: string } = {}) {
    let on = false
    const writes: string[] = []
    const gh: Gh = {
        available: async () => opts.unavailable ?? null,
        async rest(method, path) {
            if (method !== 'GET') {
                writes.push(`${method} ${path}`)
                on = true
                return { status: 204, body: null }
            }
            const p = path.replace(/^repos\/o\/r/, '')
            switch (p) {
                case '/vulnerability-alerts':
                    return { status: on ? 204 : 404, body: null }
                case '/automated-security-fixes':
                    return { status: 200, body: { enabled: on, paused: false } }
                case '': {
                    const status = on ? 'enabled' : 'disabled'
                    return {
                        status: 200,
                        body: {
                            security_and_analysis: {
                                secret_scanning: { status },
                                secret_scanning_push_protection: { status },
                            },
                        },
                    }
                }
                case '/code-scanning/default-setup':
                    return { status: 200, body: { state: on ? 'configured' : 'not-configured' } }
                case '/private-vulnerability-reporting':
                    return { status: 200, body: { enabled: on } }
            }
            return { status: 404, body: { message: 'Not Found' } }
        },
        async graphql(query) {
            if (query.startsWith('mutation')) {
                writes.push('mutation')
                on = true
                return { updateRepository: {} }
            }
            const v = on ? 'COLLABORATORS_ONLY' : 'ALL'
            return {
                repository: {
                    id: 'R_1',
                    visibility: 'PUBLIC',
                    pullRequestCreationPolicy: v,
                    issueCreationPolicy: v,
                },
            }
        },
    }
    return { gh, writes }
}

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function repo(origin: string | null = 'https://github.com/o/r.git'): string {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-init-'))
    roots.push(dir)
    Bun.spawnSync(['git', 'init', '-q', dir])
    if (origin) Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', origin])
    return dir
}

async function run(argv: string[], gh: Gh = fakeGh().gh) {
    const out: string[] = []
    const err: string[] = []
    const log = spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
    const error = spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
    const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
        throw new Exit(c ?? 0)
    }) as never)
    let code = -1
    try {
        await main(argv, 'voidflow init', { gh, resolveSha: async () => 'deadbeef' })
    } catch (e) {
        if (!(e instanceof Exit)) throw e
        code = e.code
    } finally {
        log.mockRestore()
        error.mockRestore()
        exit.mockRestore()
    }
    return { code, out: out.join('\n'), err: err.join('\n') }
}

const TOOL_FILES = [
    'lefthook.yml',
    'mise.toml',
    'renovate.json',
    'bunfig.toml',
    'biome.json',
    '.gitignore',
    '.github/workflows/ci.yml',
    'tsconfig.json',
    'package.json',
]

describe('voidflow init', () => {
    test('full run on an empty repo exits 0 and writes the tool files', async () => {
        const dir = repo()
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(0)
        for (const f of TOOL_FILES) expect(existsSync(join(dir, f))).toBe(true)
        expect(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')).toContain('@deadbeef # v')
        expect(r.out).toContain('create')
        expect(r.out).toContain('applied')
        expect(r.out).toContain('https://github.com/o/r/settings/security_analysis')
        expect(r.out).toContain("'o/r': tool()")
    })

    test('a conflict exits 1, writes no files, and still applies settings', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        const f = fakeGh()
        const r = await run(['--kind', 'tool', dir], f.gh)
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/conflict\s+mise/)
        expect(r.out).toContain('--force')
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false)
        expect(readFileSync(join(dir, 'mise.toml'), 'utf8')).toBe('[tools]\n')
        expect(f.writes.length).toBeGreaterThan(0)
    })

    test('--force overwrites a conflicting file', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        const r = await run(['--kind', 'tool', '--force', dir])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/overwrite\s+mise/)
        expect(readFileSync(join(dir, 'mise.toml'), 'utf8')).toContain('lefthook')
    })

    test('--preset settings needs no --kind and writes no files', async () => {
        const dir = repo()
        const r = await run(['--preset', 'settings', dir])
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false)
        expect(r.out).toContain('applied')
        expect(r.out).not.toContain('files:')
    })

    test('--preset files without --kind exits 2', async () => {
        const r = await run(['--preset', 'files', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('needs --kind')
    })

    test('an unknown --preset or --kind exits 2', async () => {
        expect((await run(['--kind', 'tool', '--preset', 'nope', repo()])).code).toBe(2)
        expect((await run(['--kind', 'nope', repo()])).code).toBe(2)
    })

    test('presets come from PRESETS', async () => {
        const r = await run(['--help'])
        expect(r.code).toBe(0)
        expect(r.out).toContain(Object.keys(PRESETS).join('|'))
    })

    test('--skip-file nope exits 2 listing the valid names', async () => {
        const r = await run(['--kind', 'tool', '--skip-file', 'nope', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('unknown --skip-file "nope"')
        expect(r.err).toContain('lefthook, mise')
        expect(r.err).not.toMatch(/expected one of:[^\n]*playwright/)
    })

    test('--skip-setting nope exits 2 listing the valid names', async () => {
        const r = await run(['--preset', 'settings', '--skip-setting', 'nope', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('pr-policy, issue-policy')
    })

    test('--skip-file and --skip-setting leave items out', async () => {
        const dir = repo()
        const f = fakeGh()
        const r = await run(['--kind', 'tool', '--skip-file', 'ci', '--skip-setting', 'codeql', dir], f.gh)
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(false)
        expect(f.writes.some((w) => w.includes('default-setup'))).toBe(false)
    })

    test('a dir that is not a git work tree exits 2', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-init-'))
        roots.push(dir)
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(2)
        expect(r.err).toContain('not a git work tree')
    })

    test('--enable-pvr notes the half that did not run', async () => {
        const s = await run(['--preset', 'settings', '--enable-pvr', repo()])
        expect(s.code).toBe(0)
        expect(s.out).toContain('SECURITY.md was not written')
        const dir = repo()
        const f = await run(['--kind', 'tool', '--preset', 'files', '--enable-pvr', dir])
        expect(f.code).toBe(0)
        expect(f.out).toContain('private vulnerability reporting was not enabled')
        expect(readFileSync(join(dir, 'SECURITY.md'), 'utf8')).toContain('o/r/security/advisories/new')
    })

    test('without an origin remote, files are written and the settings half fails', async () => {
        const dir = repo(null)
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(1)
        expect(r.out).toContain('--repo')
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true)
    })

    test('--repo overrides the origin remote', async () => {
        const r = await run(['--preset', 'settings', '--repo', 'o/r', repo(null)])
        expect(r.code).toBe(0)
        expect(r.out).toContain('applied')
    })

    test('gh unauthenticated with --dry-run exits 0 and reports settings unavailable', async () => {
        const dir = repo()
        const f = fakeGh({ unavailable: 'gh is not authenticated (run gh auth login)' })
        const r = await run(['--kind', 'tool', '--dry-run', dir], f.gh)
        expect(r.code).toBe(0)
        expect(r.out).toContain('unavailable')
        expect(r.out).toContain('gh auth login')
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false)
    })

    test('--dry-run changes nothing', async () => {
        const dir = repo()
        const f = fakeGh()
        const r = await run(['--kind', 'site', '--dry-run', dir], f.gh)
        expect(r.code).toBe(0)
        expect(r.out).toContain('would-apply')
        expect(r.out).toMatch(/create\s+playwright/)
        expect(f.writes).toEqual([])
        expect(existsSync(join(dir, 'playwright.config.js'))).toBe(false)
    })

    test('a re-run is all unchanged and keeps the cron minute', async () => {
        const dir = repo()
        const f = fakeGh()
        expect((await run(['--kind', 'site', dir], f.gh)).code).toBe(0)
        const ci = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')
        const r = await run(['--kind', 'site', dir], f.gh)
        expect(r.code).toBe(0)
        expect(r.out).not.toMatch(/^\s+(create|applied|merge|overwrite)\s/m)
        expect(r.out).toMatch(/unchanged\s+ci/)
        expect(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')).toBe(ci)
    })
})
