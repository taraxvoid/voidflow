/**
 * The org-grouped fleet config shape, `{ orgs: { <org>: { repos: { <name>:
 * entry } } } }`, flattened to the legacy `"org/name" -> entry` map the tools
 * check and reconcile. A config without an own `orgs` key is legacy (its keys
 * are `owner/name`, so a repo named `orgs` cannot collide).
 */

const isObject = (x: unknown): x is Record<string, unknown> =>
    typeof x === 'object' && x !== null && !Array.isArray(x)

/** `key` as a path segment: bare when it is a plain identifier, else quoted. */
const seg = (key: string) =>
    /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key)

/** Org block fields reserved for later phases (credentials). */
const RESERVED = new Set(['adminTokenEnv', 'cloudflareTokenEnv'])

/**
 * `x` unchanged (same reference) unless it has an own `orgs` key; otherwise
 * the flat map. Throws one Error listing every problem, one per line, each
 * prefixed by its path.
 */
export function flattenOrgs(x: unknown): unknown {
    if (!isObject(x) || !Object.hasOwn(x, 'orgs')) return x
    const problems: string[] = []
    const flat: Record<string, unknown> = {}
    for (const key of Object.keys(x)) {
        if (key !== 'orgs')
            problems.push(
                `${JSON.stringify(key)}: orgs cannot be mixed with other top-level keys`,
            )
    }
    const orgs = x.orgs
    if (!isObject(orgs)) {
        problems.push('orgs: not an object')
    } else {
        for (const [org, block] of Object.entries(orgs)) {
            const at = `orgs.${seg(org)}`
            if (org.includes('/')) problems.push(`${at}: org has a slash`)
            if (!isObject(block)) {
                problems.push(`${at}: not an object`)
                continue
            }
            for (const field of Object.keys(block)) {
                if (field === 'repos') continue
                problems.push(
                    RESERVED.has(field)
                        ? `${at}.${seg(field)}: not supported yet`
                        : `${at}.${seg(field)}: unknown field (only repos)`,
                )
            }
            if (!Object.hasOwn(block, 'repos')) {
                problems.push(`${at}: missing repos`)
                continue
            }
            const repos = block.repos
            if (!isObject(repos)) {
                problems.push(`${at}.repos: not an object`)
                continue
            }
            for (const [name, entry] of Object.entries(repos)) {
                const path = `${at}.repos.${seg(name)}`
                if (name.includes('/'))
                    problems.push(`${path}: name has a slash`)
                else if (!isObject(entry))
                    problems.push(`${path}: not an object`)
                else flat[`${org}/${name}`] = entry
            }
        }
    }
    if (problems.length) throw new Error(problems.join('\n'))
    return flat
}
