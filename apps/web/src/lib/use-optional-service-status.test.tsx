// @vitest-environment jsdom

import type { SpaceMemoryConfig, VoiceStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({
  rpc: { memory: { providerConfig: vi.fn() }, voice: { status: vi.fn() } },
}));

import { rpc } from "./rpc";
import { useOptionalServiceStatus } from "./use-optional-service-status";

const revision = { current: 0 };
const setMemory = vi.fn();
const setVoice = vi.fn();
const mounted: Array<() => void> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Probe({ managed }: { managed?: boolean }) {
  useOptionalServiceStatus(managed, revision, setMemory, setVoice);
  return null;
}
async function render(managed?: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(() => {
    root.unmount();
    container.remove();
  });
  const update = async (value?: boolean) => {
    await act(async () => root.render(<Probe managed={value} />));
  };
  await update(managed);
  return update;
}
afterEach(async () => {
  await act(async () => {
    for (const stop of mounted.splice(0)) stop();
  });
  vi.resetAllMocks();
  revision.current = 0;
});
it("does not call operator-only endpoints before bootstrap or in managed mode", async () => {
  const update = await render();
  await update(true);
  expect(rpc.memory.providerConfig).not.toHaveBeenCalled();
  expect(rpc.voice.status).not.toHaveBeenCalled();
  expect(setMemory).toHaveBeenLastCalledWith(null);
  expect(setVoice).toHaveBeenLastCalledWith(null);
});
it("keeps optional services working in unmanaged deployments", async () => {
  vi.mocked(rpc.memory.providerConfig).mockResolvedValue(null);
  vi.mocked(rpc.voice.status).mockResolvedValue(null as unknown as VoiceStatus);
  const update = await render();
  await update(false);
  await update(false);
  expect(rpc.memory.providerConfig).toHaveBeenCalledTimes(1);
  expect(rpc.voice.status).toHaveBeenCalledTimes(1);
});
it.each(["managed", "revision", "unmount"])(
  "ignores late optional configuration after %s",
  async (reason) => {
    const memory = deferred<SpaceMemoryConfig | null>();
    const voice = deferred<VoiceStatus>();
    vi.mocked(rpc.memory.providerConfig).mockImplementation(() => memory.promise);
    vi.mocked(rpc.voice.status).mockImplementation(() => voice.promise);
    const update = await render(false);
    if (reason === "managed") await update(true);
    if (reason === "revision") revision.current += 1;
    if (reason === "unmount") await act(async () => mounted.pop()?.());
    setMemory.mockClear();
    setVoice.mockClear();
    await act(async () => {
      memory.resolve({} as SpaceMemoryConfig);
      voice.resolve({} as VoiceStatus);
    });
    expect(setMemory).not.toHaveBeenCalled();
    expect(setVoice).toHaveBeenCalledTimes(reason === "revision" ? 1 : 0);
  },
);
