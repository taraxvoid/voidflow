import { describe, expect, test } from 'bun:test'
import {
    type RenderCtx,
    render,
    sameIgnoringMarkerVersion,
    withMarker,
} from '../scripts/init/render.ts'

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

describe('withMarker', () => {
    test('marker per type', () => {
        const y = withMarker('lefthook.yml', 'a: 1\n', ctx).split('\n')
        expect(y.slice(0, 2)).toEqual([`# ${L1}`, `# ${L2}`])
        const b = withMarker('biome.json', '{}\n', ctx).split('\n')
        expect(b.slice(0, 2)).toEqual([`// ${L1}`, `// ${L2}`])
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
