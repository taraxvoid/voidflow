import {
    type ParseError,
    parse as parseJsonc,
    printParseErrorCode,
} from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

/**
 * A wrangler config as wrangler reads it: TOML for `.toml` paths, JSONC
 * (comments and trailing commas allowed) otherwise. Plain parsers with no
 * Bun global, so the built bin works under Node. Malformed input throws
 * instead of yielding a partial value (jsonc-parser recovers by default).
 */
export function parseWranglerConfig(path: string, text: string): unknown {
    if (path.endsWith('.toml')) return parseToml(text)
    const errors: ParseError[] = []
    const value = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
        const e = errors[0]
        throw new Error(
            `${path}: ${printParseErrorCode(e.error)} at offset ${e.offset}`,
        )
    }
    return value
}
