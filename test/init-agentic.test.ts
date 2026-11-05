import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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

async function run(argv: string[], gh: Gh) {
    const out: string[] = []
    const log = spyOn(console, 'log').mockImplementation(
        (...a) => void out.push(a.join(' ')),
    )
    const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => {
        throw new Exit(c ?? 0)
    }) as never)
    let code = -1
    try {
        await main(argv, 'voidflow init', { gh, resolveSha: async () => 'sha' })
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
            'label deps:low-risk',
            'label deps:needs-you',
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
        expect([...f.labels].sort()).toEqual([
            'deps:low-risk',
            'deps:needs-you',
        ])
        const again = await run([...ARGV, dir], f.gh)
        for (const n of [
            'auto-merge',
            'actions-permissions',
            'label deps:low-risk',
        ])
            expect(again.out).toMatch(new RegExp(`unchanged\\s+${n}`))
    })

    test('prints the Copilot token secret as a manual step', async () => {
        const r = await run([...ARGV, '--dry-run', repo()], fakeGh().gh)
        expect(r.out).toContain('COPILOT_GITHUB_TOKEN')
    })
})
