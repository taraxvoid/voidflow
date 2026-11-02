/**
 * Thin adapter over the `gh` CLI so the settings code can be faked in tests.
 */
import { capture } from '../lib/proc.ts'

export type GhResult = { status: number; body: any }

export interface Gh {
    rest(
        method: 'GET' | 'PUT' | 'PATCH',
        path: string,
        body?: unknown,
    ): Promise<GhResult>
    graphql(query: string, vars: Record<string, string>): Promise<any>
    /** null when gh is installed and authenticated, else the reason it is not. */
    available(): Promise<string | null>
}

/** argv for `gh api` REST calls; a body is piped on stdin. */
export function restArgv(
    method: string,
    path: string,
    hasBody: boolean,
): string[] {
    const cmd = ['gh', 'api', '--include', '--method', method, path]
    if (hasBody) cmd.push('--input', '-')
    return cmd
}

/** argv for a GraphQL call; `-f` keeps every variable a string (no coercion). */
export function graphqlArgv(
    query: string,
    vars: Record<string, string>,
): string[] {
    const cmd = ['gh', 'api', 'graphql', '-f', `query=${query}`]
    for (const [k, v] of Object.entries(vars)) cmd.push('-f', `${k}=${v}`)
    return cmd
}

/**
 * Parse `gh api --include` output: an HTTP status line, headers, a blank line,
 * then the body (which may be empty or not JSON).
 */
export function parseInclude(text: string): GhResult {
    const normalized = text.replace(/\r\n/g, '\n')
    const first = normalized.split('\n', 1)[0]
    const m = /^HTTP\/\S+\s+(\d{3})/.exec(first)
    const status = m ? Number(m[1]) : 0
    const split = normalized.indexOf('\n\n')
    const raw = split === -1 ? '' : normalized.slice(split + 2).trim()
    let body: any = null
    if (raw) {
        try {
            body = JSON.parse(raw)
        } catch {
            body = raw
        }
    }
    return { status, body }
}

export function ghCli(): Gh {
    return {
        async rest(method, path, body) {
            const cmd = restArgv(method, path, body !== undefined)
            const r = await capture(
                cmd,
                body === undefined ? undefined : JSON.stringify(body),
                { timeoutMs: 60_000 },
            )
            const parsed = parseInclude(r.out)
            if (parsed.status === 0) {
                throw new Error(
                    r.err.trim() || `gh api ${method} ${path} exited ${r.code}`,
                )
            }
            return parsed
        },
        async graphql(query, vars) {
            const cmd = graphqlArgv(query, vars)
            const r = await capture(cmd, undefined, { timeoutMs: 60_000 })
            let json: any = null
            try {
                json = JSON.parse(r.out)
            } catch {
                // fall through to the error below
            }
            if (r.code !== 0 || json?.errors) {
                const msg =
                    json?.errors?.map((e: any) => e.message).join('; ') ||
                    r.err.trim() ||
                    `gh api graphql exited ${r.code}`
                throw new Error(msg)
            }
            return json?.data
        },
        async available() {
            try {
                // Exits 0 when the active host has a token, unlike `auth status`,
                // which fails if any other configured account is invalid.
                const r = await capture(['gh', 'auth', 'token'], undefined, {
                    timeoutMs: 30_000,
                })
                if (r.code === 0) return null
                return 'gh is not authenticated (run gh auth login)'
            } catch {
                return 'gh CLI not found on PATH (install from https://cli.github.com)'
            }
        },
    }
}

/** null when `gh` is usable, else the reason it is not (delegates to the Gh). */
export function ghAvailable(gh: Gh): Promise<string | null> {
    return gh.available()
}

/** `owner/repo` from an override or the origin remote of `dir`. */
export async function resolveRepo(
    dir: string,
    override?: string,
): Promise<string> {
    if (override) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(override)) {
            throw new Error(`invalid repo "${override}", expected owner/repo`)
        }
        return override
    }
    let url = ''
    try {
        const r = await capture(
            ['git', '-C', dir, 'remote', 'get-url', 'origin'],
            undefined,
            { timeoutMs: 15_000 },
        )
        if (r.code !== 0) throw new Error(r.err.trim())
        url = r.out.trim()
    } catch (e) {
        throw new Error(
            `cannot resolve the repo: no origin remote in ${dir} (${(e as Error).message})`,
        )
    }
    const m =
        /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
            url,
        ) ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
    if (!m) {
        throw new Error(`origin remote "${url}" is not a github.com repository`)
    }
    return `${m[1]}/${m[2]}`
}
