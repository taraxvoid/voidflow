/**
 * Plan and write the starter files for `voidflow init`.
 * node: APIs only, so the CLI runs under Node as well as Bun.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { packageRoot } from '../lib/package-root.ts'
import { json } from '../lib/template-format.ts'
import {
    type Kind,
    type RenderCtx,
    render,
    sameIgnoringMarkerVersion,
    withMarker,
} from './render.ts'

export type FileItem = {
    name: string
    target: string
    /** Template paths under templates/; `{kind}` expands to the selected kind. A leading `?` marks an optional template; any other missing one throws. */
    templates: string[]
    kinds: Kind[]
    merge?: 'package' | 'gitignore'
    optIn?: 'pvr' | 'agentic'
    /** Existing files that already fill this item's role; the item is left alone when one is present. */
    altTargets?: string[]
}

const BOTH: Kind[] = ['tool', 'site']

export const FILE_ITEMS: FileItem[] = [
    {
        name: 'lefthook',
        target: 'lefthook.yml',
        templates: ['common/lefthook.yml'],
        kinds: BOTH,
    },
    {
        name: 'mise',
        target: 'mise.toml',
        templates: ['common/mise.toml'],
        kinds: BOTH,
    },
    {
        name: 'renovate',
        target: 'renovate.json',
        templates: ['common/renovate.json'],
        kinds: BOTH,
    },
    {
        name: 'bunfig',
        target: 'bunfig.toml',
        templates: ['common/bunfig.toml'],
        kinds: BOTH,
    },
    {
        name: 'biome',
        target: 'biome.json',
        templates: ['common/biome.json'],
        kinds: BOTH,
    },
    {
        name: 'gitignore',
        target: '.gitignore',
        templates: ['common/gitignore', '?{kind}/gitignore'],
        kinds: BOTH,
        merge: 'gitignore',
    },
    {
        name: 'ci',
        target: '.github/workflows/ci.yml',
        templates: ['{kind}/ci.yml'],
        kinds: BOTH,
    },
    {
        name: 'codeowners',
        target: '.github/CODEOWNERS',
        templates: ['common/CODEOWNERS'],
        kinds: BOTH,
    },
    {
        name: 'tsconfig',
        target: 'tsconfig.json',
        templates: ['tool/tsconfig.json'],
        kinds: ['tool'],
    },
    {
        name: 'playwright',
        target: 'playwright.config.js',
        templates: ['site/playwright.config.js'],
        kinds: ['site'],
        altTargets: [
            'playwright.config.ts',
            'playwright.config.mjs',
            'playwright.config.cjs',
        ],
    },
    {
        name: 'unlighthouse',
        target: 'unlighthouse.config.ts',
        templates: ['site/unlighthouse.config.ts'],
        kinds: ['site'],
    },
    {
        name: 'package',
        target: 'package.json',
        templates: ['{kind}/package.json'],
        kinds: BOTH,
        merge: 'package',
    },
    {
        name: 'security',
        target: 'SECURITY.md',
        templates: ['common/SECURITY.md'],
        kinds: BOTH,
        optIn: 'pvr',
    },
    {
        name: 'agentic',
        target: '.github/workflows/agentic.yml',
        templates: ['common/agentic-{stage}.yml'],
        kinds: BOTH,
        optIn: 'agentic',
    },
]

/** Renovate preset that automerges low-risk updates once deps-review is required. */
/**
 * An existing `renovate.json` with the automerge preset added to `extends`,
 * keeping everything else; null when it is not plain JSON with an array
 * `extends` (the caller then reports the usual conflict).
 */
function mergeAutomerge(raw: string): string | null {
    let parsed: { extends?: unknown }
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    if (!Array.isArray(parsed.extends)) return null
    if (parsed.extends.includes(AUTOMERGE_PRESET)) return raw
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    let text = json(
        { ...parsed, extends: [...parsed.extends, AUTOMERGE_PRESET] },
        detectIndent(raw),
    )
    if (!raw.endsWith('\n')) text = text.slice(0, -1)
    return eol === '\r\n' ? text.replaceAll('\n', eol) : text
}

export const AUTOMERGE_PRESET =
    'github>taraxvoid/voidflow:deps-review-automerge'

