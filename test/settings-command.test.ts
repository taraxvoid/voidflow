import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { VoidflowConfig } from '../config/index.ts'
import type { Gh, GhResult } from '../scripts/init/gh.ts'
import { settingsCommand } from '../scripts/settings.ts'

/** A gh where every setting reads `on`, with per-path overrides. */
function fake(opts: {
    on?: boolean
    permission?: string
    unavailable?: string
    override?: Record<string, GhResult>
}): Gh & { writes: string[] } {
    const on = opts.on ?? true
    const writes: string[] = []
    return {
        writes,
        available: async () => opts.unavailable ?? null,
        async rest(method, path) {
            const key = `${method} ${path}`
            if (opts.override?.[key]) return opts.override[key]
            if (method !== 'GET') {
                writes.push(key)
                return { status: 204, body: null }
            }
            switch (path.replace('repos/o/r', '')) {
                case '/vulnerability-alerts':
                    return { status: on ? 204 : 404, body: null }
                case '/automated-security-fixes':
                    return { status: 200, body: { enabled: on } }
                case '': {
                    const s = { status: on ? 'enabled' : 'disabled' }
                    return {
                        status: 200,
                        body: {
                            security_and_analysis: {
                                secret_scanning: s,
                                secret_scanning_push_protection: s,
                            },
                        },
                    }
                }
                case '/code-scanning/default-setup':
                    return {
                        status: 200,
                        body: { state: on ? 'configured' : 'not-configured' },
                    }
            }
            return { status: 404, body: { message: 'Not Found' } }
        },
        async graphql(query) {
            if (query.startsWith('mutation')) return {}
            const v = on ? 'COLLABORATORS_ONLY' : 'ALL'
            return {
                repository: {
                    id: 'R_1',
                    visibility: 'PRIVATE',
                    pullRequestCreationPolicy: v,
                    issueCreationPolicy: v,
                    viewerPermission: opts.permission ?? 'ADMIN',
                },
            }
        },
    }
}

const CFG: VoidflowConfig = { kind: 'tool' }
const run = (
    gh: Gh,
    mode: 'plan' | 'check' | 'apply',
    o: { ifAdmin?: boolean; cfg?: VoidflowConfig; env?: object } = {},
) =>
    settingsCommand(gh, 'o/r', o.cfg ?? CFG, {
        mode,
        ifAdmin: o.ifAdmin ?? false,
        env: { GH_TOKEN: 'x', ...o.env },
    })

