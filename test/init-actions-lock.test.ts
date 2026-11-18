import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    credentialNotes,
    lockScope,
    relockCredentials,
    runActionsLock,
    scopeLockWorkflow,
} from '../scripts/init/actions-lock.ts'
import { planFiles } from '../scripts/init/files.ts'
import type { Gh, GhResult } from '../scripts/init/gh.ts'
import type { RenderCtx } from '../scripts/init/render.ts'
import { main } from '../scripts/init.ts'

const ROOT = join(import.meta.dir, '..')
const template = (name: string) =>
    readFileSync(join(ROOT, 'templates/common', name), 'utf8')

type Step = { name?: string; run?: string; uses?: string }
type Workflow = { jobs: Record<string, { steps: Step[] }> }
const parse = (text: string) => Bun.YAML.parse(text) as Workflow

let dir: string
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-actions-lock-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function workflows(...names: string[]) {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true })
    for (const n of names)
        writeFileSync(join(dir, '.github/workflows', n), 'name: x\n')
}

describe('lockScope', () => {
    test('no gh-aw workflows: a full-directory run', () => {
        workflows('ci.yml', 'release.yaml')
        expect(lockScope(dir, ['.github/workflows/ci.yml'], false)).toEqual({
            paths: null,
            skipped: [],
        })
    })

    test('no workflows dir at all: a full-directory run', () => {
        expect(lockScope(dir, [], false).paths).toBeNull()
    })

    test('a gh-aw lock file scopes to every other workflow, planned ones included', () => {
        workflows('ci.yml', 'deps-review.lock.yml', 'release.yaml')
        writeFileSync(join(dir, '.github/workflows/deps-review.md'), '# x\n')
        writeFileSync(join(dir, '.github/workflows/actions.lock'), '')
        expect(
            lockScope(
                dir,
                [
                    '.github/workflows/verify-lockfile.yml',
                    '.github/workflows/ci.yml',
                    'lefthook.yml',
                ],
                false,
            ),
        ).toEqual({
            paths: [
                '.github/workflows/ci.yml',
                '.github/workflows/release.yaml',
                '.github/workflows/verify-lockfile.yml',
            ],
            skipped: [],
        })
    })

    test('--enable-agentic scopes before gh aw add writes its lock file', () => {
        expect(
            lockScope(dir, ['.github/workflows/agentic.yml'], true).paths,
        ).toEqual(['.github/workflows/agentic.yml'])
    })

    test('names that are not plain are skipped, not quoted', () => {
        workflows('ci.yml', 'my flow.yml', 'x.lock.yml')
        expect(lockScope(dir, [], false)).toEqual({
            paths: ['.github/workflows/ci.yml'],
            skipped: ['my flow.yml'],
        })
    })
})

describe('scopeLockWorkflow', () => {
    const paths = ['.github/workflows/a.yml', '.github/workflows/b.yml']

    test('null paths leave both templates as they are', () => {
        for (const [item, file] of [
            ['actions-lock', 'verify-lockfile.yml'],
            ['actions-relock', 'relock-actions.yml'],
        ] as const) {
            const t = template(file)
            expect(scopeLockWorkflow(item, t, null)).toBe(t)
        }
    })

    test('verify runs on the listed workflows only', () => {
        const out = scopeLockWorkflow(
            'actions-lock',
            template('verify-lockfile.yml'),
            paths,
        )
        const steps = parse(out).jobs.verify?.steps ?? []
        expect(steps.at(-1)?.run).toBe(
            'gh actions-lock --verify \\\n  .github/workflows/a.yml \\\n  .github/workflows/b.yml\n',
        )
        expect(out).toContain('gh-aw compiled *.lock.yml')
    })

    test('relock locks and commits the listed workflows and actions.lock only', () => {
        const out = scopeLockWorkflow(
            'actions-relock',
            template('relock-actions.yml'),
            paths,
        )
        const steps = parse(out).jobs.relock?.steps ?? []
        const relock = steps.find((s) => s.name === 'Relock')
        expect(relock?.run).toBe(
            'gh actions-lock \\\n  .github/workflows/a.yml \\\n  .github/workflows/b.yml\n',
        )
        const push = steps.find((s) => s.name === 'Commit and push')?.run
        expect(push).toContain(
            'git add \\\n  .github/workflows/actions.lock \\\n  .github/workflows/a.yml \\\n  .github/workflows/b.yml\n',
        )
        expect(push).not.toMatch(/git add \.github\/workflows$/m)
    })

    test('a template without the expected line throws', () => {
        expect(() =>
            scopeLockWorkflow('actions-lock', 'name: x\n', paths),
        ).toThrow(/expected one/)
    })
})

