#!/usr/bin/env bun
/**
 * Plan, apply or rotate scoped Cloudflare deploy tokens for the fleet in the
 * --config module (the org's infra repo), shaped as in cloudflare/tokens.ts.
 * Every invocation takes --config <module>, e.g. ../infra/cf-tokens.ts:
 *
 *   bun scripts/cf-tokens.ts                    # plan (read-only), every repo
 *   bun scripts/cf-tokens.ts --repo transbot    # plan one repo
 *   bun scripts/cf-tokens.ts --check            # plan, exit 1 on drift or a token due to rotate
 *   bun scripts/cf-tokens.ts --apply            # create/update/rotate, set the GitHub env secrets
 *   bun scripts/cf-tokens.ts --apply --rotate   # ...and rotate every token now
 *   bun scripts/cf-tokens.ts --apply --prune    # ...and delete the repo's `retire` tokens
 *   bun scripts/cf-tokens.ts --groups           # live names of the permission group ids used
 *   bun scripts/cf-tokens.ts --repo transbot --try prod -- bunx wrangler deploy
 *                                               # run a command with a throwaway token scoped like prod's
 *
 * The module exports `REPOS` (or a default); see scripts/lib/config.ts.
 *
 * Needs CF_TOKEN_ADMIN: a user-owned token covering every account in the
 * config (envs can sit in different accounts),
 * with Account API Tokens Edit, Workers Scripts Read (Worker tags) and Zone
 * Read (zone ids) on each. Keep it local; never put it in CI.
 *
 * GitHub goes through the `gh` CLI, with admin on the repos: even a plan reads
 * each repo's wrangler config (for envs that don't spell out worker and zones)
 * and its repo-wide secret names. New token values are piped straight into
 * `gh secret set` and never printed.
 */
import { parseArgs } from 'node:util'
import { loadOrExit } from './lib/config.ts'
import {
    WORKERS_ROUTES_WRITE,
    checkRepos,
    WORKERS_SCRIPTS_WRITE,
    WORKER_EDITOR,
    envAccount,
    expiresOn,
    plan,
    policies,
    repoAccounts,
    resolveTarget,
    retireTargets,
    tokenName,
    type Action,
    type EnvConfig,
    type Policy,
    type RepoConfig,
    type Token,
} from '../cloudflare/tokens.ts'

const { values, positionals } = parseArgs({
    options: {
        apply: { type: 'boolean', default: false },
        rotate: { type: 'boolean', default: false },
        prune: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        groups: { type: 'boolean', default: false },
        try: { type: 'string' },
        repo: { type: 'string' },
        config: { type: 'string' },
    },
    allowPositionals: true,
})

const REPOS = await loadOrExit(values.config, checkRepos)

const ADMIN = process.env.CF_TOKEN_ADMIN
if (!ADMIN) {
    console.error('CF_TOKEN_ADMIN is not set (see CONTRIBUTING.md, Cloudflare deploy tokens as code)')
    process.exit(2)
}

const API = 'https://api.cloudflare.com/client/v4'

