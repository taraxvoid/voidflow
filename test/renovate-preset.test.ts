import { describe, expect, test } from 'bun:test'

const preset = await Bun.file(new URL('../default.json', import.meta.url).pathname).json()

describe('renovate preset (default.json)', () => {
    test('gates updates on a 3-day release age except our own package', () => {
        expect(preset.minimumReleaseAge).toBe('3 days')
        const own = preset.packageRules.find((r: any) =>
            r.matchPackageNames?.includes('@taraxvoid/voidflow'),
        )
        expect(own.minimumReleaseAge).toBeNull()
    })

    test('uses conventional chore(deps) commits', () => {
        expect(preset.semanticCommits).toBe('enabled')
        expect(preset.semanticCommitType).toBe('chore')
        expect(preset.semanticCommitScope).toBe('deps')
    })

    test('custom manager regexes compile and capture the pinned versions', () => {
        const [pkg, lefthook, just] = preset.customManagers.map(
            (m: any) => new RegExp(m.matchStrings[0]),
        )
        expect(
            'bunx --package @taraxvoid/voidflow@0.9.0 unlighthouse-runner'.match(pkg)?.groups
                ?.currentValue,
        ).toBe('0.9.0')
        expect(
            'git_url: https://github.com/taraxvoid/voidflow\n    ref: v0.10.0'.match(lefthook)
                ?.groups?.currentValue,
        ).toBe('v0.10.0')
        expect(
            '# renovate: datasource=pypi depName=check-jsonschema\ncheck_jsonschema_version := "0.38.0"'.match(
                just,
            )?.groups?.currentValue,
        ).toBe('0.38.0')
    })
})
