# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Veoable, please
report it **privately**. Do NOT open a public GitHub issue for it.

**Preferred channels**

1. **GitHub private vulnerability report** — use the "Report a
   vulnerability" button on the repository's
   [Security tab](https://github.com/mudit70/veoable/security/advisories/new).
   This is the fastest path and gives the maintainers a private thread on
   GitHub.
2. **Email** — `security@veoable.dev`. If email is more convenient, or
   the GitHub form is unavailable to you, this address reaches the
   maintainers directly.

Please include, if possible:

- A description of the vulnerability and its impact.
- Reproduction steps or a minimal proof-of-concept.
- The affected version(s) — the git SHA or the `@veoable/*` package
  version.
- Any known mitigations or workarounds.

## Response SLA

- **Acknowledgement:** within **72 hours** of receiving your report.
- **Triage & severity assessment:** within **7 calendar days**.
- **Fix ETA:** communicated as part of triage; depends on severity and
  affected surface. Critical issues get a dedicated release track.

We will keep you informed at each milestone until the issue is resolved
or the report is closed.

## Coordinated disclosure

We follow a **coordinated disclosure** model:

1. You report privately.
2. We confirm, triage, and fix.
3. We publish an advisory and release the fix.
4. Public disclosure (issue / blog post / CVE) happens **after** users
   have had a reasonable window to update — typically **14 days** for
   moderate issues and **7 days** for critical ones after the fixed
   release ships.

If you'd prefer a different timeline, tell us in the report and we'll
coordinate.

## Scope

In scope:

- Code in this repository and any published `@veoable/*` package.
- The Veoable CLI (`veoable`) — including argument parsing, project
  loading, and any code that executes on the analyzer host.
- The Veoable MCP server (`@veoable/mcp-server`) — including tool
  handlers, argument validation, and any file / network I/O.
- Language plugins (`@veoable/lang-*`) and framework plugins
  (`@veoable/framework-*`) — particularly anything that reads source
  code, evaluates JavaScript, or executes shell commands.
- Documentation that could lead a user to a vulnerable configuration
  (e.g. a quickstart that ships an insecure default).

Out of scope:

- Vulnerabilities in third-party dependencies with no exploit path in
  Veoable itself. Report those to the dependency's maintainers; we'll
  track and update once a fix is available.
- Vulnerabilities requiring the attacker to have already compromised
  the machine the CLI runs on.
- Denial-of-service via extraordinarily large inputs where the fix is
  "don't run the analyzer on adversarial input" — file it as a bug so
  we can add limits, but it's not a security-severity issue.

## Safe harbor

We consider security research conducted in accordance with this policy
to be authorized, and we will not pursue legal action against
researchers who:

- Act in good faith to identify and report vulnerabilities.
- Avoid privacy violations, destruction of data, and disruption to
  services.
- Give us reasonable time to fix an issue before publicly disclosing it.

## Credit

If you'd like credit in the advisory, tell us your preferred name /
handle when you report. If you'd prefer to remain anonymous, that's
fine too.
