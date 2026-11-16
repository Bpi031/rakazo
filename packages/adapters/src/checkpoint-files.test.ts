import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CheckpointFiles } from "./checkpoint-files.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "test@example.invalid",
  isDeploymentOwner: false,
};
const computer = {
  id: "computer",
  botId: "bot",
  kind: "docker",
  providerRef: "container",
} as const;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
  temporary.length = 0;
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-files-"));
  temporary.push(directory);
  const files = new Map<string, Buffer>([
    ["input.xlsx", Buffer.from([0, 1, 2, 255])],
    ["case/policy.rost", Buffer.from("rule A")],
  ]);
  const modes = new Map<string, number>([
    ["input.xlsx", 0o600],
    ["case", 0o750],
    ["case/policy.rost", 0o640],
    ["empty", 0o700],
  ]);
  const directories = new Set(["case", "empty"]);
  const caches = new Map<string, Buffer>();
  const pending = new Map<string, Buffer[]>();
  const inventory = () =>
    [...directories]
      .map((name) => ({ path: name, type: "directory", mode: modes.get(name) ?? 0o700 }))
      .concat(
        [...files].map(([name, bytes]) => ({
          path: name,
          type: "file",
          mode: modes.get(name) ?? 0o600,
          size: bytes.length,
          sha256: hash(bytes),
        })) as any,
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const execute = vi.fn(async function* (_computer, request) {
    const input = JSON.parse(Buffer.from(request.argv.at(-1), "base64").toString());
    let value: any = {};
    switch (input.operation) {
      case "inventory":
        value = { entries: inventory() };
        break;
      case "read":
        value = {
          data: files
            .get(input.path)!
            .subarray(input.offset, input.offset + 512 * 1024)
            .toString("base64"),
        };
        break;
      case "clear": {
        const preserved = [...directories].filter((name) =>
          [...caches.keys()].some((cache) => cache.startsWith(`${name}/`)),
        );
        files.clear();
        directories.clear();
        for (const name of modes.keys()) if (!preserved.includes(name)) modes.delete(name);
        for (const name of preserved) directories.add(name);
        value = { preservedDirectories: inventory() };
        break;
      }
      case "directory":
        directories.add(input.path);
        modes.set(input.path, 0o700);
        break;
      case "begin":
        files.set(input.path, Buffer.alloc(0));
        pending.set(input.path, []);
        modes.set(input.path, 0o600);
        break;
      case "write":
        pending.get(input.path)!.push(Buffer.from(input.data, "base64"));
        break;
      case "mode":
        if (pending.has(input.path)) {
          files.set(input.path, Buffer.concat(pending.get(input.path)!));
          pending.delete(input.path);
        }
        modes.set(input.path, input.mode);
        break;
      default:
        throw new Error("Unexpected operation");
    }
    yield { type: "stdout", data: JSON.stringify(value) };
    yield { type: "exit", code: 0 };
  });
  const service = new CheckpointFiles({ sandbox: { execute } as any, dataDir: directory });
  return { directory, service, execute, files, directories, modes, inventory, caches };
}

it("restores binary files, modes and empty directories and removes later files", async () => {
  const state = await fixture();
  const before = state.inventory();
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.files.set("input.xlsx", Buffer.from("wrong"));
  state.files.delete("case/policy.rost");
  state.files.set("wrong.xlsx", Buffer.from("wrong"));
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.inventory()).toEqual(before);
});

it("deduplicates unchanged bytes and keeps scope separate", async () => {
  const state = await fixture();
  const first = await state.service.capture(actor, "bot", computer);
  state.execute.mockClear();
  const second = await state.service.capture(actor, "bot", computer);
  expect(first).toEqual(second);
  const calls = state.execute.mock.calls.map(
    (call) => JSON.parse(Buffer.from(call[1].argv.at(-1), "base64").toString()).operation,
  );
  expect(calls).toEqual(["inventory", "inventory"]);
  await state.service.capture({ ...actor, userId: "other-owner" }, "bot", computer);
  await state.service.capture(actor, "other-bot", computer);
  expect(await readdir(path.join(state.directory, "checkpoint-blobs"))).toEqual([
    "other-owner",
    "owner",
  ]);
  expect(
    await readdir(path.join(state.directory, "checkpoint-blobs", "owner", "bot")),
  ).toHaveLength(2);
  expect(
    await readdir(path.join(state.directory, "checkpoint-blobs", "owner", "other-bot")),
  ).toHaveLength(2);
});

