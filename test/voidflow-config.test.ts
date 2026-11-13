import { describe, expect, test } from 'bun:test'
import {
    checkVoidflowConfig,
    defaultsFor,
    renderDefaultsTable,
    toFleet,
} from '../config/index.ts'
import { site, tool } from '../rulesets/index.ts'

const validRuleset = {
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'deletion' }],
}

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

    test('rulesets problems are reported under rulesets', () => {
        expect(problems({ kind: 'tool', rulesets: { chekcs: [] } })).toContain(
            'rulesets.chekcs: unknown field',
        )
        expect(problems({ kind: 'tool', rulesets: { checks: 'x' } })).toContain(
            'rulesets.checks: not a list',
        )
    })

    test('the raw form is accepted', () => {
        expect(() =>
            checkVoidflowConfig({
                kind: 'tool',
                rulesets: { rulesets: [validRuleset], retire: [] },
            }),
        ).not.toThrow()
        expect(
            problems({
                kind: 'tool',
                rulesets: { rulesets: 'x', retire: [] },
            }),
        ).toContain('rulesets.rulesets: not a list')
    })

    test('cloudflare is validated', () => {
        expect(() =>
            checkVoidflowConfig({
                kind: 'site',
                cloudflare: {
                    account: 'abc123',
                    adminTokenEnv: 'CF_TOKEN_ADMIN',
                },
            }),
        ).not.toThrow()
        expect(problems({ kind: 'site', cloudflare: {} })).toContain(
            'cloudflare.account: missing',
        )
        expect(
            problems({
                kind: 'site',
                cloudflare: { account: 'a', adminTokenEnv: 'not a var' },
            }),
        ).toContain(
            'cloudflare.adminTokenEnv: not an environment variable name',
        )
        expect(
            problems({ kind: 'site', cloudflare: { account: 'a', extra: 1 } }),
        ).toContain('cloudflare.extra: unknown field')
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
        const raw = { rulesets: [validRuleset], retire: [] }
        const fleet = toFleet({ kind: 'tool', rulesets: raw }, 'o/n')
        expect(fleet['o/n']).toMatchObject({ rulesets: [validRuleset] })
    })
})

describe('renderDefaultsTable', () => {
    test('lists both kinds', () => {
        const table = renderDefaultsTable()
        expect(table).toMatch(/^\| tool /m)
        expect(table).toMatch(/^\| site .*next \(staging\)/m)
    })
})
