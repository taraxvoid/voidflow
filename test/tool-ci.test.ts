import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const wf: any = Bun.YAML.parse(read('.github/workflows/tool-ci.yml'))
const job = wf.jobs.validate
const steps: any[] = job.steps
const step = (name: string) => steps.find((s) => s.name === name)
const siteJobs = Bun.YAML.parse(read('.github/workflows/site-ci.yml')).jobs
const siteSteps: any[] = siteJobs.validate.steps
const siteStep = (name: string) => siteSteps.find((s) => s.name === name)
const actionInstall: string = Bun.YAML.parse(read('actions/bun-install/action.yml')).runs.steps.find(
    (s: any) => s.id === 'install',
).run

describe('tool-ci.yml shape', () => {
    test('is reusable only, with runner and socket-scanner inputs', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_call'])
        expect(wf.on.workflow_call.inputs.runner.default).toBe('ubuntu-latest')
        expect(wf.on.workflow_call.inputs['socket-scanner'].default).toBe(false)
        expect(wf.on.workflow_call.inputs['package-manager']).toBeUndefined()
    })

    test('job reports as "Validate" and skips drafts', () => {
        expect(job.name).toBe('Validate')
        expect(job['runs-on']).toBe('${{ inputs.runner }}')
        expect(job.if).toBe('github.event.pull_request.draft == false')
    })

    test('asks only for read permissions', () => {
        expect(wf.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
    })

    test('checkout keeps full history for gitleaks and drops credentials', () => {
        expect(steps[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
        expect(steps[0].with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false })
    })

    test('every action is pinned to a full SHA', () => {
        for (const s of steps.filter((s) => s.uses)) {
            expect(s.uses).toMatch(/@[0-9a-f]{40}$/)
        }
    })
})

describe('tool-ci.yml shares its steps with site-ci and actions/bun-install', () => {
    test('install script is identical to actions/bun-install', () => {
        expect(steps.find((s) => s.id === 'install').run).toBe(actionInstall)
    })

    test.each(['Secrets Scan', 'Lint CI workflows'])('"%s" is identical to site-ci', (name) => {
        expect(step(name).run).toBe(siteStep(name).run)
    })

    test('zizmor pin matches the justfile', () => {
        const pinned = read('justfile').match(/^zizmor_version := "([^"]+)"/m)![1]
        expect(step('Audit CI workflows').run).toBe(`uvx zizmor@${pinned} --min-severity medium .github`)
    })
})

describe('tool-ci.yml optional inputs', () => {
    test('uses .bun-version only when the repo has one', () => {
        const setup = steps.find((s) => /^oven-sh\/setup-bun@/.test(s.uses ?? ''))
        expect(setup.with['bun-version-file']).toBe("${{ hashFiles('.bun-version') != '' && '.bun-version' || '' }}")
    })

    test('runs mise-action only when the repo has a mise.toml', () => {
        const mise = steps.find((s) => /^jdx\/mise-action@/.test(s.uses ?? ''))
        expect(mise.if).toBe("hashFiles('mise.toml') != ''")
    })
})

describe('tool-ci.yml script steps', () => {
    test('detects exactly the scripts it runs', () => {
        expect(step('Detect package scripts').run).toContain('for name in lint check build test check:licenses; do')
    })

    test.each([
        ['Lint', 'lint'],
        ['Typecheck', 'check'],
        ['Build', 'build'],
        ['Test', 'test'],
    ])('%s runs `bun run %s` only when defined', (name, script) => {
        expect(step(name).run).toBe(`bun run ${script}`)
        expect(step(name).if).toBe(`steps.scripts.outputs.${script} == 'true'`)
    })

    test('licenses run when deps or scripts changed', () => {
        expect(step('Check licenses').if).toBe(
            "steps.scripts.outputs.check_licenses == 'true' && (steps.changes.outputs.lockfile == 'true' || steps.changes.outputs.manifest == 'true' || steps.changes.outputs.scripts == 'true')",
        )
    })

    test('workflow linting and zizmor run only when workflows changed', () => {
        for (const name of ['Lint CI workflows', 'Setup uv', 'Audit CI workflows']) {
            expect(step(name).if).toBe("steps.changes.outputs.workflows == 'true'")
        }
    })
})

describe('SARIF for code scanning', () => {
    const sarifSteps = ['Setup uv (SARIF)', 'zizmor SARIF', 'Keep SARIF']

    test.each(sarifSteps)('"%s" is identical to site-ci and runs after failures', (name) => {
        expect(step(name)).toEqual(siteStep(name))
        expect(step(name).if).toStartWith('${{ !cancelled()')
    })

    test('the SARIF steps come last, after every gate', () => {
        expect(steps.slice(-3).map((s) => s.name)).toEqual(sarifSteps)
        expect(siteSteps.slice(-3).map((s) => s.name)).toEqual(sarifSteps)
    })

    test('gitleaks writes SARIF but still gates', () => {
        const run: string = step('Secrets Scan').run
        expect(run).toContain('--report-format sarif --report-path "$RUNNER_TEMP/sarif/gitleaks.sarif"')
        expect(step('Secrets Scan').if).toBeUndefined()
        expect(step('Secrets Scan')['continue-on-error']).toBeUndefined()
    })

    test('zizmor SARIF uses the justfile pin and scans all workflows', () => {
        const pinned = read('justfile').match(/^zizmor_version := "([^"]+)"/m)![1]
        expect(step('zizmor SARIF').run).toContain(`uvx zizmor@${pinned} --format sarif .github > "$RUNNER_TEMP/sarif/zizmor.sarif"`)
        expect(step('zizmor SARIF').if).not.toContain('steps.changes')
    })

    test('kept as the voidflow-sarif artifact', () => {
        expect(step('Keep SARIF').with.name).toBe('voidflow-sarif')
    })
})

describe('upload-sarif.yml', () => {
    const up: any = Bun.YAML.parse(read('.github/workflows/upload-sarif.yml'))
    const upSteps: any[] = up.jobs.upload.steps

    test('is reusable only and is the one workflow asking for security-events', () => {
        expect(Object.keys(up.on)).toEqual(['workflow_call'])
        expect(up.permissions).toEqual({ contents: 'read', actions: 'read', 'security-events': 'write' })
        for (const f of ['site-ci.yml', 'tool-ci.yml']) {
            const w: any = Bun.YAML.parse(read(`.github/workflows/${f}`))
            expect(JSON.stringify(w)).not.toContain('security-events')
        }
    })

    test('reads the artifact the validate workflows keep', () => {
        expect(upSteps[0].with.name).toBe(step('Keep SARIF').with.name)
        expect(upSteps[0]['continue-on-error']).toBe(true)
    })

    test('one upload per tool, categorized by tool name', () => {
        const uploads = upSteps.filter((s) => /upload-sarif@/.test(s.uses ?? ''))
        expect(uploads.map((s) => s.with.category)).toEqual(['gitleaks', 'zizmor'])
        for (const s of upSteps.filter((s) => s.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/)
    })
})
