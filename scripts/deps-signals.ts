#!/usr/bin/env bun
/**
 * Deterministic risk signals for a dependency-update PR, used by the
 * deps-review agentic workflow's gate job. The agent's verdict can only make
 * the gate stricter: the `deps-review` check is green only when the agent
 * says low risk *and* this finds nothing.
 *
 * Nothing here reads free text (PR bodies, release notes, descriptions), so a
 * compromised package can't argue its way past it. Anything it can't verify
 * is a flag.
 *
 * Usage: deps-signals --base <sha> --head <sha>   (run inside the checkout)
 * Prints JSON { clean, flags: [{ subject, reason }] }. Exit 0 when it ran,
 * 2 on a usage or git error.
 */

import { spawnSync } from 'node:child_process'

export type Flag = { subject: string; reason: string }

const DEP_SECTIONS = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
]
const LOCKFILES = new Set([
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
])
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']
const SHA = /^[0-9a-f]{40}$/

type Version = { major: number; minor: number; patch: number }

/** A plain `1.2.3`, `^1.2.3` or `~1.2.3` spec; anything else is unverifiable. */
export function parseSpec(spec: string): Version | null {
    const m = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim())
    return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

const exact = (spec: string) => spec.trim().replace(/^[\^~]/, '')

/** Files a dependency PR may touch; anything else needs a human. */
export function classifyFiles(files: string[]): Flag[] {
    return files
        .filter(
            (f) =>
                f !== 'package.json' &&
                !LOCKFILES.has(f) &&
                !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f),
        )
        .map((f) => ({
            subject: f,
            reason: 'file outside package.json, lockfiles and workflows changed',
        }))
}

export type DepChange = { name: string; from: string; to: string }

type Manifest = Record<string, unknown>
type RegistryVersion = {
    _npmUser?: { name?: string }
    maintainers?: { name?: string }[]
    scripts?: Record<string, string>
    dist?: { attestations?: unknown }
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
}
type RegistryDocument = { versions?: Record<string, RegistryVersion> }

/** Direct dependency changes between two package.json documents. */
export function diffManifest(
    base: Manifest,
    head: Manifest,
): { changes: DepChange[]; flags: Flag[] } {
    const flags: Flag[] = []
    const changes: DepChange[] = []
    const keys = new Set([...Object.keys(base), ...Object.keys(head)])
    for (const key of keys) {
        if (DEP_SECTIONS.includes(key)) continue
        if (JSON.stringify(base[key]) !== JSON.stringify(head[key])) {
            flags.push({
                subject: `package.json#${key}`,
                reason: 'non-dependency field changed',
            })
        }
    }
    for (const section of DEP_SECTIONS) {
        const a = (base[section] ?? {}) as Record<string, string>
        const b = (head[section] ?? {}) as Record<string, string>
        for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[name] === b[name]) continue
            if (!(name in a))
                flags.push({ subject: name, reason: `added to ${section}` })
            else if (!(name in b))
                flags.push({ subject: name, reason: `removed from ${section}` })
            else changes.push({ name, from: a[name], to: b[name] })
        }
    }
    return { changes, flags }
}

/** Update type rules: only patch and minor on 1.0+ can be low risk. */
export function classifyChange(c: DepChange): Flag[] {
    const from = parseSpec(c.from)
    const to = parseSpec(c.to)
    if (!from || !to)
        return [
            {
                subject: c.name,
                reason: `unverifiable version spec ${c.from} -> ${c.to}`,
            },
        ]
    if (to.major !== from.major)
        return [{ subject: c.name, reason: 'major update' }]
    if (from.major === 0)
        return [{ subject: c.name, reason: '0.x update (minor can break)' }]
    const down =
        to.minor < from.minor ||
        (to.minor === from.minor && to.patch < from.patch)
    return down ? [{ subject: c.name, reason: 'downgrade' }] : []
}

