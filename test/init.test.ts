import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Gh } from '../scripts/init/gh.ts'
import { main, PRESETS } from '../scripts/init.ts'

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

/** A stateful fake: everything starts off, writes turn it on. */
function fakeGh(
    opts: {
        unavailable?: string
        planGated?: boolean
        ownerType?: string
    } = {},
) {
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
                    return {
                        status: 200,
                        body: { state: on ? 'configured' : 'not-configured' },
                    }
                case 'users/o':
                    return {
                        status: 200,
                        body: { type: opts.ownerType ?? 'User' },
                    }
                case '/rulesets':
                    return opts.planGated
                        ? {
                              status: 403,
                              body: {
                                  message:
                                      'Upgrade to GitHub Pro or make this repository public to enable this feature.',
                              },
                          }
                        : { status: 200, body: [] }
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
                    viewerPermission: 'ADMIN',
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
    if (origin)
        Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', origin])
    return dir
}

/**
 * Tests were written when init applied by default. `--dry-run` marks a plan-only
 * run (the default now); anything else gets `--apply`.
 */
const asArgv = (argv: string[]) =>
    argv.includes('--dry-run')
        ? argv.filter((a) => a !== '--dry-run')
        : [...argv, '--apply']

async function run(argv: string[], gh: Gh = fakeGh().gh) {
    const out: string[] = []
    const err: string[] = []
    const log = spyOn(console, 'log').mockImplementation(
        (...a) => void out.push(a.join(' ')),
    )
    const error = spyOn(console, 'error').mockImplementation(
        (...a) => void err.push(a.join(' ')),
    )
    const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
        throw new Exit(c ?? 0)
    }) as never)
    let code = -1
    try {
        await main(asArgv(argv), 'voidflow init', {
            gh,
            resolveSha: async () => 'deadbeef',
        })
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
    'voidflow.config.ts',
]

