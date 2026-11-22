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
    test('leaves per-tool and verb-first calls alone', () => {
        expect(nounVerb('rulesets', ['--apply'])).toBeNull()
        expect(nounVerb('tokens', ['cf', '--apply'])).toBeNull()
        expect(nounVerb('plan', ['rulesets'])).toBeNull()
    })
})
