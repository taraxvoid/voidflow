/**
 * Flag parsing for the repo tools: node:util's strict parseArgs, plus
 * -h/--help, and a usage message instead of a stack trace on a bad flag.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util'

/**
 * Parse `argv` against `config`. -h/--help prints `usage` and exits 0; an
 * unknown, malformed or unexpected argument prints the problem and `usage`
 * and exits 2.
 */
export function parseOrExit<T extends ParseArgsConfig>(
    argv: string[],
    config: T,
    usage: string,
) {
    // Only before a `--`: what follows is a command's own (cf-tokens --try).
    const end = argv.indexOf('--')
    const flags = end === -1 ? argv : argv.slice(0, end)
    if (flags.some((a) => a === '-h' || a === '--help')) {
        console.log(usage)
        process.exit(0)
    }
    try {
        return parseArgs({ ...config, args: argv, strict: true })
    } catch (e) {
        if (!String((e as { code?: string }).code).startsWith('ERR_PARSE_ARGS_')) throw e
        console.error(`${(e as Error).message}\n\n${usage}`)
        process.exit(2)
    }
}
