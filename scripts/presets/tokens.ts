/**
 * `voidflow plan|check|apply tokens` and `voidflow try tokens`: the scoped
 * Cloudflare deploy tokens in the `cloudflare` section of a repo's
 * voidflow.config.ts, shaped as in cloudflare/tokens.ts.
 *
 *   voidflow plan tokens                    # read-only
 *   voidflow check tokens                   # exit 1 on drift or a token due to rotate
 *   voidflow apply tokens                   # create/update/rotate, set the GitHub env secrets
 *   voidflow apply tokens --rotate          # ...and rotate every token now
 *   voidflow apply tokens --prune           # ...and delete the `retire` tokens
 *   voidflow plan tokens --groups           # live names of the permission group ids used
 *   voidflow try tokens prod -- bunx wrangler deploy
 *                                           # run a command with a throwaway token scoped like prod's
 *
 * Needs the admin token in the variable `cloudflare.adminTokenEnv` names
 * (default CF_TOKEN_ADMIN), with Account API Tokens Edit, Workers Scripts
 * Read (Worker tags; Workers Metadata Read-Only in the dashboard) and Zone
 * Read (zone ids) on the account. Without a read permission Cloudflare lists
 * nothing rather than refusing, so the errors for a missing Worker or zone
 * say so. Keep it local; never put it in CI.
 *
 * GitHub goes through the `gh` CLI, with admin on the repo: even a plan reads
 * the repo's wrangler config (for envs that don't spell out worker and zones)
 * and its repo-wide secret names. New token values are piped straight into
 * `gh secret set` and never printed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
    type Action,
    D1_WRITE,
    type EnvConfig,
    EXPIRY_VAR,
    type ExpiryRecord,
    envAccount,
    expiresOn,
    expiryStatus,
    fromWrangler,
    missingWorkerMessage,
    missingZoneMessage,
    nextExpiryRecord,
    type Policy,
    parseExpiryRecord,
    plan,
    policies,
    type RepoConfig,
    renderExpiryRecord,
    repoAccounts,
    resolveTarget,
    retireTargets,
    sameToken,
    type Token,
    tokenName,
    UNMERGED_WRANGLER_HINT,
    WORKER_EDITOR,
    WORKERS_ROUTES_WRITE,
    WORKERS_SCRIPTS_WRITE,
    type WranglerTarget,
    wranglerWarnings,
} from '../../cloudflare/tokens.ts'
import { adminTokenVar, toTokenRepos } from '../../config/index.ts'
import { capture, inherit } from '../lib/proc.ts'
import { parseWranglerConfig } from '../lib/wrangler-config.ts'
import type { PresetCtx } from './context.ts'

/** What `voidflow try tokens` and `plan tokens --groups` ask for instead of a plan. */
export type TokensMode =
    | { kind: 'sync' }
    | { kind: 'groups' }
    | { kind: 'try'; env: string; cmd: string[] }
    /** No admin token: check the expiry `apply` recorded in EXPIRY_VAR. */
    | { kind: 'expiry' }

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

/**
 * Plan, check or apply the repo's tokens, list their permission groups, or
 * run a command with a throwaway one; returns the exit code (for a try, the
 * command's).
 */
