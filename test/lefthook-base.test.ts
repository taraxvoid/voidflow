import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = new URL('../lefthook/base.yml', import.meta.url).pathname
const hasLefthook = Bun.which('lefthook') !== null

describe('lefthook/base.yml', () => {
    test.skipIf(!hasLefthook)('is a valid lefthook config', async () => {
        const proc = Bun.spawn(['lefthook', 'validate'], {
            env: { ...process.env, LEFTHOOK_CONFIG: config },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const code = await proc.exited
        expect(code).toBe(0)
    })

    test('exists', () => {
        expect(existsSync(config)).toBe(true)
    })

    test('defines the three hooks every site gets', async () => {
        const text = await Bun.file(config).text()
        for (const hook of ['pre-commit:', 'commit-msg:', 'pre-push:']) {
            expect(text).toContain(`\n${hook}`)
        }
    })
    test('pre-commit unit step prefers test:unit:precommit when a site defines it', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('grep -q \'"test:unit:precommit"\' package.json')
        expect(text).toContain('{pm} run test:unit:precommit')
        expect(text).toContain('{pm} run --if-present test:unit')
    })

    test('pre-commit typecheck step prefers check:precommit when a site defines it', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('grep -q \'"check:precommit"\' package.json')
        expect(text).toContain('{pm} run check:precommit')
        expect(text).toContain('{pm} run --if-present check\n')
    })

    test('picks the package manager from the lockfile instead of hardcoding bun', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('then echo aube; elif [ -f pnpm-lock.yaml ]; then echo pnpm; else echo bun')
        expect(text).toContain("grep -q 'packageManager.*aube@' package.json")
        expect(text).not.toMatch(/\bbun run\b/)
    })

    test('audit step only runs when the site defines an audit script', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('grep -q \'"audit"\' package.json')
        expect(text).not.toContain('--if-present audit')
    })
})

const hooks: any = Bun.YAML.parse(readFileSync(config, 'utf8'))
const unitRun: string = hooks['pre-commit'].commands.unit.run
const pushRun: string = hooks['pre-push'].commands['sync-and-test'].run

// Runs a hook snippet in a temp repo with git's hook env exported, `{pm}`
// swapped for a stub that records its env and whether git still finds the
// repo from cwd.
async function runHook(snippet: string, stdin = '') {
    // realpath so `git rev-parse --show-toplevel` compares equal on macOS (/private/var)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'voidflow-lefthook-')))
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    mkdirSync(bin)
    mkdirSync(repo)
    // Clean env: if bun test itself runs inside a git hook, an inherited
    // GIT_DIR would point this init at the wrong repo.
    const cleanEnv = { PATH: process.env.PATH, HOME: root }
    Bun.spawnSync(['git', 'init', '-q', repo], { env: cleanEnv })
    // A real commit, so pre-push's "is this commit new to the remote" check
    // (`git rev-list ... --not --remotes`) can resolve the pushed sha.
    Bun.spawnSync(
        ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'x'],
        { cwd: repo, env: cleanEnv },
    )
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo, env: cleanEnv }).stdout.toString().trim()
    mkdirSync(join(repo, 'node_modules'))
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test:unit":"x","test:push":"x"}}')
    const out = join(root, 'out')
    writeFileSync(
        join(bin, 'stubpm'),
        `#!/bin/sh\nenv > ${JSON.stringify(out + '.env')}\ngit rev-parse --show-toplevel > ${JSON.stringify(out + '.top')} 2>&1\n`,
    )
    chmodSync(join(bin, 'stubpm'), 0o755)
    const script = snippet.replaceAll('{pm}', 'stubpm').replaceAll('{1}', '')
    const proc = Bun.spawn(['sh', '-c', script], {
        cwd: repo,
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: root,
            GIT_DIR: join(repo, '.git'),
            GIT_INDEX_FILE: join(repo, '.git', 'index'),
            GIT_WORK_TREE: repo,
        },
        stdin: new Blob([stdin.replaceAll('{head}', head)]),
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const code = await proc.exited
    return {
        code,
        repo,
        env: existsSync(out + '.env') ? readFileSync(out + '.env', 'utf8') : '',
        top: existsSync(out + '.top') ? readFileSync(out + '.top', 'utf8').trim() : '',
    }
}

