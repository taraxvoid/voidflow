/**
 * Fleet config for the repo tools (cf-tokens, apply-rulesets): a module in
 * the org's own (private) infra repo, given with --config, which holds the
 * repo, account and zone mapping so voidflow holds only code. Both tools
 * require it.
 */
import { resolve } from 'node:path'

/**
 * The `REPOS` (or default) export of the module at `path`, resolved against
 * `base` and run through `check`, which throws listing every problem.
 * Without a `path`, an error asking for one.
 */
export async function loadConfig<T>(
    path: string | undefined,
    base: string,
    check: (x: unknown) => T,
): Promise<T> {
    if (!path) {
        throw new Error(
            'needs --config <module>: the fleet map in your infra repo (see CONTRIBUTING.md)',
        )
    }
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
    check: (x: unknown) => T,
): Promise<T> {
    const base = process.env.VOIDFLOW_CONFIG_BASE || process.cwd()
    return loadConfig(path, base, check).catch((e: Error) => {
        console.error(e.message)
        process.exit(2)
    })
}
