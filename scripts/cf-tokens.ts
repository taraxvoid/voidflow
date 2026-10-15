#!/usr/bin/env bun
/**
 * Plan, apply or rotate the scoped Cloudflare deploy tokens described in
 * cloudflare/tokens.ts.
 *
 *   bun scripts/cf-tokens.ts                    # plan (read-only), every repo
 *   bun scripts/cf-tokens.ts --repo transbot    # plan one repo
 *   bun scripts/cf-tokens.ts --check            # plan, exit 1 on drift or a token due to rotate
 *   bun scripts/cf-tokens.ts --apply            # create/update/rotate, set the GitHub env secrets
 *   bun scripts/cf-tokens.ts --apply --rotate   # ...and rotate every token now
 *   bun scripts/cf-tokens.ts --apply --prune    # ...and delete the repo's `retire` tokens
 *   bun scripts/cf-tokens.ts --groups           # live names of the permission group ids used
 *
 * Needs CF_TOKEN_ADMIN: a user-owned token covering every account in the
 * config (envs can sit in different accounts, e.g. dev/staging apart from
 * prod), with Account API Tokens Edit, Workers Scripts Read (Worker tags) and
 * Zone Read (zone ids) on each. Keep it local; never put it in CI. GitHub writes go through the `gh` CLI. New token values are piped
 * straight into `gh secret set` and never printed.
 */
import { parseArgs } from 'node:util'
import {
    REPOS,
    WORKERS_ROUTES_WRITE,
    WORKERS_SCRIPTS_WRITE,
    WORKER_EDITOR,
    envAccount,
    expiresOn,
    plan,
    policies,
    repoAccounts,
    retireTargets,
    tokenName,
    type Action,
    type EnvConfig,
    type Policy,
    type RepoConfig,
    type Token,
} from '../cloudflare/tokens.ts'

const { values } = parseArgs({
    options: {
        apply: { type: 'boolean', default: false },
        rotate: { type: 'boolean', default: false },
        prune: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        groups: { type: 'boolean', default: false },
        repo: { type: 'string' },
    },
})

const ADMIN = process.env.CF_TOKEN_ADMIN
if (!ADMIN) {
    console.error('CF_TOKEN_ADMIN is not set (see the header of this script)')
    process.exit(2)
}

const API = 'https://api.cloudflare.com/client/v4'

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    }
    if (!json.success) {
        const why = (json.errors ?? []).map((e) => `${e.code} ${e.message}`)
        throw new Error(`${method} ${path}: ${res.status} ${why.join('; ')}`)
    }
    return json.result
}

/** Every page of a list endpoint. */
async function cfAll<T>(path: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; ; page++) {
        const sep = path.includes('?') ? '&' : '?'
        const batch = await cf<T[]>(
            'GET',
            `${path}${sep}per_page=50&page=${page}`,
        )
        out.push(...batch)
        if (batch.length < 50) return out
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

async function lookups(acct: string, env: EnvConfig) {
    const scripts = await cfAll<{ id: string; tag: string }>(
        `/accounts/${acct}/workers/scripts`,
    )
    const script = scripts.find((s) => s.id === env.worker)
    if (!script) {
        // Per-Worker grants apply only to Workers that exist; creating one
        // needs product-level Workers Admin, which no deploy token gets.
        throw new Error(
            `Worker "${env.worker}" does not exist in account ${acct} yet: deploy it once with an admin token, then re-run`,
        )
    }
    const zoneIds: Record<string, string> = {}
    for (const name of env.zones) {
        const [zone] = await cf<Array<{ id: string }>>(
            'GET',
            `/zones?name=${encodeURIComponent(name)}&account.id=${acct}`,
        )
        if (!zone) {
            throw new Error(`zone ${name} not found in account ${acct}`)
        }
        zoneIds[name] = zone.id
    }
    return { scriptTag: script.tag, zoneIds }
}

async function setSecret(repo: string, env: string, value: string) {
    await gh(
        ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--env', env, '-R', repo],
        value,
    )
}

/** Mirror the config's fallback into the env variable the deploy action reads. */
async function syncFallbackVar(repo: string, env: EnvConfig) {
    const where = ['--env', env.env, '-R', repo]
    if (env.fallback) {
        const body = `${env.fallback.reason} (since ${env.fallback.since})`
        await gh(['variable', 'set', 'CF_TOKEN_FALLBACK', ...where, '--body', body])
    } else {
        // Not set is the normal case: nothing to delete.
        await gh(['variable', 'delete', 'CF_TOKEN_FALLBACK', ...where]).catch(
            () => {},
        )
    }
}

function create(acct: string, name: string, want: Policy[]) {
    return cf<Token & { value: string }>(
        'POST',
        `/accounts/${acct}/tokens`,
        { name, policies: want, expires_on: expiresOn(now) },
    )
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
        console.log(`  ok ${label}, expires ${a.token.expires_on}`)
        return
    }
    pending++
    const sign = { create: '+', update: '~', rotate: '@', delete: '-' }[a.kind]
    console.log(`${sign} ${a.kind} ${label}: ${a.reason}`)
    if (!values.apply) return
    const path = `/accounts/${acct}/tokens`
    switch (a.kind) {
        case 'create': {
            const t = await create(acct, name, want)
            await setSecret(repo, env.env, t.value)
            console.log(`  created ${t.id}, secret set in ${repo} env ${env.env}`)
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
            // New token, then the secret, then delete the old token, so a
            // deploy in between still has a working token.
            const t = await create(acct, name, want)
            await setSecret(repo, env.env, t.value)
            await cf('DELETE', `${path}/${a.token.id}`)
            console.log(`  rotated ${a.token.id} to ${t.id}, secret set`)
            return
        }
        case 'delete':
            await cf('DELETE', `${path}/${a.token.id}`)
            console.log('  deleted')
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
    const want = policies(cfg, env, await lookups(acct, env))
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
    // Retire old tokens only once every env, in every account, has its
    // replacement.
    const old = retireTargets(cfg).flatMap(({ account, name }) =>
        (tokens.get(account) ?? [])
            .filter((t) => t.name === name)
            .map((t) => ({ account, t })),
    )
    for (const { account, t } of old) {
        pending++
        const note = !values.prune
            ? ' (needs --prune)'
            : envsOk
              ? ''
              : ' (skipped: an env failed above)'
        console.log(`- retire "${t.name}" (${t.id})${note}`)
        if (values.apply && values.prune && envsOk) {
            await cf('DELETE', `/accounts/${account}/tokens/${t.id}`)
            console.log('  deleted')
        }
    }
}

const summary =
    pending === 0
        ? 'in sync'
        : `${pending} change(s) ${values.apply ? 'applied' : 'pending (re-run with --apply)'}`
console.log(`\n${summary}${failed ? `, ${failed} env(s) failed` : ''}`)
if (failed > 0 || (values.check && pending > 0)) process.exit(1)
