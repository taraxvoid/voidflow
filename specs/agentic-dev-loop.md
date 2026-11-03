# Agentic dev loop: spec

Status: proposal. Nothing here is implemented, and nothing here is covered by
[`STABILITY.md`](../STABILITY.md) until it ships.

Goal: extend the `deps-review` pattern from "judge dependency PRs" to the rest
of a personal fleet's dev loop, and measure whether it works. The scarce
resource is the owner's attention, so the loop should spend it on decisions
and keep the rest out of the way.

Four pieces, built in this order:

1. A decision ledger and a `detect` report (the Detect loop).
2. `pr-triage`: per-PR signals, brief and labels, plus a fleet review queue.
3. `security-review`: a repo-wide review that PR review, CodeQL and dependency
   patching do not do. Its engine lives in a private repo (`voidblight`).
4. `init` support: `AGENTS.md` and the agentic workflows.

## Design rules

Taken from `deps-review`; every piece below follows them.

1. Deterministic code computes the signals. The model writes a brief and
   proposes a verdict. It can only make the outcome stricter.
2. A deterministic job posts the check or applies the label, on the exact head
   SHA it evaluated.
3. The model never gets approve, merge or push powers. Safe-outputs are scoped
   to one PR or one issue, never `*`.
4. Everything the model reads that an attacker can write (PR text, release
   notes, file contents, filenames) is evidence to quote, not instructions.