describe('templates', () => {
    test('relock keeps the safety rules and runs nothing from the PR', () => {
        const t = template('relock-actions.yml')
        expect(t).toContain('Never run `gh actions-lock --accept-moved`')
        expect(t).not.toMatch(/^\s*(-\s*)?run:.*--accept-moved/m)
        expect(t).toContain('persist-credentials: false')
        expect(t).toContain(
            "github.event.pull_request.user.login == 'renovate[bot]'",
        )
        expect(t).toContain('RELEASE_BOT_CLIENT_ID')
        expect(t).toContain('RELEASE_BOT_APP_PRIVATE_KEY')
        expect(t).toMatch(/^permissions: \{\}$/m)
        // Only install, lock and git run: no bun/npm/script from the checkout.
        const runs = (parse(t).jobs.relock?.steps ?? [])
            .map((s) => s.run)
            .filter(Boolean)
            .join('\n')
        expect(runs).not.toMatch(/\b(bun|npm|npx|pnpm|yarn|make|just)\b/)
    })

    test('pins match voidflow own lockfile workflows', () => {
        const own = readFileSync(
            join(ROOT, '.github/workflows/verify-lockfile.yml'),
            'utf8',
        )
        const version = /VERSION: (v\S+)/.exec(own)?.[1]
        expect(version).toBeTruthy()
        for (const f of ['verify-lockfile.yml', 'relock-actions.yml'])
            expect(template(f)).toContain(`VERSION: ${version} #`)
    })

    test('relock commits a first, untracked actions.lock', () => {
        const t = template('relock-actions.yml')
        expect(t).toContain('git status --porcelain -- .github/workflows')
        expect(t).not.toContain('git diff --quiet')
    })

    test('verify runs on the default branch only, not next', () => {
        expect(template('verify-lockfile.yml')).toContain('branches: [main]')
    })
})

describe('runActionsLock', () => {
    const ok = async () => ({ code: 0, out: '', err: '' })

    test('dry run plans the command without running it', async () => {
        let called = false
        const r = await runActionsLock(dir, null, true, async () => {
            called = true
            return { code: 0, out: '', err: '' }
        })
        expect(called).toBe(false)
        expect(r).toEqual({
            name: 'actions-lock',
            status: 'would-apply',
            detail: 'gh actions-lock',
        })
    })

    test('passes the scoped paths', async () => {
        let seen: string[] = []
        const r = await runActionsLock(
            dir,
            ['.github/workflows/ci.yml'],
            false,
            async (args) => {
                seen = args
                return ok()
            },
        )
        expect(seen).toEqual(['.github/workflows/ci.yml'])
        expect(r.status).toBe('applied')
        expect(r.detail).toContain('commit .github/workflows')
    })

    test('a missing extension degrades to a manual step', async () => {
        for (const res of [
            {
                code: 1,
                out: '',
                err: 'unknown command "actions-lock" for "gh"',
            },
            { code: 127, out: '', err: 'spawn gh ENOENT' },
        ]) {
            const r = await runActionsLock(dir, null, false, async () => res)
            expect(r.status).toBe('manual')
            expect(r.detail).toContain(
                'gh extension install github/gh-actions-lock && gh actions-lock',
            )
        }
    })

    test('any other failure is failed, with the first error line', async () => {
        const r = await runActionsLock(dir, null, false, async () => ({
            code: 1,
            out: '',
            err: 'error: rate limited\nmore',
        }))
        expect(r.status).toBe('failed')
        expect(r.detail).toBe(
            'error: rate limited; fix it, then run: gh actions-lock',
        )
    })
})

