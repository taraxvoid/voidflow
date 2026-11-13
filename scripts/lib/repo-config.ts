/**
 * Finding and loading a repo's `voidflow.config.ts`, and working out which
 * GitHub repo it belongs to. See docs/config.md.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checkVoidflowConfig, type VoidflowConfig } from '../../config/index.ts'
import { capture } from './proc.ts'

export const CONFIG_FILE = 'voidflow.config.ts'

const isFile = (path: string) => {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}

/**
 * The repo's config file, searching up from `cwd` to the nearest git root
 * (a directory holding `.git`, or a file for a worktree or submodule). Null
 * outside a git repo or when the repo has none.
 */
export function findRepoConfig(cwd: string): string | null {
    const start = resolve(cwd)
    let root: string | null = null
    for (let dir = start; ; dir = dirname(dir)) {
        if (existsSync(join(dir, '.git'))) {
            root = dir
            break
        }
        if (dirname(dir) === dir) return null
    }
    for (let dir = start; ; dir = dirname(dir)) {
        const hit = join(dir, CONFIG_FILE)
        if (isFile(hit)) return hit
        if (dir === root) return null
    }
}

const REMOTE =
    /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

/** `owner/name` from a GitHub remote URL, or null for any other form. */
export function parseRemote(url: string): string | null {
    const m = REMOTE.exec(url.trim())
    return m ? `${m[1]}/${m[2]}` : null
}

const SLUG = /^[^/\s]+\/[^/\s]+$/

/**
 * The GitHub repo for the checkout at `cwd`: its origin remote, or
 * GITHUB_REPOSITORY (set in Actions) when the checkout has no GitHub origin.
 * When both exist they must agree (ignoring case): a stale variable, or a job
 * that checked out a second repo, must not point writes at another repo.
 */
export async function repoSlug(
    env: Record<string, string | undefined>,
    cwd: string,
): Promise<string> {
    const fromEnv =
        env.GITHUB_REPOSITORY && SLUG.test(env.GITHUB_REPOSITORY)
            ? env.GITHUB_REPOSITORY
            : null
    let remote: string | null = null
    try {
        const r = await capture(
            ['git', 'remote', 'get-url', 'origin'],
            undefined,
            { cwd, timeoutMs: 15_000 },
        )
        if (r.code === 0) remote = parseRemote(r.out)
    } catch {
        // git missing: reported below with the other way out
    }
    if (fromEnv && remote && fromEnv.toLowerCase() !== remote.toLowerCase())
        throw new Error(
            `GITHUB_REPOSITORY is ${fromEnv} but this checkout's origin is ${remote}; run from the repo whose voidflow.config.ts this is, or fix the variable`,
        )
    if (fromEnv) return fromEnv
    if (remote) return remote
    throw new Error(
        'cannot tell which GitHub repo this is: no github.com origin remote; set GITHUB_REPOSITORY=owner/name',
    )
}

/** The validated default export of the config at `file`; errors name the file. */
export async function loadVoidflowConfig(
    file: string,
): Promise<VoidflowConfig> {
    const fail = (why: string): never => {
        throw new Error(`${file}: ${why}`)
    }
    let mod: { default?: unknown }
    try {
        mod = (await import(file)) as { default?: unknown }
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
    }
    if (mod.default === undefined) return fail('no default export')
    try {
        return checkVoidflowConfig(mod.default)
    } catch (e) {
        return fail((e as Error).message)
    }
}
