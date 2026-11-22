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
    const at = args.findIndex((a) => !a.startsWith('-'))
    // tokens takes a provider before the verb: `tokens cf apply`.
    const idx =
        noun === 'tokens' && at !== -1 && !VERBS.has(args[at])
            ? args.findIndex((a, i) => i > at && !a.startsWith('-'))
            : at
    if (idx === -1 || !VERBS.has(args[idx])) return null
    return {
        verb: args[idx],
        argv: [noun, ...args.slice(0, idx), ...args.slice(idx + 1)],
    }
}
const NOUNS = new Set(['rulesets', 'settings', 'tokens'])
const VERBS = new Set(['plan', 'check', 'apply'])
