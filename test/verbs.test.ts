import { afterEach, describe, expect, test } from 'bun:test'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { VoidflowConfig } from '../config/index.ts'
import {
    applyCommand,
    confirm,
    parseVerbArgs,
    presetsFor,
    worstExit,
} from '../scripts/verbs.ts'

describe('parseVerbArgs', () => {
    test('the first positional is the preset', () => {
        expect(parseVerbArgs('plan', ['rulesets']).preset).toBe('rulesets')
        expect(parseVerbArgs('check', ['settings']).preset).toBe('settings')
        expect(parseVerbArgs('apply', ['tokens']).preset).toBe('tokens')
        expect(parseVerbArgs('plan', []).preset).toBeUndefined()
    })

    test('rejects an unknown preset, a second one, or a command after --', () => {
        expect(() => parseVerbArgs('plan', ['nope'])).toThrow(
            'unknown preset "nope" (rulesets, settings, tokens)',
        )
        expect(() => parseVerbArgs('plan', ['tokens', 'cf'])).toThrow(
            'one preset at a time',
        )
        expect(() => parseVerbArgs('plan', ['rulesets', '--', 'x'])).toThrow(
            'takes no command',
        )
    })

    test('apply needs a preset', () => {
        expect(() => parseVerbArgs('apply', [])).toThrow('apply needs a preset')
    })

    test('the fleet and per-tool flags say what replaced them', () => {
        for (const [flag, why] of [
            ['--config', 'fleet configs were removed'],
            ['--config=x', 'fleet configs were removed'],
            ['--repo', 'run it inside that repo'],
            ['--entire-fleet', 'fleet configs were removed'],
            ['--repo-config', 'finds the voidflow.config.ts itself'],
            ['--apply', 'voidflow apply <preset>'],
            ['--check', 'voidflow check <preset>'],
            ['--try', 'voidflow try tokens'],
        ])
            expect(() => parseVerbArgs('plan', ['rulesets', flag])).toThrow(why)
    })

    test('--local-wrangler collects its envs and needs a value', () => {
        expect(
            parseVerbArgs('plan', [
                'tokens',
                '--local-wrangler',
                'preview',
                '--local-wrangler=staging',
            ]).localWrangler,
        ).toEqual(['preview', 'staging'])
        expect(() =>
            parseVerbArgs('plan', ['tokens', '--local-wrangler']),
        ).toThrow('--local-wrangler needs a value')
        expect(() =>
            parseVerbArgs('plan', ['rulesets', '--local-wrangler', 'x']),
        ).toThrow('tokens flag')
    })

    test('an unknown flag is an error', () => {
        expect(() => parseVerbArgs('plan', ['--nope'])).toThrow(
            'unknown flag --nope',
        )
    })

    test('flags go with the presets that take them', () => {
        expect(parseVerbArgs('apply', ['rulesets', '--prune']).prune).toBe(true)
        expect(parseVerbArgs('apply', ['tokens', '--rotate']).rotate).toBe(true)
        expect(parseVerbArgs('plan', ['tokens', '--groups']).groups).toBe(true)
        expect(() => parseVerbArgs('apply', ['settings', '--prune'])).toThrow(
            'rulesets and tokens flag',
        )
        expect(() => parseVerbArgs('apply', ['rulesets', '--rotate'])).toThrow(
            'tokens flag',
        )
        expect(() => parseVerbArgs('check', ['tokens', '--groups'])).toThrow(
            'voidflow plan tokens',
        )
        expect(() => parseVerbArgs('plan', ['--groups'])).toThrow(
            'voidflow plan tokens',
        )
    })

    test('try takes tokens, one env and a command after --', () => {
        const a = parseVerbArgs('try', ['tokens', 'prod', '--', 'bunx', '-v'])
        expect(a).toMatchObject({
            preset: 'tokens',
            env: 'prod',
            cmd: ['bunx', '-v'],
        })
        expect(() =>
            parseVerbArgs('try', ['rulesets', 'prod', '--', 'x']),
        ).toThrow('try takes tokens')
        expect(() => parseVerbArgs('try', ['tokens', '--', 'x'])).toThrow(
            'needs one env',
        )
        expect(() => parseVerbArgs('try', ['tokens', 'prod'])).toThrow(
            'needs a command after --',
        )
    })

    test('flags after -- belong to the command', () => {
        expect(
            parseVerbArgs('try', ['tokens', 'prod', '--', 'x', '--config']).cmd,
        ).toEqual(['x', '--config'])
    })

    test('--yes goes with apply only', () => {
        expect(parseVerbArgs('apply', ['rulesets', '--yes']).yes).toBe(true)
        expect(parseVerbArgs('apply', ['rulesets', '-y']).yes).toBe(true)
        expect(() => parseVerbArgs('plan', ['--yes'])).toThrow(
            '--yes goes with apply',
        )
    })

    test('validate takes no preset and no flags but --no-color', () => {
        expect(parseVerbArgs('validate', ['--no-color']).noColor).toBe(true)
        expect(() => parseVerbArgs('validate', ['rulesets'])).toThrow(
            'validate takes no preset',
        )
        expect(() => parseVerbArgs('validate', ['--prune'])).toThrow(
            'no flags but --no-color',
        )
    })

    test('--help wins over everything else', () => {
        expect(parseVerbArgs('apply', ['--help']).help).toBe(true)
    })
})

