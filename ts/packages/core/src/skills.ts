// Skills (PROTOCOL.md §12) — the runtime side: where a turn's skills come from,
// how the catalog is versioned for the handshake, and how level 1 is rendered
// into a system prompt. The wire types live in protocol.ts.
//
// mekik does not read SKILL.md folders itself; `@ilmek/skills` does, and its
// `SkillCatalog` satisfies `SkillSource` structurally. Any object with the same
// shape — a database-backed registry, an inline list — works the same way.

import { createHash } from "node:crypto";

import { canonicalize, type ClientSkillDefinition, type SkillEntry, type SkillSummary } from "./protocol.ts";

/**
 * Where skills come from, as a node sees them — progressive disclosure in
 * three levels. `list()` is what a model sees before choosing (level 1),
 * `get()` is one skill's instructions (level 2), and the optional
 * `readResource()` is a bundled file (level 3).
 *
 * `@ilmek/skills`' `SkillCatalog` is one; so is a plain array via
 * {@link toSkillSource}. Entries may carry more fields than the interface
 * names (ilmek's `license`, `allowedTools`, `resources`, …) — mekik ignores
 * what it does not know.
 */
export interface SkillSource {
    /** Every skill's level-1 summary, in catalog order (by name). */
    list(): readonly SkillSummary[];
    /** The whole skill, instructions included, or `undefined` for an unknown name. */
    get(name: string): SkillEntry | undefined;
    /** The text of one bundled file, when the source has files behind it. */
    readResource?(name: string, path: string): Promise<string>;
}

/** What `MekikOptions.skills` accepts: a source, or a plain list of skills. */
export type SkillsInput = SkillSource | readonly SkillEntry[];

/** An in-memory {@link SkillSource} over a fixed list — inline and test skills. */
export class StaticSkillSource implements SkillSource {
    private readonly byName: ReadonlyMap<string, SkillEntry>;

    constructor(entries: Iterable<SkillEntry>) {
        const map = new Map<string, SkillEntry>();
        for (const e of entries) {
            if (map.has(e.name)) throw new Error(`two skills are named ${JSON.stringify(e.name)}`);
            map.set(e.name, e);
        }
        this.byName = new Map([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }

    list(): SkillSummary[] {
        return [...this.byName.values()].map(summaryOf);
    }

    get(name: string): SkillEntry | undefined {
        return this.byName.get(name);
    }
}

/** Normalize {@link SkillsInput} to a source. */
export function toSkillSource(input: SkillsInput): SkillSource {
    return Array.isArray(input) ? new StaticSkillSource(input as readonly SkillEntry[]) : (input as SkillSource);
}

/** The level-1 view: `name`, `description`, `tags?` — never the instructions. */
export function summaryOf(entry: SkillSummary): SkillSummary {
    const out: SkillSummary = { name: entry.name, description: entry.description };
    if (entry.tags !== undefined && entry.tags.length > 0) out.tags = [...entry.tags];
    if (entry.source !== undefined) out.source = entry.source;
    return out;
}

/**
 * The hash that versions the server's skill catalog for the handshake
 * (§12.2): sha256 over the canonical JSON of the summaries — `name`,
 * `description`, `tags` — sorted by name. Both languages mint the same hash
 * for the same catalog, so a client may cache it against either server.
 */
export function hashSkills(summaries: readonly SkillSummary[]): string {
    if (summaries.length === 0) return "";
    const sorted = summaries
        .map((s) => {
            const { source: _source, ...rest } = summaryOf(s);
            return rest;
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return createHash("sha256").update(canonicalize(sorted), "utf8").digest("hex");
}

// ── the prompt (level 1 as text) ──────────────────────────────────────────────

/** What a model is told about the `<available_skills>` block, unless the app says otherwise. */
export const DEFAULT_SKILLS_INTRO =
    "You have the following skills available. Each entry gives a skill's name and what it is for. " +
    "When a task matches a skill, load that skill's full instructions by name before you act on the task.";

export interface SkillsPromptOptions {
    /** The sentence(s) before the block. `null` renders the block alone. Default {@link DEFAULT_SKILLS_INTRO}. */
    intro?: string | null;
}

/**
 * Render level 1 for a system prompt — the same text `@ilmek/skills`'
 * `renderSkillsPrompt` and `Ilmek.Skills`' `SkillPrompt.Render` produce:
 *
 * ```xml
 * <available_skills>
 *   <skill>
 *     <name>pdf</name>
 *     <description>Fill, merge and read PDF forms.</description>
 *   </skill>
 * </available_skills>
 * ```
 *
 * Returns `""` for an empty list.
 */
export function renderSkillsPrompt(skills: readonly SkillSummary[], opts: SkillsPromptOptions = {}): string {
    if (skills.length === 0) return "";
    const intro = opts.intro === undefined ? DEFAULT_SKILLS_INTRO : opts.intro;
    const lines: string[] = [];
    if (intro !== null && intro !== "") lines.push(intro, "");
    lines.push("<available_skills>");
    for (const s of skills) {
        lines.push(
            "  <skill>",
            `    <name>${escapeXml(s.name)}</name>`,
            `    <description>${escapeXml(s.description)}</description>`,
            "  </skill>",
        );
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}

function escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── the turn's merged view ────────────────────────────────────────────────────

/**
 * What one turn sees at `ctx.meta.skills` (§12.3): the server's catalog plus
 * the client-declared skills the app accepted, each summary stamped with its
 * `source`. A client skill whose name collides with a server skill is
 * **dropped** — the server's definition is authoritative, and a client must
 * not be able to rewrite what a server skill tells the model.
 */
export class TurnSkills implements SkillSource {
    private readonly server: SkillSource | undefined;
    private readonly client: ReadonlyMap<string, ClientSkillDefinition>;
    readonly readResource?: (name: string, path: string) => Promise<string>;

    constructor(server: SkillSource | undefined, client: readonly ClientSkillDefinition[] = []) {
        this.server = server;
        const serverNames = new Set(server?.list().map((s) => s.name) ?? []);
        this.client = new Map(client.filter((c) => !serverNames.has(c.name)).map((c) => [c.name, c]));
        // Level 3 exists only when the server source has files behind it; client
        // skills travel inline and never carry resources.
        if (server?.readResource) {
            this.readResource = async (name, path) => {
                if (!serverNames.has(name)) throw new Error(`skill ${JSON.stringify(name)} has no resources`);
                return server.readResource!(name, path);
            };
        }
    }

    list(): SkillSummary[] {
        const out: SkillSummary[] = (this.server?.list() ?? []).map((s) => ({ ...summaryOf(s), source: "server" }));
        for (const c of this.client.values()) out.push({ ...summaryOf(c), source: "client" });
        return out;
    }

    get(name: string): SkillEntry | undefined {
        const server = this.server?.get(name);
        if (server) return { ...server, ...summaryOf(server), instructions: server.instructions, source: "server" };
        const client = this.client.get(name);
        return client ? { ...summaryOf(client), instructions: client.instructions, source: "client" } : undefined;
    }
}
