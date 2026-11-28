import { useState } from "react";

export function useReportDraft(key: string | null) {
  const [reportDraft, setReportDraft] = useState<{
    key: string;
    text: string;
    nonce: string;
  } | null>(null);
  function composeReport(text: string) {
    if (key)
      setReportDraft({
        key,
        text,
        nonce: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      });
  }
  return { reportDraft, composeReport };
}
