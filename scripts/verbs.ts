/**
 * The fleet verbs over the per-tool commands:
 *
 *   voidflow plan  [rulesets|tokens [provider]] [--repo <name>]   # read-only
 *   voidflow check [rulesets|tokens [provider]] [--repo <name>]   # exit 1 on drift
 *   voidflow apply  rulesets|tokens <provider>  --repo <name> | --entire-fleet
 *
 * Each finds the tool's config (scripts/lib/discover.ts), prints a header
 * line to stderr, then runs `voidflow <tool> --config <file> [--check|--apply]`
 * as a child process with the remaining flags (token tools run as
 * `voidflow tokens <provider>`; see scripts/lib/providers.ts). See
 * docs/fleet.md.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkRepos } from '../cloudflare/tokens.ts'
import { checkFleet } from '../rulesets/index.ts'
import { loadConfig } from './lib/config.ts'
import {
    discover,
    type Found,
    TOOL_FILE,
    type Tool,
    xdgDir,
} from './lib/discover.ts'
import { packageRoot } from './lib/package-root.ts'
import {
    PROVIDERS,
    type Provider,
    providerOf,
    TOKEN_TOOLS,
} from './lib/providers.ts'

type Verb = 'plan' | 'check' | 'apply'

/** Tools in run order, rulesets first. */
const TOOLS: Tool[] = ['rulesets', ...TOKEN_TOOLS]

/** Flags the verb sets itself, or that belong to the per-tool command only. */
const REFUSED: Record<string, string> = {
    '--apply': 'the verb decides; use `voidflow apply`',
    '--check': 'the verb decides; use `voidflow check`',
    '--try': 'use `voidflow tokens cf --try`',
    '--groups': 'use `voidflow tokens cf --groups`',
}

export type VerbArgs = {
    tool?: Tool
    provider?: Provider
    /** `tokens` with no provider: run every token provider. */
    tokensAll?: boolean
    config?: string
    entireFleet: boolean
    repo?: string
    rest: string[]
}

/**
 * Split the verb's own arguments from the tool's: the first positional is the
 * tool (`rulesets`, or `tokens` with an optional provider), `--config` and
 * `--entire-fleet` are consumed, `--repo` is recorded and kept for the tool,
 * everything else is forwarded. Throws on a bad argument.
 */
export function splitVerbArgs(argv: string[]): VerbArgs {
    const out: VerbArgs = { entireFleet: false, rest: [] }
    const pos: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--') {
            out.rest.push(...argv.slice(i))
            break
        }
        const [flag, inline] = a.startsWith('--')
            ? (a.split(/=(.*)/s, 2) as [string, string | undefined])
            : [a, undefined]
        if (flag in REFUSED) throw new Error(`${flag}: ${REFUSED[flag]}`)
        if (flag === '--config') {
            const v = inline ?? argv[++i]
            if (v === undefined || v === '')
                throw new Error('--config needs a value')
            out.config = v
        } else if (flag === '--entire-fleet') {
            if (inline !== undefined)
                throw new Error('--entire-fleet takes no value')
            out.entireFleet = true
        } else if (a.startsWith('-')) {
            out.rest.push(a)
            if (flag === '--repo') {
                const v = inline ?? argv[i + 1]
                if (!v || (inline === undefined && v.startsWith('-')))
                    throw new Error('--repo needs a value')
                if (inline === undefined) out.rest.push(argv[++i])
                out.repo = v
            }
        } else {
            pos.push(a)
        }
    }
    const [first, second, third] = pos
    if (first === 'rulesets') {
        if (second !== undefined)
            throw new Error(
                `rulesets takes no provider, got ${JSON.stringify(second)}`,
            )
        out.tool = 'rulesets'
    } else if (first === 'tokens') {
        if (second === undefined) {
            out.tokensAll = true
        } else if (second in PROVIDERS) {
            out.provider = second as Provider
            out.tool = PROVIDERS[second as Provider]
        } else {
            throw new Error(
                `unknown provider ${JSON.stringify(second)} (${Object.keys(PROVIDERS).join(' or ')})`,
            )
        }
        if (third !== undefined)
            throw new Error(
                `one provider at a time, got ${JSON.stringify(third)} after ${second}`,
            )
    } else if (first !== undefined) {
        throw new Error(
            `unknown tool ${JSON.stringify(first)} (rulesets or tokens <provider>)`,
        )
    }
    return out
}

/** The repos `--repo` names: an exact owner/name, or a bare name. */
function matches(repos: string[], name: string): string[] {
    return repos.filter(
        (r) => r === name || (!name.includes('/') && r.split('/')[1] === name),
    )
}

/**
 * Why `apply` may not run with these targets, or null when it may: exactly
 * one of `--entire-fleet`, or `--repo` naming a single repo in `repos`.
 */
