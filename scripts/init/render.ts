/**
 * Template rendering and the "Written by voidflow" marker for `voidflow init`.
 * node: APIs only, so the CLI runs under Node as well as Bun.
 */
import { basename, extname } from 'node:path'
import { capture } from '../lib/proc.ts'
import { json } from '../lib/template-format.ts'

export type Kind = 'tool' | 'site'

export type RenderCtx = {
    version: string
    sha: string | null
    kind: Kind
    repo: string | null
    cronMinute: number
    /** Agentic rollout stage; shadow when unset. */
    stage?: 'shadow' | 'gate'
}

/** Fill the init-time placeholders. A null sha pins the tag instead. */
export function render(template: string, ctx: RenderCtx): string {
    const pinned =
        ctx.sha === null
            ? template.replaceAll('@{{sha}} # v{{version}}', '@v{{version}}')
            : template
    return pinned
        .replaceAll('{{version}}', ctx.version)
        .replaceAll('{{sha}}', ctx.sha ?? '')
        .replaceAll('{{kind}}', ctx.kind)
        .replaceAll('{{cron_minute}}', String(ctx.cronMinute))
        .replaceAll('{{repo}}', ctx.repo ?? 'OWNER/REPO')
}

function markerLines(ctx: RenderCtx): [string, string] {
    return [
        `Written by voidflow v${ctx.version}: https://www.npmjs.com/package/@taraxvoid/voidflow`,
        `Set up a repo the same way: npx @taraxvoid/voidflow init --kind ${ctx.kind}`,
    ]
}

const HASH = new Set(['.yml', '.yaml', '.toml'])
const SLASH = new Set(['.ts', '.js'])

/** Add the marker to `content` for the file at `target`, by file type. */
export function withMarker(
    target: string,
    content: string,
    ctx: RenderCtx,
): string {
    const name = basename(target)
    const ext = extname(name)
    const lines = markerLines(ctx)
    const prefixed = (p: string) =>
        `${lines.map((l) => p + l).join('\n')}\n${content}`
    if (name === 'renovate.json') {
        const parsed = JSON.parse(content)
        return json({ ...parsed, description: lines })
    }
    if (name === 'biome.json' || name === 'tsconfig.json')
        return prefixed('// ')
    if (ext === '.json') return content
    if (HASH.has(ext) || name === '.gitignore' || name === 'gitignore')
        return prefixed('# ')
    if (SLASH.has(ext)) return prefixed('// ')
    if (ext === '.md') return `<!--\n${lines.join('\n')}\n-->\n\n${content}`
    return content
}

const MARKER_VERSION = /Written by voidflow v\S+: /g

/** True when `a` and `b` differ at most in the version inside the marker line. */
export function sameIgnoringMarkerVersion(a: string, b: string): boolean {
    const norm = (s: string) =>
        s.replace(MARKER_VERSION, 'Written by voidflow v0: ')
    return norm(a) === norm(b)
}

/**
 * The commit SHA that tag v<version> points at in the voidflow repo, or null
 * on any failure (offline, unknown tag, git missing).
 */
export async function resolveSha(
    version: string,
    opts: { run?: typeof capture; timeoutMs?: number } = {},
): Promise<string | null> {
    const run = opts.run ?? capture
    const timeoutMs = opts.timeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const ref = `refs/tags/v${version}`
        const ls = run(
            [
                'git',
                'ls-remote',
                'https://github.com/taraxvoid/voidflow',
                ref,
                `${ref}^{}`,
            ],
            undefined,
            { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } },
        )
        // Backstop for runners that ignore timeoutMs; capture itself kills the child.
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs)
        })
        const res = await Promise.race([ls, timeout])
        if (res === null) {
            ls.catch(() => {})
            return null
        }
        const { code, out } = res
        if (code !== 0) return null
        const rows = out
            .split('\n')
            .map((l) => l.split(/\s+/))
            .filter(
                ([sha, name]) =>
                    /^[0-9a-f]{40}$/.test(sha ?? '') &&
                    (name === ref || name === `${ref}^{}`),
            )
        const peeled = rows.find(([, name]) => name === `${ref}^{}`)
        return (peeled ?? rows[0])?.[0] ?? null
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}
