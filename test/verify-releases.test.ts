import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { selectAuditTags } from '../scripts/verify-releases.ts'

const rel = (tagName: string, publishedAt: string, isDraft = false) => ({
    tagName,
    publishedAt,
    isDraft,
})

describe('selectAuditTags', () => {
    const releases = [
        rel('v0.6.0', '2026-09-30T01:02:03Z'),
        rel('v0.5.1', '2026-09-18T22:23:39Z'),
        rel('v0.5.0', '2026-09-14T23:56:30Z'),
        rel('v0.7.0-draft', '2026-10-01T00:00:00Z', true),
    ]

    test('covers the baseline and everything published after it', () => {
        expect(selectAuditTags(releases, 'v0.5.1')).toEqual([
            'v0.6.0',
            'v0.5.1',
        ])
    })

    test('skips releases that predate the baseline and drafts', () => {
        const tags = selectAuditTags(releases, 'v0.5.1')
        expect(tags).not.toContain('v0.5.0')
        expect(tags).not.toContain('v0.7.0-draft')
    })

    test('fails closed when the baseline release is missing', () => {
        expect(() => selectAuditTags(releases, 'v9.9.9')).toThrow(
            /baseline release v9.9.9 not found/,
        )
    })
})

describe('release verification wiring', () => {
    const file = (p: string) =>
        readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

    test('the baseline file names a single tag', () => {
        expect(file('.github/immutable-since').trim()).toMatch(
            /^v\d+\.\d+\.\d+$/,
        )
    })

    test('the release workflow verifies each new release with read-only access', () => {
        const wf: any = Bun.YAML.parse(
            file('.github/workflows/release-please.yml'),
        )
        const job = wf.jobs['verify-immutable']
        expect(job.needs).toEqual(['release-please'])
        expect(job.if).toBe(
            "needs.release-please.outputs.release_created == 'true'",
        )
        expect(job.permissions).toEqual({ contents: 'read' })
        const run = job.steps.map((s: any) => s.run).join('\n')
        expect(run).toContain('bun scripts/verify-releases.ts "$TAG"')
    })

    test('the scheduled audit runs weekly and can only open issues', () => {
        const wf: any = Bun.YAML.parse(
            file('.github/workflows/verify-releases.yml'),
        )
        expect(wf.on.schedule).toHaveLength(1)
        expect(wf.jobs.audit.permissions).toEqual({
            contents: 'read',
            issues: 'write',
        })
        const run = wf.jobs.audit.steps.map((s: any) => s.run).join('\n')
        expect(run).toContain('bun scripts/verify-releases.ts --audit')
    })
})
