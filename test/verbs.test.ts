import { afterEach, describe, expect, test } from 'bun:test'
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyTargetError, splitVerbArgs, worstExit } from '../scripts/verbs.ts'

describe('splitVerbArgs', () => {
    test('the first positional is the tool', () => {
        expect(splitVerbArgs(['rulesets'])).toEqual({
            tool: 'rulesets',
            entireFleet: false,
            rest: [],
        })
        expect(splitVerbArgs(['--prune', 'cf-tokens']).tool).toBe('cf-tokens')
        expect(splitVerbArgs([]).tool).toBeUndefined()
    })

    test('consumes both --config forms and --entire-fleet', () => {
        expect(splitVerbArgs(['--config', 'x', 'rulesets'])).toEqual({
            tool: 'rulesets',
            config: 'x',
            entireFleet: false,
            rest: [],
        })
        expect(splitVerbArgs(['--config=../infra', '--entire-fleet'])).toEqual({
            config: '../infra',
            entireFleet: true,
            rest: [],
        })
    })

    test('records --repo and keeps it in rest', () => {
        expect(splitVerbArgs(['rulesets', '--repo', 'site'])).toEqual({
            tool: 'rulesets',
            repo: 'site',
            entireFleet: false,
            rest: ['--repo', 'site'],
        })
        expect(splitVerbArgs(['--repo=o/site']).repo).toBe('o/site')
        expect(splitVerbArgs(['--repo=o/site']).rest).toEqual(['--repo=o/site'])
    })

    test('a value after --repo is not the tool', () => {
        expect(splitVerbArgs(['--repo', 'rulesets']).tool).toBeUndefined()
    })

    test('passes other flags through', () => {
        expect(splitVerbArgs(['rulesets', '--prune']).rest).toEqual(['--prune'])
    })

    test('rejects an unknown positional or a second tool', () => {
        expect(() => splitVerbArgs(['nope'])).toThrow('"nope"')
        expect(() => splitVerbArgs(['rulesets', 'cf-tokens'])).toThrow(
            'one tool',
        )
    })

    test('rejects the flags the verb itself sets, and --try/--groups', () => {
        for (const f of ['--apply', '--check', '--try', '--groups'])
            expect(() => splitVerbArgs(['cf-tokens', f])).toThrow(f)
        expect(() => splitVerbArgs(['rulesets', '--config'])).toThrow(
            '--config',
        )
    })
})

describe('applyTargetError', () => {
    const repos = ['a/x', 'b/x', 'a/site']

    test('--entire-fleet alone is fine', () => {
        expect(applyTargetError(repos, { entireFleet: true })).toBeNull()
    })

    test('--repo matching exactly one is fine', () => {
        expect(
            applyTargetError(repos, { entireFleet: false, repo: 'site' }),
        ).toBeNull()
        expect(
            applyTargetError(repos, { entireFleet: false, repo: 'b/x' }),
        ).toBeNull()
    })

    test('neither flag lists the repos', () => {
        const e = applyTargetError(repos, { entireFleet: false })
        expect(e).toContain('--repo')
        expect(e).toContain('--entire-fleet')
        for (const r of repos) expect(e).toContain(r)
    })

    test('both flags conflict', () => {
        expect(
            applyTargetError(repos, { entireFleet: true, repo: 'site' }),
        ).toContain('not both')
    })

    test('no match says so', () => {
        expect(
            applyTargetError(repos, { entireFleet: false, repo: 'nope' }),
        ).toContain('no repo matches --repo nope')
    })

    test('a bare name in two orgs lists both', () => {
        const e = applyTargetError(repos, { entireFleet: false, repo: 'x' })
        expect(e).toContain('a/x')
        expect(e).toContain('b/x')
    })

    test('a suffix that is not a whole name does not match', () => {
        expect(
            applyTargetError(['a/mysite'], {
                entireFleet: false,
                repo: 'site',
            }),
        ).toContain('no repo matches')
    })
})

describe('worstExit', () => {
    test('2 over 1 over 0', () => {
        expect(worstExit([])).toBe(0)
        expect(worstExit([0, 0])).toBe(0)
        expect(worstExit([0, 1])).toBe(1)
        expect(worstExit([1, 2])).toBe(2)
        expect(worstExit([2, 0])).toBe(2)
        expect(worstExit([3])).toBe(1)
    })
})

const CLI = resolve(import.meta.dir, '..', 'scripts', 'cli.ts')
const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A temp root with an empty home and xdg, and a config dir of `files`. */
function fixture(files: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'voidflow-verbs-'))
    roots.push(root)
    const home = join(root, 'home')
    const xdg = join(root, 'xdg')
    const cfg = join(root, 'infra')
    const work = join(root, 'work')
    for (const d of [home, xdg, cfg, work]) mkdirSync(d)
    for (const [f, text] of Object.entries(files))
        writeFileSync(join(cfg, f), text)
    return { root, home, xdg, cfg, work }
}

