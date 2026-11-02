import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { applyFiles, fileNames, planFiles } from '../scripts/init/files.ts'
import type { Kind, RenderCtx } from '../scripts/init/render.ts'

const ctx: RenderCtx = {
    version: '1.2.3',
    sha: 'a'.repeat(40),
    kind: 'tool',
    repo: 'o/r',
    cronMinute: 7,
}
const sel = (kind: Kind, extra: Record<string, unknown> = {}) => ({
    kind,
    skip: new Set<string>(),
    force: false,
    enablePvr: false,
    ...extra,
})

let dir: string
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-files-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const TOOL_TARGETS = [
    'lefthook.yml',
    'mise.toml',
    'renovate.json',
    'bunfig.toml',
    'biome.json',
    '.gitignore',
    '.github/workflows/ci.yml',
    'tsconfig.json',
    'package.json',
]

describe('planFiles', () => {
    test('empty dir, kind tool', () => {
        const plan = planFiles(dir, sel('tool'), ctx)
        expect(plan.every((a) => a.status === 'create')).toBe(true)
        expect(plan.map((a) => a.target).sort()).toEqual(
            [...TOOL_TARGETS].sort(),
        )
        const withPvr = planFiles(dir, sel('tool', { enablePvr: true }), ctx)
        expect(withPvr.map((a) => a.name)).toContain('security')
        expect(plan.map((a) => a.name)).not.toContain('security')
    })
    test('kind site', () => {
        const c = { ...ctx, kind: 'site' as const }
        const t = planFiles(dir, sel('site'), c).map((a) => a.target)
        expect(t).toContain('playwright.config.js')
        expect(t).toContain('unlighthouse.config.ts')
        expect(t).not.toContain('tsconfig.json')
        expect(fileNames('site')).not.toContain('tsconfig')
        expect(fileNames('tool')).toContain('tsconfig')
    })
    test('skip drops items', () => {
        const plan = planFiles(
            dir,
            sel('tool', { skip: new Set(['ci', 'mise']) }),
            ctx,
        )
        const names = plan.map((a) => a.name)
        expect(names).not.toContain('ci')
        expect(names).not.toContain('mise')
    })
    test('existing different file conflicts, force overwrites', () => {
        writeFileSync(join(dir, 'mise.toml'), 'mine\n')
        const get = (force: boolean) =>
            planFiles(dir, sel('tool', { force }), ctx).find(
                (a) => a.name === 'mise',
            )
        expect(get(false)?.status).toBe('conflict')
        expect(get(true)?.status).toBe('overwrite')
        applyFiles(dir, planFiles(dir, sel('tool', { force: true }), ctx))
        expect(readFileSync(join(dir, 'mise.toml'), 'utf8')).not.toBe('mine\n')
    })
    test('re-run is unchanged', () => {
        const s = sel('tool', { enablePvr: true })
        applyFiles(dir, planFiles(dir, s, ctx))
        const again = planFiles(dir, s, ctx)
        expect(again.map((a) => a.status)).toEqual(again.map(() => 'unchanged'))
    })
    test('site re-run is unchanged and gitignore has site extras', () => {
        const c = { ...ctx, kind: 'site' as const }
        applyFiles(dir, planFiles(dir, sel('site'), c))
        expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain(
            '.unlighthouse/',
        )
        const again = planFiles(dir, sel('site'), c)
        expect(again.every((a) => a.status === 'unchanged')).toBe(true)
    })
    test('created package.json is 4-space with name', () => {
        applyFiles(dir, planFiles(dir, sel('tool'), ctx))
        const text = readFileSync(join(dir, 'package.json'), 'utf8')
        const pkg = JSON.parse(text)
        expect(pkg.private).toBe(true)
        expect(pkg.type).toBe('module')
        expect(pkg.name).toBe(basename(dir))
        expect(text).toContain('\n    "name"')
        expect(text.endsWith('}\n')).toBe(true)
    })
    test('gitignore create has marker, merge appends only missing', () => {
        writeFileSync(join(dir, '.gitignore'), 'node_modules/\nfoo\n')
        const a = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'gitignore',
        )
        expect(a?.status).toBe('merge')
        expect(a?.content.startsWith('node_modules/\nfoo\n')).toBe(true)
        expect(a?.content).toContain('# Written by voidflow v1.2.3: ')
        expect(a?.content).toContain('# Set up a repo the same way')
        expect(a?.content).toContain('dist/\n')
        expect(a?.content.match(/node_modules\//g)?.length).toBe(1)
        applyFiles(dir, [a as NonNullable<typeof a>])
        const again = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'gitignore',
        )
        expect(again?.status).toBe('unchanged')
    })
    test('package merge', () => {
        const src =
            '{"name":"x","scripts":{"lint":"eslint ."},"devDependencies":{"@biomejs/biome":"1.0.0"}}'
        writeFileSync(join(dir, 'package.json'), src)
        const find = (force: boolean) =>
            planFiles(dir, sel('tool', { force }), ctx).find(
                (a) => a.name === 'package',
            )
        const c = find(false)
        expect(c?.status).toBe('conflict')
        expect(c?.detail).toContain('lint')
        const o = find(true)
        expect(o?.status).toBe('overwrite')
        const pkg = JSON.parse(o?.content ?? '')
        expect(pkg.name).toBe('x')
        expect(pkg.scripts.lint).toBe('biome check .')
        expect(pkg.scripts.check).toBeDefined()
        expect(pkg.devDependencies['@biomejs/biome']).toBe('1.0.0')
        expect(pkg.devDependencies.typescript).toBeDefined()
    })
    test('package merge keeps 2-space indent and trailing newline', () => {
        writeFileSync(join(dir, 'package.json'), '{\n  "name": "x"\n}\n')
        const find = () =>
            planFiles(dir, sel('tool'), ctx).find((x) => x.name === 'package')
        const a = find()
        expect(a?.status).toBe('merge')
        expect(a?.content).toContain('\n  "name": "x"')
        expect(a?.content.endsWith('}\n')).toBe(true)
        writeFileSync(join(dir, 'package.json'), '{\n  "name": "x"\n}')
        const b = find()
        expect(b?.content.endsWith('}')).toBe(true)
    })
})

