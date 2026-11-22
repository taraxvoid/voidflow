// voidflow settings for this repo; `kind` picks the defaults: https://github.com/taraxvoid/voidflow/blob/main/docs/config.md

import type { VoidflowConfig } from './config/index.ts'

export default {
    kind: 'tool',
    // This repo's CI jobs are named "Validation" and "Unit tests" (ci.yml),
    // not the tool-ci default "validate / Validate".
    rulesets: { checks: ['Validation', 'Unit tests'] },
} satisfies VoidflowConfig
