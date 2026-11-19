/**
 * `voidflow init --enable-actions-lock` / `--enable-actions-relock`: scope the
 * lockfile workflows, run `gh actions-lock` once, check the relock App's
 * credentials. node: APIs only, so the CLI runs under Node as well as Bun.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { capture } from '../lib/proc.ts'
import type { Gh } from './gh.ts'

const WORKFLOWS = '.github/workflows'
/** gh-aw compiles each agentic `x.md` to `x.lock.yml`. */
const GH_AW_LOCK = /\.lock\.ya?ml$/
/** Names that are safe unquoted in YAML and shell. */
const PLAIN = /^[\w.-]+\.ya?ml$/

export const RELOCK_LABEL = {
    name: 'relock-actions',
    color: '5319e7',
    description: 'relock-actions relocks and pushes actions.lock on this PR',
}

export const APP_VARIABLE = 'RELEASE_BOT_CLIENT_ID'
/** The name of the Actions secret holding the App's private key (not the key). */
export const APP_KEY_NAME = 'RELEASE_BOT_APP_PRIVATE_KEY'

/**
 * The workflows `gh actions-lock` should be limited to, or null for a plain
 * full-directory run (which also prunes entries for deleted workflows).
 *
 * Scoped only when the repo has gh-aw workflows (a `*.lock.yml`, or
 * `--enable-agentic`, which adds one): gh actions-lock rewrites full-SHA pins
 * to tags, and gh-aw's compiled locks pin by SHA and must stay exactly as
 * gh-aw wrote them, or agentic-locks fails on the recompile. `planned` are
 * workflow targets this run writes. Names that are not plain (spaces, quotes)
 * are left out and returned in `skipped`.
 */
export function lockScope(
    dir: string,
    planned: string[],
    agentic: boolean,
): { paths: string[] | null; skipped: string[] } {
    const wfDir = join(dir, WORKFLOWS)
    const onDisk = existsSync(wfDir)
        ? readdirSync(wfDir, { withFileTypes: true })
              .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
              .map((e) => e.name)
        : []
    const names = new Set([
        ...onDisk,
        ...planned
            .filter((t) => t.startsWith(`${WORKFLOWS}/`))
            .map((t) => t.slice(WORKFLOWS.length + 1)),
    ])
    const ghAw = agentic || [...names].some((n) => GH_AW_LOCK.test(n))
    if (!ghAw) return { paths: null, skipped: [] }
    const keep = [...names].filter((n) => !GH_AW_LOCK.test(n)).sort()
    return {
        paths: keep
            .filter((n) => PLAIN.test(n))
            .map((n) => `${WORKFLOWS}/${n}`),
        skipped: keep.filter((n) => !PLAIN.test(n)),
    }
}

function replaceLine(text: string, from: string, to: string): string {
    const lines = text.split('\n')
    const i = lines.findIndex((l) => l.trim() === from)
    if (i === -1 || lines.slice(i + 1).some((l) => l.trim() === from))
        throw new Error(`actions-lock template: expected one "${from}" line`)
    const indent = lines[i]?.match(/^\s*/)?.[0] ?? ''
    lines[i] = to
        .split('\n')
        .map((l) => indent + l)
        .join('\n')
    return lines.join('\n')
}

/** One shell word per line, joined with `\` continuations. */
function command(head: string, args: string[]): string {
    return [head, ...args.map((a) => `  ${a}`)].join(' \\\n')
}

const indent = (text: string, by: string) =>
    text
        .split('\n')
        .map((l) => by + l)
        .join('\n')

const SCOPE_NOTE = [
    '# Limited to these workflows so gh-aw compiled *.lock.yml files are never',
    '# rewritten (a full-directory run would). Add new workflows here.',
].join('\n')

/**
 * A rendered verify-lockfile or relock-actions template limited to `paths`.
 * null `paths` leaves the template as it is.
 */
export function scopeLockWorkflow(
    item: 'actions-lock' | 'actions-relock',
    text: string,
    paths: string[] | null,
): string {
    if (paths === null) return text
    if (item === 'actions-lock') {
        return replaceLine(
            text,
            '- run: gh actions-lock --verify',
            `${SCOPE_NOTE}\n- run: |\n${indent(command('gh actions-lock --verify', paths), '    ')}`,
        )
    }
    let out = replaceLine(
        text,
        '- name: Relock',
        `${SCOPE_NOTE}\n- name: Relock`,
    )
    out = replaceLine(
        out,
        'run: gh actions-lock',
        `run: |\n${indent(command('gh actions-lock', paths), '  ')}`,
    )
    return replaceLine(
        out,
        'git add .github/workflows',
        command('git add', [`${WORKFLOWS}/actions.lock`, ...paths]),
    )
}

