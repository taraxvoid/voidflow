import { describe, expect, test } from 'bun:test'
import { parseWranglerConfig } from '../scripts/lib/wrangler-config.ts'

describe('parseWranglerConfig', () => {
    test('parses TOML', () => {
        const v = parseWranglerConfig(
            'wrangler.toml',
            'name = "w"\n[env.prod]\nname = "w-prod"\n',
        )
        expect(v).toEqual({ name: 'w', env: { prod: { name: 'w-prod' } } })
    })

    test('parses JSONC with comments and trailing commas', () => {
        const v = parseWranglerConfig(
            'wrangler.jsonc',
            '{\n  // worker\n  "name": "w", /* x */\n  "routes": ["a.example/*",],\n}\n',
        )
        expect(v).toEqual({ name: 'w', routes: ['a.example/*'] })
    })

    test('rejects malformed JSONC instead of returning a partial value', () => {
        expect(() =>
            parseWranglerConfig('wrangler.jsonc', '{"name": "w", "routes": [}'),
        ).toThrow(/wrangler\.jsonc/)
    })

    test('rejects malformed TOML', () => {
        expect(() => parseWranglerConfig('wrangler.toml', 'name = ')).toThrow()
    })
})