describe('voidflow init', () => {
    test('without --apply it plans and writes nothing', async () => {
        const dir = repo()
        const r = await run(['--kind', 'tool', '--dry-run', dir])
        expect(r.code).toBe(0)
        expect(r.out).toContain('plan only: re-run with --apply')
        expect(existsSync(join(dir, 'mise.toml'))).toBe(false)
    })

    test('--force without --apply is a usage error', async () => {
        const r = await run(['--kind', 'tool', '--force', '--dry-run', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--force needs --apply')
    })

    test('full run on an empty repo exits 0 and writes the tool files', async () => {
        const dir = repo()
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(0)
        for (const f of TOOL_FILES) expect(existsSync(join(dir, f))).toBe(true)
        expect(
            readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'),
        ).toContain('@deadbeef # v')
        expect(r.out).toContain('create')
        expect(r.out).toContain('applied')
        expect(r.out).toContain(
            'https://github.com/o/r/settings/security_analysis',
        )
        expect(r.out).toContain('    voidflow plan\n')
        expect(r.out).toContain('voidflow apply rulesets')
        expect(r.out).not.toContain("'o/r': {},")
    })

    test('a customized config survives a re-run', async () => {
        const dir = repo()
        const mine =
            "export default { kind: 'tool', rulesets: { checks: [] } }\n"
        writeFileSync(join(dir, 'voidflow.config.ts'), mine)
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(0)
        expect(readFileSync(join(dir, 'voidflow.config.ts'), 'utf8')).toBe(mine)
        expect(r.out).toContain('repo-owned')
    })

    test('a fresh config records the opt-in flags as settings', async () => {
        const dir = repo()
        await run(['--kind', 'tool', '--enable-pvr', '--skip', 'codeql', dir])
        const text = readFileSync(join(dir, 'voidflow.config.ts'), 'utf8')
        expect(text).toContain(
            "export default {\n    kind: 'tool',\n    settings: { enable: ['pvr'], skip: ['codeql'] },\n} satisfies VoidflowConfig\n",
        )
    })

    test('flags add their settings to a config init wrote, keeping its data', async () => {
        const dir = repo()
        const file = join(dir, 'voidflow.config.ts')
        // A file exactly as init writes it for this data.
        await run(['--kind', 'tool', '--preset', 'files', dir])
        const plan = await run([
            '--preset',
            'settings',
            '--kind',
            'tool',
            '--enable-pvr',
            '--dry-run',
            dir,
        ])
        // The settings preset writes no files, so the line to add is a note.
        expect(plan.out).toContain(
            "add 'pvr' to settings.enable in voidflow.config.ts so voidflow check covers it",
        )
        const r = await run(['--kind', 'tool', '--enable-pvr', dir])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/merge\s+config\s+.*settings\.enable \+ pvr/)
        expect(r.out).not.toContain("add 'pvr'")
        const { default: cfg } = await import(`${file}?v=1`)
        expect(cfg).toEqual({ kind: 'tool', settings: { enable: ['pvr'] } })
        // Same settings again: the file is left alone.
        const again = await run(['--kind', 'tool', '--enable-pvr', dir])
        expect(again.out).toMatch(/unchanged\s+config/)
    })

    test('a config edited by hand is never rewritten; the settings to add are notes', async () => {
        const dir = repo()
        const file = join(dir, 'voidflow.config.ts')
        const mine =
            "// mine: CI job names\nexport default { kind: 'tool', rulesets: { checks: ['ci'] } }\n"
        writeFileSync(file, mine)
        const r = await run(['--kind', 'tool', '--enable-pvr', dir])
        expect(r.code).toBe(0)
        expect(readFileSync(file, 'utf8')).toBe(mine)
        expect(r.out).toMatch(/unchanged\s+config\s+.*edited by hand, kept/)
        expect(r.out).toContain(
            "add 'pvr' to settings.enable in voidflow.config.ts so voidflow check covers it",
        )
        // --force still overwrites, on request.
        const forced = await run([
            '--kind',
            'tool',
            '--enable-pvr',
            '--force',
            dir,
        ])
        expect(forced.out).toMatch(/overwrite\s+config/)
        expect(readFileSync(file, 'utf8')).not.toContain('// mine')
    })

    test('the file settings run in the settings half without flags', async () => {
        const dir = repo()
        writeFileSync(
            join(dir, 'voidflow.config.ts'),
            "export default { kind: 'tool', settings: { enable: ['pvr'], skip: ['codeql'] } }\n",
        )
        const r = await run(['--preset', 'settings', '--dry-run', dir])
        expect(r.out).toMatch(/would-apply\s+pvr/)
        expect(r.out).not.toMatch(/\bcodeql\b/)
    })

    test('an invalid existing config exits 2 naming the file', async () => {
        const dir = repo()
        writeFileSync(
            join(dir, 'voidflow.config.ts'),
            "export default { kind: 'tool', settings: { enable: ['nope'] } }\n",
        )
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(2)
        expect(r.err).toContain('voidflow.config.ts')
        expect(r.err).toContain('settings.enable: unknown group "nope"')
    })

    test('without the config item, next steps say to write one', async () => {
        const r = await run(['--kind', 'tool', '--skip', 'config', repo()])
        expect(r.out).toContain('write a voidflow.config.ts')
        expect(r.out).not.toContain('    voidflow plan\n')
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

    test('a conflict that blocks the config write prints the settings to add', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        writeFileSync(
            join(dir, 'voidflow.config.ts'),
            "export default { kind: 'tool' }\n",
        )
        const r = await run(['--kind', 'tool', '--enable-pvr', dir])
        expect(r.code).toBe(1)
        expect(r.out).toContain(
            "add 'pvr' to settings.enable in voidflow.config.ts so voidflow check covers it",
        )
    })

    test('a refusal leads the output and no row claims a change was made', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        const r = await run(['--kind', 'tool', dir])
        expect(r.out.startsWith('refused: nothing was written, 1 ')).toBe(true)
        expect(r.out).toContain('files (nothing written):')
        expect(r.out).toMatch(/would create\s+bunfig/)
        expect(r.out).not.toMatch(/^ {2}create\s/m)
        expect(r.out).not.toContain('\x1b[')
    })

    test('FORCE_COLOR colors statuses and --no-color wins', async () => {
        const prev = process.env.FORCE_COLOR
        process.env.FORCE_COLOR = '1'
        try {
            const on = await run(['--kind', 'tool', '--dry-run', repo()])
            expect(on.out).toContain('\x1b[32mwould create')
            const off = await run([
                '--kind',
                'tool',
                '--dry-run',
                '--no-color',
                repo(),
            ])
            expect(off.out).not.toContain('\x1b[')
        } finally {
            if (prev === undefined) delete process.env.FORCE_COLOR
            else process.env.FORCE_COLOR = prev
        }
    })

    test('--force overwrites a conflicting file', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        const r = await run(['--kind', 'tool', '--force', dir])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/overwrite\s+mise/)
        expect(readFileSync(join(dir, 'mise.toml'), 'utf8')).toContain(
            'lefthook',
        )
    })

    test('--preset settings needs no --kind and writes no files', async () => {
        const dir = repo()
        const r = await run(['--preset', 'settings', dir])
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false)
        expect(r.out).toContain('applied')
        expect(r.out).not.toContain('files:')
    })

    test('--preset ci writes only ci.yml and touches no settings', async () => {
        const dir = repo()
        const f = fakeGh()
        const r = await run(['--kind', 'tool', '--preset', 'ci', dir], f.gh)
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(true)
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(false)
        expect(existsSync(join(dir, 'mise.toml'))).toBe(false)
        expect(r.out).not.toContain('settings')
        expect(f.writes.length).toBe(0)
    })

    test('--preset codeowners writes only CODEOWNERS owned by the repo owner', async () => {
        const dir = repo()
        const f = fakeGh()
        const r = await run(
            ['--kind', 'tool', '--preset', 'codeowners', dir],
            f.gh,
        )
        expect(r.code).toBe(0)
        const text = readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')
        expect(text).toContain('/.github/ @o\n')
        expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(false)
        expect(r.out).not.toContain('not enforced')
        expect(r.out).not.toContain('placeholder')
        expect(f.writes.length).toBe(0)
    })

    test('an organization repo owner is not used as a code owner', async () => {
        const dir = repo()
        const r = await run(
            ['--kind', 'tool', '--preset', 'codeowners', dir],
            fakeGh({ ownerType: 'Organization' }).gh,
        )
        expect(r.code).toBe(2)
        expect(existsSync(join(dir, '.github/CODEOWNERS'))).toBe(false)
        expect(r.err).toContain('o is an organization')
        expect(r.err).toContain('pass --owner')
        const ok = repo()
        const o = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'codeowners',
                '--owner',
                '@o/sec',
                ok,
            ],
            fakeGh({ ownerType: 'Organization' }).gh,
        )
        expect(o.out).not.toContain('is an organization')
        expect(readFileSync(join(ok, '.github/CODEOWNERS'), 'utf8')).toContain(
            '/.github/ @o/sec\n',
        )
    })

    test('an unknown owner type keeps @owner with a note', async () => {
        const dir = repo()
        const r = await run(
            ['--kind', 'tool', '--preset', 'codeowners', dir],
            fakeGh({ unavailable: 'no gh' }).gh,
        )
        expect(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')).toContain(
            '/.github/ @o\n',
        )
        expect(r.out).toContain('could not tell whether o is a user')
    })

    test('--owner rejects consecutive periods and bare orgs with dots', async () => {
        const r = await run([
            '--kind',
            'tool',
            '--preset',
            'codeowners',
            '--owner',
            '@a..b',
            repo(),
        ])
        expect(r.code).toBe(2)
    })

    test('--owner overrides the repo owner and is validated', async () => {
        const dir = repo()
        const r = await run([
            '--kind',
            'tool',
            '--preset',
            'codeowners',
            '--owner',
            '@o/sec',
            dir,
        ])
        expect(r.code).toBe(0)
        expect(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')).toContain(
            '/.github/ @o/sec\n',
        )
        const bad = await run([
            '--kind',
            'tool',
            '--preset',
            'codeowners',
            '--owner',
            'o',
            repo(),
        ])
        expect(bad.code).toBe(2)
        expect(bad.err).toContain('invalid --owner')
    })

    test('CODEOWNERS needs --owner without a repo, never an @OWNER placeholder', async () => {
        const dir = repo(null)
        const r = await run(['--kind', 'tool', '--preset', 'codeowners', dir])
        expect(r.code).toBe(2)
        expect(existsSync(join(dir, '.github/CODEOWNERS'))).toBe(false)
        expect(r.err).toContain('pass --owner')
    })

    test('a full run skips CODEOWNERS with a note when no owner resolves', async () => {
        const dir = repo(null)
        const r = await run([
            '--kind',
            'tool',
            '--preset',
            'files',
            '--apply',
            dir,
        ])
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, '.github/CODEOWNERS'))).toBe(false)
        expect(r.out).toContain('CODEOWNERS skipped')
    })

    test('CODEOWNERS notes when the plan cannot enforce it', async () => {
        const dir = repo()
        const r = await run(
            ['--kind', 'tool', '--preset', 'codeowners', dir],
            fakeGh({ planGated: true }).gh,
        )
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, '.github/CODEOWNERS'))).toBe(true)
        expect(r.out).toContain('CODEOWNERS is written but not enforced')
    })

    test('--preset ci without --kind exits 2', async () => {
        const r = await run(['--preset', 'ci', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('needs --kind')
    })

    test('--preset files without --kind exits 2', async () => {
        const r = await run(['--preset', 'files', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('needs --kind')
    })

    test('an unknown --preset or --kind exits 2', async () => {
        expect(
            (await run(['--kind', 'tool', '--preset', 'nope', repo()])).code,
        ).toBe(2)
        expect((await run(['--kind', 'nope', repo()])).code).toBe(2)
    })

    test('presets come from PRESETS', async () => {
        const r = await run(['--help'])
        expect(r.code).toBe(0)
        expect(r.out).toContain(Object.keys(PRESETS).join('|'))
    })

    test('--skip nope exits 2 listing the valid names', async () => {
        const r = await run(['--kind', 'tool', '--skip', 'nope', repo()])
        expect(r.code).toBe(2)
        expect(r.err).toContain('unknown --skip "nope"')
        expect(r.err).toContain('lefthook, mise')
        expect(r.err).toContain('pr-policy, issue-policy')
        expect(r.err).not.toMatch(/expected one of:[^\n]*playwright/)
    })

    test('--skip leaves files and settings out', async () => {
        const dir = repo()
        const f = fakeGh()
        const r = await run(
            ['--kind', 'tool', '--skip', 'ci', '--skip', 'codeql', dir],
            f.gh,
        )
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
        const f = await run([
            '--kind',
            'tool',
            '--preset',
            'files',
            '--enable-pvr',
            dir,
        ])
        expect(f.code).toBe(0)
        expect(f.out).toContain(
            'private vulnerability reporting was not enabled',
        )
        expect(readFileSync(join(dir, 'SECURITY.md'), 'utf8')).toContain(
            'o/r/security/advisories/new',
        )
    })

    test('without an origin remote, files are written and the settings half fails', async () => {
        const dir = repo(null)
        const r = await run(['--kind', 'tool', dir])
        expect(r.code).toBe(1)
        expect(r.out).toContain('--repo')
        expect(existsSync(join(dir, 'lefthook.yml'))).toBe(true)
    })

    test('--repo overrides the origin remote', async () => {
        const r = await run([
            '--preset',
            'settings',
            '--repo',
            'o/r',
            repo(null),
        ])
        expect(r.code).toBe(0)
        expect(r.out).toContain('applied')
    })

    test('gh unauthenticated with --dry-run exits 0 and reports settings unavailable', async () => {
        const dir = repo()
        const f = fakeGh({
            unavailable: 'gh is not authenticated (run gh auth login)',
        })
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

    test('an existing playwright.config.ts means no .js is written', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'playwright.config.ts'), 'export default {}\n')
        const r = await run(['--kind', 'site', '--preset', 'files', dir])
        expect(r.code).toBe(0)
        expect(existsSync(join(dir, 'playwright.config.js'))).toBe(false)
        expect(r.out).toContain('playwright.config.ts already exists')
        expect(r.out).toContain('    voidflow plan\n')
        expect(r.out).not.toContain('tool()')
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
        expect(
            readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'),
        ).toBe(ci)
    })
})
