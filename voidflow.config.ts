// voidflow settings for this repo; `kind` picks the defaults: https://github.com/taraxvoid/voidflow/blob/main/docs/config.md

import type { VoidflowConfig } from './config/index.ts'

export default {
    kind: 'tool',
    // This repo's CI jobs are named "Validation" and "Unit tests" (ci.yml),
    // not the tool-ci default "validate / Validate".
    // codeowners and linearHistory are off to match the live `main (prod)`
    // ruleset; flip them (and `voidflow apply rulesets`) to tighten it.
    rulesets: {
        checks: ['Validation', 'Unit tests'],
        codeowners: false,
        linearHistory: false,
    },
} satisfies VoidflowConfig
