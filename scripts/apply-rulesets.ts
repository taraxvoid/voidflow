/**
 * Plan or apply the branch rulesets of the fleet in a --config module (the
 * org's infra repo), shaped as in rulesets/index.ts. Every invocation takes
 * --config <module>, e.g. ../infra/rulesets.ts:
 *
 *   voidflow rulesets --config <m>                              # plan (read-only) for every repo
 *   voidflow rulesets --config <m> --repo soundry               # plan for one repo
 *   voidflow rulesets --config <m> --check                      # plan, exit 1 on drift (for CI)
 *   voidflow rulesets --config <m> --apply                      # create/update to match
 *   voidflow rulesets --config <m> --apply --prune              # ...and delete retired rulesets
 *
 * The module exports `REPOS` (or a default); a repo may be tiered or spell
 * out its rulesets in full (see RawConfig and scripts/lib/config.ts).
 *
 * Uses the `gh` CLI for auth, so run it as someone with admin on the repos.
 * Rulesets not described in the config are reported and left alone; only the
 * ones a repo lists under `retire` are deleted, and only with --prune.
 * Private repos on a plan without rulesets (GitHub answers 403) are skipped
 * and reported, never counted as drift, so --check stays green for them.
 * A repo asking for a merge queue it can't have (not org-owned) fails the run
 * up front, before anything is written.
 *
 * A tiered repo's `environments` get an explicit deployment branch list built
 * from their tiers. Applying one creates a missing environment and keeps its
 * wait timer, reviewers and admin bypass as they are; policies for branches or
 * tags outside the list are deleted. Environments not in the config are never
 * read or changed.
 */

import { dirname } from 'node:path'
import { toFleet } from '../config/index.ts'
import {
    checkFleet,
    desired,
    diff,
    type EnvPolicy,
    envBranches,
    envDiff,
    type Fleet,
    isPlanGated,
    mergeQueueIneligible,
    normalise,
    type Ruleset,
    wantsMergeQueue,
} from '../rulesets/index.ts'
import { parseOrExit } from './lib/args.ts'
import { loadOrExit } from './lib/config.ts'
import { capture } from './lib/proc.ts'
import { loadVoidflowConfig, repoSlug } from './lib/repo-config.ts'

const OPTIONS = {
    apply: { type: 'boolean', default: false },
    prune: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    repo: { type: 'string' },
    config: { type: 'string' },
    'repo-config': { type: 'string' },
} as const

const usage = (
    prog: string,
) => `usage: ${prog} (--config <module> | --repo-config <file>) [flags]

  --config <module>  the fleet map: a module exporting REPOS (or a default)
  --repo-config <file>  a voidflow.config.ts: manage the repo it sits in
                     (set by the verbs; takes no --repo)
  --repo <name>      only this repo (owner/name, or just name)
  --check            exit 1 on drift
  --apply            create and update rulesets to match
  --prune            with --apply, also delete the rulesets listed under retire`

async function gh<T = unknown>(args: string[], body?: unknown): Promise<T> {
    const { code, out, err } = await capture(
        ['gh', 'api', ...args],
        body === undefined ? undefined : JSON.stringify(body),
    )
    if (code !== 0) throw new Error(`gh api ${args.join(' ')}: ${err || out}`)
    return (out ? JSON.parse(out) : null) as T
}

type EnvResponse = {
    can_admins_bypass?: boolean
    deployment_branch_policy: {
        protected_branches: boolean
        custom_branch_policies: boolean
    } | null
    protection_rules?: Array<{
        type: string
        wait_timer?: number
        prevent_self_review?: boolean
        reviewers?: Array<{ type: string; reviewer: { id: number } }>
    }>
}
type BranchPolicy = { id: number; name: string; type?: 'branch' | 'tag' }

const is404 = (e: unknown) => /\(HTTP 404\)/.test(String(e))

async function readEnv(
    repo: string,
    env: string,
): Promise<{
    raw: EnvResponse | null
    policy: EnvPolicy
    ids: BranchPolicy[]
}> {
    const path = `repos/${repo}/environments/${encodeURIComponent(env)}`
    let raw: EnvResponse
    try {
        raw = await gh<EnvResponse>([path])
    } catch (e) {
        if (!is404(e)) throw e
        const none = {
            exists: false,
            protectedBranches: false,
            customBranchPolicies: false,
            branches: [],
            tags: [],
        }
        return { raw: null, policy: none, ids: [] }
    }
    const p = raw.deployment_branch_policy
    const custom = p?.custom_branch_policies === true
    const ids = custom
        ? (
              await gh<Array<{ branch_policies: BranchPolicy[] }>>([
                  `${path}/deployment-branch-policies?per_page=100`,
                  '--paginate',
                  '--slurp',
              ])
          ).flatMap((page) => page.branch_policies)
        : []
    return {
        raw,
        policy: {
            exists: true,
            protectedBranches: p?.protected_branches === true,
            customBranchPolicies: custom,
            branches: ids.filter((b) => b.type !== 'tag').map((b) => b.name),
            tags: ids.filter((b) => b.type === 'tag').map((b) => b.name),
        },
        ids,
    }
}

