import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const actionScript: string = Bun.YAML.parse(read('actions/branch-env-map/action.yml')).runs.steps.find(
    (s: any) => s.id === 'map',
).run
const workflowScript: string = Bun.YAML.parse(read('.github/workflows/resolve-env.yml')).jobs[
    'resolve-env'
].steps.find((s: any) => s.id === 'map').run

async function map(script: string, ref: string, event: string, single: boolean) {
    const out = join(mkdtempSync(join(tmpdir(), 'voidflow-env-')), 'out')
    await Bun.write(out, '')
    const proc = Bun.spawn(['bash', '-c', script], {
        env: {
            PATH: process.env.PATH,
            REF_NAME: ref,
            EVENT_NAME: event,
            SINGLE: String(single),
            GITHUB_OUTPUT: out,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const code = await proc.exited
    return { code, env: readFileSync(out, 'utf8').trim() }
}

describe('resolve-env.yml carries the same mapping as branch-env-map', () => {
    test('scripts are identical (no drift)', () => {
        expect(workflowScript).toBe(actionScript)
    })

    test('resolve-env.yml has no `uses` steps (a local ./actions path or checkout cannot work cross-repo)', () => {
        const steps = Bun.YAML.parse(read('.github/workflows/resolve-env.yml')).jobs['resolve-env'].steps
        expect(steps.filter((s: any) => s.uses)).toEqual([])
    })
})

describe.each([
    ['action', actionScript],
    ['workflow', workflowScript],
])('%s script', (_name, script) => {
    test.each([
        ['main', 'push', 'env=dev'],
        ['next', 'push', 'env=staging'],
        ['live', 'push', 'env=prod'],
    ])('default mode: %s on %s', async (ref, event, expected) => {
        expect(await map(script, ref, event, false)).toEqual({ code: 0, env: expected })
    })

    test('default mode rejects unknown branches', async () => {
        expect((await map(script, 'feature/x', 'push', false)).code).toBe(1)
    })

    test.each([
        ['main', 'push', 'env=prod'],
        ['123/merge', 'pull_request', 'env=preview'],
        ['feature/x', 'pull_request', 'env=preview'],
    ])('single-environment: %s on %s', async (ref, event, expected) => {
        expect(await map(script, ref, event, true)).toEqual({ code: 0, env: expected })
    })

    test('single-environment rejects non-main pushes', async () => {
        expect((await map(script, 'feature/x', 'push', true)).code).toBe(1)
    })
})