describe('presetsFor', () => {
    const CF = {
        kind: 'site',
        cloudflare: {
            account: 'c'.repeat(32),
            adminTokenEnv: 'CF_TOKEN_ADMIN_Q',
            envs: [{ env: 'prod' }],
        },
    } satisfies VoidflowConfig

    test('a named preset runs alone', () => {
        expect(presetsFor('settings', CF, {})).toEqual({ run: ['settings'] })
    })

    test('a bare verb runs tokens after rulesets and settings when the admin variable is set', () => {
        expect(presetsFor(undefined, CF, { CF_TOKEN_ADMIN_Q: 'x' })).toEqual({
            run: ['rulesets', 'settings', 'tokens'],
        })
    })

    test('a bare verb skips tokens when the admin variable is unset or empty', () => {
        for (const env of [{}, { CF_TOKEN_ADMIN_Q: '' }])
            expect(presetsFor(undefined, CF, env)).toEqual({
                run: ['rulesets', 'settings'],
                skipped: 'tokens skipped (CF_TOKEN_ADMIN_Q not set)',
            })
    })

    test('a bare verb skips tokens without a cloudflare section', () => {
        expect(presetsFor(undefined, { kind: 'tool' }, {})).toEqual({
            run: ['rulesets', 'settings'],
            skipped:
                'tokens skipped (no cloudflare section in voidflow.config.ts)',
        })
    })
})

describe('applyCommand', () => {
    const args = (argv: string[]) => parseVerbArgs('plan', argv)
    test('names the preset and carries --prune and --rotate', () => {
        expect(applyCommand('settings', args([]))).toBe(
            'voidflow apply settings',
        )
        expect(applyCommand('rulesets', args(['--prune']))).toBe(
            'voidflow apply rulesets --prune',
        )
        expect(
            applyCommand('tokens', args(['tokens', '--rotate', '--prune'])),
        ).toBe('voidflow apply tokens --prune --rotate')
        expect(
            applyCommand(
                'tokens',
                args(['tokens', '--local-wrangler', 'preview']),
            ),
        ).toBe('voidflow apply tokens --local-wrangler preview')
    })
})

describe('confirm', () => {
    async function answer(text: string) {
        const input = new PassThrough()
        const output = new PassThrough()
        const asked = confirm('Apply? [y/N] ', { input, output })
        input.end(text)
        return asked
    }
    test('only y or yes, in any case, is yes', async () => {
        for (const yes of ['y\n', 'Y\n', 'yes\n', ' YES \n'])
            expect(await answer(yes)).toBe(true)
        for (const no of ['\n', 'n\n', 'no\n', 'yep\n', 'sure\n'])
            expect(await answer(no)).toBe(false)
    })
})

describe('worstExit', () => {
    test('2 over 1 over 0', () => {
        expect(worstExit([])).toBe(0)
        expect(worstExit([0, 0])).toBe(0)
        expect(worstExit([0, 1])).toBe(1)
        expect(worstExit([1, 2, 0])).toBe(2)
        expect(worstExit([3])).toBe(1)
    })
})

