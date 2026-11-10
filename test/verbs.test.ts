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
import {
    applyTargetError,
    splitVerbArgs,
    toolArgs,
    worstExit,
} from '../scripts/verbs.ts'

describe('splitVerbArgs', () => {
    test('the first positional is the tool', () => {
        expect(splitVerbArgs(['rulesets'])).toEqual({
            tool: 'rulesets',
            entireFleet: false,
            rest: [],
        })
        expect(splitVerbArgs(['--prune', 'tokens', 'cf'])).toEqual({
            tool: 'cf-tokens',
            provider: 'cf',
            entireFleet: false,
            rest: ['--prune'],
        })
        expect(splitVerbArgs([]).tool).toBeUndefined()
    })

    test('tokens alone means every tokens provider', () => {
        expect(splitVerbArgs(['tokens'])).toEqual({
            tokensAll: true,
            entireFleet: false,
            rest: [],
        })
    })

    test('rejects an unknown provider or extra positionals', () => {
        expect(() => splitVerbArgs(['tokens', 'bogus'])).toThrow(
            'unknown provider "bogus"',
        )
        expect(() => splitVerbArgs(['tokens', 'cf', 'x'])).toThrow(
            'one provider at a time',
        )
        expect(() => splitVerbArgs(['rulesets', 'cf'])).toThrow(
            'rulesets takes no provider',
        )
        expect(() => splitVerbArgs(['nope'])).toThrow('unknown tool "nope"')
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
        expect(() => splitVerbArgs(['rulesets', 'tokens'])).toThrow(
            'rulesets takes no provider',
        )
    })

    test('rejects the flags the verb itself sets, and --try/--groups', () => {
        for (const f of ['--apply', '--check', '--try', '--groups'])
            expect(() => splitVerbArgs(['tokens', 'cf', f])).toThrow(f)
        expect(() => splitVerbArgs(['rulesets', '--config'])).toThrow(
            '--config',
        )
    })

    test('--entire-fleet takes no inline value', () => {
        for (const a of ['--entire-fleet=false', '--entire-fleet=true'])
            expect(() => splitVerbArgs(['rulesets', a])).toThrow(
                '--entire-fleet takes no value',
            )
    })

    test('flags after -- are forwarded as given', () => {
        expect(
            splitVerbArgs(['tokens', 'cf', '--repo', 'a', '--', 'x', '--check'])
                .rest,
        ).toEqual(['--repo', 'a', '--', 'x', '--check'])
    })

    test('--repo needs a value, and a flag is not one', () => {
        expect(() => splitVerbArgs(['rulesets', '--repo'])).toThrow(
            '--repo needs a value',
        )
        expect(() =>
            splitVerbArgs(['rulesets', '--repo', '--entire-fleet']),
        ).toThrow('--repo needs a value')
        expect(() => splitVerbArgs(['rulesets', '--repo='])).toThrow(
            '--repo needs a value',
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

describe('toolArgs', () => {
    test('the verb flag goes before the forwarded flags and any --', () => {
        const args = toolArgs('check', 'cf-tokens', '/c.ts', [
            '--repo',
            'a',
            '--',
            'x',
        ])
        expect(args).toEqual([
            'tokens',
            'cf',
            '--config',
            '/c.ts',
            '--check',
            '--repo',
            'a',
            '--',
            'x',
        ])
        expect(toolArgs('plan', 'rulesets', '/r.ts', [])).toEqual([
            'rulesets',
            '--config',
            '/r.ts',
        ])
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
        const r = await voidflow(['plan', 'tokens', 'cf', '--config', f.cfg], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('tokens cf: no cf-tokens.ts')
        expect(r.err).toContain(f.cfg)
    })

    test('tokens with no provider runs every tokens provider', async () => {
        const f = fixture({
            'cf-tokens.ts': `export default { 'o/zz': { account: '${'c'.repeat(32)}', envs: [{ env: 'prod' }], retire: [] } }`,
        })
        const r = await voidflow(['plan', 'tokens', '--config', f.cfg], f)
        expect(r.err).toContain('plan tokens cf |')
        expect(r.err).toContain('CF_TOKEN_ADMIN is not set')
    })

    test('apply tokens with no provider refuses', async () => {
        const f = fixture({ 'cf-tokens.ts': 'export default {}' })
        const r = await voidflow(['apply', 'tokens', '--config', f.cfg], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('apply tokens needs a provider')
    })

    test('an unknown provider exits 2', async () => {
        const f = fixture({ 'rulesets.ts': RULESETS })
        const r = await voidflow(['plan', 'tokens', 'bogus'], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('unknown provider "bogus"')
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
        expect(r.err).toContain('tokens cf: no cf-tokens.ts')
        expect(r.err).toContain('skipped')
        expect(r.err).toContain('no repo matches --repo nope')
        expect(r.code).toBe(2)
    })

    test('without a tool, --repo skips a tool whose config lacks the repo', async () => {
        // cf-tokens runs (and stops on the missing CF_TOKEN_ADMIN, before
        // any network call); rulesets has no o/zz, so it is skipped rather
        // than reporting "no repo matches" as a config error.
        const f = fixture({
            'rulesets.ts': RULESETS,
            'cf-tokens.ts': `export default { 'o/zz': { account: '${'c'.repeat(32)}', envs: [{ env: 'prod' }], retire: [] } }`,
        })
        const r = await voidflow(
            ['check', '--config', f.cfg, '--repo', 'zz'],
            f,
        )
        expect(r.err).toContain(
            `rulesets: no repo matches --repo zz in ${join(f.cfg, 'rulesets.ts')}, skipped`,
        )
        expect(r.err).not.toContain('check rulesets |')
        expect(r.err).toContain('check tokens cf |')
        expect(r.err).toContain('CF_TOKEN_ADMIN is not set')
    })

    test('without a tool, --repo in no config exits 2', async () => {
        const f = fixture({
            'rulesets.ts': RULESETS,
            'cf-tokens.ts': 'export default {}',
        })
        const r = await voidflow(['plan', '--config', f.cfg, '--repo', 'zz'], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('no repo matches --repo zz in ')
        expect(r.err).not.toContain('plan rulesets |')
    })

    test('an xdg dir without the file says cwd was not searched', async () => {
        const f = fixture()
        mkdirSync(join(f.xdg, 'voidflow'))
        writeFileSync(join(f.xdg, 'voidflow', 'rulesets.ts'), RULESETS)
        writeFileSync(join(f.work, 'cf-tokens.ts'), 'export default {}')
        const r = await voidflow(['plan', 'tokens', 'cf'], f)
        expect(r.code).toBe(2)
        expect(r.err).toContain('it exists, so')
        expect(r.err).toContain('were not searched')
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
