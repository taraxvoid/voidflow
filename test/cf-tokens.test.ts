import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
    checkRepos,
    D1_WRITE,
    expiresOn,
    fromWrangler,
    missingWorkerMessage,
    missingZoneMessage,
    type Policy,
    plan,
    policies,
    RENEW_DAYS,
    type RepoConfig,
    repoAccounts,
    resolveTarget,
    retireTargets,
    routeHost,
    sameToken,
    type Token,
    tokenName,
    WORKERS_ROUTES_WRITE,
    WORKERS_SCRIPTS_WRITE,
    wranglerWarnings,
    zoneOf,
} from '../cloudflare/tokens.ts'
import { tryChildEnv } from '../scripts/cf-tokens.ts'

// A fleet like taraxvoid/infra's cf-tokens.ts (the real one lives there).
const REPOS: Record<string, RepoConfig> = {
    'taraxvoid/example_project': {
        account: 'c6a445a43a801403a8e33968be40c19c',
        envs: [{ env: 'prod' }],
        retire: ['example_project-deploy-token'],
    },
    'taraxvoid/taraxvoid.net': {
        account: 'c6a445a43a801403a8e33968be40c19c',
        envs: [{ env: 'prod' }, { env: 'preview', zones: [] }],
        retire: [],
    },
}
const example_project = REPOS['taraxvoid/example_project']
const prod = example_project.envs[0]
const ids = {
    scriptTag: 'tag123',
    zoneIds: { 'example_project.net': 'zone456' },
}
const acct = `com.cloudflare.api.account.${example_project.account}`
const now = new Date('2026-10-15T12:00:00Z')

const token = (over: Partial<Token> = {}): Token => ({
    id: 't1',
    name: tokenName('taraxvoid/example_project', 'prod'),
    policies: policies(example_project, prod, ids),
    expires_on: expiresOn(now),
    ...over,
})

describe('policies', () => {
    test('scope the editor groups to the one Worker by tag', () => {
        const [worker] = policies(example_project, prod, ids)
        expect(worker.resources).toEqual({
            [acct]: { 'com.cloudflare.edge.worker.script.tag123': '*' },
        })
    })

    test('grant routes write on the configured zones only, never zone.*', () => {
        const zone = policies(example_project, prod, ids)[1]
        expect(zone.permission_groups).toEqual([{ id: WORKERS_ROUTES_WRITE }])
        // Same shape the dashboard produces for "Specific zone".
        expect(zone.resources).toEqual({
            'com.cloudflare.api.account.zone.zone456': '*',
        })
        expect(JSON.stringify(zone)).not.toContain('zone.*')
    })

    test('no account-wide grant unless a fallback is recorded', () => {
        const wide = (ps: Policy[]) =>
            ps.filter((p) => p.resources[acct] === '*')
        expect(wide(policies(example_project, prod, ids))).toEqual([])
        const fb = wide(
            policies(
                example_project,
                {
                    ...prod,
                    fallback: { reason: 'custom-domain', since: '2026-10-15' },
                },
                ids,
            ),
        )
        expect(fb.map((p) => p.permission_groups)).toEqual([
            [{ id: WORKERS_SCRIPTS_WRITE }],
        ])
    })

    test('no D1 grant unless the env sets d1', () => {
        const groups = policies(example_project, prod, ids).flatMap(
            (p) => p.permission_groups,
        )
        expect(groups).not.toContainEqual({ id: D1_WRITE })
        expect(policies(example_project, { ...prod, d1: false }, ids)).toEqual(
            policies(example_project, prod, ids),
        )
    })

    test("d1 adds D1 Write on the env's own account, in its own policy", () => {
        const d1 = policies(example_project, { ...prod, d1: true }, ids).filter(
            (p) => p.permission_groups.some((g) => g.id === D1_WRITE),
        )
        expect(d1).toEqual([
            {
                effect: 'allow',
                permission_groups: [{ id: D1_WRITE }],
                resources: { [acct]: '*' },
            },
        ])
        const other = { ...prod, d1: true, account: 'e'.repeat(32) }
        expect(policies(example_project, other, ids).at(-1)?.resources).toEqual(
            { [`com.cloudflare.api.account.${'e'.repeat(32)}`]: '*' },
        )
    })

    test('a zone without an id fails rather than widening', () => {
        expect(() =>
            policies(example_project, prod, { scriptTag: 't', zoneIds: {} }, [
                'example_project.net',
            ]),
        ).toThrow('example_project.net')
    })

    test('every env has a unique token name', () => {
        const names = Object.entries(REPOS).flatMap(([repo, cfg]) =>
            cfg.envs.map((e) => tokenName(repo, e.env)),
        )
        expect(new Set(names).size).toBe(names.length)
    })

    test('canonicalizes repository casing in token names', () => {
        expect(tokenName('TaraXVoid/Example_Project', 'prod')).toBe(
            'voidflow:taraxvoid/example_project:prod',
        )
    })
})

