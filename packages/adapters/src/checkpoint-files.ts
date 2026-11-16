import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDeflate, createInflate } from "node:zlib";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { z } from "zod";
import { mappedHome } from "./team-storage.js";

const helper = readFileSync(new URL("./checkpoint-files.py", import.meta.url), "utf8");
const CHUNK = 48 * 1024;
const READ_CHUNK = 512 * 1024;
const MAGIC = Buffer.from("RKCZ1\0");
const ALREADY_COMPRESSED = new Set([
  ".xlsx",
  ".xlsm",
  ".docx",
  ".pptx",
  ".pdf",
  ".zip",
  ".gz",
  ".7z",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp4",
]);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const relative = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
const entry = z.discriminatedUnion("type", [
  z
    .object({
      path: relative,
      type: z.literal("directory"),
      mode: z.number().int().min(0).max(0o777),
    })
    .strict(),
  z
    .object({
      path: relative,
      type: z.literal("file"),
      mode: z.number().int().min(0).max(0o777),
      size: z.number().int().min(0).safe(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
const legacyManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(entry),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const teamRootSchema = z.string().regex(/^bots\/[A-Za-z0-9_-]{1,160}$/);
const teamRootsSchema = z.tuple([teamRootSchema]);
const teamManifestSchema = z
  .object({
    version: z.literal(2),
    roots: teamRootsSchema,
    entries: z.array(entry),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z.discriminatedUnion("version", [legacyManifestSchema, teamManifestSchema]);
export type CheckpointFileManifest = z.infer<typeof manifestSchema>;
export type CheckpointFileScope = "dedicated" | "team";

export function parseCheckpointFileManifest(raw: unknown): CheckpointFileManifest {
  const manifest = manifestSchema.parse(raw);
  const names = new Map(manifest.entries.map((item) => [item.path, item.type]));
  if (
    names.size !== manifest.entries.length ||
    manifest.digest !==
      sha256(
        JSON.stringify(
          manifest.version === 1
            ? manifest.entries
            : { roots: manifest.roots, entries: manifest.entries },
        ),
      )
  )
    throw new Error("Invalid checkpoint manifest");
  for (const item of manifest.entries) {
    if (
      manifest.version === 2 &&
      !manifest.roots.some((root) => item.path === root || item.path.startsWith(`${root}/`))
    )
      throw new Error("Checkpoint entry is outside the Team workspace");
    if (
      manifest.version === 2 &&
      manifest.roots.includes(item.path as (typeof manifest.roots)[number]) &&
      item.type !== "directory"
    )
      throw new Error("Checkpoint roots must be directories");
    const parts = item.path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const parent = parts.slice(0, length).join("/");
      if (
        names.get(parent) !== "directory" &&
        !(manifest.version === 2 && manifest.roots.some((root) => root.startsWith(`${parent}/`)))
      )
        throw new Error("Invalid checkpoint parent directory");
    }
  }
  return manifest;
}

/** The API owns this pool; its dataDir must not be mounted into the Agent sandbox. */
export class CheckpointFiles {
  constructor(private readonly deps: { sandbox: SandboxProvider; dataDir: string }) {}

  private async direct(
    actor: Actor,
    botId: string,
    computer: ComputerRef,
    input: Record<string, unknown>,
    scope: CheckpointFileScope,
  ) {
    if (process.env.CHECKPOINT_DIRECT_DOCKER !== "1" || computer.kind !== "docker") return null;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(computer.botId)) throw new Error("Invalid home identity");
    const home = mappedHome(path.resolve(this.deps.dataDir), computer.botId);
    const workspace = scope === "team" ? home : path.join(home, "workspace");
    for (const component of [home, workspace]) {
      const info = await lstat(component);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Invalid checkpoint workspace");
    }
    const pool = await this.directory(actor, botId);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(
        "python3",
        [
          "-I",
          fileURLToPath(new URL("./checkpoint-files.py", import.meta.url)),
          "--direct",
          workspace,
          pool,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          const value = JSON.parse(stdout);
          if (code !== 0 || value.error)
            throw new Error(value.error || stderr || "Checkpoint transfer failed");
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(input));
    });
  }

  private async directory(actor: Actor, botId: string) {
    for (const identity of [actor.userId, botId]) {
      if (
        !/^[A-Za-z0-9_-]{1,160}$/.test(identity) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(identity)
      )
        throw new Error("Invalid checkpoint storage identity");
    }
    const base = path.resolve(this.deps.dataDir, "checkpoint-blobs");
    const scope = sha256(JSON.stringify([actor.spaceId, actor.userId, botId]));
    const user = path.join(base, actor.userId);
    const directory = path.join(user, botId);
    const legacy = path.join(base, scope);
    const inspect = async (folder: string) => {
      try {
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Invalid checkpoint blob storage");
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    };
    await mkdir(base, { recursive: true, mode: 0o700 });
    await inspect(base);
    await mkdir(user, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await inspect(user);
    const oldExists = await inspect(legacy);
    const exists = await inspect(directory);
    if (oldExists && exists && (await inspect(legacy)))
      throw new Error("Legacy and user-bot checkpoint pools both exist; merge them before use");

    // The readable user/bot path still belongs to one Space. Keep its binding outside
    // the blob pool so the helper only encounters content-addressed files.
    const binding = path.join(user, `.${botId}.scope`);
    try {
      const handle = await open(binding, "wx", 0o600);
      try {
        await handle.writeFile(`${scope}\n`);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    for (let attempt = 0; ; attempt++) {
      const info = await lstat(binding);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("Invalid checkpoint storage binding");
      // A concurrent first writer may have opened the exclusive file but not written yet.
      if (info.size === 0 && attempt < 20) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (info.size !== 65 || (await readFile(binding, "utf8")) !== `${scope}\n`)
        throw new Error("Checkpoint storage belongs to a different Space");
      break;
    }
    if (oldExists) {
      try {
        await rename(legacy, directory);
      } catch (error) {
        // Another operation for this same scope may have completed the rename.
        if ((await inspect(legacy)) || !(await inspect(directory))) throw error;
      }
    } else if (!exists) {
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    if (!(await inspect(directory))) throw new Error("Checkpoint blob storage is missing");
    return directory;
  }

  private roots(botId: string, scope: CheckpointFileScope): [string] | undefined {
    if (scope !== "team") return undefined;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(botId)) throw new Error("Invalid Team bot identity");
    return [`bots/${botId}`];
  }

  private manifest(entries: z.infer<typeof entry>[], roots?: [string]): CheckpointFileManifest {
    return parseCheckpointFileManifest(
      roots
        ? { version: 2, roots, entries, digest: sha256(JSON.stringify({ roots, entries })) }
        : { version: 1, entries, digest: sha256(JSON.stringify(entries)) },
    );
  }

  private async execute(
    actor: Actor,
    botId: string,
    computer: ComputerRef,
    input: Record<string, unknown>,
    scope: CheckpointFileScope = "dedicated",
  ) {
    const encoded = Buffer.from(
      JSON.stringify({ ...input, roots: this.roots(botId, scope) }),
    ).toString("base64");
    if (encoded.length > 110000) throw new Error("Checkpoint request exceeds transfer limit");
    let stdout = "";
    let code: number | undefined;
    for await (const event of this.deps.sandbox.execute(
      computer,
      {
        argv: ["/opt/office-python/bin/python3", "-I", "-c", helper, encoded],
        cwd: "/home/rakazo",
        timeoutMs: 120000,
        unsetEnv: ["PYTHONPATH", "PYTHONHOME", "LD_PRELOAD"],
      },
      {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        operationId: randomUUID(),
        traceId: "checkpoint-files",
        signal: AbortSignal.timeout(125000),
      },
    )) {
      if (event.type === "stdout") {
        stdout += event.data;
      }
      if (event.type === "exit") code = event.code;
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new Error("Incomplete checkpoint helper response");
    }
    if (code !== 0 || value.error)
      throw new Error(typeof value.error === "string" ? value.error : "Checkpoint transfer failed");
    return value;
  }

  async capture(
    actor: Actor,
    botId: string,
    computer: ComputerRef,
    scope: CheckpointFileScope = "dedicated",
  ): Promise<CheckpointFileManifest> {
    const roots = this.roots(botId, scope);
    const direct = await this.direct(
      actor,
      botId,
      computer,
      {
        operation: "capture",
        roots,
      },
      scope,
    );
    if (direct) {
      const entries = z.array(entry).parse(direct.entries);
      return this.manifest(entries, roots);
    }
    const directory = await this.directory(actor, botId);
    const inventory = await this.execute(actor, botId, computer, { operation: "inventory" }, scope);
    const entries = z.array(entry).parse(inventory.entries);
    const manifest = this.manifest(entries, roots);
    const files = [
      ...new Map(
        entries.filter((item) => item.type === "file").map((item) => [item.sha256, item]),
      ).values(),
    ];
    let next = 0;
    let failure: unknown;
    const captureFile = async (item: (typeof files)[number]) => {
      const file = path.join(directory, item.sha256);
      try {
        await this.verifyBlob(file, item.sha256, item.size);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = path.join(directory, `.tmp-${randomUUID()}`);
      const self = this;
      const current = item;
      async function* source() {
        const hash = createHash("sha256");
        for (let offset = 0; offset < current.size; offset += READ_CHUNK) {
          const result = await self.execute(
            actor,
            botId,
            computer,
            {
              operation: "read",
              path: current.path,
              offset,
            },
            scope,
          );
          const chunk = self.decode(result.data);
          if (chunk.length !== Math.min(READ_CHUNK, current.size - offset))
            throw new Error("Workspace changed during checkpoint");
          hash.update(chunk);
          yield chunk;
        }
        if (hash.digest("hex") !== current.sha256)
          throw new Error("Workspace changed during checkpoint");
      }
      const compress = !ALREADY_COMPRESSED.has(path.extname(item.path).toLowerCase());
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          if (compress) await handle.writeFile(MAGIC);
        } finally {
          await handle.close();
        }
        const destination = createWriteStream(temporary, { flags: "a" });
        if (compress)
          await pipeline(Readable.from(source()), createDeflate({ level: 1 }), destination);
        else await pipeline(Readable.from(source()), destination);
        try {
          await link(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await this.verifyBlob(file, item.sha256, item.size);
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(16, files.length) }, async () => {
        while (!failure && next < files.length) {
          const item = files[next++]!;
          try {
            await captureFile(item);
          } catch (error) {
            failure = error;
          }
        }
      }),
    );
    if (failure) throw failure;
    const after = await this.execute(actor, botId, computer, { operation: "inventory" }, scope);
    if (JSON.stringify(after.entries) !== JSON.stringify(entries))
      throw new Error("Workspace changed during checkpoint");
    return manifest;
  }

  private decode(value: unknown) {
    if (
      typeof value !== "string" ||
      value.length > 4 * Math.ceil(READ_CHUNK / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      throw new Error("Invalid checkpoint transfer");
    return Buffer.from(value, "base64");
  }

  private async *blob(file: string, hash: string, size: number): AsyncGenerator<Buffer> {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Invalid checkpoint blob");
    const handle = await open(file, "r");
    const header = Buffer.alloc(MAGIC.length);
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    let compressed = header.equals(MAGIC);
    // Legacy raw blobs may themselves start with the magic bytes.
    if (compressed && info.size === size) {
      const rawHash = createHash("sha256");
      for await (const part of createReadStream(file)) rawHash.update(part);
      if (rawHash.digest("hex") === hash) compressed = false;
    }
    const input = createReadStream(file, compressed ? { start: MAGIC.length } : {});
    const stream = compressed ? input.pipe(createInflate()) : input;
    const digest = createHash("sha256");
    let count = 0;
    try {
      for await (const value of stream) {
        const bytes = Buffer.from(value as Buffer);
        count += bytes.length;
        if (count > size) throw new Error("Checkpoint blob integrity check failed");
        digest.update(bytes);
        yield bytes;
      }
      if (count !== size || digest.digest("hex") !== hash)
        throw new Error("Checkpoint blob integrity check failed");
    } catch {
      throw new Error("Checkpoint blob integrity check failed");
    } finally {
      input.destroy();
      stream.destroy();
    }
  }

  private async verifyBlob(file: string, hash: string, size: number) {
    for await (const _chunk of this.blob(file, hash, size)) {
      /* verify before restore */
    }
  }

  /** Caller must first persist a rescue checkpoint and stop/fence all workspace writers. */
  async restore(
    actor: Actor,
    botId: string,
    computer: ComputerRef,
    raw: unknown,
    scope: CheckpointFileScope = "dedicated",
  ): Promise<void> {
    const manifest = parseCheckpointFileManifest(raw);
    const roots = this.roots(botId, scope);
    if (
      scope === "team"
        ? manifest.version !== 2 || manifest.roots[0] !== roots![0]
        : manifest.version !== 1
    )
      throw new Error("Checkpoint belongs to a different workspace scope");
    const direct = await this.direct(
      actor,
      botId,
      computer,
      {
        operation: "restore",
        entries: manifest.entries,
        roots,
      },
      scope,
    );
    if (direct) return;
    const directory = await this.directory(actor, botId);
    // Verify all blobs before clearing; verify again while restoring without buffering files.
    const blobs = new Set<string>();
    for (const item of manifest.entries) {
      if (item.type === "file" && !blobs.has(item.sha256)) {
        await this.verifyBlob(path.join(directory, item.sha256), item.sha256, item.size);
        blobs.add(item.sha256);
      }
    }
    const cleared = await this.execute(actor, botId, computer, { operation: "clear" }, scope);
    const preservedDirectories = z.array(entry).parse(cleared.preservedDirectories);
    if (preservedDirectories.some((item) => item.type !== "directory"))
      throw new Error("Workspace changed during checkpoint restore");
    const directories = manifest.entries
      .filter((item) => item.type === "directory")
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    for (const item of directories)
      await this.execute(
        actor,
        botId,
        computer,
        { operation: "directory", path: item.path },
        scope,
      );
    const restoreFiles = manifest.entries.filter((item) => item.type === "file");
    const restoreFile = async (item: (typeof restoreFiles)[number]) => {
      await this.execute(actor, botId, computer, { operation: "begin", path: item.path }, scope);
      let offset = 0;
      for await (const bytes of this.blob(
        path.join(directory, item.sha256),
        item.sha256,
        item.size,
      )) {
        for (let start = 0; start < bytes.length; start += CHUNK) {
          const chunk = bytes.subarray(start, start + CHUNK);
          await this.execute(
            actor,
            botId,
            computer,
            {
              operation: "write",
              path: item.path,
              offset,
              data: chunk.toString("base64"),
            },
            scope,
          );
          offset += chunk.length;
        }
      }
      await this.execute(
        actor,
        botId,
        computer,
        {
          operation: "mode",
          path: item.path,
          mode: item.mode,
        },
        scope,
      );
    };
    let nextRestore = 0;
    let restoreFailure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(16, restoreFiles.length) }, async () => {
        while (!restoreFailure && nextRestore < restoreFiles.length) {
          const item = restoreFiles[nextRestore++]!;
          try {
            await restoreFile(item);
          } catch (error) {
            restoreFailure = error;
          }
        }
      }),
    );
    if (restoreFailure) throw restoreFailure;
    // Keep directories writable until their children have been restored.
    for (const item of directories.reverse())
      await this.execute(
        actor,
        botId,
        computer,
        {
          operation: "mode",
          path: item.path,
          mode: item.mode,
        },
        scope,
      );
    const after = await this.execute(actor, botId, computer, { operation: "inventory" }, scope);
    const targetPaths = new Set(manifest.entries.map((item) => item.path));
    const preserved = new Map(
      preservedDirectories
        .filter((item) => !targetPaths.has(item.path))
        .map((item) => [item.path, item]),
    );
    const actual = z.array(entry).parse(after.entries);
    const actualPreserved = actual.filter((item) => preserved.has(item.path));
    if (
      actualPreserved.length !== preserved.size ||
      actualPreserved.some(
        (item) => JSON.stringify(item) !== JSON.stringify(preserved.get(item.path)),
      ) ||
      JSON.stringify(actual.filter((item) => !preserved.has(item.path))) !==
        JSON.stringify(manifest.entries)
    )
      throw new Error("Restored workspace verification failed");
  }
}
