/**
 * The per-repo `voidflow.config.ts`: a checked-in, non-secret file at a repo's
 * root that says what voidflow manages for it. Plain data, so it loads under
 * Bun or Node without the package installed; use `import type` for the type.
 *
 *   import type { VoidflowConfig } from '@taraxvoid/voidflow/config'
 *   export default { kind: 'site' } satisfies VoidflowConfig
 *
 * `kind` selects the defaults, which the running voidflow release defines
 * (see docs/config.md).
 */

import {
    checkFleet,
    type Fleet,
    type RawConfig,
    type RepoConfig,
    site,
    tool,
} from '../rulesets/index.ts'

export const KINDS = ['site', 'tool'] as const
export type Kind = (typeof KINDS)[number]

export type VoidflowConfig = {
    kind: Kind
    /** Overrides on the kind's defaults, or a raw ruleset list. */
    rulesets?: Partial<RepoConfig> | RawConfig
    /** Reserved: validated, not applied yet. */
    cloudflare?: { account: string; adminTokenEnv?: string }
}

const KEYS = ['kind', 'rulesets', 'cloudflare']
const CLOUDFLARE_KEYS = ['account', 'adminTokenEnv']
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/** The key `rulesets` is validated under; rewritten to `rulesets` in messages. */
const PLACEHOLDER = '_/_'

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

export function defaultsFor(kind: Kind): RepoConfig {
    return kind === 'site' ? site() : tool()
}

/** `rulesets` as an entry for checkFleet: tiered overrides on the kind's defaults, or raw. */
function entry(kind: Kind, rulesets: unknown): unknown {
    if (!isObj(rulesets)) return rulesets
    return 'rulesets' in rulesets
        ? rulesets
        : { ...defaultsFor(kind), ...rulesets }
}

/** checkFleet's messages for one entry, with its repo key rewritten to `rulesets`. */
function rulesetProblems(kind: Kind, rulesets: unknown): string[] {
    try {
        checkFleet({ [PLACEHOLDER]: entry(kind, rulesets) })
        return []
    } catch (e) {
        return (e as Error).message
            .split('\n')
            .map((l) =>
                l
                    .replace(`"${PLACEHOLDER}".`, 'rulesets.')
                    .replace(`"${PLACEHOLDER}"`, 'rulesets'),
            )
    }
}

/** The config, or an Error listing every problem by path, one per line. */
export function checkVoidflowConfig(x: unknown): VoidflowConfig {
    if (!isObj(x)) throw new Error('config is not an object')
    const errs: string[] = []
    for (const k of Object.keys(x))
        if (!KEYS.includes(k)) errs.push(`${k}: unknown field`)

    const kind = x.kind
    const kindOk = KINDS.includes(kind as Kind)
    if (kind === undefined) errs.push(`kind: missing (${KINDS.join(' or ')})`)
    else if (!kindOk)
        errs.push(
            `kind: unknown ${JSON.stringify(kind)} (${KINDS.join(' or ')})`,
        )

    if (x.rulesets !== undefined) {
        if (!isObj(x.rulesets)) errs.push('rulesets: not an object')
        else
            errs.push(
                ...rulesetProblems(
                    kindOk ? (kind as Kind) : 'tool',
                    x.rulesets,
                ),
            )
    }

    const cf = x.cloudflare
    if (cf !== undefined) {
        if (!isObj(cf)) errs.push('cloudflare: not an object')
        else {
            for (const k of Object.keys(cf))
                if (!CLOUDFLARE_KEYS.includes(k))
                    errs.push(`cloudflare.${k}: unknown field`)
            if (typeof cf.account !== 'string' || cf.account === '')
                errs.push('cloudflare.account: missing')
            const env = cf.adminTokenEnv
            if (
                env !== undefined &&
                (typeof env !== 'string' || !ENV_NAME.test(env))
            )
                errs.push(
                    'cloudflare.adminTokenEnv: not an environment variable name',
                )
        }
    }

    if (errs.length > 0) throw new Error(errs.join('\n'))
    return x as VoidflowConfig
}

/** The one-repo fleet map the rulesets planner runs on, defaults filled in. */
export function toFleet(cfg: VoidflowConfig, repo: string): Fleet {
    return checkFleet({ [repo]: entry(cfg.kind, cfg.rulesets ?? {}) })
}

/** The markdown table of each kind's defaults, as docs/config.md carries it. */
export function renderDefaultsTable(): string {
    const cell = (v: unknown) =>
        Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v)
    const rows = KINDS.map((k) => {
        const d = defaultsFor(k)
        return `| ${k} | ${[d.tiers, d.checks, d.codeowners, d.linearHistory, d.mergeQueue, d.retire].map(cell).join(' | ')} |`
    })
    return [
        '| kind | tiers | checks | codeowners | linearHistory | mergeQueue | retire |',
        '|------|-------|--------|------------|---------------|------------|--------|',
        ...rows,
    ].join('\n')
}
