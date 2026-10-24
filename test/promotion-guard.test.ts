import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, '../scripts/promotion-guard.ts')
// Drop inherited GIT_* vars: inside a git hook GIT_DIR points at the real repo.
const ENV = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(['git', ...args], { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
}

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** main and next diverged: one commit each since the base. */
function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'promotion-guard-'))
    roots.push(dir)
    git(dir, 'init', '-q', '-b', 'main')
    const commit = (msg: string) => {
        writeFileSync(join(dir, `${msg.replace(/\W/g, '-')}.txt`), msg)
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', msg)
    }
    commit('base')
    git(dir, 'checkout', '-q', '-b', 'next')
    commit('feat: on next')
    git(dir, 'checkout', '-q', 'main')
    commit('fix: on main')
    const branch = (name: string, from: string, msg: string) => {
        git(dir, 'checkout', '-q', '-b', name, from)
        commit(msg)
        git(dir, 'checkout', '-q', 'main')
        return git(dir, 'rev-parse', name)
    }
    const run = (headRef: string, head: string) =>
        Bun.spawnSync(['bun', SCRIPT, '--head-ref', headRef, '--head', head, '--main', 'main', '--next', 'next'], {
            cwd: dir,
            env: ENV,
            stdout: 'pipe',
            stderr: 'pipe',
        })
    return { dir, branch, run }
}

describe('promotion-guard', () => {
    test('a branch cut from main passes', () => {
        const r = repo()
        expect(r.run('hotfix', r.branch('hotfix', 'main', 'fix: hotfix')).exitCode).toBe(0)
    })

    test('a hand-made branch off next fails and points at just promote', () => {
        const r = repo()
        const res = r.run('chore/merge_next_into_main', r.branch('promo', 'next', 'chore: merge'))
        expect(res.exitCode).toBe(1)
        expect(res.stderr.toString()).toContain('just promote')
    })

    test('next itself passes', () => {
        const r = repo()
        expect(r.run('next', git(r.dir, 'rev-parse', 'next')).exitCode).toBe(0)
    })

    test('a branch off main passes once next is merged into main', () => {
        const r = repo()
        git(r.dir, 'merge', '-q', '--no-ff', '-m', 'promote', 'next')
        expect(r.run('hotfix', r.branch('hotfix', 'main', 'fix: after promote')).exitCode).toBe(0)
    })

    test('a branch off main still passes after a back-merge into next', () => {
        const r = repo()
        git(r.dir, 'checkout', '-q', 'next')
        git(r.dir, 'merge', '-q', '--no-ff', '-m', 'back-merge', 'main')
        git(r.dir, 'checkout', '-q', 'main')
        expect(r.run('hotfix', r.branch('hotfix', 'main', 'fix: later')).exitCode).toBe(0)
    })
})