const RULESETS = 'export default { orgs: { o: { repos: { a: {}, b: {} } } } }'

async function voidflow(args: string[], f: ReturnType<typeof fixture>) {
    const proc = Bun.spawn(['bun', CLI, ...args], {
        cwd: f.work,
        env: {
            ...process.env,
            HOME: f.home,
            XDG_CONFIG_HOME: f.xdg,
            VOIDFLOW_CONFIG: '',
            VOIDFLOW_CONFIG_BASE: '',
            CF_TOKEN_ADMIN: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    return { code, out, err }
}

describe('voidflow plan|check|apply', () => {
    test('--help prints usage and exits 0', async () => {
        const r = await voidflow(['plan', '--help'], fixture())
        expect(r.code).toBe(0)
        expect(r.out).toContain('usage: voidflow plan')
    })

    test('apply without a tool exits 2', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(['apply', '--config', f.cfg], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('apply needs a tool')
    })

    test('apply rulesets without a target exits 2 and lists the repos', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(['apply', 'rulesets', '--config', f.cfg], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('o/a')
        expect(r.err).toContain('o/b')
        expect(r.err).toContain('--entire-fleet')
    })

    test('plan with nothing discoverable exits 2 and names the sources', async () => {
        const f = fixture()
        const r = await voidflow(['plan'], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('no fleet config found')
        expect(r.err).toContain(join(f.xdg, 'voidflow'))
        expect(r.err).toContain('VOIDFLOW_CONFIG')
        expect(r.err).not.toContain('    at ')
    })

    test('a named tool with no file exits 2 saying where it looked', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(['plan', 'cf-tokens', '--config', f.cfg], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('cf-tokens.ts')
        expect(r.err).toContain(f.cfg)
    })

    test('prints the header on stderr, then runs the tool', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(
            ['plan', 'rulesets', '--config', f.cfg, '--repo', 'nope'],
            f,
        )
        expect(r.code).toBe(2)
        const file = join(f.cfg, 'rulesets.ts')
        expect(r.err).toMatch(
            new RegExp(
                `voidflow \\S+ plan rulesets \\| config ${file.replace(/[.\\/]/g, '\\$&')} \\(flag\\) \\| scope repo nope \\(read-only\\)`,
            ),
        )
        expect(r.err).toContain('no repo matches --repo nope')
        expect(r.out).not.toContain('voidflow ')
    })

    test('a tool missing from the config dir is skipped with a note', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(
            ['plan', '--config', f.cfg, '--repo', 'nope'],
            f,
        )
        expect(r.err).toContain('cf-tokens: no cf-tokens.ts')
        expect(r.err).toContain('skipped')
        expect(r.err).toContain('plan rulesets')
        expect(r.code).toBe(2)
    })

    test('a --config file with no tool named exits 2', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(
            ['plan', '--config', join(f.cfg, 'rulesets.ts')],
            f,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('name the tool')
    })

    test('discovers ~/.config/voidflow through a symlink', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        symlinkSync(f.cfg, join(f.xdg, 'voidflow'))
        const r = await voidflow(['check', 'rulesets', '--repo', 'nope'], f)
        expect(r.err).toContain(
            `config ${join(f.xdg, 'voidflow', 'rulesets.ts')} (xdg)`,
        )
        expect(r.err).toContain('no repo matches')
    })

    test('a dangling xdg symlink exits 2 with a message, not a stack trace', async () => {
        const f = fixture()
        symlinkSync(join(f.root, 'gone'), join(f.xdg, 'voidflow'))
        writeFileSync(join(f.work, 'rulesets.ts'), RULESETS)
        const r = await voidflow(['plan'], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain(join(f.xdg, 'voidflow'))
        expect(r.err).toContain('missing')
        expect(r.err).not.toContain('    at ')
    })

    test('a missing --config path exits 2 naming it', async () => {
        const f = fixture()
        const r = await voidflow(['plan', '--config', join(f.root, 'nope')], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain(join(f.root, 'nope'))
        expect(r.err).not.toContain('    at ')
    })

    test('a bare --repo in two orgs: apply refuses listing both', async () => {
        const f = fixture({
            'rulesets.ts':
                'export default { orgs: { a: { repos: { x: {} } }, b: { repos: { x: {} } } } }',
        })
        const r = await voidflow(
            ['apply', 'rulesets', '--config', f.cfg, '--repo', 'x'],
            f,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('a/x')
        expect(r.err).toContain('b/x')
    })

    test('a bad orgs config exits 2 reporting by path', async () => {
        const f = fixture({
            'rulesets.ts':
                "export default { orgs: { a: { repos: { 'x/y': {} } } } }",
        })
        const r = await voidflow(
            ['apply', 'rulesets', '--config', f.cfg, '--entire-fleet'],
            f,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('orgs.a.repos."x/y": name has a slash')
        expect(r.err).not.toContain('    at ')
    })
})
