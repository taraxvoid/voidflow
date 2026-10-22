import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const actionScript: string = Bun.YAML.parse(read('actions/branch-env-map/action.yml')).runs.steps.find(
    (s: any) => s.id === 'map',
).run

async function map(script: string, ref: string, event: string) {
    const out = join(mkdtempSync(join(tmpdir(), 'voidflow-env-')), 'out')
    await Bun.write(out, '')
    const proc = Bun.spawn(['bash', '-c', script], {
        env: {
            PATH: process.env.PATH,
            REF_NAME: ref,
            EVENT_NAME: event,
            GITHUB_OUTPUT: out,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const code = await proc.exited
    return { code, env: readFileSync(out, 'utf8').trim() }
}

describe('action script', () => {
    test.each([
        ['main', 'push', 'env=prod'],
        ['123/merge', 'pull_request', 'env=preview'],
        ['feature/x', 'pull_request', 'env=preview'],
    ])('%s on %s', async (ref, event, expected) => {
        expect(await map(actionScript, ref, event)).toEqual({ code: 0, env: expected })
    })

    test.each([
        ['feature/x', 'push'],
        ['next', 'push'],
        ['live', 'push'],
    ])('rejects %s on %s', async (ref, event) => {
        expect((await map(actionScript, ref, event)).code).toBe(1)
    })
})

describe('single-environment is the only mode', () => {
    test('branch-env-map declares no inputs', () => {
        expect(Bun.YAML.parse(read('actions/branch-env-map/action.yml')).inputs).toBeUndefined()
    })

    test('site-ci.yml has no single-environment input or tier step', () => {
        const wf = Bun.YAML.parse(read('.github/workflows/site-ci.yml'))
        expect(Object.keys(wf.on.workflow_call.inputs)).not.toContain('single-environment')
        expect(wf.jobs.validate.steps.find((s: any) => s.id === 'tier')).toBeUndefined()
    })
})
