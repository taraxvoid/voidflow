import { describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    applyVersion,
    canaryVersion,
    NO_RELEASE_PR,
    proposedVersion,
} from '../scripts/canary-version.ts'
import {
    assertVersionMatchesChannel,
    resolveChannel,
} from '../scripts/release-channel.ts'

const pr = (title: string, headRefName = 'release-please--branches--main') => ({
    title,
    headRefName,
})

describe('proposedVersion', () => {
    test('reads the version from the release PR title', () => {
        expect(
            proposedVersion([
                pr('feat: unrelated', 'feature/x'),
                pr('chore(main): release 1.1.0'),
            ]),
        ).toBe('1.1.0')
        expect(
            proposedVersion([
                pr(
                    'chore(main): release voidflow 1.0.1',
                    'release-please--branches--main--components--voidflow',
                ),
            ]),
        ).toBe('1.0.1')
    })

    test('refuses when there is no release PR', () => {
        expect(() => proposedVersion([])).toThrow(NO_RELEASE_PR)
        expect(() =>
            proposedVersion([pr('chore(main): release 1.1.0', 'feature/x')]),
        ).toThrow(NO_RELEASE_PR)
        expect(() =>
            proposedVersion([pr('chore(release/1.x): release 1.0.2')]),
        ).toThrow(NO_RELEASE_PR)
    })

    test('refuses on conflicting proposals', () => {
        expect(() =>
            proposedVersion([
                pr('chore(main): release 1.1.0'),
                pr('chore(main): release 1.2.0'),
            ]),
        ).toThrow(/different versions/)
    })
})

describe('canaryVersion', () => {
    test('proposed version plus commit count', () => {
        expect(canaryVersion('1.1.0', 2)).toBe('1.1.0-next.2')
    })

    test('grows with commits while the proposal stays put', () => {
        expect(canaryVersion('1.1.0', 3) > canaryVersion('1.1.0', 2)).toBe(true)
    })

    test('rejects a non-stable proposal and an empty range', () => {
        expect(() => canaryVersion('1.1.0-next.1', 2)).toThrow(/not X\.Y\.Z/)
        expect(() => canaryVersion('1.1.0', 0)).toThrow(/nothing to canary/)
    })

    test('passes the canary channel check', () => {
        assertVersionMatchesChannel(
            canaryVersion('1.0.1', 5),
            resolveChannel('main', { canary: true }),
        )
    })
})

describe('applyVersion', () => {
    test('writes package.json, jsr.json and the VOIDFLOW pin', () => {
        const root = mkdtempSync(join(tmpdir(), 'canary-'))
        for (const f of ['package.json', 'jsr.json']) {
            cpSync(join(import.meta.dir, '..', f), join(root, f))
        }
        cpSync(join(import.meta.dir, '../agentic'), join(root, 'agentic'), {
            recursive: true,
        })
        applyVersion(root, '9.9.9-next.4')
        for (const f of ['package.json', 'jsr.json']) {
            expect(
                JSON.parse(readFileSync(join(root, f), 'utf8')).version,
            ).toBe('9.9.9-next.4')
        }
        expect(
            readFileSync(
                join(root, 'agentic/workflows/deps-review.md'),
                'utf8',
            ),
        ).toContain('VOIDFLOW: "9.9.9-next.4" # x-release-please-version')
    })
})