describe('accounts', () => {
    // dev/staging in one account, prod in another.
    const split: RepoConfig = {
        account: 'proddd',
        envs: [
            { env: 'dev', worker: 'api-dev', zones: [], account: 'devvv' },
            { env: 'prod', worker: 'api', zones: [] },
        ],
        retire: ['old-prod', { account: 'devvv', name: 'old-dev' }],
    }
    const ids0 = { scriptTag: 'tag', zoneIds: {} }

    test("an env's policies name its own account, else the repo's", () => {
        const [dev, prod] = split.envs.map(
            (e) => Object.keys(policies(split, e, ids0)[0].resources)[0],
        )
        expect(dev).toBe('com.cloudflare.api.account.devvv')
        expect(prod).toBe('com.cloudflare.api.account.proddd')
    })

    test("a fallback stays inside the env's account", () => {
        const dev = {
            ...split.envs[0],
            fallback: { reason: 'custom-domain', since: '2026-10-15' },
        }
        const wide = policies(split, dev, ids0).at(-1)
        expect(wide?.resources).toEqual({
            'com.cloudflare.api.account.devvv': '*',
        })
    })

    test("bare retire names resolve to the repo's account", () => {
        expect(retireTargets(split)).toEqual([
            { account: 'proddd', name: 'old-prod' },
            { account: 'devvv', name: 'old-dev' },
        ])
    })

    test('a repo touches each account once', () => {
        expect(repoAccounts(split).sort()).toEqual(['devvv', 'proddd'])
    })
})

describe('expiresOn', () => {
    test('ends the UTC day TTL days out', () => {
        expect(expiresOn(now, 90)).toBe('2027-01-13T23:59:59Z')
    })
})

