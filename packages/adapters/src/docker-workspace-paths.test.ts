import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "./docker-sandbox.js";

const computer = { id: "computer", botId: "bot", kind: "docker" as const, providerRef: "computer" };
const context = { operationId: "path-test", traceId: "path-test", spaceId: "space",
  userId: "user", botId: "bot", signal: new AbortController().signal };
const relative = "workspace/roster-case/DEPLOY_CASE.md";
const absolute = `/home/rakazo/${relative}`;

describe("Docker absolute-home file aliases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads absolute and relative paths through the same protected file endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ content: Buffer.from("case notes").toString("base64") }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    for (const path of [absolute, relative]) {
      expect(new TextDecoder().decode(await provider.readFile(computer, path, context, { maxBytes: 4096 }))).toBe("case notes");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => new URL(String((call as unknown[])[0])));
    expect(urls[0]?.href).toBe(urls[1]?.href);
    expect(urls[0]?.searchParams.get("path")).toBe(relative);
    expect(urls[0]?.searchParams.get("maxBytes")).toBe("4096");
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: {
      "x-rakazo-bot-id": "bot", "x-rakazo-space-id": "space", authorization: "Bearer test-token",
    } });
  });

  it("uses the same alias for listing and writing without changing payloads", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.listFiles(computer, "/home/rakazo/workspace/roster-case", context);
    expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("path"))
      .toBe("workspace/roster-case");
    await provider.writeFile(computer, { path: absolute, content: new TextEncoder().encode("notes"), executable: false }, context);
    const init = (fetchMock.mock.calls[1] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ path: relative,
      content: Buffer.from("notes").toString("base64"), executable: false });
  });

  it("rejects traversal before issuing any file request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    for (const path of ["/home/rakazo/../secret", "workspace/../../secret", "a\0b"]) {
      await expect(provider.readFile(computer, path, context)).rejects.toThrow();
      await expect(provider.listFiles(computer, path, context)).rejects.toThrow();
      await expect(provider.writeFile(computer, { path, content: new Uint8Array() }, context)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
