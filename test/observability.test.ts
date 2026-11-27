import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    observabilityFindings,
    observabilityWarnings,
} from '../scripts/lib/observability.ts'

describe('observabilityWarnings', () => {
    test('enabled at the top level is fine', () => {
        expect(
            observabilityWarnings({ observability: { enabled: true } }),
        ).toEqual([])
    })

    test('a missing block or a non-true enabled warns', () => {
        expect(observabilityWarnings({ name: 'w' })).toHaveLength(1)
        expect(observabilityWarnings({ observability: {} })).toHaveLength(1)
    })

    test('explicit off at the top level warns once, naming why', () => {
        const w = observabilityWarnings({ observability: { enabled: false } })
        expect(w).toHaveLength(1)
        expect(w[0]).toContain('observability.enabled is false')
        const l = observabilityWarnings({
            observability: { enabled: true, logs: { enabled: false } },
        })
        expect(l).toHaveLength(1)
        expect(l[0]).toContain('observability.logs.enabled is false')
    })

    test('an env block that turns it off warns, naming the env', () => {
        const w = observabilityWarnings({
            observability: { enabled: true },
            env: {
                prod: { observability: { enabled: false } },
                dev: { observability: { enabled: true } },
                bare: {},
            },
        })
        expect(w).toHaveLength(1)
        expect(w[0]).toContain('env.prod')
    })

    test('non-object input yields nothing', () => {
        expect(observabilityWarnings(null)).toEqual([])
    })
})

describe('observabilityFindings', () => {
    const root = () => {
        const dir = mkdtempSync(join(tmpdir(), 'voidflow-obs-'))
        writeFileSync(join(dir, 'voidflow.config.ts'), '')
        return dir
    }

    test('checks cloudflare env files and root defaults, skipping absent ones', () => {
        const dir = root()
        mkdirSync(join(dir, 'apps'))
        writeFileSync(join(dir, 'apps', 'w.jsonc'), '{ "name": "w" }')
        writeFileSync(
            join(dir, 'wrangler.jsonc'),
            '{ "observability": { "enabled": true } }',
        )
        const f = observabilityFindings(join(dir, 'voidflow.config.ts'), {
            kind: 'site',
            cloudflare: {
                account: 'a',
                envs: [{ env: 'PROD', wrangler: 'apps/w.jsonc' }],
            },
        } as never)
        expect(f.map((x) => x.file)).toEqual(['apps/w.jsonc'])
    })

    test('reads TOML and reports a file that does not parse', () => {
        const dir = root()
        writeFileSync(join(dir, 'wrangler.toml'), 'name = "w"\n')
        writeFileSync(join(dir, 'wrangler.json'), '{ "name": ')
        const f = observabilityFindings(join(dir, 'voidflow.config.ts'), {
            kind: 'tool',
        })
        expect(f.map((x) => x.file).sort()).toEqual([
            'wrangler.json',
            'wrangler.toml',
        ])
        expect(f.find((x) => x.file === 'wrangler.json')?.message).toContain(
            'cannot check',
        )
    })
})
