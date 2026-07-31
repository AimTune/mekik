# mekik

mekik is the realtime serving layer for ilmek graphs: it turns each graph run into one conversational turn over WebSocket, streaming text, generative UI, tool traces, and human-in-the-loop pauses. It is a dual-language monorepo with parity implementations — `ts/` (TypeScript packages and examples), `dotnet/` (.NET mirror), `website/` (Docusaurus docs site), `docs/` (supplementary markdown: GENUI, HITL, LANGUAGES, SCALING), and `conformance/` (golden fixtures that pin both mappers to the same wire output). The wire format itself is specified in `PROTOCOL.md`.

## Documentation

Docs are part of the definition of done. Any user-facing feature or behavior change MUST update the website docs (`website/docs/`) and the relevant markdown docs in `docs/` **in the same PR** as the code change — not in a follow-up. Use the real option/API names and defaults from the source (both languages where parity applies); never let the published docs describe a protocol or API the code no longer has.
