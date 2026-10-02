import { describe, expect, test } from 'bun:test'
import {
    assertVersionMatchesChannel,
    resolveChannel,
    toOutputs,
} from '../scripts/release-channel.ts'

describe('resolveChannel', () => {
    test('main is the stable channel on latest', () => {
        expect(resolveChannel('main')).toEqual({
            kind: 'stable',
            branch: 'main',
            distTag: 'latest',
            config: '.release-please/main.json',
            manifest: '.release-please/main-manifest.json',
            prerelease: false,
        })
    })

    test('next is the prerelease channel on the next dist-tag', () => {
        expect(resolveChannel('next')).toMatchObject({
            kind: 'prerelease',
            distTag: 'next',
            config: '.release-please/next.json',
            manifest: '.release-please/next-manifest.json',
            prerelease: true,
        })
    })

    test('release/0.9.x is maintenance with its own dist-tag, never latest', () => {
        const c = resolveChannel('release/0.9.x')
        expect(c.kind).toBe('maintenance')
        expect(c.distTag).toBe('release-0.9.x')
        expect(c.distTag).not.toBe('latest')
        expect(c.config).toBe('.release-please/maintenance.json')
        expect(c.manifest).toBe('.release-please/maintenance-manifest.json')
        expect(c.prerelease).toBe(false)
    })

    test('release/1.x maps to release-1.x', () => {
        expect(resolveChannel('release/1.x').distTag).toBe('release-1.x')
    })

    test.each([
        '',
        'main2',
        'Main',
        'feature/next',
        'refs/heads/main',
        'release/',
        'release/latest',
        'release/0.9.x-hotfix',
        'release/0.9',
        'release/0.9.x/extra',
        'worktree-foo',
    ])('fails closed on %p', (branch) => {
        expect(() => resolveChannel(branch)).toThrow(/no release channel/)
    })
})

describe('assertVersionMatchesChannel', () => {
    test('stable and maintenance accept plain versions only', () => {
        assertVersionMatchesChannel('0.10.0', resolveChannel('main'))
        assertVersionMatchesChannel('0.9.4', resolveChannel('release/0.9.x'))
        expect(() =>
            assertVersionMatchesChannel('0.10.0-next.1', resolveChannel('main')),
        ).toThrow(/does not belong/)
        expect(() =>
            assertVersionMatchesChannel('0.9.4-next.1', resolveChannel('release/0.9.x')),
        ).toThrow(/does not belong/)
    })

    test('maintenance accepts only versions on its own line', () => {
        const c = resolveChannel('release/0.9.x')
        assertVersionMatchesChannel('0.9.0', c)
        assertVersionMatchesChannel('0.9.12', c)
        expect(() => assertVersionMatchesChannel('0.10.0', c)).toThrow(/does not belong/)
        expect(() => assertVersionMatchesChannel('0.8.3', c)).toThrow(/does not belong/)
        expect(() => assertVersionMatchesChannel('1.9.0', c)).toThrow(/does not belong/)

        const major = resolveChannel('release/1.x')
        assertVersionMatchesChannel('1.4.2', major)
        expect(() => assertVersionMatchesChannel('2.0.0', major)).toThrow(/does not belong/)
        expect(() => assertVersionMatchesChannel('0.9.4', major)).toThrow(/does not belong/)
    })

    test('prerelease accepts release-please numbering: -next, then -next.N', () => {
        assertVersionMatchesChannel('0.10.0-next', resolveChannel('next'))
        assertVersionMatchesChannel('0.10.0-next.1', resolveChannel('next'))
        assertVersionMatchesChannel('0.10.0-next.3', resolveChannel('next'))
        expect(() => assertVersionMatchesChannel('0.10.0', resolveChannel('next'))).toThrow(
            /does not belong/,
        )
        expect(() =>
            assertVersionMatchesChannel('0.10.0-beta.1', resolveChannel('next')),
        ).toThrow(/does not belong/)
    })
})

describe('toOutputs', () => {
    test('stringifies every field the workflow reads', () => {
        expect(toOutputs(resolveChannel('next'))).toEqual({
            kind: 'prerelease',
            dist_tag: 'next',
            config: '.release-please/next.json',
            manifest: '.release-please/next-manifest.json',
            prerelease: 'true',
        })
    })
})

describe('cli', () => {
    const run = (...args: string[]) =>
        Bun.spawnSync(['bun', 'scripts/release-channel.ts', ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
        })

    test('prints key=value lines for a known branch', () => {
        const r = run('main')
        expect(r.exitCode).toBe(0)
        const out = r.stdout.toString()
        expect(out).toContain('dist_tag=latest\n')
        expect(out).toContain('prerelease=false\n')
    })

    test('exits 1 on an unknown branch', () => {
        const r = run('feature/x')
        expect(r.exitCode).toBe(1)
        expect(r.stderr.toString()).toContain('no release channel')
    })

    test('exits 1 when the version does not fit the channel', () => {
        expect(run('main', '0.10.0-next.1').exitCode).toBe(1)
        expect(run('next', '0.10.0-next.1').exitCode).toBe(0)
    })
})
