import { afterEach, describe, expect, spyOn, test } from 'bun:test'
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
import type { Gh, GhResult } from '../scripts/init/gh.ts'
import { main } from '../scripts/init.ts'

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

/** Stateful fake: the agentic knobs start off; writes turn them on. */
function fakeGh() {
    const repoFlags: Record<string, unknown> = {}
    const labels = new Set<string>()
    let perms = {
        default_workflow_permissions: 'write',
        can_approve_pull_request_reviews: true,
    }
    const writes: string[] = []
    const gh: Gh = {
        available: async () => null,
        async rest(method, path, body): Promise<GhResult> {
            if (method !== 'GET') writes.push(`${method} ${path}`)
            if (path === 'repos/o/r') {
                if (method === 'PATCH') Object.assign(repoFlags, body)
                return { status: 200, body: { ...repoFlags } }
            }
            if (path === 'repos/o/r/actions/permissions/workflow') {
                if (method === 'PUT') perms = body as typeof perms
                return { status: 200, body: perms }
            }
            if (path === 'repos/o/r/labels' && method === 'POST') {
                labels.add((body as { name: string }).name)
                return { status: 201, body: body }
            }
            const m = /^repos\/o\/r\/labels\/(.+)$/.exec(path)
            if (m) {
                if (method === 'PATCH') {
                    labels.delete(decodeURIComponent(m[1]))
                    labels.add((body as { new_name: string }).new_name)
                    return { status: 200, body: body }
                }
                return labels.has(decodeURIComponent(m[1]))
                    ? { status: 200, body: {} }
                    : { status: 404, body: { message: 'Not Found' } }
            }
            return { status: 404, body: { message: 'Not Found' } }
        },
        graphql: async () => ({
            repository: {
                id: 'R_1',
                visibility: 'PUBLIC',
                pullRequestCreationPolicy: 'COLLABORATORS_ONLY',
                issueCreationPolicy: 'COLLABORATORS_ONLY',
            },
        }),
    }
    return { gh, writes, labels, repoFlags }
}

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-init-ag-'))
    roots.push(dir)
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
    gh: Gh,
    ghAw?: (
        args: string[],
        dir: string,
    ) => Promise<{ code: number; err: string }>,
) {
    const out: string[] = []
    const log = spyOn(console, 'log').mockImplementation(
        (...a) => void out.push(a.join(' ')),
    )
    const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
        throw new Exit(c ?? 0)
    }) as never)
    let code = -1
    try {
        await main(argv, 'voidflow init', {
            gh,
            ghAw,
            resolveSha: async () => 'sha',
        })
    } catch (e) {
        if (!(e instanceof Exit)) throw e
        code = e.code
    } finally {
        log.mockRestore()
        exit.mockRestore()
    }
    return { code, out: out.join('\n') }
}

const ARGV = ['--preset', 'settings', '--enable-agentic']