/** Set an explicit branch list, keeping the environment's other protection. */
async function writeEnv(
    repo: string,
    env: string,
    have: { raw: EnvResponse | null; policy: EnvPolicy; ids: BranchPolicy[] },
    want: string[],
) {
    const path = `repos/${repo}/environments/${encodeURIComponent(env)}`
    const rules = have.raw?.protection_rules ?? []
    const wait = rules.find((r) => r.type === 'wait_timer')
    const review = rules.find((r) => r.type === 'required_reviewers')
    await gh(['-X', 'PUT', path, '--input', '-'], {
        ...(wait?.wait_timer !== undefined
            ? { wait_timer: wait.wait_timer }
            : {}),
        ...(review
            ? {
                  prevent_self_review: review.prevent_self_review === true,
                  reviewers: (review.reviewers ?? []).map((r) => ({
                      type: r.type,
                      id: r.reviewer.id,
                  })),
              }
            : {}),
        ...(have.raw?.can_admins_bypass !== undefined
            ? { can_admins_bypass: have.raw.can_admins_bypass }
            : {}),
        deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
        },
    })
    // Switching to custom policies may keep earlier ones; reread before diffing.
    const { ids } = await readEnv(repo, env)
    // Add the missing policies before deleting the obsolete ones. An old
    // pattern (say `*`) may be what lets a wanted branch deploy; if a POST
    // fails, it should still be there. Until the first POST lands, a repo that
    // had no custom policies deploys from nowhere (GitHub only takes policies
    // on an environment already set to custom ones), so a failed run is
    // finished by running again.
    const kept = ids.filter((b) => b.type !== 'tag').map((b) => b.name)
    for (const name of want.filter((b) => !kept.includes(b)))
        await gh(
            [
                '-X',
                'POST',
                `${path}/deployment-branch-policies`,
                '--input',
                '-',
            ],
            {
                name,
                type: 'branch',
            },
        )
    for (const b of ids.filter(
        (b) => b.type === 'tag' || !want.includes(b.name),
    ))
        await gh(['-X', 'DELETE', `${path}/deployment-branch-policies/${b.id}`])
}
/** One call against the GitHub rulesets API; throws with `(HTTP nnn)` on failure. */
export type RulesetApi = <T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
) => Promise<T>

export type RulesetOutcome = {
    name: string
    kind: 'ok' | 'create' | 'update' | 'retire' | 'unmanaged'
    /** True when the change was written. */
    done: boolean
}

/**
 * Plan (and with `apply`, write) one repo's rulesets against `fleet`. Shared
 * by `voidflow rulesets` and `voidflow init --preset rulesets`. A repo that is
 * private on a plan without rulesets comes back `gated`, never as drift.
 */
export async function syncRepo(
    api: RulesetApi,
    repo: string,
    fleet: Fleet,
    opts: { apply: boolean; prune: boolean },
    log: (line: string) => void,
): Promise<{ drift: number; gated: boolean; outcomes: RulesetOutcome[] }> {
    let drift = 0
    const outcomes: RulesetOutcome[] = []
    let listed: Array<{ id: number; name: string }>
    try {
        listed = await api<typeof listed>('GET', `repos/${repo}/rulesets`)
    } catch (e) {
        if (!isPlanGated(String(e))) throw e
        log('  skipped: private repo on a plan without rulesets (HTTP 403)')
        return { drift, gated: true, outcomes }
    }
    const matched = new Set<number>()

    for (const { ruleset, aka } of desired(repo, fleet)) {
        const hit = listed.find(
            (r) => r.name === ruleset.name || aka.includes(r.name),
        )
        if (!hit) {
            drift++
            log(`+ create "${ruleset.name}"`)
            if (opts.apply) {
                await api('POST', `repos/${repo}/rulesets`, ruleset)
                log('  created')
            }
            outcomes.push({
                name: ruleset.name,
                kind: 'create',
                done: opts.apply,
            })
            continue
        }
        matched.add(hit.id)
        const have = await api<Ruleset>(
            'GET',
            `repos/${repo}/rulesets/${hit.id}`,
        )
        // A read-only token gets no bypass_actors back; compare the rest.
        const bypass = Array.isArray(have.bypass_actors)
        if (!bypass)
            log(
                `  note "${ruleset.name}": bypass_actors not visible to this token, not compared`,
            )
        const lines = diff(
            normalise(have, { bypass }),
            normalise(ruleset, { bypass }),
        )
        if (lines.length === 0) {
            log(`  ok "${ruleset.name}"`)
            outcomes.push({ name: ruleset.name, kind: 'ok', done: false })
            continue
        }
        drift++
        log(`~ update "${hit.name}" (id ${hit.id})`)
        for (const l of lines) log(`    ${l}`)
        if (opts.apply) {
            await api('PUT', `repos/${repo}/rulesets/${hit.id}`, ruleset)
            log('  updated')
        }
        outcomes.push({
            name: ruleset.name,
            kind: 'update',
            done: opts.apply,
        })
    }

    const retire = new Set(fleet[repo].retire)
    for (const r of listed.filter((r) => !matched.has(r.id))) {
        if (!retire.has(r.name)) {
            log(`? unmanaged ruleset "${r.name}" (id ${r.id}), left alone`)
            outcomes.push({ name: r.name, kind: 'unmanaged', done: false })
            continue
        }
        drift++
        log(
            `- retire "${r.name}" (id ${r.id})${opts.prune ? '' : ' (needs --prune)'}`,
        )
        const done = opts.apply && opts.prune
        if (done) {
            await api('DELETE', `repos/${repo}/rulesets/${r.id}`)
            log('  deleted')
        }
        outcomes.push({ name: r.name, kind: 'retire', done })
    }
    return { drift, gated: false, outcomes }
}

