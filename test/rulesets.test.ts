import { describe, expect, test } from 'bun:test'
import { REPOS, build, desired, diff, normalise } from '../rulesets/index.ts'

const statusChecks = (r: ReturnType<typeof build>) =>
    (
        r.rules.find((x) => x.type === 'required_status_checks')?.parameters as {
            required_status_checks: Array<{ context: string }>
        }
    ).required_status_checks.map((c) => c.context)

describe('canonical rulesets', () => {
    test('main is squash-only with linear history and no unreviewed bypass', () => {
        const r = build('main', REPOS['taraxvoid/synthomaha'])
        expect(r.rules.map((x) => x.type)).toContain('required_linear_history')
        const pr = r.rules.find((x) => x.type === 'pull_request')
        expect(pr?.parameters?.allowed_merge_methods).toEqual(['squash'])
        expect(
            r.bypass_actors.filter(
                (a) => a.actor_type === 'RepositoryRole' && a.bypass_mode === 'always',
            ),
        ).toEqual([])
    })

    test('every tier of every site requires the reusable workflow check name', () => {
        for (const repo of Object.keys(REPOS)) {
            for (const { ruleset } of desired(repo)) {
                const names = statusChecks(ruleset)
                // Bare "Validate" / "pr-checks" never reports from site-ci.yml.
                expect(names).not.toContain('Validate')
                expect(names).not.toContain('pr-checks')
            }
        }
        expect(statusChecks(build('live', REPOS['taraxvoid/soundry']))).toContain(
            'validate / Validate',
        )
    })

    test('live has no bypass actors unless configured', () => {
        expect(build('live', REPOS['taraxvoid/synthomaha']).bypass_actors).toEqual([])
    })

    test('names within a repo are unique', () => {
        for (const repo of Object.keys(REPOS)) {
            const names = desired(repo).map((d) => d.ruleset.name)
            expect(new Set(names).size).toBe(names.length)
        }
    })
})

describe('diff', () => {
    test('is empty for the same ruleset in a different order', () => {
        const a = build('next', REPOS['taraxvoid/queeromaha'])
        const b = structuredClone(a)
        b.rules.reverse()
        b.bypass_actors.reverse()
        expect(diff(normalise(a), normalise(b))).toEqual([])
    })

    test('reports a changed status check', () => {
        const a = build('next', REPOS['taraxvoid/synthomaha'])
        const b = structuredClone(a)
        ;(
            b.rules.find((x) => x.type === 'required_status_checks')!.parameters as any
        ).required_status_checks[1].context = 'pr-checks'
        const lines = diff(normalise(b), normalise(a))
        expect(lines.some((l) => l.startsWith('- ') && l.includes('pr-checks'))).toBe(true)
        expect(lines.some((l) => l.startsWith('+ ') && l.includes('validate / Validate'))).toBe(true)
    })
})
