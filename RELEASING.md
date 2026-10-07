# Releasing mekik

One tag publishes both sides: `@mekik/*` to npm (OIDC trusted publishing, no
token) and `Mekik.*` to NuGet (NuGet trusted publishing via `NuGet/login`).

## The normal release

Versions live **in the repo** (unlike chativa, where the tag stamps them):

```bash
# 1. bump every ts/packages/*/package.json "version" and
#    dotnet/Directory.Build.props <Version> to the same number
# 2. one release commit + tag
git commit -am "chore(release): 0.9.0"
git push origin main
git tag v0.9.0 && git push origin v0.9.0
```

The `v*` tag runs two independent workflows:

- **[release-npm.yml](.github/workflows/release-npm.yml)** — `pnpm -r publish`
  publishes every non-private workspace package in dependency order, skipping
  versions that already exist (safe to re-run after a partial failure). pnpm is
  pinned to 10 on purpose: OIDC publishing regressed in pnpm 11 (pnpm/pnpm#11513).
- **[release.yml](.github/workflows/release.yml)** — restore → build → test →
  pack the whole solution → push every nupkg with a short-lived key minted from
  the OIDC token (`NuGet/login@v1`, owner `aimtune`).

## Adding a new npm package

`pnpm -r publish` picks a new workspace package up automatically — **no
workflow change**. Two one-time registry steps remain, because npm can only
attach a trusted publisher to a package that exists:

```powershell
cd ts/packages/<new> ; pnpm publish --access public --no-git-checks ; cd ../..
npm trust github "@mekik/<new>" --file release-npm.yml --repo AimTune/mekik -y
npm trust list "@mekik/<new>" --json   # expect AimTune/mekik + release-npm.yml
```

The trusted publisher binds to **`release-npm.yml`** (this repo's filename) and
to owner `AimTune` with that exact capitalization — fields are case-sensitive
and not validated on save; a mismatch only surfaces as a 404 at publish time.
`npm trust` prompts a browser 2FA approval; commands within ~5 minutes of an
approval don't re-prompt.

## Adding a new NuGet package

Add the project to the solution; `dotnet pack` + push cover it on the next tag,
provided the nuget.org trusted-publishing policy for owner `aimtune` allows new
package IDs (check the policy's package pattern). Otherwise push the first
version once with a scoped API key, then delete the key.
