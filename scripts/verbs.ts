/**
 * The fleet verbs over the per-tool commands:
 *
 *   voidflow plan  [rulesets|settings|tokens [provider]] [--repo <name>]   # read-only
 *   voidflow check [rulesets|settings|tokens [provider]] [--repo <name>]   # exit 1 on drift
 *   voidflow apply  rulesets|settings|tokens [provider]  --repo <name> | --entire-fleet
 *
 * settings run only on a repo's voidflow.config.ts (scripts/settings.ts).
 *
 * Each finds the tool's config (scripts/lib/discover.ts), prints a header
 * line to stderr, then runs `voidflow <tool> --config <file> [--check|--apply]`
 * as a child process with the remaining flags (token tools run as
 * `voidflow tokens <provider>`, cf when none is named; see
 * scripts/lib/providers.ts). See
 * docs/fleet.md.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkRepos } from '../cloudflare/tokens.ts'
import {
    adminTokenVar,
    type CloudflareConfig,
    type VoidflowConfig,
} from '../config/index.ts'
import { checkFleet } from '../rulesets/index.ts'
import { credentialSource } from './init/gh.ts'
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
    DEFAULT_PROVIDER,
    PROVIDERS,
    type Provider,
    providerOf,
    TOKEN_TOOLS,
} from './lib/providers.ts'
import {
    findRepoConfig,
    loadVoidflowConfig,
    repoSlug,
} from './lib/repo-config.ts'

type Verb = 'plan' | 'check' | 'apply'

/** Fleet tools in run order, rulesets first. */
const TOOLS: Tool[] = ['rulesets', ...TOKEN_TOOLS]

/** A tool the verbs run; `settings` exists only for a voidflow.config.ts. */
export type RepoTool = Tool | 'settings'

/** Flags the verb sets itself, or that belong to the per-tool command only. */
const REFUSED: Record<string, string> = {
    '--apply': 'the verb decides; use `voidflow apply`',
    '--check': 'the verb decides; use `voidflow check`',
    '--try': 'use `voidflow tokens cf --try`',
    '--groups': 'use `voidflow tokens cf --groups`',
    '--repo-config':
        'the verbs find the repo file themselves; run them inside that repo',
}

