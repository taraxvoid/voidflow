import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    type Gh,
    type GhResult,
    ghAvailable,
    graphqlArgv,
    parseInclude,
    resolveRepo,
    restArgv,
} from '../scripts/init/gh.ts'
import {
    manualReminders,
    runSettings,
    settingNames,
} from '../scripts/init/settings.ts'
import { capture } from '../scripts/lib/proc.ts'

type Call = { method: string; path: string; body?: unknown }

function fake(opts: {
    on?: boolean
    visibility?: string
    override?: Record<string, GhResult>
}) {
    const on = opts.on ?? false
    const calls: Call[] = []
    const gql: { query: string; vars: Record<string, string> }[] = []
    const gh: Gh = {
        available: async () => null,
        async rest(method, path, body) {
            calls.push({ method, path, body })
            const key = `${method} ${path}`
            if (opts.override?.[key]) return opts.override[key]
            const p = path.replace('repos/o/r', '')
            if (method !== 'GET') return { status: 204, body: null }
            switch (p) {
                case '/vulnerability-alerts':
                    return { status: on ? 204 : 404, body: null }
                case '/automated-security-fixes':
                    return { status: 200, body: { enabled: on, paused: false } }
                case '':
                    return {
                        status: 200,
                        body: {
                            security_and_analysis: {
                                secret_scanning: {
                                    status: on ? 'enabled' : 'disabled',
                                },
                                secret_scanning_push_protection: {
                                    status: on ? 'enabled' : 'disabled',
                                },
                            },
                        },
                    }
                case '/code-scanning/default-setup':
                    return {
                        status: 200,
                        body: { state: on ? 'configured' : 'not-configured' },
                    }
                case '/private-vulnerability-reporting':
                    return { status: 200, body: { enabled: on } }
                case '/code-scanning/ai-scan':
                    return {
                        status: 200,
                        body: { pr_scan: on ? 'enabled' : 'disabled' },
                    }
            }
            return { status: 404, body: { message: 'Not Found' } }
        },
        async graphql(query, vars) {
            gql.push({ query, vars })
            if (query.startsWith('mutation')) return { updateRepository: {} }
            const v = on ? 'COLLABORATORS_ONLY' : 'ALL'
            return {
                repository: {
                    id: 'R_1',
                    visibility: opts.visibility ?? 'PUBLIC',
                    pullRequestCreationPolicy: v,
                    issueCreationPolicy: v,
                },
            }
        },
    }
    return { gh, calls, gql }
}

const sel = (o: Partial<Parameters<typeof runSettings>[2]> = {}) => ({
    skip: new Set<string>(),
    enablePvr: false,
    enableAiScan: false,
    dryRun: false,
    ...o,
})
const status = (rs: { name: string; status: string }[], n: string) =>
    rs.find((r) => r.name === n)?.status
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

