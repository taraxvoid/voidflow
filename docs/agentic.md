# Agentic workflows

Experimental ([`STABILITY.md`](../STABILITY.md#experimental)).

A [gh-aw](https://github.github.com/gh-aw/) package in [`agentic/`](../agentic/).
Each workflow is Markdown you install into your repo and compile there, so it
runs with your repo's permissions, secrets and (for private repos) private logs.
Copilot is the default engine; pass `--engine` to `gh aw add` for another.

```sh
gh extension install github/gh-aw --pin v1.0.1
gh aw add taraxvoid/voidflow/agentic@vX.Y.Z   # pin a release, like the workflows
gh aw compile && git add .github/workflows && git commit -m "ci: add voidflow agentic workflows"
```

`gh aw update` brings later releases in and refuses a major without `--major`.
Keep the locks honest with the reusable check, which recompiles with a pinned
gh-aw and fails when a committed `.lock.yml` is stale or missing:

```yaml
  agentic-locks:
    uses: taraxvoid/voidflow/.github/workflows/agentic-locks.yml@<sha> # vX.Y.Z
```

## deps-review

Reviews Renovate and Dependabot PRs beyond "CI passed". Two parts, so a
compromised package can't talk its way to a merge:

- **The agent** reads the release notes between the two versions, checks them
  against what your code actually uses, and leaves a comment with the evidence
  and a `low-risk` or `needs-you` label. It treats every upstream
  string as untrusted and proposes a verdict; it never approves, merges,
  pushes or posts the check.
- **The gate job** (deterministic, runs after the agent) recomputes the hard
  signals with the `deps-signals` bin, which reads no free text: update type
  (patch or minor on 1.0+ only), a publisher who didn't publish or maintain the
  previous version, added install scripts, dropped provenance, new
  dependencies, action pins that don't match their tag, lockfile-only changes,
  and any file outside `package.json`, lockfiles and workflows. It posts the
  `deps-review` check on the exact commit the agent reviewed: green only when
  the agent said low risk **and** `deps-signals` is clean. Anything it can't
  verify is red.

Human PRs never start it.

Secrets: `COPILOT_GITHUB_TOKEN` (fine-grained PAT, Copilot Requests: Read) as
an Actions secret, and the same value as a **Dependabot** secret, since runs
Dependabot triggers only see Dependabot secrets.

Roll it out in stages:

1. **Shadow.** Install it and read its verdicts for a few weeks. Nothing merges.
2. **Gate.** Make `deps-review` a required check, post it on everyone else's
   PRs with the gate workflow, and let Renovate automerge low-risk updates:

   ```yaml
     deps-review-gate:
       uses: taraxvoid/voidflow/.github/workflows/deps-review-gate.yml@<sha> # vX.Y.Z
       permissions:
         checks: write
         contents: read
         pull-requests: read
   ```

   The gate passes a PR that changes no lockfile and no dependency field of
   any `package.json`. One that does (an agent's or a contributor's) fails as
   "Needs you" with the files listed, since nothing reviewed those
   dependencies: review them, then merge with an admin bypass. It fails
   closed: a `package.json` it cannot read or parse is listed too, a PR near
   GitHub's 3000-file listing limit fails, and if the file list itself cannot
   be fetched the step errors and posts no check, so the required check stays
   unmet.

   ```json
   { "extends": ["github>taraxvoid/voidflow", "github>taraxvoid/voidflow:deps-review-automerge"] }
   ```

   The opt-in preset automerges patch, minor, digest and pin updates on 1.0+
   versions through GitHub auto-merge, which
   waits for every required check on the current head; a Renovate rebase is
   re-reviewed before it can merge. Enable "Allow auto-merge" in the repo.
   Dependabot can't automerge itself: run `gh pr merge --auto --squash` on its
   PRs from a workflow, and the required check still gates the merge.
3. **Wider.** Add update classes (0.x minors, grouped monorepos) only with
   evidence from stage 2. Majors stay human.
