# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Historical entries prior to the `adorable` → `veoable` rename are preserved
in the [`mudit70/adorable` CHANGELOG](https://github.com/mudit70/adorable/blob/main/CHANGELOG.md)
(if / when that file exists) and in the release notes of each
[`mudit70/adorable` release](https://github.com/mudit70/adorable/releases).

## Unreleased

### Added

- Community-facing artifacts: `README.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`.
- GitHub Actions CI workflow: install / lint / typecheck / test / build.
- Dependabot config for weekly npm + GitHub Actions dependency bumps.
- Issue templates (bug report, feature request) and PR template.

### Notes

- Groundwork for the `adorable` → `veoable` rename tracked in
  [`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516).
  Source drop and package-namespace rename land in a follow-up PR.
- **License:** veoable ships under **Apache-2.0** (decision recorded
  2026-06-30 during open-source readiness review). `mudit70/adorable`
  remains MIT; the `@veoable/migrate-from-adorable` command will note
  the license change during upgrade.
