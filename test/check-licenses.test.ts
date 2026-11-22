import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    declaredLicenses,
    isBlocked,
    packageBlocked,
} from '../scripts/check-licenses'

const script = new URL('../scripts/check-licenses.ts', import.meta.url).pathname

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
    test('runs an exact-pinned checker from voidflow, not bunx', () => {
        const pkg = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        )
        expect(pkg.dependencies['license-checker-rseidelsohn']).toMatch(
            /^\d+\.\d+\.\d+$/,
        )
        expect(readFileSync(script, 'utf8')).not.toContain("'bunx'")
    })

    test('passes when every dependency is permissively licensed', async () => {
        const { code, stdout } = await run(project('MIT'))
        expect(code).toBe(0)
        expect(stdout).toContain('check:licenses passed')
    }, 60_000)

    test('allows LGPL', async () => {
        const { code } = await run(project('LGPL-3.0'))
        expect(code).toBe(0)
    }, 60_000)

    test.each(['GPL-3.0', 'AGPL-3.0-or-later'])(
        'fails on %s',
        async (lic) => {
            const { code, stderr } = await run(project(lic))
            expect(code).toBe(1)
            expect(stderr).toContain('disallowed license')
        },
        60_000,
    )

    test.each([
        'BUSL-1.1',
        'Elastic-2.0',
        'SSPL-1.0',
        'MIT AND Commons-Clause',
        'PolyForm-Noncommercial-1.0.0',
    ])(
        'fails on %s',
        async (lic) => {
            const { code, stderr } = await run(project(lic))
            expect(code).toBe(1)
            expect(stderr).toContain('disallowed license')
            expect(stderr).toContain('dep@1.0.0')
        },
        60_000,
    )
})

describe('isBlocked', () => {
    test.each([
        'GPL-3.0',
        'gpl-3.0-only',
        'GPL-2.0*',
        'GPL-3.0+',
        'AGPL-3.0+',
        'BUSL-1.1',
        'Elastic-2.0',
        'SSPL-1.0',
        'Commons-Clause',
        'Commons Clause',
        'PolyForm-Noncommercial-1.0.0',
        'PolyForm-Shield-1.0.0',
        'MIT AND Commons-Clause',
        'Apache-2.0 WITH Commons-Clause-1.0',
        '(MIT AND GPL-3.0)',
        'GPL-3.0 OR AGPL-3.0',
        '(MIT AND BUSL-1.1) OR GPL-3.0',
    ])('blocks %s', (lic) => {
        expect(isBlocked(lic)).toBe(true)
    })

    test.each([
        'MIT',
        'LGPL-3.0',
        'BSL-1.0',
        'Apache-2.0 WITH LLVM-exception',
        '(MIT OR GPL-3.0)',
        'BUSL-1.1 OR Apache-2.0',
        '(MIT OR Apache-2.0) AND BSD-3-Clause',
        'UNKNOWN',
        'UNLICENSED',
    ])('allows %s', (lic) => {
        expect(isBlocked(lic)).toBe(false)
    })

    test('falls back to a whole-string match on a malformed expression', () => {
        expect(isBlocked('(GPL-3.0')).toBe(false)
        expect(isBlocked('MIT AND')).toBe(false)
    })

    test('reads license and legacy licenses fields as declared', () => {
        expect(
            declaredLicenses({
                license: { type: 'MIT' },
                licenses: ['BUSL-1.1', { type: 'Apache-2.0' }, {}],
            }),
        ).toEqual(['MIT', 'BUSL-1.1', 'Apache-2.0'])
        expect(declaredLicenses({})).toEqual([])
    })

    test('treats a legacy licenses array as all applying', () => {
        expect(packageBlocked(['MIT', 'GPL-3.0'])).toBe(true)
        expect(packageBlocked(['MIT', 'Apache-2.0'])).toBe(false)
        expect(packageBlocked(undefined)).toBe(false)
    })
})