const CLI = resolve(import.meta.dir, '..', 'scripts', 'cli.ts')
const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/**
 * Run the CLI in a temp repo holding `config` as voidflow.config.ts (none
 * when null), with a gh on PATH that only leaves a marker and fails.
 */
async function inRepo(
    args: string[],
    config: string | null,
    env: Record<string, string> = {},
) {
    const root = mkdtempSync(join(tmpdir(), 'voidflow-verbs-'))
    roots.push(root)
    const work = join(root, 'work')
    const shim = join(root, 'shim')
    for (const d of [work, join(work, '.git'), shim]) mkdirSync(d)
    const file = join(work, 'voidflow.config.ts')
    if (config !== null) writeFileSync(file, config)
    const marker = join(shim, 'gh-called')
    writeFileSync(join(shim, 'gh'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
    chmodSync(join(shim, 'gh'), 0o755)
    const proc = Bun.spawn(['bun', CLI, ...args], {
        cwd: work,
        env: {
            ...process.env,
            PATH: `${shim}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'o/n',
            GH_TOKEN: '',
            GITHUB_TOKEN: '',
            CF_TOKEN_ADMIN: '',
            CF_TOKEN_ADMIN_Q: '',
            ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ])
    return {
        code,
        out,
        err,
        file: config === null ? file : realpathSync(file),
        ghCalled: existsSync(marker),
    }
}

const TOOL = "export default { kind: 'tool' }"
const CF = `export default { kind: 'site', cloudflare: { account: '${'c'.repeat(32)}', adminTokenEnv: 'CF_TOKEN_ADMIN_Q', envs: [{ env: 'prod' }] } }`

describe('voidflow plan|check|apply|try', () => {
    test('--help prints usage and exits 0, even outside a repo config', async () => {
        const r = await inRepo(['apply', '--help'], null)
        expect(r.code).toBe(0)
        expect(r.out).toContain(
            'usage: voidflow apply rulesets|settings|tokens',
        )
    })

    test('a bad argument exits 2 with usage, before reading the config', async () => {
        const r = await inRepo(['plan', 'rulesets', '--repo', 'x'], TOOL)
        expect(r.code).toBe(2)
        expect(r.err).toContain('--repo:')
        expect(r.err).toContain('usage: voidflow plan')
        expect(r.ghCalled).toBe(false)
    })

    test('without a voidflow.config.ts exits 2 pointing at init', async () => {
        const r = await inRepo(['plan'], null)
        expect(r.code).toBe(2)
        expect(r.err).toContain('no voidflow.config.ts')
        expect(r.err).toContain('voidflow init')
        expect(r.ghCalled).toBe(false)
    })

    test('plan rulesets reads the repo file and names the repo and credential', async () => {
        const r = await inRepo(['plan', 'rulesets'], TOOL)
        expect(r.err).toContain(
            `plan rulesets | config ${r.file} | repo o/n | credential gh auth`,
        )
        expect(r.ghCalled).toBe(true)
    })

    test('a read that fails is exit 2 under check, never drift', async () => {
        const r = await inRepo(['check', 'rulesets'], TOOL)
        expect(r.ghCalled).toBe(true)
        expect(r.code).toBe(2)
    })

    test('VOIDFLOW_CONFIG no longer redirects a run away from the repo file, and says so', async () => {
        const r = await inRepo(['plan', 'rulesets'], TOOL, {
            VOIDFLOW_CONFIG: '/nonexistent/infra',
        })
        expect(r.err).toContain('VOIDFLOW_CONFIG is set but ignored')
        expect(r.err).toContain(`config ${r.file} |`)
        const unset = await inRepo(['plan', 'rulesets'], TOOL)
        expect(unset.err).not.toContain('VOIDFLOW_CONFIG')
    })

    test('a bare plan runs rulesets and settings and says tokens were skipped', async () => {
        const r = await inRepo(['plan'], TOOL)
        expect(r.err).toContain('plan rulesets |')
        expect(r.err).toContain(
            `plan settings | config ${r.file} | repo o/n | credential gh auth`,
        )
        expect(r.err).toContain('tokens skipped (no cloudflare section')
    })

    test('a config that does not load exits 2 naming the file, before any gh call', async () => {
        const r = await inRepo(
            ['plan', 'rulesets'],
            "export default { kind: 'sit' }",
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain(r.file)
        expect(r.ghCalled).toBe(false)
    })

    test('no repo slug exits 2 with the reason', async () => {
        const r = await inRepo(['plan', 'rulesets'], TOOL, {
            GITHUB_REPOSITORY: '',
        })
        expect(r.code).toBe(2)
        expect(r.err).toContain('cannot tell which GitHub repo')
    })

    test('plan tokens without a cloudflare section exits 2, never falling back to a fleet', async () => {
        const r = await inRepo(['plan', 'tokens'], TOOL)
        expect(r.code).toBe(2)
        expect(r.err).toContain('tokens: no cloudflare section')
        expect(r.ghCalled).toBe(false)
    })

    test('plan tokens names the admin variable the section picks, not CF_TOKEN_ADMIN', async () => {
        const r = await inRepo(['plan', 'tokens'], CF, { CF_TOKEN_ADMIN: 'x' })
        expect(r.err).toContain(
            `plan tokens | config ${r.file} | repo o/n | credential CF_TOKEN_ADMIN_Q`,
        )
        expect(r.code).toBe(2)
        expect(r.err).toContain('CF_TOKEN_ADMIN_Q is not set')
    })

    test('a bare plan skips tokens when the admin variable is unset', async () => {
        const r = await inRepo(['plan'], CF)
        expect(r.err).toContain('tokens skipped (CF_TOKEN_ADMIN_Q not set)')
        expect(r.err).not.toContain('plan tokens |')
    })

    test('a bare plan runs tokens after rulesets when the admin variable is set', async () => {
        // A dead proxy keeps the Cloudflare calls off the network.
        const r = await inRepo(['plan'], CF, {
            CF_TOKEN_ADMIN_Q: 'x',
            HTTPS_PROXY: 'http://127.0.0.1:9',
            https_proxy: 'http://127.0.0.1:9',
        })
        const rules = r.err.indexOf('plan rulesets |')
        const tokens = r.err.indexOf('plan tokens |')
        expect(rules).toBeGreaterThan(-1)
        expect(tokens).toBeGreaterThan(rules)
    })

    test('validate checks the file offline: 0 when valid, 2 naming the problem', async () => {
        const ok = await inRepo(['validate'], TOOL, { GITHUB_REPOSITORY: '' })
        expect(ok.code).toBe(0)
        expect(ok.out).toContain(`${ok.file}: valid`)
        expect(ok.ghCalled).toBe(false)
        const bad = await inRepo(
            ['validate'],
            "export default { kind: 'tool', rulesets: { tiers: ['nope'] } }",
        )
        expect(bad.code).toBe(2)
        expect(bad.err).toContain('rulesets.tiers[0]: unknown tier "nope"')
        expect(bad.ghCalled).toBe(false)
        const none = await inRepo(['validate'], null)
        expect(none.code).toBe(2)
        expect(none.err).toContain('no voidflow.config.ts')
    })

    test('apply without a terminal refuses unless --yes, before any gh call', async () => {
        const r = await inRepo(['apply', 'rulesets'], TOOL)
        expect(r.code).toBe(2)
        expect(r.err).toContain('pass --yes to write without asking')
        expect(r.ghCalled).toBe(false)
        const yes = await inRepo(['apply', 'rulesets', '--yes'], TOOL)
        expect(yes.err).toContain('apply rulesets | config')
        expect(yes.ghCalled).toBe(true)
    })

    test('try tokens with an env the section lacks exits 2 listing its envs', async () => {
        const r = await inRepo(['try', 'tokens', 'staging', '--', 'true'], CF, {
            CF_TOKEN_ADMIN_Q: 'x',
        })
        expect(r.code).toBe(2)
        expect(r.err).toContain(
            'no env staging in the cloudflare section (envs: prod)',
        )
    })
})
