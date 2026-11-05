/**
 * `voidflow init --preset rulesets`: apply voidflow's branch rulesets to the
 * repo being initialised, reusing the planner and diff of `voidflow rulesets`.
 * Never prunes: rulesets the config does not describe are left alone.
 */

import {
    type Fleet,
    mergeQueueIneligible,
    tool,
    wantsMergeQueue,
} from '../../rulesets/index.ts'
import {
    type RulesetApi,
    type RulesetOutcome,
    syncRepo,
} from '../apply-rulesets.ts'
import type { Gh, GhResult } from './gh.ts'
import type { SettingResult } from './settings.ts'

function object(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

/** The default fleet entry for a repo: `tool()`; sites have no builder yet. */
export function defaultFleet(repo: string): Fleet {
    return { [repo]: tool() }
}

/** A RulesetApi over the injectable Gh; failures read `... (HTTP nnn)`. */
export function ghRulesetApi(gh: Gh): RulesetApi {
    return async <T>(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
    ) => {
        const r: GhResult = await gh.rest(method, path, body)
        if (r.status < 200 || r.status >= 300) {
            const message = object(r.body)?.message
            throw new Error(
                `${path}: ${typeof message === 'string' ? message : 'request failed'} (HTTP ${r.status})`,
            )
        }
        return r.body as T
    }
}

const STATUS: Record<
    RulesetOutcome['kind'],
    (o: RulesetOutcome, dryRun: boolean) => SettingResult | null
> = {
    ok: (o) => ({ name: `ruleset ${o.name}`, status: 'unchanged' }),
    create: (o, dryRun) => ({
        name: `ruleset ${o.name}`,
        status: dryRun ? 'would-apply' : 'applied',
        detail: 'create',
    }),
    update: (o, dryRun) => ({
        name: `ruleset ${o.name}`,
        status: dryRun ? 'would-apply' : 'applied',
        detail: 'update',
    }),
    // init never prunes, and unmanaged rulesets are not its business.
    retire: () => null,
    unmanaged: () => null,
}

export async function runRulesets(
    gh: Gh,
    repo: string,
    fleet: Fleet,
    dryRun: boolean,
): Promise<SettingResult[]> {
    const api = ghRulesetApi(gh)
    const name = 'rulesets'
    try {
        if (wantsMergeQueue(fleet[repo])) {
            const info = await api<{
                owner: { type: string }
                private: boolean
            }>('GET', `repos/${repo}`)
            const why = mergeQueueIneligible(info)
            if (why) {
                return [
                    {
                        name,
                        status: 'skipped-plan',
                        detail: `mergeQueue: true, but ${why}`,
                    },
                ]
            }
        }
        const r = await syncRepo(
            api,
            repo,
            fleet,
            { apply: !dryRun, prune: false },
            () => {},
        )
        if (r.gated) {
            return [
                {
                    name,
                    status: 'skipped-plan',
                    detail: 'private repo on a plan without rulesets (HTTP 403)',
                },
            ]
        }
        return r.outcomes.flatMap((o) => {
            const s = STATUS[o.kind](o, dryRun)
            return s ? [s] : []
        })
    } catch (e) {
        return [
            {
                name,
                status: 'failed',
                detail: e instanceof Error ? e.message : String(e),
            },
        ]
    }
}
