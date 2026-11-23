import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string) =>
    readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const yaml = (s: string): any => Bun.YAML.parse(s)

const drift = yaml(read('.github/workflows/voidflow-drift.yml'))
const tool = yaml(read('.github/workflows/tool-ci.yml'))
const step = (job: string, id: string) =>
    drift.jobs[job].steps.find((s: any) => s.id === id)

describe('voidflow-drift.yml', () => {
    test('the bun install script is identical to tool-ci', () => {
        const toolInstall = tool.jobs.validate.steps.find(
            (s: any) => s.id === 'install',
        ).run
        expect(step('check', 'install').run).toBe(toolInstall)
    })

    test('only the report job can write issues, and it runs no repo code', () => {
        expect(drift.permissions).toEqual({})
        expect(drift.jobs.check.permissions).toEqual({
            contents: 'read',
            actions: 'read',
        })
        expect(drift.jobs.report.permissions).toEqual({ issues: 'write' })
        const uses = drift.jobs.report.steps.filter((s: any) => s.uses)
        expect(uses).toEqual([])
    })

    test('checks the default branch, whatever ref triggered it', () => {
        const checkout = drift.jobs.check.steps[0]
        expect(checkout.uses).toMatch(/^actions\/checkout@/)
        expect(checkout.with.ref).toBe(
            '${{ github.event.repository.default_branch }}',
        )
        expect(checkout.with['persist-credentials']).toBe(false)
    })

    test('installs from the lockfile for every package manager', () => {
        const runs = drift.jobs.check.steps
            .map((s: any) => s.run ?? '')
            .join('\n')
        expect(runs).toContain('bun install --frozen-lockfile')
        expect(runs).toContain('pnpm install --frozen-lockfile')
        expect(runs).toContain('aube ci')
        expect(runs).not.toContain('npx')
    })
})
