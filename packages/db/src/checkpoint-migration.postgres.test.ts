import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const connection = process.env.CHECKPOINT_TEST_DATABASE_URL;
const enabled =
  connection && /^rakazo_checkpoint_[a-z0-9_]+$/.test(new URL(connection).pathname.slice(1));

describe.skipIf(!enabled)("checkpoint migration on existing records", () => {
  it("backfills an initial branch without changing sequences or deleting legacy data", async () => {
    const pool = new Pool({ connectionString: connection, max: 1 });
    const schema = `checkpoint_migration_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE threads (id TEXT PRIMARY KEY, "botId" TEXT, "nextMessageSeq" INTEGER);
        CREATE TABLE messages (id TEXT PRIMARY KEY, "threadId" TEXT, seq INTEGER);
        CREATE TABLE events (id TEXT PRIMARY KEY, "threadId" TEXT, seq INTEGER);
        CREATE TABLE runs (id TEXT PRIMARY KEY, "threadId" TEXT);
        CREATE TABLE routines (id TEXT PRIMARY KEY);
        CREATE TABLE artifacts (id TEXT PRIMARY KEY, "botId" TEXT, "groupId" TEXT);
        INSERT INTO threads VALUES ('thread', 'bot', 42);
        INSERT INTO messages VALUES ('message', 'thread', 41);
        INSERT INTO events VALUES ('event', 'thread', 99);
        INSERT INTO runs VALUES ('run', 'thread');
        INSERT INTO artifacts VALUES ('artifact', 'bot', NULL);
      `);
      await client.query(
        readFileSync(
          new URL(
            "../prisma/migrations/20261115000000_checkpoints_v1/migration.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(
        (
          await client.query(
            'SELECT "activeBranchId", "nextMessageSeq", "checkpointGeneration" FROM threads',
          )
        ).rows,
      ).toEqual([
        { activeBranchId: "initial:thread", nextMessageSeq: 42, checkpointGeneration: 0 },
      ]);
      expect((await client.query('SELECT id, seq, "branchId" FROM messages')).rows).toEqual([
        { id: "message", seq: 41, branchId: "initial:thread" },
      ]);
      expect(
        (await client.query('SELECT "branchId", "checkpointHidden" FROM artifacts')).rows,
      ).toEqual([{ branchId: "initial:thread", checkpointHidden: false }]);
      expect(
        (await client.query('SELECT "branchId", "checkpointGeneration" FROM runs')).rows,
      ).toEqual([{ branchId: "initial:thread", checkpointGeneration: 0 }]);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
      await pool.end();
    }
  });
});
