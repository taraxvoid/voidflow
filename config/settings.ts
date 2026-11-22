/**
 * The repo settings a `voidflow.config.ts` can turn on, as plain data: the
 * opt-in groups (named after `voidflow init`'s `--enable-*` flags) and which
 * group each setting belongs to. scripts/init/settings.ts holds how each
 * setting is read and written; a test keeps the two lists in step.
 */

export const GROUPS = [
    'pvr',
    'ai-scan',
    'agentic',
    'actions-lock',
    'actions-relock',
] as const
export type SettingsGroup = (typeof GROUPS)[number]

/** Every setting, in apply order, and its group. */
export const SETTING_GROUPS: Readonly<
    Record<string, 'baseline' | SettingsGroup>
> = {
    'pr-policy': 'baseline',
    'issue-policy': 'baseline',
    'dependabot-alerts': 'baseline',
    'dependabot-security-updates': 'baseline',
    'secret-scanning': 'baseline',
    codeql: 'baseline',
    pvr: 'pvr',
    'ai-scan': 'ai-scan',
    'auto-merge': 'agentic',
    'update-branch': 'agentic',
    'delete-branch-on-merge': 'agentic',
    'actions-permissions': 'agentic',
    'fork-pr-approval': 'agentic',
    'label-low-risk': 'agentic',
    'label-needs-you': 'agentic',
    'label-relock-actions': 'actions-relock',
}

/** The `settings` section: opt-in groups to check, and settings to leave alone. */
export type SettingsConfig = {
    /** Opt-in groups, by their `voidflow init --enable-*` names. */
    enable?: SettingsGroup[]
    /** Setting names to leave out (see docs/config.md for the list). */
    skip?: string[]
}

/** Groups `actions-relock` brings along: relock without verify is half a feature. */
const IMPLIES: Partial<Record<SettingsGroup, SettingsGroup[]>> = {
    'actions-relock': ['actions-lock'],
}

/** The enabled groups, implied ones included. */
export function enabledGroups(
    enable: readonly SettingsGroup[] = [],
): Set<SettingsGroup> {
    const out = new Set<SettingsGroup>()
    for (const g of enable) {
        out.add(g)
        for (const i of IMPLIES[g] ?? []) out.add(i)
    }
    return out
}

const isGroup = (v: unknown): v is SettingsGroup =>
    GROUPS.includes(v as SettingsGroup)

/** Problems with a `settings` value, one per line, under `settings.` paths. */
export function settingsProblems(x: unknown): string[] {
    if (typeof x !== 'object' || x === null || Array.isArray(x))
        return ['settings: not an object']
    const s = x as Record<string, unknown>
    const errs: string[] = []
    for (const k of Object.keys(s))
        if (k !== 'enable' && k !== 'skip')
            errs.push(`settings.${k}: unknown field`)
    const list = (k: 'enable' | 'skip'): unknown[] | null => {
        const v = s[k]
        if (v === undefined) return []
        if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
            errs.push(`settings.${k}: not a list of strings`)
            return null
        }
        return v
    }
    const enable = list('enable')
    const skip = list('skip')
    const seen = new Set<unknown>()
    for (const g of enable ?? []) {
        if (!isGroup(g))
            errs.push(
                `settings.enable: unknown group ${JSON.stringify(g)} (${GROUPS.join(', ')})`,
            )
        else if (seen.has(g)) errs.push(`settings.enable: ${g} is listed twice`)
        seen.add(g)
    }
    const on = enabledGroups((enable ?? []).filter(isGroup))
    const skipped = new Set<unknown>()
    for (const name of skip ?? []) {
        const group = SETTING_GROUPS[name as string]
        if (!Object.hasOwn(SETTING_GROUPS, name as string))
            errs.push(`settings.skip: unknown setting ${JSON.stringify(name)}`)
        else if (skipped.has(name))
            errs.push(`settings.skip: ${name} is listed twice`)
        else if (group !== 'baseline' && enable !== null && !on.has(group))
            errs.push(
                `settings.skip: ${name} is in ${group}, which settings.enable does not list`,
            )
        skipped.add(name)
    }
    return errs
}

/** The markdown table of settings by group, as docs/config.md carries it. */
export function renderSettingsTable(): string {
    const rows = (['baseline', ...GROUPS] as const).map((g) => {
        const names = Object.keys(SETTING_GROUPS).filter(
            (n) => SETTING_GROUPS[n] === g,
        )
        return `| ${g} | ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'none (files only)'} |`
    })
    return ['| group | settings |', '|-------|----------|', ...rows].join('\n')
}
