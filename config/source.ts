/**
 * A voidflow.config.ts default export as TypeScript source, for `voidflow
 * init` to write the file back after merging `settings` into it. The config
 * is plain data, so a value prints as a literal: inline when it holds no
 * nested object and fits in 80 columns, else one entry per line with
 * four-space indent and trailing commas. `{ kind: 'tool' }` prints exactly as
 * the template always has.
 */

const WIDTH = 80
const INDENT = '    '
const IDENT = /^[A-Za-z_$][\w$]*$/

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

function str(s: string): string {
    return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`
}

const key = (k: string) => (IDENT.test(k) ? k : str(k))

/** True when `v` holds an object at any depth, so it never prints inline. */
function nested(v: unknown): boolean {
    if (Array.isArray(v)) return v.some((e) => isObj(e) || nested(e))
    if (isObj(v)) return Object.values(v).some((e) => isObj(e) || nested(e))
    return false
}

function inline(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`
    if (isObj(v)) {
        const entries = Object.entries(v).filter(([, e]) => e !== undefined)
        return entries.length === 0
            ? '{}'
            : `{ ${entries.map(([k, e]) => `${key(k)}: ${inline(e)}`).join(', ')} }`
    }
    if (typeof v === 'string') return str(v)
    return String(v)
}

/** `v` as a literal at `depth`, after `lead` characters on its first line. */
function literal(v: unknown, depth: number, lead: number): string {
    const flat = inline(v)
    const fits = depth * INDENT.length + lead + flat.length <= WIDTH
    if (!(Array.isArray(v) || isObj(v)) || (fits && !nested(v))) return flat
    const pad = INDENT.repeat(depth + 1)
    const close = `${INDENT.repeat(depth)}${Array.isArray(v) ? ']' : '}'}`
    const lines = Array.isArray(v)
        ? v.map((e) => `${pad}${literal(e, depth + 1, 0)},`)
        : Object.entries(v)
              .filter(([, e]) => e !== undefined)
              .map(([k, e]) => {
                  const head = `${key(k)}: `
                  return `${pad}${head}${literal(e, depth + 1, head.length)},`
              })
    if (lines.length === 0) return Array.isArray(v) ? '[]' : '{}'
    return `${Array.isArray(v) ? '[' : '{'}\n${lines.join('\n')}\n${close}`
}

/** The default export's object literal, as it goes after `export default `. */
export function configSource(cfg: Record<string, unknown>): string {
    return literal(cfg, 0, 'export default '.length)
}
