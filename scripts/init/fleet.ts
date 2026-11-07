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

type Prop = { key: string; at: number; value: number }

/**
 * The top-level properties of the object whose `{` is at `open` in `text`
 * (comments blanked, strings intact): each key (quoted or a bare
 * identifier), where it starts, and where its value starts.
 */
function props(text: string, open: number, end: number): Prop[] {
    const out: Prop[] = []
    let depth = 0
    let atKey = true
    for (let i = open + 1; i < end - 1; i++) {
        const c = text[i]
        if (depth === 0 && atKey && /[\w$'"`]/.test(c)) {
            let key: string
            let j: number
            if (/['"`]/.test(c)) {
                j = i + 1
                for (; j < end && text[j] !== c; j++) if (text[j] === '\\') j++
                key = text.slice(i + 1, j)
                j++
            } else {
                j = i
                while (j < end && /[\w$]/.test(text[j])) j++
                key = text.slice(i, j)
            }
            const colon = /^\s*:\s*/.exec(text.slice(j, end))
            if (colon) out.push({ key, at: i, value: j + colon[0].length })
            atKey = false
            i = j - 1
        } else if (c === "'" || c === '"' || c === '`') {
            let j = i + 1
            for (; j < end && text[j] !== c; j++) if (text[j] === '\\') j++
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
    return out
}

/** Leading whitespace of the line holding `at`, when only whitespace precedes it. */
function lineIndent(text: string, at: number): string | null {
    const start = text.lastIndexOf('\n', at - 1) + 1
    const lead = text.slice(start, at)
    return /^[ \t]*$/.test(lead) ? lead : null
}

/**
 * `text` with `entry` appended to the object spanning `open`..`end`, one per
 * line, indented like the object's first entry (else `fallback`), adding a
 * comma after the last entry if it lacks one.
 */
function append(
    text: string,
    noComments: string,
    open: number,
    end: number,
    entry: string,
    fallback: string,
): string {
    const close = end - 1
    const first = props(noComments, open, end)[0]
    const indent = (first && lineIndent(text, first.at)) ?? fallback
    const closeIndent = lineIndent(text, close) ?? fallback.slice(4)
    const lastCode = noComments.slice(0, close).trimEnd().length
    const comma = /[,{]$/.test(noComments.slice(0, lastCode)) ? '' : ','
    const tail = text.slice(lastCode, close).trimEnd()
    return `${text.slice(0, lastCode)}${comma}${tail}\n${indent}${entry}\n${closeIndent}${text.slice(close)}`
}

/** The `{` of `key`'s object value among `ps`, with the key's indent; null if not an object. */
function child(
    text: string,
    code: string,
    ps: Prop[],
    key: string,
): { open: number; end: number; indent: string } | null | undefined {
    const p = ps.find((x) => x.key === key)
    if (!p) return undefined
    if (code[p.value] !== '{') return null
    const end = closeBrace(code, p.value)
    if (end === -1) return null
    return { open: p.value, end, indent: lineIndent(text, p.at) ?? '' }
}

/** The org-grouped case of addToFleet: insert under orgs.<owner>.repos. */
function addToOrgs(
    text: string,
    code: string,
    noComments: string,
    orgs: { open: number; end: number; indent: string },
    repo: string,
): FleetEdit {
    const slash = repo.indexOf('/')
    const owner = repo.slice(0, slash)
    const name = repo.slice(slash + 1)
    const ownerKey = /^[A-Za-z_$][\w$]*$/.test(owner) ? owner : `'${owner}'`
    const org = child(text, code, props(noComments, orgs.open, orgs.end), owner)
    if (org === undefined) {
        return {
            status: 'added',
            text: append(
                text,
                noComments,
                orgs.open,
                orgs.end,
                `${ownerKey}: { repos: { '${name}': {} } },`,
                `${orgs.indent}    `,
            ),
        }
    }
    const repos =
        org && child(text, code, props(noComments, org.open, org.end), 'repos')
    if (!org || !repos) {
        return {
            status: 'failed',
            detail: `orgs.${ownerKey} has no repos object to add ${name} to`,
        }
    }
    if (props(noComments, repos.open, repos.end).some((p) => p.key === name))
        return { status: 'unchanged' }
    return {
        status: 'added',
        text: append(
            text,
            noComments,
            repos.open,
            repos.end,
            `'${name}': {},`,
            `${repos.indent}    `,
        ),
    }
}

/**
 * `text` with `'repo': {},` appended to its REPOS object (or default export
 * object). Unchanged when the repo already has a key there. Comments and
 * strings are skipped when finding the export, the end of the object, and the
 * existing keys, so an `export default {}` inside a comment is not the object
 * and a key written inside a comment is not an entry. When the object has an
 * `orgs` key (the org-grouped shape), `'name': {},` goes under
 * `orgs.<owner>.repos` instead, and a missing owner block is appended.
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
    const top = props(noComments, open, end)
    if (top.some((p) => p.key === 'orgs')) {
        const orgs = child(text, code, top, 'orgs')
        if (!orgs) return { status: 'failed', detail: 'orgs is not an object' }
        return addToOrgs(text, code, noComments, orgs, repo)
    }
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
