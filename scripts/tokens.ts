/**
 * `voidflow tokens <provider>`: the token providers' shared entry point.
 * The provider is the first argument; the rest goes to its script, which
 * takes --config and the same flags as before:
 *
 *   voidflow tokens cf --config cf-tokens.ts [--apply ...]
 *   voidflow tokens cf --repo example_project --try prod -- bunx wrangler deploy
 *
 * Providers live in scripts/lib/providers.ts; each keeps its own
 * <provider>-tokens.ts fleet config.
 */
import { PROVIDERS, type Provider } from './lib/providers.ts'

type Main = (argv: string[], prog: string) => Promise<void>

/** Provider id -> its script, loaded lazily so --help stays cheap. */
const MODULES: Record<Provider, () => Promise<{ main: Main }>> = {
    cf: () => import('./cf-tokens.ts'),
}

const usage = (prog: string) =>
    [
        `usage: ${prog} <provider> [flags]`,
        '',
        `providers: ${Object.keys(PROVIDERS).join(', ')}`,
        '',
        `Run \`${prog} <provider> --help\` for a provider's flags.`,
    ].join('\n')

export async function main(argv: string[], prog = 'voidflow tokens') {
    const [provider, ...rest] = argv
    if (provider === '-h' || provider === '--help') {
        console.log(usage(prog))
        process.exit(0)
    }
    const load =
        provider === undefined ? undefined : MODULES[provider as Provider]
    if (load === undefined) {
        console.error(
            `${
                provider === undefined
                    ? 'needs a provider'
                    : `unknown provider ${JSON.stringify(provider)}`
            } (${Object.keys(PROVIDERS).join(' or ')})\n\n${usage(prog)}`,
        )
        process.exit(2)
    }
    const { main: run } = await load()
    await run(rest, `voidflow tokens ${provider}`)
}