describe('plan', () => {
    const want = policies(example_project, prod, ids)

    test('creates a missing token', () => {
        expect(plan(want, [], now).map((a) => a.kind)).toEqual(['create'])
    })

    test('is ok when only order and API-added fields differ', () => {
        const shuffled = token({
            policies: [...want].reverse().map((p, i) => ({
                ...p,
                id: `p${i}`,
                permission_groups: [...p.permission_groups]
                    .reverse()
                    .map((g) => ({ ...g, name: 'cosmetic' })),
            })),
        })
        expect(plan(want, [shuffled], now).map((a) => a.kind)).toEqual(['ok'])
    })

    test('updates in place when policies drift', () => {
        const narrower = token({ policies: [want[0]] })
        expect(plan(want, [narrower], now).map((a) => a.kind)).toEqual([
            'update',
        ])
    })

    test('rotates inside the renewal window, when expired, or without expiry', () => {
        const at = (days: number) =>
            new Date(now.getTime() + days * 86_400_000).toISOString()
        for (const expires_on of [at(RENEW_DAYS - 1), at(-1), null]) {
            const [a] = plan(want, [token({ expires_on })], now)
            expect(a.kind).toBe('rotate')
        }
        const later = token({ expires_on: at(RENEW_DAYS + 1) })
        expect(plan(want, [later], now)[0].kind).toBe('ok')
    })

    test('rotates on request', () => {
        expect(plan(want, [token()], now, { rotate: true })[0].kind).toBe(
            'rotate',
        )
    })

    // A token's value can't be read back, so a token whose GitHub secret is
    // gone (repo recreated, secret deleted) is useless: replace it.
    test('rotates when the GitHub secret is missing', () => {
        const [a] = plan(want, [token({ id: 'old' })], now, {
            secretMissing: true,
        })
        expect(a.kind).toBe('rotate')
        expect(a.kind === 'rotate' && a.reason).toBe('secret not set')
        expect(a.kind === 'rotate' && a.tokens.map((t) => t.id)).toEqual([
            'old',
        ])
    })

    test('still creates when both the token and the secret are missing', () => {
        expect(
            plan(want, [], now, { secretMissing: true }).map((a) => a.kind),
        ).toEqual(['create'])
    })

    test('a legacy-cased name is renamed even when policies match', () => {
        const legacy = token({
            name: 'voidflow:TaraXVoid/Example_Project:prod',
        })
        const [a] = plan(want, [legacy], now, {
            name: tokenName('taraxvoid/example_project', 'prod'),
        })
        expect(a.kind).toBe('update')
    })

    test('sameToken folds the repo case but keeps the env exact', () => {
        expect(
            sameToken('voidflow:Owner/Repo:prod', 'voidflow:owner/repo:prod'),
        ).toBe(true)
        expect(
            sameToken('voidflow:owner/repo:PROD', 'voidflow:owner/repo:prod'),
        ).toBe(false)
    })

    test('a rotation replaces the token it found', () => {
        const [a] = plan(want, [token({ id: 'old' })], now, { rotate: true })
        expect(a.kind === 'rotate' && a.tokens.map((t) => t.id)).toEqual([
            'old',
        ])
    })

    // Either duplicate may be the one in the GitHub secret (a stop between
    // create and secret write leaves the newer one unused), so neither is
    // kept: a fresh token goes into the secret, then both are deleted.
    test('rotates away duplicates instead of guessing which one is live', () => {
        const old = token({ id: 'old', expires_on: expiresOn(now, 30) })
        const fresh = token({ id: 'new' })
        const acts = plan(want, [old, fresh], now)
        expect(acts).toHaveLength(1)
        const [a] = acts
        expect(a.kind).toBe('rotate')
        expect(a.kind === 'rotate' && a.tokens.map((t) => t.id)).toEqual([
            'old',
            'new',
        ])
    })
})

describe('checkRepos', () => {
    const DEV = '189861042e47aa72c52e44fe4d18e723'
    const PROD = 'e632b9f816f9f2a62ed9571d352fd4ae'
    const good = {
        'example-org/site': {
            account: PROD,
            envs: [
                { env: 'dev', worker: 'site-dev', zones: [], account: DEV },
                { env: 'prod', worker: 'site', zones: ['example.com'] },
            ],
            retire: ['old', { account: DEV, name: 'old-dev' }],
        },
    }

    test('accepts a fleet and a split-account one', () => {
        expect(checkRepos(REPOS)).toBe(REPOS)
        expect(checkRepos(good)).toBe(good)
    })

    test('names every problem by its path', () => {
        const bad = {
            nope: { account: PROD, envs: [], retire: [] },
            'a/b': {
                account: 'not-hex',
                envs: [
                    {
                        env: 'prod',
                        worker: 3,
                        zones: 'example.com',
                        d1: 'yes',
                        account: 'x',
                        secret: 'org',
                        wranglr: 'wrangler.toml',
                    },
                    {
                        env: 'prod',
                        worker: 'w',
                        zones: [],
                        fallback: { reason: 'custom-domain' },
                    },
                    { env: 'a', secret: 'repo' },
                    { env: 'b', secret: 'repo' },
                ],
                retire: [{ name: 'old' }],
            },
        }
        let msg = ''
        try {
            checkRepos(bad)
        } catch (e) {
            msg = (e as Error).message
        }
        for (const want of [
            '"nope": key is not owner/name',
            '"nope".envs: empty',
            '"a/b".account: not a 32-hex account id',
            '"a/b".envs[0].worker: not a name',
            "\"a/b\".envs[0].secret: 'env' or 'repo'",
            '"a/b".envs[0].wranglr: unknown field',
            '"a/b".envs[3].secret: a second \'repo\' env',
            '"a/b".envs[0].zones: not a list of zone names',
            '"a/b".envs[0].d1: not true or false',
            '"a/b".envs[0].account: not a 32-hex account id',
            '"a/b".envs[1].env: duplicate "prod"',
            '"a/b".envs[1].fallback: needs reason and since',
            '"a/b".retire[0]: a name or { account, name }',
        ]) {
            expect(msg).toContain(want)
        }
    })

    test('rejects a config that is not an object of repos', () => {
        expect(() => checkRepos(undefined)).toThrow('not an object')
        expect(() => checkRepos([])).toThrow('not an object')
    })
})

