/**
 * Fleet config for the repo tools (cf-tokens, apply-rulesets): the built-in
 * one, or another repo's module given with --config. That lets an org keep
 * its fleet map in its own (private) repo and run these scripts against it.
 */
import { resolve } from 'node:path'

/**
 * `builtin` when there is no `path`; otherwise the `REPOS` (or default)
 * export of the module at `path`, resolved against `base` and run through
 * `check`, which throws listing every problem.
 */
export async function loadConfig<T>(
    path: string | undefined,
    base: string,
    builtin: T,
    check: (x: unknown) => T,
): Promise<T> {
    if (!path) return builtin
    const file = resolve(base, path)
    const mod = (await import(file)) as { REPOS?: unknown; default?: unknown }
    const cfg = mod.REPOS ?? mod.default
    if (cfg === undefined) throw new Error(`${file}: no REPOS or default export`)
    try {
        return check(cfg)
    } catch (e) {
        throw new Error(`${file}: ${(e as Error).message}`)
    }
}

/**
 * Load the config named by --config, exiting 2 with the problems on failure.
 * Relative paths resolve against VOIDFLOW_CONFIG_BASE (the just recipes set
 * it to the directory `just` was run from), else the current directory.
 */
export function loadOrExit<T>(
    path: string | undefined,
    builtin: T,
    check: (x: unknown) => T,
): Promise<T> {
    const base = process.env.VOIDFLOW_CONFIG_BASE || process.cwd()
    return loadConfig(path, base, builtin, check).catch((e: Error) => {
        console.error(e.message)
        process.exit(2)
    })
}
