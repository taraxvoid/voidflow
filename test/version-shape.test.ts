import { describe, expect, test } from 'bun:test'
import {
    isCanaryVersion,
    isStableVersion,
} from '../scripts/lib/version-shape.ts'

describe('version shapes', () => {
    test('stable is X.Y.Z', () => {
        expect(isStableVersion('1.10.0')).toBe(true)
        for (const v of ['', '1.0', '1.0.0.0', '1.0.x', '1..0', '1.0.0-next.1'])
            expect(isStableVersion(v)).toBe(false)
    })

    test('canary is X.Y.Z-next.N', () => {
        expect(isCanaryVersion('1.1.0-next.12')).toBe(true)
        for (const v of [
            '1.1.0',
            '1.1.0-next',
            '1.1.0-next.',
            '1.1.0-next.1.2',
        ])
            expect(isCanaryVersion(v)).toBe(false)
    })

    test('oversized input is rejected', () => {
        const big = '9'.repeat(100_000)
        expect(isStableVersion(`${big}.0.0`)).toBe(false)
        expect(isCanaryVersion(`1.0.0-next.${big}`)).toBe(false)
    })
})