describe('wrangler config', () => {
    // Shaped like example_project's real config.
    const single = {
        name: 'example_project',
        routes: [{ pattern: 'example_project.net', custom_domain: true }],
    }
    const multi = {
        name: 'site',
        routes: ['old.example.com/*'],
        env: {
            preview: { name: 'site-preview', workers_dev: true },
            prod: {
                name: 'site-prod',
                routes: [
                    { pattern: 'example.com', custom_domain: true },
                    { pattern: 'www.example.com', custom_domain: true },
                    { pattern: 'dl.example.com', custom_domain: true },
                    { pattern: 'other.biz', custom_domain: true },
                    { pattern: 'api.example.net/*', zone_name: 'example.net' },
                ],
            },
            staging: {},
        },
    }
    const zones = [
        'example.com',
        'other.biz',
        'example_project.net',
        'sub.other.biz',
    ]

    test('routeHost strips scheme, path, port and a leading wildcard', () => {
        expect(routeHost('*.example.com/api/*')).toBe('example.com')
        expect(routeHost('*example.com/*')).toBe('example.com')
        expect(routeHost('https://a.example.com:443/')).toBe('a.example.com')
        expect(routeHost('example.com')).toBe('example.com')
    })

    test('zoneOf picks the longest zone the host is in, never a lookalike', () => {
        expect(zoneOf('www.example.com', zones)).toBe('example.com')
        expect(zoneOf('a.sub.other.biz', zones)).toBe('sub.other.biz')
        expect(zoneOf('notexample.com', zones)).toBeUndefined()
    })

    test('top level when there is no env block named like the env', () => {
        expect(fromWrangler(single, 'prod')).toEqual({
            worker: 'example_project',
            hosts: ['example_project.net'],
            zones: [],
        })
    })

    test("an env block's name and routes, and a route's zone_name as is", () => {
        const t = fromWrangler(multi, 'prod')
        expect(t.worker).toBe('site-prod')
        expect(t.hosts).toEqual([
            'example.com',
            'www.example.com',
            'dl.example.com',
            'other.biz',
        ])
        expect(t.zones).toEqual(['example.net'])
    })

    test("like wrangler: no name is <name>-<env>, no routes inherits the top level's", () => {
        expect(fromWrangler(multi, 'staging')).toEqual({
            worker: 'site-staging',
            hosts: ['old.example.com'],
            zones: [],
            block: 'staging',
        })
    })

    test('wranglerEnv picks a block, and a missing one fails', () => {
        expect(fromWrangler(multi, 'live', 'prod').worker).toBe('site-prod')
        expect(fromWrangler(multi, 'live', 'prod').block).toBe('prod')
        expect(() => fromWrangler(multi, 'prod', 'nope')).toThrow('env.nope')
    })

    test("account_id comes from the env block, else the top level's", () => {
        const a = 'a'.repeat(32)
        const b = 'b'.repeat(32)
        const cfg = {
            name: 's',
            account_id: a,
            env: { preview: {}, other: { account_id: b } },
        }
        expect(fromWrangler(cfg, 'preview').account).toBe(a)
        expect(fromWrangler(cfg, 'other').account).toBe(b)
        expect(fromWrangler(single, 'prod').account).toBeUndefined()
    })

    test('resolveTarget maps routes to deduplicated account zones', () => {
        expect(resolveTarget({ env: 'prod' }, multi, zones)).toEqual({
            worker: 'site-prod',
            zones: ['example.com', 'example.net', 'other.biz'],
        })
    })

    test('a route outside every account zone fails instead of being dropped', () => {
        expect(() =>
            resolveTarget({ env: 'prod' }, single, ['example.com']),
        ).toThrow('example_project.net')
    })

    test("the env's own worker and zones win; zones: [] grants none", () => {
        expect(
            resolveTarget({ env: 'preview', zones: [] }, single, zones),
        ).toEqual({ worker: 'example_project', zones: [] })
        expect(
            resolveTarget(
                { env: 'x', worker: 'w', zones: ['a.org'] },
                undefined,
                [],
            ),
        ).toEqual({ worker: 'w', zones: ['a.org'] })
    })

    test('no zones at all points at Zone Read, not a missing zone', () => {
        expect(() => resolveTarget({ env: 'prod' }, single, [])).toThrow(
            'lacks Zone Read',
        )
        expect(() =>
            resolveTarget({ env: 'prod' }, single, ['example.com']),
        ).toThrow('Zone Read does not include it')
    })
})

