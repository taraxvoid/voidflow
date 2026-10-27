import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const action: any = Bun.YAML.parse(read('actions/cloudflare-preview/action.yml'))
const step = (id: string) => action.runs.steps.find((s: any) => s.id === id)

function run(script: string, env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-preview-'))
    const out = join(dir, 'output')
    const proc = Bun.spawnSync(['bash', '-c', script], {
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: dir, ...env },
    })
    const lines = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : []
    const outputs = Object.fromEntries(lines.filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    return { code: proc.exitCode, outputs, dir }
}

const resolve = (env: Record<string, string>) =>
    run(step('resolve').run, { INPUT_NAME: '', INPUT_DELETE: 'false', SECRETS: '', PR_NUMBER: '', REF_NAME: '', ...env })

describe('cloudflare-preview resolve step', () => {
    test('names the Preview after the pull request', () => {
        expect(resolve({ PR_NUMBER: '42', REF_NAME: 'feat/x' }).outputs).toEqual({
            name: 'pr-42',
            cmd: 'preview --name pr-42 --json',
        })
    })

    test('falls back to a hostname-safe branch name outside pull requests', () => {
        expect(resolve({ REF_NAME: 'Feat/Some_Thing--' }).outputs.name).toBe('feat-some-thing')
    })

    test('an explicit name wins', () => {
        expect(resolve({ INPUT_NAME: 'staging', PR_NUMBER: '42' }).outputs.name).toBe('staging')
    })

    test('fails when no name can be derived', () => {
        expect(resolve({}).code).toBe(1)
    })

    test('delete builds a non-interactive delete', () => {
        expect(resolve({ PR_NUMBER: '7', INPUT_DELETE: 'true' }).outputs.cmd).toBe(
            'preview delete --name pr-7 --skip-confirmation',
        )
    })

    test('secrets go to a private file passed with --secrets-file', () => {
        const { outputs, dir } = resolve({ PR_NUMBER: '7', SECRETS: 'A=1\nB=2' })
        const file = join(dir, 'voidflow-preview-secrets.env')
        expect(outputs.cmd).toBe(`preview --name pr-7 --json --secrets-file ${file}`)
        expect(readFileSync(file, 'utf8')).toBe('A=1\nB=2\n')
        expect(statSync(file).mode & 0o777).toBe(0o600)
    })
})

describe('cloudflare-preview parse step', () => {
    const parse = (OUTPUT: string) => run(step('parse').run, { OUTPUT })

    test('reads the documented .preview.urls[0]', () => {
        const json = JSON.stringify({
            preview: { urls: ['https://pr-42-site.acct.workers.dev'] },
            deployment: { urls: ['https://abc123-pr-42-site.acct.workers.dev'] },
        })
        expect(parse(json).outputs).toEqual({
            url: 'https://pr-42-site.acct.workers.dev',
            'deployment-url': 'https://abc123-pr-42-site.acct.workers.dev',
        })
    })

    test('skips log lines before the JSON and falls back to the first https URL', () => {
        const out = 'wrangler 4.x\n{\n  "preview_urls": ["https://x.workers.dev"]\n}'
        expect(parse(out).outputs).toEqual({ url: 'https://x.workers.dev', 'deployment-url': '' })
    })

    test('fails when there is no URL', () => {
        expect(parse('{"ok": true}').code).toBe(1)
    })
})

describe('cloudflare-preview action shape', () => {
    test('every action is pinned to a full SHA', () => {
        for (const s of action.runs.steps.filter((s: any) => s.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/)
    })

    test('uses the same wrangler-action pin as cloudflare-deploy', () => {
        const deploy: any = Bun.YAML.parse(read('actions/cloudflare-deploy/action.yml'))
        const pin = (a: any) => a.runs.steps.find((s: any) => s.uses?.startsWith('cloudflare/wrangler-action@')).uses
        expect(pin(action)).toBe(pin(deploy))
    })

    test('the secrets file is removed even when the deploy fails', () => {
        const rm = action.runs.steps.find((s: any) => s.name === 'Remove secrets file')
        expect(rm.if).toContain('always()')
    })
})
