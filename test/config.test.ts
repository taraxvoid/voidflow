import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../scripts/lib/config.ts'

describe('loadConfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-config-'))
    const cfg = { 'example-org/site': { n: 1 } }
    // Accepts objects whose values all have a numeric `n`.
    const check = (x: unknown) => {
        const ok =
            typeof x === 'object' &&
            x !== null &&
            Object.values(x).every((v) => typeof (v as any)?.n === 'number')
        if (!ok) throw new Error('"x": n is not a number')
        return x as typeof cfg
    }
    writeFileSync(join(dir, 'named.ts'), `export const REPOS = ${JSON.stringify(cfg)}`)
    writeFileSync(join(dir, 'default.ts'), `export default ${JSON.stringify(cfg)}`)
    writeFileSync(join(dir, 'empty.ts'), 'export const other = 1')
    writeFileSync(join(dir, 'bad.ts'), "export const REPOS = { x: { n: 'one' } }")

    test('without a path, asks for --config', async () => {
        await expect(
            loadConfig(undefined, dir, check),
        ).rejects.toThrow('needs --config')
    })

    test('a REPOS or default export, relative to the base dir', async () => {
        expect(await loadConfig('named.ts', dir, check)).toEqual(cfg)
        expect(
            await loadConfig(join(dir, 'default.ts'), '/', check),
        ).toEqual(cfg)
    })

    test('names the file when it has no config or a bad one', async () => {
        await expect(
            loadConfig('empty.ts', dir, check),
        ).rejects.toThrow(`${join(dir, 'empty.ts')}: no REPOS or default export`)
        await expect(loadConfig('bad.ts', dir, check)).rejects.toThrow(
            `${join(dir, 'bad.ts')}: "x": n is not a number`,
        )
    })
})
