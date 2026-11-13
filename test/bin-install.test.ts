import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The published bin, installed from the packed tarball by each package
// manager the README names, then run the way an infra repo would. A manager
// not on PATH skips, except under CI where bun and npm must be present.

const ROOT = resolve(import.meta.dir, '..')

const MANAGERS: [name: string, add: (tgz: string) => string[]][] = [
    ['bun', (tgz) => ['bun', 'add', tgz]],
    ['npm', (tgz) => ['npm', 'install', '--no-audit', '--no-fund', tgz]],
    ['pnpm', (tgz) => ['pnpm', 'add', tgz]],
    ['aube', (tgz) => ['aube', 'add', tgz]],
]

const onPath = (cmd: string) => Bun.which(cmd) !== null

for (const required of ['bun', 'npm'])
    if (process.env.CI && !onPath(required))
        throw new Error(
            `CI needs ${required} on PATH for the bin install tests`,
        )

let dir = ''
let tgz = ''
beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'voidflow-bin-install-'))
    const pack = Bun.spawnSync(
        ['bun', 'pm', 'pack', '--destination', dir, '--quiet'],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    if (pack.exitCode !== 0)
        throw new Error(`bun pm pack failed:\n${pack.stderr}`)
    tgz = resolve(dir, pack.stdout.toString().trim().split('\n').pop()!)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(cmd: string[], cwd: string, home: string) {
    const r = Bun.spawnSync(cmd, {
        cwd,
        env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            VOIDFLOW_CONFIG: '',
            VOIDFLOW_CONFIG_BASE: '',
            CF_TOKEN_ADMIN: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    return {
        code: r.exitCode,
        out: r.stdout.toString(),
        err: r.stderr.toString(),
    }
}

describe.each(MANAGERS)('installed with %s', (name, add) => {
    test.skipIf(!onPath(name))(
        'the bin runs the verbs',
        () => {
            const project = join(dir, name)
            const home = join(dir, `${name}-home`)
            mkdirSync(project)
            mkdirSync(home)
            writeFileSync(
                join(project, 'package.json'),
                '{"name": "infra", "private": true, "type": "module"}',
            )
            // A throwaway npm user config and cache: the tarball's deps are
            // public, and the user's own .npmrc and cache stay out of it.
            writeFileSync(join(dir, 'npmrc'), '')
            const install = Bun.spawnSync(add(tgz), {
                cwd: project,
                env: {
                    ...process.env,
                    npm_config_userconfig: join(dir, 'npmrc'),
                    npm_config_cache: join(dir, 'npm-cache'),
                },
                stdout: 'pipe',
                stderr: 'pipe',
            })
            expect({
                name,
                code: install.exitCode,
                err: install.exitCode ? install.stderr.toString() : '',
            }).toEqual({ name, code: 0, err: '' })

            const bin = join(project, 'node_modules', '.bin', 'voidflow')
            const help = run([bin, 'plan', '--help'], project, home)
            expect({ name, code: help.code }).toEqual({ name, code: 0 })
            expect(help.out).toContain('usage: voidflow plan')

            const apply = run([bin, 'apply', 'rulesets'], project, home)
            expect({ name, code: apply.code }).toEqual({ name, code: 2 })
            expect(apply.err).toContain('no rulesets.ts found')
        },
        120_000,
    )
})