function fakeGh(routes: Record<string, GhResult>): Gh {
    return {
        available: async () => null,
        async rest(method, path) {
            return (
                routes[`${method} ${path}`] ?? {
                    status: 404,
                    body: { message: 'Not Found' },
                }
            )
        },
        graphql: async () => ({}),
    }
}

describe('relockCredentials', () => {
    const v = 'GET repos/o/r/actions/variables/RELEASE_BOT_CLIENT_ID'
    const s = 'GET repos/o/r/actions/secrets/RELEASE_BOT_APP_PRIVATE_KEY'
    const ov = 'GET repos/o/r/actions/organization-variables?per_page=100'
    const os = 'GET repos/o/r/actions/organization-secrets?per_page=100'

    test('repo-level variable and secret', async () => {
        const gh = fakeGh({
            [v]: { status: 200, body: {} },
            [s]: { status: 200, body: {} },
        })
        expect(await relockCredentials(gh, 'o/r')).toEqual({
            variable: true,
            secret: true,
        })
    })

    test('organization-level ones shared with the repo count', async () => {
        const gh = fakeGh({
            [ov]: {
                status: 200,
                body: { variables: [{ name: 'RELEASE_BOT_CLIENT_ID' }] },
            },
            [os]: { status: 200, body: { secrets: [{ name: 'OTHER' }] } },
        })
        expect(await relockCredentials(gh, 'o/r')).toEqual({
            variable: true,
            secret: false,
        })
    })

    test('no access is unknown, not missing', async () => {
        const gh = fakeGh({
            [v]: { status: 403, body: {} },
            [s]: { status: 404, body: {} },
            [os]: { status: 403, body: {} },
        })
        expect(await relockCredentials(gh, 'o/r')).toEqual({
            variable: null,
            secret: null,
        })
    })

    test('notes name what is missing, and nothing when both are set', () => {
        expect(
            credentialNotes('o/r', { variable: true, secret: true }),
        ).toEqual([])
        const [missing] = credentialNotes('o/r', {
            variable: true,
            secret: false,
        })
        expect(missing).toContain(
            'is missing the RELEASE_BOT_APP_PRIVATE_KEY secret',
        )
        expect(missing).not.toContain('RELEASE_BOT_CLIENT_ID variable')
        expect(missing).toContain('Contents and Workflows read and write')
        const [unknown] = credentialNotes('o/r', {
            variable: null,
            secret: true,
        })
        expect(unknown).toContain('could not confirm the RELEASE_BOT_CLIENT_ID')
    })
})

