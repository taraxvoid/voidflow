/**
 * `voidflow plan|check|apply settings`: the repo settings a voidflow.config.ts
 * asks for (its `settings` section, on top of the baseline), planned, checked
 * or applied with the settings table that `voidflow init` uses
 * (scripts/init/settings.ts). See docs/config.md.
 *
 * Exit: 0 in sync (or skipped on a bare run), 1 drift under check or a
 * failed write under apply, 2 a failed read or a credential without admin.
 */
import type { VoidflowConfig } from '../../config/index.ts'
import { enabledGroups } from '../../config/settings.ts'
import {
    colorEnabled,
    type Paint,
    painter,
    statusStyle,
} from '../init/color.ts'
import { credentialSource, type Gh, ghAvailable, ghCli } from '../init/gh.ts'
import {
    manualReminders,
    runSettings,
    type SettingResult,
} from '../init/settings.ts'
import type { PresetCtx, Verb } from './context.ts'

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
        mode: Verb
        ifAdmin: boolean
        env: Record<string, string | undefined>
        /** How to apply a plan. Default: run `voidflow apply settings`. */
        applyHint?: string
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
    const hint = opts.applyHint ?? 'run `voidflow apply settings`'
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

/** Plan, check or apply the repo's settings; returns the exit code. */
export async function settings(
    ctx: PresetCtx,
    deps: { gh?: Gh } = {},
): Promise<number> {
    const { lines, code } = await settingsCommand(
        deps.gh ?? ghCli(),
        ctx.repo,
        ctx.cfg,
        {
            mode: ctx.verb,
            ifAdmin: ctx.bare,
            env: ctx.env,
            applyHint: ctx.applyHint,
            paint: painter(colorEnabled(ctx.noColor)),
        },
    )
    console.log(lines.join('\n'))
    return code
}