describe('error messages', () => {
    const a = 'a'.repeat(32)

    test('an empty scripts list blames the permission before the Worker', () => {
        const m = missingWorkerMessage('site-preview', a, 0, 'preview')
        expect(m).toContain('lists no Workers')
        expect(m).toContain('Workers Metadata Read-Only')
        expect(m).toContain('wrangler deploy --env preview')
    })

    test('a Worker missing from a non-empty list names the deploy command', () => {
        const m = missingWorkerMessage('site-preview', a, 3, 'preview')
        expect(m).toContain('may not include it')
        expect(m).toContain('wrangler deploy --env preview')
        expect(m).toContain(`account_id ${a}`)
        expect(m).toContain('only Previews')
        expect(missingWorkerMessage('site', a, 3)).toContain(
            '(wrangler deploy, with',
        )
    })

    test('an unknown wrangler env guesses no deploy command', () => {
        const m = missingWorkerMessage('site-preview', a, 3, null)
        expect(m).not.toContain('(wrangler deploy,')
        expect(m).toContain('not the top-level one')
    })

    test('a missing zone hints at Zone Read either way', () => {
        expect(missingZoneMessage('x.com', a, [])).toContain('lacks Zone Read')
        expect(missingZoneMessage('x.com', a, ['y.com'])).toContain(
            'does not include it',
        )
    })
})

describe('wranglerWarnings', () => {
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    const used = { worker: 'site', hosts: ['example.com'], zones: [] }
    const base = { env: 'preview', account: a, file: 'wrangler.jsonc', used }

    test('quiet when the account matches and there is no local copy', () => {
        expect(wranglerWarnings(base)).toEqual([])
        expect(
            wranglerWarnings({ ...base, used: { ...used, account: a } }),
        ).toEqual([])
    })

    test("an account_id other than the env's account", () => {
        const [w] = wranglerWarnings({
            ...base,
            used: { ...used, account: b },
        })
        expect(w).toContain(`account_id ${b}, not the env's account ${a}`)
    })

    test('a local copy that resolves to another Worker', () => {
        const [w] = wranglerWarnings({
            ...base,
            local: { ...used, worker: 'site-preview', block: 'preview' },
        })
        expect(w).toContain('Worker site-preview')
        expect(w).toContain('which the plan uses')
        expect(
            wranglerWarnings({ ...base, local: { ...used, block: 'x' } }),
        ).toEqual([])
    })

    test('a local copy that does not resolve', () => {
        const [w] = wranglerWarnings({
            ...base,
            local: new Error('wrangler config has no name'),
        })
        expect(w).toContain('does not resolve (wrangler config has no name)')
    })
})

