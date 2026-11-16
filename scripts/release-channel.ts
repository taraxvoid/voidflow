#!/usr/bin/env bun
/**
 * Maps a release branch to its release channel: which release-please config
 * and manifest to use, and which npm dist-tag to publish under.
 *
 *   bun scripts/release-channel.ts <branch> [version] [--canary]
 *
 * Prints key=value lines, ready to append to $GITHUB_OUTPUT. When a version is
 * given it must fit the channel (stable and maintenance: X.Y.Z, canary:
 * X.Y.Z-next.N), so a mis-routed publish aborts before anything reaches npm.
 * Canaries come from main only, and only when asked for with --canary: main
 * without it is the stable channel, which rejects -next versions.
 * Unknown branches fail closed: there is no default channel, in particular no
 * fall-through to `latest`.
 */

export type ChannelKind = 'stable' | 'canary' | 'maintenance'

export type Channel = {
    kind: ChannelKind
    branch: string
    distTag: string
    config: string
    manifest: string
    prerelease: boolean
    /** Maintenance only: the version line the branch serves, "0.9" or "1". */
    line?: string
}

// release/0.9.x (minor line, pre-1.0) or release/1.x (major line).
const MAINTENANCE = /^release\/(\d+(?:\.\d+)?)\.x$/

const files = (name: string) => ({
    config: `.release-please/${name}.json`,
    manifest: `.release-please/${name}-manifest.json`,
})

export function resolveChannel(
    branch: string,
    opts: { canary?: boolean } = {},
): Channel {
    if (opts.canary && branch !== 'main') {
        throw new Error(
            `canaries are published from main only, not "${branch}"`,
        )
    }
    if (branch === 'main' && opts.canary) {
        return {
            kind: 'canary',
            branch,
            distTag: 'next',
            prerelease: true,
            ...files('main'),
        }
    }
    if (branch === 'main') {
        return {
            kind: 'stable',
            branch,
            distTag: 'latest',
            prerelease: false,
            ...files('main'),
        }
    }
    const m = MAINTENANCE.exec(branch)
    if (m) {
        return {
            kind: 'maintenance',
            branch,
            distTag: `release-${m[1]}.x`,
            prerelease: false,
            line: m[1],
            ...files('maintenance'),
        }
    }
    throw new Error(
        `no release channel for branch "${branch}" (expected main, release/N.x or release/N.M.x)`,
    )
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/
// scripts/canary-version.ts builds <proposed>-next.<n>. Old release-please
// prereleases (1.0.0-next, no number) are not canaries and are not accepted.
const CANARY_VERSION = /^\d+\.\d+\.\d+-next\.\d+$/

export function assertVersionMatchesChannel(
    version: string,
    channel: Channel,
): void {
    const shapeOk =
        channel.kind === 'canary'
            ? CANARY_VERSION.test(version)
            : STABLE_VERSION.test(version)
    // A maintenance branch only publishes its own line, so republishing some
    // other stable tag from it cannot land under its dist-tag.
    const lineOk =
        channel.line === undefined || version.startsWith(`${channel.line}.`)
    if (!shapeOk || !lineOk) {
        throw new Error(
            `version ${version} does not belong on the ${channel.kind} channel (branch ${channel.branch})`,
        )
    }
}

export function toOutputs(channel: Channel): Record<string, string> {
    return {
        kind: channel.kind,
        dist_tag: channel.distTag,
        config: channel.config,
        manifest: channel.manifest,
        prerelease: String(channel.prerelease),
    }
}

if (import.meta.main) {
    const args = Bun.argv.slice(2)
    const canary = args.includes('--canary')
    const [branch, version] = args.filter((a) => a !== '--canary')
    try {
        const channel = resolveChannel(branch ?? '', { canary })
        if (version) assertVersionMatchesChannel(version, channel)
        for (const [k, v] of Object.entries(toOutputs(channel)))
            console.log(`${k}=${v}`)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