describe('planFiles', () => {
    const ctx: RenderCtx = {
        version: '1.2.3',
        sha: 'a'.repeat(40),
        kind: 'tool',
        repo: 'o/r',
        cronMinute: 7,
    }
    const base = {
        kind: 'tool' as const,
        skip: new Set<string>(),
        force: false,
        enablePvr: false,
    }
    const names = (extra: Record<string, unknown>) =>
        planFiles(dir, { ...base, ...extra }, ctx).map((a) => a.name)

    test('both items are opt-in', () => {
        const n = names({})
        expect(n).not.toContain('actions-lock')
        expect(n).not.toContain('actions-relock')
    })

    test('--enable-actions-lock writes verify only; relock implies it', () => {
        expect(names({ enableActionsLock: true })).toContain('actions-lock')
        expect(names({ enableActionsLock: true })).not.toContain(
            'actions-relock',
        )
        const both = names({ enableActionsRelock: true })
        expect(both).toContain('actions-lock')
        expect(both).toContain('actions-relock')
    })

    test('carries the marker, the cron minute and the scope', () => {
        const actions = planFiles(
            dir,
            {
                ...base,
                enableActionsRelock: true,
                lockPaths: ['.github/workflows/ci.yml'],
            },
            ctx,
        )
        const verify = actions.find((a) => a.name === 'actions-lock')
        expect(verify?.target).toBe('.github/workflows/verify-lockfile.yml')
        expect(verify?.content).toStartWith('# Written by voidflow v1.2.3')
        expect(verify?.content).toContain("cron: '7 7 * * 1'")
        expect(verify?.content).toContain(
            'gh actions-lock --verify \\\n            .github/workflows/ci.yml',
        )
        const relock = actions.find((a) => a.name === 'actions-relock')
        expect(relock?.target).toBe('.github/workflows/relock-actions.yml')
        expect(relock?.content).toContain('.github/workflows/actions.lock')
    })
})

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