export function applyTargetError(
    repos: string[],
    v: { repo?: string; entireFleet: boolean },
): string | null {
    const list = repos.map((r) => `  ${r}`).join('\n') || '  (none)'
    if (v.entireFleet && v.repo !== undefined)
        return 'apply takes --repo <name> or --entire-fleet, not both'
    if (v.entireFleet) return null
    if (v.repo === undefined)
        return `apply needs a target: --repo <name> for one repo, or --entire-fleet for all of them. Repos:\n${list}`
    const hit = matches(repos, v.repo)
    if (hit.length === 1) return null
    if (hit.length === 0)
        return `no repo matches --repo ${v.repo}. Repos:\n${list}`
    return `--repo ${v.repo} matches several repos, name one as owner/name:\n${hit.map((r) => `  ${r}`).join('\n')}`
}

/** The exit code for a run of several tools: 2 over 1 over 0. */
export function worstExit(codes: number[]): 0 | 1 | 2 {
    if (codes.includes(2)) return 2
    return codes.some((c) => c !== 0) ? 1 : 0
}

const usage = (verb: Verb) =>
    `${
        verb === 'apply'
            ? 'usage: voidflow apply rulesets|tokens <provider> (--repo <name> | --entire-fleet) [flags]'
            : `usage: voidflow ${verb} [rulesets|tokens [provider]] [--repo <name>] [flags]`
    }

  --config <file|dir>  the fleet config: a tool's module, or the infra repo
                       directory holding rulesets.ts and cf-tokens.ts.
                       Otherwise found from VOIDFLOW_CONFIG, then
                       $XDG_CONFIG_HOME/voidflow (~/.config/voidflow), then
                       the nearest directory up from here holding the file
  --repo <name>        only this repo (owner/name, or a name unique in the config)${
      verb === 'apply'
          ? '\n  --entire-fleet       apply to every repo in the config'
          : ''
  }

${
    verb === 'plan'
        ? 'Read-only: prints what apply would change.'
        : verb === 'check'
          ? 'Read-only: exit 1 on drift, 2 on a config or auth error.'
          : 'Writes. Other flags (--prune, --rotate) go to the tool; see `voidflow <tool> --help`.'
}
Without a tool, ${verb === 'apply' ? 'apply refuses' : 'runs each configured tool, rulesets first'}; \`tokens\` alone runs every tokens provider.`

const VERB_FLAG: Record<Verb, string[]> = {
    plan: [],
    check: ['--check'],
    apply: ['--apply'],
}

/** The user-facing name of a tool: `rulesets` or `tokens cf`. */
const toolName = (tool: Tool) => {
    const provider = providerOf(tool)
    return provider ? `tokens ${provider}` : tool
}

/**
 * The per-tool command line for one verb run. The verb's flag goes before the
 * forwarded flags: after a `--` in them it would be a positional, and check
 * or apply would silently plan.
 */
export function toolArgs(
    verb: Verb,
    tool: Tool,
    file: string,
    rest: string[],
): string[] {
    const provider = providerOf(tool)
    return [
        ...(provider ? ['tokens', provider] : [tool]),
        '--config',
        file,
        ...VERB_FLAG[verb],
        ...rest,
    ]
}

/** Where discovery looked, for a "not found" message. */
function lookedIn(tool: Tool, v: VerbArgs, xdg: string): string {
    const file = TOOL_FILE[tool]
    if (v.config !== undefined) return `--config ${v.config}`
    if (process.env.VOIDFLOW_CONFIG)
        return `VOIDFLOW_CONFIG ${process.env.VOIDFLOW_CONFIG}`
    if (isDir(xdg))
        return `${xdg} (it exists, so ${process.cwd()} and the directories above it were not searched; add ${file} there, or set --config or VOIDFLOW_CONFIG to point elsewhere)`
    return `${xdg}, then ${file} in ${process.cwd()} and each directory above it (set --config or VOIDFLOW_CONFIG to point elsewhere)`
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory()
    } catch {
        return false
    }
}

/** The repo keys of a tool's config file; throws on a bad config. */
async function reposIn(tool: Tool, file: string): Promise<string[]> {
    return Object.keys(await loadConfig(file, '/', CHECKS[tool]))
}

function version(): string {
    try {
        return JSON.parse(
            readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
        ).version
    } catch {
        return 'unknown'
    }
}

/** The bin to re-run: the source cli under Bun, the built one otherwise. */
function cliPath(): string {
    return join(
        packageRoot(),
        import.meta.url.endsWith('.ts')
            ? 'scripts/cli.ts'
            : 'dist/scripts/cli.js',
    )
}

const CHECKS: Record<Tool, (x: unknown) => Record<string, unknown>> = {
    rulesets: checkFleet,
    'cf-tokens': checkRepos,
}

function fail(msg: string): never {
    console.error(msg)
    process.exit(2)
}

