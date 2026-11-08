/**
 * `voidflow init`: write a repo's starter files and apply the GitHub repo
 * settings voidflow wants. Safe to re-run: identical files are `unchanged`,
 * settings already as desired are `unchanged`.
 *
 *   voidflow init --kind tool                    # files and settings, current dir
 *   voidflow init --kind site --dry-run ../app   # plan only
 *   voidflow init --preset settings              # settings only, no --kind needed
 *
 * node: APIs only, so it runs under Node 24+ as well as Bun.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkFleet, type Fleet } from '../rulesets/index.ts'
import {
    applyFiles,
    FILE_ITEMS,
    type FileAction,
    fileNames,
    planFiles,
} from './init/files.ts'
import { addToFleet } from './init/fleet.ts'
import {
    type Gh,
    ghAvailable,
    ghCli,
    ownerType,
    resolveRepo,
    rulesetsPlanGated,
} from './init/gh.ts'
import {
    resolveSha as defaultResolveSha,
    type Kind,
    type RenderCtx,
} from './init/render.ts'
import { defaultFleet, runRulesets } from './init/rulesets.ts'
import {
    manualReminders,
    runSettings,
    type SettingResult,
    settingNames,
} from './init/settings.ts'
import { parseOrExit } from './lib/args.ts'
import { loadOrExit } from './lib/config.ts'
import { configPath } from './lib/discover.ts'
import { packageRoot } from './lib/package-root.ts'
import { capture } from './lib/proc.ts'

/**
 * Presets are data: each names the file items it selects and whether the
 * settings half runs. A new preset is one more entry here.
 */
export const PRESETS: Record<
    string,
    { files: 'all' | string[] | null; settings: boolean; rulesets?: boolean }
> = {
    full: { files: 'all', settings: true },
    files: { files: 'all', settings: false },
    settings: { files: null, settings: true },
    ci: { files: ['ci'], settings: false },
    codeowners: { files: ['codeowners'], settings: false },
    // Opt-in only: rulesets block direct pushes to main, which surprises a
    // fresh repo before its first push.
    rulesets: { files: null, settings: false, rulesets: true },
}

const KINDS: Kind[] = ['tool', 'site']

const OPTIONS = {
    kind: { type: 'string' },
    preset: { type: 'string', default: 'full' },
    skip: { type: 'string', multiple: true, default: [] as string[] },
    'enable-pvr': { type: 'boolean', default: false },
    'enable-ai-scan': { type: 'boolean', default: false },
    'enable-agentic': { type: 'boolean', default: false },
    'agentic-stage': { type: 'string', default: 'shadow' },
    repo: { type: 'string' },
    owner: { type: 'string' },
    config: { type: 'string' },
    force: { type: 'boolean', short: 'f', default: false },
    'dry-run': { type: 'boolean', default: false },
} as const

const usage = (prog: string) => `usage: ${prog} --kind tool|site [flags] [dir]

  --kind tool|site        which starter files to write (not needed with --preset settings)
  --preset <name>         ${Object.keys(PRESETS).join('|')}(default full)
  --skip <name>           leave this file or setting out (repeatable, names below)
  --enable-pvr            opt in: private vulnerability reporting and SECURITY.md
  --enable-ai-scan        opt in: AI Scan for pull requests
  --enable-agentic        opt in (experimental): deps-review, its caller workflow, and the repo settings and labels it relies on
  --agentic-stage <s>     with --enable-agentic: shadow (default; nothing merges) or gate (adds the gate job and Renovate automerge)
  --repo owner/name       the GitHub repo (default: the origin remote)
  --owner @handle         CODEOWNERS owner: @user or @org/team (default: the repo owner when it is a user)
  --config <module|dir>   the fleet rulesets config (in your infra repo; a directory means its rulesets.ts): add the repo to it, or with --preset rulesets take this repo's entry from it
  -f, --force             overwrite files that differ
  --dry-run               plan both halves, write and change nothing

dir defaults to the current directory and must be a git work tree. Settings
need the gh CLI, authenticated as someone with admin on the repo.

Files:    ${FILE_ITEMS.map((i) => i.name).join(', ')}
Settings: ${settingNames().join(', ')}`

