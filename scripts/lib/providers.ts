/**
 * Token providers for `voidflow tokens <provider>`: the user-facing id maps
 * to the fleet tool whose config file and checker it uses. Adding a provider
 * is one entry here, one lazy import in scripts/tokens.ts, and its
 * <provider>-tokens.ts config file convention.
 */
import type { Tool } from './discover.ts'

export const PROVIDERS = {
    cf: 'cf-tokens',
} as const satisfies Record<string, Tool>

export type Provider = keyof typeof PROVIDERS

/** The provider id a token tool runs as, or undefined for other tools. */
export const providerOf = (tool: Tool): Provider | undefined =>
    (Object.keys(PROVIDERS) as Provider[]).find((p) => PROVIDERS[p] === tool)

/** Every token-provider tool, in registry order. */
export const TOKEN_TOOLS: Tool[] = Object.values(PROVIDERS)
