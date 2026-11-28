import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState } from "react";
import { useEventListener } from "./use-event-listener";

export function useVisibleRefresh(
  refresh: () => void,
  interval: number | null,
  resumeOnFocus = false,
) {
  const [pulse, setPulse] = useState(0);
  const onVisible = () => {
    if (document.visibilityState === "visible") refresh();
  };
  useTimeout(
    () => {
      onVisible();
      setPulse((current) => current + 1);
    },
    interval,
    pulse,
  );
  const listen = interval != null && resumeOnFocus && typeof window !== "undefined";
  useEventListener(listen ? window : null, "focus", onVisible);
  useEventListener(listen ? document : null, "visibilitychange", onVisible);
}
