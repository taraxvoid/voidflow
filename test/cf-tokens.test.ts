import { describe, expect, test } from 'bun:test'
import {
    REPOS,
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

const transbot = REPOS['taraxvoid/transbot']
const prod = transbot.envs[0]
const ids = { scriptTag: 'tag123', zoneIds: { 'transbot.net': 'zone456' } }
const acct = `com.cloudflare.api.account.${transbot.account}`
const now = new Date('2026-10-15T12:00:00Z')

const token = (over: Partial<Token> = {}): Token => ({
    id: 't1',
    name: tokenName('taraxvoid/transbot', 'prod'),
    policies: policies(transbot, prod, ids),
    expires_on: expiresOn(now),
    ...over,
})

describe('policies', () => {
    test('scope the editor groups to the one Worker by tag', () => {
        const [worker] = policies(transbot, prod, ids)
        expect(worker.resources).toEqual({
            [acct]: { 'com.cloudflare.edge.worker.script.tag123': '*' },
        })
    })

    test('grant routes write on the configured zones only, never zone.*', () => {
        const zone = policies(transbot, prod, ids)[1]
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
        expect(wide(policies(transbot, prod, ids))).toEqual([])
        const fb = wide(
            policies(
                transbot,
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
            policies(transbot, prod, { scriptTag: 't', zoneIds: {} }),
        ).toThrow('transbot.net')
    })

    test('every env has a unique token name', () => {
        const names = Object.entries(REPOS).flatMap(([repo, cfg]) =>
            cfg.envs.map((e) => tokenName(repo, e.env)),
        )
        expect(new Set(names).size).toBe(names.length)
    })
})

describe('accounts', () => {
    // dev/staging in one account, prod in another (ravenflight's shape).
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
    const want = policies(transbot, prod, ids)

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

    test('keeps the latest-expiring duplicate and deletes the rest', () => {
        const old = token({ id: 'old', expires_on: expiresOn(now, 30) })
        const fresh = token({ id: 'new' })
        const acts = plan(want, [old, fresh], now)
        expect(
            acts.map((a) => [a.kind, 'token' in a ? a.token.id : '']),
        ).toEqual([
            ['delete', 'old'],
            ['ok', 'new'],
        ])
    })
})
