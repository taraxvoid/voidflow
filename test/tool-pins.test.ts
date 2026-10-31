import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

// The justfile is the source of truth for tool pins. Renovate bumps every copy
// in one grouped PR (renovate.json); this catches a copy it can't see.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const justfile = read('justfile')
const pin = (name: string) => justfile.match(new RegExp(`^${name}_version := "([^"]+)"`, 'm'))![1]
const workflows = readdirSync(new URL('../.github/workflows', import.meta.url))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, read(`.github/workflows/${f}`)] as const)

describe('tool pins match the justfile', () => {
    test('jactionlint: every workflow pin is annotated for Renovate and matches', () => {
        const want = pin('jactionlint')
        let seen = 0
        for (const [f, text] of workflows) {
            if (!text.includes('jactionlint_')) continue
            const pins = [...text.matchAll(/VERSION: (\S+) # renovate: datasource=github-releases depName=jdx\/jactionlint/g)]
            expect(pins.length, f).toBeGreaterThan(0)
            for (const [, v] of pins) expect(v, f).toBe(want)
            expect(text, `${f} hardcodes a jactionlint version`).not.toMatch(/jactionlint_\d/)
            seen += pins.length
        }
        expect(seen).toBeGreaterThanOrEqual(3)
    })

    test('jactionlint: mise.toml matches', () => {
        expect((Bun.TOML.parse(read('mise.toml')).tools as Record<string, string>).jactionlint).toBe(
            pin('jactionlint'),
        )
    })

    test('zizmor: every uvx call matches', () => {
        const want = pin('zizmor')
        const all = workflows.flatMap(([f, text]) => [...text.matchAll(/zizmor@(\S+)/g)].map(([, v]) => [f, v]))
        expect(all.length).toBeGreaterThanOrEqual(5)
        for (const [f, v] of all) expect(v, f).toBe(want)
    })
})
