import { describe, expect, test } from 'bun:test'
import {
    DEFAULT_PROVIDER,
    PROVIDERS,
    providerOf,
    TOKEN_TOOLS,
} from '../scripts/lib/providers.ts'

describe('token providers', () => {
    test('cf maps to the cf-tokens tool', () => {
        expect(PROVIDERS.cf).toBe('cf-tokens')
    })

    test('providerOf reverses the mapping', () => {
        expect(providerOf('cf-tokens')).toBe('cf')
        expect(providerOf('rulesets')).toBeUndefined()
    })

    test('TOKEN_TOOLS lists every provider tool in registry order', () => {
        expect(TOKEN_TOOLS).toEqual(['cf-tokens'])
    })

    test('cf is the default provider', () => {
        expect(DEFAULT_PROVIDER).toBe('cf')
    })
})
