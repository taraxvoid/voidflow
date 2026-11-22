#!/usr/bin/env node
/**
 * The `voidflow` bin, run inside a repo with a voidflow.config.ts:
 *
 *   voidflow plan|check [rulesets|settings|tokens]
 *   voidflow apply rulesets|settings|tokens [--prune] [--rotate] [--yes]
 *   voidflow try tokens <env> -- <command...>
 *   voidflow validate
 *   voidflow init --kind tool|site [...]
 *   voidflow --version
 *
 * The verbs are scripts/verbs.ts; each lists its flags with --help.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from './lib/package-root.ts'

type Main = (argv: string[], prog: string) => Promise<void>

const verb = (v: 'plan' | 'check' | 'apply' | 'try' | 'validate') => () =>
    import('./verbs.ts').then((m) => ({ main: m.verbMain(v) }))

const COMMANDS: Record<
    string,
    { load: () => Promise<{ main: Main }>; about: string }
> = {
    plan: {
        load: verb('plan'),
        about: 'show what apply would change (rulesets, settings, tokens)',
    },
    check: { load: verb('check'), about: 'plan, exiting 1 on drift' },
    apply: {
        load: verb('apply'),
        about: 'make GitHub (or Cloudflare) match voidflow.config.ts',
    },
    validate: {
        load: verb('validate'),
        about: 'check voidflow.config.ts, with no network calls',
    },
    try: {
        load: verb('try'),
        about: 'run a command with a throwaway token scoped like an env',
    },
    init: {
        load: () => import('./init.ts'),
        about: 'write starter files and apply repo settings',
    },
}

/** Commands from before the verbs took presets, and what replaced them. */
const REMOVED: Record<string, string> = {
    rulesets: 'voidflow plan|check|apply rulesets',
    settings: 'voidflow plan|check|apply settings',
    tokens: 'voidflow plan|check|apply tokens, or voidflow try tokens <env> -- <command>',
    'cf-tokens':
        'voidflow plan|check|apply tokens, or voidflow try tokens <env> -- <command>',
}

const usage = () =>
    [
        'usage: voidflow <command> [flags]',
        '',
        ...Object.entries(COMMANDS).map(
            ([name, c]) => `  ${name.padEnd(10)} ${c.about}`,
        ),
        '',
        'Run `voidflow <command> --help` for its flags, or `voidflow --version`.',
    ].join('\n')

const [name, ...rest] = process.argv.slice(2)
if (name === undefined || name === '-h' || name === '--help') {
    console.log(usage())
    process.exit(name === undefined ? 2 : 0)
}
if (name === '-v' || name === '--version') {
    console.log(
        JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8'))
            .version as string,
    )
    process.exit(0)
}
if (name.startsWith('-')) {
    console.error(
        `the command comes before its flags, got ${JSON.stringify(name)}\n\n${usage()}`,
    )
    process.exit(2)
}

if (Object.hasOwn(REMOVED, name)) {
    console.error(
        `voidflow ${name} was replaced by \`${REMOVED[name]}\`, run inside the repo whose voidflow.config.ts it reads (fleet configs were removed; see docs/config.md)`,
    )
    process.exit(2)
}
const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
if (!cmd) {
    console.error(`unknown command ${JSON.stringify(name)}\n\n${usage()}`)
    process.exit(2)
}
try {
    await (await cmd.load()).main(rest, `voidflow ${name}`)
} catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    console.error(`voidflow ${name}: ${err.message}`)
    if (err.cause) console.error(`  cause: ${String(err.cause)}`)
    if (process.env.VOIDFLOW_DEBUG) console.error(err.stack)
    else console.error('  (set VOIDFLOW_DEBUG=1 for the stack trace)')
    process.exit(1)
}
