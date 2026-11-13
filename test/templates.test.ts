import { describe, expect, test } from 'bun:test'
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    buildTemplates,
    TEMPLATE_PLACEHOLDERS,
} from '../scripts/build-templates.ts'
import { packageRoot } from '../scripts/lib/package-root.ts'
import { capture } from '../scripts/lib/proc.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

describe('agentic gate caller', () => {
    test('grants the permissions the reusable workflow requests', () => {
        const caller = readFileSync(
            join(ROOT, 'templates/common/agentic-gate.yml'),
            'utf8',
        )
        for (const p of [
            'checks: write',
            'contents: read',
            'pull-requests: read',
        ])
            expect(caller).toContain(p)
    })
})

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    )
}

describe('templates', () => {
    test('committed templates match a fresh build', () => {
        const built = buildTemplates(ROOT)
        for (const [path, content] of built) {
            expect(
                readFileSync(join(ROOT, 'templates', path), 'utf8'),
                `templates/${path} is stale, run 'just templates'`,
            ).toBe(content)
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
        expect(
            JSON.parse(t.get('tool/package.json')!).devDependencies[
                '@types/bun'
            ],
        ).not.toBe('latest')
    })

    test('bunfig template keeps the install gate and the scanner', () => {
        const b = buildTemplates(ROOT).get('common/bunfig.toml')!
        expect(b).toContain('[install.security]')
        expect(b).toMatch(/^scanner = /m)
        expect(b).not.toContain('[test]')
    })

    test('biome-formatted files pass biome check with the base config', async () => {
        // Outside the repo, so no root config interferes; extends the real base.
        const dir = mkdtempSync(join(tmpdir(), 'tpl-biome-'))
        const t = buildTemplates(ROOT)
        // The shipped biome.json verbatim: it extends "@taraxvoid/voidflow/biome",
        // so install this checkout as that package.
        mkdirSync(join(dir, 'node_modules/@taraxvoid'), { recursive: true })
        symlinkSync(ROOT, join(dir, 'node_modules/@taraxvoid/voidflow'))
        // The base config sets vcs.useIgnoreFile, which wants an ignore file.
        writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
        writeFileSync(join(dir, 'biome.json'), t.get('common/biome.json')!)
        const checked = [
            'common/renovate.json',
            'tool/tsconfig.json',
            'tool/package.json',
            'site/package.json',
            'site/playwright.config.js',
            'site/unlighthouse.config.ts',
        ]
        for (const p of checked) {
            const out = join(dir, p)
            mkdirSync(dirname(out), { recursive: true })
            writeFileSync(out, t.get(p)!)
        }
        const biome = join(ROOT, 'node_modules/.bin/biome')
        const r = await capture([biome, 'check', `--config-path=${dir}`, dir])
        expect(r.code, r.out + r.err).toBe(0)
    })

    test('packageRoot finds this repo', () => {
        expect(packageRoot()).toBe(ROOT)
    })

    test('npm pack ships templates', async () => {
        // A fresh cache dir: the default one may be unwritable (root-owned, sandboxes).
        const prev = process.env.npm_config_cache
        process.env.npm_config_cache = mkdtempSync(join(tmpdir(), 'npm-cache-'))
        let r: Awaited<ReturnType<typeof capture>>
        try {
            r = await capture([
                'npm',
                'pack',
                '--dry-run',
                '--json',
                '--ignore-scripts',
            ])
        } finally {
            if (prev === undefined) delete process.env.npm_config_cache
            else process.env.npm_config_cache = prev
        }
        expect(r.code, r.err).toBe(0)
        const files = (JSON.parse(r.out)[0].files as { path: string }[]).map(
            (f) => f.path,
        )
        expect(files).toContain('templates/common/gitignore')
        expect(files).toContain('templates/tool/ci.yml')
    })
})
