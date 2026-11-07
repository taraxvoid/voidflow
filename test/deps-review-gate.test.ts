import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const read = (p: string) =>
    readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const step = (
    Bun.YAML.parse(read('.github/workflows/deps-review-gate.yml')) as any
).jobs['pass-through'].steps.find(
    (s: any) => s.name === 'Post deps-review check',
)

// Stands in for `gh api`: serves the PR's files and each commit's tree from a
// fixture directory, and records the check run it is asked to post.
const FAKE_GH = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/compare/"*) echo '{"merge_base_commit":{"sha":"mb"}}' ;;
  *"/pulls/"*"/files"*)
    if [ -f "$FIX/files.fail" ]; then echo 'Bad Gateway (HTTP 502)' >&2; exit 1; fi
    cat "$FIX/files.json" ;;
  *"/contents/"*)
    p=\${args##*/contents/}; path=\${p%%\\?ref=*}; ref=\${p##*\\?ref=}
    path=$(printf '%b' "\${path//%/\\\\x}")
    f="$FIX/tree/$ref/$path"
    if [ -f "$FIX/content.fail" ]; then echo 'Bad Gateway (HTTP 502)' >&2; exit 1; fi
    if [ -f "$f" ]; then cat "$f"; else echo 'Not Found (HTTP 404)' >&2; exit 1; fi ;;
  *"/check-runs"*) cat > "$FIX/posted.json" ;;
  *) echo "unexpected gh $args" >&2; exit 9 ;;
