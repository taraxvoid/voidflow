#!/usr/bin/env bun
/**
 * Shared license policy check for the Astro/bun site stack: fail on copyleft
 * and source-available licenses.
 *
 * Runs `license-checker-rseidelsohn` against the current working directory (the caller's
 * repo root) and exits non-zero if any installed package carries a blocked
 * license. The checker is voidflow's own exact-pinned dependency, resolved from
 * voidflow's install rather than `bunx`, so every site runs the same version
 * and nothing is fetched at check time.
 *
 * The checker's own `--failOn` only matches a whole license string, so
 * `(GPL-3.0 AND MIT)` would get through, and it rewrites strings that aren't
 * valid SPDX (`MIT AND Commons-Clause` becomes `MIT*`, a PolyForm id becomes
 * `UNKNOWN`). This script reads the checker's JSON output plus each package's
 * own `license` field, and evaluates every SPDX expression: an `AND` or `WITH`
 * is blocked when any part is, an `OR` only when every choice is (you can take
 * the permissive one).
 *
 * Usage: bun check-licenses.ts
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BLOCKED = [
    // Strong copyleft.
    'GPL-1.0',
    'GPL-1.0-only',
    'GPL-1.0-or-later',
    'GPL-2.0',
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-1.0',
    'AGPL-1.0-only',
    'AGPL-1.0-or-later',
    'AGPL-2.0',
    'AGPL-2.0-only',
    'AGPL-2.0-or-later',
    'AGPL-3.0',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
    'OSL-2.1',
    'OSL-3.0',
    'CPAL-1.0',
    'EUPL-1.1',
    'EUPL-1.2',
    'CECILL-2.1',
    // Source-available: not open source, with use or field-of-use limits.
    'SSPL-1.0',
    'BUSL-1.1',
    'Elastic-2.0',
    'Commons-Clause',
    // LGPL is deliberately NOT in this list - it only imposes obligations on
    // modifying/statically linking the library, not on depending on it as-is.
]

const blockedIds = new Set(BLOCKED.map((id) => id.toLowerCase()))

/** One SPDX license id or exception, as license-checker reports it. */
function blockedId(id: string) {
    // license-checker marks a license it guessed from a file with a trailing *;
    // a trailing + is the deprecated SPDX "or later" form (GPL-3.0+).
    const bare = id.replace(/[+*]+$/, '').toLowerCase()
    // Every PolyForm license (Noncommercial, Small-Business, Strict, Shield,
    // Perimeter, Internal-Use, Free-Trial) restricts use.
    return blockedIds.has(bare) || bare.startsWith('polyform-')
}

/**
 * Whether a license expression is blocked. AND and WITH: any part blocked.
 * OR: every choice blocked. A string that doesn't parse as an expression is
 * checked as a single id, as license-checker's own --failOn would.
 */
export function isBlocked(expression: string): boolean {
    const normalized = expression
        .trim()
        .replace(/commons[ -]clause(?:[ -]v?1\.0)?/gi, 'Commons-Clause')
    const tokens = normalized.match(/\(|\)|[^\s()]+/g) ?? []
    let pos = 0

    // or := and ('OR' and)*
    // and := atom (('AND' | 'WITH') atom)*
    // atom := '(' or ')' | id
    const parseOr = (): boolean => {
        let blocked = parseAnd()
        while (tokens[pos]?.toUpperCase() === 'OR') {
            pos++
            blocked = parseAnd() && blocked
        }
        return blocked
    }
    const parseAnd = (): boolean => {
        let blocked = parseAtom()
        while (['AND', 'WITH'].includes(tokens[pos]?.toUpperCase() ?? '')) {
            pos++
            blocked = parseAtom() || blocked
        }
        return blocked
    }
    const parseAtom = (): boolean => {
        const token = tokens[pos++]
        if (token === undefined) throw new Error('unexpected end')
        if (token === '(') {
            const blocked = parseOr()
            if (tokens[pos++] !== ')') throw new Error('missing )')
            return blocked
        }
        if (token === ')') throw new Error('unexpected )')
        return blockedId(token)
    }

    try {
        const blocked = parseOr()
        if (pos !== tokens.length) throw new Error('trailing tokens')
        return blocked
    } catch {
        return blockedId(normalized)
    }
}

/** license-checker reports a string, or an array for packages that list several. */
export function packageBlocked(licenses: string | string[] | undefined) {
    if (licenses === undefined) return false
    // An array comes from the legacy `licenses` field; treat every entry as
    // applying, since it doesn't say whether they are alternatives.
    return [licenses].flat().some(isBlocked)
}

type LicenseField = string | { type?: string }

/** The `license` / legacy `licenses` fields as the package itself declares them. */
export function declaredLicenses(pkg: {
    license?: LicenseField
    licenses?: LicenseField[]
}): string[] {
    return [pkg.license, ...(Array.isArray(pkg.licenses) ? pkg.licenses : [])]
        .map((field) => (typeof field === 'string' ? field : field?.type))
        .filter((id): id is string => typeof id === 'string' && id !== '')
}

function readDeclared(path: string | undefined): string[] {
    if (!path) return []
    try {
        return declaredLicenses(
            JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')),
        )
    } catch {
        return []
    }
}

function main() {
    const checkerPkg = Bun.resolveSync(
        'license-checker-rseidelsohn/package.json',
        import.meta.dir,
    )
    const checkerBin = join(
        dirname(checkerPkg),
        JSON.parse(readFileSync(checkerPkg, 'utf8')).bin[
            'license-checker-rseidelsohn'
        ],
    )

    const result = spawnSync(process.execPath, [checkerBin, '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
    })

    if (result.error || result.status !== 0) {
        const why = result.error?.message ?? `exit code ${result.status}`
        console.error(
            `\ncheck:licenses failed - could not run license-checker-rseidelsohn: ${why}`,
        )
        process.exit(1)
    }

    const packages: Record<
        string,
        { licenses?: string | string[]; path?: string }
    > = JSON.parse(result.stdout)
    const counts = new Map<string, number>()
    const hits: string[] = []
    for (const [name, info] of Object.entries(packages)) {
        const label = [info.licenses ?? 'UNKNOWN'].flat().join(', ')
        counts.set(label, (counts.get(label) ?? 0) + 1)
        const declared = readDeclared(info.path)
        if (packageBlocked(info.licenses) || packageBlocked(declared)) {
            const raw = declared.join(', ')
            hits.push(
                raw && raw !== label
                    ? `${name}: ${raw} (reported as ${label})`
                    : `${name}: ${label}`,
            )
        }
    }

    for (const [label, count] of [...counts].sort((a, b) => b[1] - a[1])) {
        console.log(`${label}: ${count}`)
    }

    if (hits.length > 0) {
        console.error(
            '\ncheck:licenses failed - at least one disallowed license was found:',
        )
        for (const hit of hits) console.error(`  - ${hit}`)
        process.exit(1)
    }

    console.log(
        '\ncheck:licenses passed - no blocked licenses found in any workspace.',
    )
}

if (import.meta.main) main()
