import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const yaml = (p: string): any => Bun.YAML.parse(read(p))
const frontmatter = (p: string): any => {
    const m = read(p).match(/^---\n([\s\S]*?)\n---\n/)
    if (!m) throw new Error(`${p} has no frontmatter`)
    return Bun.YAML.parse(m[1])
}

const BOTS = ['renovate[bot]', 'dependabot[bot]']

describe('agentic package (agentic/aw.yml)', () => {
    test('lists exactly the workflows in agentic/workflows', () => {
        const manifest = yaml('agentic/aw.yml')
        const onDisk = readdirSync(new URL('../agentic/workflows', import.meta.url))
            .filter((f) => f.endsWith('.md'))
            .map((f) => `workflows/${f}`)
            .sort()
        expect(manifest['manifest-version']).toBe('1')
        expect([...manifest.files].sort()).toEqual(onDisk)
    })
})

describe('deps-review agent', () => {
    const fm = frontmatter('agentic/workflows/deps-review.md')
    const outputs = fm['safe-outputs']

    test('only the dependency bots (or a manual run) start it', () => {
        expect(fm.on.bots).toEqual(BOTS)
        for (const bot of BOTS) expect(fm.if).toContain(`github.event.pull_request.user.login == '${bot}'`)
        expect(fm.if).toContain("github.event_name == 'workflow_dispatch'")
    })

    test('the agent job only reads', () => {
        for (const level of Object.values(fm.permissions)) expect(level).toBe('read')
        expect(fm.tools.github['read-only']).toBe(true)
    })

    // It judges; Renovate and GitHub auto-merge act. Adding any write power is a major.
    test('the model never approves, merges, pushes or posts the check itself', () => {
        expect(Object.keys(outputs).sort()).toEqual(['add-comment', 'add-labels', 'jobs', 'remove-labels'])
        expect(Object.keys(outputs.jobs)).toEqual(['deps-gate'])
    })

    // Renaming the labels breaks callers' filters.
    test('applies only its two labels', () => {
        const labels = ['deps:low-risk', 'deps:needs-you']
        expect(outputs['add-labels'].allowed).toEqual(labels)
        expect(outputs['remove-labels'].allowed).toEqual(labels)
    })

    describe('deps-gate job (owns the deps-review check)', () => {
        const gate = outputs.jobs['deps-gate']
        const script = gate.steps.find((s: any) => s.name === 'Gate')

        test('can write checks and nothing else', () => {
            expect(gate.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', checks: 'write' })
        })

        // The model can only make the gate stricter.
        test('posts success only when the model says low-risk and deps-signals is clean', () => {
            expect(script.run).toContain('[ "$verdicts" = "low-risk" ] && [ "$clean" = "true" ]')
            expect(script.run).toContain('conclusion=failure')
            expect(script.run).toContain('name: "deps-review"')
            expect(script.run).toContain('deps-signals --base "$base" --head "$head"')
        })

        test('evaluates the commit the agent reviewed and posts only while it is still the head', () => {
            expect(script.env.EVENT_HEAD).toBe('${{ github.event.pull_request.head.sha }}')
            expect(script.run).toContain('if [ "$(pr headRefOid)" != "$head" ]')
        })

        // release-please rewrites the marked line, so a release's workflow runs that release's deps-signals.
        test('runs the deps-signals of the voidflow release it ships in', () => {
            const pkg = JSON.parse(read('package.json'))
            expect(script.env.VOIDFLOW).toBe(pkg.version)
            expect(read('agentic/workflows/deps-review.md')).toContain(`VOIDFLOW: "${pkg.version}" # x-release-please-version`)
            for (const f of ['next', 'main', 'maintenance']) {
                const cfg = JSON.parse(read(`.release-please/${f}.json`))
                expect(cfg.packages['.']['extra-files']).toContainEqual({
                    type: 'generic',
                    path: 'agentic/workflows/deps-review.md',
                })
            }
            expect(pkg.bin['deps-signals']).toBe('scripts/deps-signals.ts')
            expect(pkg.files).toContain('scripts/deps-signals.ts')
        })
    })
})

describe('deps-review-gate.yml', () => {
    const wf = yaml('.github/workflows/deps-review-gate.yml')
    const jobs = Object.entries<any>(wf.jobs)

    // A skipped job named deps-review would count as a passing deps-review check.
    test('no job is named deps-review', () => {
        for (const [id, job] of jobs) {
            expect(id).not.toBe('deps-review')
            expect(job.name).not.toBe('deps-review')
        }
    })

    test('posts the pass-through only on PRs the bots did not open', () => {
        const [, job] = jobs[0]
        expect(jobs).toHaveLength(1)
        for (const bot of BOTS) expect(job.if).toContain(`github.event.pull_request.user.login != '${bot}'`)
        expect(job.steps[0].run).toContain('-f name=deps-review')
        expect(wf.permissions).toEqual({ checks: 'write' })
    })
})

describe('agentic-locks.yml', () => {
    test('defaults to the gh-aw version voidflow compiles its own package with', () => {
        const wf = yaml('.github/workflows/agentic-locks.yml')
        const ci = yaml('.github/workflows/ci.yml')
        const step = ci.jobs.validation.steps.find((s: any) => s.name === 'Compile agentic package')
        expect(wf.on.workflow_call.inputs['gh-aw-version'].default).toBe(step.env.GH_AW_VERSION)
        expect(wf.permissions).toEqual({ contents: 'read' })
    })
})

describe('renovate preset (deps-review-automerge.json)', () => {
    const preset = JSON.parse(read('deps-review-automerge.json'))
    const [rule] = preset.packageRules

    // Lockfile maintenance is out: deps-signals can't verify transitive updates.
    test('automerges only low-risk update types on 1.0+ versions', () => {
        expect(preset.packageRules).toHaveLength(1)
        expect(rule.matchUpdateTypes).toEqual(['patch', 'minor', 'digest', 'pin'])
        expect(rule.matchCurrentVersion).toBe('!/^0/')
        expect(rule.automerge).toBe(true)
    })

    // GitHub auto-merge waits for required checks on the current head; Renovate's
    // own merge only sees checks that already exist, which races the agent.
    test('hands the merge to GitHub auto-merge', () => {
        expect(rule.platformAutomerge).toBe(true)
    })

    test('the base preset does not automerge on its own', () => {
        const base = JSON.parse(read('default.json'))
        expect(base.automerge ?? false).toBe(false)
        for (const r of base.packageRules) expect(r.automerge ?? false).toBe(false)
    })
})
