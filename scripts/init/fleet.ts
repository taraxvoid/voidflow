/**
 * Add a repo to the fleet rulesets config (the REPOS object in a module in
 * the org's infra repo) by editing its source text, so comments and the
 * entries around the new one stay as written.
 */

export type FleetEdit =
    | { status: 'added'; text: string }
    | { status: 'unchanged' }
    | { status: 'failed'; detail: string }

/** Index just past the `}` closing the `{` at `open`, skipping strings and comments; -1 if unbalanced. */
function closeBrace(text: string, open: number): number {
    let depth = 0
    for (let i = open; i < text.length; i++) {
        const c = text[i]
        if (c === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i)
            if (nl === -1) return -1
            i = nl
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2)
            if (end === -1) return -1
            i = end + 1
        } else if (c === "'" || c === '"' || c === '`') {
            for (i++; i < text.length && text[i] !== c; i++)
                if (text[i] === '\\') i++
        } else if (c === '{') {
            depth++
        } else if (c === '}' && --depth === 0) {
            return i + 1
        }
    }
    return -1
}

/**
 * `text` with `'repo': {},` appended to its REPOS object (or default export
 * object). Unchanged when the repo already has a key there.
 */
export function addToFleet(text: string, repo: string): FleetEdit {
    const m = /export\s+(?:const\s+REPOS\s*(?::[^=]+)?=|default)\s*\{/.exec(
        text,
    )
    if (!m) {
        return {
            status: 'failed',
            detail: 'no `export const REPOS = {` or `export default {` object found',
        }
    }
    const open = m.index + m[0].length - 1
    const end = closeBrace(text, open)
    if (end === -1)
        return { status: 'failed', detail: 'could not find the end of REPOS' }
    const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    const key = new RegExp(`^\\s*['"\`]${escaped}['"\`]\\s*:`, 'm')
    if (key.test(text.slice(open, end))) return { status: 'unchanged' }

    // Append after the last entry (or the opening brace), adding a comma if
    // the last entry lacks one.
    const close = end - 1
    let before = text.slice(0, close).replace(/\s+$/, '')
    const lastLine = before.slice(before.lastIndexOf('\n') + 1)
    const endsComment = /^\s*\/\//.test(lastLine) || /\*\/\s*$/.test(lastLine)
    if (!endsComment && !/[,{]$/.test(before)) before += ','
    return {
        status: 'added',
        text: `${before}\n    '${repo}': {},\n${text.slice(close)}`,
    }
}