type Deps = {
    gh?: Gh
    /** Runs `gh aw` in dir; for tests. */
    ghAw?: (
        args: string[],
        dir: string,
    ) => Promise<{ code: number; err: string }>
    resolveSha?: (version: string) => Promise<string | null>
}

function fail(msg: string, prog: string): never {
    console.error(`${msg}\n\n${usage(prog)}`)
    process.exit(2)
}

const row = (status: string, name: string, extra = '') =>
    `  ${status.padEnd(16)}${extra ? `${name.padEnd(28)} ${extra}` : name}`

/** The cron minute from a voidflow-written ci.yml, so a re-run stays unchanged. */
function existingCronMinute(dir: string): number | null {
    const path = join(dir, '.github/workflows/ci.yml')
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    if (!text.includes('Written by voidflow v')) return null
    const m = /cron:\s*'(\d{1,2}) 6 \* \* \*'/.exec(text)
    const n = m ? Number(m[1]) : Number.NaN
    return n >= 0 && n <= 59 ? n : null
}

async function defaultGhAw(
    args: string[],
    dir: string,
): Promise<{ code: number; err: string }> {
    try {
        const r = await capture(['gh', 'aw', ...args], undefined, {
            timeoutMs: 120_000,
            cwd: dir,
        })
        return { code: r.code, err: r.err }
    } catch (e) {
        return { code: 127, err: (e as Error).message }
    }
}

/** The gh-aw version the reusable agentic-locks workflow compiles with by default. */
function agenticLocksGhAwVersion(): string | null {
    try {
        const text = readFileSync(
            join(packageRoot(), 'templates/common/gh-aw-version'),
            'utf8',
        ).trim()
        return /^v\d[\w.-]*$/.test(text) ? text : null
    } catch {
        return null
    }
}

/** Install the deps-review workflow with `gh aw add`, pinned to this version. */
async function installDepsReview(
    dir: string,
    version: string,
    dryRun: boolean,
    run: NonNullable<Deps['ghAw']>,
): Promise<{ name: string; status: string; detail: string }> {
    const name = 'deps-review'
    const spec = `taraxvoid/voidflow/agentic@v${version}`
    if (existsSync(join(dir, '.github/workflows/deps-review.md')))
        return { name, status: 'unchanged', detail: '' }
    if (dryRun)
        return { name, status: 'would-apply', detail: `gh aw add ${spec}` }
    const r = await run(['add', spec], dir)
    return r.code === 0
        ? { name, status: 'applied', detail: `gh aw add ${spec}` }
        : {
              name,
              status: 'failed',
              detail: `${r.err.trim().split('\n')[0] || `exit ${r.code}`}; install gh-aw and run: gh aw add ${spec}`,
          }
}

async function isWorkTree(dir: string): Promise<boolean> {
    try {
        const r = await capture(
            ['git', '-C', dir, 'rev-parse', '--is-inside-work-tree'],
            undefined,
            {
                timeoutMs: 15_000,
            },
        )
        return r.code === 0 && r.out.trim() === 'true'
    } catch {
        return false
    }
}

/**
 * The rulesets config file `--config` names, read the way the fleet verbs
 * read it (configPath: `~/` is home, relative is against VOIDFLOW_CONFIG_BASE
 * else cwd): a directory means its rulesets.ts.
 */
function rulesetsFile(config: string): string {
    const file = configPath(config, {
        env: process.env,
        cwd: process.cwd(),
        home: homedir(),
    })
    try {
        if (statSync(file).isDirectory()) return join(file, 'rulesets.ts')
    } catch {
        // missing: reported where it is read
    }
    return file
}

