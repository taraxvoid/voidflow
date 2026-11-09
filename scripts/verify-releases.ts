#!/usr/bin/env bun
/**
 * Checks that GitHub releases are immutable, using GitHub's own release
 * attestation (`gh release verify`). A release only gets that attestation if
 * the repo's "immutable releases" setting was on when it was published, so a
 * failing check means the setting was off at publish time.
 *
 *   bun scripts/verify-releases.ts <tag>...   verify the given tags (with retries)
 *   bun scripts/verify-releases.ts --audit    verify every release published
 *                                             on or after the baseline
 *
 * The baseline is the tag in .github/immutable-since: the first release
 * published with immutability on. Earlier releases are not covered and are
 * skipped. Needs `gh` and a token (GH_TOKEN) that can read the repo.
 * Exits non-zero if any checked release fails.
 */

export type Release = {
    tagName: string
    publishedAt: string
    isDraft?: boolean
    isImmutable?: boolean
}

/** Tags the audit must hold to the guarantee: published, on or after `since`. */
export function selectAuditTags(releases: Release[], since: string): string[] {
    const baseline = releases.find((r) => r.tagName === since)
    if (!baseline) {
        throw new Error(
            `baseline release ${since} not found; fix .github/immutable-since`,
        )
    }
    const from = Date.parse(baseline.publishedAt)
    return releases
        .filter((r) => !r.isDraft && Date.parse(r.publishedAt) >= from)
        .map((r) => r.tagName)
}

async function gh(args: string[]) {
    const proc = Bun.spawn(['gh', ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { out, err, ok: code === 0 }
}

async function verify(tag: string, attempts: number, delayMs: number) {
    let last = ''
    for (let i = 1; i <= attempts; i++) {
        const r = await gh(['release', 'verify', tag])
        if (r.ok) return { ok: true, detail: '' }
        last = (r.err || r.out).trim()
        // The attestation can lag a few seconds behind publishing a release.
        if (i < attempts) await Bun.sleep(delayMs)
    }
    return { ok: false, detail: last }
}

async function main(argv: string[]) {
    let tags: string[]
    let attempts = 6
    if (argv[0] === '--audit') {
        const since = (await Bun.file('.github/immutable-since').text()).trim()
        const list = await gh([
            'release',
            'list',
            '--limit',
            '1000',
            '--json',
            'tagName,publishedAt,isDraft,isImmutable',
        ])
        if (!list.ok) throw new Error(`gh release list failed: ${list.err}`)
        tags = selectAuditTags(JSON.parse(list.out) as Release[], since)
        attempts = 1
    } else if (argv.length > 0 && !argv[0].startsWith('-')) {
        tags = argv
    } else {
        console.error('usage: verify-releases.ts <tag>... | --audit')
        return 2
    }

    const failed: string[] = []
    for (const tag of tags) {
        const r = await verify(tag, attempts, 10_000)
        if (r.ok) {
            console.log(`ok   ${tag}`)
        } else {
            failed.push(tag)
            console.log(`FAIL ${tag}`)
            console.log(
                `::error::${tag} is not a verified immutable release: ${r.detail}`,
            )
        }
    }
    console.log(`${tags.length - failed.length}/${tags.length} verified`)
    return failed.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
