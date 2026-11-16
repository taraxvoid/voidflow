#!/usr/bin/env bun
/**
 * Move the `next` dist-tag to a stable version once it is live.
 *
 *   bun scripts/sync-next.ts X.Y.Z
 *
 * Canaries are published on demand, so after a stable release @next would still
 * point at an older canary. `npm stage approve` takes no extra tags and the
 * release job's token cannot move dist-tags (that permission would also let CI
 * move `latest`), so this runs by hand right after approving the release, from
 * the same npm session. For each package it checks that X.Y.Z is the current
 * `latest` (approved and live) and sorts above the current `next`, and leaves
 * a package alone when a canary for a later version already exists.
 */
export const PACKAGES = ['@taraxvoid/voidflow', 'voidflow']

export type Plan = { action: 'move' | 'skip'; reason: string }

/** What to do for one package, given its current dist-tags. */
export function planSync(version: string, tags: Record<string, string>): Plan {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`"${version}" is not a stable X.Y.Z version`)
    }
    if (tags.latest !== version) {
        throw new Error(
            `${version} is not the current latest (${tags.latest ?? 'unset'}): approve it on npm first`,
        )
    }
    const next = tags.next
    if (next === undefined) return { action: 'move', reason: 'next is unset' }
    if (Bun.semver.order(version, next) > 0) {
        return { action: 'move', reason: `next is ${next}, below ${version}` }
    }
    return { action: 'skip', reason: `next is ${next}, not below ${version}` }
}

const npm = (args: string[]) => {
    const r = Bun.spawnSync(['npm', ...args], {
        stdout: 'pipe',
        stderr: 'inherit',
    })
    if (r.exitCode !== 0) throw new Error(`npm ${args.join(' ')} failed`)
    return r.stdout.toString().trim()
}

if (import.meta.main) {
    const version = Bun.argv[2] ?? ''
    try {
        // Plan every package before touching any, so a package that is not
        // approved yet cannot leave the two tags out of step.
        const plans = PACKAGES.map((pkg) => ({
            pkg,
            plan: planSync(
                version,
                JSON.parse(npm(['view', pkg, 'dist-tags', '--json'])),
            ),
        }))
        for (const { pkg, plan } of plans) {
            if (plan.action === 'skip') {
                console.log(`${pkg}: left alone (${plan.reason})`)
                continue
            }
            npm(['dist-tag', 'add', `${pkg}@${version}`, 'next'])
            console.log(`${pkg}: next -> ${version} (${plan.reason})`)
        }
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
