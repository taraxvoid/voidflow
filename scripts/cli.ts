#!/usr/bin/env bun
/**
 * The `voidflow` bin: the fleet tools, for an org's infra repo to run from a
 * pinned release instead of a voidflow checkout.
 *
 *   bunx @taraxvoid/voidflow@<version> cf-tokens --config cf-tokens.ts [--apply ...]
 *   bunx @taraxvoid/voidflow@<version> rulesets --config rulesets.ts [--check ...]
 *
 * Each command takes the same flags as its script (scripts/cf-tokens.ts,
 * scripts/apply-rulesets.ts); a relative --config resolves from the current
 * directory.
 */

const COMMANDS: Record<string, { script: string; about: string }> = {
    'cf-tokens': {
        script: './cf-tokens.ts',
        about: 'plan, apply or rotate scoped Cloudflare deploy tokens',
    },
    rulesets: {
        script: './apply-rulesets.ts',
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
        "Flags are those of the command's script; see voidflow's CONTRIBUTING.md.",
    ].join('\n')

const name = process.argv[2]
if (name === undefined || name === '-h' || name === '--help') {
    console.log(usage())
    process.exit(name === undefined ? 2 : 0)
}
const cmd = COMMANDS[name]
if (!cmd) {
    console.error(`unknown command ${JSON.stringify(name)}\n\n${usage()}`)
    process.exit(2)
}
// The scripts parse process.argv.slice(2), so drop the command name.
process.argv.splice(2, 1)
await import(cmd.script)
