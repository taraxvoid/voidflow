/**
 * `voidflow tokens <provider>`: the token providers' shared entry point.
 * The provider is the first argument (cf when the first argument is a flag
 * or missing); the rest goes to its script, which takes --config and the
 * same flags as before:
 *
 *   voidflow tokens cf --config cf-tokens.ts [--apply ...]
 *   voidflow tokens cf --repo example_project --try prod -- bunx wrangler deploy
 *
 * Providers live in scripts/lib/providers.ts; each keeps its own
 * <provider>-tokens.ts fleet config.
 */
import { DEFAULT_PROVIDER, PROVIDERS, type Provider } from './lib/providers.ts'

type Main = (argv: string[], prog: string) => Promise<void>

/** Provider id -> its script, loaded lazily so --help stays cheap. */
const MODULES: Record<Provider, () => Promise<{ main: Main }>> = {
    cf: () => import('./cf-tokens.ts'),
}

const usage = (prog: string) =>
    [
        `usage: ${prog} <provider> [flags]`,
        '',
        `providers: ${Object.keys(PROVIDERS).join(', ')} (default ${DEFAULT_PROVIDER})`,
        '',
        `Run \`${prog} <provider> --help\` for a provider's flags.`,
    ].join('\n')

export async function main(argv: string[], prog = 'voidflow tokens') {
    if (argv[0] === '-h' || argv[0] === '--help') {
        console.log(usage(prog))
        process.exit(0)
    }
    const named = argv[0] !== undefined && !argv[0].startsWith('-')
    const provider = named ? argv[0] : DEFAULT_PROVIDER
    const rest = named ? argv.slice(1) : argv
    const load = MODULES[provider as Provider]
    if (load === undefined) {
        console.error(
            `unknown provider ${JSON.stringify(provider)} (${Object.keys(PROVIDERS).join(' or ')})\n\n${usage(prog)}`,
        )
        process.exit(2)
    }
    const { main: run } = await load()
    await run(rest, `voidflow tokens ${provider}`)
}
