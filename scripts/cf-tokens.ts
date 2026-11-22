/**
 * Plan, apply or rotate scoped Cloudflare deploy tokens, for one repo from
 * the `cloudflare` section of its voidflow.config.ts (--repo-config <file>,
 * what `voidflow plan|check|apply tokens` passes inside a repo), or for the
 * fleet in a --config module (the org's infra repo), shaped as in
 * cloudflare/tokens.ts. Fleet invocations take --config, e.g.
 * ../infra/cf-tokens.ts:
 *
 *   voidflow tokens cf                          # plan (read-only), every repo
 *   voidflow tokens cf --repo example_project          # plan one repo
 *   voidflow tokens cf --check                  # plan, exit 1 on drift or a token due to rotate
 *   voidflow tokens cf --apply                  # create/update/rotate, set the GitHub env secrets
 *   voidflow tokens cf --apply --rotate         # ...and rotate every token now
 *   voidflow tokens cf --apply --prune          # ...and delete the repo's `retire` tokens
 *   voidflow tokens cf --groups                 # live names of the permission group ids used
 *   voidflow tokens cf --repo example_project --try prod -- bunx wrangler deploy
 *                                               # run a command with a throwaway token scoped like prod's
 *
 * The module exports `REPOS` (or a default); see scripts/lib/config.ts.
 *
 * Needs an admin token: in the variable the repo's `cloudflare.adminTokenEnv`
 * names (default CF_TOKEN_ADMIN) with --repo-config, else CF_TOKEN_ADMIN
 * covering every account in the fleet config (envs can sit in different
 * accounts). It needs Account API Tokens Edit, Workers Scripts Read (Worker
 * tags; Workers Metadata Read-Only in the dashboard) and Zone Read (zone ids)
 * on each. Without a read permission Cloudflare lists nothing rather than
 * refusing, so the errors for a missing Worker or zone say so. Keep it local;
 * never put it in CI.
 *
 * GitHub goes through the `gh` CLI, with admin on the repos: even a plan reads
 * each repo's wrangler config (for envs that don't spell out worker and zones)
 * and its repo-wide secret names. New token values are piped straight into
 * `gh secret set` and never printed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
    type Action,
    checkRepos,
    D1_WRITE,
    type EnvConfig,
    envAccount,
    expiresOn,
    fromWrangler,
    missingWorkerMessage,
    missingZoneMessage,
    type Policy,
    plan,
    policies,
    type RepoConfig,
    repoAccounts,
    resolveTarget,
    retireTargets,
    sameToken,
    type Token,
    tokenName,
    WORKER_EDITOR,
    WORKERS_ROUTES_WRITE,
    WORKERS_SCRIPTS_WRITE,
    type WranglerTarget,
    wranglerWarnings,
} from '../cloudflare/tokens.ts'
import {
    adminTokenVar,
    DEFAULT_ADMIN_TOKEN_ENV,
    toTokenRepos,
} from '../config/index.ts'
import { parseOrExit } from './lib/args.ts'
import { loadOrExit } from './lib/config.ts'
import { capture, inherit } from './lib/proc.ts'
import { loadVoidflowConfig, repoSlug } from './lib/repo-config.ts'

const OPTIONS = {
    apply: { type: 'boolean', default: false },
    rotate: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    groups: { type: 'boolean', default: false },
    try: { type: 'string' },
    repo: { type: 'string' },
    config: { type: 'string' },
    'repo-config': { type: 'string' },
} as const

const usage = (prog: string) => `usage: ${prog} --config <module> [flags]
       ${prog} --repo-config <file> [flags]
       ${prog} --config <module> --repo <name> --try <env> -- <command...>
       ${prog} --repo-config <file> --try <env> -- <command...>

  --config <module>  the fleet map: a module exporting REPOS (or a default)
  --repo-config <file>  a voidflow.config.ts: manage the repo it sits in,
                     from its cloudflare section (takes no --repo)
  --repo <name>      only this repo (owner/name, or just name)
  --check            exit 1 on drift or a token due to rotate
  --apply            create, update and rotate tokens; set each env's secret
  --rotate           with --apply, rotate every token now
  --prune            with --apply, also delete retire tokens and a leftover
                     repo-wide secret
  --groups           print the live names of the permission group ids used
  --try <env>        run the command after -- with a throwaway token scoped
                     like the env's

Needs the admin token (cloudflare.adminTokenEnv with --repo-config, default
CF_TOKEN_ADMIN) and gh with admin on the repos.`

/**
 * The environment for a --try command: `env` without CF_TOKEN_ADMIN or its
 * validated admin variable, with the throwaway token and its account.
 */
