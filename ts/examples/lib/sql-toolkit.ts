// A SQL toolkit shaped like LangChain's own.
//
// LangChain JS *had* `SqlDatabase` + `SqlToolkit` (`langchain/sql_db`,
// `langchain/agents/toolkits/sql`), but they were dropped in LangChain v1 and
// live only on the 0.3 line, which pins `@langchain/core >=0.3.58 <0.4.0` and
// wants TypeORM. These examples are on `@langchain/core` 1.x, so the toolkit is
// reproduced here against `node:sqlite` instead — same tool names, same
// `getTools()` shape, same "the model discovers the schema itself" flow.
//
// The point it makes for mekik is the one that matters: `withMekikTools` takes
// any `StructuredToolInterface[]`. It does not care whether you authored the
// tools or a toolkit handed them to you, so a prebuilt toolkit gets traces,
// masking and exactly-once replay without being modified.

import { DatabaseSync } from "node:sqlite";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

export type Row = Record<string, unknown>;

export interface QueryResult {
    columns: string[];
    rows: Row[];
}

/** Called after a successful `query-sql`, so the caller can render the rows. */
export type OnRows = (result: QueryResult & { sql: string }) => void;

/**
 * A thin stand-in for LangChain's `SqlDatabase`: it owns the connection and the
 * read-only policy, so the tools stay presentation-only.
 */
export class SqlDatabase {
    readonly db: DatabaseSync;
    /** Every statement the agent attempted, with what came of it. */
    readonly audit: Array<{ sql: string; outcome: string }> = [];

    constructor(db: DatabaseSync) {
        this.db = db;
    }

    static fromSchema(schema: string): SqlDatabase {
        const db = new DatabaseSync(":memory:");
        db.exec(schema);
        return new SqlDatabase(db);
    }

    tableNames(): string[] {
        const rows = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>;
        return rows.map((r) => r.name);
    }

    /** CREATE TABLE plus a couple of sample rows — what `info-sql` returns. */
    tableInfo(tables: string[]): string {
        return tables
            .map((raw) => {
                const table = raw.trim();
                const found = this.db
                    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                    .get(table) as { sql?: string } | undefined;
                if (!found?.sql) {
                    throw new Error(`No table named ${table}. Known tables: ${this.tableNames().join(", ")}.`);
                }
                // Sample rows help the model far more than the schema alone: they
                // show the value shapes (cents vs dollars, date formats, enums).
                const sample = this.db.prepare(`SELECT * FROM "${table}" LIMIT 3`).all() as Row[];
                return `${found.sql}\n\n/* 3 rows from ${table}:\n${JSON.stringify(sample, null, 2)}\n*/`;
            })
            .join("\n\n");
    }

    /** Anything that is not a single read is refused before it reaches SQLite. */
    assertReadOnly(sql: string): void {
        const trimmed = sql.trim().replace(/;\s*$/, "");
        if (/;/.test(trimmed)) {
            throw new Error("Only a single statement is allowed — remove the ';' and send one query.");
        }
        if (!/^(select|with)\b/i.test(trimmed)) {
            const verb = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? "that";
            throw new Error(
                `This connection is read-only, so ${verb} is refused. You can SELECT to inspect data, but not modify it.`,
            );
        }
    }

    run(sql: string): QueryResult {
        this.assertReadOnly(sql);
        let rows: Row[];
        try {
            rows = this.db.prepare(sql).all() as Row[];
        } catch (err) {
            // SQLite names the offending token, which is exactly what the model
            // needs to fix the query on its next turn.
            this.audit.push({ sql, outcome: "sql error" });
            throw new Error(`SQLite rejected the query: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.audit.push({ sql, outcome: `${rows.length} row(s)` });
        return { columns: rows.length > 0 ? Object.keys(rows[0]!) : [], rows };
    }
}

export interface SqlToolkitOptions {
    /** Invoked after a successful query — used here to emit the `data-table` card. */
    onRows?: OnRows;
}

/**
 * The toolkit. `getTools()` mirrors LangChain's `SqlToolkit.getTools()`, and the
 * tool names are the ones LangChain used, so a prompt written against the real
 * toolkit still reads correctly.
 */
export class SqlToolkit {
    readonly db: SqlDatabase;
    private readonly onRows: OnRows | undefined;

    constructor(db: SqlDatabase, options: SqlToolkitOptions = {}) {
        this.db = db;
        this.onRows = options.onRows;
    }

    getTools(): StructuredToolInterface[] {
        return [this.listTables(), this.infoSql(), this.querySql()];
    }

    private listTables(): StructuredToolInterface {
        return tool(() => this.db.tableNames().join(", "), {
            name: "list-tables-sql",
            description: "Input is an empty string. Output is a comma-separated list of tables in the database.",
            schema: z.object({}),
        });
    }

    private infoSql(): StructuredToolInterface {
        return tool(({ tables }) => this.db.tableInfo(tables.split(",")), {
            name: "info-sql",
            description:
                "Input is a comma-separated list of tables. Output is their schema and sample rows. " +
                "Call list-tables-sql first to be sure the tables exist.",
            schema: z.object({ tables: z.string().describe("Comma-separated table names, e.g. orders,customers") }),
        });
    }

    private querySql(): StructuredToolInterface {
        return tool(
            ({ sql }) => {
                const result = this.db.run(sql);
                this.onRows?.({ ...result, sql });
                // Returned as an object, not a JSON string: mekik's `redact` masks
                // by field name and walks nested rows — it cannot see into a string.
                return result;
            },
            {
                name: "query-sql",
                description:
                    "Run one read-only SQL query (SELECT or WITH) and return its rows. " +
                    "If the query is wrong you will get an error back — rewrite it and try again.",
                schema: z.object({ sql: z.string().describe("A single SELECT statement, without a trailing semicolon") }),
            },
        );
    }
}