describe('voidflow settings', () => {
    test('in sync: 0 in every mode, no writes', async () => {
        for (const mode of ['plan', 'check', 'apply'] as const) {
            const gh = fake({})
            const r = await run(gh, mode)
            expect(r.code).toBe(0)
            expect(gh.writes).toEqual([])
            expect(r.lines.at(-1)).toBe(
                mode === 'apply' ? '0 setting(s) changed' : 'in sync',
            )
        }
    })

    test('drift: check exits 1 with the apply hint, plan exits 0', async () => {
        const env = {
            VOIDFLOW_VIA_VERB: '1',
            VOIDFLOW_APPLY_HINT: 'voidflow apply settings',
        }
        const check = await run(fake({ on: false }), 'check', { env })
        expect(check.code).toBe(1)
        expect(check.lines.at(-1)).toBe(
            '6 setting(s) differ (run `voidflow apply settings`)',
        )
        expect((await run(fake({ on: false }), 'plan')).code).toBe(0)
    })

    test('apply writes what differs and prints the reminders', async () => {
        const gh = fake({ on: false })
        const r = await run(gh, 'apply', {
            cfg: { kind: 'tool', settings: { skip: ['codeql'] } },
        })
        expect(r.code).toBe(0)
        expect(gh.writes).not.toContain(
            'PATCH repos/o/r/code-scanning/default-setup',
        )
        expect(r.lines).toContain('manual:')
        expect(r.lines.at(-1)).toBe('5 setting(s) changed')
    })

    test('plan-gated skips warn and are not drift', async () => {
        const gh = fake({
            on: false,
            override: {
                'GET repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: { message: 'Code Security must be enabled' },
                },
            },
        })
        const r = await run(gh, 'check', {
            cfg: {
                kind: 'tool',
                settings: {
                    skip: [
                        'pr-policy',
                        'issue-policy',
                        'dependabot-alerts',
                        'dependabot-security-updates',
                        'secret-scanning',
                    ],
                },
            },
        })
        expect(r.code).toBe(0)
        expect(r.lines.join('\n')).toContain('skipped-plan')
        expect(r.lines).toContain(
            'warning: 1 setting(s) skipped (see above); not counted as drift',
        )
    })

    test('without admin: exit 2 when named, a skip on a bare run', async () => {
        const named = await run(fake({ permission: 'WRITE' }), 'check')
        expect(named).toEqual({
            lines: ['settings need admin on o/r (GH_TOKEN has WRITE)'],
            code: 2,
        })
        const bare = await run(fake({ permission: 'WRITE' }), 'check', {
            ifAdmin: true,
        })
        expect(bare).toEqual({
            lines: ['settings skipped (GH_TOKEN lacks admin)'],
            code: 0,
        })
    })

    test('gh unavailable: exit 2 when named, a skip on a bare run', async () => {
        const gh = fake({ unavailable: 'gh is not installed' })
        expect((await run(gh, 'plan')).code).toBe(2)
        expect(await run(gh, 'plan', { ifAdmin: true })).toEqual({
            lines: ['settings skipped (gh is not installed)'],
            code: 0,
        })
    })

    test('a token missing a scope fails instead of reading as plan-gated', async () => {
        const gh = fake({
            override: {
                'GET repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: {
                        message:
                            'Resource not accessible by personal access token',
                    },
                },
            },
        })
        const r = await run(gh, 'check')
        expect(r.code).toBe(2)
        expect(r.lines.join('\n')).toMatch(
            /failed\s+codeql\s+the credential lacks/,
        )
    })

    test('a failed read is 2; a failed write is 1', async () => {
        const read = fake({
            override: {
                'GET repos/o/r/automated-security-fixes': {
                    status: 500,
                    body: { message: 'boom' },
                },
            },
        })
        expect((await run(read, 'check')).code).toBe(2)
        const write = fake({
            on: false,
            override: {
                'PUT repos/o/r/vulnerability-alerts': {
                    status: 500,
                    body: { message: 'boom' },
                },
            },
        })
        const r = await run(write, 'apply')
        expect(r.code).toBe(1)
        expect(r.lines).not.toContain('manual:')
    })
})

describe('voidflow settings (the command line)', () => {
    const CLI = resolve(import.meta.dir, '..', 'scripts', 'cli.ts')
    const dirs: string[] = []
    afterEach(() => {
        for (const d of dirs.splice(0))
            rmSync(d, { recursive: true, force: true })
    })
    async function cli(args: string[], config?: string) {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-settings-'))
        dirs.push(dir)
        mkdirSync(join(dir, '.git'))
        const file = join(dir, 'voidflow.config.ts')
        if (config !== undefined) writeFileSync(file, config)
        const proc = Bun.spawn(
            [
                'bun',
                CLI,
                'settings',
                ...args.map((a) => a.replace('FILE', file)),
            ],
            {
                cwd: dir,
                env: { ...process.env, GITHUB_REPOSITORY: 'o/r' },
                stdout: 'pipe',
                stderr: 'pipe',
            },
        )
        const [code, err] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ])
        return { code, err }
    }

    test('--repo-config is required', async () => {
        const r = await cli([])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--repo-config is required')
    })

    test('--check and --apply are alternatives', async () => {
        const r = await cli(
            ['--repo-config', 'FILE', '--check', '--apply'],
            "export default { kind: 'tool' }\n",
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('alternatives')
    })

    test('an invalid config exits 2 naming the file', async () => {
        const r = await cli(
            ['--repo-config', 'FILE'],
            "export default { kind: 'tool', settings: { skip: ['nope'] } }\n",
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('voidflow.config.ts')
        expect(r.err).toContain('settings.skip: unknown setting "nope"')
    })

    test('an unknown flag exits 2', async () => {
        const r = await cli(
            ['--repo-config', 'FILE', '--prune'],
            "export default { kind: 'tool' }\n",
        )
        expect(r.code).toBe(2)
    })
})
