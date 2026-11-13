import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    assertVersionMatchesChannel,
    resolveChannel,
    toOutputs,
} from '../scripts/release-channel'

const text = readFileSync(
    new URL('../.github/workflows/tool-release.yml', import.meta.url),
    'utf8',
)
const wf: any = Bun.YAML.parse(text)
const step = (job: string, name: string) => {
    const s = wf.jobs[job].steps.find((x: any) => x.name === name)
    expect(s, `${job}: ${name}`).toBeDefined()
    return s
}
const publish: any[] = wf.jobs.publish.steps
const index = (name: string) => {
    const i = publish.findIndex((s) => s.name === name)
    expect(i, name).toBeGreaterThanOrEqual(0)
    return i
}

/** Run a workflow step's bash with `env`, in `cwd`; returns outputs + exit. */
function runStep(
    run: string,
    env: Record<string, string>,
    cwd: string,
): { code: number; out: Record<string, string> } {
    const out = join(cwd, 'gh-output')
    writeFileSync(out, '')
    const proc = Bun.spawnSync(['bash', '-c', run], {
        cwd,
        env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, ...env },
        stderr: 'pipe',
    })
    const lines = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean)
    return {
        code: proc.exitCode ?? 1,
        out: Object.fromEntries(lines.map((l) => l.split(/=(.*)/s, 2))),
    }
}

function callerRepo(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'tool-release-'))
    mkdirSync(join(dir, '.release-please'))
    for (const n of names) {
        writeFileSync(join(dir, `.release-please/${n}.json`), '{}')
        writeFileSync(join(dir, `.release-please/${n}-manifest.json`), '{}')
    }
    return dir
}

// The channel step is release-channel.ts rewritten in bash (a reusable
// workflow can't run scripts from voidflow's tree), so check they agree.
describe('tool-release.yml channel step matches release-channel.ts', () => {
    const run: string = step(
        'channel',
        'Resolve release channel from branch',
    ).run
    const repo = callerRepo(['main', 'next', 'maintenance'])

    for (const branch of [
        'main',
        'next',
        'release/0.9.x',
        'release/1.x',
        'release/12.3.x',
    ]) {
        test(branch, () => {
            const { kind, dist_tag, config, manifest } = toOutputs(
                resolveChannel(branch),
            )
            const res = runStep(run, { BRANCH: branch }, repo)
            expect(res.code).toBe(0)
            expect(res.out).toEqual({ kind, dist_tag, config, manifest })
        })
    }

    for (const branch of ['feature/x', 'release/x', 'release/1', 'mainline']) {
        test(`${branch} fails closed`, () => {
            expect(() => resolveChannel(branch)).toThrow()
            expect(runStep(run, { BRANCH: branch }, repo).code).not.toBe(0)
        })
    }

    test("a channel without the caller's config fails", () => {
        const onlyMain = callerRepo(['main'])
        expect(runStep(run, { BRANCH: 'main' }, onlyMain).code).toBe(0)
        expect(runStep(run, { BRANCH: 'next' }, onlyMain).code).not.toBe(0)
    })
})

describe('tool-release.yml tag check matches assertVersionMatchesChannel', () => {
    // Only the version half: cut the tag resolution and ancestry check off.
    const full: string = step(
        'publish',
        'Check tag belongs to this channel',
    ).run
    const run = full.slice(0, full.indexOf('# Resolve the tag once'))
    const repo = callerRepo([])
    const cases: Array<[string, string]> = [
        ['main', '1.2.3'],
        ['main', '1.2.3-next.1'],
        ['next', '1.2.3-next'],
        ['next', '1.2.3-next.4'],
        ['next', '1.2.3'],
        ['release/0.9.x', '0.9.4'],
        ['release/0.9.x', '0.10.0'],
        ['release/1.x', '1.4.0'],
        ['release/1.x', '2.0.0'],
    ]
    for (const [branch, version] of cases) {
        test(`${version} on ${branch}`, () => {
            const channel = resolveChannel(branch)
            let ok = true
            try {
                assertVersionMatchesChannel(version, channel)
            } catch {
                ok = false
            }
            const res = runStep(
                run,
                { BRANCH: branch, KIND: channel.kind, TAG: `v${version}` },
                repo,
            )
            expect(res.code === 0).toBe(ok)
        })
    }
})

// Same guarantees as release-please.yml's publish job (release-workflow.test).
describe('tool-release.yml publish: the npm tarball is attested', () => {
    test('can write attestations, and nothing broader', () => {
        expect(wf.jobs.publish.permissions).toEqual({
            contents: 'read',
            'id-token': 'write',
            attestations: 'write',
        })
        expect(wf.permissions).toEqual({})
    })

    test('runs in the npm environment the caller names', () => {
        expect(wf.jobs.publish.environment).toBe(
            '${{ inputs.npm-environment }}',
        )
        expect(wf.on.workflow_call.inputs['npm-environment'].default).toBe(
            'npm',
        )
    })

    test('packs, then attests, then stages that same file', () => {
        expect(index('Build')).toBeLessThan(index('Pack npm tarball'))
        expect(index('Pack npm tarball')).toBeLessThan(
            index('Attest npm tarball'),
        )
        expect(index('Attest npm tarball')).toBeLessThan(index('Stage on npm'))
        const attest = publish[index('Attest npm tarball')]
        expect(attest.uses).toMatch(/^actions\/attest@v\d+\.\d+\.\d+$/)
        expect(attest.with['subject-path']).toBe(
            '${{ runner.temp }}/npm-pack/*.tgz',
        )
        expect(attest.if).toContain('!inputs.dry-run')
        const stage = publish[index('Stage on npm')]
        expect(stage.env.TARBALL).toBe('${{ steps.pack.outputs.tarball }}')
        expect(stage.run).toContain('npm stage publish "$TARBALL" ')
        expect(stage.run).not.toMatch(/(^|\s)npm publish /m)
    })

    test('builds the exact commit whose ancestry it checked', () => {
        const check = publish[index('Check tag belongs to this channel')]
        expect(check.id).toBe('tag')
        expect(check.run).toContain('git merge-base --is-ancestor "$sha"')
        const tagCheckout = publish.find(
            (s, i) =>
                i > index('Check tag belongs to this channel') &&
                String(s.uses).startsWith('actions/checkout@'),
        )
        expect(tagCheckout?.with.ref).toBe('${{ steps.tag.outputs.sha }}')
    })

    test('checks every bin made it into the tarball', () => {
        const pack: string = publish[index('Pack npm tarball')].run
        expect(pack).toContain('tar -tzf "$file" "package/${bin#./}"')
    })

    test('the approve summary matches scripts/stage-summary.sh', () => {
        const stage: string = publish[index('Stage on npm')].run
        const script = readFileSync(
            new URL('../scripts/stage-summary.sh', import.meta.url),
            'utf8',
        )
        for (const line of [
            'line=$(grep -E \'^\\+ .+ \\(staged with id [0-9a-f-]+\\)\' "$log" | tail -n1 || true)',
            'spec=$(sed -E \'s/^\\+ (.+) \\(staged with id .*/\\1/\' <<<"$line")',
            'id=$(sed -E \'s/.*staged with id ([0-9a-f-]+)\\).*/\\1/\' <<<"$line")',
        ]) {
            expect(script).toContain(line)
            expect(stage).toContain(line)
        }
    })

    test('every job pins its actions to a version tag (commits live in actions.lock)', () => {
        for (const job of Object.values<any>(wf.jobs))
            for (const s of job.steps ?? [])
                if (s.uses) expect(s.uses).toMatch(/@v\d+\.\d+\.\d+$/)
    })
})
