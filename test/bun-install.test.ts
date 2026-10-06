import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const actionScript: string = Bun.YAML.parse(read('actions/bun-install/action.yml')).runs.steps.find(
    (s: any) => s.id === 'install',
).run
const siteCiSteps: any[] = Bun.YAML.parse(read('.github/workflows/site-ci.yml')).jobs.validate.steps
const workflowScript: string = siteCiSteps.find((s: any) => s.id === 'install').run

const socketBunfig = `[install]
minimumReleaseAge = 259200 # 3 days

[install.security]
scanner = "@socketsecurity/bun-security-scanner"
`

// Runs the script in a temp repo with a stub `bun` that records its args and
// the config file it was pointed at.
async function install(script: string, opts: { bunfig?: string; scanner: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'voidflow-bun-install-'))
    const repo = join(root, 'repo')
    const runnerTemp = join(root, 'runner-temp')
    const bin = join(root, 'bin')
    for (const d of [repo, runnerTemp, bin]) mkdirSync(d)
    if (opts.bunfig !== undefined) writeFileSync(join(repo, 'bunfig.toml'), opts.bunfig)
    const log = join(root, 'bun-args')
    writeFileSync(
        join(bin, 'bun'),
        `#!/usr/bin/env bash
# the script's own \`bun -e\` (the TOML check) runs on the real bun; --config=/dev/null keeps the repo bunfig.toml out of it
if [[ " $* " == *" -e "* ]]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
printf '%s\\n' "$@" > ${JSON.stringify(log)}
for a in "$@"; do [[ "$a" == --config=* ]] && cp "\${a#--config=}" ${JSON.stringify(log + '.config')}; done
exit 0
`,
    )
    chmodSync(join(bin, 'bun'), 0o755)
    const proc = Bun.spawn(['bash', '-c', script], {
        cwd: repo,
        env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, SOCKET_SCANNER: String(opts.scanner) },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return {
        code,
        stdout,
        stderr,
        args: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : null,
        config: existsSync(log + '.config') ? readFileSync(log + '.config', 'utf8') : null,
        bunfigAfter: opts.bunfig !== undefined ? readFileSync(join(repo, 'bunfig.toml'), 'utf8') : null,
    }
}

describe('site-ci.yml carries the same install script as actions/bun-install', () => {
    test('scripts are identical (no drift)', () => {
        expect(workflowScript).toBe(actionScript)
    })

    test('the inlined bun step only runs for bun; pnpm has its own install', () => {
        expect(siteCiSteps.find((s: any) => s.id === 'install').if).toBe("inputs.package-manager == 'bun'")
        const pnpm = siteCiSteps.find((s: any) => s.if === "inputs.package-manager == 'pnpm'" && /pnpm install/.test(s.run ?? ''))
        expect(pnpm).toBeDefined()
    })

    test('socket-scanner defaults to off in both', () => {
        expect(Bun.YAML.parse(read('actions/bun-install/action.yml')).inputs['socket-scanner'].default).toBe('false')
        const wf = Bun.YAML.parse(read('.github/workflows/site-ci.yml'))
        expect(wf.on.workflow_call.inputs['socket-scanner'].default).toBe(false)
    })

    test("voidflow's own ci.yml installs through the action", () => {
        const steps = Bun.YAML.parse(read('.github/workflows/ci.yml')).jobs['unit-tests'].steps
        expect(steps.some((s: any) => s.uses === './actions/bun-install')).toBe(true)
        expect(steps.some((s: any) => /bun install/.test(s.run ?? ''))).toBe(false)
    })
})

