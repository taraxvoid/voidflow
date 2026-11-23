/**
 * What every preset (`rulesets`, `settings`, `tokens`) gets from the verbs in
 * scripts/verbs.ts: the repo's validated voidflow.config.ts, which repo it
 * belongs to, and how to run. A preset prints its own plan and returns its
 * exit code: 0 in sync or applied, 1 drift under check or a failed write, 2
 * a config, usage or auth error, or a read that failed (so it never reads as
 * drift).
 */
import type { VoidflowConfig } from '../../config/index.ts'

export type Verb = 'plan' | 'check' | 'apply'

export const PRESETS = ['rulesets', 'settings', 'tokens'] as const
export type Preset = (typeof PRESETS)[number]

export type PresetCtx = {
    verb: Verb
    /** Absolute path of the voidflow.config.ts. */
    file: string
    cfg: VoidflowConfig
    /** owner/name of the GitHub repo the file belongs to. */
    repo: string
    env: Record<string, string | undefined>
    /** With apply: also delete what the config lists under `retire`. */
    prune: boolean
    /** tokens: rotate every token now. */
    rotate: boolean
    noColor: boolean
    /** tokens: envs whose wrangler config is read from the checkout, not the default branch. */
    localWrangler: string[]
    /** No preset was named, so one that cannot run here skips instead of failing. */
    bare: boolean
    /** How to apply what a plan shows, for its summary line: `run `voidflow apply ...``. */
    applyHint: string
}
