import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, discover, TOOL_FILE } from '../scripts/lib/discover.ts'

// init --config resolves through configPath too, so it reads a value the way
// the verbs' --config does.
describe('configPath', () => {
    const o = { env: {}, cwd: '/work', home: '/home/t' }
    test('~/ is home, relative is cwd, VOIDFLOW_CONFIG_BASE wins over cwd', () => {
        expect(configPath('~/infra', o)).toBe('/home/t/infra')
        expect(configPath('../infra', o)).toBe('/infra')
        expect(configPath('/abs', o)).toBe('/abs')
        expect(
            configPath('infra', {
                ...o,
                env: { VOIDFLOW_CONFIG_BASE: '/base' },
            }),
        ).toBe('/base/infra')
    })
})

/** A fresh temp tree: home (empty), and a config dir holding the given files. */
function tree(files: string[] = ['rulesets.ts', 'cf-tokens.ts']) {
    const root = mkdtempSync(join(tmpdir(), 'voidflow-discover-'))
    const home = join(root, 'home')
    const cfg = join(root, 'infra')
    const cwd = join(root, 'work', 'a', 'b')
    mkdirSync(home, { recursive: true })
    mkdirSync(cfg, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    for (const f of files) writeFileSync(join(cfg, f), 'export default {}')
    return { root, home, cfg, cwd }
}

describe('discover', () => {
    test('TOOL_FILE names each tool file', () => {
        expect(TOOL_FILE).toEqual({
            rulesets: 'rulesets.ts',
            'cf-tokens': 'cf-tokens.ts',
        })
    })

    test('nothing anywhere is null', () => {
        const t = tree([])
        expect(
            discover('rulesets', { env: {}, cwd: t.cwd, home: t.home }),
        ).toBeNull()
    })

    test('--config as a directory or a file', () => {
        const t = tree()
        const o = { env: {}, cwd: t.cwd, home: t.home }
        expect(discover('rulesets', { ...o, flag: t.cfg })).toEqual({
            file: join(t.cfg, 'rulesets.ts'),
            via: 'flag',
        })
        expect(
            discover('rulesets', { ...o, flag: join(t.cfg, 'cf-tokens.ts') }),
        ).toEqual({ file: join(t.cfg, 'cf-tokens.ts'), via: 'flag' })
    })

    test('VOIDFLOW_CONFIG', () => {
        const t = tree()
        expect(
            discover('cf-tokens', {
                env: { VOIDFLOW_CONFIG: t.cfg },
                cwd: t.cwd,
                home: t.home,
            }),
        ).toEqual({ file: join(t.cfg, 'cf-tokens.ts'), via: 'env' })
    })

    test('XDG_CONFIG_HOME, else home/.config', () => {
        const t = tree()
        const xdg = join(t.root, 'xdg')
        mkdirSync(join(xdg, 'voidflow'), { recursive: true })
        writeFileSync(join(xdg, 'voidflow', 'rulesets.ts'), '')
        expect(
            discover('rulesets', {
                env: { XDG_CONFIG_HOME: xdg },
                cwd: t.cwd,
                home: t.home,
            }),
        ).toEqual({ file: join(xdg, 'voidflow', 'rulesets.ts'), via: 'xdg' })
        mkdirSync(join(t.home, '.config', 'voidflow'), { recursive: true })
        writeFileSync(join(t.home, '.config', 'voidflow', 'rulesets.ts'), '')
        expect(
            discover('rulesets', { env: {}, cwd: t.cwd, home: t.home }),
        ).toEqual({
            file: join(t.home, '.config', 'voidflow', 'rulesets.ts'),
            via: 'xdg',
        })
    })

    test('a symlinked voidflow dir resolves', () => {
        const t = tree()
        mkdirSync(join(t.home, '.config'))
        symlinkSync(t.cfg, join(t.home, '.config', 'voidflow'))
        expect(
            discover('cf-tokens', { env: {}, cwd: t.cwd, home: t.home }),
        ).toEqual({
            file: join(t.home, '.config', 'voidflow', 'cf-tokens.ts'),
            via: 'xdg',
        })
    })

    test('a dangling xdg symlink throws naming it, and does not fall through', () => {
        const t = tree([])
        mkdirSync(join(t.home, '.config'))
        symlinkSync(join(t.root, 'gone'), join(t.home, '.config', 'voidflow'))
        writeFileSync(join(t.cwd, 'rulesets.ts'), '')
        expect(() =>
            discover('rulesets', { env: {}, cwd: t.cwd, home: t.home }),
        ).toThrow(
            `${join(t.home, '.config', 'voidflow')} is a symlink to a missing path`,
        )
    })

    test('ancestors of cwd, nearest first', () => {
        const t = tree([])
        writeFileSync(join(t.root, 'work', 'rulesets.ts'), '')
        expect(
            discover('rulesets', { env: {}, cwd: t.cwd, home: t.home }),
        ).toEqual({ file: join(t.root, 'work', 'rulesets.ts'), via: 'cwd' })
        writeFileSync(join(t.root, 'work', 'a', 'rulesets.ts'), '')
        expect(
            discover('rulesets', { env: {}, cwd: t.cwd, home: t.home })?.file,
        ).toBe(join(t.root, 'work', 'a', 'rulesets.ts'))
    })

    test('precedence: flag, env, xdg, cwd', () => {
        const t = tree()
        const other = join(t.root, 'other')
        mkdirSync(other)
        writeFileSync(join(other, 'rulesets.ts'), '')
        const xdg = join(t.root, 'xdg')
        mkdirSync(join(xdg, 'voidflow'), { recursive: true })
        writeFileSync(join(xdg, 'voidflow', 'rulesets.ts'), '')
        writeFileSync(join(t.cwd, 'rulesets.ts'), '')
        const base = { cwd: t.cwd, home: t.home }
        const all = { VOIDFLOW_CONFIG: other, XDG_CONFIG_HOME: xdg }
        expect(
            discover('rulesets', { ...base, env: all, flag: t.cfg })?.via,
        ).toBe('flag')
        expect(discover('rulesets', { ...base, env: all })?.via).toBe('env')
        expect(
            discover('rulesets', { ...base, env: { XDG_CONFIG_HOME: xdg } })
                ?.via,
        ).toBe('xdg')
        expect(discover('rulesets', { ...base, env: {} })?.via).toBe('cwd')
    })

    test('an explicit dir without the tool file is null, not a fall-through', () => {
        const t = tree(['rulesets.ts'])
        writeFileSync(join(t.cwd, 'cf-tokens.ts'), '')
        const o = { cwd: t.cwd, home: t.home }
        expect(discover('cf-tokens', { ...o, env: {}, flag: t.cfg })).toBeNull()
        expect(
            discover('cf-tokens', { ...o, env: { VOIDFLOW_CONFIG: t.cfg } }),
        ).toBeNull()
        expect(discover('rulesets', { ...o, env: {}, flag: t.cfg })?.via).toBe(
            'flag',
        )
    })

    test('a missing flag or env path throws naming it', () => {
        const t = tree()
        const gone = join(t.root, 'nope')
        expect(() =>
            discover('rulesets', {
                env: {},
                cwd: t.cwd,
                home: t.home,
                flag: gone,
            }),
        ).toThrow(gone)
        expect(() =>
            discover('rulesets', {
                env: { VOIDFLOW_CONFIG: gone },
                cwd: t.cwd,
                home: t.home,
            }),
        ).toThrow(`VOIDFLOW_CONFIG ${gone}`)
    })

    test('~/ expands to home', () => {
        const t = tree([])
        mkdirSync(join(t.home, 'infra'))
        writeFileSync(join(t.home, 'infra', 'rulesets.ts'), '')
        expect(
            discover('rulesets', {
                env: {},
                cwd: t.cwd,
                home: t.home,
                flag: '~/infra',
            })?.file,
        ).toBe(join(t.home, 'infra', 'rulesets.ts'))
    })

    test('relative values resolve against VOIDFLOW_CONFIG_BASE, else cwd', () => {
        const t = tree()
        expect(
            discover('rulesets', {
                env: { VOIDFLOW_CONFIG_BASE: t.root },
                cwd: t.cwd,
                home: t.home,
                flag: 'infra',
            })?.file,
        ).toBe(join(t.cfg, 'rulesets.ts'))
        expect(
            discover('rulesets', {
                env: { VOIDFLOW_CONFIG: '../../../infra' },
                cwd: t.cwd,
                home: t.home,
            })?.file,
        ).toBe(join(t.cfg, 'rulesets.ts'))
    })
})
