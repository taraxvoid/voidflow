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

function apiMessage(r: GhResult): string {
    const b = r.body
    const m = typeof b === 'string' ? b : b?.message
    const errs = Array.isArray(b?.errors)
        ? ` ${b.errors.map((e: any) => (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)))).join('; ')}`
        : ''
    return `HTTP ${r.status}${m ? `: ${m}` : ''}${errs}`
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
        async read(gh, repo) {
            const data = await gh.graphql(
                `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${field} } }`,
                split(repo),
            )
            return data?.repository?.[field] === 'COLLABORATORS_ONLY'
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
            return r.body?.enabled === true
        },
        write: (gh, repo) =>
            send(gh, 'PUT', `repos/${repo}/automated-security-fixes`),
    },
    {
        name: 'secret-scanning',
        async read(gh, repo) {
            const sa = (await get(gh, `repos/${repo}`)).body
                ?.security_and_analysis
            return (
                sa?.secret_scanning?.status === 'enabled' &&
                sa?.secret_scanning_push_protection?.status === 'enabled'
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
            return r.body?.state === 'configured'
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
            return r.body?.enabled === true
        },
        write: (gh, repo) =>
            send(gh, 'PUT', `repos/${repo}/private-vulnerability-reporting`),
    },
    {
        name: 'ai-scan',
        optIn: 'ai-scan',
        async read(gh, repo) {
            const r = await get(gh, `repos/${repo}/code-scanning/ai-scan`)
            return r.body?.pr_scan === 'enabled'
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
    if (name === 'codeql' && /language/i.test(msg)) {
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
        info = {
            id: data.repository.id,
            visibility: data.repository.visibility,
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
