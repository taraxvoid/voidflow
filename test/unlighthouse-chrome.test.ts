import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noSandboxWrapper } from '../scripts/unlighthouse/chrome.ts'

// A stand-in "chrome" that prints the arguments it receives.
function fakeChrome(name = 'chrome') {
    const dir = mkdtempSync(join(tmpdir(), 'voidflow-fake-'))
    const bin = join(dir, name)
    writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n')
    chmodSync(bin, 0o755)
    return bin
}

async function run(bin: string, ...args: string[]) {
    const proc = Bun.spawn([bin, ...args], { stdout: 'pipe' })
    return (await new Response(proc.stdout).text()).trim().split('\n')
}

describe('noSandboxWrapper', () => {
    test('is executable and runs chrome with --no-sandbox first', async () => {
        const wrapper = noSandboxWrapper(fakeChrome())
        expect(statSync(wrapper).mode & 0o111).not.toBe(0)
        expect(await run(wrapper, '--headless', 'about:blank')).toEqual([
            'arg:--no-sandbox',
            'arg:--headless',
            'arg:about:blank',
        ])
    })

    test('handles chrome paths with spaces and quotes', async () => {
        const wrapper = noSandboxWrapper(fakeChrome("Google Chrome 'x'"))
        expect(await run(wrapper, '--flag')).toEqual(['arg:--no-sandbox', 'arg:--flag'])
    })
})
