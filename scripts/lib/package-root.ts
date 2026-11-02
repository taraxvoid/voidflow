/**
 * Locate the voidflow package directory from wherever this file runs (source
 * tree, or the bundled dist/), so templates resolve under Bun and Node alike.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = '@taraxvoid/voidflow'

/** Absolute path of the nearest ancestor directory whose package.json is voidflow's. */
export function packageRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (;;) {
        const pkg = join(dir, 'package.json')
        if (existsSync(pkg)) {
            try {
                if (JSON.parse(readFileSync(pkg, 'utf8')).name === NAME) return dir
            } catch {
                // unreadable package.json: keep walking
            }
        }
        const parent = dirname(dir)
        if (parent === dir) throw new Error(`could not find the ${NAME} package root`)
        dir = parent
    }
}