async function cfRaw<T>(
    method: string,
    path: string,
    body?: unknown,
): Promise<{ result: T; result_info?: { total_pages?: number; total_count?: number } }> {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${ADMIN}`,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json()) as {
        success: boolean
        errors?: Array<{ code: number; message: string }>
        result: T
        result_info?: { total_pages?: number; total_count?: number }
    }
    if (!json.success) {
        const why = (json.errors ?? []).map((e) => `${e.code} ${e.message}`)
        throw new Error(`${method} ${path}: ${res.status} ${why.join('; ')}`)
    }
    return json
}

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await cfRaw<T>(method, path, body)).result
}

/**
 * Every page of a list endpoint, going by `result_info` (total_pages, else
 * total_count). Without either the endpoint is taken as unpaged: one that
 * ignores `page` would return its whole list on every page, forever.
 */
async function cfAll<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; ; page++) {
        const sep = path.includes('?') ? '&' : '?'
        const { result, result_info } = await cfRaw<T[]>(
            'GET',
            `${path}${sep}per_page=50&page=${page}`,
        )
        out.push(...result)
        const info = result_info ?? {}
        const done =
            info.total_pages !== undefined
                ? page >= info.total_pages
                : info.total_count !== undefined
                  ? out.length >= info.total_count || result.length === 0
                  : true
        if (done) return out
    }
}

async function gh(args: string[], stdin?: string): Promise<string> {
    const proc = Bun.spawn(['gh', ...args], {
        stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    if (code !== 0) throw new Error(`gh ${args.join(' ')}: ${err || out}`)
    return out
}

// ---- --groups ---------------------------------------------------------------

if (values.groups) {
    const accounts = [...new Set(Object.values(REPOS).flatMap(repoAccounts))]
    const used = new Map<string, string[]>()
    const note = (id: string, where: string) =>
        used.set(id, [...(used.get(id) ?? []), where])
    for (const id of WORKER_EDITOR) note(id, 'WORKER_EDITOR')
    note(WORKERS_ROUTES_WRITE, 'WORKERS_ROUTES_WRITE')
    note(WORKERS_SCRIPTS_WRITE, 'WORKERS_SCRIPTS_WRITE')
    for (const acct of accounts) {
        const live = await cf<
            Array<{ id: string; name: string; scopes?: string[] }>
        >('GET', `/accounts/${acct}/tokens/permission_groups`)
        const byId = new Map(live.map((g) => [g.id, g]))
        console.log(`== account ${acct}`)
        for (const [id, where] of used) {
            const g = byId.get(id)
            const desc = g
                ? `${g.name}  [${(g.scopes ?? []).join(',')}]`
                : 'NOT FOUND'
            console.log(`  ${id}  ${desc}  (${where.join(', ')})`)
        }
    }
    process.exit(0)
}

// ---- plan / apply -----------------------------------------------------------

const repos = Object.keys(REPOS).filter(
    (r) => !values.repo || r === values.repo || r.endsWith(`/${values.repo}`),
)
if (repos.length === 0) {
    console.error(`no repo matches --repo ${values.repo}`)
    process.exit(2)
}

const now = new Date()
let pending = 0
let failed = 0

/** Per-account lists every env in that account shares, fetched once. */
const memo = <T>(load: (key: string) => Promise<T>) => {
    const seen = new Map<string, Promise<T>>()
    return (key: string) => {
        if (!seen.has(key)) seen.set(key, load(key))
        return seen.get(key) as Promise<T>
    }
}
const scriptsIn = memo((acct) =>
    cfAll<{ id: string; tag: string }>(`/accounts/${acct}/workers/scripts`),
)
const zonesIn = memo((acct) =>
    cfAll<{ id: string; name: string }>(`/zones?account.id=${acct}`),
)
/** A repo's wrangler config on its default branch, parsed. Key: repo:path. */
const wranglerAt = memo(async (key) => {
    const [repo, path] = key.split(':')
    const text = await gh([
        'api',
        `repos/${repo}/contents/${path}`,
        '-H',
        'Accept: application/vnd.github.raw',
    ])
    return path.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)
})

/** The env's Worker and zones, and the ids its policies reference them by. */
async function lookups(repo: string, acct: string, env: EnvConfig) {
    const zones = await zonesIn(acct)
    const wrangler =
        env.worker && env.zones
            ? undefined
            : await wranglerAt(`${repo}:${env.wrangler ?? 'wrangler.jsonc'}`)
    const t = resolveTarget(
        env,
        wrangler,
        zones.map((z) => z.name),
    )
    const script = (await scriptsIn(acct)).find((s) => s.id === t.worker)
    if (!script) {
        // Per-Worker grants apply only to Workers that exist; creating one
        // needs product-level Workers Admin, which no deploy token gets.
        throw new Error(
            `Worker "${t.worker}" does not exist in account ${acct} yet: deploy it once with an admin token, then re-run`,
        )
    }
    const zoneIds: Record<string, string> = {}
    for (const name of t.zones) {
        const zone = zones.find((z) => z.name === name)
        if (!zone) throw new Error(`zone ${name} not found in account ${acct}`)
        zoneIds[name] = zone.id
    }
    return { target: t, ids: { scriptTag: script.tag, zoneIds } }
}

/** `gh` flags for where an env's secret and variable live. */
const scope = (repo: string, env: EnvConfig) =>
    env.secret === 'repo' ? ['-R', repo] : ['--env', env.env, '-R', repo]

const scopeLabel = (repo: string, env: EnvConfig) =>
    env.secret === 'repo' ? `${repo} (repo-wide)` : `${repo} env ${env.env}`

async function setSecret(repo: string, env: EnvConfig, value: string) {
    await gh(['secret', 'set', 'CLOUDFLARE_API_TOKEN', ...scope(repo, env)], value)
}

/** Mirror the config's fallback into the variable the deploy action reads. */
async function syncFallbackVar(repo: string, env: EnvConfig) {
    if (env.fallback) {
        const body = `${env.fallback.reason} (since ${env.fallback.since})`
        await gh([
            'variable',
            'set',
            'CF_TOKEN_FALLBACK',
            ...scope(repo, env),
            '--body',
            body,
        ])
    } else {
        // Not set is the normal case: nothing to delete.
        await gh(['variable', 'delete', 'CF_TOKEN_FALLBACK', ...scope(repo, env)]).catch(
            () => {},
        )
    }
}

/**
 * Mint a token and put its value in the env's secret. If the secret can't be
 * set, delete the new token again, so a token with this name only outlives
 * the call once GitHub holds it.
 */
async function createAndSet(
    repo: string,
    acct: string,
    env: EnvConfig,
    name: string,
    want: Policy[],
) {
    const t = await cf<Token & { value: string }>(
        'POST',
        `/accounts/${acct}/tokens`,
        { name, policies: want, expires_on: expiresOn(now) },
    )
    try {
        await setSecret(repo, env, t.value)
    } catch (e) {
        await cf('DELETE', `/accounts/${acct}/tokens/${t.id}`).catch(
            (d: Error) =>
                console.error(
                    `  x could not delete ${t.id} after the failed secret write; the next run rotates it away: ${d.message}`,
                ),
        )
        throw e
    }
    return t
}

async function act(
    repo: string,
    acct: string,
    env: EnvConfig,
    name: string,
    want: Policy[],
    a: Action,
) {
    const label = `${env.env} "${name}"`
    if (a.kind === 'ok') {
        const used = a.token.last_used_on ?? 'never'
        console.log(`  ok ${label}, expires ${a.token.expires_on}, last used ${used}`)
        return
    }
    pending++
    const sign = { create: '+', update: '~', rotate: '@' }[a.kind]
    console.log(`${sign} ${a.kind} ${label}: ${a.reason}`)
    if (!values.apply) return
    const path = `/accounts/${acct}/tokens`
    switch (a.kind) {
        case 'create': {
            const t = await createAndSet(repo, acct, env, name, want)
            console.log(`  created ${t.id}, secret set in ${scopeLabel(repo, env)}`)
            return
        }
        case 'update':
            await cf('PUT', `${path}/${a.token.id}`, {
                name,
                policies: want,
                expires_on: a.token.expires_on,
                status: 'active',
            })
            console.log('  updated (value unchanged)')
            return
        case 'rotate': {
            // New token, then the secret, then delete the old ones, so a
            // deploy in between still has a working token. A stop before the
            // deletes leaves duplicates, which the next plan rotates away.
            const t = await createAndSet(repo, acct, env, name, want)
            for (const old of a.tokens) await cf('DELETE', `${path}/${old.id}`)
            const ids = a.tokens.map((o) => o.id).join(', ')
            console.log(`  rotated ${ids} to ${t.id}, secret set`)
            return
        }
    }
}

async function run(
    repo: string,
    cfg: RepoConfig,
    env: EnvConfig,
    tokens: Map<string, Token[]>,
) {
    const acct = envAccount(cfg, env)
    const name = tokenName(repo, env.env)
    const { target, ids } = await lookups(repo, acct, env)
    const want = policies(cfg, env, ids, target.zones)
    const zones = target.zones.length ? target.zones.join(', ') : 'no zones'
    console.log(`  ${env.env}: Worker ${target.worker}, ${zones}, secret in ${scopeLabel(repo, env)}`)
    // The list endpoint omits policies; fetch each match in full.
    const have = await Promise.all(
        (tokens.get(acct) ?? [])
            .filter((t) => t.name === name)
            .map((t) => cf<Token>('GET', `/accounts/${acct}/tokens/${t.id}`)),
    )
    if (env.fallback) {
        console.log(
            `  ! ${env.env}: FALLBACK account-wide Workers Scripts Write: ${env.fallback.reason} (since ${env.fallback.since})`,
        )
    }
    for (const a of plan(want, have, now, { rotate: values.rotate })) {
        await act(repo, acct, env, name, want, a)
    }
    if (values.apply) await syncFallbackVar(repo, env)
}

// ---- --try ------------------------------------------------------------------

/**
 * Run a command (a deploy, say) with a throwaway token that has exactly the
 * env's policies, to prove they are enough before CI depends on them. The
 * real token's value only exists in GitHub, so a local deploy can't use it,
 * and a shell holding a wider token would hide a missing grant. The child gets
 * the throwaway token as CLOUDFLARE_API_TOKEN, with CF_TOKEN_ADMIN removed,
 * runs in the directory `just` was run from, and the token is deleted after
 * (it expires within the hour regardless).
 */
async function tryEnv(envName: string, cmd: string[]) {
    if (repos.length !== 1 || cmd.length === 0) {
        console.error('--try needs one --repo, an env, and a command after --')
        process.exit(2)
    }
    const [repo] = repos
    const cfg = REPOS[repo]
    const env = cfg.envs.find((e) => e.env === envName)
    if (!env) {
        console.error(`${repo} has no env ${envName}`)
        process.exit(2)
    }
    const acct = envAccount(cfg, env)
    const { target, ids } = await lookups(repo, acct, env)
    const expires = new Date(now.getTime() + 3_600_000)
    const t = await cf<Token & { value: string }>('POST', `/accounts/${acct}/tokens`, {
        name: `${tokenName(repo, env.env)}:try`,
        policies: policies(cfg, env, ids, target.zones),
        expires_on: `${expires.toISOString().slice(0, 19)}Z`,
    })
    const zones = target.zones.length ? target.zones.join(', ') : 'no zones'
    console.log(`try ${t.id}: Worker ${target.worker}, ${zones}, until ${expires.toISOString()}`)
    let code = 1
    try {
        const childEnv: Record<string, string | undefined> = {
            ...process.env,
            CLOUDFLARE_API_TOKEN: t.value,
            CLOUDFLARE_ACCOUNT_ID: acct,
        }
        delete childEnv.CF_TOKEN_ADMIN
        const proc = Bun.spawn(cmd, {
            cwd: process.env.VOIDFLOW_CONFIG_BASE || process.cwd(),
            env: childEnv,
            stdio: ['inherit', 'inherit', 'inherit'],
        })
        code = await proc.exited
    } finally {
        await cf('DELETE', `/accounts/${acct}/tokens/${t.id}`)
        console.log(`try ${t.id} deleted; the command exited ${code}`)
    }
    process.exit(code)
}

if (values.try !== undefined) await tryEnv(values.try, positionals)

for (const repo of repos) {
    const cfg = REPOS[repo]
    console.log(`\n== ${repo}`)
    const tokens = new Map<string, Token[]>()
    for (const acct of repoAccounts(cfg)) {
        tokens.set(acct, await cfAll<Token>(`/accounts/${acct}/tokens`))
    }
    let envsOk = true
    for (const env of cfg.envs) {
        try {
            await run(repo, cfg, env, tokens)
        } catch (e) {
            envsOk = false
            failed++
            console.error(`  x ${env.env}: ${(e as Error).message}`)
        }
    }
    // Retire old tokens (and a shadowed repo secret) only once every env, in
    // every account, has its replacement.
    const note = !values.prune
        ? ' (needs --prune)'
        : envsOk
          ? ''
          : ' (skipped: an env failed above)'
    const prune = values.apply && values.prune && envsOk
    const old = retireTargets(cfg).flatMap(({ account, name }) =>
        (tokens.get(account) ?? [])
            .filter((t) => t.name === name)
            .map((t) => ({ account, t })),
    )
    for (const { account, t } of old) {
        pending++
        console.log(`- retire "${t.name}" (${t.id})${note}`)
        if (prune) {
            await cf('DELETE', `/accounts/${account}/tokens/${t.id}`)
            console.log('  deleted')
        }
    }
    // With every env's secret in an environment, a repo-wide one is a
    // pre-voidflow leftover: environment jobs never read it, and any job
    // without an environment that still does is deploying with an old token.
    if (!cfg.envs.some((e) => e.secret === 'repo')) {
        const repoSecrets = await gh(['secret', 'list', '-R', repo, '--json', 'name', '-q', '.[].name'])
        if (repoSecrets.split('\n').includes('CLOUDFLARE_API_TOKEN')) {
            pending++
            console.log(
                `- repo-wide secret CLOUDFLARE_API_TOKEN: every env's is in an environment; jobs without one still read this${note}`,
            )
            if (prune) {
                await gh(['secret', 'delete', 'CLOUDFLARE_API_TOKEN', '-R', repo])
                console.log('  deleted')
            }
        }
    }
}

const summary =
    pending === 0
        ? 'in sync'
        : `${pending} change(s) ${values.apply ? 'applied' : 'pending (re-run with --apply)'}`
console.log(`\n${summary}${failed ? `, ${failed} env(s) failed` : ''}`)
if (failed > 0 || (values.check && pending > 0)) process.exit(1)
