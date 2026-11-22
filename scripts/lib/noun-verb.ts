/**
 * Noun-first spelling of the fleet verbs: `voidflow rulesets plan` is
 * `voidflow plan rulesets`, and `voidflow tokens cf apply` (or
 * `tokens apply cf`) is `voidflow apply tokens cf`. Returns the verb and the
 * argv for it, or null when this is not a noun-verb call.
 */
export function nounVerb(
    noun: string,
    args: string[],
): { verb: string; argv: string[] } | null {
    if (!NOUNS.has(noun)) return null
    // The positionals before `--`, skipping flags and their values, so
    // `tokens cf --repo x apply` finds `apply` and `--repo apply` does not.
    const pos: number[] = []
    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--') break
        if (!a.startsWith('-')) pos.push(i)
        else if (VALUE_FLAGS.has(a)) i++
    }
    // tokens takes a provider before the verb: `tokens cf apply`.
    const idx =
        noun === 'tokens' && pos[0] !== undefined && !VERBS.has(args[pos[0]])
            ? pos[1]
            : pos[0]
    if (idx === undefined || !VERBS.has(args[idx])) return null
    return {
        verb: args[idx],
        argv: [noun, ...args.slice(0, idx), ...args.slice(idx + 1)],
    }
}
const NOUNS = new Set(['rulesets', 'settings', 'tokens'])
const VERBS = new Set(['plan', 'check', 'apply'])
/** The flags the tools take a separate value for (`--repo x`, not `--repo=x`). */
const VALUE_FLAGS = new Set([
    '--repo',
    '--config',
    '--repo-config',
    '--try',
    '--local-wrangler',
])
