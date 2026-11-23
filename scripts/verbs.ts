/**
 * The verbs, run on the repo's own voidflow.config.ts (found from the current
 * directory up to the git root):
 *
 *   voidflow plan  [rulesets|settings|tokens]   # read-only
 *   voidflow check [rulesets|settings|tokens]   # exit 1 on drift
 *   voidflow apply  rulesets|settings|tokens    # write
 *   voidflow try    tokens <env> -- <command...>
 *
 * Each preset runs in this process (scripts/presets/). See docs/config.md.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { adminTokenVar, type VoidflowConfig } from '../config/index.ts'
import { credentialSource } from './init/gh.ts'
import { packageRoot } from './lib/package-root.ts'
import {
    CONFIG_FILE,
    findRepoConfig,
    loadVoidflowConfig,
    repoSlug,
} from './lib/repo-config.ts'
import {
    PRESETS,
    type Preset,
    type PresetCtx,
    type Verb,
} from './presets/context.ts'
import type { TokensMode } from './presets/tokens.ts'

export type { Preset, Verb }

/** Flags that belonged to the fleet tools or the per-tool commands. */
const REMOVED: Record<string, string> = {
    '--config':
        'fleet configs were removed; voidflow reads the voidflow.config.ts of the repo you run it in',
    '--repo':
        'voidflow manages the repo whose voidflow.config.ts it reads; run it inside that repo',
    '--entire-fleet':
        'fleet configs were removed; run voidflow inside each repo',
    '--repo-config':
        'voidflow finds the voidflow.config.ts itself; run it inside that repo',
    '--apply': 'the verb is the command: run `voidflow apply <preset>`',
    '--check': 'the verb is the command: run `voidflow check <preset>`',
    '--try': 'run `voidflow try tokens <env> -- <command>`',
}

export type VerbArgs = {
    preset?: Preset
    prune: boolean
    rotate: boolean
    groups: boolean
    noColor: boolean
    help: boolean
    /** try: the env, then the command after `--`. */
    env?: string
    cmd: string[]
}

/** Parse a verb's arguments; throws with the reason on a bad one. */
export function parseVerbArgs(verb: Verb | 'try', argv: string[]): VerbArgs {
    const out: VerbArgs = {
        prune: false,
        rotate: false,
        groups: false,
        noColor: false,
        help: false,
        cmd: [],
    }
    const pos: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--') {
            out.cmd = argv.slice(i + 1)
            break
        }
        const flag = a.split('=', 1)[0]
        if (a === '-h' || a === '--help') out.help = true
        else if (Object.hasOwn(REMOVED, flag))
            throw new Error(`${flag}: ${REMOVED[flag]}`)
        else if (a === '--prune') out.prune = true
        else if (a === '--rotate') out.rotate = true
        else if (a === '--groups') out.groups = true
        else if (a === '--no-color') out.noColor = true
        else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`)
        else pos.push(a)
    }
    if (out.help) return out

    const [first, ...more] = pos
    if (first !== undefined) {
        if (!(PRESETS as readonly string[]).includes(first))
            throw new Error(
                `unknown preset ${JSON.stringify(first)} (${PRESETS.join(', ')})`,
            )
        out.preset = first as Preset
    }
    if (verb === 'try') {
        if (out.preset !== 'tokens')
            throw new Error(
                'try takes tokens: voidflow try tokens <env> -- <command>',
            )
        if (more.length !== 1)
            throw new Error(
                'try tokens needs one env: voidflow try tokens <env> -- <command>',
            )
        out.env = more[0]
        if (out.cmd.length === 0)
            throw new Error('try needs a command after --')
    } else {
        if (more.length > 0)
            throw new Error(
                `one preset at a time, got ${JSON.stringify(more[0])} after ${first}`,
            )
        if (out.cmd.length > 0)
            throw new Error(`${verb} takes no command after --`)
        if (verb === 'apply' && out.preset === undefined)
            throw new Error(
                `apply needs a preset: voidflow apply ${PRESETS.join('|')}`,
            )
    }
    if (out.groups && (verb !== 'plan' || out.preset !== 'tokens'))
        throw new Error('--groups goes with `voidflow plan tokens`')
    if (out.rotate && out.preset !== undefined && out.preset !== 'tokens')
        throw new Error('--rotate is a tokens flag')
    if (out.prune && out.preset === 'settings')
        throw new Error('--prune is a rulesets and tokens flag')
    return out
}

export const usage = (verb: Verb | 'try') =>
    verb === 'try'
        ? `usage: voidflow try tokens <env> -- <command...>

