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

    test('sites manage only main and retire next/live', () => {
        for (const repo of ['queeromaha', 'soundry', 'synthomaha']) {
            const cfg = REPOS[`taraxvoid/${repo}`]
            expect(cfg.tiers).toEqual(['main'])
            expect(cfg.retire).toEqual(['next (staging)', 'live (prod)'])
        }
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

describe('voidflow release channels', () => {
    const cfg = REPOS['taraxvoid/voidflow']
    const mergeMethods = (r: ReturnType<typeof build>) =>
        r.rules.find((x) => x.type === 'pull_request')?.parameters
            ?.allowed_merge_methods as string[]

    test('main drops linear history and allows merge commits for promotion, no rebase', () => {
        const r = build('main', cfg)
        expect(r.rules.map((x) => x.type)).not.toContain('required_linear_history')
        expect(mergeMethods(r)).toEqual(['squash', 'merge'])
    })

    test('sites are byte-for-byte unchanged: linear history, squash only', () => {
        for (const repo of ['queeromaha', 'soundry', 'synthomaha']) {
            const r = build('main', REPOS[`taraxvoid/${repo}`])
            expect(r.rules.map((x) => x.type)).toContain('required_linear_history')
            expect(mergeMethods(r)).toEqual(['squash'])
        }
    })

    test('prerelease protects next, allows merge commits for back-merges, no linear history', () => {
        const r = build('prerelease', cfg)
        expect(r.name).toBe('next (prerelease)')
        expect(r.conditions.ref_name.include).toEqual(['refs/heads/next'])
        expect(mergeMethods(r)).toEqual(['squash', 'merge'])
        expect(r.rules.map((x) => x.type)).not.toContain('required_linear_history')
    })

    test('maintenance protects release/* and is squash only', () => {
        const r = build('maintenance', cfg)
        expect(r.name).toBe('release/* (maintenance)')
        expect(r.conditions.ref_name.include).toEqual(['refs/heads/release/*'])
        expect(mergeMethods(r)).toEqual(['squash'])
    })

    test('release branches block deletion and force-push, require the repo checks, no deploy-key bypass', () => {
        for (const tier of ['main', 'prerelease', 'maintenance'] as const) {
            const r = build(tier, cfg)
            const types = r.rules.map((x) => x.type)
            expect(types).toContain('deletion')
            expect(types).toContain('non_fast_forward')
            expect(statusChecks(r)).toEqual(['Validation', 'Unit tests'])
            expect(r.bypass_actors.some((a) => a.actor_type === 'DeployKey')).toBe(false)
        }
    })

    test('voidflow manages main, prerelease and maintenance', () => {
        expect(cfg.tiers).toEqual(['main', 'prerelease', 'maintenance'])
    })
})
