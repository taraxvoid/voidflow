import { describe, expect, test } from 'bun:test'
import { flattenOrgs } from '../scripts/lib/orgs.ts'

describe('flattenOrgs', () => {
    test('flattens orgs.<org>.repos.<name> to "org/name" keys', () => {
        expect(
            flattenOrgs({
                orgs: {
                    taraxvoid: { repos: { voidflow: { x: 1 }, 'txv.sh': {} } },
                },
            }),
        ).toEqual({ 'taraxvoid/voidflow': { x: 1 }, 'taraxvoid/txv.sh': {} })
    })

    test('several orgs', () => {
        expect(
            flattenOrgs({
                orgs: {
                    a: { repos: { x: {} } },
                    b: { repos: { y: { n: 2 } } },
                },
            }),
        ).toEqual({ 'a/x': {}, 'b/y': { n: 2 } })
    })

    test('a legacy map is returned as is', () => {
        const legacy = { 'o/a': {}, 'o/orgs': {} }
        expect(flattenOrgs(legacy)).toBe(legacy)
        const weird = 'not an object'
        expect(flattenOrgs(weird)).toBe(weird)
        expect(flattenOrgs(null)).toBe(null)
    })

    test('empty orgs flattens to an empty map', () => {
        expect(flattenOrgs({ orgs: {} })).toEqual({})
    })

    test('reports every problem by path, at once', () => {
        let msg = ''
        try {
            flattenOrgs({
                orgs: {
                    bad: 1,
                    extra: { repos: {}, adminTokenEnv: 'X' },
                    norepos: {},
                    slash: { repos: { 'a/b': {} } },
                    entry: { repos: { e: 'nope', ok: {} } },
                },
                'o/r': {},
            })
        } catch (e) {
            msg = (e as Error).message
        }
        const lines = msg.split('\n')
        expect(lines).toContain(
            '"o/r": orgs cannot be mixed with other top-level keys',
        )
        expect(lines).toContain('orgs.bad: not an object')
        expect(
            lines.find((l) => l.startsWith('orgs.extra.adminTokenEnv:')),
        ).toContain('not supported yet')
        expect(lines).toContain('orgs.norepos: missing repos')
        expect(lines).toContain('orgs.slash.repos."a/b": name has a slash')
        expect(lines).toContain('orgs.entry.repos.e: not an object')
        expect(lines).toHaveLength(6)
    })

    test('orgs itself must be an object', () => {
        expect(() => flattenOrgs({ orgs: [] })).toThrow('orgs: not an object')
        expect(() => flattenOrgs({ orgs: { a: { repos: [] } } })).toThrow(
            'orgs.a.repos: not an object',
        )
    })
})