5. Every decision is written to the ledger (below).
6. Prompts are behavior and are versioned like code (`STABILITY.md`, "Agentic
   workflow prompts").

## Auth: GitHub Apps

`GITHUB_TOKEN` is scoped to one repo, so anything that crosses repos (the fleet
queue, the central security review) needs another credential. Use GitHub Apps,
not personal access tokens: short-lived installation tokens, per-repo
installation, scoped permissions, no human account behind them.

Split by privilege so one compromised credential does not escalate:

| App | Permissions | Used by |
|---|---|---|
| `fleet-reader` | `contents: read`, `pull-requests: read`, `checks: read`, `metadata: read` on fleet repos | queue collector, security review checkout, outcome collector |
| `fleet-writer` | `issues: write` on the infra repo only | queue and findings issues |
| `fleet-actor` (later, optional) | `pull-requests: write`, `checks: write` on fleet repos | label changes and auto-merge enablement, only after the Detect loop justifies it |

Rules:

- Mint tokens with `actions/create-github-app-token` in deterministic jobs,
  scoped with `owner`, `repositories` and `permission-*` inputs to the minimum
  for that job. Pin it by SHA.
- App private keys live as secrets in the infra repo only.
- No credential is ever passed to a job or step the model runs in. Checkouts
  happen in an earlier deterministic job and are handed over as files.
- Keep `fleet-actor` out of v1. Labels from the model's gate job can use the
  per-repo `GITHUB_TOKEN`.
- If GitHub ships a first-party way to do cross-repo agent auth, prefer it and
  retire the apps.

This is a design position, not something verified against gh-aw's cross-repo
support. Check the gh-aw reference before relying on any gh-aw-native option.

## 1. Decision ledger and Detect loop

The point: show that agent verdicts were right, with numbers, and set the bar
for letting a workflow do more (AES: "escaped defects stay flat as agent use
grows").

### Ledger record

One record per decision, written into the check-run output JSON (the
`deps-review` gate already posts one):

```json
{
  "schema": 1,
  "workflow": "deps-review",
  "repo": "owner/name",
  "pr": 123,
  "head_sha": "...",
  "verdict": "low-risk",
  "gate": "success",
  "signals": { "clean": true, "flags": [] },
  "prompt_version": "1.0.0-next.3",
  "engine": "copilot",
  "at": "2026-11-03T12:00:00Z"
}
```

`prompt_version` is the voidflow release that shipped the prompt, so a change
in agreement rate can be tied to a prompt edit.

### Outcome collector

A scheduled, deterministic job (in the infra repo, using `fleet-reader`).
For each ledger record whose PR is closed, record exactly one outcome:

| Outcome | Meaning |
|---|---|
| `merged-unchanged` | merged with the verdict standing |
| `overridden-up` | verdict was low-risk but a human closed it, or a human pushed changes before merging |
| `overridden-down` | verdict was needs-you but a human merged it with no changes |
| `reverted` | a revert of the merge landed within 14 days |
| `broke-main` | default-branch CI went red within 24 hours of the merge and the PR is the first suspect commit |

`reverted` and `broke-main` on a low-risk verdict are **false low-risk**.

### Report: `voidflow detect`

New CLI command, same `--config` fleet map as the other fleet tools.

- **False low-risk count.** The number that matters. Target zero.
- **Needs-you precision.** Share of needs-you PRs that were not
  `overridden-down`. A low value means the agent is wasting attention.
- **Time to decision.** Median and p90 from PR open to merge or close, split by
  verdict.
- Grouped by `prompt_version` and workflow.

### Promotion rule

A workflow moves from shadow to gate (the existing `deps-review` stage 1 to 2)
only when, for the workflow and its current `prompt_version` line:

- at least 30 decisions with outcomes, and
- zero false low-risk, and
- needs-you precision reported (no threshold at first; the report sets one
  after real data exists).

Add the rule to `STABILITY.md` when this ships. Start with `deps-review`: it
already produces decisions, so the ledger can be backfilled from its check
runs.

## 2. `pr-triage` and the fleet queue

### Per-repo workflow (catalog, gh-aw)

Triggers: `pull_request` (opened, synchronize, reopened, ready_for_review) and
a daily schedule to catch aging PRs.

Signals, from a new `pr-signals` bin (generalizes `deps-signals`; reads no
free text):

- diff size (files, additions, deletions) and an effort bucket: `quick`,
  `medium`, `deep`
- sensitive paths touched: `.github/workflows`, lockfiles, `migrations/`,
  `.sops.yaml`, `rulesets/`, release config
- tests changed alongside code
- CI state of the head, review state, draft, age, mergeable
- author class: human, Renovate, Dependabot, agent
- the PR's `deps-review` verdict if present

Model: reads the diff and writes one comment: what to look at, what it could
not verify, with file and line citations. Proposes a state.

Gate job (deterministic): applies exactly one of `queue:merge-ready`,
`queue:needs-you`, `queue:blocked`, and posts a `pr-triage` check on the
evaluated head. The state is the stricter of the model's proposal and the
signals. `queue:merge-ready` requires: CI green, no sensitive paths, no
signal flags.

Merging:

- Bot PRs already merge through `deps-review` and Renovate automerge. No
  change.
- Everyone else's PRs get labels only. Enabling auto-merge from a
  deterministic job is a later, separate change that must clear the promotion
  rule first, and is a major bump under `STABILITY.md` (new write power).

Safe-outputs: `add-comment` (1, this PR), `add-labels` and `remove-labels`
(only the three `queue:*` labels, this PR). Prompt reads `AGENTS.md` from the
**base** ref, never the PR head.

### Fleet queue: `voidflow queue`

New CLI command, deterministic, no model. Reads the fleet map (`--config`, the
same `REPOS` shape as `rulesets.ts`), collects open PRs and their `pr-triage`
labels, signals and briefs using `fleet-reader`, and rewrites one floating
issue in the org's infra repo using `fleet-writer`.

- Sections: `needs-you` ordered by effort bucket then age, then
  `merge-ready` (for a glance), then `blocked`.
- `--window 25m` returns a pick list that fits a focus block, using the effort
  buckets (`quick` about 5 min, `medium` about 15, `deep` about 45; tune with
  the Detect loop's time-to-decision data).
- Runs on a schedule and on demand (`just queue`).
- The cross-repo token stays in this command, out of reach of any model.

## 3. `security-review`

Covers what PR review, CodeQL and dependency patching do not: issues that only
show when you look at the whole repo or the whole fleet.

Candidate probes (deterministic, each emits structured findings):

- workflow trust boundaries: `pull_request_target`, untrusted checkout,
  artifact poisoning, over-broad `permissions`, secrets reaching forks
- drift between intended and actual repo settings and rulesets (reuse the
  `init` settings table and `rulesets-plan --check`)
- stale or unused credentials (`cf-tokens` plan already knows last use)
- secret handling in IaC (SOPS recipients, plaintext in history)
- data migrations: destructive statements, missing rollback
- reachability of vulnerable dependencies from this repo's own code

The model chains probe output into attack paths and ranks them. Every finding
needs evidence (`file:line`, or the setting and its value); a finding without
evidence is dropped.

### Where it runs

Centrally, from the org's infra repo, on a schedule and on demand. Callers do
not fetch the private engine.

1. Deterministic job: mint `fleet-reader` token, check out each target repo
   read-only (no persisted credentials), check out the private engine, run the
   probes, write `findings.json`.
2. Model job: no credentials. Reads `findings.json` and the checked-out files.
   Safe-output: update one issue.
3. Deterministic job: mint `fleet-writer` token, apply the update.

Findings go to the infra repo's floating issue, **never** to an issue on the
target repo. Several fleet repos are public, and an issue there discloses a
vulnerability before it is fixed.

Optional per-caller mode: the catalog workflow runs voidflow's public probes
only. A caller can add the private probes by supplying a read-only
`VOIDBLIGHT_TOKEN` and a pinned engine SHA. Scheduled and dispatch triggers
only, never `pull_request`.

### The private engine (`voidblight`)

- `probes/`: the deterministic checks above, versioned, with tests.
- `lessons/`: structured entries - pattern, why it mattered, detector if any.
  A lesson that repeats becomes a probe. Lessons are inputs, never published.
- `prompts/`: the prompt kit.
- Protect its branches with the same rulesets as voidflow and pin it by SHA
  everywhere. Its code runs with credentials, so treat it as trusted
  infrastructure.

### Findings state

Fingerprint each finding (probe id, location, normalized evidence). The issue
tracks new, known, fixed and dismissed. A dismissal records a reason, and the
reasons feed `lessons/`.

### Detect loop

- **Canaries.** Plant known vulnerabilities in a test repo and measure recall
  per probe and for the model's ranking. This is the adversarial check on the
  checker.
- **Dismissal rate** per probe (false positive proxy).
- **Time to fix** per finding.

## 4. `init` support

- Write a starter `AGENTS.md` (setup commands, conventions, what an agent must
  not touch). Keep `CLAUDE.md` as a one-line import of it.
- Offer `--preset agentic`: `gh aw add` for the chosen workflows, the
  `agentic-locks` job, the labels, and a check that the engine's credential
  exists. If the repo is org-owned, try `copilot-requests: write` before
  falling back to `COPILOT_GITHUB_TOKEN`.
- A fleet-wide `voidflow check` that reuses the `init` settings table for drift.

## Stability and versioning

Per `STABILITY.md`:

- New workflows, bins and commands ship off by default and, for the CLI, as
  Experimental.
- New check names and labels (`pr-triage`, `queue:*`) become public surface
  when they ship; document them in the README and the surface table.
- A stricter verdict or new evidence is a minor; a looser verdict, a renamed
  label or check, or a new write power (auto-merge) is a major.
- The ledger `schema` field is versioned; readers must ignore unknown fields.

## Open questions

- Does gh-aw support scheduled runs, custom jobs and cross-repo reads the way
  this spec assumes? The `docs.github.com` pages do not cover it; check the
  gh-aw reference.
- Does `copilot-requests: write` work for the personal and org setups here, or
  does it need a Copilot plan the account does not have?
- Revert and "broke main" attribution is heuristic. Is the first-suspect-commit
  rule good enough, or is a manual `detect --mark` correction needed?
- Effort buckets are guesses until time-to-decision data exists.
- `ravenflight/infra` was not reviewed. Confirm its fleet map fits the same
  shape as `taraxvoid/infra/rulesets.ts`.