it("keeps a user-bot pool bound to its original Space", async () => {
  const state = await fixture();
  await state.service.capture(actor, "bot", computer);
  const binding = path.join(state.directory, "checkpoint-blobs", "owner", ".bot.scope");
  const before = await readFile(binding);
  state.execute.mockClear();
  await expect(
    state.service.capture({ ...actor, spaceId: "other" }, "bot", computer),
  ).rejects.toThrow("different Space");
  expect(await readFile(binding)).toEqual(before);
  expect(state.execute).not.toHaveBeenCalled();
});

it("relocates legacy pools without copying blobs and restores their saved manifest", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  const base = path.join(state.directory, "checkpoint-blobs");
  const pool = path.join(base, "owner", "bot");
  const legacy = path.join(base, hash(JSON.stringify([actor.spaceId, actor.userId, "bot"])));
  const first = snapshot.entries.find((item) => item.type === "file")!;
  if (first.type !== "file") throw new Error("Missing fixture file");
  const before = await lstat(path.join(pool, first.sha256));
  await rename(pool, legacy);
  await unlink(path.join(base, "owner", ".bot.scope"));
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.inventory()).toEqual(snapshot.entries);
  await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  const after = await lstat(path.join(pool, first.sha256));
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.nlink).toBe(1);
  expect(await readdir(pool)).toHaveLength(2);
});

it("refuses coexisting legacy and new pools without changing either", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  const base = path.join(state.directory, "checkpoint-blobs");
  const pool = path.join(base, "owner", "bot");
  const legacy = path.join(base, hash(JSON.stringify([actor.spaceId, actor.userId, "bot"])));
  await mkdir(legacy);
  const sentinel = hash("legacy-only");
  await writeFile(path.join(legacy, sentinel), "legacy-only");
  const originals = await Promise.all(
    (await readdir(pool)).map((name) => readFile(path.join(pool, name))),
  );
  state.execute.mockClear();
  await expect(state.service.restore(actor, "bot", computer, snapshot)).rejects.toThrow(
    "both exist",
  );
  expect(await readFile(path.join(legacy, sentinel), "utf8")).toBe("legacy-only");
  expect(
    await Promise.all((await readdir(pool)).map((name) => readFile(path.join(pool, name)))),
  ).toEqual(originals);
  expect(state.execute).not.toHaveBeenCalled();
});

it("shares exclusive Space binding safely across concurrent first captures", async () => {
  const state = await fixture();
  const snapshots = await Promise.all([
    state.service.capture(actor, "bot", computer),
    state.service.capture(actor, "bot", computer),
  ]);
  expect(snapshots[0]).toEqual(snapshots[1]);
  expect(
    await readdir(path.join(state.directory, "checkpoint-blobs", "owner", "bot")),
  ).toHaveLength(2);
});

it("handles concurrent operations relocating the same legacy pool", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  const base = path.join(state.directory, "checkpoint-blobs");
  const pool = path.join(base, "owner", "bot");
  const legacy = path.join(base, hash(JSON.stringify([actor.spaceId, actor.userId, "bot"])));
  await rename(pool, legacy);
  await unlink(path.join(base, "owner", ".bot.scope"));
  const captures = await Promise.all([
    state.service.capture(actor, "bot", computer),
    state.service.capture(actor, "bot", computer),
  ]);
  expect(captures).toEqual([snapshot, snapshot]);
  await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(pool)).toHaveLength(2);
});

it.each([
  ["user", "../outside"],
  ["user", "owner/child"],
  ["user", "CON"],
  ["bot", "..\\outside"],
  ["bot", "/absolute"],
  ["bot", ""],
])("rejects an invalid %s storage identity: %s", async (field, value) => {
  const state = await fixture();
  await expect(
    state.service.capture(
      field === "user" ? { ...actor, userId: value } : actor,
      field === "bot" ? value : "bot",
      computer,
    ),
  ).rejects.toThrow("storage identity");
  expect(state.execute).not.toHaveBeenCalled();
});

