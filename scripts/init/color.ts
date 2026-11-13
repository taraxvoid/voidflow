/** ANSI colors for `voidflow init` output, off unless stdout is a terminal. */

const CODES = {
    red: '31',
    green: '32',
    yellow: '33',
    cyan: '36',
    dim: '2',
    bold: '1',
} as const

export type Paint = (style: keyof typeof CODES, text: string) => string

/**
 * Color is on only when stdout is a TTY, NO_COLOR is unset and --no-color was
 * not passed; FORCE_COLOR (non-empty, not "0") turns it on regardless of the TTY.
 */
export function colorEnabled(
    noColorFlag: boolean,
    env: Record<string, string | undefined> = process.env,
    isTTY: boolean = process.stdout.isTTY === true,
): boolean {
    if (noColorFlag) return false
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '')
        return env.FORCE_COLOR !== '0'
    return isTTY
}

export function painter(enabled: boolean): Paint {
    return (style, text) =>
        enabled ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text
}

const STATUS_STYLE: Record<string, keyof typeof CODES> = {
    create: 'green',
    created: 'green',
    added: 'green',
    enabled: 'green',
    merge: 'cyan',
    merged: 'cyan',
    overwrite: 'yellow',
    updated: 'yellow',
    applied: 'green',
    'would-apply': 'green',
    unchanged: 'dim',
    skipped: 'dim',
    conflict: 'red',
    failed: 'red',
    unavailable: 'red',
}

/** The style for a status word, ignoring a leading "would ". */
export function statusStyle(status: string): keyof typeof CODES | null {
    return STATUS_STYLE[status.replace(/^would /, '')] ?? null
}
