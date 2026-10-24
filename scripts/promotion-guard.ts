#!/usr/bin/env bun
/**
 * Fail a PR into main that carries next's commits from any head but next.
 *
 *   bun scripts/promotion-guard.ts --head-ref <branch> --head <sha> [--main origin/main] [--next origin/next]
 *
 * A promotion has to come from `just promote` (head `next`, auto-merge with a
 * merge commit). A hand-made branch off next tends to get squash-merged, as
 * #185 was: main then gets next's changes without next's commits, every later
 * back-merge conflicts on the same lines, and the automatic one fails.
 *
 * The PR carries next's commits when its merge base with next is not already
 * on main. Branches cut from main (hotfixes, release-please, Renovate) pass.
 */
import { parseArgs } from 'node:util'

export type GitRun = (args: string[]) => { code: number; out: string }

export function carriesNext(git: GitRun, head: string, main: string, next: string): boolean {
    const base = git(['merge-base', head, next])
    // No shared history with next at all: nothing of next's can be in it.
    if (base.code !== 0) return false
    return git(['merge-base', '--is-ancestor', base.out, main]).code !== 0
}

function main() {
    const { values } = parseArgs({
        options: {
            'head-ref': { type: 'string' },
            head: { type: 'string' },
            main: { type: 'string', default: 'origin/main' },
            next: { type: 'string', default: 'origin/next' },
        },
    })
    const { 'head-ref': headRef, head } = values
    if (!headRef || !head) {
        throw new Error('usage: promotion-guard.ts --head-ref <branch> --head <sha> [--main <ref>] [--next <ref>]')
    }
    if (headRef === 'next') return

    const git: GitRun = (args) => {
        const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
        return { code: r.exitCode, out: r.stdout.toString().trim() }
    }
    if (carriesNext(git, head, values.main, values.next)) {
        throw new Error(
            `${headRef} carries commits from next. Promote with \`just promote\` (head next, merged with a merge commit) instead; see RELEASING.md.`,
        )
    }
}

if (import.meta.main) {
    try {
        main()
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