it.each(["base", "user", "bot", "legacy"])(
  "rejects a symlink at the %s directory",
  async (component) => {
    const state = await fixture();
    const base = path.join(state.directory, "checkpoint-blobs");
    const user = path.join(base, "owner");
    const outside = path.join(state.directory, "outside");
    await mkdir(outside);
    const target =
      component === "base"
        ? base
        : component === "user"
          ? user
          : component === "bot"
            ? path.join(user, "bot")
            : path.join(base, hash(JSON.stringify([actor.spaceId, actor.userId, "bot"])));
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    await expect(state.service.capture(actor, "bot", computer)).rejects.toThrow("blob storage");
    expect(await readdir(outside)).toEqual([]);
    expect(state.execute).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === "win32")("rejects a symlinked Space binding", async () => {
  const state = await fixture();
  const user = path.join(state.directory, "checkpoint-blobs", "owner");
  await mkdir(user, { recursive: true });
  const outside = path.join(state.directory, "outside");
  await writeFile(outside, `${hash(JSON.stringify([actor.spaceId, actor.userId, "bot"]))}\n`);
  await symlink(outside, path.join(user, ".bot.scope"));
  await expect(state.service.capture(actor, "bot", computer)).rejects.toThrow("storage binding");
  expect(state.execute).not.toHaveBeenCalled();
});

it("preserves newly created cache ancestors without treating them as restored business files", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.directories.add("project");
  state.directories.add("project/tooling");
  state.modes.set("project", 0o750);
  state.modes.set("project/tooling", 0o710);
  state.caches.set("project/tooling/node_modules/dependency", Buffer.from("keep cache"));
  state.files.set("project/failed-model.json", Buffer.from("discard failed model"));
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.files.has("project/failed-model.json")).toBe(false);
  expect(state.caches.get("project/tooling/node_modules/dependency")).toEqual(
    Buffer.from("keep cache"),
  );
  expect(state.modes.get("project")).toBe(0o750);
  expect(state.modes.get("project/tooling")).toBe(0o710);
  expect(state.inventory().filter((item) => !item.path.startsWith("project"))).toEqual(
    snapshot.entries,
  );
});

it.each(["file", "directory", "target-mode", "cache-ancestor-mode"])(
  "still rejects unexpected %s changes after restoring around preserved caches",
  async (change) => {
    const state = await fixture();
    const snapshot = await state.service.capture(actor, "bot", computer);
    state.directories.add("project");
    state.caches.set("project/node_modules/dependency", Buffer.from("keep cache"));
    const original = state.execute.getMockImplementation()!;
    let cleared = false;
    state.execute.mockImplementation(async function* (computer, request) {
      const input = JSON.parse(Buffer.from(request.argv.at(-1), "base64").toString());
      if (cleared && input.operation === "inventory") {
        if (change === "file") state.files.set("project/unexpected.log", Buffer.from("unexpected"));
        if (change === "directory") state.directories.add("unexpected");
        if (change === "target-mode") state.modes.set("input.xlsx", 0o777);
        if (change === "cache-ancestor-mode") state.modes.set("project", 0o777);
      }
      yield* original(computer, request);
      if (input.operation === "clear") cleared = true;
    });
    await expect(state.service.restore(actor, "bot", computer, snapshot)).rejects.toThrow(
      "Restored workspace verification failed",
    );
  },
);

it("captures identical files once and restores every path", async () => {
  const state = await fixture();
  state.files.set("copy-a.txt", Buffer.from("same content"));
  state.files.set("copy-b.txt", Buffer.from("same content"));
  const snapshot = await state.service.capture(actor, "bot", computer);
  const reads = state.execute.mock.calls
    .map((call) => JSON.parse(Buffer.from(call[1].argv.at(-1), "base64").toString()))
    .filter((input) => input.operation === "read" && input.path.startsWith("copy-"));
  expect(reads).toHaveLength(1);
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.files.get("copy-a.txt")).toEqual(Buffer.from("same content"));
  expect(state.files.get("copy-b.txt")).toEqual(Buffer.from("same content"));
});

it("verifies every blob before clearing the active workspace", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  const file = snapshot.entries.find((item) => item.type === "file")!;
  if (file.type !== "file") throw new Error("Missing fixture file");
  const blob = path.join(state.directory, "checkpoint-blobs", "owner", "bot", file.sha256);
  await writeFile(blob, Buffer.alloc((await readFile(blob)).length, 42));
  state.execute.mockClear();
  const before = state.inventory();
  await expect(state.service.restore(actor, "bot", computer, snapshot)).rejects.toThrow(
    "integrity",
  );
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.inventory()).toEqual(before);
});

it("rejects traversal and missing parent manifests before executing the helper", async () => {
  const state = await fixture();
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.execute.mockClear();
  const entries = [{ path: "../outside", type: "directory", mode: 0o700 }];
  await expect(
    state.service.restore(actor, "bot", computer, {
      ...snapshot,
      entries,
      digest: hash(JSON.stringify(entries)),
    }),
  ).rejects.toThrow();
  const missing = [{ path: "missing/child", type: "directory", mode: 0o700 }];
  await expect(
    state.service.restore(actor, "bot", computer, {
      ...snapshot,
      entries: missing,
      digest: hash(JSON.stringify(missing)),
    }),
  ).rejects.toThrow("parent");
  expect(state.execute).not.toHaveBeenCalled();
});

