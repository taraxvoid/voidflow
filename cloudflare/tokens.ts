/**
 * Scoped Cloudflare deploy tokens for the voidflow fleet, as data.
 *
 * `scripts/cf-tokens.ts` diffs these against the account's API tokens and
 * (with --apply) creates, updates or rotates them, writing each new value to
 * the repo's GitHub environment secret. Tokens it did not create are left
 * alone unless a repo lists them under `retire` (deleted only with --prune).
 *
 * Each token is owned by its env's account (dev/staging and prod can live in
 * different accounts) and scoped to one Worker (Workers Editor on that
 * Worker), plus Workers Routes Write on the zones of its custom domains.
 * Custom Domains do not support per-Worker roles yet; when a deploy proves the
 * zone grant is not enough, record a `fallback` and the token also gets
 * account-wide Workers Scripts Write. Every plan and every deploy says so.
 */

export type Fallback = {
    /** Why the narrow token was not enough, e.g. 'custom-domain'. */
    reason: string
    /** ISO date the fallback was recorded. */
    since: string
}

export type EnvConfig = {
    /** GitHub environment the deploy job runs in (holds the secret). */
    env: string
    /** Worker script name, as in wrangler.jsonc `name`. */
    worker: string
    /** Zones of the Worker's routes and custom domains, by name. */
    zones: string[]
    /** Account the Worker and token live in, when not the repo's `account`. */
    account?: string
    fallback?: Fallback
}

/** An old token to retire; a bare name means the repo's `account`. */
export type Retire = string | { account: string; name: string }

export type RepoConfig = {
    /** Default account for the repo's envs and `retire` names. */
    account: string
    envs: EnvConfig[]
    /** Pre-voidflow token names to delete with --prune once cut over. */
    retire: Retire[]
}

export type Resources = Record<string, string | Record<string, string>>

export type Policy = {
    effect: 'allow'
    permission_groups: Array<{ id: string; name?: string }>
    resources: Resources
}

/** A token as the account tokens API returns it (the fields we read). */
export type Token = {
    id: string
    name: string
    status?: string
    policies: Array<Policy & { id?: string }>
    expires_on?: string | null
}

export const TAG = 'voidflow'
/** Token lifetime; `apply` rotates and `--check` fails inside RENEW_DAYS. */
export const TTL_DAYS = 90
export const RENEW_DAYS = 14

const TARAXVOID = 'c6a445a43a801403a8e33968be40c19c'

// Permission group ids. Names are cosmetic and can change; ids are stable.
// `just cf-tokens-groups` prints the live names next to these.
//
// WORKER_EDITOR is the set the dashboard produced for "Specified Workers >
// Editor" (2026-10, twice). It mixes the new Workers role groups with legacy
// ones (KV, R2, Scripts, Account Settings). The transbot shakedown checks
// whether the role really needs all of them.
export const WORKER_EDITOR = [
    'cb142f7fbc3540f0bade0cbe75f606dc',
    'bdbcd690c763475a985e8641dddc09f7',
    '82c075da3f4647a2a03becd0fe240f8a',
    '2e095cf436e2455fa62c9a9c2e18c478',
    '8d28297797f24fb8a0c332fe0866ec89',
    'bf7481a1826f439697cb59a20b22293e',
    '05880cd1bdc24d8bae0be2136972816b',
    'f7f0eda5697f475c90846e879bab8666',
    'e086da7e2179491d91ee5f35b3ca210a',
    'c1fde68c7bcc44588cbb6ddbc16d6480',
]
/** Zone > Workers Routes > Write: add or keep routes and custom domains. */
export const WORKERS_ROUTES_WRITE = '28f4b596e7d643029c524985477ae49a'
/** Legacy account-wide Workers Scripts Write, used only for a fallback. */
export const WORKERS_SCRIPTS_WRITE = 'e086da7e2179491d91ee5f35b3ca210a'

