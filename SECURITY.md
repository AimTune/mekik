# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately, either way:

- **GitHub private vulnerability reporting:**
  <https://github.com/AimTune/mekik/security/advisories/new>
- **Email:** <hamzaagareng@gmail.com> with the subject line `mekik security`.

Include the affected package and version (`@mekik/*` on npm, `Mekik.*` on
NuGet), the attacker-controlled input, the code path it reaches, and a
reproducer if you have one (a frame sequence, a `node --test` case, or an
xUnit case). Both language implementations share one wire protocol, so note
whether the issue affects TypeScript, .NET, or both.

You should get an acknowledgement within 7 days. Fixes ship as a patch release
of the affected packages; the advisory is published after the release.

## Supported versions

Only the latest minor release line on npm and NuGet receives security fixes.

## Scope

The library packages under `ts/packages/` and `dotnet/src/` are in scope. The
examples, the documentation site, and the conformance fixtures are not, unless
they demonstrate a bug in the library.

The threat model, including the trust boundaries and the severity rubric we
apply, is in [`.oss-scanner/threat_model.md`](.oss-scanner/threat_model.md).

## Automated scanning

mekik is enrolled in [Anthropic's OSS Scanner](https://red.anthropic.com/oss-scanner),
which builds the repository from [`.oss-scanner/Dockerfile`](.oss-scanner/Dockerfile)
and audits it offline. Fixes that come out of a scanner report credit the
report id in the commit message, for example
`Discovered by Anthropic's OSS Scanner, as vulnerability ANT-2026-XXXXXXXX`.
