import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addToFleet } from '../scripts/init/fleet.ts'
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
        await main(argv, 'voidflow init', {
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
]

describe('voidflow init', () => {
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
        expect(r.out).toContain("'o/r': {},")
        expect(r.out).toContain('--config')
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
        expect(r.code).toBe(0)
        expect(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')).toContain(
            '/.github/ @OWNER\n',
        )
        expect(r.out).toContain('o is an organization')
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

    test('CODEOWNERS uses a placeholder and says so without a repo', async () => {
        const dir = repo(null)
        const r = await run(['--kind', 'tool', '--preset', 'codeowners', dir])
        expect(r.code).toBe(0)
        expect(readFileSync(join(dir, '.github/CODEOWNERS'), 'utf8')).toContain(
            '@OWNER',
        )
        expect(r.out).toContain('pass --owner @handle')
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
        expect(r.out).toContain("': {},")
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

describe('voidflow init --config', () => {
    const SRC = `// fleet\nexport const REPOS = {\n    'a/b': {\n        retire: ['x'], // }\n    },\n    // trailing\n}\n`
    const S = ['--preset', 'settings']

    function cfg(text: string): string {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-fleet-'))
        roots.push(dir)
        const p = join(dir, 'rulesets.ts')
        writeFileSync(p, text)
        return p
    }

    test('adds the repo to REPOS, once', async () => {
        const p = cfg(SRC)
        const r = await run([...S, '--config', p, repo()])
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/added\s+rulesets\s+o\/r/)
        const text = readFileSync(p, 'utf8')
        expect(text).toContain("    // trailing\n    'o/r': {},\n}")
        expect(r.out).not.toContain('by hand')
        const again = await run([...S, '--config', p, repo()])
        expect(again.out).toMatch(/unchanged\s+rulesets/)
        expect(readFileSync(p, 'utf8')).toBe(text)
    })

    test('adds a missing comma and fills an empty object', async () => {
        const a = cfg("export const REPOS = {\n    'a/b': {}\n}\n")
        await run([...S, '--config', a, repo()])
        expect(readFileSync(a, 'utf8')).toBe(
            "export const REPOS = {\n    'a/b': {},\n    'o/r': {},\n}\n",
        )
        const b = cfg('export default {}\n')
        await run([...S, '--config', b, repo()])
        expect(readFileSync(b, 'utf8')).toBe(
            "export default {\n    'o/r': {},\n}\n",
        )
    })

    test('--dry-run writes nothing; an unparseable config fails', async () => {
        const p = cfg(SRC)
        const d = await run([...S, '--dry-run', '--config', p, repo()])
        expect(d.out).toMatch(/added\s+rulesets/)
        expect(readFileSync(p, 'utf8')).toBe(SRC)
        const r = await run([...S, '--config', cfg('const x = 1\n'), repo()])
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/failed\s+rulesets/)
    })

    test('a config path that cannot be read is a failed row, and the rest still prints', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-fleet-'))
        roots.push(dir)
        const r = await run([...S, '--config', dir, repo()])
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/failed\s+rulesets/)
        expect(r.out).toContain('fleet:')
        // Not "done": the next steps still tell the user to add the entry.
        expect(r.out).toContain('by hand')
    })
})

describe('addToFleet', () => {
    const added = (text: string) => {
        const r = addToFleet(text, 'o/r')
        if (r.status !== 'added') throw new Error(`expected added: ${r.status}`)
        return r.text
    }

    test('ignores an export written in a comment or a string', () => {
        const text =
            '/* old:\nexport default {}\n*/\n// export const REPOS = {\nconst s = "export default {"\nexport const REPOS = {\n    "a/b": {},\n}\n'
        expect(added(text)).toBe(
            text.replace('"a/b": {},\n}', `"a/b": {},\n    'o/r': {},\n}`),
        )
        expect(addToFleet('/* export default {} */\n', 'o/r').status).toBe(
            'failed',
        )
    })

    test('finds an existing key wherever it sits, not in comments or nested values', () => {
        const key = (text: string) => addToFleet(text, 'o/r').status
        // On the opening line, and after another entry on a line.
        expect(key("export default { 'o/r': {} }\n")).toBe('unchanged')
        expect(key("export default {\n 'a/b': {}, 'o/r': {},\n}\n")).toBe(
            'unchanged',
        )
        // A key inside a block comment, or in a nested value, is not an entry.
        expect(key("export default {\n/*\n 'o/r': {},\n*/\n}\n")).toBe('added')
        expect(
            key("export default {\n 'a/b': { aka: { 'o/r': 'x' } },\n}\n"),
        ).toBe('added')
    })

    test('puts a missing comma before an inline comment', () => {
        expect(added("export default {\n    'a/b': {} // keep\n}\n")).toBe(
            "export default {\n    'a/b': {}, // keep\n    'o/r': {},\n}\n",
        )
        expect(added("export default {\n    'a/b': {} /* keep */\n}\n")).toBe(
            "export default {\n    'a/b': {}, /* keep */\n    'o/r': {},\n}\n",
        )
    })
})
