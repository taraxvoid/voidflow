import type { PlaywrightTestConfig, Project } from '@playwright/test'

export interface PreviewConfigOptions {
    /** Fixed port used when `CI` is set. Required in CI. */
    ciPort?: number
    /** Package manager that runs the `preview` script. Default `bun`. */
    runner?: 'bun' | 'pnpm' | 'npm' | 'yarn' | (string & {})
    /** Test and web server timeout in ms. Default 30000. */
    timeout?: number
    /** Playwright projects. Default: mobile-chrome (Pixel 7) and desktop-chrome. */
    projects?: Project[]
    /** Default `./test/e2e`. */
    testDir?: string
}

export const defaultProjects: Project[]

export function definePreviewConfig(
    options?: PreviewConfigOptions,
): PlaywrightTestConfig
