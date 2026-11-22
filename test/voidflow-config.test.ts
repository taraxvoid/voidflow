import { describe, expect, test } from 'bun:test'
import {
    adminTokenVar,
    checkVoidflowConfig,
    defaultsFor,
    enabledGroups,
    GROUPS,
    renderDefaultsTable,
    toFleet,
    toTokenRepos,
} from '../config/index.ts'
import { type Ruleset, site, tool } from '../rulesets/index.ts'

const ACCT = '0123456789abcdef0123456789abcdef'

const validRuleset = {
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'deletion' }],
} satisfies Ruleset

/** The message `checkVoidflowConfig` throws for `x`. */
function problems(x: unknown): string {
    try {
        checkVoidflowConfig(x)
    } catch (e) {
        return (e as Error).message
    }
    throw new Error('expected checkVoidflowConfig to throw')
}

describe('site()', () => {
    test('is tool() plus the legacy retire list', () => {
        expect(site()).toEqual({
            ...tool(),
            retire: ['next (staging)', 'live (prod)'],
        })
        expect(site({ retire: [] }).retire).toEqual([])
    })
})

describe('defaultsFor', () => {
    test('picks by kind', () => {
        expect(defaultsFor('tool')).toEqual(tool())
        expect(defaultsFor('site')).toEqual(site())
    })
})

describe('checkVoidflowConfig', () => {
    test('accepts the minimal file', () => {
        expect(checkVoidflowConfig({ kind: 'tool' }).kind).toBe('tool')
    })

    test('kind is required and must be site or tool', () => {
        expect(problems({})).toContain('kind: missing')
        expect(problems({ kind: 'sit' })).toContain('kind: unknown "sit"')
    })

    test('unknown top-level keys are errors by path', () => {
        expect(problems({ kind: 'tool', tires: [] })).toContain(
            'tires: unknown field',
        )
    })

    test('accepts a settings section with every group', () => {
        const cfg = checkVoidflowConfig({
            kind: 'tool',
            settings: {
                enable: [...GROUPS],
                skip: ['codeql', 'label-low-risk', 'label-relock-actions'],
            },
        })
        expect(cfg.settings?.enable).toEqual([...GROUPS])
        expect(checkVoidflowConfig({ kind: 'tool', settings: {} })).toBeTruthy()
    })

    test('settings problems are reported under settings', () => {
        const p = (settings: unknown) => problems({ kind: 'tool', settings })
        expect(p([])).toContain('settings: not an object')
        expect(p({ enabel: [] })).toContain('settings.enabel: unknown field')
        expect(p({ enable: 'agentic' })).toContain(
            'settings.enable: not a list of strings',
        )
        expect(p({ skip: [1] })).toContain(
            'settings.skip: not a list of strings',
        )
        expect(p({ enable: ['agentik'] })).toContain(
            'settings.enable: unknown group "agentik"',
        )
        expect(p({ enable: ['pvr', 'pvr'] })).toContain(
            'settings.enable: pvr is listed twice',
        )
        expect(p({ skip: ['codeqll'] })).toContain(
            'settings.skip: unknown setting "codeqll"',
        )
        expect(p({ skip: ['codeql', 'codeql'] })).toContain(
            'settings.skip: codeql is listed twice',
        )
        expect(p({ skip: ['label-low-risk'] })).toContain(
            'settings.skip: label-low-risk is in agentic, which settings.enable does not list',
        )
    })

    test('actions-relock enables actions-lock', () => {
        expect([...enabledGroups(['actions-relock'])]).toEqual([
            'actions-relock',
            'actions-lock',
        ])
    })

    test('rulesets problems are reported under rulesets', () => {
        expect(problems({ kind: 'tool', rulesets: { chekcs: [] } })).toContain(
            'rulesets.chekcs: unknown field',
        )
        expect(problems({ kind: 'tool', rulesets: { checks: 'x' } })).toContain(
            'rulesets.checks: not a list',
        )
    })

    test('the raw form is accepted, retire optional', () => {
        for (const rulesets of [
            { raw: [validRuleset], retire: ['old'] },
            { raw: [validRuleset] },
        ])
            expect(() =>
                checkVoidflowConfig({ kind: 'tool', rulesets }),
            ).not.toThrow()
    })

    test('raw problems are reported under rulesets.raw', () => {
        const p = problems({ kind: 'tool', rulesets: { raw: 'x' } })
        expect(p).toContain('rulesets.raw: not a list')
        const q = problems({
            kind: 'tool',
            rulesets: { raw: [{}], retire: 'x' },
        }).split('\n')
        expect(q).toContain('rulesets.raw[0].name: missing')
        expect(q).toContain('rulesets.retire: not a list')
    })

    test('raw takes no tier fields', () => {
        expect(
            problems({
                kind: 'tool',
                rulesets: { raw: [validRuleset], checks: ['a'] },
            }),
        ).toContain('rulesets.checks: unknown field')
    })

    test('the old rulesets.rulesets spelling says it was renamed', () => {
        expect(
            problems({
                kind: 'tool',
                rulesets: { rulesets: [validRuleset], retire: [] },
            }),
        ).toBe(
            'rulesets.rulesets: renamed; spell rulesets out in full as rulesets.raw',
        )
    })

    test('cloudflare takes the fleet entry shape', () => {
        expect(() =>
            checkVoidflowConfig({
                kind: 'site',
                cloudflare: {
                    account: ACCT,
                    adminTokenEnv: 'CF_TOKEN_ADMIN_Q',
                    envs: [{ env: 'prod' }],
                },
            }),
        ).not.toThrow()
        expect(
            problems({ kind: 'site', cloudflare: { account: ACCT } }),
        ).toContain('cloudflare.envs: not a list')
        expect(
            problems({
                kind: 'site',
                cloudflare: { account: 'abc', envs: [{ env: 'prod' }] },
            }),
        ).toContain('cloudflare.account: not a 32-hex account id')
        expect(
            problems({
                kind: 'site',
                cloudflare: { account: ACCT, envs: [{}] },
            }),
        ).toContain('cloudflare.envs[0].env: missing')
        expect(
            problems({
                kind: 'site',
                cloudflare: {
                    account: ACCT,
                    envs: [{ env: 'prod' }],
                    adminTokenEnv: 'not a var',
                },
            }),
        ).toContain(
            'cloudflare.adminTokenEnv: not an environment variable name',
        )
        for (const adminTokenEnv of [
            'CLOUDFLARE_API_TOKEN',
            'GH_TOKEN',
            'GITHUB_TOKEN',
        ])
            expect(
                problems({
                    kind: 'site',
                    cloudflare: {
                        account: ACCT,
                        envs: [{ env: 'prod' }],
                        adminTokenEnv,
                    },
                }),
            ).toContain(`${adminTokenEnv} is reserved`)
        expect(
            problems({
                kind: 'site',
                cloudflare: {
                    account: ACCT,
                    envs: [{ env: 'prod' }],
                    extra: 1,
                },
            }),
        ).toContain('cloudflare.extra: unknown field')
        expect(problems({ kind: 'site', cloudflare: 1 })).toContain(
            'cloudflare: not an object',
        )
    })

    test('reports every problem at once', () => {
        const msg = problems({ kind: 'sit', tires: [] })
        expect(msg).toContain('kind: unknown')
        expect(msg).toContain('tires: unknown field')
    })
})

