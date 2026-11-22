import { describe, expect, test } from 'bun:test'
import { checkVoidflowConfig } from '../config/index.ts'
import { configSource } from '../config/source.ts'
import { mergeSettings, withSettings } from '../scripts/init/config-settings.ts'

describe('configSource', () => {
    test('the minimal file prints as the template always has', () => {
        expect(configSource({ kind: 'tool' })).toBe("{ kind: 'tool' }")
    })

    test('nested objects go one entry per line; flat values stay inline', () => {
        expect(
            configSource({ kind: 'site', settings: { enable: ['agentic'] } }),
        ).toBe(
            "{\n    kind: 'site',\n    settings: { enable: ['agentic'] },\n}",
        )
    })

    test('a value too wide for 80 columns breaks', () => {
        const checks = Array.from({ length: 6 }, (_, i) => `check number ${i}`)
        const text = configSource({ kind: 'tool', rulesets: { checks } })
        expect(text).toContain(
            "        checks: [\n            'check number 0',",
        )
        expect(text.split('\n').every((l) => l.length <= 80)).toBe(true)
    })

    test('quotes keys that are not identifiers and escapes strings', () => {
        expect(configSource({ 'a-b': "it's \\ here" })).toBe(
            "{ 'a-b': 'it\\'s \\\\ here' }",
        )
    })

    test('a full config round-trips through the validator', async () => {
        const cfg = {
            kind: 'site',
            rulesets: {
                checks: ['validate / Validate'],
                bypass: {
                    main: [
                        {
                            actor_id: 13473,
                            actor_type: 'Integration',
                            bypass_mode: 'always',
                        },
                    ],
                },
            },
            cloudflare: {
                account: '0123456789abcdef0123456789abcdef',
                envs: [{ env: 'prod' }, { env: 'preview', zones: [] }],
                retire: ['old-token'],
            },
            settings: { enable: ['agentic'], skip: ['codeql'] },
        }
        // biome-ignore lint/security/noGlobalEval: evaluates the printed literal
        const back = (0, eval)(`(${configSource(cfg)})`)
        expect(back).toEqual(cfg)
        expect(checkVoidflowConfig(back)).toEqual(cfg as never)
    })
})

describe('mergeSettings', () => {
    test('nothing in, nothing to record', () => {
        expect(mergeSettings(undefined, [], ['ci'])).toEqual({ added: [] })
    })

    test('flags add to the file, in group and table order', () => {
        expect(
            mergeSettings({ enable: ['agentic'] }, ['pvr'], ['codeql']),
        ).toEqual({
            settings: { enable: ['pvr', 'agentic'], skip: ['codeql'] },
            added: ['settings.enable + pvr', 'settings.skip + codeql'],
        })
    })

    test('relock records itself, not the lock it implies', () => {
        expect(
            mergeSettings(undefined, ['actions-lock', 'actions-relock'], [])
                .settings,
        ).toEqual({ enable: ['actions-relock'] })
    })

    test('file names in --skip and skips of disabled groups are dropped', () => {
        expect(
            mergeSettings(undefined, [], ['codeowners', 'label-low-risk']),
        ).toEqual({ added: [] })
    })

    test('the file alone adds nothing', () => {
        const file = { enable: ['pvr' as const], skip: ['codeql'] }
        expect(mergeSettings(file, ['pvr'], ['codeql'])).toEqual({
            settings: file,
            added: [],
        })
    })
})

describe('withSettings', () => {
    test('replaces in place, appends when new, drops when undefined', () => {
        const s = { enable: ['pvr' as const] }
        expect(
            Object.keys(
                withSettings({ kind: 'tool', settings: {}, rulesets: {} }, s),
            ),
        ).toEqual(['kind', 'settings', 'rulesets'])
        expect(withSettings({ kind: 'tool' }, s)).toEqual({
            kind: 'tool',
            settings: s,
        })
        expect(withSettings({ kind: 'tool', settings: s }, undefined)).toEqual({
            kind: 'tool',
        })
    })
})
