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
        expect(text).toContain('pnpm-lock.yaml ]; then echo pnpm; else echo bun')
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
    Bun.spawnSync(['git', 'init', '-q', repo], { env: { PATH: process.env.PATH, HOME: root } })
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
        stdin: new Blob([stdin]),
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
    const pushStdin = `refs/heads/x ${'1'.repeat(40)} refs/heads/x ${'0'.repeat(40)}\n`

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
