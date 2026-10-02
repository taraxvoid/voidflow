/**
 * Canonical branch rulesets for the voidflow fleet, as data.
 *
 * `scripts/apply-rulesets.ts` diffs these against what GitHub has and (with
 * --apply) creates/updates them. Rulesets that exist in a repo but are not
 * described here are reported, never deleted.
 */

export type BypassActor = {
    actor_id: number | null
    actor_type: 'RepositoryRole' | 'Integration' | 'DeployKey'
    bypass_mode: 'always' | 'pull_request'
}

export type Ruleset = {
    name: string
    target: 'branch'
    enforcement: 'active'
    conditions: { ref_name: { include: string[]; exclude: string[] } }
    bypass_actors: BypassActor[]
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>
}

// Integration (GitHub App) ids as they appear in required status checks.
export const GITHUB_ACTIONS = 15368
export const NETLIFY = 13473

// RepositoryRole 5 is "Admin".
const ADMIN_VIA_PR: BypassActor = {
    actor_id: 5,
    actor_type: 'RepositoryRole',
    bypass_mode: 'pull_request',
}
const ADMIN_ALWAYS: BypassActor = { ...ADMIN_VIA_PR, bypass_mode: 'always' }
const DEPLOY_KEY: BypassActor = {
    actor_id: null,
    actor_type: 'DeployKey',
    bypass_mode: 'always',
}
export const app = (id: number): BypassActor => ({
    actor_id: id,
    actor_type: 'Integration',
    bypass_mode: 'always',
})

export type Tier = 'main' | 'next' | 'live' | 'prerelease' | 'maintenance'

export type RepoConfig = {
    /** Tiers to manage; a tier not listed gets no ruleset. */
    tiers: Tier[]
    /** Require Netlify's deploy status (sites deployed via Netlify). */
    netlify: boolean
    /** Status check contexts from GitHub Actions. */
    checks: string[]
    /** Require CODEOWNERS review. */
    codeowners: boolean
    /**
     * Require linear history on main (and so squash-only). Repos that promote
     * a prerelease branch into main with merge commits set this to false.
     */
    linearHistory: boolean
    /** Extra bypass actors per tier, on top of the tier defaults. */
    bypass: Partial<Record<Tier, BypassActor[]>>
    /** Existing ruleset names to adopt (rename) instead of duplicating. */
    aka: Partial<Record<Tier, string[]>>
    /**
     * Ruleset names that should no longer exist (e.g. next/live protection for
     * a site that moved to a single stable main). Only deleted with --prune.
     */
    retire: string[]
}

const SITE_CHECK = 'validate / Validate'

// Sites run a single stable `main` that deploys to prod (previews on PRs),
// i.e. voidflow's `single-environment` mode. Multi-environment repos
// (main/next/live) list all three tiers instead.
const site = (over: Partial<RepoConfig> = {}): RepoConfig => ({
    tiers: ['main'],
    netlify: true,
    checks: [SITE_CHECK],
    codeowners: true,
    linearHistory: true,
    bypass: {},
    aka: {},
    retire: ['next (staging)', 'live (prod)'],
    ...over,
})

// Integration bypasses are preserved as-is; they are believed to be the
// Netlify/Cloudflare apps and come out once deploys run from Actions (see
// the "Deploy via Actions" issue).
// taraxvoid.net is private on a plan without rulesets, so it is not listed.
export const REPOS: Record<string, RepoConfig> = {
    'taraxvoid/queeromaha': site({
        bypass: { main: [app(NETLIFY), app(85455)] },
    }),
    'taraxvoid/soundry': site({
        bypass: { main: [app(85455), app(1236702)] },
        aka: { main: ['main (live)'] },
    }),
    'taraxvoid/synthomaha': site({
        bypass: { main: [app(85455)] },
    }),
    'taraxvoid/voidflow': {
        // main (stable), next (prerelease channel), release/* (maintenance).
        // See RELEASING.md. Promotion next -> main uses merge commits, so no
        // linear history here.
        tiers: ['main', 'prerelease', 'maintenance'],
        netlify: false,
        checks: ['Validation', 'Unit tests'],
        codeowners: false,
        linearHistory: false,
        bypass: {},
        aka: { main: ['main/prod'] },
        retire: [],
    },
}

const NAMES: Record<Tier, string> = {
    main: 'main (prod)',
    next: 'next (staging)',
    live: 'live (prod)',
    prerelease: 'next (prerelease)',
    maintenance: 'release/* (maintenance)',
}

const REFS: Record<Tier, string> = {
    main: '~DEFAULT_BRANCH',
    next: 'refs/heads/next',
    live: 'refs/heads/live',
    prerelease: 'refs/heads/next',
    maintenance: 'refs/heads/release/*',
}

