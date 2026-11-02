import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTemplates, TEMPLATE_PLACEHOLDERS } from '../scripts/build-templates.ts'
import { packageRoot } from '../scripts/lib/package-root.ts'
import { capture } from '../scripts/lib/proc.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    )
}

describe('templates', () => {
    test('committed templates match a fresh build', () => {
        const built = buildTemplates(ROOT)
        for (const [path, content] of built) {
            expect(readFileSync(join(ROOT, 'templates', path), 'utf8'), path).toBe(content)
        }
        const onDisk = walk(join(ROOT, 'templates'))
            .map((f) => relative(join(ROOT, 'templates'), f))
            .sort()
        expect(onDisk).toEqual([...built.keys()].sort())
    })

    test('build is deterministic', () => {
        expect([...buildTemplates(ROOT)]).toEqual([...buildTemplates(ROOT)])
    })

    test('placeholders are only the known ones', () => {
        const known = new Set<string>(TEMPLATE_PLACEHOLDERS)
        for (const [path, content] of buildTemplates(ROOT)) {
            for (const m of content.match(/(?<!\$)\{\{[^}]*\}\}/g) ?? []) {
                expect(known.has(m), `${path}: ${m}`).toBe(true)
            }
        }
    })

    test('templates are ASCII only', () => {
        for (const [path, content] of buildTemplates(ROOT)) {
            expect(/^[\x00-\x7f]*$/.test(content), path).toBe(true)
        }
    })

    test('pins come from voidflow own files', () => {
        const t = buildTemplates(ROOT)
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
        expect(t.get('common/biome.json')).toContain(
            `schemas/${pkg.devDependencies['@biomejs/biome']}/schema.json`,
        )
        expect(t.get('common/mise.toml')).toMatch(/^lefthook = "\d/m)
        expect(JSON.parse(t.get('tool/package.json')!).devDependencies['@types/bun']).not.toBe('latest')
    })

    test('packageRoot finds this repo', () => {
        expect(packageRoot()).toBe(ROOT)
    })

    test('npm pack ships templates', async () => {
        // A fresh cache dir: the default one may be unwritable (root-owned, sandboxes).
        process.env.npm_config_cache = mkdtempSync(join(tmpdir(), 'npm-cache-'))
        const r = await capture(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'])
        expect(r.code, r.err).toBe(0)
        const files = (JSON.parse(r.out)[0].files as { path: string }[]).map((f) => f.path)
        expect(files).toContain('templates/common/gitignore')
        expect(files).toContain('templates/tool/ci.yml')
    })
})
