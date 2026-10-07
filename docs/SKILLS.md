# Skills — what the agent knows how to do, progressively

A **skill** is a folder with a `SKILL.md`: YAML frontmatter that names and
describes it, then markdown instructions — the Agent Skills format. mekik
(PROTOCOL.md §12) gives a graph's nodes a catalog of them, shows a client which
one the agent is following, and lets a frontend declare skills of its own behind
an opt-in policy. The `SKILL.md` reader lives in ilmek (`@ilmek/skills` /
`Ilmek.Skills`); mekik consumes any `SkillSource`.

The published guide is [website/docs/authoring/skills.md](../website/docs/authoring/skills.md);
this file is the short version plus the design notes.

## The three levels

| level | what enters the model's context | mekik API |
|---|---|---|
| 1 | every skill's `name` + `description` (the `<available_skills>` block) | `mekik.skills(ctx, {tags?, source?})`, `mekik.skillsPrompt(ctx, …)` / `Shuttle.Skills`, `Shuttle.SkillsPrompt` |
| 2 | one skill's instructions | `mekik.loadSkill(ctx, name)` / `Shuttle.LoadSkill` → emits a `skill` frame |
| 3 | one bundled file | `mekik.skillResource(ctx, name, path)` / `Shuttle.SkillResourceAsync` |

Agent wrappers: `withSkills(ctx, filter)` / `runAgent({ skills })` in
`@mekik/langchain`, `SkillFunctions.Wrap(ctx, tags, source)` /
`AgentRunOptions.Skills` in `Mekik.Agents` — a `load_skill` tool, plus
`read_skill_resource` when the catalog has files.

## Wire (§12)

- `skills` — transient, sent once after `welcome`: `{type, hash, unchanged?,
  skills?: SkillSummary[]}`, the server's level-1 catalog, hash-versioned like
  `genui_components`. `hello.skillsHash` short-circuits it.
- `skill` — persistent, upsert by `data.id`: `{type, seq, data:{id, name,
  status:"loaded"|"error", source?, error?}}`. Emitted by every load.
- `hello.skills` / `client_skills` — a client's inline declarations, the
  connection's whole set each time (`[]` withdraws). Inert unless
  `MekikOptions.clientSkills` opts in.

## Design notes

- **Why the server never re-announces client skills.** A client already knows
  what it declared, and the catalog frame is about what the *server* offers.
- **Why a client skill can't shadow a server skill.** The server's definition
  is authoritative; a colliding client declaration is dropped in the turn merge
  (`TurnSkills` / `TurnSkillSource`), so a manipulated client cannot rewrite
  what a trusted skill tells the model.
- **Why loads aren't journaled.** A load is a catalog read, not a side effect.
  The trace id is replay-stable (task id + call order, like tool ids) so a
  resume pass upserts the frame instead of duplicating it.
- **Why `source` is stamped.** A node can list only server skills, or only
  client ones, and a UI can render them differently. The stamp never enters the
  catalog hash.
- **Why a skill owns its tools, and why it's agent-side.** A node with many
  tools sends every schema on every call, and a skill's instructions are only
  useful together with the tools they talk about — so the skill definition
  carries them: `SkillEntry<TTool>.tools` (TS) / `SkillEntry<TTool>.Tools`
  (.NET). The agent loop keeps a skill's tools out of the request until the
  model loads that skill successfully, rebuilds the offered list after a load,
  and — because `load_skill` re-runs on a replay pass — offers each round the
  same toolbox on a resume. A premature call is refused as an observation
  rather than run, so the model never acts without the skill's instructions.
  `skillTools` / `SkillTools` on the run options add tools that must be built
  per request (closing over the turn's state); they merge with the entry's own.
- **Why the tools never reach the wire.** A tool is a server object (a function
  with its credentials and side effects), not data. The catalog frame, the
  catalog hash and the `skill` frame are computed from the summary fields
  only, so adding tools to an entry changes nothing a client sees — both
  suites assert the pinned hash literal for an entry with and without tools. A
  client declaration can never carry tools: sanitization keeps only the known
  fields, and the turn merge builds client entries from those fields alone.
- **Why `SkillEntry` is generic over the tool type.** `@mekik/core` /
  `Mekik.Core` know no agent framework. TS: `SkillEntry<TTool = unknown>`,
  closed as `SkillEntry<StructuredToolInterface>` by `@mekik/langchain`,
  which checks each entry at run start. .NET: `SkillEntry` stays the plain
  record and `SkillEntry<TTool> : SkillEntry` adds `Tools` (records clone their
  runtime type, so the turn snapshot keeps it); `Mekik.Agents` reads
  `SkillEntry<AIFunction>`. A tool of the wrong type fails the run rather
  than being dropped silently.
- **Why the prompt renderer is duplicated in mekik.** `@mekik/core` does not
  depend on `@ilmek/skills` (a `SkillSource` is structural), so mekik ships the
  same renderer and both suites pin the same output — the ilmek fixture's
  expected prompt is asserted byte-for-byte in mekik's tests too.

Wire spec: [PROTOCOL.md §12](../PROTOCOL.md#12-skills-12). Conformance:
`conformance/fixtures/skill-loaded.json` plus scenarios 21–24 in
[conformance/README.md](../conformance/README.md).