function mergeMethods(tier: Tier, cfg: RepoConfig): string[] {
    switch (tier) {
        case 'main':
            // Squash-only keeps history linear; repos that promote with merge
            // commits also allow `merge` (never `rebase`).
            return cfg.linearHistory ? ['squash'] : ['squash', 'merge']
        case 'prerelease':
            // Back-merges from main must be merge commits to keep shared ancestry.
            return ['squash', 'merge']
        case 'maintenance':
            return ['squash']
        default:
            // next/live merge promotion branches with any method.
            return ['merge', 'squash', 'rebase']
    }
}

function bypassFor(tier: Tier, cfg: RepoConfig): BypassActor[] {
    switch (tier) {
        case 'next':
            return [DEPLOY_KEY, ADMIN_ALWAYS, ...(cfg.bypass.next ?? [])]
        case 'live':
            return [...(cfg.bypass.live ?? [])]
        default:
            return [ADMIN_VIA_PR, ...(cfg.bypass[tier] ?? [])]
    }
}

export function build(tier: Tier, cfg: RepoConfig): Ruleset {
    const contexts = [
        ...(cfg.netlify
            ? [{ context: 'deploy/netlify', integration_id: NETLIFY }]
            : []),
        ...cfg.checks.map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS,
        })),
    ]
    return {
        name: NAMES[tier],
        target: 'branch',
        enforcement: 'active',
        conditions: {
            ref_name: {
                include: [REFS[tier]],
                exclude: [],
            },
        },
        bypass_actors: bypassFor(tier, cfg),
        rules: [
            { type: 'deletion' },
            { type: 'non_fast_forward' },
            ...(tier === 'main' && cfg.linearHistory
                ? [{ type: 'required_linear_history' }]
                : []),
            {
                type: 'pull_request',
                parameters: {
                    required_approving_review_count: 0,
                    dismiss_stale_reviews_on_push: false,
                    required_reviewers: [],
                    require_code_owner_review: cfg.codeowners,
                    require_last_push_approval: false,
                    required_review_thread_resolution: false,
                    require_extra_approval_for_unattributed_changes: true,
                    allowed_merge_methods: mergeMethods(tier, cfg),
                },
            },
            {
                type: 'required_status_checks',
                parameters: {
                    strict_required_status_checks_policy: false,
                    // A freshly cut release/N.x has no CI statuses yet; protection
                    // applies from the first push after creation.
                    do_not_enforce_on_create: tier === 'maintenance',
                    required_status_checks: contexts,
                },
            },
        ],
    }
}

/** Every ruleset we want, per repo, with the names it may already have. */
export function desired(repo: string): Array<{ ruleset: Ruleset; aka: string[] }> {
    const cfg = REPOS[repo]
    if (!cfg) throw new Error(`unknown repo ${repo}`)
    return cfg.tiers.map((tier) => ({
        ruleset: build(tier, cfg),
        aka: cfg.aka[tier] ?? [],
    }))
}

// ---- normalisation + diff -------------------------------------------------

/** Order-insensitive canonical form so GitHub's ordering never shows as drift. */
export function normalise(r: Ruleset): unknown {
    const sortBy = <T>(xs: T[], key: (x: T) => string) =>
        [...xs].sort((a, b) => key(a).localeCompare(key(b)))
    return {
        name: r.name,
        target: r.target,
        enforcement: r.enforcement,
        conditions: r.conditions,
        bypass_actors: sortBy(
            r.bypass_actors,
            (a) => `${a.actor_type}:${a.actor_id}:${a.bypass_mode}`,
        ),
        rules: sortBy(r.rules, (x) => x.type).map((rule) => {
            const p = rule.parameters as any
            if (rule.type === 'required_status_checks' && p) {
                return {
                    type: rule.type,
                    parameters: {
                        ...p,
                        required_status_checks: sortBy(
                            p.required_status_checks,
                            (c: any) => c.context,
                        ),
                    },
                }
            }
            return rule.parameters
                ? { type: rule.type, parameters: p }
                : { type: rule.type }
        }),
    }
}

function flatten(v: unknown, path = ''): string[] {
    if (v === null || typeof v !== 'object') return [`${path} = ${JSON.stringify(v)}`]
    const entries = Array.isArray(v)
        ? v.map((x, i) => [String(i), x] as const)
        : Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return [`${path} = ${Array.isArray(v) ? '[]' : '{}'}`]
    return entries.flatMap(([k, x]) => flatten(x, path ? `${path}.${k}` : k))
}

/** Lines only in `have` ("-") or only in `want` ("+"). Empty means in sync. */
export function diff(have: unknown, want: unknown): string[] {
    const h = new Set(flatten(have))
    const w = new Set(flatten(want))
    return [
        ...[...h].filter((l) => !w.has(l)).map((l) => `- ${l}`),
        ...[...w].filter((l) => !h.has(l)).map((l) => `+ ${l}`),
    ]
}