/** Supply-chain signals from the registry document for one package. */
export function registrySignals(c: DepChange, doc: RegistryDocument): Flag[] {
    const flag = (reason: string) => ({ subject: c.name, reason })
    const old = doc?.versions?.[exact(c.from)]
    const cur = doc?.versions?.[exact(c.to)]
    if (!old || !cur) return [flag('version missing from the registry')]
    const flags: Flag[] = []
    const known = new Set<string>(
        [
            old._npmUser?.name,
            ...(old.maintainers ?? []).map((m) => m.name),
        ].filter((name): name is string => typeof name === 'string'),
    )
    if (!cur._npmUser?.name || !known.has(cur._npmUser.name)) {
        flags.push(
            flag(
                `published by ${cur._npmUser?.name ?? 'unknown'}, not a publisher or maintainer of ${exact(c.from)}`,
            ),
        )
    }
    for (const s of INSTALL_SCRIPTS) {
        if (cur.scripts?.[s] && cur.scripts[s] !== old.scripts?.[s])
            flags.push(flag(`${s} script added or changed`))
    }
    if (old.dist?.attestations && !cur.dist?.attestations)
        flags.push(flag('provenance attestation dropped'))
    const before = new Set(
        Object.keys({ ...old.dependencies, ...old.optionalDependencies }),
    )
    const added = Object.keys({
        ...cur.dependencies,
        ...cur.optionalDependencies,
    }).filter((d) => !before.has(d))
    if (added.length) flags.push(flag(`new dependencies: ${added.join(', ')}`))
    return flags
}

export type ActionPin = { action: string; sha: string; tag: string | null }

