import type { SpaceMemoryConfig, VoiceStatus } from "@rakazo/contracts";
import type { RefObject } from "react";
import { useEffect } from "react";
import { rpc } from "./rpc";

/** Wait for capabilities; managed deployments never query user credential endpoints. */
export function useOptionalServiceStatus(
  managed: boolean | undefined,
  memoryRevision: RefObject<number>,
  setMemory: (config: SpaceMemoryConfig | null) => void,
  setVoice: (status: VoiceStatus | null) => void,
) {
  useEffect(() => {
    if (managed !== false) {
      setMemory(null);
      setVoice(null);
      return;
    }
    let cancelled = false;
    const revision = memoryRevision.current;
    void rpc.memory
      .providerConfig()
      .then((config) => {
        if (!cancelled && memoryRevision.current === revision) setMemory(config);
      })
      .catch(() => {
        if (!cancelled && memoryRevision.current === revision) setMemory(null);
      });
    void rpc.voice
      .status()
      .then((status) => {
        if (!cancelled) setVoice(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [managed, memoryRevision, setMemory, setVoice]);
}
