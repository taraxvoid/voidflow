// voidflow settings for this repo; `kind` picks the defaults: https://github.com/taraxvoid/voidflow/blob/main/docs/config.md

import type { VoidflowConfig } from './config/index.ts'

export default {
    kind: 'tool',
    rulesets: {
        // Stable releases and canaries both come from main (RELEASING.md).
        tiers: ['main'],
        // This repo's CI jobs are named "Validation" and "Unit tests" (ci.yml),
        // not the tool-ci default "validate / Validate".
        checks: ['Validation', 'Unit tests'],
        // Trusted publishing's only server-side limit on who can publish
        // (RELEASING.md): the npm environment deploys from main only.
        environments: { npm: ['main'] },
    },
} satisfies VoidflowConfig