esac
`

type Tree = Record<string, unknown>

async function gate(
    files: Array<{ filename: string; previous_filename?: string }>,
    trees: { mb?: Tree; head?: Tree } = {},
    fail: { files?: boolean; content?: boolean } = {},
) {
    const fix = mkdtempSync(join(tmpdir(), 'voidflow-deps-gate-'))
    const bin = join(fix, 'bin')
    mkdirSync(bin)
    if (fail.files) await Bun.write(join(fix, 'files.fail'), '')
    if (fail.content) await Bun.write(join(fix, 'content.fail'), '')
    await Bun.write(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    // Two pages, the way `gh api --paginate` prints them.
    const half = Math.ceil(files.length / 2)
    await Bun.write(
        join(fix, 'files.json'),
        JSON.stringify(files.slice(0, half)) +
            JSON.stringify(files.slice(half)),
    )
    for (const [ref, tree] of Object.entries(trees))
        for (const [path, body] of Object.entries(tree ?? {})) {
            const f = join(fix, 'tree', ref, path)
            mkdirSync(dirname(f), { recursive: true })
            await Bun.write(
                f,
                typeof body === 'string' ? body : JSON.stringify(body),
            )
        }
    const proc = Bun.spawn(['bash', '-c', step.run], {
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            FIX: fix,
            TMPDIR: fix,
            REPO: 'o/r',
            PR: '7',
            BASE: 'base-tip',
            SHA: 'head',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(await new Response(proc.stderr).text())
    return JSON.parse(readFileSync(join(fix, 'posted.json'), 'utf8'))
}

const pkg = (over: Record<string, unknown> = {}) => ({
    name: 'site',
    scripts: { build: 'astro build' },
    dependencies: { astro: '6.0.0' },
    ...over,
})

describe('deps-review gate on PRs the bots did not open', () => {
    test('passes a PR that touches no dependency', async () => {
        const run = await gate([{ filename: 'src/index.ts' }])
        expect(run).toMatchObject({
            name: 'deps-review',
            head_sha: 'head',
            conclusion: 'success',
        })
    })

    test('passes a package.json change outside the dependency fields', async () => {
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': pkg() },
            head: {
                'package.json': pkg({ scripts: { build: 'astro build --x' } }),
            },
        })
        expect(run.conclusion).toBe('success')
    })

    test('fails a lockfile change in any directory, and names it', async () => {
        const run = await gate([
            { filename: 'src/a.ts' },
            { filename: 'packages/web/bun.lock' },
        ])
        expect(run.conclusion).toBe('failure')
        expect(run.output.title).toBe('Needs you')
        expect(run.output.summary).toContain('- `packages/web/bun.lock`')
        expect(run.output.summary).not.toContain('src/a.ts')
        expect(run.output.summary).toContain('PR #7')
    })

    test.each([
        [
            'an added dependency',
            { dependencies: { astro: '6.0.0', evil: '1.0.0' } },
        ],
        ['a bumped dependency', { dependencies: { astro: '6.0.1' } }],
        ['an override', { overrides: { undici: '7.0.0' } }],
        ['a trusted install script', { trustedDependencies: ['esbuild'] }],
    ])('fails %s in package.json', async (_, over) => {
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': pkg() },
            head: { 'package.json': pkg(over) },
        })
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain('- `package.json`')
    })

    test('compares against the merge base, not the base branch tip', async () => {
        // base-tip has moved on (no fixture); only mb counts.
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': pkg() },
            head: { 'package.json': pkg() },
        })
        expect(run.conclusion).toBe('success')
    })

    test('fails a new package.json with dependencies, and a renamed one that gains some', async () => {
        const added = await gate([{ filename: 'tools/package.json' }], {
            head: { 'tools/package.json': pkg() },
        })
        expect(added.conclusion).toBe('failure')
        const moved = await gate(
            [
                {
                    filename: 'web/package.json',
                    previous_filename: 'package.json',
                },
            ],
            {
                mb: { 'package.json': pkg() },
                head: {
                    'web/package.json': pkg({
                        devDependencies: { x: '1.0.0' },
                    }),
                },
            },
        )
        expect(moved.conclusion).toBe('failure')
    })

    test('fails closed when a package.json does not parse', async () => {
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': pkg() },
            head: { 'package.json': '{ not json' },
        })
        expect(run.conclusion).toBe('failure')
    })

    test.each([
        ['deno.lock', 'deno.lock'],
        ['a nested deno.lock', 'tools/deno.lock'],
    ])('fails a change to %s', async (_, filename) => {
        const run = await gate([{ filename }])
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain(`- \`${filename}\``)
    })

    test.each([
        [
            'dependenciesMeta',
            { dependenciesMeta: { esbuild: { built: true } } },
        ],
        [
            'peerDependenciesMeta',
            { peerDependenciesMeta: { astro: { optional: true } } },
        ],
    ])('fails a change that only touches %s', async (_, over) => {
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': pkg() },
            head: { 'package.json': pkg(over) },
        })
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain('- `package.json`')
    })

    test('fails closed, naming the file, when package.json cannot be read', async () => {
        // Both lookups fail with something other than 404: the two results
        // must not compare as equal empty objects.
        const run = await gate(
            [{ filename: 'package.json' }],
            {
                mb: { 'package.json': pkg() },
                head: { 'package.json': pkg() },
            },
            { content: true },
        )
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain('could not be compared')
        expect(run.output.summary).toContain('- `package.json`')
    })

    test.each([
        ['arrays', '[]', '[]'],
        ['strings', '"text"', '"text"'],
        ['an array and a string', '[]', '"text"'],
        ['empty files', '', ''],
    ])('fails closed when both package.json are %s', async (_, a, b) => {
        const run = await gate([{ filename: 'package.json' }], {
            mb: { 'package.json': a },
            head: { 'package.json': b },
        })
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain('could not be compared')
    })

    test('does not post a check when the file list cannot be fetched', async () => {
        // No check is a required check that never reports; "success" would
        // let a lockfile change through.
        await expect(
            gate([{ filename: 'bun.lock' }], {}, { files: true }),
        ).rejects.toThrow()
    })

    test('reads package.json files whose names hold URL or TSV metacharacters', async () => {
        // Neither lookup may silently 404 into "{}" == "{}".
        for (const dir of ['a?b', 'a#b', 'a%b', 'a b', 'a\\b', 'a\tb']) {
            const filename = `${dir}/package.json`
            const run = await gate([{ filename }], {
                mb: {},
                head: { [filename]: pkg() },
            })
            expect(run.conclusion).toBe('failure')
            expect(run.output.summary).toContain(filename)
        }
    })

    test('fails when the file list may be truncated at the API limit', async () => {
        const files = Array.from({ length: 3000 }, (_, i) => ({
            filename: `src/f${i}.ts`,
        }))
        const run = await gate(files)
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary).toContain('at most 3000 files')
        const under = await gate(files.slice(1))
        expect(under.conclusion).toBe('success')
    })

    test('keeps the summary under the check run limit', async () => {
        const files = Array.from({ length: 400 }, (_, i) => ({
            filename: `${'d'.repeat(500)}/${i}/bun.lock`,
        }))
        const run = await gate(files)
        expect(run.conclusion).toBe('failure')
        expect(run.output.summary.length).toBeLessThan(65535)
        expect(run.output.summary).toContain('and 300 more')
    })
})
