import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('../scripts/check-licenses.ts', import.meta.url)
    .pathname

// A throwaway project whose only dependency declares `license`.
function project(license: string) {
    const cwd = mkdtempSync(join(tmpdir(), 'voidflow-licenses-'))
    writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({
            name: 'fixture',
            version: '1.0.0',
            license: 'MIT',
            dependencies: { dep: '1.0.0' },
        }),
    )
    const dep = join(cwd, 'node_modules', 'dep')
    mkdirSync(dep, { recursive: true })
    writeFileSync(
        join(dep, 'package.json'),
        JSON.stringify({ name: 'dep', version: '1.0.0', license }),
    )
    return cwd
}

async function run(cwd: string) {
    const proc = Bun.spawn(['bun', script], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { stdout, stderr, code }
}

describe('check-licenses', () => {
    test('passes when every dependency is permissively licensed', async () => {
        const { code, stdout } = await run(project('MIT'))
        expect(code).toBe(0)
        expect(stdout).toContain('check:licenses passed')
    })

    test('allows LGPL', async () => {
        const { code } = await run(project('LGPL-3.0'))
        expect(code).toBe(0)
    })

    test.each(['GPL-3.0', 'AGPL-3.0-or-later'])('fails on %s', async (lic) => {
        const { code, stderr } = await run(project(lic))
        expect(code).toBe(1)
        expect(stderr).toContain('disallowed license')
    })
}, 60_000)
