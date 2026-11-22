import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '../.github/workflows')
const lock = readFileSync(join(dir, 'actions.lock'), 'utf8')

/** `uses:` refs that gh actions-lock covers: remote actions, not local, docker or reusable workflows. */
function lockedRefs(text: string): string[] {
    const refs: string[] = []
    for (const line of text.split('\n')) {
        const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line)
        if (!m) continue
        const ref = m[1]
        if (/^(\.|\$)\//.test(ref) || ref.startsWith('docker://')) continue
        if (ref.includes('/.github/workflows/')) continue
        refs.push(ref)
    }
    return refs
}

describe('actions.lock', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml'))

    test('every workflow is recorded in the lockfile', () => {
        for (const f of files) {
            if (lockedRefs(readFileSync(join(dir, f), 'utf8')).length === 0)
                continue
            expect(lock).toContain(`'.github/workflows/${f}':`)
        }
    })

    test('every external action ref has a lockfile entry', () => {
        for (const f of files) {
            for (const ref of lockedRefs(readFileSync(join(dir, f), 'utf8'))) {
                const [path, version] = ref.split('@')
                const repo = path.split('/').slice(0, 2).join('/')
                expect(lock, `${f}: ${ref}`).toContain(`'${repo}@${version}'`)
            }
        }
    })
})
