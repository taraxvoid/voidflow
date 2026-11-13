import { describe, expect, test } from 'bun:test'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    writeFileSync,
} from 'node:fs'
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
    test('uses GITHUB_REPOSITORY when the checkout has no GitHub origin', async () => {
        expect(await repoSlug({ GITHUB_REPOSITORY: 'o/n' }, gitRepo())).toBe(
            'o/n',
        )
        expect(
            await repoSlug(
                { GITHUB_REPOSITORY: 'o/n' },
                gitRepo('https://gitlab.com/o/n.git'),
            ),
        ).toBe('o/n')
    })

    test('GITHUB_REPOSITORY that agrees with origin is accepted, ignoring case', async () => {
        const dir = gitRepo('git@github.com:Owner/Name.git')
        expect(await repoSlug({ GITHUB_REPOSITORY: 'owner/name' }, dir)).toBe(
            'owner/name',
        )
    })

    test('GITHUB_REPOSITORY that disagrees with origin is an error naming both', async () => {
        const dir = gitRepo('git@github.com:o/a.git')
        const err = await repoSlug({ GITHUB_REPOSITORY: 'x/other' }, dir).then(
            () => null,
            (e: Error) => e,
        )
        expect(err?.message).toContain('x/other')
        expect(err?.message).toContain('o/a')
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

describe('rulesets --repo-config', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'cli.ts')

    /** Run `voidflow rulesets ...`, with a `gh` on PATH that only leaves a marker file. */
    function run(args: string[]) {
        const shim = tmp()
        const marker = join(shim, 'gh-called')
        const gh = join(shim, 'gh')
        writeFileSync(gh, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
        chmodSync(gh, 0o755)
        const r = Bun.spawnSync([process.execPath, cli, 'rulesets', ...args], {
            env: {
                ...process.env,
                PATH: `${shim}:${process.env.PATH}`,
                GITHUB_REPOSITORY: 'o/n',
            },
        })
        return {
            code: r.exitCode,
            err: r.stderr.toString(),
            ghCalled: existsSync(marker),
        }
    }

    test('is refused together with --config', () => {
        const r = run(['--repo-config', 'a.ts', '--config', 'b.ts'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('--repo-config and --config')
    })

    test('is refused together with --repo', () => {
        const r = run(['--repo-config', 'a.ts', '--repo', 'x'])
        expect(r.code).toBe(2)
        expect(r.err).toContain('per-repo')
    })

    test('a config that does not load exits 2 naming the file, before any gh call', () => {
        const path = join(tmp(), CONFIG_FILE)
        writeFileSync(path, "export default { kind: 'sit' }")
        const r = run(['--repo-config', path])
        expect(r.code).toBe(2)
        expect(r.err).toContain(path)
        expect(r.ghCalled).toBe(false)
    })

    test('a valid config reaches gh for its repo', () => {
        const path = join(tmp(), CONFIG_FILE)
        writeFileSync(path, "export default { kind: 'tool' }")
        const r = run(['--repo-config', path])
        expect(r.ghCalled).toBe(true)
    })
})
