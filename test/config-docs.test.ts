import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderDefaultsTable } from '../config/index.ts'
import { renderSettingsTable } from '../config/settings.ts'

const root = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('docs/config.md', () => {
    test('holds the generated defaults table', () => {
        const text = read('docs/config.md')
        const start = '<!-- defaults:start -->'
        const end = '<!-- defaults:end -->'
        const body = text.slice(
            text.indexOf(start) + start.length,
            text.indexOf(end),
        )
        expect(text).toContain(start)
        expect(body.trim()).toBe(renderDefaultsTable().trim())
    })

    test('holds the generated settings table', () => {
        const text = read('docs/config.md')
        const start = '<!-- settings:start -->'
        const end = '<!-- settings:end -->'
        const body = text.slice(
            text.indexOf(start) + start.length,
            text.indexOf(end),
        )
        expect(text).toContain(start)
        expect(body.trim()).toBe(renderSettingsTable().trim())
    })
})

describe('package.json', () => {
    const pkg = JSON.parse(read('package.json'))

    test('exports ./config like ./rulesets', () => {
        expect(pkg.exports['./config']).toEqual({
            types: './dist/config/index.d.ts',
            bun: './config/index.ts',
            default: './dist/config/index.js',
        })
    })

    // Consumers type-check a `.ts` types entry under their own compiler
    // flags (skipLibCheck does not cover it), so each fleet export ships
    // declarations built next to its Node entry point.
    test('fleet exports point types at built declarations', () => {
        for (const name of ['./cloudflare', './config', './rulesets']) {
            const e = pkg.exports[name]
            expect({ name, types: e.types }).toEqual({
                name,
                types: e.default.replace(/\.js$/, '.d.ts'),
            })
        }
        expect(pkg.scripts.build).toContain('tsc -p tsconfig.build.json')
    })

    test('ships and builds the config module', () => {
        expect(pkg.files).toContain('config')
        expect(pkg.scripts.build).toContain('./config/index.ts')
    })
})