export type LockRow = { name: string; status: string; detail: string }

export type GhActionsLock = (
    args: string[],
    dir: string,
) => Promise<{ code: number; out: string; err: string }>

export async function defaultGhActionsLock(
    args: string[],
    dir: string,
): Promise<{ code: number; out: string; err: string }> {
    try {
        return await capture(['gh', 'actions-lock', ...args], undefined, {
            timeoutMs: 300_000,
            cwd: dir,
        })
    } catch (e) {
        return { code: 127, out: '', err: (e as Error).message }
    }
}

const INSTALL = 'gh extension install github/gh-actions-lock'

/** True when gh reports `actions-lock` as an unknown command (extension not installed). */
function missingExtension(err: string, code: number): boolean {
    const e = err.toLowerCase()
    return (
        code === 127 ||
        (e.includes('unknown command') && e.includes('actions-lock'))
    )
}

/**
 * Run `gh actions-lock` once so the workflows just written are locked. A
 * missing extension degrades to a manual step, not a failure.
 */
export async function runActionsLock(
    dir: string,
    paths: string[] | null,
    dryRun: boolean,
    run: GhActionsLock,
): Promise<LockRow> {
    const name = 'actions-lock'
    const cmd = ['gh actions-lock', ...(paths ?? [])].join(' ')
    if (dryRun) return { name, status: 'would-apply', detail: cmd }
    const r = await run(paths ?? [], dir)
    if (r.code === 0)
        return {
            name,
            status: 'applied',
            detail: `${cmd}; commit ${WORKFLOWS}`,
        }
    const first =
        (r.err.trim() || r.out.trim()).split('\n')[0] || `exit ${r.code}`
    if (missingExtension(r.err, r.code))
        return {
            name,
            status: 'manual',
            detail: `gh-actions-lock is not installed; run: ${INSTALL} && ${cmd}`,
        }
    return {
        name,
        status: 'failed',
        detail: `${first}; fix it, then run: ${cmd}`,
    }
}

/** true or false when GitHub said, null when it could not be checked. */
async function hasName(
    gh: Gh,
    repoPath: string,
    listPath: string,
    key: 'variables' | 'secrets',
    name: string,
): Promise<boolean | null> {
    try {
        const one = await gh.rest('GET', repoPath)
        if (one.status === 200) return true
        if (one.status !== 404) return null
        // Not on the repo: an organization variable or secret shared with it counts.
        const list = await gh.rest('GET', listPath)
        if (list.status === 404) return false
        if (list.status !== 200) return null
        const body = list.body as Record<string, unknown> | null
        const items = Array.isArray(body?.[key]) ? (body[key] as unknown[]) : []
        return items.some(
            (i) =>
                typeof i === 'object' &&
                i !== null &&
                (i as { name?: unknown }).name === name,
        )
    } catch {
        return null
    }
}

/**
 * Whether the relock App's client-ID variable and private-key secret are set
 * on the repo (or shared with it by its organization).
 */
export async function relockCredentials(
    gh: Gh,
    repo: string,
): Promise<{ variable: boolean | null; secret: boolean | null }> {
    const [variable, secret] = await Promise.all([
        hasName(
            gh,
            `repos/${repo}/actions/variables/${APP_VARIABLE}`,
            `repos/${repo}/actions/organization-variables?per_page=100`,
            'variables',
            APP_VARIABLE,
        ),
        hasName(
            gh,
            `repos/${repo}/actions/secrets/${APP_KEY_NAME}`,
            `repos/${repo}/actions/organization-secrets?per_page=100`,
            'secrets',
            APP_KEY_NAME,
        ),
    ])
    return { variable, secret }
}

/** Setup steps for whatever of the App's credentials is missing or unknown. */
export function credentialNotes(
    repo: string,
    c: { variable: boolean | null; secret: boolean | null },
): string[] {
    const missing: string[] = []
    if (c.variable !== true) missing.push(`the ${APP_VARIABLE} variable`)
    if (c.secret !== true) missing.push(`the ${APP_KEY_NAME} secret`)
    if (missing.length === 0) return []
    const unknown = c.variable === null || c.secret === null
    return [
        `relock-actions needs a GitHub App with Contents and Workflows read and write on ${repo}, ${unknown ? 'and could not confirm' : 'but is missing'} ${missing.join(' and ')}; until both are set the relock job fails at its token step. Install the App on the repo, then set them at https://github.com/${repo}/settings/variables/actions and https://github.com/${repo}/settings/secrets/actions`,
    ]
}
