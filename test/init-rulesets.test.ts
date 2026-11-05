import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, tool } from '../rulesets/index.ts'
import type { Gh, GhResult } from '../scripts/init/gh.ts'
import { runRulesets } from '../scripts/init/rulesets.ts'
import { main } from '../scripts/init.ts'

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

/** In-memory rulesets API for repo o/r: POST creates, PUT replaces. */
function fakeRulesets(opts: { plan403?: boolean; existing?: unknown[] } = {}) {
    const store = new Map<number, Record<string, unknown>>()
    for (const [i, r] of (opts.existing ?? []).entries())
        store.set(i + 1, { id: i + 1, ...(r as object) })
    let next = 100
    const writes: string[] = []
    const gh: Gh = {
        available: async () => null,
        async rest(method, path, body): Promise<GhResult> {
            if (method !== 'GET') writes.push(`${method} ${path}`)
            if (path === 'repos/o/r/rulesets' && method === 'GET') {
                if (opts.plan403) {
                    return {
                        status: 403,
                        body: {
                            message:
                                'Upgrade to GitHub Pro or make this repository public to enable this feature.',
                        },
                    }
                }
                return {
                    status: 200,
                    body: [...store.values()].map((r) => ({
                        id: r.id,
                        name: r.name,
                    })),
                }
            }
            if (path === 'repos/o/r/rulesets' && method === 'POST') {
                const id = next++
                store.set(id, { id, ...(body as object) })
                return { status: 201, body: store.get(id) }
            }
            const m = /^repos\/o\/r\/rulesets\/(\d+)$/.exec(path)
            if (m) {
                const id = Number(m[1])
                if (method === 'GET')
                    return { status: 200, body: store.get(id) }
                if (method === 'PUT') {
                    store.set(id, { id, ...(body as object) })
                    return { status: 200, body: store.get(id) }
                }
            }
            return { status: 404, body: { message: 'Not Found' } }
        },
        graphql: async () => ({}),
    }
    return { gh, writes, store }
}

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-init-rs-'))
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
        await main(argv, 'voidflow init', { gh, resolveSha: async () => 'sha' })
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

describe('init --preset rulesets', () => {
    test('--dry-run plans a create and writes nothing', async () => {
        const f = fakeRulesets()
        const r = await run(
            ['--preset', 'rulesets', '--kind', 'tool', '--dry-run', repo()],
            f.gh,
        )
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/would-apply\s+ruleset main/)
        expect(f.writes).toEqual([])
    })

    test('applies once, then re-runs unchanged', async () => {
        const f = fakeRulesets()
        const dir = repo()
        const first = await run(
            ['--preset', 'rulesets', '--kind', 'tool', dir],
            f.gh,
        )
        expect(first.code).toBe(0)
        expect(first.out).toMatch(/applied\s+ruleset main/)
        expect(f.writes).toEqual(['POST repos/o/r/rulesets'])
        const second = await run(
            ['--preset', 'rulesets', '--kind', 'tool', dir],
            f.gh,
        )
        expect(second.out).toMatch(/unchanged\s+ruleset main/)
        expect(f.writes.length).toBe(1)
    })

    test('updates a ruleset that drifted', async () => {
        const stale = {
            ...build('main', tool()),
            enforcement: 'disabled',
        }
        const f = fakeRulesets({ existing: [stale] })
        const r = await run(
            ['--preset', 'rulesets', '--kind', 'tool', repo()],
            f.gh,
        )
        expect(r.out).toMatch(/applied\s+ruleset main/)
        expect(f.writes).toEqual(['PUT repos/o/r/rulesets/1'])
    })

    test('a private repo without ruleset support is skipped-plan, exit 0', async () => {
        const f = fakeRulesets({ plan403: true })
        const r = await run(
            ['--preset', 'rulesets', '--kind', 'tool', repo()],
            f.gh,
        )
        expect(r.code).toBe(0)
        expect(r.out).toMatch(/skipped-plan\s+rulesets/)
    })

    test('a site without --config exits 2', async () => {
        const r = await run(
            ['--preset', 'rulesets', '--kind', 'site', repo()],
            fakeRulesets().gh,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('--config')
    })

    test('no --kind and no --config exits 2', async () => {
        const r = await run(['--preset', 'rulesets', repo()], fakeRulesets().gh)
        expect(r.code).toBe(2)
    })

    test('full does not touch rulesets', async () => {
        const f = fakeRulesets()
        const r = await run(['--kind', 'tool', '--dry-run', repo()], f.gh)
        expect(r.out).not.toContain('rulesets:')
        expect(r.out).not.toContain('rulesets (dry run)')
        expect(f.writes).toEqual([])
    })

    test('a ruleset listed in retire is reported, not dropped', async () => {
        const f = fakeRulesets({ existing: [{ name: 'legacy' }] })
        const rows = await runRulesets(
            f.gh,
            'o/r',
            { 'o/r': tool({ retire: ['legacy'] }) },
            true,
        )
        const legacy = rows.find((x) => x.name === 'ruleset legacy')
        expect(legacy?.detail).toContain('--prune')
    })

    test('a mid-run failure keeps the rulesets already written', async () => {
        const f = fakeRulesets()
        const rest = f.gh.rest
        let posts = 0
        f.gh.rest = async (method, path, body) => {
            if (method === 'POST' && ++posts === 2)
                return { status: 422, body: { message: 'nope' } }
            return rest(method, path, body)
        }
        const rows = await runRulesets(
            f.gh,
            'o/r',
            { 'o/r': tool({ tiers: ['main', 'next'] }) },
            false,
        )
        expect(rows.map((x) => x.status)).toEqual(['applied', 'failed'])
    })

    test('--config without --preset rulesets exits 2', async () => {
        const r = await run(
            ['--kind', 'tool', '--config', './x.ts', repo()],
            fakeRulesets().gh,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('--config')
    })
})
