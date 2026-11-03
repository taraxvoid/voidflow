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
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
    applyFiles,
    FILE_ITEMS,
    type FileAction,
    fileNames,
    planFiles,
} from './init/files.ts'
import { type Gh, ghAvailable, ghCli, resolveRepo } from './init/gh.ts'
import {
    resolveSha as defaultResolveSha,
    type Kind,
    type RenderCtx,
} from './init/render.ts'
import {
    manualReminders,
    runSettings,
    type SettingResult,
    settingNames,
} from './init/settings.ts'
import { parseOrExit } from './lib/args.ts'
import { packageRoot } from './lib/package-root.ts'
import { capture } from './lib/proc.ts'

/**
 * Presets are data: each names the file items it selects and whether the
 * settings half runs. A new preset is one more entry here.
 */
export const PRESETS: Record<
    string,
    { files: 'all' | string[] | null; settings: boolean }
> = {
    full: { files: 'all', settings: true },
    files: { files: 'all', settings: false },
    settings: { files: null, settings: true },
}

const KINDS: Kind[] = ['tool', 'site']

const OPTIONS = {
    kind: { type: 'string' },
    preset: { type: 'string', default: 'full' },
    'skip-file': { type: 'string', multiple: true, default: [] as string[] },
    'skip-setting': { type: 'string', multiple: true, default: [] as string[] },
    'enable-pvr': { type: 'boolean', default: false },
    'enable-ai-scan': { type: 'boolean', default: false },
    repo: { type: 'string' },
    force: { type: 'boolean', short: 'f', default: false },
    'dry-run': { type: 'boolean', default: false },
} as const

const usage = (prog: string) => `usage: ${prog} --kind tool|site [flags] [dir]

  --kind tool|site        which starter files to write (not needed with --preset settings)
  --preset <name>         ${Object.keys(PRESETS).join('|')} (default full)
  --skip-file <name>      leave this file out (repeatable)
  --skip-setting <name>   leave this setting alone (repeatable)
  --enable-pvr            opt in: private vulnerability reporting and SECURITY.md
  --enable-ai-scan        opt in: AI Scan for pull requests
  --repo owner/name       the GitHub repo (default: the origin remote)
  -f, --force             overwrite files that differ
  --dry-run               plan both halves, write and change nothing

dir defaults to the current directory and must be a git work tree. Settings
need the gh CLI, authenticated as someone with admin on the repo.

Files:    ${FILE_ITEMS.map((i) => i.name).join(', ')}
Settings: ${settingNames().join(', ')}`

type Deps = {
    gh?: Gh
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

    const validFiles = kind ? fileNames(kind) : FILE_ITEMS.map((i) => i.name)
    for (const n of values['skip-file']) {
        if (!validFiles.includes(n))
            fail(
                `unknown --skip-file "${n}", expected one of: ${validFiles.join(', ')}`,
                prog,
            )
    }
    for (const n of values['skip-setting']) {
        if (!settingNames().includes(n)) {
            fail(
                `unknown --skip-setting "${n}", expected one of: ${settingNames().join(', ')}`,
                prog,
            )
        }
    }

    const dir = resolve(positionals[0] ?? '.')
    if (!(await isWorkTree(dir)))
        fail(`${dir} is not a git work tree (run git init first)`, prog)

    const dryRun = values['dry-run']
    const enablePvr = values['enable-pvr']
    const enableAiScan = values['enable-ai-scan']
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
        const ctx: RenderCtx = {
            version,
            sha,
            kind,
            repo,
            cronMinute:
                existingCronMinute(dir) ?? Math.floor(Math.random() * 60),
        }
        const picked = preset.files === 'all' ? null : new Set(preset.files)
        const skip = new Set([
            ...values['skip-file'],
            ...(picked ? fileNames(kind).filter((n) => !picked.has(n)) : []),
        ])
        fileActions = planFiles(
            dir,
            { kind, skip, force: values.force, enablePvr },
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
                skip: new Set(values['skip-setting']),
                enablePvr,
                enableAiScan,
                dryRun,
            })
            for (const r of settingResults)
                out.push(row(r.status, r.name, r.detail))
            if (settingResults.some((r) => r.status === 'failed')) exitCode = 1
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

    if (repo && preset.settings) {
        out.push('manual:')
        for (const l of manualReminders(repo, enableAiScan)) out.push(`  ${l}`)
    }
    if (notes.length > 0) {
        out.push('notes:')
        for (const n of notes) out.push(`  ${n}`)
    }
    out.push('next:')
    if (wantFiles) out.push('  mise install', '  bun install')
    out.push(
        `  add the repo to your infra repo's rulesets config: '${repo ?? 'OWNER/REPO'}': tool(),`,
        '    (see https://github.com/taraxvoid/voidflow/blob/main/CONTRIBUTING.md#fleet-config---config)',
    )
    console.log(out.join('\n'))
    process.exit(exitCode)
}