describe('tryChildEnv', () => {
    test('drops both admin variables and sets the throwaway token', () => {
        const acct = '0123456789abcdef0123456789abcdef'
        expect(
            tryChildEnv(
                {
                    CF_TOKEN_ADMIN_Q: 's',
                    CF_TOKEN_ADMIN: 't',
                    GH_TOKEN: 'g',
                    GITHUB_TOKEN: 'h',
                    A: '1',
                },
                'CF_TOKEN_ADMIN_Q',
                'tok',
                acct,
            ),
        ).toEqual({
            GH_TOKEN: 'g',
            GITHUB_TOKEN: 'h',
            A: '1',
            CLOUDFLARE_API_TOKEN: 'tok',
            CLOUDFLARE_ACCOUNT_ID: acct,
        })
    })
})

describe('voidflow tokens cf --repo-config', () => {
    const CLI = resolve(import.meta.dir, '..', 'scripts', 'cli.ts')
    const roots: string[] = []
    afterEach(() => {
        for (const r of roots.splice(0))
            rmSync(r, { recursive: true, force: true })
    })
    const CF = `export default { kind: 'site', cloudflare: { account: '${'c'.repeat(32)}', adminTokenEnv: 'CF_TOKEN_ADMIN_Q', envs: [{ env: 'prod' }] } }`

    /** Run `voidflow tokens cf` in a temp git dir holding `config` as voidflow.config.ts; `@file` in args is its path. */
    async function run(
        args: string[],
        config = CF,
        env: Record<string, string> = {},
        configInBase = false,
    ) {
        const root = mkdtempSync(join(tmpdir(), 'voidflow-cf-'))
        roots.push(root)
        mkdirSync(join(root, '.git'))
        const configDir = configInBase ? join(root, 'base') : root
        if (configInBase) mkdirSync(configDir)
        const file = join(configDir, 'voidflow.config.ts')
        writeFileSync(file, config)
        const proc = Bun.spawn(
            [
                'bun',
                CLI,
                'tokens',
                'cf',
                ...args.map((a) => (a === '@file' ? file : a)),
            ],
            {
                cwd: root,
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: 'o/n',
                    CF_TOKEN_ADMIN: '',
                    CF_TOKEN_ADMIN_Q: '',
                    VOIDFLOW_CONFIG_BASE: configInBase ? configDir : '',
                    ...env,
                },
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

    test('--repo-config and --config are alternatives', async () => {
        const r = await run(['--repo-config', '@file', '--config', 'x.ts'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--repo-config and --config are alternatives')
    })

    test('--repo does not apply with --repo-config', async () => {
        const r = await run(['--repo-config', '@file', '--repo', 'x'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('per-repo config')
    })

    test('--local-wrangler needs --repo-config', async () => {
        const r = await run(['--config', 'x.ts', '--local-wrangler', 'prod'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--local-wrangler reads the checkout')
    })

    test('--local-wrangler takes an env from the cloudflare section', async () => {
        const r = await run([
            '--repo-config',
            '@file',
            '--local-wrangler',
            'prod',
        ])
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('--local-wrangler rejects an env the config does not list', async () => {
        const r = await run([
            '--repo-config',
            '@file',
            '--local-wrangler',
            'preview',
        ])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--local-wrangler preview: no such env')
    })

    test('a config with no cloudflare section exits 2', async () => {
        const r = await run(
            ['--repo-config', '@file'],
            "export default { kind: 'site' }",
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('no cloudflare section')
    })

    test('a relative --repo-config resolves against the working directory', async () => {
        const r = await run(['--repo-config', 'voidflow.config.ts'])
        expect(r.err).not.toContain('Cannot find')
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('a relative --repo-config resolves against VOIDFLOW_CONFIG_BASE', async () => {
        const r = await run(
            ['--repo-config', 'voidflow.config.ts'],
            CF,
            {},
            true,
        )
        expect(r.err).not.toContain('Cannot find')
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('names the missing admin variable', async () => {
        const r = await run(['--repo-config', '@file'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('uses the named variable, not CF_TOKEN_ADMIN', async () => {
        const r = await run(['--repo-config', '@file'], CF, {
            CF_TOKEN_ADMIN: 'x',
        })
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('no repo slug exits 2 with the reason', async () => {
        const r = await run(['--repo-config', '@file'], CF, {
            GITHUB_REPOSITORY: '',
        })
        expect(r.code).toBe(2)
        expect(r.err).toContain('cannot tell which GitHub repo')
    })
})