/** `renovate.json` text with the automerge preset appended to `extends`. */
function withAutomerge(text: string): string {
    const parsed = JSON.parse(text) as { extends?: string[] }
    const extend = parsed.extends ?? []
    if (!extend.includes(AUTOMERGE_PRESET)) extend.push(AUTOMERGE_PRESET)
    return json({ ...parsed, extends: extend })
}

export type FileStatus =
    | 'create'
    | 'overwrite'
    | 'merge'
    | 'unchanged'
    | 'conflict'

export type FileAction = {
    name: string
    target: string
    status: FileStatus
    content: string
    detail?: string
}

type Selection = {
    kind: Kind
    skip: Set<string>
    force: boolean
    enablePvr: boolean
    enableAgentic?: boolean
}

/** Names of the file items that apply to `kind`. */
export function fileNames(kind: Kind): string[] {
    return FILE_ITEMS.filter((i) => i.kinds.includes(kind)).map((i) => i.name)
}

function templateTexts(item: FileItem, ctx: RenderCtx): string[] {
    const root = join(packageRoot(), 'templates')
    return item.templates.flatMap((t) => {
        const optional = t.startsWith('?')
        const p = join(
            root,
            t
                .replace(/^\?/, '')
                .replaceAll('{kind}', ctx.kind)
                .replaceAll('{stage}', ctx.stage ?? 'shadow'),
        )
        if (!existsSync(p)) {
            if (optional) return []
            throw new Error(`missing template: ${p}`)
        }
        return [render(readFileSync(p, 'utf8'), ctx)]
    })
}

/** Significant gitignore lines: trimmed, no blanks, no comments. */
function patterns(text: string): string[] {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
}

function planGitignore(
    path: string,
    texts: string[],
    ctx: RenderCtx,
): Pick<FileAction, 'status' | 'content'> {
    const wanted = [...new Set(texts.flatMap(patterns))]
    if (!existsSync(path)) {
        return {
            status: 'create',
            content: withMarker('.gitignore', `${wanted.join('\n')}\n`, ctx),
        }
    }
    const existing = readFileSync(path, 'utf8')
    const have = new Set(patterns(existing))
    const missing = wanted.filter((l) => !have.has(l))
    if (missing.length === 0) return { status: 'unchanged', content: existing }
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const sep = existing === '' || existing.endsWith('\n') ? '' : eol
    const gap = existing === '' ? '' : eol
    const block = withMarker('.gitignore', `${missing.join('\n')}\n`, ctx)
    return {
        status: 'merge',
        content: `${existing}${sep}${gap}${block.replaceAll('\n', eol)}`,
    }
}

type Pkg = Record<string, unknown> & {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
}

function detectIndent(text: string): string {
    const m = text.match(/^([ \t]+)\S/m)
    return m?.[1] ?? '    '
}

function planPackage(
    dir: string,
    path: string,
    texts: string[],
    sel: Selection,
): Pick<FileAction, 'status' | 'content' | 'detail'> {
    const fragment = JSON.parse(texts[0] ?? '{}') as Pkg
    if (!existsSync(path)) {
        return {
            status: 'create',
            content: json({
                name: basename(resolve(dir)),
                private: true,
                type: 'module',
                ...fragment,
            }),
        }
    }
    const raw = readFileSync(path, 'utf8')
    let pkg: Pkg
    try {
        pkg = JSON.parse(raw) as Pkg
    } catch {
        return {
            status: 'conflict',
            content: raw,
            detail: 'package.json is not valid JSON',
        }
    }
    const isObj = (v: unknown) =>
        typeof v === 'object' && v !== null && !Array.isArray(v)
    if (
        !isObj(pkg) ||
        (pkg.scripts !== undefined && !isObj(pkg.scripts)) ||
        (pkg.devDependencies !== undefined && !isObj(pkg.devDependencies))
    ) {
        return {
            status: 'conflict',
            content: raw,
            detail: 'package.json is not an object with object scripts and devDependencies',
        }
    }
    const scripts = { ...(pkg.scripts ?? {}) }
    const devDeps = { ...(pkg.devDependencies ?? {}) }
    const conflicts: string[] = []
    let changed = false
    for (const [k, v] of Object.entries(fragment.scripts ?? {})) {
        if (!(k in scripts)) {
            scripts[k] = v
            changed = true
        } else if (scripts[k] !== v) {
            conflicts.push(k)
            if (sel.force) scripts[k] = v
        }
    }
    for (const [k, v] of Object.entries(fragment.devDependencies ?? {})) {
        if (!(k in devDeps)) {
            devDeps[k] = v
            changed = true
        }
    }
    const next: Pkg = { ...pkg }
    if (Object.keys(scripts).length > 0) next.scripts = scripts
    if (Object.keys(devDeps).length > 0) next.devDependencies = devDeps
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    let content = json(next, detectIndent(raw))
    if (!raw.endsWith('\n')) content = content.slice(0, -1)
    if (eol === '\r\n') content = content.replaceAll('\n', eol)
    const detail = conflicts.length
        ? `scripts differ: ${conflicts.join(', ')}`
        : undefined
    if (conflicts.length > 0) {
        return { status: sel.force ? 'overwrite' : 'conflict', content, detail }
    }
    return changed
        ? { status: 'merge', content }
        : { status: 'unchanged', content: raw }
}

