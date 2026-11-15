import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderDefaultsTable } from '../config/index.ts'

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
})

describe('package.json', () => {
    const pkg = JSON.parse(read('package.json'))

    test('exports ./config like ./rulesets', () => {
        expect(pkg.exports['./config']).toEqual({
            types: './config/index.ts',
            bun: './config/index.ts',
            default: './dist/config/index.js',
        })
    })

    test('ships and builds the config module', () => {
        expect(pkg.files).toContain('config')
        expect(pkg.scripts.build).toContain('./config/index.ts')
    })
})