describe('merge edge cases', () => {
    const pkgAction = () =>
        planFiles(dir, sel('tool'), ctx).find((x) => x.name === 'package')

    test('biome-formatted inline arrays survive the merge', () => {
        const src = '{\n    "name": "x",\n    "files": ["dist", "src"]\n}\n'
        writeFileSync(join(dir, 'package.json'), src)
        const a = pkgAction()
        expect(a?.status).toBe('merge')
        expect(a?.content).toContain('    "files": ["dist", "src"],\n')
        expect(
            a?.content.startsWith(
                '{\n    "name": "x",\n    "files": ["dist", "src"],\n',
            ),
        ).toBe(true)
    })
    test('non-object package.json is a conflict', () => {
        for (const src of ['null', '[]', '"s"', '{"scripts": "x"}']) {
            writeFileSync(join(dir, 'package.json'), src)
            const a = pkgAction()
            expect(a?.status).toBe('conflict')
            expect(a?.detail).toBeTruthy()
        }
    })
    test('missing required template throws', () => {
        expect(() =>
            planFiles(dir, sel('tool'), { ...ctx, kind: 'nope' as Kind }),
        ).toThrow(/missing template/)
    })
    test('CRLF is preserved in package.json merge', () => {
        writeFileSync(join(dir, 'package.json'), '{\r\n  "name": "x"\r\n}\r\n')
        const a = pkgAction()
        expect(a?.content.replaceAll('\r\n', '')).not.toContain('\n')
        expect(a?.content.endsWith('}\r\n')).toBe(true)
    })
    test('CRLF is preserved in gitignore merge', () => {
        writeFileSync(join(dir, '.gitignore'), 'foo\r\n')
        const a = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'gitignore',
        )
        expect(a?.status).toBe('merge')
        expect(a?.content.replaceAll('\r\n', '')).not.toContain('\n')
        expect(a?.content).toContain('# Written by voidflow')
    })
    test('force replaces only the conflicting script', () => {
        writeFileSync(
            join(dir, 'package.json'),
            '{"scripts":{"lint":"eslint .","custom":"vitest"}}',
        )
        const a = planFiles(dir, sel('tool', { force: true }), ctx).find(
            (x) => x.name === 'package',
        )
        const pkg = JSON.parse(a?.content ?? '')
        expect(pkg.scripts.lint).toBe('biome check .')
        expect(pkg.scripts.custom).toBe('vitest')
    })
})

describe('applyFiles', () => {
    test('refuses conflicts and writes nothing', () => {
        writeFileSync(join(dir, 'mise.toml'), 'mine\n')
        const plan = planFiles(dir, sel('tool'), ctx)
        expect(plan.some((a) => a.status === 'conflict')).toBe(true)
        expect(() => applyFiles(dir, plan)).toThrow()
        expect(readdirSync(dir)).toEqual(['mise.toml'])
    })
    test('creates parent dirs', () => {
        applyFiles(dir, planFiles(dir, sel('tool'), ctx))
        expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(true)
    })
})
