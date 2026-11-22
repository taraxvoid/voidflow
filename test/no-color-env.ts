// Preloaded by bunfig.toml. Suites assert on plain init output, but init turns
// color on when FORCE_COLOR is set (some terminals and runners export it), so
// ANSI codes leak into the expectations. Pin color off for every run: deleting
// FORCE_COLOR would let init fall back to the TTY check and color a terminal
// run. The tests that exercise color set FORCE_COLOR themselves.
delete process.env.NO_COLOR
process.env.FORCE_COLOR = '0'
