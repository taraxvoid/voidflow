/**
 * Scoped Cloudflare deploy tokens: the config shape and the plan logic. The
 * fleet itself (repos, accounts, envs) lives in the org's infra repo and is
 * passed with --config (e.g. taraxvoid/infra's cf-tokens.ts).
 *
 * `scripts/cf-tokens.ts` diffs that config against the account's API tokens and
 * (with --apply) creates, updates or rotates them, writing each new value to
 * the repo's `CLOUDFLARE_API_TOKEN` secret (per GitHub environment by default,
 * or repo-wide). Tokens it did not create are left alone unless a repo lists
 * them under `retire` (deleted only with --prune).
 *
 * The Worker and its zones come from the repo's own wrangler config unless an
 * env spells them out, so a route added there shows up as drift here.
 *
 * Each token is owned by its env's account (envs can live in different
 * accounts) and scoped to one Worker (Workers Editor on that
 * Worker), plus Workers Routes Write on the zones of its routes.
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
    /**
     * Names the token, and is the GitHub environment that holds its secret
     * (unless `secret` is 'repo').
     */
    env: string
    /**
     * Where the secret goes: 'env' (default) is an environment secret, read
     * only by jobs with `environment: <env>`, so branch policies on that
     * environment gate it; 'repo' is a repository secret every job can read,
     * for repos that deploy without environments. One env per repo at most.
     */
    secret?: 'env' | 'repo'
    /** Worker script name. Default: from the wrangler config. */
    worker?: string
    /**
     * Zones to grant Workers Routes Write on, by name. Default: the zones of
     * the wrangler config's routes; `[]` for none (e.g. a Worker Preview
     * token, which deploys no routes).
     */
    zones?: string[]
    /** Wrangler config path in the repo (default branch). Default: wrangler.jsonc. */
    wrangler?: string
    /**
     * Wrangler `env.<name>` block to read. Default: the block named like
     * `env` if the config has one, else the top level.
     */
    wranglerEnv?: string
    /** Account the Worker and token live in, when not the repo's `account`. */
    account?: string
    fallback?: Fallback
}

/** What an env's token is scoped to, once resolved. */
export type Target = { worker: string; zones: string[] }

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
    last_used_on?: string | null
}

export const TAG = 'voidflow'
/** Token lifetime; `apply` rotates and `--check` fails inside RENEW_DAYS. */
export const TTL_DAYS = 90
export const RENEW_DAYS = 14

// Permission group ids. Names are cosmetic and can change; ids are stable.
// `just cf-tokens-groups` prints the live names next to these.
//
// WORKER_EDITOR is the set the dashboard produced for "Specified Workers >
// Editor" (2026-10, twice). It mixes the new Workers role groups with legacy
// ones (KV, R2, Scripts, Account Settings). Shaken down 2026-10 on transbot
// (custom domain, zone grant only) and taraxvoid.net (KV bound by id, two
// zones): both deployed with no fallback. Whether every group is needed is
// untested.
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

// ---- wrangler config --------------------------------------------------------

type Route = string | { pattern: string; zone_name?: string }

/**
 * The Worker name and route hostnames an env deploys, read from a parsed
 * wrangler config the way wrangler reads it: an `env.<name>` block's `name`,
 * else the top-level name plus `-<name>`; its `routes`/`route`, else the
 * top level's. A route's `zone_name`, when set, is used as is.
 */
export function fromWrangler(
    config: unknown,
    env: string,
    wranglerEnv?: string,
): { worker: string; hosts: string[]; zones: string[] } {
    type Block = { name?: string; route?: Route; routes?: Route[] }
    const top = config as Block & { env?: Record<string, Block> }
    const block = wranglerEnv ?? (top.env?.[env] ? env : undefined)
    const sub = block === undefined ? undefined : top.env?.[block]
    if (block !== undefined && !sub) {
        throw new Error(`wrangler config has no env.${block}`)
    }
    const worker =
        sub?.name ?? (top.name && block ? `${top.name}-${block}` : top.name)
    if (!worker) throw new Error('wrangler config has no name')
    const pick = (b?: Block) => b?.routes ?? (b?.route ? [b.route] : undefined)
    const hosts: string[] = []
    const zones: string[] = []
    for (const r of pick(sub) ?? pick(top) ?? []) {
        if (typeof r !== 'string' && r.zone_name) zones.push(r.zone_name)
        else hosts.push(routeHost(typeof r === 'string' ? r : r.pattern))
    }
    return { worker, hosts, zones }
}