describe.each([
    ['action', actionScript],
    ['workflow', workflowScript],
])('%s script', (_name, script) => {
    test('off by default: installs with a scanner-free copy of bunfig.toml, other settings kept', async () => {
        const r = await install(script, { bunfig: socketBunfig, scanner: false })
        expect(r.code).toBe(0)
        expect(r.args?.[0]).toBe('install')
        expect(r.args).toContain('--frozen-lockfile')
        expect(r.args?.some((a) => a.startsWith('--config='))).toBe(true)
        expect(Bun.TOML.parse(r.config!)).toEqual({ install: { minimumReleaseAge: 259200, security: {} } })
        expect(r.stdout).toContain('::notice')
        // the checkout's bunfig.toml is left untouched
        expect(r.bunfigAfter).toBe(socketBunfig)
    })

    test('on: plain install, scanner left in place', async () => {
        const r = await install(script, { bunfig: socketBunfig, scanner: true })
        expect(r).toMatchObject({ code: 0, args: ['install', '--frozen-lockfile'] })
        expect(r.stdout).not.toContain('::notice')
    })

    test.each([
        ['no bunfig.toml', undefined],
        ['bunfig.toml without a scanner', '[install]\nminimumReleaseAge = 259200\n'],
        ['a commented-out scanner', '[install.security]\n# scanner = "@socketsecurity/bun-security-scanner"\n'],
    ])('off with %s: plain install, no notice', async (_label, bunfig) => {
        const r = await install(script, { bunfig, scanner: false })
        expect(r).toMatchObject({ code: 0, args: ['install', '--frozen-lockfile'] })
        expect(r.stdout).not.toContain('::notice')
    })

    test.each([
        ['[install] security.scanner', '[install]\nsecurity.scanner = "x"\n'],
        ['top-level install.security.scanner', 'install.security.scanner = "x"\n'],
    ])('off strips the dotted form: %s', async (_label, bunfig) => {
        const r = await install(script, { bunfig, scanner: false })
        expect(r.code).toBe(0)
        expect(Bun.TOML.parse(r.config!).install?.security?.scanner).toBeUndefined()
    })

    test.each([
        ['an inline table', '[install]\nsecurity = { scanner = "x" }\n'],
        ['a `scanner` key in another table too', '[install.security]\nscanner = "x"\n\n[other]\nscanner = "y"\n'],
        ['invalid TOML', '[install.security\nscanner = "x"\n'],
    ])('off fails closed when it cannot remove the scanner cleanly: %s', async (_label, bunfig) => {
        const r = await install(script, { bunfig, scanner: false })
        expect(r.code).toBe(1)
        expect(r.stdout).toContain('::error')
        expect(r.args).toBeNull()
    })

    test('off only touches the scanner key, not other values that mention "scanner"', async () => {
        const bunfig = `[install]
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = ["foo-scanner"]

[install.security]
scanner = "@socketsecurity/bun-security-scanner"

[other]
tool = { scanner = "y" }
`
        const r = await install(script, { bunfig, scanner: false })
        expect(r.code).toBe(0)
        expect(Bun.TOML.parse(r.config!)).toEqual({
            install: { minimumReleaseAge: 259200, minimumReleaseAgeExcludes: ['foo-scanner'], security: {} },
            other: { tool: { scanner: 'y' } },
        })
    })
})

// End-to-end against the real bun: `--config=` must replace (not merge with)
// the repo's bunfig.toml, or the scanner would still run. A local fake scanner
// and a file: dependency keep this offline.
describe('real bun', () => {
    function fixture(bunfig: string) {
        const repo = mkdtempSync(join(tmpdir(), 'voidflow-bun-real-'))
        mkdirSync(join(repo, 'node_modules/fake-scanner'), { recursive: true })
        mkdirSync(join(repo, 'dep'))
        writeFileSync(
            join(repo, 'node_modules/fake-scanner/package.json'),
            '{"name":"fake-scanner","version":"1.0.0","type":"module","main":"index.js"}',
        )
        writeFileSync(
            join(repo, 'node_modules/fake-scanner/index.js'),
            'export const scanner = { version: "1", async scan() { console.error("FAKE SCANNER RAN"); return [] } }',
        )
        writeFileSync(join(repo, 'dep/package.json'), '{"name":"dep","version":"1.0.0"}')
        writeFileSync(join(repo, 'package.json'), '{"name":"fixture","dependencies":{"dep":"file:./dep"}}')
        writeFileSync(join(repo, 'bunfig.toml'), bunfig)
        // lockfile for --frozen-lockfile
        Bun.spawnSync(['bun', 'install', '--config=/dev/null'], { cwd: repo })
        return repo
    }

    async function run(scanner: boolean) {
        const repo = fixture('[install.security]\nscanner = "fake-scanner"\n')
        const runnerTemp = mkdtempSync(join(tmpdir(), 'voidflow-runner-temp-'))
        const proc = Bun.spawn(['bash', '-c', actionScript], {
            cwd: repo,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, SOCKET_SCANNER: String(scanner) },
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const code = await proc.exited
        return { code, output: (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text()) }
    }

    test('off: the scanner does not run', async () => {
        const r = await run(false)
        expect(r.code).toBe(0)
        expect(r.output).not.toContain('FAKE SCANNER RAN')
    })

    test('on: the scanner runs', async () => {
        const r = await run(true)
        expect(r.code).toBe(0)
        expect(r.output).toContain('FAKE SCANNER RAN')
    })
})
