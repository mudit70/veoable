# Pre-launch audit — adorable tree

Audit performed as part of [`mudit70/adorable#516`](https://github.com/mudit70/adorable/issues/516)
open-source readiness. Findings gate the mechanical-rename + npm publish
steps.

- **Audited tree:** `mudit70/adorable`
- **Audited SHA:** `ff810f06f828212503989795519dc69144b42800` (`main`)
- **Audit date:** 2026-06-30
- **Auditor:** Claude Code (unattended run — findings need human review)

## Executive summary

- **Secret scan:** ✅ clean. No high-signal cloud, OAuth, or private-key
  patterns found in tracked content. No `.env`, `.pem`, `.key`, `.crt`,
  or credential files are tracked; `.gitignore` covers them.
- **License audit:** ✅ compatible. All production dependency licenses
  are permissive (MIT, Apache-2.0, BSD-2/3-Clause, ISC, BlueOak-1.0.0,
  Unlicense). No GPL / AGPL / SSPL / EPL / MPL findings.
- **License on veoable:** ✅ **decided** — veoable ships under
  **Apache-2.0** (owner decision, 2026-06-30). adorable remains MIT.
  Both are permissive and compatible with the dependency set. See
  [F3](#f3--license-policy-discrepancy-apache-20-vs-mit--resolved).
- **`.env` / credential files:** ✅ none tracked; correctly gitignored.
- **Third-party attribution:** ⚠️ **needs targeted review** — no
  license-checker was run against the deep-history file set. First-cut
  found nothing suspicious in the working tree, but code copied from
  other OSS projects (especially fixtures / test-apps) should get a
  focused pass before public release.

Recommendation: **safe to proceed** to mechanical-rename PR once the
license policy is resolved (Apache-2.0 vs. MIT).

## Method

Ran, from `~/projects/adorable` at SHA `ff810f0`:

### Secret scan (grep-based fallback)

`gitleaks` and `trufflehog` are not installed on the audit host. Ran
targeted `git grep` patterns instead:

```bash
# Cloud / OAuth / private key signatures
git grep -InE 'AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|xoxb-[0-9]+-[0-9]+|ghp_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED |PRIVATE)?PRIVATE KEY' \
  -- ':!*.lock' ':!*.md'

# Hardcoded password / apiKey / secret / token literals (non-fixture)
git grep -InE 'password\s*[:=]\s*"[^"]{4,}|api[_-]?key\s*[:=]\s*"[^"]{10,}|secret\s*[:=]\s*"[^"]{8,}|token\s*[:=]\s*"[^"]{16,}' \
  -- ':!*.lock' ':!*.md' ':!*/test/**' ':!*/tests/**' ':!*/fixtures/**' ':!*/test-apps/**' \
  | grep -iv 'process.env\|example\|placeholder\|fake\|test'

# Tracked env / key / credential files
git ls-files | grep -iE '\.env|\.pem|\.key$|\.crt$|credentials\.json|secrets\.json'
```

All three returned **zero matches**.

**Follow-up before public release:** run a full `gitleaks detect
--source .` against the full git history (409 commits). Grep only
covers the current tree; a real secret-scanner covers every historical
blob.

### License audit

```bash
pnpm licenses list --prod 2>&1 \
  | awk 'BEGIN{FS="│"} /^│/ && NF>=3 { gsub(/^ +| +$/,"",$3);
         if ($3 != "License" && $3 != "") print $3 }' \
  | sort -u
```

Unique license values across all transitive production dependencies:

```
(BSD-2-Clause OR MIT OR Apache-2.0)
(MIT OR WTFPL)
Apache-2.0
BSD-2-Clause
BSD-3-Clause
BlueOak-1.0.0
ISC
MIT
Unlicense
```

All are permissive and compatible with **either** MIT or Apache-2.0 as
the project license.

- `Unlicense` (used by `tree-sitter-wasms`) is public-domain equivalent
  in most jurisdictions; some legal teams prefer to double-check
  attribution requirements. Non-blocking.
- `BlueOak-1.0.0` (used by some newer JS ecosystem tools) is permissive
  and OSI-approved.
- The `(A OR B)` composite entries are OR-choice; downstream can pick
  the compatible option.

### Tracked-file spot check

```bash
git ls-files | wc -l       # 2043 files
git log --oneline | wc -l  # 409 commits
cat .gitignore             # covers node_modules/, dist/, *.db, *.env,
                           # tmp/, grade-tcc/, veodiagram*.project.json,
                           # .claude/, .DS_Store, coverage/
```

The working directory contains several `*.db` files (`graph.db`,
`graph-v2.db`, etc.) but these are **local analysis artifacts** — the
`.gitignore` prevents them from being tracked. Verified: none appear
in `git ls-files`.

## Findings

### F1 — Secret scan: no findings 🟢

No high-signal secret patterns in tracked content of the current tree.
No credential-shaped files tracked. `.gitignore` correctly covers
`.env`, `.env.local`, and `*.db*`.

**Follow-up before public release:** run a real secret-scanner
(`gitleaks detect --source . --log-level info`) against the full git
history. A hosted CI-run (e.g. as a GitHub Actions job on the rename
PR) is the least-friction option.

### F2 — License compatibility: clean 🟢

All production dependency licenses are permissive. No GPL / AGPL /
SSPL / EPL / MPL findings.

**Follow-up:** re-run `pnpm licenses list` after the rename PR (the
`@veoable/*` namespace change doesn't affect transitive licenses, but
worth confirming). Consider adding a `pnpm licenses list --prod` step
to CI so drift shows up as a broken build rather than a launch-day
surprise.

### F3 — License policy discrepancy: Apache-2.0 vs. MIT ✅ resolved

**Decision (2026-06-30):** ship veoable under **Apache-2.0**.

Rationale: Apache-2.0's explicit patent grant and per-file license
identification are valuable for a project accepting third-party
framework plugins. The production dependency set is fully compatible.

Implication: veoable and adorable ship under different licenses
(MIT vs. Apache-2.0). Both are permissive; downstream consumers can
combine either into their own projects. The `@veoable/migrate-from-adorable`
migration command should call this out in its documentation so users
know the license changes when they upgrade.

Follow-up (not blocking this PR):

- Contributions should include an Apache-2.0 file header on new source
  files once the mechanical rename lands (or be exempt by a documented
  convention if we choose not to).
- Consider adding a `NOTICE` file at the repo root before first release
  — Apache-2.0 doesn't require one, but it's the conventional place to
  aggregate third-party attributions once we identify any.
- Contributor sign-off: whether to require DCO or CLA is a separate
  decision (F4 follow-ups).

The current README, CONTRIBUTING, and CHANGELOG already reference the
Apache-2.0 file that shipped in the initial commit. No file swap
needed.

### F4 — Third-party attribution: needs targeted review ⚠️

The tree includes ~2 000 tracked files, of which many are fixtures /
test-apps that may include code adapted from third-party OSS. A
first-cut grep did not surface obvious attribution blocks
(`// Adapted from ...`, `# Copyright <Foo> ...`) that would signal
copied code, but a real-eyes review is warranted before public release.

**Recommendation:** run a scoped `license-checker` (or a targeted
`grep -Rin 'copyright\|adapted from\|original by' packages/framework-*/tests`)
and add any findings to a `NOTICE` file at the repo root.

**Owner decision required** — non-blocking for the open-source
readiness PR itself; blocking for public announcement.

### F5 — `.env` / credential file audit: clean 🟢

No `.env`, `.env.*`, `*.pem`, `*.key`, `*.crt`, `credentials.json`,
or `secrets.json` files tracked. `.gitignore` covers `.env` and
`.env.local`. Working-tree local artifacts (`graph*.db`) are correctly
excluded.

## Pre-launch checklist (derived)

Ordered by blocking-ness for the public announcement:

- [x] **License policy** — Apache-2.0 confirmed (2026-06-30). No file
      changes required; docs already reference Apache-2.0. (F3)
- [ ] **Run a real secret-scanner** on full git history before the
      first `@veoable/*` npm publish. Attach the report as an artifact
      on the rename PR. (F1)
- [ ] **Attribution review** on `packages/*/tests`, `test-apps/`,
      `examples/`. Add a `NOTICE` file if any third-party code
      requires attribution. (F4)
- [ ] **Add `pnpm licenses list --prod` to CI** as a soft gate. (F2)
- [ ] **DCO or CLA?** Decide whether contributions require a DCO
      sign-off or CLA. Neither is required today; picking one before
      the first external PR is easier than retrofitting.

## Reproducing this audit

Everything in this report was produced from the SHA / commands listed
above, on a machine with pnpm 10 and Node 22 installed. Rerun locally:

```bash
git clone https://github.com/mudit70/adorable ~/projects/adorable
cd ~/projects/adorable
git checkout ff810f06f828212503989795519dc69144b42800
pnpm install

# Secret scan (grep fallback — install gitleaks for real coverage)
git grep -InE 'AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}|-----BEGIN (RSA |EC |DSA )?PRIVATE KEY' -- ':!*.lock' ':!*.md'

# License scan
pnpm licenses list --prod
```
