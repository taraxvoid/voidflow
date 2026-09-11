# Changelog

All notable changes to this project are documented here, generated with
[git-cliff](https://git-cliff.org) from [Conventional Commits](https://www.conventionalcommits.org).

Commits made before conventional commits were adopted are not included.
<!-- git-cliff: end of header -->
## [0.3.0] - 2026-09-11

### 🚀 Features

- *(site-ci.yml)* Add GITLEAKS\_LICENSE secret since organizations require it
- Add conventional-commits release method ([#27](https://github.com/taraxvoid/voidflow/issues/27))

### 🐛 Bug Fixes

- Improve Playwright cache invalidation ([#22](https://github.com/taraxvoid/voidflow/issues/22))
- *(release.yml)* Pass GH_TOKEN through to just validate ([#28](https://github.com/taraxvoid/voidflow/issues/28))
- *(release)* Split into PR-then-tag flow, main is PR-only ([#30](https://github.com/taraxvoid/voidflow/issues/30))
- *(tag-release.yml)* Tolerate squash-merge's " (#NN)" suffix ([#33](https://github.com/taraxvoid/voidflow/issues/33))

### ⚙️ Miscellaneous Tasks

- Self-validation checks, security audit, and local dry-run tooling
- Swap action-validator for check-jsonschema, fix act dry-run end-to-end
## [0.2] - 2026-09-09

### ⚙️ Miscellaneous Tasks

- Correct audit gating + fix Build-before-Unit-tests ordering ([#1](https://github.com/taraxvoid/voidflow/issues/1))
