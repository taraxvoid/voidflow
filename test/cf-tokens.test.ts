import { describe, expect, test } from 'bun:test'
import {
    checkRepos,
    fromWrangler,
    resolveTarget,
    routeHost,
    zoneOf,
    RENEW_DAYS,
    WORKERS_ROUTES_WRITE,
    WORKERS_SCRIPTS_WRITE,
    expiresOn,
    plan,
    policies,
    repoAccounts,
    retireTargets,
    tokenName,
    type RepoConfig,
    type Policy,
    type Token,
} from '../cloudflare/tokens.ts'

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
const ids = { scriptTag: 'tag123', zoneIds: { 'example_project.net': 'zone456' } }
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

    test('a rotation replaces the token it found', () => {
        const [a] = plan(want, [token({ id: 'old' })], now, { rotate: true })
        expect(a.kind === 'rotate' && a.tokens.map((t) => t.id)).toEqual(['old'])
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
            '"a/b".envs[0].secret: \'env\' or \'repo\'',
            '"a/b".envs[0].wranglr: unknown field',
            '"a/b".envs[3].secret: a second \'repo\' env',
            '"a/b".envs[0].zones: not a list of zone names',
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
    const zones = ['example.com', 'other.biz', 'example_project.net', 'sub.other.biz']

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
        })
    })

    test('wranglerEnv picks a block, and a missing one fails', () => {
        expect(fromWrangler(multi, 'live', 'prod').worker).toBe('site-prod')
        expect(() => fromWrangler(multi, 'prod', 'nope')).toThrow('env.nope')
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
            resolveTarget({ env: 'x', worker: 'w', zones: ['a.org'] }, undefined, []),
        ).toEqual({ worker: 'w', zones: ['a.org'] })
    })
})