describe('toFleet', () => {
    test('fills defaults under the repo key', () => {
        expect(toFleet({ kind: 'site' }, 'o/n')).toEqual({ 'o/n': site() })
    })

    test('an override beats the kind default', () => {
        const fleet = toFleet({ kind: 'site', rulesets: { retire: [] } }, 'o/n')
        expect(fleet['o/n']).toMatchObject({ retire: [] })
        const tiered = toFleet(
            { kind: 'tool', rulesets: { checks: ['a'] } },
            'o/n',
        )
        expect(tiered['o/n']).toMatchObject({ checks: ['a'] })
    })

    test('the raw form passes through', () => {
        const fleet = toFleet(
            { kind: 'tool', rulesets: { raw: [validRuleset] } },
            'o/n',
        )
        expect(fleet['o/n']).toEqual({ rulesets: [validRuleset], retire: [] })
    })
})

describe('toTokenRepos', () => {
    test('keys the cloudflare section by the repo, retire defaulted', () => {
        expect(
            toTokenRepos(
                {
                    kind: 'site',
                    cloudflare: {
                        account: ACCT,
                        adminTokenEnv: 'Q',
                        envs: [{ env: 'prod' }],
                    },
                },
                'o/n',
            ),
        ).toEqual({
            'o/n': { account: ACCT, envs: [{ env: 'prod' }], retire: [] },
        })
    })

    test('throws without a cloudflare section', () => {
        expect(() => toTokenRepos({ kind: 'site' }, 'o/n')).toThrow(
            'no cloudflare section',
        )
    })
})

describe('adminTokenVar', () => {
    test('defaults to CF_TOKEN_ADMIN', () => {
        expect(adminTokenVar({ account: ACCT, envs: [] })).toBe(
            'CF_TOKEN_ADMIN',
        )
        expect(
            adminTokenVar({ account: ACCT, envs: [], adminTokenEnv: 'X_Y' }),
        ).toBe('X_Y')
    })
})

describe('renderDefaultsTable', () => {
    test('lists both kinds', () => {
        const table = renderDefaultsTable()
        expect(table).toMatch(/^\| tool /m)
        expect(table).toMatch(/^\| site .*next \(staging\)/m)
    })
})
