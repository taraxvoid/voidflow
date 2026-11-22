import { describe, expect, test } from 'bun:test'
import { nounVerb } from '../scripts/lib/noun-verb.ts'

describe('nounVerb', () => {
    test('rulesets plan', () => {
        expect(nounVerb('rulesets', ['plan', '--repo', 'x'])).toEqual({
            verb: 'plan',
            argv: ['rulesets', '--repo', 'x'],
        })
    })
    test('tokens with the verb before or after the provider', () => {
        const want = { verb: 'apply', argv: ['tokens', 'cf', '--prune'] }
        expect(nounVerb('tokens', ['cf', 'apply', '--prune'])).toEqual(want)
        expect(nounVerb('tokens', ['apply', 'cf', '--prune'])).toEqual(want)
    })
    test('settings', () => {
        expect(nounVerb('settings', ['apply'])).toEqual({
            verb: 'apply',
            argv: ['settings'],
        })
    })
    test('skips flag values before the verb', () => {
        expect(nounVerb('tokens', ['cf', '--repo', 'x', 'apply'])).toEqual({
            verb: 'apply',
            argv: ['tokens', 'cf', '--repo', 'x'],
        })
        expect(nounVerb('tokens', ['cf', '--try', 'prod', 'check'])).toEqual({
            verb: 'check',
            argv: ['tokens', 'cf', '--try', 'prod'],
        })
        expect(
            nounVerb('tokens', ['--local-wrangler', 'plan', 'apply']),
        ).toEqual({
            verb: 'apply',
            argv: ['tokens', '--local-wrangler', 'plan'],
        })
    })
    test('a flag value or a command after -- is not a verb', () => {
        expect(nounVerb('rulesets', ['--repo', 'apply'])).toBeNull()
        expect(
            nounVerb('tokens', ['cf', '--try', 'prod', '--', 'apply']),
        ).toBeNull()
    })
    test('leaves per-tool and verb-first calls alone', () => {
        expect(nounVerb('rulesets', ['--apply'])).toBeNull()
        expect(nounVerb('tokens', ['cf', '--apply'])).toBeNull()
        expect(nounVerb('plan', ['rulesets'])).toBeNull()
    })
})
