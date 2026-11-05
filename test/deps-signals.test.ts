import { describe, expect, test } from 'bun:test'
import {
    classifyChange,
    classifyFiles,
    diffManifest,
    diffPins,
    parseSpec,
    parseUses,
    pinRemote,
    registrySignals,
    registryUrl,
    tagMatches,
} from '../scripts/deps-signals.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const reasons = (flags: { reason: string }[]) => flags.map((f) => f.reason)

describe('parseSpec', () => {
    test('accepts exact, caret and tilde versions only', () => {
        expect(parseSpec('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
        expect(parseSpec('^1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
        expect(parseSpec('~0.4.0')).toEqual({ major: 0, minor: 4, patch: 0 })
        for (const s of [
            '>=1.0.0',
            '1.x',
            '1.2.3-beta.1',
            'npm:foo@1.0.0',
            'github:a/b',
            '*',
            'workspace:*',
        ]) {
            expect(parseSpec(s)).toBeNull()
        }
    })
})

describe('classifyFiles', () => {
    test('allows package.json, lockfiles and workflow files', () => {
        expect(
            classifyFiles([
                'package.json',
                'bun.lock',
                'pnpm-lock.yaml',
                '.github/workflows/ci.yml',
            ]),
        ).toEqual([])
    })

    test('flags anything else, including nested manifests and actions', () => {
        const flags = classifyFiles([
            'src/index.ts',
            'packages/a/package.json',
            'actions/x/action.yml',
            'mise.toml',
        ])
        expect(flags.map((f) => f.subject)).toEqual([
            'src/index.ts',
            'packages/a/package.json',
            'actions/x/action.yml',
            'mise.toml',
        ])
    })
})

describe('diffManifest', () => {
    test('lists version changes and flags additions, removals and other fields', () => {
        const base = {
            name: 'x',
            dependencies: { a: '^1.0.0', gone: '1.0.0' },
            devDependencies: { b: '2.0.0' },
        }
        const head = {
            name: 'x',
            packageManager: 'bun@1.4.4',
            dependencies: { a: '^1.1.0', fresh: '1.0.0' },
            devDependencies: { b: '2.0.0' },
        }
        const { changes, flags } = diffManifest(base, head)
        expect(changes).toEqual([{ name: 'a', from: '^1.0.0', to: '^1.1.0' }])
        expect(flags).toEqual([
            {
                subject: 'package.json#packageManager',
                reason: 'non-dependency field changed',
            },
            { subject: 'gone', reason: 'removed from dependencies' },
            { subject: 'fresh', reason: 'added to dependencies' },
        ])
    })
})

describe('classifyChange', () => {
    const change = (from: string, to: string) => ({ name: 'p', from, to })

    test('patch and minor on 1.0+ pass', () => {
        expect(classifyChange(change('^1.2.3', '^1.2.4'))).toEqual([])
        expect(classifyChange(change('1.2.3', '1.3.0'))).toEqual([])
    })

    test('majors, 0.x, downgrades and odd specs are flagged', () => {
        expect(reasons(classifyChange(change('^1.9.0', '^2.0.0')))).toEqual([
            'major update',
        ])
        expect(reasons(classifyChange(change('0.4.0', '0.4.1')))).toEqual([
            '0.x update (minor can break)',
        ])
        expect(reasons(classifyChange(change('1.3.0', '1.2.9')))).toEqual([
            'downgrade',
        ])
        expect(
            reasons(classifyChange(change('1.0.0', '1.1.0-rc.1')))[0],
        ).toStartWith('unverifiable')
    })
})

describe('registrySignals', () => {
    const c = { name: 'pkg', from: '^1.0.0', to: '^1.0.1' }
    const v = (over: any = {}) => ({
        _npmUser: { name: 'alice' },
        maintainers: [{ name: 'alice' }, { name: 'bob' }],
        dist: { attestations: { url: 'x' } },
        dependencies: { dep: '^1.0.0' },
        ...over,
    })
    const doc = (old: any, cur: any) => ({
        versions: { '1.0.0': old, '1.0.1': cur },
    })

    test('same publisher, no scripts, provenance kept, no new deps: clean', () => {
        expect(registrySignals(c, doc(v(), v()))).toEqual([])
        expect(
            registrySignals(c, doc(v(), v({ _npmUser: { name: 'bob' } }))),
        ).toEqual([])
    })

    test('flags a publisher who neither published nor maintained the old version', () => {
        expect(
            reasons(
                registrySignals(
                    c,
                    doc(v(), v({ _npmUser: { name: 'mallory' } })),
                ),
            )[0],
        ).toStartWith('published by mallory')
    })

    test('flags added or changed install scripts, dropped provenance and new dependencies', () => {
        const cur = v({
            scripts: { postinstall: 'node steal.js', test: 'x' },
            dist: {},
            dependencies: { dep: '^1.0.0', 'plain-crypto-js': '^4.2.1' },
        })
        expect(reasons(registrySignals(c, doc(v(), cur)))).toEqual([
            'postinstall script added or changed',
            'provenance attestation dropped',
            'new dependencies: plain-crypto-js',
        ])
    })

    test('a version missing from the registry is a flag, not a pass', () => {
        expect(
            reasons(registrySignals(c, { versions: { '1.0.0': v() } })),
        ).toEqual(['version missing from the registry'])
    })
})

describe('action pins', () => {
    test('parseUses keeps SHA pins and flags tags, branches and docker refs', () => {
        const yaml = [
            `      - uses: actions/checkout@${SHA_A} # v7.0.1`,
            '      - uses: ./actions/bun-install',
            '        uses: owner/x@v4',
            '      - uses: docker://alpine:3',
        ].join('\n')
        const { pins, flags } = parseUses(yaml)
        expect(pins).toEqual([
            { action: 'actions/checkout', sha: SHA_A, tag: 'v7.0.1' },
        ])
        expect(flags.map((f) => f.subject)).toEqual([
            'owner/x@v4',
            'docker://alpine:3',
        ])
    })

    test('diffPins verifies same-major bumps and flags new actions, majors and missing comments', () => {
        const base = [
            { action: 'a/one', sha: SHA_A, tag: 'v1.2.0' },
            { action: 'a/two', sha: SHA_A, tag: 'v4.0.0' },
            { action: 'a/three', sha: SHA_A, tag: 'v1' },
        ]
        const head = [
            { action: 'a/one', sha: SHA_B, tag: 'v1.3.0' },
            { action: 'a/two', sha: SHA_B, tag: 'v5.0.0' },
            { action: 'a/three', sha: SHA_B, tag: null },
            { action: 'a/four', sha: SHA_B, tag: 'v1' },
        ]
        const { verify, flags } = diffPins(base, head)
        expect(verify).toEqual([head[0]])
        expect(flags.map((f) => [f.subject, f.reason])).toEqual([
            ['a/two', 'major update'],
            ['a/three', 'pin has no version comment to verify'],
            ['a/four', 'new action'],
        ])
    })

    test('tagMatches prefers the peeled commit of an annotated tag', () => {
        const out = `${'c'.repeat(40)}\trefs/tags/v1.3.0\n${SHA_B}\trefs/tags/v1.3.0^{}\n`
        expect(tagMatches(out, 'v1.3.0', SHA_B)).toBe(true)
        expect(tagMatches(out, 'v1.3.0', 'c'.repeat(40))).toBe(false)
        expect(tagMatches(`${SHA_B}\trefs/tags/v2\n`, 'v2', SHA_B)).toBe(true)
        expect(tagMatches('', 'v2', SHA_B)).toBe(false)
    })

    test('parseUses stays linear on a long run of blanks', () => {
        const start = performance.now()
        parseUses(`${' \t'.repeat(50_000)}x`)
        expect(performance.now() - start).toBeLessThan(500)
    })

    test('pinRemote accepts GitHub repos and plain tags only', () => {
        const pin = (action: string, tag: string | null) => ({
            action,
            sha: SHA_A,
            tag,
        })
        expect(pinRemote(pin('actions/checkout', 'v4.2.2'))).toBe(
            'https://github.com/actions/checkout',
        )
        expect(pinRemote(pin('github/codeql-action/upload-sarif', 'v4'))).toBe(
            'https://github.com/github/codeql-action',
        )
        expect(pinRemote(pin('a/b', '--upload-pack=x'))).toBeNull()
        expect(pinRemote(pin('-x/b', 'v1'))).toBeNull()
        expect(pinRemote(pin('../b', 'v1'))).toBeNull()
        expect(pinRemote(pin('a/..', 'v1'))).toBeNull()
        expect(pinRemote(pin('a/b', null))).toBeNull()
    })
})

describe('registryUrl', () => {
    test('encodes the scope slash and rejects names npm would not accept', () => {
        expect(registryUrl('left-pad')).toBe(
            'https://registry.npmjs.org/left-pad',
        )
        expect(registryUrl('@types/node')).toBe(
            'https://registry.npmjs.org/@types%2Fnode',
        )
        expect(registryUrl('@a/b/../c')).toBeNull()
        expect(registryUrl('a/b')).toBeNull()
        expect(registryUrl('../x')).toBeNull()
    })
})
