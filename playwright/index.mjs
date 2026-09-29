/*
 * Shared Playwright config for Astro sites that e2e against `astro preview`.
 *
 *   import { definePreviewConfig } from '@taraxvoid/voidflow/playwright'
 *   export default definePreviewConfig({ ciPort: 4141 })
 */
import { createServer } from 'node:net'
import { devices } from '@playwright/test'

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = createServer()
        srv.unref()
        srv.on('error', reject)
        srv.listen(0, () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
    })
}

// Worktrees run tests concurrently, so a fixed port would collide (or reuse
// another worktree's server). Outside CI, ask the OS for a free port. The
// result is cached in PLAYWRIGHT_TEST_PORT because the config is reloaded in
// the runner and in every worker; each reload must agree on one port.
if (!process.env.CI && !process.env.PLAYWRIGHT_TEST_PORT) {
    process.env.PLAYWRIGHT_TEST_PORT = String(await getFreePort())
}

export const defaultProjects = [
    { name: 'mobile-chrome', use: devices['Pixel 7'] },
    { name: 'desktop-chrome', use: devices['Desktop Chrome'] },
]

export function definePreviewConfig({
    ciPort,
    runner = 'bun',
    timeout = 30_000,
    projects = defaultProjects,
    testDir = './test/e2e',
} = {}) {
    if (process.env.CI && ciPort === undefined) {
        throw new Error('definePreviewConfig: ciPort is required in CI')
    }
    const port = process.env.CI ? ciPort : process.env.PLAYWRIGHT_TEST_PORT
    const external = process.env.PLAYWRIGHT_BASE_URL
    const baseURL = external ?? `http://localhost:${port}`

    return {
        testDir,
        timeout,
        fullyParallel: true,
        use: { baseURL, serviceWorkers: 'block' },
        // Set PLAYWRIGHT_BASE_URL to test a deployed site or preview instead.
        webServer: external
            ? undefined
            : {
                  command: `${runner} run preview --port ${port}`,
                  url: baseURL,
                  reuseExistingServer: !process.env.CI,
                  timeout,
                  // Astro backgrounds `astro preview` in agentic environments
                  // (CLAUDECODE, AI_AGENT), which makes Playwright think the
                  // server exited early. Any non-empty value skips detection.
                  env: { ASTRO_PREVIEW_BACKGROUND: 'false' },
              },
        projects,
    }
}
