#!/usr/bin/env bun
/**
 * Plan or apply the branch rulesets described in rulesets/index.ts.
 *
 *   bun scripts/apply-rulesets.ts                  # plan (read-only) for every repo
 *   bun scripts/apply-rulesets.ts --repo soundry   # plan for one repo
 *   bun scripts/apply-rulesets.ts --check          # plan, exit 1 on drift (for CI)
 *   bun scripts/apply-rulesets.ts --apply          # create/update to match
 *   bun scripts/apply-rulesets.ts --apply --prune  # ...and delete retired rulesets
 *   bun scripts/apply-rulesets.ts --config ../infra/rulesets.ts   # another fleet's config
 *
 * The config is REPOS in rulesets/index.ts unless --config names a module
 * exporting `REPOS` (or a default) of the same shape, where a repo may also
 * spell out its rulesets in full (see RawConfig and scripts/lib/config.ts).
 *
 * Uses the `gh` CLI for auth, so run it as someone with admin on the repos.
 * Rulesets not described in the config are reported and left alone; only the
 * ones a repo lists under `retire` are deleted, and only with --prune.
 * Private repos on a plan without rulesets (GitHub answers 403) are skipped
 * and reported, never counted as drift, so --check stays green for them.
 */
import { parseArgs } from 'node:util'
import { loadOrExit } from './lib/config.ts'
import {
    REPOS as BUILTIN,
    checkFleet,
    desired,
    diff,
    isPlanGated,
    normalise,
    type Ruleset,
} from '../rulesets/index.ts'

const { values } = parseArgs({
    options: {
        apply: { type: 'boolean', default: false },
        prune: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        repo: { type: 'string' },
        config: { type: 'string' },
    },
})

const REPOS = await loadOrExit(values.config, BUILTIN, checkFleet)

async function gh(args: string[], body?: unknown): Promise<any> {
    const proc = Bun.spawn(['gh', 'api', ...args], {
        stdin: body === undefined ? 'ignore' : new Blob([JSON.stringify(body)]),
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    if (code !== 0) throw new Error(`gh api ${args.join(' ')}: ${err || out}`)
    return out ? JSON.parse(out) : null
}

const repos = Object.keys(REPOS).filter(
    (r) => !values.repo || r === values.repo || r.endsWith(`/${values.repo}`),
)
if (repos.length === 0) {
    console.error(`no repo matches --repo ${values.repo}`)
    process.exit(2)
}

let drift = 0
const gated: string[] = []

for (const repo of repos) {
    console.log(`\n== ${repo}`)
    let listed: Array<{ id: number; name: string }>
    try {
        listed = await gh([`repos/${repo}/rulesets`])
    } catch (e) {
        if (!isPlanGated(String(e))) throw e
        gated.push(repo)
        console.log('  skipped: private repo on a plan without rulesets (HTTP 403)')
        continue
    }
    const matched = new Set<number>()

    for (const { ruleset, aka } of desired(repo, REPOS)) {
        const hit = listed.find(
            (r) => r.name === ruleset.name || aka.includes(r.name),
        )
        if (!hit) {
            drift++
            console.log(`+ create "${ruleset.name}"`)
            if (values.apply) {
                await gh(['-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], ruleset)
                console.log('  created')
            }
            continue
        }
        matched.add(hit.id)
        const have: Ruleset = await gh([`repos/${repo}/rulesets/${hit.id}`])
        // A read-only token gets no bypass_actors back; compare the rest.
        const bypass = Array.isArray(have.bypass_actors)
        if (!bypass) console.log(`  note "${ruleset.name}": bypass_actors not visible to this token, not compared`)
        const lines = diff(normalise(have, { bypass }), normalise(ruleset, { bypass }))
        if (lines.length === 0) {
            console.log(`  ok "${ruleset.name}"`)
            continue
        }
        drift++
        console.log(`~ update "${hit.name}" (id ${hit.id})`)
        for (const l of lines) console.log(`    ${l}`)
        if (values.apply) {
            await gh(
                ['-X', 'PUT', `repos/${repo}/rulesets/${hit.id}`, '--input', '-'],
                ruleset,
            )
            console.log('  updated')
        }
    }

    const retire = new Set(REPOS[repo].retire)
    for (const r of listed.filter((r) => !matched.has(r.id))) {
        if (!retire.has(r.name)) {
            console.log(`? unmanaged ruleset "${r.name}" (id ${r.id}), left alone`)
            continue
        }
        drift++
        console.log(`- retire "${r.name}" (id ${r.id})${values.prune ? '' : ' (needs --prune)'}`)
        if (values.apply && values.prune) {
            await gh(['-X', 'DELETE', `repos/${repo}/rulesets/${r.id}`])
            console.log('  deleted')
        }
    }
}

if (gated.length > 0) {
    console.log(`\nskipped ${gated.length} private repo(s) without ruleset support: ${gated.join(', ')}`)
}
console.log(
    `\n${drift === 0 ? 'in sync' : `${drift} ruleset(s) ${values.apply ? 'changed' : 'differ (re-run with --apply)'}`}`,
)
if (values.check && drift > 0) process.exit(1)
