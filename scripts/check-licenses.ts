#!/usr/bin/env bun
/**
 * Shared license policy check for the Astro/bun site stack: fail on GPL kudzu.
 *
 * Runs `license-checker-rseidelsohn` against the current working directory (the caller's
 * repo root) and exits non-zero if any installed package carries a blocked
 * license.
 *
 * Usage: bun check-licenses.ts
 */

import { spawnSync } from 'node:child_process'

export const FAIL_ON = [
    'GPL-1.0',
    'GPL-1.0-only',
    'GPL-1.0-or-later',
    'GPL-2.0',
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-1.0',
    'AGPL-1.0-only',
    'AGPL-1.0-or-later',
    'AGPL-2.0',
    'AGPL-2.0-only',
    'AGPL-2.0-or-later',
    'AGPL-3.0',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
    'SSPL-1.0',
    'OSL-2.1',
    'OSL-3.0',
    'CPAL-1.0',
    'EUPL-1.1',
    'EUPL-1.2',
    'CECILL-2.1',
    // LGPL is deliberately NOT in this list - it only imposes obligations on
    // modifying/statically linking the library, not on depending on it as-is.
].join(';')

const result = spawnSync(
    'bunx',
    ['license-checker-rseidelsohn', '--summary', '--failOn', FAIL_ON],
    { cwd: process.cwd(), stdio: 'inherit' },
)

if (result.error) {
    console.error(
        `\ncheck:licenses failed - could not run license-checker-rseidelsohn: ${result.error.message}`,
    )
    process.exit(1)
}

if (result.status !== 0) {
    console.error(
        '\ncheck:licenses failed - at least one disallowed license was found.',
    )
    process.exit(1)
}

console.log(
    '\ncheck:licenses passed - no blocked licenses found in any workspace.',
)
