import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../.github/workflows/release-please.yml', import.meta.url), 'utf8')
const wf: any = Bun.YAML.parse(text)
const job = wf.jobs.publish
const steps: any[] = job.steps
const index = (name: string) => {
    const i = steps.findIndex((s) => s.name === name)
    expect(i, name).toBeGreaterThanOrEqual(0)
    return i
}
const PUBLISHES = ['Publish @taraxvoid/voidflow to NPM (scoped canonical package)', 'Publish voidflow (unscoped mirror)']

// `gh attestation verify <tarball from npm>` only passes if the bytes on npm
// are the bytes that were attested, so the job must attest the packed file and
// publish that same file, never re-pack in `npm publish`.
describe('release-please.yml publish: npm tarballs are attested', () => {
    test('can write attestations, and nothing broader', () => {
        expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' })
    })

    test('attests the packed tarballs with a pinned actions/attest', () => {
        const attest = steps[index('Attest npm tarballs')]
        expect(attest.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/)
        // The version comment is what Renovate reads; YAML parsing drops it.
        expect(text).toContain(`uses: ${attest.uses} # v`)
        expect(attest.with['subject-path']).toBe('${{ runner.temp }}/npm-pack/*.tgz')
        expect(steps[index('Pack npm tarballs')].env.PACK_DIR).toBe('${{ runner.temp }}/npm-pack')
    })

    test('skips attesting on a dry run or when nothing was packed', () => {
        const cond = steps[index('Attest npm tarballs')].if
        expect(cond).toContain('!inputs.dry-run')
        expect(cond).toContain("steps.pack.outputs.scoped != ''")
        expect(cond).toContain("steps.pack.outputs.mirror != ''")
    })

    test('packs, then attests, before anything is published', () => {
        const attest = index('Attest npm tarballs')
        expect(index('Pack npm tarballs')).toBeLessThan(attest)
        expect(attest).toBeLessThan(index('Publish @taraxvoid/voidflow to JSR'))
        for (const name of PUBLISHES) expect(attest).toBeLessThan(index(name))
    })

    test('each npm publish uploads its packed tarball', () => {
        const [scoped, mirror] = PUBLISHES.map((n) => steps[index(n)])
        expect(scoped.env.TARBALL).toBe('${{ steps.pack.outputs.scoped }}')
        expect(mirror.env.TARBALL).toBe('${{ steps.pack.outputs.mirror }}')
        for (const s of [scoped, mirror]) {
            expect(s.if).toBe(`${s.env.TARBALL.replace(/^\$\{\{ | \}\}$/g, '')} != ''`)
            // Staged: a human approves each version with 2FA before it goes live.
            expect(s.run).toContain('npm stage publish "$TARBALL" ')
            expect(s.run).not.toMatch(/(^|\s)npm publish /m)
            expect(s.run).not.toContain('npm pkg set')
        }
    })

    test('the mirror is packed from a restored tree, so JSR gets the real README', () => {
        const run: string = steps[index('Pack npm tarballs')].run
        expect(run.indexOf('git checkout -- package.json README.md')).toBeGreaterThan(
            run.indexOf('cp scripts/mirror-readme.md README.md'),
        )
    })
})
