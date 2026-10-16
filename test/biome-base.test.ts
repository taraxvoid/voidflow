import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = new URL('..', import.meta.url).pathname
const biome = join(repo, 'node_modules/.bin/biome')

// A throwaway site that depends on voidflow and extends the base by package
// name, the way a real site does.
function site(config: object, files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-biome-'))
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
    mkdirSync(join(dir, 'node_modules/@taraxvoid'), { recursive: true })
    symlinkSync(repo, join(dir, 'node_modules/@taraxvoid/voidflow'))
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(join(dir, 'biome.json'), JSON.stringify(config))
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text)
    }
    return dir
}

function check(dir: string, ...files: string[]) {
    const proc = Bun.spawnSync([biome, 'check', ...files], { cwd: dir })
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
}

const extendsBase = { extends: ['@taraxvoid/voidflow/biome'] }
const houseStyle = "import { a } from './b'\n\nexport const c = [a, 'd']\n"

describe('biome/base.json', () => {
    test('a site resolves the base through the package export', () => {
        const dir = site(extendsBase, { 'ok.ts': houseStyle })
        const { code, out } = check(dir, 'ok.ts')
        expect(out).not.toContain('configuration')
        expect(code).toBe(0)
    })

    test('applies the house style: no semicolons, single quotes', () => {
        const dir = site(extendsBase, {
            'semi.ts': 'export const c = 1;\n',
            'double.ts': 'export const c = "d"\n',
        })
        expect(check(dir, 'semi.ts').code).not.toBe(0)
        expect(check(dir, 'double.ts').code).not.toBe(0)
    })

    test('applies the recommended preset', () => {
        const dir = site(extendsBase, { 'debug.ts': 'debugger\n' })
        expect(check(dir, 'debug.ts').code).not.toBe(0)
    })

    test('the .astro override matches files in the extending site', () => {
        const astro = "---\nimport { a } from './b'\n---\n\n<p>hi</p>\n"
        // Control: without the base's override, recommended flags the import.
        const bare = site({ linter: { rules: { preset: 'recommended' } } }, { 'page.astro': astro })
        expect(check(bare, 'page.astro').out).toContain('noUnusedImports')

        const dir = site(extendsBase, { 'page.astro': astro })
        const { code, out } = check(dir, 'page.astro')
        expect(out).not.toContain('noUnusedImports')
        expect(code).toBe(0)
    })

    test('a setting in the site overrides the base', () => {
        const dir = site(
            { ...extendsBase, javascript: { formatter: { semicolons: 'always' } } },
            { 'semi.ts': 'export const c = 1;\n' },
        )
        expect(check(dir, 'semi.ts').code).toBe(0)
    })
})

// The warning snippets run in the site's repo: give them a site with a given
// Biome version installed (or none) and capture what they print.
function runIn(version: string | null, shell: string, script: string) {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-biome-version-'))
    if (version) {
        mkdirSync(join(dir, 'node_modules/@biomejs/biome'), { recursive: true })
        writeFileSync(
            join(dir, 'node_modules/@biomejs/biome/package.json'),
            JSON.stringify({ name: '@biomejs/biome', version }, null, 2),
        )
    }
    const proc = Bun.spawnSync([shell, '-c', script], { cwd: dir })
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
}

const read = (path: string) => Bun.file(join(repo, path)).text()

describe('Biome 1.x warning', async () => {
    const hook = Bun.YAML.parse(await read('lefthook/site.yml'))['pre-commit'].commands['biome-version']
    const hookScript = hook.run.replaceAll('{pm}', 'bun')
    const ciStep = Bun.YAML.parse(await read('.github/workflows/site-ci.yml')).jobs.validate.steps.find(
        (s: { name?: string }) => s.name === 'Check Biome version',
    )

    test('pre-commit warns on 1.x and still passes', () => {
        const { code, out } = runIn('1.9.4', 'sh', hookScript)
        expect(out).toContain('Biome 1.9.4')
        expect(code).toBe(0)
    })

    test('pre-commit is silent on 2.x and without Biome', () => {
        for (const version of ['2.5.14', null]) {
            const { code, out } = runIn(version, 'sh', hookScript)
            expect(out).toBe('')
            expect(code).toBe(0)
        }
    })

    test('site-ci annotates 1.x with a warning and still passes', () => {
        const { code, out } = runIn('1.9.4', 'bash', ciStep.run)
        expect(out).toContain('::warning')
        expect(out).toContain('Biome 1.9.4')
        expect(code).toBe(0)
    })

    test('site-ci is silent on 2.x and without Biome', () => {
        for (const version of ['2.5.14', null]) {
            const { code, out } = runIn(version, 'bash', ciStep.run)
            expect(out).toBe('')
            expect(code).toBe(0)
        }
    })
})