export function planFiles(
    dir: string,
    sel: Selection,
    ctx: RenderCtx,
): FileAction[] {
    const actions: FileAction[] = []
    for (const item of FILE_ITEMS) {
        if (!item.kinds.includes(sel.kind) || sel.skip.has(item.name)) continue
        if (item.optIn === 'pvr' && !sel.enablePvr) continue
        if (item.optIn === 'agentic' && !sel.enableAgentic) continue
        const path = join(dir, item.target)
        const alt = item.altTargets?.find((t) => existsSync(join(dir, t)))
        if (alt && !existsSync(path)) {
            actions.push({
                name: item.name,
                target: alt,
                status: 'unchanged',
                content: readFileSync(join(dir, alt), 'utf8'),
                detail: `${alt} already exists`,
            })
            continue
        }
        const texts = templateTexts(item, ctx)
        const base = { name: item.name, target: item.target }
        if (item.merge === 'gitignore') {
            actions.push({ ...base, ...planGitignore(path, texts, ctx) })
            continue
        }
        if (item.merge === 'package') {
            actions.push({ ...base, ...planPackage(dir, path, texts, sel) })
            continue
        }
        const content = withMarker(
            item.target,
            item.name === 'renovate' &&
                sel.enableAgentic &&
                ctx.stage === 'gate'
                ? withAutomerge(texts[0] ?? '')
                : (texts[0] ?? ''),
            ctx,
        )
        if (!existsSync(path)) {
            actions.push({ ...base, status: 'create', content })
            continue
        }
        const existing = readFileSync(path, 'utf8')
        // Moving a repo from the shadow to the gate stage merges the two
        // stage-dependent files instead of reporting a conflict.
        if (
            ctx.stage === 'gate' &&
            sel.enableAgentic &&
            (item.name === 'renovate' || item.name === 'agentic') &&
            !sameIgnoringMarkerVersion(existing, content)
        ) {
            const shadowTexts = templateTexts(item, { ...ctx, stage: 'shadow' })
            const shadow = withMarker(item.target, shadowTexts[0] ?? '', ctx)
            if (sameIgnoringMarkerVersion(existing, shadow)) {
                actions.push({ ...base, status: 'merge', content })
                continue
            }
        }
        // A customised renovate.json keeps its settings: only the preset is
        // added to its `extends`.
        if (
            item.name === 'renovate' &&
            ctx.stage === 'gate' &&
            sel.enableAgentic &&
            !sameIgnoringMarkerVersion(existing, content)
        ) {
            const merged = mergeAutomerge(existing)
            if (merged !== null) {
                actions.push({
                    ...base,
                    status: merged === existing ? 'unchanged' : 'merge',
                    content: merged,
                })
                continue
            }
        }
        const status: FileStatus = sameIgnoringMarkerVersion(existing, content)
            ? 'unchanged'
            : sel.force
              ? 'overwrite'
              : 'conflict'
        actions.push({ ...base, status, content })
    }
    return actions
}

/** Write every action that changes a file. Throws, writing nothing, if any action is a conflict. */
export function applyFiles(dir: string, actions: FileAction[]): void {
    const bad = actions.filter((a) => a.status === 'conflict')
    if (bad.length > 0) {
        throw new Error(
            `conflicting files, nothing written: ${bad.map((a) => a.target).join(', ')}`,
        )
    }
    for (const a of actions) {
        if (a.status === 'unchanged') continue
        const path = join(dir, a.target)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, a.content)
    }
}