export const REPOS: Record<string, RepoConfig> = {
    // Assets-only Worker, one custom domain, no D1/R2/KV: the smallest real
    // deploy, so the first shakedown.
    'taraxvoid/transbot': {
        account: TARAXVOID,
        envs: [{ env: 'prod', worker: 'transbot', zones: ['transbot.net'] }],
        retire: ['transbot-deploy-token'],
    },
}

export const tokenName = (repo: string, env: string) =>
    `${TAG}:${repo}:${env}`

/** The account an env's Worker and token live in. */
export const envAccount = (cfg: RepoConfig, env: EnvConfig) =>
    env.account ?? cfg.account

/** `retire` entries with their accounts filled in. */
export const retireTargets = (cfg: RepoConfig) =>
    cfg.retire.map((r) =>
        typeof r === 'string' ? { account: cfg.account, name: r } : r,
    )

/** Every account a repo's envs and `retire` entries touch. */
export const repoAccounts = (cfg: RepoConfig) => [
    ...new Set([
        ...cfg.envs.map((e) => envAccount(cfg, e)),
        ...retireTargets(cfg).map((r) => r.account),
    ]),
]

// ---- config from elsewhere --------------------------------------------------

/**
 * Check an untyped config (another repo's `--config` module) and throw with
 * every problem, by path. Returns the config unchanged.
 */
export function checkRepos(x: unknown): Record<string, RepoConfig> {
    const isObj = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v)
    const isStr = (v: unknown): v is string =>
        typeof v === 'string' && v !== ''
    const isAcct = (v: unknown) =>
        typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
    if (!isObj(x)) throw new Error('config is not an object of repos')
    const errs: string[] = []
    const bad = (path: string, why: string) => errs.push(`${path}: ${why}`)
    for (const [repo, cfg] of Object.entries(x)) {
        const at = JSON.stringify(repo)
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) bad(at, 'key is not owner/name')
        if (!isObj(cfg)) {
            bad(at, 'not an object')
            continue
        }
        if (!isAcct(cfg.account)) bad(`${at}.account`, 'not a 32-hex account id')
        if (!Array.isArray(cfg.envs)) bad(`${at}.envs`, 'not a list')
        else if (cfg.envs.length === 0) bad(`${at}.envs`, 'empty')
        const seen = new Set<string>()
        for (const [i, env] of (Array.isArray(cfg.envs) ? cfg.envs : []).entries()) {
            const e = `${at}.envs[${i}]`
            if (!isObj(env)) {
                bad(e, 'not an object')
                continue
            }
            if (!isStr(env.env)) bad(`${e}.env`, 'missing')
            else if (seen.has(env.env)) bad(`${e}.env`, `duplicate "${env.env}"`)
            else seen.add(env.env)
            if (!isStr(env.worker)) bad(`${e}.worker`, 'missing')
            if (!Array.isArray(env.zones) || !env.zones.every(isStr))
                bad(`${e}.zones`, 'not a list of zone names')
            if (env.account !== undefined && !isAcct(env.account))
                bad(`${e}.account`, 'not a 32-hex account id')
            if (
                env.fallback !== undefined &&
                !(
                    isObj(env.fallback) &&
                    isStr(env.fallback.reason) &&
                    isStr(env.fallback.since)
                )
            )
                bad(`${e}.fallback`, 'needs reason and since')
        }
        if (!Array.isArray(cfg.retire)) bad(`${at}.retire`, 'not a list')
        for (const [i, r] of (Array.isArray(cfg.retire) ? cfg.retire : []).entries()) {
            if (!(isStr(r) || (isObj(r) && isAcct(r.account) && isStr(r.name))))
                bad(`${at}.retire[${i}]`, 'a name or { account, name }')
        }
    }
    if (errs.length) throw new Error(errs.join('\n'))
    return x as Record<string, RepoConfig>
}

const account = (id: string) => `com.cloudflare.api.account.${id}`

/**
 * Policies for one env. `scriptTag` is the Worker's tag (not its name) and
 * `zoneIds` maps each configured zone name to its id; tokens reference
 * resources by id, so the script looks both up.
 */
