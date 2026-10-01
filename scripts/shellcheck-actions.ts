#!/usr/bin/env bun
// Shellchecks the `run:` blocks inside composite action.yml files.
// actionlint already shellchecks .github/workflows/*.yml; it doesn't touch action.yml.
import { $ } from 'bun'

type Doc = { runs?: { steps?: Array<{ shell?: string; run?: string }> } }

const files = (await $`git ls-files -- '*/action.yml' '*/action.yaml'`.text()).split('\n').filter(Boolean)
let failed = false

for (const file of files) {
  const doc = Bun.YAML.parse(await Bun.file(file).text()) as Doc
  for (const [i, step] of (doc?.runs?.steps ?? []).entries()) {
    const shell = step.shell ?? ''
    if (shell !== 'bash' && shell !== 'sh') continue
    if (!step.run) continue

    // ${{ ... }} is substituted by the Actions runner before the shell ever
    // sees it; shellcheck doesn't know that syntax, so swap it for a
    // placeholder var (preserves quoting context, so real SC2086-type issues
    // around it still get caught).
    const script = step.run.replace(/\$\{\{[^}]*\}\}/g, '$GHA_EXPR')

    const proc = Bun.spawn(['shellcheck', '-s', shell, '-'], {
      stdin: new Blob([script]),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await proc.exited) !== 0) {
      console.log(`::error file=${file}::shellcheck failed on runs.steps[${i}]`)
      failed = true
    }
  }
}

process.exit(failed ? 1 : 0)
