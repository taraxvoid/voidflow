// Preloaded by bunfig.toml. Several suites resolve voidflow's own install
// (node_modules/.bin/biome, license-checker-rseidelsohn), so in a worktree
// without `bun install` they fail with unrelated-looking ENOENT/exit-code errors.
// Fail once, up front, with the actual fix.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const depsMessage =
    "test: 'node_modules' is missing, dependencies aren't installed.\n        Run 'bun install' first, then run the tests again."

export function checkDeps(root: string): string | null {
    return existsSync(join(root, 'node_modules')) ? null : depsMessage
}

const message = checkDeps(join(import.meta.dir, '..'))
if (message) {
    console.error(message)
    process.exit(1)
}