/** `uses:` references in a workflow file. Local (`./`) actions are skipped. */
export function parseUses(yaml: string): { pins: ActionPin[]; flags: Flag[] } {
    const pins: ActionPin[] = []
    const flags: Flag[] = []
    for (const m of yaml.matchAll(
        // `(?:-[ \t]*)?`, not `-?[ \t]*`: two adjacent `[ \t]*` runs backtrack
        // quadratically on a long run of blanks (ReDoS).
        /^[ \t]*(?:-[ \t]*)?uses:[ \t]*([^\s#]+)[ \t]*(?:#[ \t]*(\S+))?/gm,
    )) {
        const [ref, tag] = [m[1].replace(/^['"]|['"]$/g, ''), m[2] ?? null]
        if (ref.startsWith('./')) continue
        const at = ref.lastIndexOf('@')
        const action = ref.slice(0, at)
        const sha = ref.slice(at + 1)
        if (at < 0 || ref.startsWith('docker://') || !SHA.test(sha)) {
            flags.push({
                subject: ref,
                reason: 'action not pinned to a commit SHA',
            })
        } else pins.push({ action, sha, tag })
    }
    return { pins, flags }
}

// npm package names (legacy ones may have capitals); scoped names have one `/`.
const NPM_NAME = /^(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/

/** Registry document URL for a package, or null for a name npm would reject. */
export function registryUrl(name: string): string | null {
    if (!NPM_NAME.test(name)) return null
    return `https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, '@')}`
}

// GitHub owner/repo, optionally followed by a path to an action inside it.
const ACTION = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(?:\/[\w./-]+)?$/
const TAG = /^[A-Za-z0-9][\w.+/-]*$/

/** The GitHub repo to ask about a pin, or null when the action or tag looks off. */
export function pinRemote(p: ActionPin): string | null {
    if (!p.tag || !ACTION.test(p.action) || !TAG.test(p.tag)) return null
    const repo = p.action.split('/').slice(0, 2)
    if (repo.some((seg) => /^\.+$/.test(seg))) return null
    return `https://github.com/${repo.join('/')}`
}

const tagMajor = (tag: string | null) => tag?.match(/^v?(\d+)/)?.[1] ?? null

/** New or changed action pins: each needs a tag comment and the same major as before. */
export function diffPins(
    base: ActionPin[],
    head: ActionPin[],
): { verify: ActionPin[]; flags: Flag[] } {
    const before = new Map(base.map((p) => [p.action, p]))
    const verify: ActionPin[] = []
    const flags: Flag[] = []
    for (const p of head) {
        const old = before.get(p.action)
        if (old && old.sha === p.sha) continue
        if (!p.tag)
            flags.push({
                subject: p.action,
                reason: 'pin has no version comment to verify',
            })
        else if (!old) flags.push({ subject: p.action, reason: 'new action' })
        else if (tagMajor(old.tag) !== tagMajor(p.tag))
            flags.push({ subject: p.action, reason: 'major update' })
        else verify.push(p)
    }
    return { verify, flags }
}

/** Does `git ls-remote` output resolve `tag` to `sha` (peeled tags preferred)? */
export function tagMatches(
    lsRemote: string,
    tag: string,
    sha: string,
): boolean {
    const refs = new Map(
        lsRemote
            .trim()
            .split('\n')
            .map((l) => l.split('\t').reverse() as [string, string]),
    )
    return (
        (refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)) ===
        sha
    )
}

// --- CLI -------------------------------------------------------------------

function git(args: string[]): string | null {
    const r = spawnSync('git', args, { encoding: 'utf8' })
    return r.status === 0 ? r.stdout : null
}

async function main(argv: string[]): Promise<number> {
    const arg = (name: string) => argv[argv.indexOf(name) + 1]
    const base = arg('--base')
    const head = arg('--head')
    if (
        !argv.includes('--base') ||
        !argv.includes('--head') ||
        !SHA.test(base) ||
        !SHA.test(head)
    ) {
        console.error('usage: deps-signals --base <sha> --head <sha>')
        return 2
    }
    const changed = git(['diff', '--name-only', base, head])
    if (changed === null) {
        console.error('git diff failed: are both commits fetched?')
        return 2
    }
    const files = changed.split('\n').filter(Boolean)
    const flags: Flag[] = [...classifyFiles(files)]
    if (files.length === 0) flags.push({ subject: 'PR', reason: 'no changes' })

    if (files.includes('package.json')) {
        const read = (ref: string) =>
            JSON.parse(git(['show', `${ref}:package.json`]) ?? '{}') as Manifest
        const { changes, flags: manifestFlags } = diffManifest(
            read(base),
            read(head),
        )
        flags.push(...manifestFlags)
        for (const c of changes) {
            const typeFlags = classifyChange(c)
            flags.push(...typeFlags)
            if (typeFlags.length) continue
            const url = registryUrl(c.name)
            if (url === null) {
                flags.push({ subject: c.name, reason: 'invalid package name' })
                continue
            }
            const res = await fetch(url)
            flags.push(
                ...(res.ok
                    ? registrySignals(c, (await res.json()) as RegistryDocument)
                    : [{ subject: c.name, reason: `registry ${res.status}` }]),
            )
        }
    } else if (files.some((f) => LOCKFILES.has(f))) {
        flags.push({
            subject: 'lockfile',
            reason: 'lockfile-only change: transitive updates are not verified',
        })
    }

    for (const f of files.filter((f) => f.startsWith('.github/workflows/'))) {
        const parse = (ref: string) =>
            parseUses(git(['show', `${ref}:${f}`]) ?? '')
        const was = parse(base)
        const now = parse(head)
        flags.push(
            ...now.flags.filter(
                (x) => !was.flags.some((y) => y.subject === x.subject),
            ),
        )
        const { verify, flags: pinFlags } = diffPins(was.pins, now.pins)
        flags.push(...pinFlags)
        for (const p of verify) {
            const remote = pinRemote(p)
            if (remote === null) {
                flags.push({
                    subject: p.action,
                    reason: 'unverifiable action or tag name',
                })
                continue
            }
            // `--` so no later argument can be read as an option (--upload-pack).
            const out = git([
                'ls-remote',
                '--',
                remote,
                `refs/tags/${p.tag}`,
                `refs/tags/${p.tag}^{}`,
            ])
            if (out === null || !tagMatches(out, p.tag as string, p.sha)) {
                flags.push({
                    subject: p.action,
                    reason: `${p.sha.slice(0, 7)} is not what ${p.tag} points to`,
                })
            }
        }
    }

    console.log(JSON.stringify({ clean: flags.length === 0, flags }, null, 2))
    return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