describe('git env cleanup before tests', () => {
    // A pushed branch with a new commit, so sync-and-test doesn't take the
    // "nothing new to push" exit. `{1}` (remote) is empty, so no fetch.
    // `{head}` is the temp repo's real commit (see runHook).
    const pushStdin = `refs/heads/x {head} refs/heads/x ${'0'.repeat(40)}\n`

    test.each([
        ['pre-commit unit', unitRun, ''],
        ['pre-push sync-and-test', pushRun, pushStdin],
    ])('%s: test script sees no GIT_* vars and git still finds the repo', async (_name, run, stdin) => {
        const r = await runHook(run, stdin)
        expect(r.code).toBe(0)
        expect(r.env).not.toMatch(/^GIT_DIR=/m)
        expect(r.env).not.toMatch(/^GIT_INDEX_FILE=/m)
        expect(r.env).not.toMatch(/^GIT_WORK_TREE=/m)
        expect(r.top).toBe(r.repo)
    })

    test("uses git's own list of repo-local vars", () => {
        for (const run of [unitRun, pushRun]) {
            expect(run).toContain('unset $(git rev-parse --local-env-vars)')
        }
    })

    test('pre-push unsets only after the remote check, which needs the repo env', () => {
        expect(pushRun.indexOf('unset $(git rev-parse')).toBeGreaterThan(pushRun.indexOf('git merge-base'))
        expect(pushRun.indexOf('unset $(git rev-parse')).toBeLessThan(pushRun.indexOf('{pm} run --if-present test:push'))
    })
})

describe('lefthook/base.yml pre-push new-commit detection', () => {
    const ZERO = '0'.repeat(40)
    // Clean env: if bun test itself runs inside a git hook, an inherited
    // GIT_DIR would point these git calls at the wrong repo.
    const env = () => ({ PATH: process.env.PATH, HOME: tmpdir() })

    // The hook's script with lefthook's {1} (remote name) filled in and {pm}
    // made an echo, so the test sees whether test:push would run.
    const script = pushRun.replaceAll('{1}', 'origin').replaceAll('{pm}', 'echo PM')

    const git = (cwd: string, ...args: string[]) => {
        const proc = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: env() })
        if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr}`)
        return proc.stdout.toString().trim()
    }

    // A clone with one commit already on origin/main, plus node_modules so
    // the hook gets past its install check.
    const setup = () => {
        const root = mkdtempSync(join(tmpdir(), 'prepush-'))
        const remote = join(root, 'remote.git')
        const repo = join(root, 'repo')
        git(root, 'init', '-q', '--bare', '-b', 'main', remote)
        git(root, 'init', '-q', '-b', 'main', repo)
        git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'pushed')
        git(repo, 'remote', 'add', 'origin', remote)
        git(repo, 'push', '-q', '--no-verify', 'origin', 'main')
        mkdirSync(join(repo, 'node_modules'))
        return { repo, pushed: git(repo, 'rev-parse', 'HEAD') }
    }

    const run = async (repo: string, stdin: string) => {
        const proc = Bun.spawn(['sh', '-c', script], {
            cwd: repo,
            env: env(),
            stdin: new Blob([stdin]),
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const code = await proc.exited
        return { code, out: await new Response(proc.stdout).text() }
    }

    test('skips checks for a branch delete', async () => {
        const { repo, pushed } = setup()
        const { code, out } = await run(repo, `(delete) ${ZERO} refs/heads/old ${pushed}\n`)
        expect(code).toBe(0)
        expect(out).toContain('no new commits to push')
        expect(out).not.toContain('PM run')
    })

    test('skips checks for a new branch at an already-pushed commit', async () => {
        const { repo, pushed } = setup()
        const { out } = await run(repo, `refs/heads/feature ${pushed} refs/heads/feature ${ZERO}\n`)
        expect(out).toContain('no new commits to push')
        expect(out).not.toContain('PM run')
    })

    test('skips checks for a tag on an already-pushed commit', async () => {
        const { repo, pushed } = setup()
        const { out } = await run(repo, `refs/tags/v1 ${pushed} refs/tags/v1 ${ZERO}\n`)
        expect(out).toContain('no new commits to push')
        expect(out).not.toContain('PM run')
    })

    test('runs checks when a commit is not on the remote yet', async () => {
        const { repo, pushed } = setup()
        git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'new')
        const head = git(repo, 'rev-parse', 'HEAD')
        const { code, out } = await run(repo, `refs/heads/main ${head} refs/heads/main ${pushed}\n`)
        expect(code).toBe(0)
        expect(out).toContain('PM run --if-present test:push')
    })

    test('runs checks when a tag push also carries a new commit', async () => {
        const { repo, pushed } = setup()
        git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'new')
        const head = git(repo, 'rev-parse', 'HEAD')
        const stdin = `refs/tags/v1 ${pushed} refs/tags/v1 ${ZERO}\nrefs/heads/main ${head} refs/heads/main ${pushed}\n`
        const { out } = await run(repo, stdin)
        expect(out).toContain('PM run --if-present test:push')
    })
})