it("rejects source changes between inventory and capture", async () => {
  const state = await fixture();
  const original = state.execute.getMockImplementation()!;
  let calls = 0;
  state.execute.mockImplementation(async function* (computer, request) {
    calls++;
    if (calls === 2) state.files.set("case/policy.rost", Buffer.from("changed"));
    yield* original(computer, request);
  });
  await expect(state.service.capture(actor, "bot", computer)).rejects.toThrow("changed");
});

it("transfers files beyond one argument-sized chunk without truncation", async () => {
  const state = await fixture();
  const bytes = Buffer.alloc(150000, 57);
  state.files.set("large.xlsx", bytes);
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.files.get("large.xlsx")).toEqual(bytes);
  expect(state.execute.mock.calls.every((call) => call[1].argv.at(-1).length < 110000)).toBe(true);
});

it("compresses text and preserves already-compressed formats", async () => {
  const state = await fixture();
  const text = Buffer.from("rost model rows and rules\n".repeat(20000));
  state.files.set("model.json", text);
  state.files.set("spreadsheet.xlsm", Buffer.from("spreadsheet archive"));
  const snapshot = await state.service.capture(actor, "bot", computer);
  const folder = path.join(state.directory, "checkpoint-blobs", "owner", "bot");
  const compressed = await readFile(path.join(folder, hash(text)));
  expect(compressed.subarray(0, 6).toString("binary")).toBe("RKCZ1\0");
  expect(compressed.length).toBeLessThan(text.length / 5);
  expect(await readFile(path.join(folder, hash("spreadsheet archive")))).toEqual(
    Buffer.from("spreadsheet archive"),
  );
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.files.get("model.json")).toEqual(text);
});

it("reads legacy uncompressed blobs including raw magic prefix", async () => {
  const state = await fixture();
  const original = Buffer.from("RKCZ1\0legacy data");
  state.files.set("legacy.xlsx", original);
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(state.files.get("legacy.xlsx")).toEqual(original);
});

it("captures and restores a file above the previous 64 MiB limit", async () => {
  const state = await fixture();
  const bytes = Buffer.alloc(65 * 1024 * 1024, 97);
  state.files.set("model.json", bytes);
  const snapshot = await state.service.capture(actor, "bot", computer);
  state.files.clear();
  await state.service.restore(actor, "bot", computer, snapshot);
  expect(hash(state.files.get("model.json")!)).toBe(hash(bytes));
}, 60000);

it("accepts more than 2000 manifest entries", async () => {
  const state = await fixture();
  for (let i = 0; i < 2100; i++) state.directories.add(`folder-${i}`);
  const snapshot = await state.service.capture(actor, "bot", computer);
  expect(snapshot.entries.length).toBeGreaterThan(2000);
});

it("accepts a manifest above the previous 256 MiB total limit", async () => {
  const state = await fixture();
  const entries = Array.from({ length: 5 }, (_, i) => ({
    path: `file-${i}.json`,
    type: "file" as const,
    mode: 0o600,
    size: 65 * 1024 * 1024,
    sha256: "a".repeat(64),
  }));
  await expect(
    state.service.restore(actor, "bot", computer, {
      version: 1,
      entries,
      digest: hash(JSON.stringify(entries)),
    }),
  ).rejects.toThrow(/ENOENT/);
  expect(state.execute).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
  "uses direct Docker storage to capture and restore without sandbox processes",
  async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "checkpoint-direct-"));
    temporary.push(dataDir);
    const workspace = path.join(dataDir, "homes", "bot", "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "model.json"), "rules\n".repeat(10000));
    const execute = vi.fn();
    const service = new CheckpointFiles({ sandbox: { execute } as any, dataDir });
    const prior = process.env.CHECKPOINT_DIRECT_DOCKER;
    process.env.CHECKPOINT_DIRECT_DOCKER = "1";
    try {
      const first = await service.capture(actor, "bot", computer);
      const cache = path.join(workspace, "project", "tooling", "node_modules", "dependency");
      await mkdir(path.dirname(cache), { recursive: true });
      await writeFile(cache, "keep cache");
      await writeFile(path.join(workspace, "model.json"), "changed");
      await service.restore(actor, "bot", computer, first);
      expect(await readFile(path.join(workspace, "model.json"), "utf8")).toBe(
        "rules\n".repeat(10000),
      );
      expect(await readFile(cache, "utf8")).toBe("keep cache");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.CHECKPOINT_DIRECT_DOCKER;
      else process.env.CHECKPOINT_DIRECT_DOCKER = prior;
    }
  },
);
