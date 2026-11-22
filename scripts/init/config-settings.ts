/**
 * `voidflow init` and a repo's voidflow.config.ts `settings`: what the file
 * asks for plus what this run's flags add, so the settings half runs both
 * and the file can record them for `voidflow check`.
 */
import {
    enabledGroups,
    GROUPS,
    SETTING_GROUPS,
    type SettingsConfig,
    type SettingsGroup,
} from '../../config/settings.ts'

export type MergedSettings = {
    /** The section to write; undefined when there is nothing to record. */
    settings?: SettingsConfig
    /** What the flags added to the file, e.g. `settings.enable + agentic`; empty when nothing. */
    added: string[]
}

/**
 * The file's settings plus the flags': `flags` are the groups the run's
 * `--enable-*` flags name, `skip` its `--skip` names (file names are ignored).
 * Lists come out in GROUPS and table order; a skip whose group is not
 * enabled is dropped, since the file would not validate with it.
 */
export function mergeSettings(
    file: SettingsConfig | undefined,
    flags: readonly SettingsGroup[],
    skip: readonly string[],
): MergedSettings {
    const fileEnable = new Set(file?.enable ?? [])
    const flagEnable = new Set(flags)
    // Recording actions-lock beside actions-relock says nothing new.
    if (flagEnable.has('actions-relock')) flagEnable.delete('actions-lock')
    const enable = GROUPS.filter((g) => fileEnable.has(g) || flagEnable.has(g))
    const on = enabledGroups(enable)
    const fileSkip = new Set(file?.skip ?? [])
    const flagSkip = new Set(
        skip.filter((n) => Object.hasOwn(SETTING_GROUPS, n)),
    )
    const skips = Object.keys(SETTING_GROUPS).filter((n) => {
        if (!fileSkip.has(n) && !flagSkip.has(n)) return false
        const g = SETTING_GROUPS[n]
        return g === 'baseline' || on.has(g)
    })
    const added = [
        ...enable
            .filter((g) => !fileEnable.has(g))
            .map((g) => `settings.enable + ${g}`),
        ...skips
            .filter((n) => !fileSkip.has(n))
            .map((n) => `settings.skip + ${n}`),
    ]
    if (enable.length === 0 && skips.length === 0) return { added }
    return {
        settings: {
            ...(enable.length > 0 ? { enable } : {}),
            ...(skips.length > 0 ? { skip: skips } : {}),
        },
        added,
    }
}

/** The config with `settings` replaced, key order kept, `settings` last when new. */
export function withSettings(
    cfg: Record<string, unknown>,
    settings: SettingsConfig | undefined,
): Record<string, unknown> {
    const { settings: _old, ...rest } = cfg
    if (settings === undefined) return rest
    if (!('settings' in cfg)) return { ...rest, settings }
    return Object.fromEntries(
        Object.entries(cfg).map(([k, v]) => [
            k,
            k === 'settings' ? settings : v,
        ]),
    )
}
