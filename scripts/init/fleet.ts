/**
 * Add a repo to the fleet rulesets config (the REPOS object in a module in
 * the org's infra repo) by editing its source text, so comments and the
 * entries around the new one stay as written.
 */

export type FleetEdit =
    | { status: 'added'; text: string }
    | { status: 'unchanged' }
    | { status: 'failed'; detail: string }

/**
 * `text` with comments overwritten by spaces, and with the inside of string
 * literals too when `strings` is set. Newlines stay, and so does every other
 * index, so a match in the blanked text is a match in the original.
 */
function blank(text: string, strings: boolean): string {
    const out = text.split('')
    const wipe = (from: number, to: number) => {
        for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '
    }
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i)
            const end = nl === -1 ? text.length : nl
            wipe(i, end)
            i = end - 1
        } else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2)
            const end = close === -1 ? text.length : close + 2
            wipe(i, end)
            i = end - 1
        } else if (c === "'" || c === '"' || c === '`') {
            const start = i
            for (i++; i < text.length && text[i] !== c; i++)
                if (text[i] === '\\') i++
            if (strings) wipe(start + 1, i)
        }
    }
    return out.join('')
}

/** Index just past the `}` closing the `{` at `open` in blanked code; -1 if unbalanced. */
function closeBrace(code: string, open: number): number {
    let depth = 0
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++
        else if (code[i] === '}' && --depth === 0) return i + 1
    }
    return -1
}

/** The quoted keys of the object whose body is `body` (comments blanked), nested ones left out. */
function topLevelKeys(body: string): string[] {
    const keys: string[] = []
    let depth = 0
    let atKey = true
    for (let i = 0; i < body.length; i++) {
        const c = body[i]
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1
            for (; j < body.length && body[j] !== c; j++)
                if (body[j] === '\\') j++
            if (depth === 0 && atKey && /^\s*:/.test(body.slice(j + 1)))
                keys.push(body.slice(i + 1, j))
            atKey = false
            i = j
        } else if ('{[('.includes(c)) {
            depth++
        } else if ('}])'.includes(c)) {
            depth--
        } else if (c === ',' && depth === 0) {
            atKey = true
        } else if (depth === 0 && !/\s/.test(c)) {
            atKey = false
        }
    }
    return keys
}

/**
 * `text` with `'repo': {},` appended to its REPOS object (or default export
 * object). Unchanged when the repo already has a key there. Comments and
 * strings are skipped when finding the export, the end of the object, and the
 * existing keys, so an `export default {}` inside a comment is not the object
 * and a key written inside a comment is not an entry.
 */
export function addToFleet(text: string, repo: string): FleetEdit {
    const code = blank(text, true)
    const m = /export\s+(?:const\s+REPOS\s*(?::[^=]+)?=|default)\s*\{/.exec(
        code,
    )
    if (!m) {
        return {
            status: 'failed',
            detail: 'no `export const REPOS = {` or `export default {` object found',
        }
    }
    const open = m.index + m[0].length - 1
    const end = closeBrace(code, open)
    if (end === -1)
        return { status: 'failed', detail: 'could not find the end of REPOS' }
    const noComments = blank(text, false)
    if (topLevelKeys(noComments.slice(open + 1, end - 1)).includes(repo))
        return { status: 'unchanged' }

    // Append after the last entry (or the opening brace). If that entry lacks
    // a comma, it goes right after the entry, before any comment on its line.
    const close = end - 1
    const lastCode = noComments.slice(0, close).trimEnd().length
    const comma = /[,{]$/.test(noComments.slice(0, lastCode)) ? '' : ','
    const tail = text.slice(lastCode, close).trimEnd()
    return {
        status: 'added',
        text: `${text.slice(0, lastCode)}${comma}${tail}\n    '${repo}': {},\n${text.slice(close)}`,
    }
}