Runs the command with a throwaway Cloudflare token scoped like <env>'s, the
admin token removed from its environment; the token is deleted afterwards.
Needs the cloudflare section's admin token variable.`
        : `usage: voidflow ${verb} ${verb === 'apply' ? PRESETS.join('|') : `[${PRESETS.join('|')}]`} [flags]

  --prune      ${verb === 'apply' ? 'also delete' : 'with apply, delete'} what the config lists under retire (rulesets, tokens)
  --rotate     tokens: rotate every token now
${verb === 'plan' ? '  --groups     tokens: print the live names of the permission groups used\n' : ''}  --no-color   no ANSI colors

${
    verb === 'plan'
        ? 'Read-only: prints what apply would change.'
        : verb === 'check'
          ? 'Read-only: exit 1 on drift, 2 on a config or auth error.'
          : 'Writes the repo the config sits in.'
}${
    verb === 'apply'
        ? ''
        : `
Without a preset, runs rulesets, then settings (skipped when gh lacks admin
on the repo), then tokens (skipped without a cloudflare section or its admin
token variable).`
}

Reads the ${CONFIG_FILE} found from here up to the git root. See
https://github.com/taraxvoid/voidflow/blob/main/docs/config.md`

/** The exit code for a run of several presets: 2 over 1 over 0. */
export function worstExit(codes: number[]): 0 | 1 | 2 {
    if (codes.includes(2)) return 2
    return codes.some((c) => c !== 0) ? 1 : 0
}

/**
 * The presets one verb runs: a named preset alone; otherwise rulesets,
 * settings (which skips itself without admin), then tokens when the file has
 * a cloudflare section and its admin token variable is set (so a repo's CI,
 * which has neither, still checks rulesets), with `skipped` saying why tokens
 * did not run.
 */
export function presetsFor(
    preset: Preset | undefined,
    cfg: VoidflowConfig,
    env: Record<string, string | undefined>,
): { run: Preset[]; skipped?: string } {
    if (preset) return { run: [preset] }
    const always: Preset[] = ['rulesets', 'settings']
    const cf = cfg.cloudflare
    if (!cf)
        return {
            run: always,
            skipped: `tokens skipped (no cloudflare section in ${CONFIG_FILE})`,
        }
    const admin = adminTokenVar(cf)
    if (!env[admin])
        return { run: always, skipped: `tokens skipped (${admin} not set)` }
    return { run: [...always, 'tokens'] }
}

/** The command that applies what a plan of `preset` shows. */
export function applyHint(preset: Preset, a: VerbArgs): string {
    return [
        'voidflow apply',
        preset,
        ...(a.prune ? ['--prune'] : []),
        ...(a.rotate && preset === 'tokens' ? ['--rotate'] : []),
    ].join(' ')
}

/** The credential a preset uses, by name (never its value). */
function credential(
    preset: Preset,
    cfg: VoidflowConfig,
    env: PresetCtx['env'],
) {
    return preset === 'tokens' && cfg.cloudflare
        ? adminTokenVar(cfg.cloudflare)
        : credentialSource(env)
}

function version(): string {
    try {
        return JSON.parse(
            readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
        ).version
    } catch {
        return 'unknown'
    }
}

