/**
 * `voidflow settings --repo-config <file> [--check|--apply]`: the repo
 * settings a voidflow.config.ts asks for (its `settings` section, on top of
 * the baseline), planned, checked or applied with the settings table that
 * `voidflow init` uses (scripts/init/settings.ts). The verbs run it as
 * `voidflow plan|check|apply settings`; see docs/config.md.
 *
 * Exit: 0 in sync (or skipped with --if-admin), 1 drift under --check or a
 * failed write under --apply, 2 a config error, a failed read, or a
 * credential without admin.
 */
import { dirname } from 'node:path'
import type { VoidflowConfig } from '../config/index.ts'
import { enabledGroups } from '../config/settings.ts'
import { colorEnabled, type Paint, painter, statusStyle } from './init/color.ts'
import { credentialSource, type Gh, ghAvailable, ghCli } from './init/gh.ts'
import {
    manualReminders,
    runSettings,
    type SettingResult,
} from './init/settings.ts'
import { parseOrExit } from './lib/args.ts'
import { loadVoidflowConfig, repoSlug } from './lib/repo-config.ts'

const OPTIONS = {
    'repo-config': { type: 'string' },
    check: { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
    'if-admin': { type: 'boolean', default: false },
    'no-color': { type: 'boolean', default: false },
} as const

const usage = (prog: string) => `usage: ${prog} --repo-config <file> [flags]

  --repo-config <file>  a voidflow.config.ts: manage the repo it sits in
                        (set by the verbs)
  --check               exit 1 on drift
  --apply               change the settings that differ
  --no-color            no ANSI colors

Reads need gh authenticated as an admin of the repo. Usually run as
\`voidflow plan|check|apply settings\`; see docs/config.md.`

export type Mode = 'plan' | 'check' | 'apply'

/** Skips that are not drift: shown, never counted. */
const SKIPS = new Set(['skipped-plan', 'skipped-no-code'])

/**
 * One run's output lines and exit code. `ifAdmin` (a bare verb run) turns a
 * credential without admin into a skip instead of an error.
 */
export async function settingsCommand(
    gh: Gh,
    repo: string,
    cfg: VoidflowConfig,
    opts: {
        mode: Mode
        ifAdmin: boolean
        env: Record<string, string | undefined>
        paint?: Paint
    },
): Promise<{ lines: string[]; code: 0 | 1 | 2 }> {
    const paint = opts.paint ?? painter(false)
    const row = (r: SettingResult) => {
        const style = statusStyle(r.status)
        const label = r.status.padEnd(16)
        return `  ${style ? paint(style, label) : label}${r.detail ? `${r.name.padEnd(28)} ${r.detail}` : r.name}`
    }
    const credential = credentialSource(opts.env)
    const unavailable = await ghAvailable(gh)
    if (unavailable)
        return opts.ifAdmin
            ? { lines: [`settings skipped (${unavailable})`], code: 0 }
            : { lines: [`settings: ${unavailable}`], code: 2 }
    const enabled = enabledGroups(cfg.settings?.enable)
    const run = await runSettings(gh, repo, {
        enabled,
        skip: new Set(cfg.settings?.skip),
        dryRun: opts.mode !== 'apply',
    })
    if (run.notAdmin !== undefined)
        return opts.ifAdmin
            ? {
                  lines: [`settings skipped (${credential} lacks admin)`],
                  code: 0,
              }
            : {
                  lines: [
                      `settings need admin on ${repo} (${credential} has ${run.notAdmin})`,
                  ],
                  code: 2,
              }

    const lines = run.results.map(row)
    const failed = run.results.filter((r) => r.status === 'failed').length
    const drift = run.results.filter((r) => r.status === 'would-apply').length
    const skipped = run.results.filter((r) => SKIPS.has(r.status)).length
    if (skipped > 0)
        lines.push(
            `warning: ${skipped} setting(s) skipped (see above); not counted as drift`,
        )
    if (opts.mode === 'apply' && failed === 0) {
        lines.push('manual:')
        for (const l of manualReminders(repo, enabled)) lines.push(`  ${l}`)
    }
    const hint = opts.env.VOIDFLOW_VIA_VERB
        ? `run \`${opts.env.VOIDFLOW_APPLY_HINT ?? 'voidflow apply settings'}\``
        : 're-run with --apply'
    if (failed > 0)
        lines.push(
            `${failed} setting(s) failed${opts.mode === 'apply' ? '' : ' to read'}`,
        )
    else if (opts.mode === 'apply')
        lines.push(
            `${run.results.filter((r) => r.status === 'applied').length} setting(s) changed`,
        )
    else
        lines.push(
            drift === 0 ? 'in sync' : `${drift} setting(s) differ (${hint})`,
        )

    if (failed > 0) return { lines, code: opts.mode === 'apply' ? 1 : 2 }
    if (opts.mode === 'check' && drift > 0) return { lines, code: 1 }
    return { lines, code: 0 }
}

/** `prog` names the command in the --help usage. */
export async function main(
    argv: string[],
    prog = 'voidflow settings',
    deps: { gh?: Gh } = {},
) {
    const { values } = parseOrExit(argv, { options: OPTIONS }, usage(prog))
    const file = values['repo-config']
    if (file === undefined) {
        console.error(`${prog}: --repo-config is required\n\n${usage(prog)}`)
        process.exit(2)
    }
    if (values.check && values.apply) {
        console.error(`${prog}: --check and --apply are alternatives`)
        process.exit(2)
    }
    let cfg: VoidflowConfig
    let repo: string
    try {
        cfg = await loadVoidflowConfig(file)
        repo = await repoSlug(process.env, dirname(file))
    } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
    }
    const { lines, code } = await settingsCommand(
        deps.gh ?? ghCli(),
        repo,
        cfg,
        {
            mode: values.apply ? 'apply' : values.check ? 'check' : 'plan',
            ifAdmin: values['if-admin'],
            env: process.env,
            paint: painter(colorEnabled(values['no-color'])),
        },
    )
    console.log(lines.join('\n'))
    process.exit(code)
}
