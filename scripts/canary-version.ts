#!/usr/bin/env bun
/**
 * Canary version for the commit at main's tip: <proposed>-next.<n>.
 *
 *   bun scripts/canary-version.ts [--apply]
 *
 * <proposed> is the version in release-please's open release PR on main (title
 * "chore(main): release X.Y.Z"), the version this code will ship as, so the
 * canary sorts directly below it. <n> is the number of commits on main since
 * the last stable tag. No open release PR means nothing releasable has landed
 * since the last stable release, so there is nothing to canary and it refuses.
 *
 * Prints `version=X.Y.Z-next.N`, ready for $GITHUB_OUTPUT. With --apply it also
 * writes the version into the files release-please bumps (package.json,
 * jsr.json and the VOIDFLOW pin in agentic/workflows/deps-review.md), so the
 * tarball, the JSR package and the pinned workflow all carry the canary version.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isStableVersion } from './lib/version-shape.ts'

const PR_TITLE = /^chore\(main\): release (?:\S+ )?(\d+\.\d+\.\d+)$/
// release-please names the branch of main's release PR after the target branch.
const PR_BRANCH_PREFIX = 'release-please--branches--main'

export const NO_RELEASE_PR =
    'no open release PR on main: nothing releasable has landed since the last stable release, so there is nothing to canary'

export type ReleasePr = { title: string; headRefName: string }

/** The version main's open release PR proposes, or throws when there is none. */
export function proposedVersion(prs: ReleasePr[]): string {
    const versions = prs
        .filter((p) => p.headRefName.startsWith(PR_BRANCH_PREFIX))
        .map((p) => PR_TITLE.exec(p.title)?.[1])
        .filter((v): v is string => v !== undefined)
    if (versions.length === 0) throw new Error(NO_RELEASE_PR)
    if (new Set(versions).size > 1) {
        throw new Error(
            `several release PRs on main propose different versions (${versions.join(', ')})`,
        )
    }
    return versions[0] as string
}

export function canaryVersion(proposed: string, commits: number): string {
    if (!isStableVersion(proposed)) {
        throw new Error(`proposed version "${proposed}" is not X.Y.Z`)
    }
    if (!Number.isInteger(commits) || commits < 1) {
        throw new Error(
            `${commits} commits since the last stable tag: nothing to canary`,
        )
    }
    return `${proposed}-next.${commits}`
}

const replaceOnce = (text: string, re: RegExp, to: string, what: string) => {
    let hit = false
    const out = text.replace(re, (_m, before: string, after: string) => {
        hit = true
        return `${before}${to}${after}`
    })
    if (!hit) throw new Error(`no version to replace in ${what}`)
    return out
}

/** Writes the version into the files release-please bumps via extra-files. */
export function applyVersion(root: string, version: string): void {
    for (const f of ['package.json', 'jsr.json']) {
        const p = join(root, f)
        writeFileSync(
            p,
            replaceOnce(
                readFileSync(p, 'utf8'),
                /("version":\s*")[^"]+(")/,
                version,
                f,
            ),
        )
    }
    const wf = join(root, 'agentic/workflows/deps-review.md')
    writeFileSync(
        wf,
        replaceOnce(
            readFileSync(wf, 'utf8'),
            /(VOIDFLOW:\s*")[^"]+("\s*#\s*x-release-please-version)/,
            version,
            'agentic/workflows/deps-review.md',
        ),
    )
}

const sh = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) {
        throw new Error(`${cmd.join(' ')} failed: ${r.stderr.toString()}`)
    }
    return r.stdout.toString().trim()
}

function resolve(): string {
    const prs: ReleasePr[] = JSON.parse(
        sh([
            'gh',
            'pr',
            'list',
            '--state',
            'open',
            '--base',
            'main',
            '--limit',
            '200',
            '--json',
            'title,headRefName',
        ]),
    )
    const lastStable = sh([
        'git',
        'describe',
        '--tags',
        '--abbrev=0',
        '--match',
        'v[0-9]*.[0-9]*.[0-9]*',
        '--exclude',
        '*-*',
        'HEAD',
    ])
    const count = Number(
        sh(['git', 'rev-list', '--count', `${lastStable}..HEAD`]),
    )
    return canaryVersion(proposedVersion(prs), count)
}

if (import.meta.main) {
    try {
        const version = resolve()
        if (Bun.argv.includes('--apply')) applyVersion(process.cwd(), version)
        console.log(`version=${version}`)
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
