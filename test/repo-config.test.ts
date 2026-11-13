import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    CONFIG_FILE,
    findRepoConfig,
    loadVoidflowConfig,
    parseRemote,
    repoSlug,
} from '../scripts/lib/repo-config.ts'

/** A fresh temp directory. */
const tmp = () => mkdtempSync(join(tmpdir(), 'voidflow-repo-config-'))

/** A temp "repo": a directory holding a `.git` directory. */
function repo(withConfig = true) {
    const root = tmp()
    mkdirSync(join(root, '.git'))
    if (withConfig)
        writeFileSync(
            join(root, CONFIG_FILE),
            "export default { kind: 'tool' }",
        )
    return root
}

/** A real git repo with the given origin, so `git remote get-url` answers. */
function gitRepo(origin?: string) {
    const root = tmp()
    const run = (...args: string[]) => {
        const r = Bun.spawnSync(['git', ...args], { cwd: root })
        if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    }
    run('init', '-q')
    if (origin) run('remote', 'add', 'origin', origin)
    return root
}

describe('findRepoConfig', () => {
    test('finds the file in the repo root from a subdirectory', () => {
        const root = repo()
        const sub = join(root, 'a', 'b')
        mkdirSync(sub, { recursive: true })
        expect(findRepoConfig(sub)).toBe(join(root, CONFIG_FILE))
        expect(findRepoConfig(root)).toBe(join(root, CONFIG_FILE))
    })

    test('stops at the nearest git root', () => {
        const outer = repo()
        const inner = join(outer, 'vendor', 'lib')
        mkdirSync(join(inner, '.git'), { recursive: true })
        expect(findRepoConfig(inner)).toBeNull()
    })

    test('returns null outside a git repo', () => {
        const dir = tmp()
        writeFileSync(join(dir, CONFIG_FILE), "export default { kind: 'tool' }")
        expect(findRepoConfig(dir)).toBeNull()
    })

    test('returns null in a repo with no config file', () => {
        expect(findRepoConfig(repo(false))).toBeNull()
    })
})

describe('parseRemote', () => {
    test('reads the GitHub URL shapes', () => {
        for (const url of [
            'git@github.com:o/n.git',
            'https://github.com/o/n.git',
            'https://github.com/o/n/',
            'ssh://git@github.com/o/n',
        ])
            expect(parseRemote(url)).toBe('o/n')
    })

    test('rejects other hosts and non-URLs', () => {
        expect(parseRemote('https://gitlab.com/o/n.git')).toBeNull()
        expect(parseRemote('not a url')).toBeNull()
    })
})

describe('repoSlug', () => {
    test('prefers GITHUB_REPOSITORY', async () => {
        const dir = gitRepo('git@github.com:x/y.git')
        expect(await repoSlug({ GITHUB_REPOSITORY: 'o/n' }, dir)).toBe('o/n')
    })

    test('falls back to the origin remote', async () => {
        const dir = gitRepo('https://github.com/x/y.git')
        expect(await repoSlug({}, dir)).toBe('x/y')
        expect(await repoSlug({ GITHUB_REPOSITORY: 'nope' }, dir)).toBe('x/y')
    })

    test('names GITHUB_REPOSITORY when there is no usable remote', async () => {
        await expect(repoSlug({}, gitRepo())).rejects.toThrow(
            'GITHUB_REPOSITORY',
        )
        await expect(
            repoSlug({}, gitRepo('https://gitlab.com/o/n.git')),
        ).rejects.toThrow('GITHUB_REPOSITORY')
    })
})

describe('loadVoidflowConfig', () => {
    /** Write `source` as a config file in a fresh directory. */
    function file(source: string) {
        const path = join(tmp(), CONFIG_FILE)
        writeFileSync(path, source)
        return path
    }

    test('loads a valid default export', async () => {
        const path = file(
            "import type { VoidflowConfig } from '@taraxvoid/voidflow/config'\nexport default { kind: 'site' } satisfies VoidflowConfig",
        )
        expect((await loadVoidflowConfig(path)).kind).toBe('site')
    })

    test('rejects a file that does not load, naming it', async () => {
        const cases: [string, string][] = [
            ['export default {', ''],
            ["throw new Error('boom')", 'boom'],
            ['export const x = 1', 'default export'],
            ["export default { kind: 'sit' }", 'kind'],
        ]
        for (const [source, message] of cases) {
            const path = file(source)
            const err = await loadVoidflowConfig(path).then(
                () => null,
                (e: Error) => e,
            )
            expect(err).not.toBeNull()
            expect(err?.message.startsWith(path)).toBe(true)
            expect(err?.message).toContain(message)
        }
    })
})
