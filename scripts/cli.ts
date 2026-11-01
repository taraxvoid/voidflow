#!/usr/bin/env node
/**
 * The `voidflow` bin: the fleet tools, for an org's infra repo to run from a
 * pinned release instead of a voidflow checkout.
 *
 *   bunx @taraxvoid/voidflow@<version> cf-tokens --config cf-tokens.ts [--apply ...]
 *   bunx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts [--check ...]
 *
 * Each command takes the same flags as its script (scripts/cf-tokens.ts,
 * scripts/apply-rulesets.ts) and lists them with --help. A relative --config
 * resolves from VOIDFLOW_CONFIG_BASE when that is set, else the current
 * directory.
 */

type Main = (argv: string[], prog: string) => Promise<void>

const COMMANDS: Record<string, { load: () => Promise<{ main: Main }>; about: string }> = {
    'cf-tokens': {
        load: () => import('./cf-tokens.ts'),
        about: 'plan, apply or rotate scoped Cloudflare deploy tokens',
    },
    rulesets: {
        load: () => import('./apply-rulesets.ts'),
        about: 'plan or apply branch rulesets',
    },
}

const usage = () =>
    [
        'usage: voidflow <command> --config <module> [flags]',
        '',
        ...Object.entries(COMMANDS).map(
            ([name, c]) => `  ${name.padEnd(10)} ${c.about}`,
        ),
        '',
        'Run `voidflow <command> --help` for its flags.',
    ].join('\n')

const [name, ...rest] = process.argv.slice(2)
if (name === undefined || name === '-h' || name === '--help') {
    console.log(usage())
    process.exit(name === undefined ? 2 : 0)
}
if (name.startsWith('-')) {
    console.error(`the command comes before its flags, got ${JSON.stringify(name)}\n\n${usage()}`)
    process.exit(2)
}
const cmd = COMMANDS[name]
if (!cmd) {
    console.error(`unknown command ${JSON.stringify(name)}\n\n${usage()}`)
    process.exit(2)
}
await (await cmd.load()).main(rest, `voidflow ${name}`)