/** `prog` names the command in the --help usage; `deps` are for tests. */
export async function main(
    argv: string[],
    prog = 'voidflow init',
    deps: Deps = {},
) {
    const { values, positionals } = parseOrExit(
        argv,
        { options: OPTIONS, allowPositionals: true },
        usage(prog),
    )
    const preset = PRESETS[values.preset]
    if (!Object.hasOwn(PRESETS, values.preset) || !preset) {
        fail(
            `unknown --preset "${values.preset}", expected one of: ${Object.keys(PRESETS).join(', ')}`,
            prog,
        )
    }
    if (positionals.length > 1)
        fail(`expected at most one dir, got ${positionals.length}`, prog)
    const kind = values.kind as Kind | undefined
    if (kind !== undefined && !KINDS.includes(kind)) {
        fail(`unknown --kind "${kind}", expected tool or site`, prog)
    }
    const wantFiles = preset.files !== null
    if (wantFiles && kind === undefined)
        fail(`--preset ${values.preset} needs --kind tool|site`, prog)

    if (preset.rulesets && !values.config && kind !== 'tool') {
        fail(
            kind === 'site'
                ? '--preset rulesets for a site needs --config <module> (no default site rulesets yet)'
                : '--preset rulesets needs --kind tool or --config <module>',
            prog,
        )
    }

    const validFiles = kind ? fileNames(kind) : FILE_ITEMS.map((i) => i.name)
    const valid = [...validFiles, ...settingNames()]
    for (const n of values.skip) {
        if (!valid.includes(n))
            fail(
                `unknown --skip "${n}", expected one of: ${valid.join(', ')}`,
                prog,
            )
    }

    const dir = resolve(positionals[0] ?? '.')
    if (!(await isWorkTree(dir)))
        fail(`${dir} is not a git work tree (run git init first)`, prog)

    const owner = values.owner
    if (
        owner !== undefined &&
        !/^@[A-Za-z0-9][\w-]*(?:\/[A-Za-z0-9][\w-]*)?$/.test(owner)
    )
        fail(`invalid --owner "${owner}", expected @user or @org/team`, prog)

    const stage = values['agentic-stage']
    if (stage !== 'shadow' && stage !== 'gate')
        fail(
            `unknown --agentic-stage "${stage}", expected shadow or gate`,
            prog,
        )

    const dryRun = values['dry-run']
    const enablePvr = values['enable-pvr']
    const enableAiScan = values['enable-ai-scan']
    const enableAgentic = values['enable-agentic']
    const version = JSON.parse(
        readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
    ).version as string

    // The repo feeds SECURITY.md and the settings half; a failure here only
    // stops the settings half.
    let repo: string | null = null
    let repoError: string | null = null
    try {
        repo = await resolveRepo(dir, values.repo)
    } catch (e) {
        repoError = `${(e as Error).message}; pass --repo owner/name`
    }

    const out: string[] = []
    const notes: string[] = []
    let exitCode = 0

    // Files half.
    let fileActions: FileAction[] = []
    const securityPlanned = () => fileActions.some((a) => a.name === 'security')
    if (wantFiles && kind) {
        const sha = await (deps.resolveSha ?? defaultResolveSha)(version)
        if (sha === null) {
            notes.push(
                `could not resolve the v${version} tag (offline?); ci.yml pins @v${version}, Renovate pins the digest later`,
            )
        }
        const picked = preset.files === 'all' ? null : new Set(preset.files)
        // An organization cannot be a code owner, only its users and teams.
        let ownerHandle = owner ?? null
        if (
            owner === undefined &&
            repo &&
            (picked === null || picked.has('codeowners')) &&
            !values.skip.includes('codeowners')
        ) {
            const login = repo.split('/')[0] as string
            const gh = deps.gh ?? ghCli()
            const type =
                (await ghAvailable(gh)) === null
                    ? await ownerType(gh, login)
                    : null
            if (type === 'Organization') {
                notes.push(
                    `${login} is an organization, which cannot be a code owner: CODEOWNERS uses the placeholder @OWNER; pass --owner @${login}/team or @user (needs write access)`,
                )
            } else {
                ownerHandle = `@${login}`
                if (type === null)
                    notes.push(
                        `could not tell whether ${login} is a user; if it is an organization, pass --owner @${login}/team or @user for CODEOWNERS`,
                    )
            }
        }
        const ctx: RenderCtx = {
            version,
            sha,
            kind,
            repo,
            cronMinute:
                existingCronMinute(dir) ?? Math.floor(Math.random() * 60),
            stage,
            owner: ownerHandle,
        }
        const skip = new Set([
            ...values.skip,
            ...(picked ? fileNames(kind).filter((n) => !picked.has(n)) : []),
        ])
        fileActions = planFiles(
            dir,
            {
                kind,
                skip,
                force: values.force,
                enablePvr,
                enableAgentic: values['enable-agentic'],
            },
            ctx,
        )
        const conflicts = fileActions.filter((a) => a.status === 'conflict')
        out.push(dryRun ? 'files (dry run):' : 'files:')
        for (const a of fileActions)
            out.push(
                row(
                    a.status,
                    a.name,
                    [a.target, a.detail].filter(Boolean).join('  '),
                ),
            )
        if (conflicts.length > 0) {
            exitCode = 1
            out.push(
                `  nothing written: ${conflicts.length} file(s) differ (${conflicts.map((a) => a.target).join(', ')}); re-run with --force to overwrite`,
            )
        } else if (!dryRun) {
            applyFiles(dir, fileActions)
        }
        if (fileActions.some((a) => a.name === 'codeowners')) {
            if (ctx.owner == null && !repo)
                notes.push(
                    'CODEOWNERS uses the placeholder @OWNER (no repo to take the owner from); pass --owner @handle',
                )
            const gh = deps.gh ?? ghCli()
            if (
                repo &&
                (await ghAvailable(gh)) === null &&
                (await rulesetsPlanGated(gh, repo))
            )
                notes.push(
                    `CODEOWNERS is written but not enforced: ${repo} is private on a plan without rulesets (upgrade to GitHub Pro or make it public)`,
                )
        }
        const agenticPlanned = fileActions.some((a) => a.name === 'agentic')
        if (enableAgentic && (!agenticPlanned || conflicts.length > 0)) {
            notes.push(
                conflicts.length > 0
                    ? 'deps-review was not installed (file conflicts, nothing written)'
                    : 'deps-review was not installed (the files half did not include agentic)',
            )
        } else if (enableAgentic) {
            const r = await installDepsReview(
                dir,
                version,
                dryRun,
                deps.ghAw ?? defaultGhAw,
            )
            out.push('agentic:')
            out.push(row(r.status, r.name, r.detail))
            if (r.status === 'failed' && !dryRun) exitCode = 1
        }
    }

    // Settings half.
    let settingResults: SettingResult[] = []
    if (preset.settings) {
        out.push(dryRun ? 'settings (dry run):' : 'settings:')
        const gh = deps.gh ?? ghCli()
        const unavailable = repoError ?? (await ghAvailable(gh))
        if (unavailable) {
            out.push(row('unavailable', 'settings', unavailable))
            if (!dryRun) exitCode = 1
        } else if (repo) {
            settingResults = await runSettings(gh, repo, {
                skip: new Set(values.skip),
                enablePvr,
                enableAiScan,
                enableAgentic,
                dryRun,
            })
            for (const r of settingResults)
                out.push(row(r.status, r.name, r.detail))
            if (settingResults.some((r) => r.status === 'failed')) exitCode = 1
        }
    }

    // Rulesets half. A bad --config is reported even when gh is unavailable.
    if (preset.rulesets) {
        let fleet: Fleet | undefined
        if (values.config) {
            fleet = await loadOrExit(rulesetsFile(values.config), checkFleet)
            if (repo && !fleet[repo]) {
                console.error(
                    `${values.config} has no entry for ${repo}; entries: ${Object.keys(fleet).join(', ') || '(none)'}`,
                )
                process.exit(2)
            }
        }
        out.push(dryRun ? 'rulesets (dry run):' : 'rulesets:')
        const gh = deps.gh ?? ghCli()
        const unavailable = repoError ?? (await ghAvailable(gh))
        if (unavailable) {
            out.push(row('unavailable', 'rulesets', unavailable))
            if (!dryRun) exitCode = 1
        } else if (repo) {
            const results = await runRulesets(
                gh,
                repo,
                fleet ?? defaultFleet(repo),
                dryRun,
            )
            for (const r of results) out.push(row(r.status, r.name, r.detail))
            if (results.some((r) => r.status === 'failed')) exitCode = 1
        }
    }

    // Opt-ins act only on the halves that ran; say what was left out.
    if (enablePvr) {
        if (!securityPlanned())
            notes.push(
                'SECURITY.md was not written (the files half did not include it)',
            )
        if (!settingResults.some((r) => r.name === 'pvr')) {
            notes.push(
                'private vulnerability reporting was not enabled (the settings half did not include it)',
            )
        }
    }

    if (enableAgentic && !preset.settings) {
        notes.push(
            'agentic settings were not applied (the settings half did not run)',
        )
    }
    if (enableAgentic) {
        const pin = agenticLocksGhAwVersion()
        if (pin) {
            notes.push(
                `agentic-locks recompiles with gh-aw ${pin} and fails on a different lock; use the same version locally: gh extension install github/gh-aw --pin ${pin}`,
            )
        }
    }

    if (repo && preset.settings) {
        out.push('manual:')
        for (const l of manualReminders(repo, enableAiScan, enableAgentic))
            out.push(`  ${l}`)
    }
    if (notes.length > 0) {
        out.push('notes:')
        for (const n of notes) out.push(`  ${n}`)
    }
    // Fleet half: add the repo to the infra repo's rulesets config. With
    // --preset rulesets, --config is read above instead (the entry must exist).
    let fleetDone = false
    let fleetFile = ''
    if (values.config !== undefined && !preset.rulesets) {
        const file = rulesetsFile(values.config)
        fleetFile = file
        out.push(dryRun ? 'fleet (dry run):' : 'fleet:')
        if (!repo) {
            out.push(row('unavailable', 'rulesets', repoError ?? ''))
            exitCode = 1
        } else if (!existsSync(file)) {
            out.push(row('failed', 'rulesets', `${file} does not exist`))
            exitCode = 1
        } else {
            // A path that is a directory, or a file that cannot be read or
            // written, is a failed row like any other, not a crash that drops
            // the results buffered in `out`.
            try {
                const edit = addToFleet(readFileSync(file, 'utf8'), repo)
                if (edit.status === 'failed') {
                    out.push(
                        row('failed', 'rulesets', `${file}: ${edit.detail}`),
                    )
                    exitCode = 1
                } else {
                    if (edit.status === 'added' && !dryRun)
                        writeFileSync(file, edit.text)
                    fleetDone = true
                    out.push(row(edit.status, 'rulesets', `${repo} in ${file}`))
                }
            } catch (e) {
                out.push(
                    row(
                        'failed',
                        'rulesets',
                        `${file}: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                )
                exitCode = 1
            }
        }
    }

    out.push('next:')
    if (wantFiles) out.push('  mise install', '  bun install')
    if (fleetDone) {
        // Discovery from this repo would not find the infra repo's config,
        // so the commands name it.
        out.push(
            '  review and commit the rulesets config, then run:',
            `    voidflow plan rulesets --config ${fleetFile} --repo ${repo}`,
            `    voidflow apply rulesets --config ${fleetFile} --repo ${repo}`,
        )
    } else if (!(preset.rulesets && values.config)) {
        out.push(
            '  add the repo to your fleet rulesets config: rerun with --config <path to it>, e.g. ../infra/rulesets.ts',
            `  or add this entry by hand: '${repo ?? 'OWNER/REPO'}': {},`,
            '  (see https://github.com/taraxvoid/voidflow/blob/main/CONTRIBUTING.md#fleet-config---config)',
        )
    }
    console.log(out.join('\n'))
    process.exit(exitCode)
}
