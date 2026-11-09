/**
 * Plan gating: GitHub refuses rulesets (and so code owner review) on a
 * private repo whose plan lacks them, with a fixed upgrade message.
 */

/** True when `message` is GitHub's "upgrade or make it public" refusal text. */
export function isUpgradeMessage(message: string): boolean {
    return /Upgrade to GitHub Pro|make this repository public/.test(message)
}

/**
 * True when a `gh api` error is GitHub refusing rulesets because the repo is
 * private on a plan without them (free personal accounts). That is a property
 * of the plan, not drift, so the script skips the repo instead of failing.
 * Other errors, including other 403s, still abort the run.
 */
export function isPlanGated(message: string): boolean {
    return /\(HTTP 403\)/.test(message) && isUpgradeMessage(message)
}
