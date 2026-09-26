---
sidebar_position: 8
title: Skills
description: Agent Skills for a mekik app — a server catalog of SKILL.md folders, client-declared skills behind an opt-in policy, progressive disclosure into the model's prompt, and a `skill` frame that shows which skill the agent is following.
---

# Skills

A **skill** is a folder with a `SKILL.md`: YAML frontmatter that names and describes it, then markdown instructions — the [Agent Skills](https://agentskills.io) format. mekik gives a graph's nodes a catalog of them and shows a client which one the agent is following, the way `tool_call` shows a tool. What goes into the model's context is **progressive**: names and descriptions up front, one skill's instructions when a task matches, a bundled file only when the instructions point at it.

The wire rules are normative in [`PROTOCOL.md §12`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md); this page is the authoring guide. The `SKILL.md` reader itself lives in ilmek — [`@ilmek/skills`](https://ilmek.aimtune.dev/skills) / `Ilmek.Skills` — so both projects read the same folders to the same result.

## The three levels

| level | what the model sees | when | helper |
|---|---|---|---|
| 1 | every skill's `name` + `description` | in the system prompt, always | `mekik.skills(ctx)` / `mekik.skillsPrompt(ctx)` — `Shuttle.Skills` / `Shuttle.SkillsPrompt` |
| 2 | one skill's full instructions | when a task matches | `mekik.loadSkill(ctx, name)` — `Shuttle.LoadSkill` |
| 3 | one bundled file | when the instructions point at it | `mekik.skillResource(ctx, name, path)` — `Shuttle.SkillResourceAsync` |

## Configuring the server's skills

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { mekik } from "@mekik/core";
import { SkillCatalog } from "@ilmek/skills";

// From folders — @ilmek/skills' catalog is a SkillSource as-is.
const app = mekik({ graph, skills: await SkillCatalog.fromDirectories(["./skills"]) });

// …or inline, for a small fixed set (or a test).
const app2 = mekik({
    graph,
    skills: [
        { name: "brand-voice", description: "Write in the house voice.", instructions: "Short sentences. No exclamation marks." },
        { name: "pdf", description: "Fill, merge and read PDF forms.", instructions: "…", tags: ["docs"] },
    ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
using Ilmek.Skills;

// Inline, for a small fixed set (or a test).
var app = new MekikApp(new MekikOptions
{
    Graph = g,
    Skills = SkillSources.Inline(
        new SkillEntry { Name = "brand-voice", Description = "Write in the house voice.", Instructions = "Short sentences. No exclamation marks." },
        new SkillEntry { Name = "pdf", Description = "Fill, merge and read PDF forms.", Instructions = "…", Tags = ["docs"] }),
});

// From folders — map Ilmek.Skills' catalog into entries.
var catalog = await SkillCatalog.FromDirectoriesAsync("./skills");
Skills = SkillSources.Inline(catalog.All().Select(s => new SkillEntry
{
    Name = s.Name, Description = s.Description, Instructions = s.Instructions,
})),
```

</TabItem>
</Tabs>

`skills` takes a **`SkillSource`** — anything with `list()` (level 1) and `get(name)` (level 2), optionally `readResource(name, path)` (level 3) — or a plain list. Tags on an entry scope which node sees it, exactly as [client tool tags](./client-tools.md#reading-the-toolbox--and-tags) do: an untagged skill is visible to every query, a tagged one only to queries whose tags intersect its own.

On connect, the server announces its catalog once, right after `welcome`, as a transient `skills` frame — level-1 summaries only, versioned by a hash so a client that hands the hash back in `hello.skillsHash` gets `{unchanged: true}` instead of the list. A UI can show what the agent can do before the first turn.

## Reading the catalog and building the prompt

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("agent", async (s, ctx) => {
    const system = BASE_PROMPT + "\n\n" + mekik.skillsPrompt(ctx, { tags: ["docs"] });
    const menu = mekik.skills(ctx);           // SkillSummary[] — name, description, tags?, source
    …
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var system = BasePrompt + "\n\n" + Shuttle.SkillsPrompt(ctx, tags: ["docs"]);
var menu = Shuttle.Skills(ctx);               // IReadOnlyList<SkillSummary>
```

</TabItem>
</Tabs>

`skillsPrompt` renders the `<available_skills>` block the model reads — identical text in TypeScript, .NET and ilmek's own renderer:

```xml
You have the following skills available. Each entry gives a skill's name and what it is for. When a task matches a skill, load that skill's full instructions by name before you act on the task.

<available_skills>
  <skill>
    <name>brand-voice</name>
    <description>Write in the house voice.</description>
  </skill>
  <skill>
    <name>pdf</name>
    <description>Fill, merge and read PDF forms.</description>
  </skill>
</available_skills>
```

It returns `""` when the turn has no skills, so appending it unconditionally is safe. Pass `{ intro: null }` / `intro: null` for the block alone, or your own sentence.

## Loading a skill — and the `skill` frame

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const pdf = mekik.loadSkill(ctx, "pdf");         // { name, description, instructions, tags?, source }
messages.push(new SystemMessage(pdf.instructions));

const conventions = await mekik.skillResource(ctx, "pdf", "references/forms.md");   // level 3
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var pdf = Shuttle.LoadSkill(ctx, "pdf");         // SkillEntry
messages.Add(new(ChatRole.System, pdf.Instructions));

var conventions = await Shuttle.SkillResourceAsync(ctx, "pdf", "references/forms.md");   // level 3
```

</TabItem>
</Tabs>

Every load emits a persistent **`skill` frame** — `{type:"skill", seq, data:{id, name, status:"loaded", source}}` — so the conversation shows *"using skill: pdf"* the way it shows a tool call, and a reconnecting tab replays it. An unknown name emits `status:"error"` and **throws**; the agent wrappers below turn that into an observation the model can read instead.

Loading is a catalog read, not a side effect, so it is not journaled; the trace id is replay-stable (task id + call order, like tool ids), so the resume pass after a pause upserts the same frame rather than duplicating it.

Level 3 exists only for a source with files behind it — `@ilmek/skills`' catalog confines `path` to the skill folder (`..` and absolute paths are refused). Inline and client-declared skills have no files; `skillResource` rejects for them, and `skillResourcesAvailable(ctx)` / `Shuttle.SkillResourcesAvailable` tells you up front.

## Client-declared skills (off by default)

A frontend can declare skills of its own — a house style, the names its screens use — inline in the handshake or a later `client_skills` frame:

```jsonc
{ "type": "hello", "skills": [
    { "name": "ui-conventions", "description": "How this app names its screens.",
      "instructions": "Call the cart the Basket. Never say 'checkout'.", "tags": ["ui"] } ] }
```

Declarations are **ignored entirely unless the app opts in** — the same posture as [client tools](./client-tools.md#accepting-the-server-side--off-by-default) and `acceptClientMeta`, because a skill's description and instructions are text a model will follow.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const app = mekik({ graph, skills, clientSkills: true });                            // accept everything well-formed

const app = mekik({                                                                   // …or allowlist
    graph,
    skills,
    clientSkills: (defs) => defs.filter((d) => d.name === "ui-conventions" && d.instructions.length <= 4000),
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var app = new MekikApp(new MekikOptions { Graph = g, Skills = skills, ClientSkills = ClientSkills.AcceptAll });

// …or allowlist
ClientSkills = (defs, conv) => defs.Where(d => d.Name == "ui-conventions" && d.Instructions.Length <= 4000).ToList(),
```

</TabItem>
</Tabs>

Leaving the option unset is the kill switch. The rules once it is on:

- **Sanitized first.** An entry needs a valid `name` (1–64 lowercase letters, digits, single hyphens), a non-empty `description` of at most 1024 characters and a string `instructions`; anything else is dropped, and a redeclared name replaces the earlier one.
- **The server wins.** A client skill whose name matches a server skill is dropped — a client cannot rewrite what a server skill tells the model.
- **Origin is visible.** Every summary carries `source: "server" | "client"`, and `mekik.skills(ctx, { source: "client" })` / `Shuttle.Skills(ctx, source: SkillOrigin.Client)` narrows to one origin, so a node can decide how much to trust what it lists.
- **Per connection, per turn.** Declarations vanish with the socket and are snapshotted at run start; a `client_skills` frame takes effect on the next turn. Multi-tab: the union across live connections, the latest declaration of a name winning — as for client tools.

## Handing skills to a model

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { runAgent } from "@mekik/langchain";

// One switch: the prompt gets the <available_skills> block, the tools get load_skill
// (and read_skill_resource when the catalog has files).
return { reply: await runAgent(ctx, model, { system, input: s.input, tools, skills: { tags: ["docs"] } }) };

// Or wire it yourself:
import { withSkills } from "@mekik/langchain";
const tools = [...withMekikTools(ctx, serverTools, policy), ...withSkills(ctx, { tags: ["docs"] })];
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// One switch: the prompt gets the <available_skills> block, the functions get load_skill
// (and read_skill_resource when the catalog has files).
return Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
{
    System = system, Input = input, Tools = tools, Skills = true, SkillTags = ["docs"],
}));

// Or wire it yourself:
var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
    .Concat(SkillFunctions.Wrap(ctx, tags: ["docs"]))
    .ToList();
```

</TabItem>
</Tabs>

`load_skill` returns the instructions as the tool observation and emits the `skill` frame; an unknown or filtered-out name comes back as an error observation, so the loop stays alive. See [LangChain → `withSkills`](../integrations/langchain.md#withskills--progressive-disclosure) and [Microsoft.Extensions.AI → `SkillFunctions.Wrap`](../integrations/dotnet-agents.md#skillfunctionswrap--progressive-disclosure).

## Authoring the folders

```
skills/
  pdf/
    SKILL.md
    references/forms.md
    scripts/fill.py
  brand-voice/
    SKILL.md
```

```markdown title="skills/pdf/SKILL.md"
---
name: pdf
description: >-
  Fill, merge and read PDF forms. Use when the user mentions a PDF,
  a form to fill, or asks to combine documents.
allowed-tools: Read Bash(python3:*)
metadata:
  author: AimTune
---

# PDF skill

Use `scripts/fill.py` to fill a form from a JSON payload; see
`references/forms.md` for the field-naming conventions.
```

The format, the frontmatter rules and the `skill` node types for stored graphs are documented on the ilmek side: [ilmek → Skills](https://ilmek.aimtune.dev/skills).
