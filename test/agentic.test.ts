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

    // It judges; Renovate and GitHub auto-merge act. Adding any of these is a major.
    test('never approves, merges or pushes', () => {
        expect(Object.keys(outputs).sort()).toEqual(
            ['add-comment', 'add-labels', 'create-check-run', 'remove-labels'].sort(),
        )
    })

    // Renaming the check or the labels breaks callers' required checks and filters.
    test('posts the deps-review check and only its two labels', () => {
        expect(outputs['create-check-run'].name).toBe('deps-review')
        const labels = ['deps:low-risk', 'deps:needs-you']
        expect(outputs['add-labels'].allowed).toEqual(labels)
        expect(outputs['remove-labels'].allowed).toEqual(labels)
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

    test('automerges only low-risk update types on 1.0+ versions', () => {
        expect(preset.packageRules).toHaveLength(1)
        expect(rule.matchUpdateTypes).not.toContain('major')
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