export function policies(
    cfg: RepoConfig,
    env: EnvConfig,
    ids: { scriptTag: string; zoneIds: Record<string, string> },
): Policy[] {
    const acct = account(envAccount(cfg, env))
    const out: Policy[] = [
        {
            effect: 'allow',
            permission_groups: WORKER_EDITOR.map((id) => ({ id })),
            resources: {
                [acct]: {
                    [`com.cloudflare.edge.worker.script.${ids.scriptTag}`]:
                        '*',
                },
            },
        },
    ]
    if (env.zones.length > 0) {
        const zones: Resources = {}
        for (const z of env.zones) {
            const id = ids.zoneIds[z]
            if (!id) throw new Error(`no zone id for ${z}`)
            zones[`com.cloudflare.api.account.zone.${id}`] = '*'
        }
        out.push({
            effect: 'allow',
            permission_groups: [{ id: WORKERS_ROUTES_WRITE }],
            resources: zones,
        })
    }
    if (env.fallback) {
        out.push({
            effect: 'allow',
            permission_groups: [{ id: WORKERS_SCRIPTS_WRITE }],
            resources: { [acct]: '*' },
        })
    }
    return out
}

/** Expiry `days` from `now`, at the end of that UTC day (dashboard style). */
export function expiresOn(now: Date, days = TTL_DAYS): string {
    const d = new Date(now.getTime() + days * 86_400_000)
    return `${d.toISOString().slice(0, 10)}T23:59:59Z`
}

// ---- normalisation + plan ---------------------------------------------------

/** Order-insensitive policies, without the ids and names the API adds. */
export function normalise(ps: Policy[]): string {
    const sortKeys = (r: Resources | string): unknown =>
        typeof r === 'string'
            ? r
            : Object.fromEntries(
                  Object.keys(r)
                      .sort()
                      .map((k) => [k, sortKeys(r[k] as Resources | string)]),
              )
    return JSON.stringify(
        ps
            .map((p) =>
                JSON.stringify({
                    effect: p.effect,
                    permission_groups: p.permission_groups
                        .map((g) => g.id)
                        .sort(),
                    resources: sortKeys(p.resources),
                }),
            )
            .sort(),
    )
}

export type Action =
    | { kind: 'create'; reason: string }
    | { kind: 'update'; token: Token; reason: string }
    /** Create a replacement, set the secret, then delete every `tokens`. */
    | { kind: 'rotate'; tokens: Token[]; reason: string }
    | { kind: 'ok'; token: Token }

const daysLeft = (iso: string, now: Date) =>
    (Date.parse(iso) - now.getTime()) / 86_400_000

/**
 * What to do for one env's token. `have` is every account token with the
 * env's name. More than one means a rotation stopped between creating a token
 * and deleting the old one, and nothing says which value the GitHub secret
 * holds, so rotate: once the secret has a fresh value, all of them are unused.
 */
export function plan(
    want: Policy[],
    have: Token[],
    now: Date,
    opts: { rotate?: boolean } = {},
): Action[] {
    if (have.length === 0) return [{ kind: 'create', reason: 'missing' }]
    if (have.length > 1) {
        return [
            {
                kind: 'rotate',
                tokens: have,
                reason: `${have.length} tokens (interrupted rotation?)`,
            },
        ]
    }
    const [token] = have
    const left = token.expires_on ? daysLeft(token.expires_on, now) : null
    if (opts.rotate || left === null || left < RENEW_DAYS) {
        // The replacement is created with the wanted policies, so a rotation
        // also fixes any drift.
        const why = opts.rotate
            ? 'requested'
            : left === null
              ? 'no expiry'
              : left < 0
                ? 'expired'
                : `expires in ${Math.floor(left)}d`
        return [{ kind: 'rotate', tokens: [token], reason: why }]
    }
    if (normalise(token.policies) !== normalise(want)) {
        return [{ kind: 'update', token, reason: 'policies differ' }]
    }
    return [{ kind: 'ok', token }]
}
