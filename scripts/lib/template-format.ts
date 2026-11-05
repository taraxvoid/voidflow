/**
 * Template constants and JSON formatting shared by the template build script
 * and `voidflow init`, kept free of build-only code so the CLI bundle stays small.
 */

export const TEMPLATE_PLACEHOLDERS = [
    '{{version}}',
    '{{sha}}',
    '{{kind}}',
    '{{cron_minute}}',
    '{{repo}}',
] as const

/**
 * JSON as biome prints it with biome/base.json (4-space indent, width 80):
 * objects expanded, arrays on one line when they fit. Generated repos run
 * `biome check .`, so the written files must already be formatted.
 */
function fmt(v: unknown, indent: string, used: number, unit: string): string {
    if (Array.isArray(v)) {
        const flat = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`
        const scalars = !v.some((x) => typeof x === 'object' && x !== null)
        if (scalars && used + flat.length + 1 <= 80) return flat
        const inner = `${indent}${unit}`
        return `[\n${v.map((x) => inner + fmt(x, inner, inner.length, unit)).join(',\n')}\n${indent}]`
    }
    if (typeof v === 'object' && v !== null) {
        if (Object.keys(v).length === 0) return '{}'
        const inner = `${indent}${unit}`
        const rows = Object.entries(v).map(([k, x]) => {
            const key = `${JSON.stringify(k)}: `
            return inner + key + fmt(x, inner, inner.length + key.length, unit)
        })
        return `{\n${rows.join(',\n')}\n${indent}}`
    }
    return JSON.stringify(v)
}
/** `unit` is one indent level (4 spaces by default). */
export const json = (v: unknown, unit = '    ') => `${fmt(v, '', 0, unit)}\n`