export function tryChildEnv(
    env: Record<string, string | undefined>,
    adminVar: string,
    value: string,
    account: string,
): Record<string, string | undefined> {
    const out = { ...env }
    delete out.CF_TOKEN_ADMIN
    delete out[adminVar]
    return {
        ...out,
        // The value is the throwaway --try token, created at run time and
        // deleted after the command; nothing is hard-coded here.
        // nosemgrep
        CLOUDFLARE_API_TOKEN: value,
        CLOUDFLARE_ACCOUNT_ID: account,
    }
}

/** `prog` names the command in the --help usage. */
export async function main(argv: string[], prog = 'voidflow tokens cf') {
    const { values, positionals } = parseOrExit(
        argv,
        { options: OPTIONS, allowPositionals: true },
        usage(prog),
    )

    const repoConfig = values['repo-config']
    if (repoConfig !== undefined && values.config !== undefined) {
        console.error(`${prog}: --repo-config and --config are alternatives`)
        process.exit(2)
    }
    if (repoConfig !== undefined && values.repo !== undefined) {
        console.error(
            `${prog}: --repo does not apply to a per-repo config; it manages the repo it sits in`,
        )
        process.exit(2)
    }

    let REPOS: Record<string, RepoConfig>
    let adminVar = DEFAULT_ADMIN_TOKEN_ENV
    /** The checkout the per-repo config sits in; the fleet has none. */
    let localRoot: string | undefined
    if (repoConfig === undefined) {
        REPOS = await loadOrExit(values.config, checkRepos)
    } else {
        try {
            const repoConfigPath = resolve(
                process.env.VOIDFLOW_CONFIG_BASE || process.cwd(),
                repoConfig,
            )
            localRoot = dirname(repoConfigPath)
            const cfg = await loadVoidflowConfig(repoConfigPath)
            REPOS = toTokenRepos(
                cfg,
                await repoSlug(process.env, dirname(repoConfigPath)),
            )
            if (cfg.cloudflare) adminVar = adminTokenVar(cfg.cloudflare)
        } catch (e) {
            console.error(`${prog}: ${(e as Error).message}`)
            process.exit(2)
        }
    }

    const ADMIN = process.env[adminVar]
    if (!ADMIN) {
        console.error(
            `${adminVar} is not set (see CONTRIBUTING.md, Cloudflare deploy tokens as code)`,
        )
        process.exit(2)
    }

    const API = 'https://api.cloudflare.com/client/v4'

    async function cfRaw<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<{
        result: T
        result_info?: { total_pages?: number; total_count?: number }
    }> {
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${ADMIN}`,
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        const json = (await res.json().catch(() => undefined)) as
            | {
                  success: boolean
                  errors?: Array<{ code: number; message: string }>
                  result: T
                  result_info?: { total_pages?: number; total_count?: number }
              }
            | undefined
        if (!json?.success) {
            const why = (json?.errors ?? []).map(
                (e) => `${e.code} ${e.message}`,
            )
            if (!json) why.push('response was not JSON')
            const hint =
                res.status === 401
                    ? ` (${adminVar} is invalid or expired)`
                    : res.status === 403
                      ? ` (${adminVar} lacks permission for this call; it needs account API token edit rights, see CONTRIBUTING.md)`
                      : ''
            throw new Error(
                `${method} ${path}: ${res.status} ${why.join('; ')}${hint}`,
            )
        }
        return json
    }

    async function cf<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
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
        const { code, out, err } = await capture(['gh', ...args], stdin)
        if (code !== 0) throw new Error(`gh ${args.join(' ')}: ${err || out}`)
        return out
    }

    // ---- --groups ---------------------------------------------------------------

    if (values.groups) {
        const accounts = [
            ...new Set(Object.values(REPOS).flatMap(repoAccounts)),
        ]
        const used = new Map<string, string[]>()
        const note = (id: string, where: string) =>
            used.set(id, [...(used.get(id) ?? []), where])
        for (const id of WORKER_EDITOR) note(id, 'WORKER_EDITOR')
        note(WORKERS_ROUTES_WRITE, 'WORKERS_ROUTES_WRITE')
        note(D1_WRITE, 'D1_WRITE')
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
        (r) =>
            !values.repo || r === values.repo || r.endsWith(`/${values.repo}`),
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
    const parseWrangler = (path: string, text: string): unknown =>
        path.endsWith('.toml') ? Bun.TOML.parse(text) : Bun.JSONC.parse(text)
    /** A repo's wrangler config on its default branch, parsed. Key: repo:path. */
    const wranglerAt = memo(async (key) => {
        const [repo, path] = key.split(':')
        let text: string
        try {
            text = await gh([
                'api',
                `repos/${repo}/contents/${path}`,
                '-H',
                'Accept: application/vnd.github.raw',
            ])
        } catch (e) {
            const local = localRoot && join(localRoot, path)
            if (
                local &&
                existsSync(local) &&
                /HTTP 404|Not Found/i.test((e as Error).message)
            ) {
                throw new Error(
                    `${path} is not on ${repo}'s default branch, only in this checkout; the plan reads the default branch's. Merge it first, or set worker and zones on the env in voidflow.config.ts`,
                )
            }
            throw e
        }
        return parseWrangler(path, text)
    })
    /** The same file in this checkout, with --repo-config; undefined if absent. */
    function localWrangler(path: string): unknown {
        const file = localRoot && join(localRoot, path)
        if (!file || !existsSync(file)) return undefined
        return parseWrangler(path, readFileSync(file, 'utf8'))
    }

    /**
     * The env's Worker and zones, the ids its policies reference them by, and
     * where the Worker and zones came from.
     */
    async function lookups(repo: string, acct: string, env: EnvConfig) {
        const zones = await zonesIn(acct)
        const zoneNames = zones.map((z) => z.name)
        const file = env.wrangler ?? 'wrangler.jsonc'
        const wrangler =
            env.worker && env.zones
                ? undefined
                : await wranglerAt(`${repo}:${file}`)
        let t: ReturnType<typeof resolveTarget>
        try {
            t = resolveTarget(env, wrangler, zoneNames)
        } catch (e) {
            // An env block only in this checkout: say so, rather than the bare error.
            if (
                wrangler !== undefined &&
                /has no env\./.test((e as Error).message)
            ) {
                let inLocal = false
                try {
                    const lp = localWrangler(file)
                    if (lp !== undefined) {
                        fromWrangler(lp, env.env, env.wranglerEnv)
                        inLocal = true
                    }
                } catch {}
                if (inLocal)
                    throw new Error(
                        `${env.env}: ${(e as Error).message} on ${file}'s default branch, but the local ${file} has it; the plan reads the default branch's. Merge it first, or set worker and zones on the env in voidflow.config.ts`,
                    )
            }
            throw e
        }
        // null: an explicit worker with no wrangler env named, so unknown
        let block: string | null | undefined =
            wrangler === undefined && env.wranglerEnv === undefined
                ? null
                : env.wranglerEnv
        let source = 'worker and zones from the config'
        if (wrangler !== undefined) {
            source = `${file} on the default branch`
            const used = fromWrangler(wrangler, env.env, env.wranglerEnv)
            block = used.block
            let local: WranglerTarget | Error | undefined
            try {
                const parsed = localWrangler(file)
                if (parsed !== undefined)
                    local = fromWrangler(parsed, env.env, env.wranglerEnv)
            } catch (e) {
                local = e as Error
            }
            for (const w of wranglerWarnings({
                env: env.env,
                account: acct,
                file,
                used,
                local,
            }))
                console.log(`  ! ${w}`)
        }
        const scripts = await scriptsIn(acct)
        const script = scripts.find((s) => s.id === t.worker)
        if (!script) {
            // Per-Worker grants apply only to Workers that exist; creating one
            // needs product-level Workers Admin, which no deploy token gets.
            throw new Error(
                missingWorkerMessage(t.worker, acct, scripts.length, block),
            )
        }
        const zoneIds: Record<string, string> = {}
        for (const name of t.zones) {
            const zone = zones.find((z) => z.name === name)
            if (!zone)
                throw new Error(missingZoneMessage(name, acct, zoneNames))
            zoneIds[name] = zone.id
        }
        return { target: t, ids: { scriptTag: script.tag, zoneIds }, source }
    }

    /** `gh` flags for where an env's secret and variable live. */
    const scope = (repo: string, env: EnvConfig) =>
        env.secret === 'repo' ? ['-R', repo] : ['--env', env.env, '-R', repo]

    const scopeLabel = (repo: string, env: EnvConfig) =>
        env.secret === 'repo' ? `${repo} (repo-wide)` : `${repo} env ${env.env}`

    async function setSecret(repo: string, env: EnvConfig, value: string) {
        await gh(
            ['secret', 'set', 'CLOUDFLARE_API_TOKEN', ...scope(repo, env)],
            value,
        )
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
            await gh([
                'variable',
                'delete',
                'CF_TOKEN_FALLBACK',
                ...scope(repo, env),
            ]).catch(() => {})
        }
    }

    /**
     * Whether the env's secret exists in GitHub. A missing environment counts
     * as missing (the apply creates it); any other gh failure throws.
     */
    async function secretExists(repo: string, env: EnvConfig) {
        try {
            const out = await gh([
                'secret',
                'list',
                ...scope(repo, env),
                '--json',
                'name',
                '-q',
                '.[].name',
            ])
            return out.split('\n').includes('CLOUDFLARE_API_TOKEN')
        } catch (e) {
            if (/HTTP 404|Not Found/i.test((e as Error).message)) return false
            throw e
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
            console.log(
                `  ok ${label}, expires ${a.token.expires_on}, last used ${used}`,
            )
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
                console.log(
                    `  created ${t.id}, secret set in ${scopeLabel(repo, env)}`,
                )
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
                for (const old of a.tokens)
                    await cf('DELETE', `${path}/${old.id}`)
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
        const { target, ids, source } = await lookups(repo, acct, env)
        const want = policies(cfg, env, ids, target.zones)
        const zones = target.zones.length ? target.zones.join(', ') : 'no zones'
        console.log(
            `  ${env.env}: Worker ${target.worker}, ${zones}${env.d1 ? ', D1 write (account)' : ''}, secret in ${scopeLabel(repo, env)} (${source})`,
        )
        // The list endpoint omits policies; fetch each match in full.
        const have = await Promise.all(
            (tokens.get(acct) ?? [])
                // A former fleet config may have spelled owner/name with
                // different casing. Treat it as this token, then update it
                // to the canonical lowercase name instead of minting another.
                // Only the repo part is case-folded: env names stay exact.
                .filter((t) => sameToken(t.name, name))
                .map((t) =>
                    cf<Token>('GET', `/accounts/${acct}/tokens/${t.id}`),
                ),
        )
        if (env.fallback) {
            console.log(
                `  ! ${env.env}: FALLBACK account-wide Workers Scripts Write: ${env.fallback.reason} (since ${env.fallback.since})`,
            )
        }
        const secretMissing = !(await secretExists(repo, env))
        if (secretMissing) {
            console.log(
                `  ! ${env.env}: no CLOUDFLARE_API_TOKEN secret in ${scopeLabel(repo, env)}`,
            )
        }
        for (const a of plan(want, have, now, {
            rotate: values.rotate,
            secretMissing,
            name,
        })) {
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
     * the throwaway token as CLOUDFLARE_API_TOKEN, with the admin token removed,
     * runs in the directory `just` was run from, and the token is deleted after
     * (it expires within the hour regardless).
     */
    async function tryEnv(envName: string, cmd: string[]) {
        if (repos.length !== 1 || cmd.length === 0) {
            console.error(
                '--try needs one configured repo, an env, and a command after --',
            )
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
        const t = await cf<Token & { value: string }>(
            'POST',
            `/accounts/${acct}/tokens`,
            {
                name: `${tokenName(repo, env.env)}:try`,
                policies: policies(cfg, env, ids, target.zones),
                expires_on: `${expires.toISOString().slice(0, 19)}Z`,
            },
        )
        const zones = target.zones.length ? target.zones.join(', ') : 'no zones'
        console.log(
            `try ${t.id}: Worker ${target.worker}, ${zones}${env.d1 ? ', D1 write (account)' : ''}, until ${expires.toISOString()}`,
        )
        let code = 1
        try {
            code = await inherit(cmd, {
                cwd: process.env.VOIDFLOW_CONFIG_BASE || process.cwd(),
                env: tryChildEnv(process.env, adminVar, t.value, acct),
            })
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
        try {
            for (const acct of repoAccounts(cfg)) {
                tokens.set(acct, await cfAll<Token>(`/accounts/${acct}/tokens`))
            }
        } catch (e) {
            failed++
            console.error(`  x listing tokens: ${(e as Error).message}`)
            continue
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
            const repoSecrets = await gh([
                'secret',
                'list',
                '-R',
                repo,
                '--json',
                'name',
                '-q',
                '.[].name',
            ])
            if (repoSecrets.split('\n').includes('CLOUDFLARE_API_TOKEN')) {
                pending++
                console.log(
                    `- repo-wide secret CLOUDFLARE_API_TOKEN: every env's is in an environment; jobs without one still read this${note}`,
                )
                if (prune) {
                    await gh([
                        'secret',
                        'delete',
                        'CLOUDFLARE_API_TOKEN',
                        '-R',
                        repo,
                    ])
                    console.log('  deleted')
                }
            }
        }
    }

    const applyHint = process.env.VOIDFLOW_APPLY_HINT ?? 'voidflow apply'
    const summary =
        pending === 0
            ? 'in sync'
            : `${pending} change(s) ${values.apply ? 'applied' : `pending (${process.env.VOIDFLOW_VIA_VERB ? `run \`${applyHint}\`` : 're-run with --apply'})`}`
    console.log(`\n${summary}${failed ? `, ${failed} env(s) failed` : ''}`)
    if (failed > 0 || (values.check && pending > 0)) process.exit(1)
}