/** The `main` of one verb, for scripts/cli.ts. */
export function verbMain(verb: Verb) {
    return async (argv: string[], prog = `voidflow ${verb}`): Promise<void> => {
        const end = argv.indexOf('--')
        const head = end === -1 ? argv : argv.slice(0, end)
        if (head.some((a) => a === '-h' || a === '--help')) {
            console.log(usage(verb))
            process.exit(0)
        }
        let v: VerbArgs
        try {
            v = splitVerbArgs(argv)
        } catch (e) {
            fail(`${prog}: ${(e as Error).message}\n\n${usage(verb)}`)
        }
        if (verb === 'apply' && !v.tool)
            fail(
                v.tokensAll
                    ? `${prog}: apply tokens needs a provider: voidflow apply tokens <provider> (${Object.keys(PROVIDERS).join(' or ')})\n\n${usage(verb)}`
                    : `${prog}: apply needs a tool: voidflow apply rulesets|tokens <provider>\n\n${usage(verb)}`,
            )

        const wanted: Tool[] = v.tool
            ? [v.tool]
            : v.tokensAll
              ? TOKEN_TOOLS
              : TOOLS

        const env = process.env
        const home = homedir()
        const xdg = xdgDir({ env, home })

        let found: [Tool, Found][] = []
        try {
            for (const tool of wanted) {
                const hit = discover(tool, {
                    flag: v.config,
                    env,
                    cwd: process.cwd(),
                    home,
                })
                if (hit) found.push([tool, hit])
                else if (v.tool || v.tokensAll)
                    fail(
                        `${prog}: ${toolName(tool)}: no ${TOOL_FILE[tool]} found; looked in ${lookedIn(tool, v, xdg)}`,
                    )
                else
                    console.error(
                        `${prog}: ${toolName(tool)}: no ${TOOL_FILE[tool]} in ${lookedIn(tool, v, xdg)}, skipped`,
                    )
            }
        } catch (e) {
            fail(`${prog}: ${(e as Error).message}`)
        }
        if (found.length === 0)
            fail(
                `${prog}: no fleet config found; looked in ${lookedIn('rulesets', v, xdg)} (for rulesets.ts or cf-tokens.ts)`,
            )
        // A --config or VOIDFLOW_CONFIG file (not a directory) is the same
        // file for every tool.
        if (
            !v.tool &&
            found.length > 1 &&
            found.length === wanted.length &&
            found.every(([, f]) => f.file === found[0][1].file)
        )
            fail(
                `${prog}: ${v.config !== undefined ? `--config ${v.config}` : `VOIDFLOW_CONFIG ${process.env.VOIDFLOW_CONFIG}`} is a file, so name the tool it is for: voidflow ${verb} rulesets or tokens <provider>`,
            )

        // Without a tool, --repo runs only the tools whose config lists it, so
        // a repo in one config is not a "no repo matches" error from the other.
        if (!v.tool && v.repo !== undefined) {
            const repo = v.repo
            const listed: [Tool, Found][] = []
            for (const [tool, hit] of found) {
                let repos: string[]
                try {
                    repos = await reposIn(tool, hit.file)
                } catch (e) {
                    fail((e as Error).message)
                }
                if (matches(repos, repo).length > 0) listed.push([tool, hit])
                else
                    console.error(
                        `${prog}: ${toolName(tool)}: no repo matches --repo ${repo} in ${hit.file}, skipped`,
                    )
            }
            if (listed.length === 0)
                fail(
                    `${prog}: no repo matches --repo ${repo} in ${found.map(([, f]) => f.file).join(' or ')}`,
                )
            found = listed
        }

        let scope: string
        if (verb === 'apply') {
            const [tool, hit] = found[0]
            let repos: string[]
            try {
                repos = await reposIn(tool, hit.file)
            } catch (e) {
                fail((e as Error).message)
            }
            const err = applyTargetError(repos, v)
            if (err) fail(`${prog}: ${err}`)
            scope = v.entireFleet
                ? 'entire fleet'
                : `repo ${matches(repos, v.repo as string)[0]}`
        } else {
            scope =
                v.repo === undefined
                    ? 'fleet (read-only)'
                    : `repo ${v.repo} (read-only)`
        }

        const ver = version()
        const cli = cliPath()
        const codes: number[] = []
        for (const [tool, hit] of found) {
            console.error(
                `voidflow ${ver} ${verb} ${toolName(tool)} | config ${hit.file} (${hit.via}) | scope ${scope}`,
            )
            const r = spawnSync(
                process.execPath,
                [cli, ...toolArgs(verb, tool, hit.file, v.rest)],
                { stdio: 'inherit' },
            )
            if (r.error) console.error(`${prog}: ${tool}: ${r.error.message}`)
            codes.push(r.error || r.status === null ? 2 : r.status)
        }
        process.exit(worstExit(codes))
    }
}
