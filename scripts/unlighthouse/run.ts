#!/usr/bin/env bun
/*
 * Shared Unlighthouse CI runner for the Astro/bun site stack.
 *
 * Serves a built static directory on a free local port, then runs
 * `unlighthouse-ci` against it with the caller's config file and exits with
 * its status (non-zero when a category budget fails). Reuses the Chromium that
 * Playwright already installed, so no second Chrome download.
 *
 * Usage:
 *   bun run.ts [--dir dist] [--config unlighthouse.config.ts] [--version 0.19.0]
 *
 * Paths are relative to the current working directory (the caller's repo root).
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
    options: {
        dir: { type: 'string', default: 'dist' },
        config: { type: 'string', default: 'unlighthouse.config.ts' },
        version: { type: 'string', default: '0.19.0' },
    },
})

const dir = resolve(values.dir as string)
const config = resolve(values.config as string)

if (!existsSync(dir)) {
    console.error(`dist directory not found: ${dir} (run the build first)`)
    process.exit(2)
}
if (!existsSync(config)) {
    console.error(`unlighthouse config not found: ${config}`)
    process.exit(2)
}

function findPlaywrightChromium(): string | null {
    const base =
        process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
            : process.platform === 'win32'
              ? join(homedir(), 'AppData', 'Local', 'ms-playwright')
              : join(homedir(), '.cache', 'ms-playwright')
    if (!existsSync(base)) return null

    const relPaths = [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
    ]
    for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        for (const rel of relPaths) {
            const candidate = join(base, entry.name, rel)
            if (existsSync(candidate)) return candidate
        }
    }
    return null
}

// Resolve a request path to a file the way static hosts do: exact file,
// then <path>/index.html, then <path>.html.
function resolveFile(pathname: string): string | null {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    const candidates = [rel, join(rel, 'index.html'), `${rel}.html`]
    for (const c of candidates) {
        const full = resolve(dir, c)
        if (!full.startsWith(`${dir}/`) && full !== dir) continue
        if (existsSync(full) && statSync(full).isFile()) return full
    }
    return null
}

const server = Bun.serve({
    port: 0,
    fetch(req) {
        const file = resolveFile(new URL(req.url).pathname)
        if (file) return new Response(Bun.file(file))
        const notFound = resolveFile('/404.html')
        return notFound
            ? new Response(Bun.file(notFound), { status: 404 })
            : new Response('Not found', { status: 404 })
    },
})

const site = `http://localhost:${server.port}`
const chrome = findPlaywrightChromium()
const env: Record<string, string | undefined> = { ...process.env }
if (chrome) {
    env.CHROME_PATH = chrome
    env.PUPPETEER_EXECUTABLE_PATH = chrome
    console.log(`Using Chromium: ${chrome}`)
} else {
    console.log('No Playwright Chromium found; relying on system Chrome lookup.')
}
console.log(`Serving ${dir} at ${site}`)

const child = spawn(
    'bunx',
    [
        '--package',
        `unlighthouse@${values.version}`,
        'unlighthouse-ci',
        '--site',
        site,
        '--config-file',
        config,
    ],
    { env, stdio: 'inherit' },
)

child.on('error', (err) => {
    console.error('failed to start unlighthouse-ci:', err.message)
    server.stop(true)
    process.exit(1)
})
child.on('close', (code) => {
    server.stop(true)
    process.exit(code ?? 1)
})
