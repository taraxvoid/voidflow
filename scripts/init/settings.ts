/**
 * GitHub repo settings for `voidflow init`: read current state, change only
 * what differs. The table is data so a drift check can reuse it.
 */
import { SETTING_GROUPS, type SettingsGroup } from '../../config/settings.ts'
import { RELOCK_LABEL } from './actions-lock.ts'
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
    /** The credential's role on the repo: ADMIN, MAINTAIN, WRITE, TRIAGE, READ. */
    viewerPermission?: string
}

/** One setting; its group comes from SETTING_GROUPS in config/settings.ts. */
type Setting = {
    name: string
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
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
        // AI Scan for pull requests and for the repository: one endpoint, the
        // same eligibility, changed together. `repository_scan` is a preview;
        // a repo whose GET lacks it is checked on `pr_scan` alone, so the
        // preview reaching it later shows up as drift.
        name: 'ai-scan',
        async read(gh, repo) {
            const b = await aiScan(gh, repo)
            return (
                b?.pr_scan === 'enabled' &&
                (!('repository_scan' in (b ?? {})) ||
                    b?.repository_scan === 'enabled')
            )
        },
        async write(gh, repo) {
            const b = await aiScan(gh, repo)
            await send(gh, 'PATCH', `repos/${repo}/code-scanning/ai-scan`, {
                pr_scan: 'enabled',
                ...(b && 'repository_scan' in b
                    ? { repository_scan: 'enabled' }
                    : {}),
            })
        },
    },
]

async function aiScan(gh: Gh, repo: string) {
    return object((await get(gh, `repos/${repo}/code-scanning/ai-scan`)).body)
}

/**
 * Labels the deps-review agent applies, created up front. Names follow
 * rookery's convention: lowercase words joined by hyphens, so they never need
 * quoting. `needs-you` is rookery's shared "blocked on a human" label, not a
 * deps-only one. `was` is the old name: a repo that has it gets it deleted
 * (nothing legacy is preserved).
 */
const AGENTIC_LABELS = [
    {
        name: 'low-risk',
        was: 'deps:low-risk',
        color: '0e8a16',
        description: 'Dependency update judged low risk by deps-review',
    },
    {
        name: 'needs-you',
        was: 'deps:needs-you',
        color: 'd93f0b',
        description:
            'Blocked on a human decision, whoever or whatever was working on it.',
    },
]

async function labelExists(gh: Gh, repo: string, name: string) {
    const r = await gh.rest(
        'GET',
        `repos/${repo}/labels/${encodeURIComponent(name)}`,
    )
    if (r.status === 404) return false
    ok(r)
    return true
}

function repoFlag(
    name: string,
    field:
        | 'allow_auto_merge'
        | 'allow_update_branch'
        | 'delete_branch_on_merge',
): Setting {
    return {
        name,
        async read(gh, repo) {
            return (
                object((await get(gh, `repos/${repo}`)).body)?.[field] === true
            )
        },
        write: (gh, repo) =>
            send(gh, 'PATCH', `repos/${repo}`, { [field]: true }),
    }
}

