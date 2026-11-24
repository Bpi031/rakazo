import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const connection = process.env.CHECKPOINT_TEST_DATABASE_URL;
const enabled =
  connection && /^rakazo_checkpoint_[a-z0-9_]+$/.test(new URL(connection).pathname.slice(1));
const migration = (name: string) =>
  readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");

describe.skipIf(!enabled)("checkpoint research retention migration", () => {
  it.each(["thread", "bot"] as const)(
    "keeps existing snapshots, branches and audits after deleting the %s",
    async (source) => {
      const pool = new Pool({ connectionString: connection, max: 1 });
      const schema = `checkpoint_retention_${randomUUID().replaceAll("-", "")}`;
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(`
          CREATE TABLE bots (id TEXT PRIMARY KEY);
          CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            "botId" TEXT REFERENCES bots(id) ON DELETE CASCADE,
            "nextMessageSeq" INTEGER
          );
          CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            "threadId" TEXT REFERENCES threads(id) ON DELETE CASCADE,
            seq INTEGER
          );
          CREATE TABLE events (id TEXT PRIMARY KEY, "threadId" TEXT, seq INTEGER);
          CREATE TABLE runs (id TEXT PRIMARY KEY, "threadId" TEXT);
          CREATE TABLE routines (id TEXT PRIMARY KEY);
          CREATE TABLE artifacts (id TEXT PRIMARY KEY, "botId" TEXT, "groupId" TEXT);
          INSERT INTO bots VALUES ('bot');
          INSERT INTO threads VALUES ('thread', 'bot', 42);
          INSERT INTO messages VALUES ('message', 'thread', 41);
        `);
        await client.query(migration("20261115000000_checkpoints_v1"));
        const fileManifest = {
          version: 1,
          entries: [{ path: "result.xlsx", sha256: "a".repeat(64), size: 9 }],
        };
        const businessState = {
          transcript: [{ id: "message", seq: 41, role: "user", blocks: [{ text: "Clean input" }] }],
          artifacts: [{ id: "artifact" }],
          binding: { sourceSha256: "b".repeat(64) },
        };
        const taskState = [{ id: "run", status: "cancelled" }];
        await client.query(
          `INSERT INTO checkpoints (
            id, "threadId", "spaceId", "botId", "userId", "branchId", kind, label,
            "cutoffMessageSeq", "cutoffEventSeq", generation, "fileManifest", "businessState", "taskState"
          ) VALUES ('checkpoint', 'thread', 'space', 'bot', 'user', 'initial:thread', 'manual',
            'Research baseline', 41, 7, 2, $1::jsonb, $2::jsonb, $3::jsonb)`,
          [JSON.stringify(fileManifest), JSON.stringify(businessState), JSON.stringify(taskState)],
        );
        await client.query(`
          INSERT INTO conversation_branches (id, "threadId", "parentBranchId", "parentCutoffMessageSeq", "parentCutoffEventSeq")
            VALUES ('fork', 'thread', 'initial:thread', 41, 7);
          INSERT INTO rollback_audit_logs (
            id, "threadId", "spaceId", "botId", "userId", "toCheckpointId", "rescueCheckpointId",
            "branchId", generation, status, details
          ) VALUES ('audit', 'thread', 'space', 'bot', 'user', 'checkpoint', 'rescue',
            'fork', 3, 'completed', '{"restoreMode":"reconstructed","cancelledTasks":["run"]}');
        `);
        const before = {
          checkpoints: (await client.query("SELECT * FROM checkpoints ORDER BY id")).rows,
          branches: (await client.query("SELECT * FROM conversation_branches ORDER BY id")).rows,
          audits: (await client.query("SELECT * FROM rollback_audit_logs ORDER BY id")).rows,
        };
        await client.query(migration("20261116000000_checkpoint_research_retention"));
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM pg_constraint
               WHERE contype = 'f' AND connamespace = $1::regnamespace
                 AND conrelid IN ('checkpoints'::regclass, 'conversation_branches'::regclass,
                   'rollback_audit_logs'::regclass)`,
              [schema],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        await client.query(source === "bot" ? "DELETE FROM bots" : "DELETE FROM threads");
        expect((await client.query("SELECT id FROM threads")).rows).toEqual([]);
        expect((await client.query("SELECT id FROM messages")).rows).toEqual([]);
        expect({
          checkpoints: (await client.query("SELECT * FROM checkpoints ORDER BY id")).rows,
          branches: (await client.query("SELECT * FROM conversation_branches ORDER BY id")).rows,
          audits: (await client.query("SELECT * FROM rollback_audit_logs ORDER BY id")).rows,
        }).toEqual(before);
      } finally {
        await client.query("ROLLBACK");
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        client.release();
        await pool.end();
      }
    },
  );
});
