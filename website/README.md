# mekik docs

The documentation site for [mekik](https://github.com/AimTune/mekik), built with
[Docusaurus](https://docusaurus.io/). Deploys to https://mekik.aimtune.dev.

```bash
pnpm install
pnpm start      # local dev server with hot reload
pnpm build      # static build into ./build
pnpm serve      # preview the production build
```

Docs live in `docs/`; the sidebar is `sidebars.ts`; site config is
`docusaurus.config.ts`. `PROTOCOL.md` in the repo root is the normative spec —
the `Protocol` section of this site is its narrated companion, not a replacement.
