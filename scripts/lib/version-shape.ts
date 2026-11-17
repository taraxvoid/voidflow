/**
 * Shape checks for release versions, written without regular expressions so
 * input from a workflow dispatch is never matched against a pattern.
 */

// No real version is anywhere near this long; reject oversized input early.
const MAX_LENGTH = 64

const isDigits = (s: string): boolean =>
    s.length > 0 && [...s].every((c) => c >= '0' && c <= '9')

/** X.Y.Z */
export function isStableVersion(v: string): boolean {
    if (v.length > MAX_LENGTH) return false
    const parts = v.split('.')
    return parts.length === 3 && parts.every(isDigits)
}

const CANARY_MARK = '-next.'

/** X.Y.Z-next.N */
export function isCanaryVersion(v: string): boolean {
    if (v.length > MAX_LENGTH) return false
    const i = v.indexOf(CANARY_MARK)
    if (i < 0) return false
    return (
        isStableVersion(v.slice(0, i)) &&
        isDigits(v.slice(i + CANARY_MARK.length))
    )
}
