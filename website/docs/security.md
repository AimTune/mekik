---
sidebar_position: 12
title: Security
description: How to report a vulnerability in mekik, what is in scope, and how the repository is scanned by Anthropic's OSS Scanner.
---

# Security

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately:

- [GitHub private vulnerability reporting](https://github.com/AimTune/mekik/security/advisories/new), or
- email `hamzaagareng@gmail.com` with the subject line `mekik security`.

Say which package and version is affected (`@mekik/*` on npm, `Mekik.*` on NuGet), what input an attacker controls, which code path it reaches, and include a reproducer if you have one: a frame sequence, a `node --test` case, or an xUnit case. The two implementations share one wire protocol, so note whether the issue is in TypeScript, .NET, or both.

Expect an acknowledgement within 7 days. Fixes ship as a patch release of the affected packages, and the advisory is published after the release. Only the latest minor release line receives security fixes.

The canonical policy lives in [`SECURITY.md`](https://github.com/AimTune/mekik/blob/main/SECURITY.md) in the repository.

## Scope and threat model

The library packages under `ts/packages/` and `dotnet/src/` are in scope. Examples, this documentation site, and the conformance fixtures are not, unless they demonstrate a bug in the library.

The operator of a mekik server trusts the graph author and the process environment. It does **not** trust WebSocket clients, HTTP callers of the MCP and A2A endpoints, upstream MCP servers, or the LLM's tool-call arguments. The goals mekik enforces on that boundary are:

- isolation between conversations and users (no client can read, resume, or cancel a conversation or interrupt it does not own),
- interrupt integrity (a `resume` answers exactly one open interrupt on its own thread),
- client tools stay client-scoped (a `tool_result` only completes a call that client was asked to perform),
- no server-side code execution or SSRF from anything on the wire, and
- bounded resources per client.

The full write-up, including the severity rubric, is [`.oss-scanner/threat_model.md`](https://github.com/AimTune/mekik/blob/main/.oss-scanner/threat_model.md).

## Automated scanning

mekik is enrolled in [Anthropic's OSS Scanner](https://red.anthropic.com/oss-scanner). The scanner clones the repository, builds [`.oss-scanner/Dockerfile`](https://github.com/AimTune/mekik/blob/main/.oss-scanner/Dockerfile) with network access, then audits the finished image with no network and emails findings to the security contact with a reproducer and a proposed patch where available. Reports are model-generated and are not made public.

The Dockerfile installs both toolchains (Node 24 with pnpm 10, and the .NET 9 SDK), restores from the lockfiles, builds every package, and runs both test suites once during the build. Anything the tests need is therefore already in the image. To reproduce the scanner's environment locally:

```bash
docker build -f .oss-scanner/Dockerfile -t mekik-scan .
docker run --rm -it --network none mekik-scan bash
# inside the container
cd /src/ts && pnpm test
cd /src/dotnet && dotnet test Mekik.slnx -c Release --no-build
```

A fix that comes out of a scanner report credits the report id in the commit message, for example `Discovered by Anthropic's OSS Scanner, as vulnerability ANT-2026-XXXXXXXX`.
