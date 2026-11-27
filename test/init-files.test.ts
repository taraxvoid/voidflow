import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { proxyTables } from '../scripts/build-templates.ts'
import { applyFiles, fileNames, planFiles } from '../scripts/init/files.ts'
import type { Kind, RenderCtx } from '../scripts/init/render.ts'
import { loadVoidflowConfig } from '../scripts/lib/repo-config.ts'

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
    '.github/CODEOWNERS',
    'voidflow.config.ts',
    '.github/workflows/voidflow-drift.yml',
    '.github/zizmor.yml',
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
    test('zizmor policy follows the actions-lock opt-in', () => {
        const pick = (lock: boolean) =>
            planFiles(dir, sel('tool', { enableActionsLock: lock }), {
                ...ctx,
                actionsLock: lock,
            }).find((a) => a.name === 'zizmor')?.content ?? ''
        expect(pick(false)).toContain("'taraxvoid/voidflow/*': ref-pin")
        expect(pick(false)).not.toContain("'*': ref-pin")
        expect(pick(true)).toContain("'*': ref-pin")
    })
    test('codeowners renders the owner into every rule', () => {
        const [a] = planFiles(dir, sel('tool'), {
            ...ctx,
            owner: '@acme/sec',
        }).filter((x) => x.name === 'codeowners')
        const rules = (a?.content ?? '')
            .split('\n')
            .filter((l) => l.startsWith('/'))
        expect(rules.length).toBeGreaterThan(10)
        for (const l of rules) expect(l.endsWith(' @acme/sec')).toBe(true)
        expect(a?.content).toContain('/.github/ @acme/sec')
        expect(a?.content).toContain('/CLAUDE.md @acme/sec')
        expect(a?.content.startsWith('# Written by voidflow v1.2.3')).toBe(true)
        expect(a?.content).not.toContain('{{')
    })
    test('codeowners falls back to a placeholder owner', () => {
        const a = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'codeowners',
        )
        expect(a?.content).toContain('/.github/ @OWNER')
    })
    test('kind site', () => {
        const c = { ...ctx, kind: 'site' as const }
        const t = planFiles(dir, sel('site'), c).map((a) => a.target)
        expect(t).toContain('playwright.config.js')
        expect(t).toContain('unlighthouse.config.ts')
        expect(t).not.toContain('tsconfig.json')
        expect(fileNames('site')).not.toContain('tsconfig')
        expect(fileNames('tool')).toContain('tsconfig')
        expect(fileNames('tool')).not.toContain('fnox')
    })
    test('site fnox.toml: repo-owned, admin token only behind the proxy', () => {
        const a = planFiles(dir, sel('site'), { ...ctx, kind: 'site' }).find(
            (x) => x.name === 'fnox',
        )
        expect(a?.target).toBe('fnox.toml')
        expect(a?.content).not.toContain('Written by voidflow')
        expect(a?.content).not.toContain('{{')
        expect(a?.content).toContain('"voidflow-cf-token-admin:o/r"')
        expect(a?.content).toMatch(/^CF_TOKEN_ADMIN = \{.*env = false \}$/m)
        // The same proxy tables as voidflow's own fnox.toml.
        const own = readFileSync(
            new URL('../fnox.toml', import.meta.url),
            'utf8',
        )
        expect(a?.content.endsWith(proxyTables(own))).toBe(true)
        expect(a?.content).toContain('egress = "strict"')
        writeFileSync(join(dir, 'fnox.toml'), 'mine\n')
        const kept = planFiles(dir, sel('site'), { ...ctx, kind: 'site' }).find(
            (x) => x.name === 'fnox',
        )
        expect(kept?.status).toBe('unchanged')
        expect(kept?.content).toBe('mine\n')
    })
    test('proxyTables stops at the next non-proxy table', () => {
        const toml = [
            '[secrets]',
            'A = { value = "a" }',
            '',
            '[proxy]',
            'egress = "strict"',
            '',
            '[[proxy.rules]]',
            'secret = "A"',
            '',
            '# about B',
            '[secrets.more]',
            'B = { value = "b" }',
            '',
        ].join('\n')
        expect(proxyTables(toml)).toBe(
            '[proxy]\negress = "strict"\n\n[[proxy.rules]]\nsecret = "A"\n',
        )
        expect(() => proxyTables('[secrets]\n')).toThrow('[proxy] not found')
    })
    test('config renders kind only, without a marker', () => {
        const a = planFiles(dir, sel('site'), { ...ctx, kind: 'site' }).find(
            (x) => x.name === 'config',
        )
        expect(a?.status).toBe('create')
        expect(a?.target).toBe('voidflow.config.ts')
        expect(a?.content).toContain(
            "export default { kind: 'site' } satisfies VoidflowConfig",
        )
        expect(a?.content).toContain(
            "import type { VoidflowConfig } from '@taraxvoid/voidflow/config'",
        )
        expect(a?.content).not.toContain('Written by voidflow')
    })
    test('existing config is kept, force overwrites', () => {
        const mine =
            "export default { kind: 'tool', cloudflare: { account: 'x', envs: [] } }\n"
        writeFileSync(join(dir, 'voidflow.config.ts'), mine)
        const get = (force: boolean) =>
            planFiles(dir, sel('tool', { force }), ctx).find(
                (a) => a.name === 'config',
            )
        expect(get(false)?.status).toBe('unchanged')
        expect(get(false)?.detail).toBe('repo-owned, kept (--force overwrites)')
        applyFiles(
            dir,
            planFiles(dir, sel('tool'), ctx).filter((a) => a.name === 'config'),
        )
        expect(readFileSync(join(dir, 'voidflow.config.ts'), 'utf8')).toBe(mine)
        expect(get(true)?.status).toBe('overwrite')
    })
    test('rendered config validates', async () => {
        // Bun caches import() by URL: one subdirectory per kind.
        for (const kind of ['tool', 'site'] as const) {
            const sub = join(dir, kind)
            mkdirSync(sub)
            applyFiles(
                sub,
                planFiles(sub, sel(kind), { ...ctx, kind }).filter(
                    (a) => a.name === 'config',
                ),
            )
            expect(
                await loadVoidflowConfig(join(sub, 'voidflow.config.ts')),
            ).toEqual({ kind })
        }
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
    test('gitignore create keeps the marker', () => {
        const a = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'gitignore',
        )
        expect(a?.status).toBe('create')
        expect(a?.content).toContain('# Written by voidflow v1.2.3: ')
    })
    test('gitignore merge appends only missing, without a marker', () => {
        writeFileSync(join(dir, '.gitignore'), 'node_modules/\nfoo\n')
        const a = planFiles(dir, sel('tool'), ctx).find(
            (x) => x.name === 'gitignore',
        )
        expect(a?.status).toBe('merge')
        expect(a?.content.startsWith('node_modules/\nfoo\n')).toBe(true)
        expect(a?.content).not.toContain('Written by voidflow')
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
        expect(a?.content).not.toContain('Written by voidflow')
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