export async function tokens(
    ctx: PresetCtx,
    mode: TokensMode = { kind: 'sync' },
): Promise<number> {
    const cf0 = ctx.cfg.cloudflare
    if (!cf0) {
        console.error(
            `${ctx.file}: no cloudflare section (see docs/config.md#cloudflare-tokens)`,
        )
        return 2
    }
    const REPOS: Record<string, RepoConfig> = toTokenRepos(ctx.cfg, ctx.repo)
    const adminVar = adminTokenVar(cf0)
    /** The checkout the config sits in, for comparing its wrangler files. */
    const localRoot = dirname(ctx.file)
    const apply = ctx.verb === 'apply'
    /** Envs whose wrangler config comes from the checkout, not the default branch. */
    const localEnvs = new Set(ctx.localWrangler)
    const known = new Set(
        Object.values(REPOS).flatMap((c) => c.envs.map((e) => e.env)),
    )
    for (const e of localEnvs) {
        if (!known.has(e)) {
            console.error(
                `--local-wrangler ${e}: no such env in the cloudflare section (${[...known].join(', ')})`,
            )
            return 2
        }
    }

    if (mode.kind === 'expiry') return recordedExpiry()

    const ADMIN = ctx.env[adminVar]
    if (!ADMIN) {
        console.error(
            `${adminVar} is not set (see CONTRIBUTING.md, Cloudflare deploy tokens as code)`,
        )
        return 2
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
                // Cloudflare answers 403 9109 "Invalid access token" for a
                // token that is expired, wrong, account-owned, or used
                // outside its IP filter.
                res.status === 401 ||
                (json?.errors ?? []).some((e) => e.code === 9109)
                    ? ` (${adminVar} is invalid, expired, account-owned rather than user-owned, or its IP filter does not allow this address)`
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

    /**
     * The repo's EXPIRY_VAR as `gh` reads it: undefined when the variable is
     * not set, an Error when it holds something else.
     */
    async function readRecord(
        repo: string,
    ): Promise<ExpiryRecord | Error | undefined> {
        let text: string
        try {
            text = await gh(['variable', 'get', EXPIRY_VAR, '-R', repo])
        } catch (e) {
            if (/not found|HTTP 404/i.test((e as Error).message))
                return undefined
            throw e
        }
        return parseExpiryRecord(text.trim())
    }

    /**
     * `check` without the admin token: each env's token by the expiry `apply`
     * recorded. The drift workflow passes the record in the environment (from
     * the `vars` context, which needs no permission); otherwise `gh` reads it.
     */
    async function recordedExpiry(): Promise<number> {
        const [repo] = Object.keys(REPOS)
        const envs = REPOS[repo].envs.map((e) => e.env)
        const passed = ctx.env[EXPIRY_VAR]
        const recorded = passed
            ? parseExpiryRecord(passed)
            : await readRecord(repo)
        console.log(
            `\n== ${repo} (${adminVar} not set: checking the expiry recorded in ${EXPIRY_VAR})`,
        )
        const rotate = `run \`voidflow apply tokens\` with ${adminVar} (behind \`fnox proxy run --\` when fnox holds it)`
        if (recorded instanceof Error) {
            console.log(`! ${recorded.message}; ${rotate} to record it again`)
            return ctx.verb === 'check' ? 1 : 0
        }
        let due = 0
        for (const s of expiryStatus(envs, recorded ?? {}, new Date())) {
            if (s.kind === 'ok') {
                console.log(`  ok ${s.env}, expires ${s.expires}`)
                continue
            }
            due++
            if (s.kind === 'missing') {
                console.log(
                    `! ${s.env}: no expiry recorded (apply records it, and rotates the token only if it is due)`,
                )
            } else {
                const when =
                    s.left < 0 ? 'expired' : `expires in ${Math.floor(s.left)}d`
                console.log(`@ ${s.env}: ${when} (${s.expires}), rotate it`)
            }
        }
        console.log(
            `\n${due === 0 ? 'no token due to rotate' : `${due} token(s) to rotate or record: ${rotate}`}`,
        )
        return ctx.verb === 'check' && due > 0 ? 1 : 0
    }

    // ---- --groups ---------------------------------------------------------------

    if (mode.kind === 'groups') {
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
        return 0
    }

    // ---- plan / apply -----------------------------------------------------------

    const repos = Object.keys(REPOS)

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
    /**
     * A repo's wrangler config, parsed: on its default branch, or in this
     * checkout for a --local-wrangler env. Key: repo:path:remote|local.
     */
    const wranglerAt = memo(async (key) => {
        const [repo, path, where] = key.split(':')
        if (where === 'local') {
            const parsed = localWrangler(path)
            if (parsed === undefined)
                throw new Error(
                    `${path} is not in this checkout (--local-wrangler reads it from ${localRoot})`,
                )
            return parsed
        }
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
                    `${path} is not on ${repo}'s default branch, only in this checkout; the plan reads the default branch's. ${UNMERGED_WRANGLER_HINT}`,
                )
            }
            throw e
        }
        return parseWranglerConfig(path, text)
    })
    /** The same file in this checkout; undefined if absent. */
    function localWrangler(path: string): unknown {
        const file = localRoot && join(localRoot, path)
        if (!file || !existsSync(file)) return undefined
        return parseWranglerConfig(path, readFileSync(file, 'utf8'))
    }

    /**
     * The env's Worker and zones, the ids its policies reference them by, and
     * where the Worker and zones came from.
     */
    async function lookups(repo: string, acct: string, env: EnvConfig) {
        const zones = await zonesIn(acct)
        const zoneNames = zones.map((z) => z.name)
        const file = env.wrangler ?? 'wrangler.jsonc'
        const fromLocal = localEnvs.has(env.env)
        const wrangler =
            env.worker && env.zones
                ? undefined
                : await wranglerAt(
                      `${repo}:${file}:${fromLocal ? 'local' : 'remote'}`,
                  )
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
                        `${env.env}: ${(e as Error).message} on ${file}'s default branch, but the local ${file} has it; the plan reads the default branch's. ${UNMERGED_WRANGLER_HINT}`,
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
            source = fromLocal
                ? `${file} in this checkout, not the default branch`
                : `${file} on the default branch`
            const used = fromWrangler(wrangler, env.env, env.wranglerEnv)
            block = used.block
            let local: WranglerTarget | Error | undefined
            // With --local-wrangler the plan already reads the local copy.
            if (!fromLocal) {
                try {
                    const parsed = localWrangler(file)
                    if (parsed !== undefined)
                        local = fromWrangler(parsed, env.env, env.wranglerEnv)
                } catch (e) {
                    local = e as Error
                }
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
    ): Promise<string | undefined> {
        const label = `${env.env} "${name}"`
        if (a.kind === 'ok') {
            const used = a.token.last_used_on ?? 'never'
            console.log(
                `  ok ${label}, expires ${a.token.expires_on}, last used ${used}`,
            )
            return a.token.expires_on ?? undefined
        }
        pending++
        const sign = { create: '+', update: '~', rotate: '@' }[a.kind]
        console.log(`${sign} ${a.kind} ${label}: ${a.reason}`)
        if (!apply)
            return a.kind === 'update'
                ? (a.token.expires_on ?? undefined)
                : undefined
        const path = `/accounts/${acct}/tokens`
        switch (a.kind) {
            case 'create': {
                const t = await createAndSet(repo, acct, env, name, want)
                console.log(
                    `  created ${t.id}, secret set in ${scopeLabel(repo, env)}`,
                )
                return t.expires_on ?? expiresOn(now)
            }
            case 'update':
                await cf('PUT', `${path}/${a.token.id}`, {
                    name,
                    policies: want,
                    expires_on: a.token.expires_on,
                    status: 'active',
                })
                console.log('  updated (value unchanged)')
                return a.token.expires_on ?? undefined
            case 'rotate': {
                // New token, then the secret, then delete the old ones, so a
                // deploy in between still has a working token. A stop before the
                // deletes leaves duplicates, which the next plan rotates away.
                const t = await createAndSet(repo, acct, env, name, want)
                for (const old of a.tokens)
                    await cf('DELETE', `${path}/${old.id}`)
                const ids = a.tokens.map((o) => o.id).join(', ')
                console.log(`  rotated ${ids} to ${t.id}, secret set`)
                return t.expires_on ?? expiresOn(now)
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
                // An older config may have spelled owner/name with
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
        let expires: string | undefined
        for (const a of plan(want, have, now, {
            rotate: ctx.rotate,
            secretMissing,
            name,
        })) {
            expires = await act(repo, acct, env, name, want, a)
        }
        if (apply) await syncFallbackVar(repo, env)
        return expires
    }

    /**
     * Keep EXPIRY_VAR in step with the expiries this run knows (`known`): a
     * pending change under plan or check, written under apply.
     */
    async function syncExpiryRecord(
        repo: string,
        cfg: RepoConfig,
        known: Map<string, string>,
    ) {
        const read = await readRecord(repo)
        const recorded = read instanceof Error || !read ? {} : read
        const next = nextExpiryRecord(
            cfg.envs.map((e) => e.env),
            recorded,
            known,
        )
        const text = renderExpiryRecord(next)
        if (text === renderExpiryRecord(recorded) && !(read instanceof Error))
            return
        pending++
        const why =
            read instanceof Error
                ? read.message
                : read === undefined
                  ? 'not set'
                  : 'out of date'
        console.log(
            `~ record token expiry in the ${EXPIRY_VAR} variable (${why}), for checks without ${adminVar}`,
        )
        if (!apply) return
        await gh(['variable', 'set', EXPIRY_VAR, '-R', repo, '--body', text])
        console.log('  recorded')
    }

    // ---- --try ------------------------------------------------------------------

    /**
     * Run a command (a deploy, say) with a throwaway token that has exactly the
     * env's policies, to prove they are enough before CI depends on them. The
     * real token's value only exists in GitHub, so a local deploy can't use it,
     * and a shell holding a wider token would hide a missing grant. The child gets
     * the throwaway token as CLOUDFLARE_API_TOKEN, with the admin token removed,
     * runs in the current directory, and the token is deleted after (it
     * expires within the hour regardless).
     */
    async function tryEnv(envName: string, cmd: string[]): Promise<number> {
        if (cmd.length === 0) {
            console.error('try needs a command after --')
            return 2
        }
        const [repo] = repos
        const cfg = REPOS[repo]
        const env = cfg.envs.find((e) => e.env === envName)
        if (!env) {
            console.error(
                `no env ${envName} in the cloudflare section (envs: ${cfg.envs.map((e) => e.env).join(', ')})`,
            )
            return 2
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
                cwd: process.cwd(),
                env: tryChildEnv(ctx.env, adminVar, t.value, acct),
            })
        } finally {
            await cf('DELETE', `/accounts/${acct}/tokens/${t.id}`)
            console.log(`try ${t.id} deleted; the command exited ${code}`)
        }
        return code
    }

    if (mode.kind === 'try') return tryEnv(mode.env, mode.cmd)

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
        const known = new Map<string, string>()
        for (const env of cfg.envs) {
            try {
                const expires = await run(repo, cfg, env, tokens)
                if (expires) known.set(env.env, expires)
            } catch (e) {
                envsOk = false
                failed++
                console.error(`  x ${env.env}: ${(e as Error).message}`)
            }
        }
        try {
            await syncExpiryRecord(repo, cfg, known)
        } catch (e) {
            failed++
            console.error(`  x ${EXPIRY_VAR}: ${(e as Error).message}`)
        }
        // Retire old tokens (and a shadowed repo secret) only once every env, in
        // every account, has its replacement.
        const note = !ctx.prune
            ? ' (needs --prune)'
            : envsOk
              ? ''
              : ' (skipped: an env failed above)'
        const prune = apply && ctx.prune && envsOk
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

    const summary =
        pending === 0
            ? 'in sync'
            : `${pending} change(s) ${apply ? 'applied' : `pending (${ctx.applyHint})`}`
    console.log(`\n${summary}${failed ? `, ${failed} env(s) failed` : ''}`)
    // A read that failed is "could not tell" (2) when planning or checking,
    // so it never reads as drift; a failed write is 1.
    if (failed > 0) return apply ? 1 : 2
    return ctx.verb === 'check' && pending > 0 ? 1 : 0
}
