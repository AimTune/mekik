# syntax=docker/dockerfile:1
#
# Build image for Anthropic's OSS Scanner (https://red.anthropic.com/oss-scanner).
#
# The scanner clones this repository, builds this Dockerfile with the clone as
# the build context (network ON), then audits the finished image with network
# OFF. Everything the build or the tests need must therefore be fetched here:
# pnpm's store, NuGet's package cache, and both toolchains.
#
# Layout inside the image mirrors the repo: /src is the checkout, with the
# TypeScript workspace built under /src/ts and the .NET solution under
# /src/dotnet. The final stage keeps apt so the scanner can add its own layer.
#
# Verify locally (from the repository root):
#   docker build -f .oss-scanner/Dockerfile -t mekik-scan .
#   docker run --rm -it --network none mekik-scan bash
#   (cd ts && pnpm test) && (cd dotnet && dotnet test Mekik.slnx -c Release --no-build)

FROM mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_XMLDOC_MODE=skip \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH

# Node 24 is what CI runs (tests and examples are executed as .ts directly via
# Node's type stripping). pnpm 10 matches the workflows and the lockfile.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg bash \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm@10 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . /src

# ── TypeScript workspace ───────────────────────────────────────────────────────
# Restore from the lockfile and build every package (real tsc, which is what
# proves the types). A failing install or build fails the image; primary_contact
# gets the log. The conformance fixtures under /src/conformance are read by the
# tests directly from the checkout.
WORKDIR /src/ts
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm test:types

# Run the suites once so the image is known-good, but as the scanner template
# recommends, do not let a failing test abort the build.
RUN pnpm test || echo "WARNING: TypeScript tests reported failures"

# ── .NET solution ──────────────────────────────────────────────────────────────
# Restore is the only step that needs the network; build and test run with
# --no-restore / --no-build so they are reproducible offline.
WORKDIR /src/dotnet
RUN dotnet restore Mekik.slnx \
 && dotnet build Mekik.slnx -c Release --no-restore
RUN dotnet test Mekik.slnx -c Release --no-build --verbosity minimal \
 || echo "WARNING: .NET tests reported failures"

WORKDIR /src