export type VerbArgs = {
    tool?: RepoTool
    provider?: Provider
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
        if (Object.hasOwn(REFUSED, flag))
            throw new Error(`${flag}: ${REFUSED[flag]}`)
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
    if (first === 'rulesets' || first === 'settings') {
        if (second !== undefined)
            throw new Error(
                `${first} takes no provider, got ${JSON.stringify(second)}`,
            )
        out.tool = first
    } else if (first === 'tokens') {
        const provider = second ?? DEFAULT_PROVIDER
        if (Object.hasOwn(PROVIDERS, provider)) {
            out.provider = provider as Provider
            out.tool = PROVIDERS[provider as Provider]
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
            `unknown tool ${JSON.stringify(first)} (rulesets, settings or tokens <provider>)`,
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
            ? 'usage: voidflow apply rulesets|settings|tokens [provider] (--repo <name> | --entire-fleet) [flags]'
            : `usage: voidflow ${verb} [rulesets|settings|tokens [provider]] [--repo <name>] [flags]`
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
Without a tool, ${verb === 'apply' ? 'apply refuses' : 'runs each configured tool, rulesets first'}; \`tokens\` alone means \`tokens ${DEFAULT_PROVIDER}\`.

Inside a repo with a voidflow.config.ts (and no --config or VOIDFLOW_CONFIG),
rulesets and settings run from that file for that repo only, and so do tokens
when it has a cloudflare section. settings exist only there. For token
verbs, --repo and --entire-fleet select the fleet instead. Without a tool,
settings are skipped when gh lacks admin on the repo, and tokens run only
when the section's admin token variable is set. See docs/config.md.`

/** Why per-repo mode refuses these arguments, or null when it takes them. */
export function repoModeError(v: VerbArgs): string | null {
    if (v.repo !== undefined)
        return '--repo does not apply to a per-repo config; it manages the repo it sits in'
    if (v.entireFleet)
        return '--entire-fleet does not apply to a per-repo config; it manages the repo it sits in'
    return null
}

export { credentialSource }

const VERB_FLAG: Record<Verb, string[]> = {
    plan: [],
    check: ['--check'],
    apply: ['--apply'],
}

/** The user-facing name of a tool: `rulesets`, `settings` or `tokens cf`. */
const toolName = (tool: RepoTool) => {
    if (tool === 'settings') return tool
    const provider = providerOf(tool)
    return provider ? `tokens ${provider}` : tool
}

function shellArg(arg: string): string {
    return /^[\w@%+=:,./-]+$/u.test(arg)
        ? arg
        : `'${arg.replaceAll("'", "'\\''")}'`
}

/**
 * The complete command a plan or check child can recommend to apply its
 * changes. Fleet plans without a repo apply to the entire fleet.
 */
export function applyHint(
    tool: RepoTool,
    file: string | undefined,
    rest: string[],
    entireFleet: boolean,
): string {
    const args = [
        'voidflow',
        'apply',
        ...toolName(tool).split(' '),
        ...(file === undefined ? [] : ['--config', file]),
        ...(entireFleet ? ['--entire-fleet'] : []),
        ...rest,
    ]
    return args.map(shellArg).join(' ')
}

/** Environment for a verb child, including its complete apply hint. */
export function verbChildEnv(hint: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        VOIDFLOW_VIA_VERB: '1',
        VOIDFLOW_APPLY_HINT: hint,
    }
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

/**
 * The per-tool command line for one verb run on a voidflow.config.ts.
 * `bare` (no tool named) lets settings skip when it cannot check.
 */
export function repoToolArgs(
    verb: Verb,
    file: string,
    rest: string[],
    tool: RepoTool = 'rulesets',
    bare = false,
): string[] {
    const provider = tool === 'settings' ? undefined : providerOf(tool)
    return [
        ...(provider ? ['tokens', provider] : [tool]),
        '--repo-config',
        file,
        ...VERB_FLAG[verb],
        ...(tool === 'settings' && bare ? ['--if-admin'] : []),
        ...rest,
    ]
}

/**
 * The tools one verb runs on a voidflow.config.ts: a named tool alone;
 * otherwise rulesets, settings (which skips itself without admin), then
 * tokens when the file has a cloudflare section and its admin token variable
 * is set (so a repo's CI, which has neither, still checks rulesets), with
 * `skipped` saying why tokens did not run.
 */
export function repoModeTools(
    v: VerbArgs,
    cf: CloudflareConfig | undefined,
    env: Record<string, string | undefined>,
): { run: RepoTool[]; skipped?: string } {
    if (v.tool) return { run: [v.tool] }
    const always: RepoTool[] = ['rulesets', 'settings']
    if (!cf)
        return {
            run: always,
            skipped:
                'tokens skipped (no cloudflare section in voidflow.config.ts)',
        }
    const admin = adminTokenVar(cf)
    if (!env[admin])
        return {
            run: always,
            skipped: `tokens skipped (${admin} not set)`,
        }
    return { run: [...always, 'cf-tokens'] }
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

/**
 * One verb run on the repo's own validated voidflow.config.ts: for each tool
 * (repoModeTools) prints the header and re-runs `voidflow rulesets` or
 * `voidflow tokens cf` on it. Exits with the worst tool's code.
 */
async function runRepoMode(
    verb: Verb,
    v: VerbArgs,
    prog: string,
    file: string,
    cfg: VoidflowConfig,
): Promise<never> {
    const refused = repoModeError(v)
    if (refused) fail(`${prog}: ${refused}`)
    const cf: CloudflareConfig | undefined = cfg.cloudflare
    let slug: string
    try {
        slug = await repoSlug(process.env, dirname(file))
    } catch (e) {
        fail(`${prog}: ${(e as Error).message}`)
    }
    const { run, skipped } = repoModeTools(v, cf, process.env)
    if (skipped) console.error(`${prog}: ${skipped}`)
    const codes: number[] = []
    for (const tool of run) {
        const credential =
            tool !== 'cf-tokens' || !cf
                ? credentialSource(process.env)
                : adminTokenVar(cf)
        console.error(
            `voidflow ${version()} ${verb} ${toolName(tool)} | config ${file} (repo) | repo ${slug} | credential ${credential}`,
        )
        const r = spawnSync(
            process.execPath,
            [
                cliPath(),
                ...repoToolArgs(verb, file, v.rest, tool, v.tool === undefined),
            ],
            {
                stdio: 'inherit',
                env: verbChildEnv(applyHint(tool, undefined, v.rest, false)),
            },
        )
        if (r.error)
            console.error(`${prog}: ${toolName(tool)}: ${r.error.message}`)
        codes.push(r.error || r.status === null ? 2 : r.status)
    }
    process.exit(worstExit(codes))
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
                `${prog}: apply needs a tool: voidflow apply rulesets|settings|tokens [provider]\n\n${usage(verb)}`,
            )

        // Inside a repo with a voidflow.config.ts, the verbs run from that
        // file unless the fleet is named explicitly. Token verbs also honor
        // --repo and --entire-fleet as explicit fleet intent.
        const repoFile =
            v.config === undefined && !process.env.VOIDFLOW_CONFIG
                ? findRepoConfig(process.cwd())
                : null
        // Explicit fleet intent for token verbs skips the repo file entirely,
        // so an invalid local cloudflare section can't block a fleet run.
        const tokenFleetTarget =
            v.tool === 'cf-tokens' && (v.repo !== undefined || v.entireFleet)
        if (repoFile && !tokenFleetTarget) {
            let cfg: VoidflowConfig
            try {
                cfg = await loadVoidflowConfig(repoFile)
            } catch (e) {
                fail(`${prog}: ${(e as Error).message}`)
            }
            const fromRepo =
                v.tool !== 'cf-tokens' || cfg.cloudflare !== undefined
            if (fromRepo) return runRepoMode(verb, v, prog, repoFile, cfg)
        }

        if (v.tool === 'settings')
            fail(
                `${prog}: settings are per-repo; run inside a repo with voidflow.config.ts`,
            )
        const wanted: Tool[] = v.tool ? [v.tool] : TOOLS

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
                else if (v.tool)
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
                `${prog}: no fleet config found; looked in ${lookedIn(wanted[0], v, xdg)} (for ${wanted.map((t) => TOOL_FILE[t]).join(' or ')})`,
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

        if (found.some(([tool]) => tool === 'rulesets'))
            console.error(
                'voidflow: fleet configs are deprecated for rulesets; move each repo to a voidflow.config.ts (docs/config.md)',
            )

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
                {
                    stdio: 'inherit',
                    env: verbChildEnv(
                        applyHint(tool, hit.file, v.rest, v.repo === undefined),
                    ),
                },
            )
            if (r.error) console.error(`${prog}: ${tool}: ${r.error.message}`)
            codes.push(r.error || r.status === null ? 2 : r.status)
        }
        process.exit(worstExit(codes))
    }
}
