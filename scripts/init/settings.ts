/**
 * GitHub repo settings for `voidflow init`: read current state, change only
 * what differs. The table is data so a drift check can reuse it.
 */
import type { Gh, GhResult } from './gh.ts'

export type SettingStatus =
    | 'unchanged'
    | 'applied'
    | 'would-apply'
    | 'skipped-plan'
    | 'skipped-no-code'
    | 'failed'

export type SettingResult = {
    name: string
    status: SettingStatus
    detail?: string
}

export type RepoInfo = {
    id: string
    visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL'
    pullRequestCreationPolicy?: string
    issueCreationPolicy?: string
}

type Setting = {
    name: string
    optIn?: 'pvr' | 'ai-scan'
    read(gh: Gh, repo: string, info: RepoInfo): Promise<boolean>
    write(gh: Gh, repo: string, info: RepoInfo): Promise<void>
}

/** An API failure carrying the HTTP status, so the classifier can see 403/422. */
class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

function object(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function isVisibility(value: unknown): value is RepoInfo['visibility'] {
    return value === 'PUBLIC' || value === 'PRIVATE' || value === 'INTERNAL'
}

function apiMessage(r: GhResult): string {
    const b = r.body
    const body = object(b)
    const message =
        typeof b === 'string'
            ? b
            : typeof body?.message === 'string'
              ? body.message
              : ''
    const errs = Array.isArray(body?.errors)
        ? ` ${body.errors
              .map((e) => {
                  if (typeof e === 'string') return e
                  const errorMessage = object(e)?.message
                  return typeof errorMessage === 'string'
                      ? errorMessage
                      : (JSON.stringify(e) ?? String(e))
              })
              .join('; ')}`
        : ''
    return `HTTP ${r.status}${message ? `: ${message}` : ''}${errs}`
}

function ok(r: GhResult): GhResult {
    if (r.status < 200 || r.status >= 300) {
        throw new ApiError(r.status, apiMessage(r))
    }
    return r
}

async function get(gh: Gh, path: string): Promise<GhResult> {
    return ok(await gh.rest('GET', path))
}

async function send(
    gh: Gh,
    method: 'PUT' | 'PATCH',
    path: string,
    body?: unknown,
): Promise<void> {
    ok(await gh.rest(method, path, body))
}

function split(repo: string): { owner: string; name: string } {
    const [owner, name] = repo.split('/')
    return { owner, name }
}

function policy(
    name: string,
    field: 'pullRequestCreationPolicy' | 'issueCreationPolicy',
): Setting {
    return {
        name,
        async read(_gh, _repo, info) {
            return info[field] === 'COLLABORATORS_ONLY'
        },
        async write(gh, _repo, info) {
            await gh.graphql(
                `mutation($id: ID!) { updateRepository(input: { repositoryId: $id, ${field}: COLLABORATORS_ONLY }) { clientMutationId } }`,
                { id: info.id },
            )
        },
    }
}

export const SETTINGS: Setting[] = [
    policy('pr-policy', 'pullRequestCreationPolicy'),
    policy('issue-policy', 'issueCreationPolicy'),
    {
        name: 'dependabot-alerts',
        async read(gh, repo) {
            const r = await gh.rest('GET', `repos/${repo}/vulnerability-alerts`)
            if (r.status === 404) return false
            ok(r)
            return true
        },
        write: (gh, repo) =>
            send(gh, 'PUT', `repos/${repo}/vulnerability-alerts`),
    },
    {
        name: 'dependabot-security-updates',
        async read(gh, repo) {
            const r = await get(gh, `repos/${repo}/automated-security-fixes`)
            return object(r.body)?.enabled === true
        },
        write: (gh, repo) =>
            send(gh, 'PUT', `repos/${repo}/automated-security-fixes`),
    },
    {
        name: 'secret-scanning',
        async read(gh, repo) {
            const sa = object(
                object((await get(gh, `repos/${repo}`)).body)
                    ?.security_and_analysis,
            )
            const secretScanning = object(sa?.secret_scanning)
            const pushProtection = object(sa?.secret_scanning_push_protection)
            return (
                secretScanning?.status === 'enabled' &&
                pushProtection?.status === 'enabled'
            )
        },
        write: (gh, repo) =>
            send(gh, 'PATCH', `repos/${repo}`, {
                security_and_analysis: {
                    secret_scanning: { status: 'enabled' },
                    secret_scanning_push_protection: { status: 'enabled' },
                },
            }),
    },
    {
        name: 'codeql',
        async read(gh, repo) {
            const r = await get(gh, `repos/${repo}/code-scanning/default-setup`)
            return object(r.body)?.state === 'configured'
        },
        write: (gh, repo) =>
            send(gh, 'PATCH', `repos/${repo}/code-scanning/default-setup`, {
                state: 'configured',
            }),
    },
    {
        name: 'pvr',
        optIn: 'pvr',
        async read(gh, repo) {
            const r = await get(
                gh,
                `repos/${repo}/private-vulnerability-reporting`,
            )
            return object(r.body)?.enabled === true
        },
        write: (gh, repo) =>
            send(gh, 'PUT', `repos/${repo}/private-vulnerability-reporting`),
    },
    {
        name: 'ai-scan',
        optIn: 'ai-scan',
        async read(gh, repo) {
            const r = await get(gh, `repos/${repo}/code-scanning/ai-scan`)
            return object(r.body)?.pr_scan === 'enabled'
        },
        write: (gh, repo) =>
            send(gh, 'PATCH', `repos/${repo}/code-scanning/ai-scan`, {
                pr_scan: 'enabled',
            }),
    },
]

export function settingNames(): string[] {
    return SETTINGS.map((s) => s.name)
}

const PLAN_GATED = new Set(['codeql', 'secret-scanning'])

function classifyError(
    name: string,
    e: unknown,
    info: RepoInfo,
): SettingResult {
    const msg = e instanceof Error ? e.message : String(e)
    const status = e instanceof ApiError ? e.status : 0
    if (
        name === 'codeql' &&
        status >= 400 &&
        status < 500 &&
        /language/i.test(msg)
    ) {
        return {
            name,
            status: 'skipped-no-code',
            detail: 're-run voidflow init --preset settings after your first push',
        }
    }
    if (
        PLAN_GATED.has(name) &&
        info.visibility !== 'PUBLIC' &&
        (status === 403 || status === 422)
    ) {
        return { name, status: 'skipped-plan', detail: msg }
    }
    return { name, status: 'failed', detail: msg }
}

export async function runSettings(
    gh: Gh,
    repo: string,
    sel: {
        skip: Set<string>
        enablePvr: boolean
        enableAiScan: boolean
        dryRun: boolean
    },
): Promise<SettingResult[]> {
    const chosen = SETTINGS.filter((s) => {
        if (sel.skip.has(s.name)) return false
        if (s.optIn === 'pvr') return sel.enablePvr
        if (s.optIn === 'ai-scan') return sel.enableAiScan
        return true
    })
    let info: RepoInfo
    try {
        const { owner, name } = split(repo)
        const data = await gh.graphql(
            'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id visibility pullRequestCreationPolicy issueCreationPolicy } }',
            { owner, name },
        )
        const repository = object(object(data)?.repository)
        if (
            typeof repository?.id !== 'string' ||
            !isVisibility(repository.visibility)
        ) {
            throw new Error('gh api graphql returned an invalid repository')
        }
        info = {
            id: repository.id,
            visibility: repository.visibility,
            pullRequestCreationPolicy:
                typeof repository.pullRequestCreationPolicy === 'string'
                    ? repository.pullRequestCreationPolicy
                    : undefined,
            issueCreationPolicy:
                typeof repository.issueCreationPolicy === 'string'
                    ? repository.issueCreationPolicy
                    : undefined,
        }
    } catch (e) {
        const detail = `cannot read ${repo}: ${e instanceof Error ? e.message : String(e)}`
        return chosen.map((s) => ({ name: s.name, status: 'failed', detail }))
    }
    const results: SettingResult[] = []
    for (const s of chosen) {
        try {
            if (await s.read(gh, repo, info)) {
                results.push({ name: s.name, status: 'unchanged' })
            } else if (sel.dryRun) {
                results.push({ name: s.name, status: 'would-apply' })
            } else {
                await s.write(gh, repo, info)
                results.push({ name: s.name, status: 'applied' })
            }
        } catch (e) {
            results.push(classifyError(s.name, e, info))
        }
    }
    return results
}

export function manualReminders(repo: string, enableAiScan: boolean): string[] {
    const url = `https://github.com/${repo}/settings/security_analysis`
    const lines = [`Turn on Dependabot malware alerts (no API): ${url}`]
    if (enableAiScan) {
        lines.push(
            `Turn on AI Scan for repositories (preview, no API): ${url}`,
            `Turn on code scanning for AI applications (preview, no API): ${url}`,
        )
    }
    return lines
}
