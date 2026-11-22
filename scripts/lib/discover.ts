/**
 * Find a fleet tool's config file without --config: the infra repo's
 * per-tool module (rulesets.ts, cf-tokens.ts), looked for in a fixed order
 * so a run from anywhere names the same file. See docs/fleet.md.
 */
import { lstatSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type Tool = 'rulesets' | 'cf-tokens'

/** The module each tool reads, inside a config directory. */
export const TOOL_FILE: Record<Tool, string> = {
    rulesets: 'rulesets.ts',
    'cf-tokens': 'cf-tokens.ts',
}

/** Where a config file came from, for the header line. */
export type Found = { file: string; via: 'flag' | 'env' | 'xdg' | 'cwd' }

export type DiscoverOptions = {
    flag?: string
    env: Record<string, string | undefined>
    cwd: string
    home: string
}

/** `<XDG_CONFIG_HOME or home/.config>/voidflow`. */
export function xdgDir(o: Pick<DiscoverOptions, 'env' | 'home'>): string {
    return join(o.env.XDG_CONFIG_HOME || join(o.home, '.config'), 'voidflow')
}

/** What `path` is, following symlinks; a dangling link is `missing`. */
function kind(path: string): 'file' | 'dir' | 'missing' {
    try {
        return statSync(path).isDirectory() ? 'dir' : 'file'
    } catch {
        return 'missing'
    }
}

/** True when `path` is a symlink whose target does not exist. */
function isDangling(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink() && kind(path) === 'missing'
    } catch {
        return false
    }
}

/**
 * An explicit config value (--config or VOIDFLOW_CONFIG) as an absolute
 * path: `~/` expands to home, a relative one resolves against
 * VOIDFLOW_CONFIG_BASE else cwd.
 */
export function configPath(
    value: string,
    o: Pick<DiscoverOptions, 'env' | 'cwd' | 'home'>,
): string {
    const expanded = value.startsWith('~/')
        ? join(o.home, value.slice(2))
        : value
    return resolve(o.env.VOIDFLOW_CONFIG_BASE || o.cwd, expanded)
}

/**
 * An explicit value at configPath(). A directory means the tool's file in it
 * (null when absent); a missing path throws.
 */
function explicit(
    value: string,
    label: string,
    file: string,
    o: DiscoverOptions,
): string | null {
    const path = configPath(value, o)
    const k = kind(path)
    if (k === 'missing') throw new Error(`${label} ${path} does not exist`)
    if (k === 'file') return path
    const inside = join(path, file)
    return kind(inside) === 'file' ? inside : null
}

/**
 * The config file for `tool`, first hit wins: `o.flag`; VOIDFLOW_CONFIG; the
 * xdg voidflow dir; the nearest ancestor of `cwd` holding the tool's file.
 * An explicit source, or an xdg dir that exists, decides alone: without the
 * tool's file it is null, not a fall-through. Throws when an explicit path
 * does not exist, or when the xdg dir is a dangling symlink (so a broken link
 * does not silently fall through to cwd).
 */
export function discover(tool: Tool, o: DiscoverOptions): Found | null {
    const file = TOOL_FILE[tool]
    if (o.flag !== undefined) {
        const hit = explicit(o.flag, '--config', file, o)
        return hit ? { file: hit, via: 'flag' } : null
    }
    if (o.env.VOIDFLOW_CONFIG) {
        const hit = explicit(o.env.VOIDFLOW_CONFIG, 'VOIDFLOW_CONFIG', file, o)
        return hit ? { file: hit, via: 'env' } : null
    }
    const xdg = xdgDir(o)
    if (kind(xdg) === 'dir') {
        const hit = join(xdg, file)
        return kind(hit) === 'file' ? { file: hit, via: 'xdg' } : null
    }
    if (isDangling(xdg))
        throw new Error(
            `${xdg} is a symlink to a missing path; fix or remove it, or pass --config`,
        )
    for (let dir = resolve(o.cwd); ; dir = dirname(dir)) {
        const hit = join(dir, file)
        if (kind(hit) === 'file') return { file: hit, via: 'cwd' }
        if (dirname(dir) === dir) return null
    }
}