describe('init --enable-agentic', () => {
    test('is off by default', async () => {
        const f = fakeGh()
        const r = await run(['--preset', 'settings', repo()], f.gh)
        expect(r.out).not.toContain('auto-merge')
        expect(f.labels.size).toBe(0)
    })

    test('--dry-run lists every piece and writes none of them', async () => {
        const f = fakeGh()
        const r = await run([...ARGV, '--dry-run', repo()], f.gh)
        for (const n of [
            'auto-merge',
            'update-branch',
            'delete-branch-on-merge',
            'actions-permissions',
            'label-low-risk',
            'label-needs-you',
        ])
            expect(r.out).toMatch(new RegExp(`would-apply\\s+${n}`))
        expect(f.writes.filter((w) => w.includes('labels'))).toEqual([])
        expect(f.repoFlags).not.toHaveProperty('allow_auto_merge')
    })

    test('applies once, then a re-run is unchanged', async () => {
        const f = fakeGh()
        const dir = repo()
        await run([...ARGV, dir], f.gh)
        expect(f.repoFlags).toMatchObject({
            allow_auto_merge: true,
            allow_update_branch: true,
            delete_branch_on_merge: true,
        })
        expect([...f.labels].sort()).toEqual(['low-risk', 'needs-you'])
        const again = await run([...ARGV, dir], f.gh)
        for (const n of ['auto-merge', 'actions-permissions', 'label-low-risk'])
            expect(again.out).toMatch(new RegExp(`unchanged\\s+${n}`))
    })

    test('renames the old deps: labels in place', async () => {
        const f = fakeGh()
        f.labels.add('deps:low-risk')
        f.labels.add('deps:needs-you')
        const r = await run([...ARGV, repo()], f.gh)
        expect(r.out).toMatch(/applied\s+label-low-risk/)
        expect([...f.labels].sort()).toEqual(['low-risk', 'needs-you'])
        expect(
            f.writes.some((w) => w.startsWith('POST') && w.includes('labels')),
        ).toBe(false)
    })

    test('prints the Copilot token secret as a manual step', async () => {
        const r = await run([...ARGV, '--dry-run', repo()], fakeGh().gh)
        expect(r.out).toContain('COPILOT_GITHUB_TOKEN')
    })

    test('shadow writes agentic.yml with the locks job only', async () => {
        const dir = repo()
        const calls: string[][] = []
        const aw = async (args: string[]) => (
            calls.push(args), { code: 0, err: '' }
        )
        await run(['--kind', 'tool', '--enable-agentic', dir], fakeGh().gh, aw)
        const text = readFileSync(
            join(dir, '.github/workflows/agentic.yml'),
            'utf8',
        )
        expect(text).toContain('agentic-locks.yml@sha')
        expect(text).not.toContain('deps-review-gate')
        expect(readFileSync(join(dir, 'renovate.json'), 'utf8')).not.toContain(
            'deps-review-automerge',
        )
        expect(calls).toEqual([
            [
                'add',
                'taraxvoid/voidflow/agentic@v' + calls[0][1].split('@v')[1],
            ],
        ])
    })

    test('gate adds the gate job and the Renovate automerge preset', async () => {
        const dir = repo()
        const aw = async () => ({ code: 0, err: '' })
        await run(
            [
                '--kind',
                'tool',
                '--enable-agentic',
                '--agentic-stage',
                'gate',
                dir,
            ],
            fakeGh().gh,
            aw,
        )
        expect(
            readFileSync(join(dir, '.github/workflows/agentic.yml'), 'utf8'),
        ).toContain('deps-review-gate.yml@sha')
        expect(readFileSync(join(dir, 'renovate.json'), 'utf8')).toContain(
            'github>taraxvoid/voidflow:deps-review-automerge',
        )
    })

    test('moving a shadow repo to gate merges renovate.json, no --force', async () => {
        const dir = repo()
        // Like the real `gh aw add`, leave the workflow Markdown behind.
        const aw = async (_args: string[], at: string) => {
            mkdirSync(join(at, '.github/workflows'), { recursive: true })
            writeFileSync(join(at, '.github/workflows/deps-review.md'), '')
            return { code: 0, err: '' }
        }
        await run(['--kind', 'tool', '--enable-agentic', dir], fakeGh().gh, aw)
        const r = await run(
            [
                '--kind',
                'tool',
                '--enable-agentic',
                '--agentic-stage',
                'gate',
                dir,
            ],
            fakeGh().gh,
            aw,
        )
        expect(r.out).toMatch(/merge\s+renovate/)
        expect(r.out).not.toContain('conflict')
        expect(readFileSync(join(dir, 'renovate.json'), 'utf8')).toContain(
            'deps-review-automerge',
        )
        const again = await run(
            [
                '--kind',
                'tool',
                '--enable-agentic',
                '--agentic-stage',
                'gate',
                dir,
            ],
            fakeGh().gh,
            aw,
        )
        expect(again.out).toMatch(/unchanged\s+renovate/)
        expect(again.out).toMatch(/unchanged\s+deps-review/)
    })

    test('a failing gh aw add is reported with the manual command', async () => {
        const dir = repo()
        const r = await run(
            ['--kind', 'tool', '--enable-agentic', dir],
            fakeGh().gh,
            async () => ({ code: 1, err: 'unknown command "aw"\n' }),
        )
        expect(r.out).toMatch(/failed\s+deps-review/)
        expect(r.out).toContain('gh aw add taraxvoid/voidflow/agentic@v')
        expect(r.code).toBe(1)
    })

    test('--dry-run plans deps-review without running gh aw', async () => {
        const dir = repo()
        let ran = false
        const r = await run(
            ['--kind', 'tool', '--enable-agentic', '--dry-run', dir],
            fakeGh().gh,
            async () => ((ran = true), { code: 0, err: '' }),
        )
        expect(ran).toBe(false)
        expect(r.out).toMatch(/would-apply\s+deps-review/)
        expect(existsSync(join(dir, '.github/workflows/agentic.yml'))).toBe(
            false,
        )
    })

    test('an unknown --agentic-stage exits 2', async () => {
        const r = await run(
            ['--kind', 'tool', '--agentic-stage', 'nope', repo()],
            fakeGh().gh,
        )
        expect(r.code).toBe(2)
    })

    test('--skip agentic also skips the deps-review install', async () => {
        let ran = false
        const r = await run(
            ['--kind', 'tool', '--enable-agentic', '--skip', 'agentic', repo()],
            fakeGh().gh,
            async () => ((ran = true), { code: 0, err: '' }),
        )
        expect(ran).toBe(false)
        expect(r.out).toContain('deps-review was not installed')
    })

    test('file conflicts say deps-review was not installed', async () => {
        const dir = repo()
        writeFileSync(join(dir, 'mise.toml'), '[tools]\n')
        const r = await run(
            ['--kind', 'tool', '--enable-agentic', dir],
            fakeGh().gh,
        )
        expect(r.out).toContain('deps-review was not installed (file conflicts')
    })

    test('gate merges the preset into a customised renovate.json', async () => {
        const dir = repo()
        writeFileSync(
            join(dir, 'renovate.json'),
            '{\n  "extends": ["config:recommended"],\n  "labels": ["deps"]\n}\n',
        )
        const r = await run(
            [
                '--kind',
                'tool',
                '--enable-agentic',
                '--agentic-stage',
                'gate',
                dir,
            ],
            fakeGh().gh,
            async () => ({ code: 0, err: '' }),
        )
        expect(r.out).toMatch(/merge\s+renovate/)
        const j = JSON.parse(readFileSync(join(dir, 'renovate.json'), 'utf8'))
        expect(j.labels).toEqual(['deps'])
        expect(j.extends).toEqual([
            'config:recommended',
            'github>taraxvoid/voidflow:deps-review-automerge',
        ])
    })

    test('names the gh-aw version agentic-locks compiles with', async () => {
        const r = await run(
            ['--kind', 'tool', '--enable-agentic', '--dry-run', repo()],
            fakeGh().gh,
        )
        expect(r.out).toMatch(/gh extension install github\/gh-aw --pin v\d/)
    })
})
