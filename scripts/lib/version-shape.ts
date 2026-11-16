/**
 * Shape checks for release versions, written without regular expressions so
 * input from a workflow dispatch is never matched against a pattern.
 */

const isDigits = (s: string): boolean =>
    s.length > 0 && [...s].every((c) => c >= '0' && c <= '9')

/** X.Y.Z */
export function isStableVersion(v: string): boolean {
    const parts = v.split('.')
    return parts.length === 3 && parts.every(isDigits)
}

const CANARY_MARK = '-next.'

/** X.Y.Z-next.N */
export function isCanaryVersion(v: string): boolean {
    const i = v.indexOf(CANARY_MARK)
    if (i < 0) return false
    return (
        isStableVersion(v.slice(0, i)) &&
        isDigits(v.slice(i + CANARY_MARK.length))
    )
}