/**
 * Plan (and with `apply`, write) a tiered repo's environment branch policies;
 * returns the number that differ. Only `voidflow rulesets` does this, not
 * `voidflow init --preset rulesets`.
 */
async function syncEnvs(
    repo: string,
    cfg: Fleet[string],
    apply: boolean,
): Promise<number> {
    // Raw configs pass through checkFleet unvalidated beyond their rulesets,
    // so an `environments` field on one is not ours to read.
    const envs = 'rulesets' in cfg ? [] : Object.entries(cfg.environments)
    if (envs.length === 0) return 0
    let drift = 0
    const { default_branch } = await gh<{ default_branch: string }>([
        `repos/${repo}`,
    ])
    for (const [env, tiers] of envs) {
        const want = envBranches(tiers, default_branch)
        const have = await readEnv(repo, env)
        const lines = envDiff(have.policy, want)
        if (lines.length === 0) {
            console.log(`  ok environment "${env}" (${want.join(', ')})`)
            continue
        }
        drift++
        console.log(
            `~ environment "${env}" deploys from ${want.join(', ')} only`,
        )
        for (const l of lines) console.log(`    ${l}`)
        if (apply) {
            await writeEnv(repo, env, have, want)
            console.log('  updated')
        }
    }
    return drift
}

/** `prog` names the command in the --help usage. */
export async function main(argv: string[], prog = 'voidflow rulesets') {
    const { values } = parseOrExit(argv, { options: OPTIONS }, usage(prog))

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

    let REPOS: Fleet
    if (repoConfig === undefined) {
        REPOS = await loadOrExit(values.config, checkFleet)
    } else {
        try {
            REPOS = toFleet(
                await loadVoidflowConfig(repoConfig),
                await repoSlug(process.env, dirname(repoConfig)),
            )
        } catch (e) {
            console.error((e as Error).message)
            process.exit(2)
        }
    }

    const repos = Object.keys(REPOS).filter(
        (r) =>
            !values.repo || r === values.repo || r.endsWith(`/${values.repo}`),
    )
    if (repos.length === 0) {
        console.error(`no repo matches --repo ${values.repo}`)
        process.exit(2)
    }

    // Fail before any write if a repo wants a merge queue GitHub can't give it.
    const refused: string[] = []
    for (const repo of repos.filter((r) => wantsMergeQueue(REPOS[r]))) {
        let info: { owner: { type: string }; private: boolean }
        try {
            info = await gh<typeof info>([`repos/${repo}`])
        } catch (e) {
            // Without access to the repo, the rulesets call below reports it.
            console.log(
                `note ${repo}: merge queue eligibility not checked (${e})`,
            )
            continue
        }
        const why = mergeQueueIneligible(info)
        if (why) refused.push(`${repo}: mergeQueue: true, but ${why}`)
        else if (info.private)
            console.log(
                `note ${repo}: private org repo; a merge queue needs Enterprise Cloud`,
            )
    }
    if (refused.length > 0) {
        console.error(refused.join('\n'))
        process.exit(2)
    }

    let drift = 0
    const gated: string[] = []
    const api: RulesetApi = (method, path, body) =>
        gh(
            method === 'GET' ? [path] : ['-X', method, path, '--input', '-'],
            body,
        )

    for (const repo of repos) {
        console.log(`\n== ${repo}`)
        const r = await syncRepo(api, repo, REPOS, values, (l) =>
            console.log(l),
        )
        drift += r.drift
        if (r.gated) gated.push(repo)
        else drift += await syncEnvs(repo, REPOS[repo], values.apply)
    }

    if (gated.length > 0) {
        console.log(
            `\nskipped ${gated.length} private repo(s) without ruleset support: ${gated.join(', ')}`,
        )
    }
    console.log(
        `\n${drift === 0 ? 'in sync' : `${drift} ruleset(s) or environment(s) ${values.apply ? 'changed' : 'differ (re-run with --apply)'}`}`,
    )
    if (values.check && drift > 0) process.exit(1)
}
