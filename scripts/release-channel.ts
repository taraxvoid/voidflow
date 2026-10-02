#!/usr/bin/env bun
/**
 * Maps a release branch to its release channel: which release-please config
 * and manifest to use, and which npm dist-tag to publish under.
 *
 *   bun scripts/release-channel.ts <branch> [version]
 *
 * Prints key=value lines, ready to append to $GITHUB_OUTPUT. When a version is
 * given it must fit the channel (stable and maintenance: X.Y.Z, prerelease:
 * X.Y.Z-next.N), so a mis-routed publish aborts before anything reaches npm.
 * Unknown branches fail closed: there is no default channel, in particular no
 * fall-through to `latest`.
 */

export type ChannelKind = 'stable' | 'prerelease' | 'maintenance'

export type Channel = {
    kind: ChannelKind
    branch: string
    distTag: string
    config: string
    manifest: string
    prerelease: boolean
}

// release/0.9.x (minor line, pre-1.0) or release/1.x (major line).
const MAINTENANCE = /^release\/(\d+(?:\.\d+)?)\.x$/

const files = (name: string) => ({
    config: `.release-please/${name}.json`,
    manifest: `.release-please/${name}-manifest.json`,
})

export function resolveChannel(branch: string): Channel {
    if (branch === 'main') {
        return { kind: 'stable', branch, distTag: 'latest', prerelease: false, ...files('main') }
    }
    if (branch === 'next') {
        return { kind: 'prerelease', branch, distTag: 'next', prerelease: true, ...files('next') }
    }
    const m = MAINTENANCE.exec(branch)
    if (m) {
        return {
            kind: 'maintenance',
            branch,
            distTag: `release-${m[1]}.x`,
            prerelease: false,
            ...files('maintenance'),
        }
    }
    throw new Error(
        `no release channel for branch "${branch}" (expected main, next, release/N.x or release/N.M.x)`,
    )
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/
const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-next\.\d+$/

export function assertVersionMatchesChannel(version: string, channel: Channel): void {
    const ok =
        channel.kind === 'prerelease'
            ? PRERELEASE_VERSION.test(version)
            : STABLE_VERSION.test(version)
    if (!ok) {
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
    const [branch, version] = Bun.argv.slice(2)
    try {
        const channel = resolveChannel(branch ?? '')
        if (version) assertVersionMatchesChannel(version, channel)
        for (const [k, v] of Object.entries(toOutputs(channel))) console.log(`${k}=${v}`)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
