import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = new URL('../lefthook/site.yml', import.meta.url).pathname
const hasLefthook = Bun.which('lefthook') !== null

describe('lefthook/site.yml', () => {
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
        expect(text).toContain('pnpm-lock.yaml ]; then echo pnpm; else echo bun')
        expect(text).not.toMatch(/\bbun run\b/)
    })

    test('audit step only runs when the site defines an audit script', async () => {
        const text = await Bun.file(config).text()
        expect(text).toContain('grep -q \'"audit"\' package.json')
        expect(text).not.toContain('--if-present audit')
    })
})

describe('lefthook/site.yml pre-push', () => {
    const ZERO = '0'.repeat(40)

    // The hook's script with lefthook's {1} (remote name) and {pm} filled in;
    // {pm} becomes an echo so the test sees whether test:push would run.
    const script = async () => {
        const parsed = Bun.YAML.parse(await Bun.file(config).text()) as {
            'pre-push': { commands: { 'sync-and-test': { run: string } } }
        }
        return parsed['pre-push'].commands['sync-and-test'].run
            .replaceAll('{1}', 'origin')
            .replaceAll('{pm}', 'echo PM')
    }

    const git = (cwd: string, ...args: string[]) => {
        const proc = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })
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
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'pushed')
        git(repo, 'remote', 'add', 'origin', remote)
        git(repo, 'push', '-q', 'origin', 'main')
        mkdirSync(join(repo, 'node_modules'))
        return { repo, pushed: git(repo, 'rev-parse', 'HEAD') }
    }

    const run = async (repo: string, stdin: string) => {
        const proc = Bun.spawn(['sh', '-c', await script()], {
            cwd: repo,
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
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'new')
        const head = git(repo, 'rev-parse', 'HEAD')
        const { code, out } = await run(repo, `refs/heads/main ${head} refs/heads/main ${pushed}\n`)
        expect(code).toBe(0)
        expect(out).toContain('PM run --if-present test:push')
    })

    test('runs checks when a tag push also carries a new commit', async () => {
        const { repo, pushed } = setup()
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'new')
        const head = git(repo, 'rev-parse', 'HEAD')
        const stdin = `refs/tags/v1 ${pushed} refs/tags/v1 ${ZERO}\nrefs/heads/main ${head} refs/heads/main ${pushed}\n`
        const { out } = await run(repo, stdin)
        expect(out).toContain('PM run --if-present test:push')
    })
})
