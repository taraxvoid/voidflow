#!/usr/bin/env bun
/**
 * Prepare the main -> next back-merge after a stable release.
 *
 *   bun scripts/back-merge.ts --remote <url|path> --tag v0.10.0 --version 0.10.0 --sha <release commit on main>
 *
 * Run inside a full clone. Creates and checks out the local branch
 * backmerge/<tag> (next plus the release commit) and prints key=value lines:
 *
 *   result=created  branch=backmerge/<tag>   a commit is ready to push
 *   result=none                              next already has the release
 *   result=no-next                           the remote has no next branch yet
 *
 * Only version bookkeeping may conflict, and it is resolved here:
 *   package.json, jsr.json   version lines are normalised on all three sides,
 *                            then a real three-way merge keeps every other change
 *   CHANGELOG.md, main manifest   take main's side
 * Any other conflict, or a merge that fails for another reason, exits 1.
 *
 * next's release-please manifest is moved up to the stable version only when
 * that is newer than what next already has, so a hotfix on an older line never
 * rewinds the prerelease numbering.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const NEXT_MANIFEST = '.release-please/next-manifest.json'
const VERSION_FILES = new Set(['package.json', 'jsr.json'])
const MAIN_SIDE_FILES = new Set(['CHANGELOG.md', '.release-please/main-manifest.json'])
const SRC = 'refs/remotes/backmerge-src'

export function nextManifestVersion(current: string, stable: string): string {
    return Bun.semver.order(stable, current) === 1 ? stable : current
}

// First "version" key only; every other line is left byte-for-byte alone.
const VERSION_LINE = /("version"\s*:\s*")[^"]*(")/
const withVersion = (text: string, version: string) =>
    text.replace(VERSION_LINE, `$1${version}$2`)

function main() {
    const { values } = parseArgs({
        options: {
            remote: { type: 'string' },
            tag: { type: 'string' },
            version: { type: 'string' },
            sha: { type: 'string' },
        },
    })
    const { remote, tag, version, sha } = values
    if (!remote || !tag || !version || !sha) {
        throw new Error('usage: back-merge.ts --remote <url|path> --tag <tag> --version <x.y.z> --sha <commit>')
    }

    const redact = (s: string) => s.split(remote).join('<remote>')
    const git = (args: string[], allowFail = false) => {
        const r = Bun.spawnSync(
            ['git', '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', ...args],
            { stdout: 'pipe', stderr: 'pipe' },
        )
        const out = r.stdout.toString()
        const err = r.stderr.toString()
        if (r.exitCode !== 0 && !allowFail) {
            throw new Error(redact(`git ${args.join(' ')}: ${err || out}`))
        }
        return { code: r.exitCode, out, err }
    }
    const mergeInProgress = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).code === 0

    // 2 means "no such ref"; anything else non-zero is a real failure.
    const ls = git(['ls-remote', '--exit-code', '--heads', remote, 'next'], true)
    if (ls.code === 2) {
        console.log('result=no-next')
        return
    }
    if (ls.code !== 0) throw new Error(redact(`git ls-remote failed: ${ls.err || ls.out}`))

    git(['fetch', '--quiet', remote, `+refs/heads/next:${SRC}/next`, `+refs/heads/main:${SRC}/main`])
    if (git(['merge-base', '--is-ancestor', sha, `${SRC}/main`], true).code !== 0) {
        throw new Error(`${sha} is not on main`)
    }

    const branch = `backmerge/${tag}`
    git(['checkout', '--quiet', '-B', branch, `${SRC}/next`])

    const current = JSON.parse(readFileSync(NEXT_MANIFEST, 'utf8'))['.'] as string
    const target = nextManifestVersion(current, version)

    const touched = new Set<string>()
    const merge = git(['merge', '--no-ff', '--no-commit', sha], true)
    if (merge.code !== 0) {
        const unmerged = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
        if (unmerged.length === 0 && !mergeInProgress()) {
            throw new Error(redact(`merge of ${sha} into next failed: ${merge.err || merge.out}`))
        }
        for (const f of unmerged) {
            if (MAIN_SIDE_FILES.has(f)) {
                git(['checkout', '--theirs', '--', f])
            } else if (VERSION_FILES.has(f)) {
                resolveVersionFile(f, target, git)
            } else {
                throw new Error(
                    `unexpected merge conflict in ${f}: merge main into next by hand (see RELEASING.md)`,
                )
            }
            touched.add(f)
        }
    }

    if (target !== current) {
        const manifest = JSON.parse(readFileSync(NEXT_MANIFEST, 'utf8'))
        manifest['.'] = target
        writeFileSync(NEXT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
        touched.add(NEXT_MANIFEST)
    }
    for (const f of touched) git(['add', '--', f])

    if (!mergeInProgress() && git(['status', '--porcelain']).out.trim() === '') {
        console.log('result=none')
        return
    }
    git(['commit', '--quiet', '-m', `chore: back-merge ${tag} into next`])
    console.log('result=created')
    console.log(`branch=${branch}`)
}

function resolveVersionFile(
    file: string,
    target: string,
    git: (args: string[], allowFail?: boolean) => { code: number; out: string; err: string },
) {
    const dir = mkdtempSync(join(tmpdir(), 'back-merge-'))
    try {
        const stage = (n: number, name: string) => {
            const r = git(['show', `:${n}:${file}`], true)
            if (r.code !== 0) throw new Error(`cannot merge ${file}: no stage ${n} (add/add or delete conflict)`)
            const path = join(dir, name)
            writeFileSync(path, withVersion(r.out, target))
            return path
        }
        const base = stage(1, 'base')
        const ours = stage(2, 'ours')
        const theirs = stage(3, 'theirs')
        const merged = git(['merge-file', '-p', ours, base, theirs], true)
        if (merged.code !== 0) {
            throw new Error(`unexpected merge conflict in ${file}: merge main into next by hand (see RELEASING.md)`)
        }
        writeFileSync(file, merged.out)
    } finally {
        rmSync(dir, { recursive: true, force: true })
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
