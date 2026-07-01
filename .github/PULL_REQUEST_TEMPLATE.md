<!--
Thanks for the contribution! Fill out the sections below so reviewers
can move quickly. Delete anything that doesn't apply.
-->

## Summary

<!-- One or two sentences on what this PR does and why. -->

## Related issues

<!-- e.g. Closes #123, Refs #456. If none, delete. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing behavior
      to change)
- [ ] Documentation only
- [ ] Chore / infra (CI, dependencies, tooling)

## Screenshots / examples (if applicable)

<!-- Emitted flow diffs, CLI output before/after, MCP tool response
     samples. Delete if not relevant. -->

## Checklist

- [ ] Tests added or updated (unit + integration where applicable).
- [ ] `pnpm lint`, `pnpm test`, `pnpm test:integration`, and `pnpm build`
      all pass locally.
- [ ] `pnpm format:check` passes.
- [ ] `docs/userguide.md` (or the relevant doc) updated for user-visible
      changes.
- [ ] `CHANGELOG.md` entry added under the `## Unreleased` heading.
- [ ] Architectural rule 1 respected — no new framework plugin
      instantiates its own parser (see `CONTRIBUTING.md`).
- [ ] Architectural rule 2 respected — no new cross-repo AST sharing.
- [ ] For breaking changes: migration steps documented in the PR body
      **and** the changelog entry.

## Additional context

<!-- Anything reviewers should know that isn't obvious from the diff:
     tricky edge cases, benchmarks, follow-ups you plan to file. -->
