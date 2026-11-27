/**
 * `voidflow validate`'s Workers observability check: a wrangler config that
 * would deploy a Worker with no logs gets a warning (never a failure).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { VoidflowConfig } from '../../config/index.ts'
import { parseWranglerConfig } from './wrangler-config.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why a block's `observability` is off, or null when it is not off. */
function explicitlyOff(block: Obj): string | null {
    const o = block.observability
    if (!isObj(o)) return null
    if (o.enabled === false) return 'observability.enabled is false'
    if (isObj(o.logs) && o.logs.enabled === false)
        return 'observability.logs.enabled is false'
    return null
}

/** Warning messages for one parsed wrangler config; empty when it is fine. */
export function observabilityWarnings(parsed: unknown): string[] {
    if (!isObj(parsed)) return []
    const out: string[] = []
    const top = isObj(parsed.observability) ? parsed.observability : undefined
    const topOff = explicitlyOff(parsed)
    if (topOff) out.push(`Worker deploys without logs: ${topOff}`)
    else if (top?.enabled !== true)
        out.push(
            'Worker deploys without observability: set observability.enabled to true',
        )
    if (isObj(parsed.env))
        for (const [name, env] of Object.entries(parsed.env)) {
            if (!isObj(env)) continue
            const off = explicitlyOff(env)
            if (off) out.push(`env.${name} deploys without logs: ${off}`)
        }
    return out
}

export type ObservabilityFinding = { file: string; message: string }

/**
 * Every wrangler file the config points at (each `cloudflare.envs[].wrangler`,
 * default wrangler.jsonc) plus any wrangler.jsonc / .json / .toml at the
 * config's root, checked offline. Missing files are skipped; unparseable ones
 * are reported as findings.
 */
export function observabilityFindings(
    configFile: string,
    cfg: VoidflowConfig,
): ObservabilityFinding[] {
    const root = dirname(resolve(configFile))
    const names = new Set<string>()
    for (const e of cfg.cloudflare?.envs ?? [])
        names.add(e.wrangler ?? 'wrangler.jsonc')
    for (const n of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'])
        names.add(n)
    const out: ObservabilityFinding[] = []
    for (const name of names) {
        const path = isAbsolute(name) ? name : join(root, name)
        if (!existsSync(path)) continue
        try {
            for (const message of observabilityWarnings(
                parseWranglerConfig(path, readFileSync(path, 'utf8')),
            ))
                out.push({ file: name, message })
        } catch (e) {
            out.push({
                file: name,
                message: `cannot check observability: ${(e as Error).message}`,
            })
        }
    }
    return out
}
