import { describe, expect, test } from 'bun:test'
import {
    type RenderCtx,
    render,
    resolveSha,
    sameIgnoringMarkerVersion,
    withMarker,
} from '../scripts/init/render.ts'
import { json } from '../scripts/lib/template-format.ts'

const ctx: RenderCtx = {
    version: '1.2.3',
    sha: 'abc',
    kind: 'tool',
    repo: 'o/r',
    cronMinute: 7,
}
const L1 =
    'Written by voidflow v1.2.3: https://www.npmjs.com/package/@taraxvoid/voidflow'
const L2 =
    'Set up a repo the same way: npx @taraxvoid/voidflow init --kind tool'

describe('render', () => {
    test('fills version, sha, kind, repo, cron', () => {
        expect(
            render(
                'a@{{sha}} # v{{version}} {{kind}} {{cron_minute}} {{repo}}',
                ctx,
            ),
        ).toBe('a@abc # v1.2.3 tool 7 o/r')
    })
    test('without sha pins the tag', () => {
        expect(render('a@{{sha}} # v{{version}}', { ...ctx, sha: null })).toBe(
            'a@v1.2.3',
        )
    })
    test('null repo becomes OWNER/REPO', () => {
        expect(render('{{repo}}', { ...ctx, repo: null })).toBe('OWNER/REPO')
    })
})

describe('render (null sha, repeated)', () => {
    test('pins every occurrence', () => {
        const t = 'a@{{sha}} # v{{version}}\nb@{{sha}} # v{{version}}\n'
        expect(render(t, { ...ctx, sha: null })).toBe('a@v1.2.3\nb@v1.2.3\n')
    })
})

describe('json', () => {
    test('empty object prints as {}', () => {
        expect(json({})).toBe('{}\n')
        expect(json({ a: {} })).toBe('{\n    "a": {}\n}\n')
    })
})

describe('resolveSha', () => {
    const sha = 'a'.repeat(40)
    const peeled = 'b'.repeat(40)
    const ok = (out: string) => async () => ({ code: 0, out, err: '' })
    test('returns the peeled commit for an annotated tag', async () => {
        const out = `${sha}\trefs/tags/v1.2.3\n${peeled}\trefs/tags/v1.2.3^{}\n`
        expect(await resolveSha('1.2.3', { run: ok(out) })).toBe(peeled)
    })
    test('returns the lightweight tag sha', async () => {
        expect(
            await resolveSha('1.2.3', {
                run: ok(`${sha}\trefs/tags/v1.2.3\n`),
            }),
        ).toBe(sha)
    })
    test('null on non-zero exit, empty output, or a thrown runner', async () => {
        expect(
            await resolveSha('1.2.3', {
                run: async () => ({ code: 128, out: '', err: 'x' }),
            }),
        ).toBeNull()
        expect(await resolveSha('1.2.3', { run: ok('') })).toBeNull()
        expect(
            await resolveSha('1.2.3', {
                run: async () => {
                    throw new Error('ENOENT')
                },
            }),
        ).toBeNull()
    })
    test('null within the timeout when the runner never resolves', async () => {
        const t0 = Date.now()
        const res = await resolveSha('1.2.3', {
            run: () => new Promise(() => {}),
            timeoutMs: 50,
        })
        expect(res).toBeNull()
        expect(Date.now() - t0).toBeLessThan(1000)
    })
    test('passes timeout and GIT_TERMINAL_PROMPT=0 to the runner', async () => {
        let seen: unknown
        await resolveSha('1.2.3', {
            timeoutMs: 1234,
            run: async (_c, _s, o) => {
                seen = o
                return { code: 1, out: '', err: '' }
            },
        })
        expect(seen).toEqual({
            timeoutMs: 1234,
            env: { GIT_TERMINAL_PROMPT: '0' },
        })
    })
})

describe('withMarker', () => {
    test('marker per type', () => {
        const y = withMarker('lefthook.yml', 'a: 1\n', ctx).split('\n')
        expect(y.slice(0, 2)).toEqual([`# ${L1}`, `# ${L2}`])
        const b = withMarker('biome.json', '{}\n', ctx).split('\n')
        expect(b.join('\n')).toBe('{}\n')
        expect(withMarker('tsconfig.json', '{}\n', ctx).startsWith('// ')).toBe(
            true,
        )
        const md = withMarker('SECURITY.md', '# S\n', ctx)
        expect(md.startsWith('<!--')).toBe(true)
        expect(md).toContain(L1)
        expect(md).toContain(L2)
        expect(withMarker('.gitignore', 'x\n', ctx).startsWith('# ')).toBe(true)
        expect(withMarker('a.ts', 'x\n', ctx).startsWith('// ')).toBe(true)
        expect(
            JSON.parse(withMarker('renovate.json', '{"extends":[]}', ctx))
                .description,
        ).toEqual([L1, L2])
        const x = '{"a":1}\n'
        expect(withMarker('package.json', x, ctx)).toBe(x)
    })
    test('renovate.json stays formatted like biome output', () => {
        const out = withMarker(
            'renovate.json',
            '{\n    "extends": ["a"]\n}\n',
            ctx,
        )
        expect(out).toBe(
            `{\n    "extends": ["a"],\n    "description": [\n        "${L1}",\n        "${L2}"\n    ]\n}\n`,
        )
    })
})

describe('sameIgnoringMarkerVersion', () => {
    const at = (v: string, body: string) =>
        withMarker('lefthook.yml', body, { ...ctx, version: v })
    test('marker version is ignored when comparing', () => {
        expect(
            sameIgnoringMarkerVersion(
                at('1.0.0', 'a: 1\n'),
                at('1.1.0', 'a: 1\n'),
            ),
        ).toBe(true)
        expect(
            sameIgnoringMarkerVersion(
                at('1.0.0', 'a: 1\n'),
                at('1.1.0', 'a: 2\n'),
            ),
        ).toBe(false)
        const r = (v: string) =>
            withMarker('renovate.json', '{"extends":[]}', {
                ...ctx,
                version: v,
            })
        expect(sameIgnoringMarkerVersion(r('1.0.0'), r('1.1.0'))).toBe(true)
    })
})
