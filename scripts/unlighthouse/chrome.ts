import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * GitHub's ubuntu-24.04 runners disable unprivileged user namespaces via
 * AppArmor, so Chrome aborts at launch ("No usable sandbox!"). Returns a shell
 * wrapper that runs `chrome` with --no-sandbox, for use as CHROME_PATH /
 * PUPPETEER_EXECUTABLE_PATH. Only used in CI, where the browser loads our own
 * static build and nothing untrusted.
 */
export function noSandboxWrapper(chrome: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-chrome-'))
    const wrapper = join(dir, 'chrome-no-sandbox')
    // Single-quote the path for sh; escape any embedded single quotes.
    const quoted = `'${chrome.replaceAll("'", `'\\''`)}'`
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quoted} --no-sandbox "$@"\n`)
    chmodSync(wrapper, 0o755)
    return wrapper
}
