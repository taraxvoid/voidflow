import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { definePreviewConfig, defaultProjects } from '../playwright/index.mjs'

const ENV_KEYS = ['CI', 'PLAYWRIGHT_BASE_URL', 'PLAYWRIGHT_TEST_PORT']
let saved

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
    }
})

describe('definePreviewConfig outside CI', () => {
    test('uses PLAYWRIGHT_TEST_PORT for the server and baseURL', () => {
        process.env.PLAYWRIGHT_TEST_PORT = '5123'
        const config = definePreviewConfig()
        expect(config.use.baseURL).toBe('http://localhost:5123')
        expect(config.webServer.command).toBe('bun run preview --port 5123')
        expect(config.webServer.url).toBe('http://localhost:5123')
        expect(config.webServer.reuseExistingServer).toBe(true)
    })

    test('disables Astro preview backgrounding', () => {
        process.env.PLAYWRIGHT_TEST_PORT = '5123'
        const { webServer } = definePreviewConfig()
        expect(webServer.env.ASTRO_PREVIEW_BACKGROUND).toBe('false')
    })

    test('applies defaults and honours overrides', () => {
        process.env.PLAYWRIGHT_TEST_PORT = '5123'
        const defaults = definePreviewConfig()
        expect(defaults.testDir).toBe('./test/e2e')
        expect(defaults.timeout).toBe(30_000)
        expect(defaults.projects).toBe(defaultProjects)

        const custom = definePreviewConfig({
            runner: 'pnpm',
            timeout: 5_000,
            testDir: './e2e',
            projects: [],
        })
        expect(custom.webServer.command).toBe('pnpm run preview --port 5123')
        expect(custom.timeout).toBe(5_000)
        expect(custom.webServer.timeout).toBe(5_000)
        expect(custom.testDir).toBe('./e2e')
        expect(custom.projects).toEqual([])
    })
})

describe('definePreviewConfig in CI', () => {
    test('requires ciPort', () => {
        process.env.CI = 'true'
        expect(() => definePreviewConfig()).toThrow('ciPort is required')
    })

    test('uses ciPort and does not reuse an existing server', () => {
        process.env.CI = 'true'
        process.env.PLAYWRIGHT_TEST_PORT = '5123'
        const config = definePreviewConfig({ ciPort: 4141 })
        expect(config.use.baseURL).toBe('http://localhost:4141')
        expect(config.webServer.command).toBe('bun run preview --port 4141')
        expect(config.webServer.reuseExistingServer).toBe(false)
    })
})

describe('PLAYWRIGHT_BASE_URL', () => {
    test('drops the webServer and targets the external URL', () => {
        process.env.PLAYWRIGHT_BASE_URL = 'https://preview.example.test'
        process.env.PLAYWRIGHT_TEST_PORT = '5123'
        const config = definePreviewConfig()
        expect(config.use.baseURL).toBe('https://preview.example.test')
        expect(config.webServer).toBeUndefined()
    })

    test('also applies in CI', () => {
        process.env.CI = 'true'
        process.env.PLAYWRIGHT_BASE_URL = 'https://preview.example.test'
        const config = definePreviewConfig({ ciPort: 4141 })
        expect(config.use.baseURL).toBe('https://preview.example.test')
        expect(config.webServer).toBeUndefined()
    })
})

describe('module load', () => {
    test('picks and caches a free port outside CI', async () => {
        const proc = Bun.spawn(
            [
                'bun',
                '-e',
                `await import('${new URL('../playwright/index.mjs', import.meta.url).pathname}'); console.log(process.env.PLAYWRIGHT_TEST_PORT)`,
            ],
            {
                env: { ...process.env, CI: '', PLAYWRIGHT_TEST_PORT: '' },
                stdout: 'pipe',
            },
        )
        const port = Number((await new Response(proc.stdout).text()).trim())
        expect(Number.isInteger(port)).toBe(true)
        expect(port).toBeGreaterThan(0)
        expect(port).toBeLessThan(65536)
    })
})