describe('settings', () => {
    test('names', () => {
        expect(settingNames()).toEqual([
            'pr-policy',
            'issue-policy',
            'dependabot-alerts',
            'dependabot-security-updates',
            'secret-scanning',
            'codeql',
            'pvr',
            'ai-scan',
        ])
    })

    test('all off, apply', async () => {
        const f = fake({})
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(rs.map((r) => r.status)).toEqual(Array(6).fill('applied'))
        const w = writes(f.calls)
        expect(w).toContainEqual({
            method: 'PUT',
            path: 'repos/o/r/vulnerability-alerts',
            body: undefined,
        })
        expect(
            w.some((c) => c.path === 'repos/o/r/automated-security-fixes'),
        ).toBe(true)
        expect(
            w.find((c) => c.path === 'repos/o/r/code-scanning/default-setup')
                ?.body,
        ).toEqual({ state: 'configured' })
        const patch: any = w.find(
            (c) => c.path === 'repos/o/r' && c.method === 'PATCH',
        )?.body
        expect(patch.security_and_analysis.secret_scanning.status).toBe(
            'enabled',
        )
        expect(
            patch.security_and_analysis.secret_scanning_push_protection.status,
        ).toBe('enabled')
        const muts = f.gql.filter((g) => g.query.startsWith('mutation'))
        expect(muts).toHaveLength(2)
        expect(muts.every((m) => m.query.includes('COLLABORATORS_ONLY'))).toBe(
            true,
        )
        expect(muts[0].vars).toEqual({ id: 'R_1' })
    })

    test('all on', async () => {
        const f = fake({ on: true })
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(rs.every((r) => r.status === 'unchanged')).toBe(true)
        expect(writes(f.calls)).toHaveLength(0)
        expect(
            f.gql.filter((g) => g.query.startsWith('mutation')),
        ).toHaveLength(0)
    })

    test('dry-run', async () => {
        const f = fake({})
        const rs = await runSettings(f.gh, 'o/r', sel({ dryRun: true }))
        expect(rs.every((r) => r.status === 'would-apply')).toBe(true)
        expect(writes(f.calls)).toHaveLength(0)
        expect(
            f.gql.filter((g) => g.query.startsWith('mutation')),
        ).toHaveLength(0)
    })

    test('opt-ins untouched without flags', async () => {
        const f = fake({})
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(status(rs, 'pvr')).toBeUndefined()
        expect(status(rs, 'ai-scan')).toBeUndefined()
        expect(
            f.calls.some((c) => /private-vulnerability|ai-scan/.test(c.path)),
        ).toBe(false)
        const g = fake({})
        const rs2 = await runSettings(
            g.gh,
            'o/r',
            sel({ enablePvr: true, enableAiScan: true }),
        )
        expect(status(rs2, 'pvr')).toBe('applied')
        expect(status(rs2, 'ai-scan')).toBe('applied')
        expect(
            g.calls.some(
                (c) =>
                    c.method === 'PUT' &&
                    c.path === 'repos/o/r/private-vulnerability-reporting',
            ),
        ).toBe(true)
        expect(
            g.calls.find(
                (c) =>
                    c.path === 'repos/o/r/code-scanning/ai-scan' &&
                    c.method === 'PATCH',
            )?.body,
        ).toEqual({ pr_scan: 'enabled' })
    })

    test('skip removes a setting', async () => {
        const f = fake({})
        const rs = await runSettings(
            f.gh,
            'o/r',
            sel({ skip: new Set(['codeql']) }),
        )
        expect(status(rs, 'codeql')).toBeUndefined()
    })

    test('private repo plan gate', async () => {
        const f = fake({
            visibility: 'PRIVATE',
            override: {
                'PATCH repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: { message: 'Code Security must be enabled' },
                },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(status(rs, 'codeql')).toBe('skipped-plan')
        expect(status(rs, 'secret-scanning')).toBe('applied')
    })

    test('403 on a public repo is a failure', async () => {
        const f = fake({
            override: {
                'PATCH repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: { message: 'nope' },
                },
            },
        })
        expect(status(await runSettings(f.gh, 'o/r', sel()), 'codeql')).toBe(
            'failed',
        )
    })

    test('no code yet', async () => {
        const f = fake({
            override: {
                'PATCH repos/o/r/code-scanning/default-setup': {
                    status: 422,
                    body: { message: 'No supported languages found' },
                },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel())
        const r = rs.find((x) => x.name === 'codeql')
        expect(r?.status).toBe('skipped-no-code')
        expect(r?.detail).toContain('--preset settings')
    })

    test('one failure continues', async () => {
        const f = fake({
            override: {
                'PUT repos/o/r/vulnerability-alerts': {
                    status: 500,
                    body: { message: 'boom' },
                },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel())
        const bad = rs.find((r) => r.name === 'dependabot-alerts')
        expect(bad?.status).toBe('failed')
        expect(bad?.detail).toContain('boom')
        expect(status(rs, 'dependabot-security-updates')).toBe('applied')
        expect(status(rs, 'codeql')).toBe('applied')
    })

    test('secret-scanning plan gate on private and internal repos', async () => {
        for (const visibility of ['PRIVATE', 'INTERNAL']) {
            const f = fake({
                visibility,
                override: {
                    'PATCH repos/o/r': {
                        status: 422,
                        body: { message: 'Secret scanning needs a plan' },
                    },
                },
            })
            const rs = await runSettings(f.gh, 'o/r', sel())
            expect(status(rs, 'secret-scanning')).toBe('skipped-plan')
        }
    })

    test('plan gate does not apply to public repos', async () => {
        const f = fake({
            override: {
                'PATCH repos/o/r': { status: 422, body: { message: 'x' } },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(status(rs, 'secret-scanning')).toBe('failed')
    })

    test('plan gate on a read error', async () => {
        const f = fake({
            visibility: 'PRIVATE',
            override: {
                'GET repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: { message: 'Advanced Security must be enabled' },
                },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel())
        expect(status(rs, 'codeql')).toBe('skipped-plan')
        expect(
            writes(f.calls).some((c) => c.path.includes('default-setup')),
        ).toBe(false)
    })

    test('plan gate in dry-run (read error)', async () => {
        const f = fake({
            visibility: 'PRIVATE',
            override: {
                'GET repos/o/r/code-scanning/default-setup': {
                    status: 403,
                    body: { message: 'nope' },
                },
            },
        })
        const rs = await runSettings(f.gh, 'o/r', sel({ dryRun: true }))
        expect(status(rs, 'codeql')).toBe('skipped-plan')
        expect(status(rs, 'pr-policy')).toBe('would-apply')
        expect(writes(f.calls)).toHaveLength(0)
    })

    test('language message on a 5xx is a failure, not no-code', async () => {
        const f = fake({
            override: {
                'PATCH repos/o/r/code-scanning/default-setup': {
                    status: 500,
                    body: { message: 'language service down' },
                },
            },
        })
        expect(status(await runSettings(f.gh, 'o/r', sel()), 'codeql')).toBe(
            'failed',
        )
    })

    test('policies come from the single repo read', async () => {
        const f = fake({ on: true })
        await runSettings(f.gh, 'o/r', sel())
        expect(f.gql).toHaveLength(1)
    })

    test('graphql read failure fails every selected setting', async () => {
        const gh: Gh = {
            available: async () => null,
            rest: async () => ({ status: 200, body: {} }),
            graphql: async () => {
                throw new Error('Could not resolve to a Repository')
            },
        }
        const rs = await runSettings(gh, 'o/r', sel())
        expect(rs).toHaveLength(6)
        expect(rs.every((r) => r.status === 'failed')).toBe(true)
    })
})

describe('ghAvailable', () => {
    test('delegates to the Gh', async () => {
        const f = fake({})
        expect(await ghAvailable(f.gh)).toBeNull()
        const down: Gh = { ...f.gh, available: async () => 'gh missing' }
        expect(await ghAvailable(down)).toBe('gh missing')
    })
})

describe('argv', () => {
    test('rest without body', () => {
        expect(restArgv('GET', 'repos/o/r', false)).toEqual([
            'gh',
            'api',
            '--include',
            '--method',
            'GET',
            'repos/o/r',
        ])
    })
    test('rest with body pipes stdin', () => {
        const a = restArgv('PATCH', 'repos/o/r', true)
        expect(a.slice(-2)).toEqual(['--input', '-'])
        expect(a).toContain('--include')
        expect(a).toContain('PATCH')
    })
    test('graphql passes every variable as a string with -f', () => {
        const a = graphqlArgv('query Q', { owner: 'o', name: '123' })
        expect(a).toEqual([
            'gh',
            'api',
            'graphql',
            '-f',
            'query=query Q',
            '-f',
            'owner=o',
            '-f',
            'name=123',
        ])
        expect(a).not.toContain('-F')
    })
})

describe('parseInclude', () => {
    test('status and json body', () => {
        const r = parseInclude(
            'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"enabled":true}\n',
        )
        expect(r).toEqual({ status: 200, body: { enabled: true } })
    })
    test('empty body', () => {
        expect(parseInclude('HTTP/2.0 204 No Content\nX-A: b\n\n')).toEqual({
            status: 204,
            body: null,
        })
    })
    test('error status with message and CRLF', () => {
        const r = parseInclude(
            'HTTP/2.0 422 Unprocessable\r\nA: b\r\n\r\n{"message":"x"}',
        )
        expect(r.status).toBe(422)
        expect(r.body).toEqual({ message: 'x' })
    })
    test('garbage gives status 0', () => {
        expect(parseInclude('oops').status).toBe(0)
    })
})

describe('resolveRepo', () => {
    async function repoWith(url: string): Promise<string> {
        const dir = mkdtempSync(join(tmpdir(), 'vf-gh-'))
        await capture(['git', '-C', dir, 'init', '-q'])
        await capture(['git', '-C', dir, 'remote', 'add', 'origin', url])
        return dir
    }
    test('https and ssh forms', async () => {
        expect(
            await resolveRepo(await repoWith('https://github.com/o/r.git')),
        ).toBe('o/r')
        expect(
            await resolveRepo(await repoWith('https://github.com/o/r')),
        ).toBe('o/r')
        expect(
            await resolveRepo(await repoWith('git@github.com:o/r.git')),
        ).toBe('o/r')
        expect(await resolveRepo(await repoWith('git@github.com:o/r'))).toBe(
            'o/r',
        )
    })
    test('rejects other hosts', async () => {
        await expect(
            resolveRepo(await repoWith('https://gitlab.com/o/r')),
        ).rejects.toThrow(/github\.com/)
    })
    test('override', async () => {
        expect(await resolveRepo('/nonexistent', 'a/b')).toBe('a/b')
        await expect(resolveRepo('/nonexistent', 'bad')).rejects.toThrow()
    })
})

describe('manualReminders', () => {
    test('base and ai-scan', () => {
        const a = manualReminders('o/r', false)
        expect(a).toHaveLength(1)
        expect(a[0]).toContain('Dependabot malware alerts')
        expect(a[0]).toContain(
            'https://github.com/o/r/settings/security_analysis',
        )
        expect(manualReminders('o/r', true)).toHaveLength(3)
    })
})
