import { describe, expect, test } from 'bun:test'
import { planSync } from '../scripts/sync-next.ts'

describe('planSync', () => {
    test('moves next when it is behind the live stable version', () => {
        expect(
            planSync('1.1.0', { latest: '1.1.0', next: '1.1.0-next.2' }).action,
        ).toBe('move')
        expect(
            planSync('1.1.0', { latest: '1.1.0', next: '1.0.0' }).action,
        ).toBe('move')
        expect(planSync('1.1.0', { latest: '1.1.0' }).action).toBe('move')
    })

    test('leaves a newer canary alone', () => {
        expect(
            planSync('1.1.0', { latest: '1.1.0', next: '1.2.0-next.1' }).action,
        ).toBe('skip')
        expect(
            planSync('1.1.0', { latest: '1.1.0', next: '1.1.0' }).action,
        ).toBe('skip')
    })

    test('refuses a version that is not latest yet', () => {
        expect(() =>
            planSync('1.1.0', { latest: '1.0.0', next: '1.1.0-next.2' }),
        ).toThrow(/not the current latest/)
        expect(() => planSync('1.1.0', {})).toThrow(/not the current latest/)
    })

    test('refuses a non-stable version', () => {
        expect(() =>
            planSync('1.1.0-next.2', { latest: '1.1.0-next.2' }),
        ).toThrow(/not a stable/)
    })
})