/** `*.example.com/api/*` and `https://example.com:443/` to their hostname. */
export const routeHost = (pattern: string) =>
    pattern
        .replace(/^[a-z]+:\/\//, '')
        .replace(/[/:].*$/, '')
        .replace(/^\*\.?/, '')

/** The zone a hostname belongs to: the longest zone name it ends with. */
export function zoneOf(host: string, zoneNames: string[]): string | undefined {
    return zoneNames
        .filter((z) => host === z || host.endsWith(`.${z}`))
        .sort((a, b) => b.length - a.length)[0]
}

/**
 * The Worker and zone names an env's token covers: its own `worker`/`zones`
 * when given, else the wrangler config's (`wrangler` is undefined only when
 * the env gives both). Throws when a route's host is in none of `zoneNames`
 * (the account's zones), rather than leaving it out.
 */
export function resolveTarget(
    env: EnvConfig,
    wrangler: unknown,
    zoneNames: string[],
): Target {
    const from = () => fromWrangler(wrangler, env.env, env.wranglerEnv)
    const worker = env.worker ?? from().worker
    if (env.zones) return { worker, zones: env.zones }
    const { hosts, zones } = from()
    for (const h of hosts) {
        const z = zoneOf(h, zoneNames)
        if (!z) throw new Error(`route host ${h} is in no zone of the account`)
        zones.push(z)
    }
    return { worker, zones: [...new Set(zones)].sort() }
}

// ---- config from elsewhere --------------------------------------------------

const ENV_FIELDS = [
    'env',
    'secret',
    'worker',
    'zones',
    'wrangler',
    'wranglerEnv',
    'account',
    'fallback',
] satisfies Array<keyof EnvConfig> as string[]

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
        let repoScoped = 0
        for (const [i, env] of (Array.isArray(cfg.envs) ? cfg.envs : []).entries()) {
            const e = `${at}.envs[${i}]`
            if (!isObj(env)) {
                bad(e, 'not an object')
                continue
            }
            for (const k of Object.keys(env))
                if (!ENV_FIELDS.includes(k)) bad(`${e}.${k}`, 'unknown field')
            if (!isStr(env.env)) bad(`${e}.env`, 'missing')
            else if (seen.has(env.env)) bad(`${e}.env`, `duplicate "${env.env}"`)
            else seen.add(env.env)
            if (env.secret !== undefined && env.secret !== 'env' && env.secret !== 'repo')
                bad(`${e}.secret`, "'env' or 'repo'")
            if (env.secret === 'repo' && ++repoScoped === 2)
                bad(`${e}.secret`, "a second 'repo' env would overwrite the first's secret")
            for (const k of ['worker', 'wrangler', 'wranglerEnv'])
                if (env[k] !== undefined && !isStr(env[k])) bad(`${e}.${k}`, 'not a name')
            if (
                env.zones !== undefined &&
                (!Array.isArray(env.zones) || !env.zones.every(isStr))
            )
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
 * `zoneIds` maps each of the target's zone names to its id; tokens reference
 * resources by id, so the script looks both up.
 */
export function policies(
    cfg: RepoConfig,
    env: EnvConfig,
    ids: { scriptTag: string; zoneIds: Record<string, string> },
    zones: string[] = Object.keys(ids.zoneIds),
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
    if (zones.length > 0) {
        const resources: Resources = {}
        for (const z of zones) {
            const id = ids.zoneIds[z]
            if (!id) throw new Error(`no zone id for ${z}`)
            resources[`com.cloudflare.api.account.zone.${id}`] = '*'
        }
        out.push({
            effect: 'allow',
            permission_groups: [{ id: WORKERS_ROUTES_WRITE }],
            resources,
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
