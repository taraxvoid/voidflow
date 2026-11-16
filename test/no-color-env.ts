// Preloaded by bunfig.toml. Suites assert on plain init output, but init turns
// color on when FORCE_COLOR is set (some terminals and runners export it), so
// ANSI codes leak into the expectations. Start every run with color env unset;
// the tests that exercise color set FORCE_COLOR themselves.
delete process.env.FORCE_COLOR
delete process.env.NO_COLOR