describe('voidflow init --enable-actions-relock', () => {
    function repo(): string {
        Bun.spawnSync(['git', 'init', '-q', dir])
        Bun.spawnSync([
            'git',
            '-C',
            dir,
            'remote',
            'add',
            'origin',
            'https://github.com/o/r.git',
        ])
        return dir
    }

    async function run(
        argv: string[],
        lock: (args: string[]) => { code: number; out: string; err: string },
        routes: Record<string, GhResult> = {},
    ) {
        const out: string[] = []
        const calls: string[][] = []
        const log = spyOn(console, 'log').mockImplementation(
            (...a) => void out.push(a.join(' ')),
        )
        const error = spyOn(console, 'error').mockImplementation(() => {})
        const exit = spyOn(process, 'exit').mockImplementation(((
            c?: number,
        ) => {
            throw new Exit(c ?? 0)
        }) as never)
        let code = -1
        try {
            await main([...argv, dir], 'voidflow init', {
                gh: fakeGh({
                    'GET users/o': { status: 200, body: { type: 'User' } },
                    ...routes,
                }),
                resolveSha: async () => 'deadbeef',
                ghActionsLock: async (args) => {
                    calls.push(args)
                    return lock(args)
                },
            })
        } catch (e) {
            if (!(e instanceof Exit)) throw e
            code = e.code
        } finally {
            log.mockRestore()
            error.mockRestore()
            exit.mockRestore()
        }
        return { code, out: out.join('\n'), calls }
    }

    const okLock = () => ({ code: 0, out: '', err: '' })

    test('dry run plans both files and the lock run, runs and writes nothing', async () => {
        repo()
        const r = await run(
            ['--kind', 'tool', '--preset', 'files', '--enable-actions-relock'],
            okLock,
        )
        expect(r.code).toBe(0)
        expect(r.calls).toEqual([])
        expect(r.out).toMatch(/would create\s+actions-lock/)
        expect(r.out).toMatch(/would create\s+actions-relock/)
        expect(r.out).toMatch(/would-apply\s+actions-lock\s+gh actions-lock$/m)
        expect(
            existsSync(join(dir, '.github/workflows/relock-actions.yml')),
        ).toBe(false)
        // Missing App credentials are a setup reminder, not a failure.
        expect(r.out).toContain(
            'is missing the RELEASE_BOT_CLIENT_ID variable and the RELEASE_BOT_APP_PRIVATE_KEY secret',
        )
    })

    test('--apply writes both and runs gh actions-lock once over the whole directory', async () => {
        repo()
        const r = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'files',
                '--enable-actions-relock',
                '--apply',
            ],
            okLock,
            {
                'GET repos/o/r/actions/variables/RELEASE_BOT_CLIENT_ID': {
                    status: 200,
                    body: {},
                },
                'GET repos/o/r/actions/secrets/RELEASE_BOT_APP_PRIVATE_KEY': {
                    status: 200,
                    body: {},
                },
            },
        )
        expect(r.code).toBe(0)
        expect(r.calls).toEqual([[]])
        expect(
            existsSync(join(dir, '.github/workflows/verify-lockfile.yml')),
        ).toBe(true)
        expect(
            existsSync(join(dir, '.github/workflows/relock-actions.yml')),
        ).toBe(true)
        expect(r.out).not.toContain('RELEASE_BOT_APP_PRIVATE_KEY')
        expect(r.out).toContain('label any other PR')
    })

    test('with a gh-aw lock file the run and both workflows are scoped', async () => {
        repo()
        workflows('deps-review.lock.yml', 'deploy.yml')
        const r = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'files',
                '--enable-actions-relock',
                '--apply',
            ],
            okLock,
        )
        expect(r.code).toBe(0)
        expect(r.calls).toEqual([
            [
                '.github/workflows/ci.yml',
                '.github/workflows/deploy.yml',
                '.github/workflows/relock-actions.yml',
                '.github/workflows/verify-lockfile.yml',
            ],
        ])
        const relock = readFileSync(
            join(dir, '.github/workflows/relock-actions.yml'),
            'utf8',
        )
        expect(relock).toContain('.github/workflows/deploy.yml \\')
        expect(relock).not.toContain('deps-review.lock.yml')
    })

    test('a re-run keeps the verify cron minute when ci.yml is skipped', async () => {
        repo()
        const argv = [
            '--kind',
            'tool',
            '--preset',
            'files',
            '--skip',
            'ci',
            '--enable-actions-lock',
            '--apply',
        ]
        const path = join(dir, '.github/workflows/verify-lockfile.yml')
        expect((await run(argv, okLock)).code).toBe(0)
        const first = readFileSync(path, 'utf8')
        for (let i = 0; i < 5; i++) {
            const r = await run(argv, okLock)
            expect(r.code).toBe(0)
            expect(r.out).toMatch(/unchanged\s+actions-lock/)
        }
        expect(readFileSync(path, 'utf8')).toBe(first)
    })

    test('a missing extension is a manual step and exits 0', async () => {
        repo()
        const r = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'files',
                '--enable-actions-lock',
                '--apply',
            ],
            () => ({
                code: 1,
                out: '',
                err: 'unknown command "actions-lock" for "gh"',
            }),
        )
        expect(r.code).toBe(0)
        expect(r.out).toMatch(
            /manual\s+actions-lock\s+gh-actions-lock is not installed/,
        )
        expect(r.out).not.toContain('relock')
    })

    test('a lock failure exits 1', async () => {
        repo()
        const r = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'files',
                '--enable-actions-lock',
                '--apply',
            ],
            () => ({ code: 1, out: '', err: 'boom' }),
        )
        expect(r.code).toBe(1)
        expect(r.out).toMatch(/failed\s+actions-lock\s+boom/)
    })

    test('a file conflict means gh actions-lock is not run', async () => {
        repo()
        workflows('verify-lockfile.yml')
        const r = await run(
            [
                '--kind',
                'tool',
                '--preset',
                'files',
                '--enable-actions-lock',
                '--apply',
            ],
            okLock,
        )
        expect(r.code).toBe(1)
        expect(r.calls).toEqual([])
        expect(r.out).toContain('gh actions-lock was not run (file conflicts')
    })

    test('the settings half creates the relock-actions label and reminds about the policy', async () => {
        repo()
        const r = await run(
            [
                '--preset',
                'settings',
                '--enable-actions-relock',
                '--skip',
                'codeql',
            ],
            okLock,
        )
        expect(r.out).toMatch(/label-relock-actions/)
        expect(r.out).toContain('Require lockfile policy')
        // Settings only: no files, so nothing to lock.
        expect(r.calls).toEqual([])
    })
})
