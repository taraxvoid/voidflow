import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nextManifestVersion } from '../scripts/back-merge.ts'

const SCRIPT = join(import.meta.dir, '../scripts/back-merge.ts')
const ENV = {
    ...process.env,
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

function write(dir: string, rel: string, content: string) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
}

const pkg = (version: string, deps = '{}') =>
    `{\n  "name": "x",\n  "version": "${version}",\n  "dependencies": ${deps}\n}\n`
const manifest = (v: string) => `{\n  ".": "${v}"\n}\n`

const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

type Opts = {
    /** false: the remote has no next branch. */
    next?: boolean
    /** Version main just released. */
    stable?: string
    /** Version next is at (package.json and next-manifest). */
    nextVersion?: string
    /** Both branches edit src/a.txt differently. */
    conflictSrc?: boolean
    /** next already contains the release and its manifest is up to date. */
    premerged?: boolean
}

function scenario(o: Opts = {}) {
    const root = mkdtempSync(join(tmpdir(), 'backmerge-'))
    roots.push(root)
    const remote = join(root, 'remote.git')
    git(root, 'init', '--bare', '-b', 'main', remote)
    const dev = join(root, 'dev')
    git(root, 'clone', remote, dev)
    git(dev, 'checkout', '-B', 'main')

    const stable = o.stable ?? '0.10.0'
    const nextVersion = o.nextVersion ?? '0.10.0-next.1'

    write(dev, 'package.json', pkg('0.9.0'))
    write(dev, 'CHANGELOG.md', '# base\n')
    write(dev, '.release-please/main-manifest.json', manifest('0.9.0'))
    write(dev, '.release-please/next-manifest.json', manifest('0.9.0'))
    write(dev, 'src/a.txt', 'a\n')
    git(dev, 'add', '-A')
    git(dev, 'commit', '-m', 'base')
    git(dev, 'push', 'origin', 'main')

    if (o.next !== false) {
        git(dev, 'checkout', '-b', 'next')
        write(dev, 'package.json', pkg(nextVersion, '{"left-pad": "1.0.0"}'))
        write(dev, '.release-please/next-manifest.json', manifest(nextVersion))
        if (o.conflictSrc) write(dev, 'src/a.txt', 'next\n')
        git(dev, 'add', '-A')
        git(dev, 'commit', '-m', 'next prerelease')
        git(dev, 'push', 'origin', 'next')
        git(dev, 'checkout', 'main')
    }

    write(dev, 'package.json', pkg(stable))
    write(dev, 'CHANGELOG.md', '# base\n## release\n')
    write(dev, '.release-please/main-manifest.json', manifest(stable))
    if (o.conflictSrc) write(dev, 'src/a.txt', 'main\n')
    git(dev, 'add', '-A')
    git(dev, 'commit', '-m', 'release')
    git(dev, 'push', 'origin', 'main')
    const sha = git(dev, 'rev-parse', 'HEAD')

    if (o.premerged) {
        git(dev, 'checkout', 'next')
        git(dev, 'merge', '-s', 'ours', '-m', 'merge main', sha)
        write(dev, '.release-please/next-manifest.json', manifest(stable))
        git(dev, 'add', '-A')
        git(dev, 'commit', '-m', 'reset manifest')
        git(dev, 'push', 'origin', 'next')
    }

    // The job's checkout: a fresh clone of the remote.
    const job = join(root, 'job')
    git(root, 'clone', remote, job)

    const run = () => {
        const r = Bun.spawnSync(
            ['bun', SCRIPT, '--remote', remote, '--tag', `v${stable}`, '--version', stable, '--sha', sha],
            { cwd: job, env: ENV, stdout: 'pipe', stderr: 'pipe' },
        )
        const out = Object.fromEntries(
            r.stdout
                .toString()
                .split('\n')
                .filter(Boolean)
                .map((l) => l.split('=') as [string, string]),
        )
        return { code: r.exitCode, out, err: r.stderr.toString() }
    }
    return { job, run, stable }
}

const readJson = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'))

describe('nextManifestVersion', () => {
    test('a stable release resets next to the stable version', () => {
        expect(nextManifestVersion('0.10.0-next.1', '0.10.0')).toBe('0.10.0')
    })

    test('a hotfix below next keeps next where it is', () => {
        expect(nextManifestVersion('0.10.0-next.1', '0.9.1')).toBe('0.10.0-next.1')
    })

    test('equal versions stay put', () => {
        expect(nextManifestVersion('0.10.0', '0.10.0')).toBe('0.10.0')
    })
})

describe('back-merge', () => {
    test('does nothing when next does not exist yet', () => {
        const s = scenario({ next: false })
        const r = s.run()
        expect(r.code).toBe(0)
        expect(r.out.result).toBe('no-next')
    })

    test('merges main into next, keeping next-only changes in package.json', () => {
        const s = scenario()
        const r = s.run()
        expect(r.code).toBe(0)
        expect(r.out.result).toBe('created')
        expect(r.out.branch).toBe('backmerge/v0.10.0')
        expect(git(s.job, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('backmerge/v0.10.0')
        // A real merge commit: two parents.
        expect(git(s.job, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
        const p = readJson(s.job, 'package.json')
        expect(p.version).toBe('0.10.0')
        expect(p.dependencies['left-pad']).toBe('1.0.0')
        expect(readJson(s.job, '.release-please/next-manifest.json')['.']).toBe('0.10.0')
        expect(readFileSync(join(s.job, 'CHANGELOG.md'), 'utf8')).toContain('## release')
    })

    test('a hotfix release does not regress next numbering', () => {
        const s = scenario({ stable: '0.9.1' })
        const r = s.run()
        expect(r.code).toBe(0)
        expect(r.out.result).toBe('created')
        expect(readJson(s.job, '.release-please/next-manifest.json')['.']).toBe('0.10.0-next.1')
        expect(readJson(s.job, 'package.json').version).toBe('0.10.0-next.1')
    })

    test('fails loudly on a conflict outside the version bookkeeping files', () => {
        const s = scenario({ conflictSrc: true })
        const r = s.run()
        expect(r.code).toBe(1)
        expect(r.err).toContain('src/a.txt')
    })

    test('reports nothing to do when next already has the release', () => {
        const s = scenario({ premerged: true })
        const r = s.run()
        expect(r.code).toBe(0)
        expect(r.out.result).toBe('none')
    })
})