/** The config, the repo it belongs to, or exit 2 with the reason. */
async function loadRepo(
    prog: string,
): Promise<{ file: string; cfg: VoidflowConfig; repo: string }> {
    // It used to point the verbs at a fleet config; say so rather than
    // leave someone wondering why it no longer does anything.
    if (process.env.VOIDFLOW_CONFIG)
        console.error(
            `${prog}: VOIDFLOW_CONFIG is set but ignored: fleet configs were removed, and voidflow reads the ${CONFIG_FILE} of the repo it runs in`,
        )
    const file = findRepoConfig(process.cwd())
    if (!file)
        fail(
            `${prog}: no ${CONFIG_FILE} in ${process.cwd()} or above it up to the git root; write one with \`voidflow init --kind tool|site\` (see docs/config.md)`,
        )
    try {
        const cfg = await loadVoidflowConfig(file)
        const repo = await repoSlug(process.env, dirname(file))
        return { file, cfg, repo }
    } catch (e) {
        fail(`${prog}: ${(e as Error).message}`)
    }
}

function fail(msg: string): never {
    console.error(msg)
    process.exit(2)
}

/** Run one preset, loaded when it runs, so --help and usage errors stay cheap. */
async function run(
    preset: Preset,
    ctx: PresetCtx,
    mode?: TokensMode,
): Promise<number> {
    switch (preset) {
        case 'rulesets':
            return (await import('./presets/rulesets.ts')).rulesets(ctx)
        case 'settings':
            return (await import('./presets/settings.ts')).settings(ctx)
        case 'tokens':
            return (await import('./presets/tokens.ts')).tokens(ctx, mode)
    }
}

/** One preset: the header line on stderr, then the run; a throw is exit 1. */
async function runPreset(
    preset: Preset,
    ctx: PresetCtx,
    prog: string,
    mode?: TokensMode,
): Promise<number> {
    console.error(
        `voidflow ${version()} ${ctx.verb} ${preset} | config ${ctx.file} | repo ${ctx.repo} | credential ${credential(preset, ctx.cfg, ctx.env)}`,
    )
    try {
        return await run(preset, ctx, mode)
    } catch (e) {
        console.error(`${prog} ${preset}: ${(e as Error).message}`)
        return 1
    }
}

/** The `main` of one verb, for scripts/cli.ts. */
export function verbMain(verb: Verb | 'try') {
    return async (argv: string[], prog = `voidflow ${verb}`): Promise<void> => {
        let a: VerbArgs
        try {
            a = parseVerbArgs(verb, argv)
        } catch (e) {
            fail(`${prog}: ${(e as Error).message}\n\n${usage(verb)}`)
        }
        if (a.help) {
            console.log(usage(verb))
            process.exit(0)
        }
        const { file, cfg, repo } = await loadRepo(prog)
        const ctx = (preset: Preset, bare: boolean): PresetCtx => ({
            verb: verb === 'try' ? 'plan' : verb,
            file,
            cfg,
            repo,
            env: process.env,
            prune: a.prune,
            rotate: a.rotate,
            noColor: a.noColor,
            bare,
            applyHint: applyHint(preset, a),
        })

        if (verb === 'try') {
            process.exit(
                await runPreset('tokens', ctx('tokens', false), prog, {
                    kind: 'try',
                    env: a.env as string,
                    cmd: a.cmd,
                }),
            )
        }
        if (a.preset === 'tokens' && !cfg.cloudflare)
            fail(
                `${prog}: tokens: no cloudflare section in ${file} (see docs/config.md#cloudflare-tokens)`,
            )

        const { run, skipped } = presetsFor(a.preset, cfg, process.env)
        if (skipped) console.error(`${prog}: ${skipped}`)
        const codes: number[] = []
        for (const preset of run) {
            const mode: TokensMode | undefined = a.groups
                ? { kind: 'groups' }
                : undefined
            codes.push(
                await runPreset(
                    preset,
                    ctx(preset, a.preset === undefined),
                    prog,
                    mode,
                ),
            )
        }
        process.exit(worstExit(codes))
    }
}