function agenticSettings(): Setting[] {
    return [
        repoFlag('auto-merge', 'allow_auto_merge'),
        repoFlag('update-branch', 'allow_update_branch'),
        repoFlag('delete-branch-on-merge', 'delete_branch_on_merge'),
        {
            name: 'actions-permissions',
            // Read-only token, and Actions must never approve PRs: deps-review
            // must not be able to approve what it reviews.
            async read(gh, repo) {
                const b = object(
                    (
                        await get(
                            gh,
                            `repos/${repo}/actions/permissions/workflow`,
                        )
                    ).body,
                )
                return (
                    b?.default_workflow_permissions === 'read' &&
                    b?.can_approve_pull_request_reviews === false
                )
            },
            write: (gh, repo) =>
                send(gh, 'PUT', `repos/${repo}/actions/permissions/workflow`, {
                    default_workflow_permissions: 'read',
                    can_approve_pull_request_reviews: false,
                }),
        },
        {
            name: 'fork-pr-approval',
            // Runs from any outside contributor's fork PR wait for approval,
            // so agent-driven workflows never run untrusted code unprompted.
            async read(gh, repo) {
                const b = object(
                    (
                        await get(
                            gh,
                            `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
                        )
                    ).body,
                )
                return b?.approval_policy === 'all_external_contributors'
            },
            write: (gh, repo) =>
                send(
                    gh,
                    'PUT',
                    `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
                    { approval_policy: 'all_external_contributors' },
                ),
        },
        ...AGENTIC_LABELS.map(
            (label): Setting => ({
                name: `label-${label.name}`,
                read: (gh, repo) => labelExists(gh, repo, label.name),
                async write(gh, repo) {
                    const { name, color, description } = label
                    if (await labelExists(gh, repo, label.was)) {
                        await send(
                            gh,
                            'DELETE',
                            `repos/${repo}/labels/${encodeURIComponent(label.was)}`,
                        )
                    }
                    await send(gh, 'POST', `repos/${repo}/labels`, {
                        name,
                        color,
                        description,
                    })
                },
            }),
        ),
    ]
}

SETTINGS.push(...agenticSettings())

// The label that asks relock-actions to relock a non-Renovate pull request.
SETTINGS.push({
    name: `label-${RELOCK_LABEL.name}`,
    read: (gh, repo) => labelExists(gh, repo, RELOCK_LABEL.name),
    write: (gh, repo) => send(gh, 'POST', `repos/${repo}/labels`, RELOCK_LABEL),
})

export function settingNames(): string[] {
    return SETTINGS.map((s) => s.name)
}

const PLAN_GATED = new Set(['codeql', 'secret-scanning'])

/** GitHub's 403 text for a token missing a scope or fine-grained permission. */
const TOKEN_SCOPE = /not accessible by (personal access token|integration)/i

const AI_SCAN_HINT =
    'AI Scan needs a public repo owned by an organization, or GitHub Code Security, and the organization and enterprise policies must allow it. Turning it on starts no scan; scans run on demand and use Code Security AI credits (or skip it: settings.skip in voidflow.config.ts, or --skip ai-scan)'

/** Actionable replacement for the raw 403/422 body on a plan-gated setting. */
function planGatedHint(name: string, info: RepoInfo): string {
    const feature = name === 'codeql' ? 'code scanning' : 'secret scanning'
    const kind = info.visibility === 'INTERNAL' ? 'internal' : 'private'
    return `${feature} on ${kind} repositories needs a paid GitHub Code Security / Secret Protection plan; enable it for the org or make the repo public, then re-run (or skip it: settings.skip in voidflow.config.ts, or --skip ${name})`
}

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
            detail: 're-run voidflow apply settings (or voidflow init --preset settings) after your first push',
        }
    }
    if (name === 'ai-scan' && status === 422) {
        return { name, status: 'skipped-plan', detail: AI_SCAN_HINT }
    }
    // An admin's token can still lack a scope (a fine-grained token without
    // Code scanning alerts, say). GitHub says so in the message; that is a
    // failed read, not a plan limit, or check would hide the drift.
    if (status === 403 && TOKEN_SCOPE.test(msg)) {
        return {
            name,
            status: 'failed',
            detail: `the credential lacks a permission this setting needs: ${msg}`,
        }
    }
    if (
        PLAN_GATED.has(name) &&
        info.visibility !== 'PUBLIC' &&
        (status === 403 || status === 422)
    ) {
        return {
            name,
            status: 'skipped-plan',
            detail: planGatedHint(name, info),
        }
    }
    return { name, status: 'failed', detail: msg }
}

/** What one run did; `notAdmin` (the credential's role) means nothing was read. */
export type SettingsRun = { results: SettingResult[]; notAdmin?: string }

/** The settings a selection covers: baseline plus enabled groups, minus skips. */
export function selectSettings(
    enabled: ReadonlySet<SettingsGroup>,
    skip: ReadonlySet<string>,
): string[] {
    return SETTINGS.map((s) => s.name).filter((name) => {
        if (skip.has(name)) return false
        const group = SETTING_GROUPS[name]
        return group === 'baseline' || enabled.has(group)
    })
}

export async function runSettings(
    gh: Gh,
    repo: string,
    sel: {
        enabled: ReadonlySet<SettingsGroup>
        skip: ReadonlySet<string>
        dryRun: boolean
    },
): Promise<SettingsRun> {
    const names = new Set(selectSettings(sel.enabled, sel.skip))
    const chosen = SETTINGS.filter((s) => names.has(s.name))
    let info: RepoInfo
    try {
        const { owner, name } = split(repo)
        const data = await gh.graphql(
            'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id visibility pullRequestCreationPolicy issueCreationPolicy viewerPermission } }',
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
            viewerPermission:
                typeof repository.viewerPermission === 'string'
                    ? repository.viewerPermission
                    : undefined,
        }
    } catch (e) {
        const detail = `cannot read ${repo}: ${e instanceof Error ? e.message : String(e)}`
        return {
            results: chosen.map((s) => ({
                name: s.name,
                status: 'failed',
                detail,
            })),
        }
    }
    // Most settings need admin, and a weak credential's 403 would read as a
    // plan-gated skip and hide drift, so check before reading any.
    if (info.viewerPermission !== 'ADMIN')
        return { results: [], notAdmin: info.viewerPermission ?? 'none' }
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
    return { results }
}

export function manualReminders(
    repo: string,
    enabled: ReadonlySet<SettingsGroup>,
): string[] {
    const url = `https://github.com/${repo}/settings/security_analysis`
    const lines = [`Turn on Dependabot malware alerts (no API setting): ${url}`]
    if (enabled.has('actions-lock')) {
        lines.push(
            `Once actions.lock is committed and verify-lockfile passes, turn on the Require lockfile policy (no API setting): Evaluate first where offered (Enterprise Cloud), then Active. See https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles`,
        )
    }
    if (enabled.has('agentic')) {
        lines.push(
            `Add the COPILOT_GITHUB_TOKEN secret for the deps-review engine (cannot be created from nothing), as an Actions secret (https://github.com/${repo}/settings/secrets/actions) and again as a Dependabot secret (https://github.com/${repo}/settings/secrets/dependabot)`,
        )
    }
    if (enabled.has('ai-scan')) {
        lines.push(
            `Turn on code scanning for AI applications (preview, no API setting): ${url}`,
        )
    }
    return lines
}
