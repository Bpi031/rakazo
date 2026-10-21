import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Transcript } from "../pages/Shell";
import { ManagedModelPicker } from "./ManagedModelPicker";
import "../styles.css";

i18n.load("en", {});
i18n.activate("en");
const columns = [
  { key: "doctor", label: "Doctor", type: "text" },
  ...Array.from({ length: 14 }, (_, i) => ({
    key: `c${i}`,
    label: `Call category ${i + 1}`,
    type: "number",
  })),
];
const rows = Array.from({ length: 80 }, (_, i) =>
  Object.fromEntries([
    ["doctor", `Synthetic doctor ${String(i + 1).padStart(3, "0")}`],
    ...columns.slice(1).map((c, j) => [c.key, i + j]),
  ]),
);
const block = {
  kind: "agent_report",
  report: {
    schema: "rakazo/agent-report/v1",
    title: "November roster review",
    sourcePaths: ["workspace/synthetic.json"],
    sections: [
      {
        kind: "metrics",
        items: [
          { label: "Synthetic staff", value: 80 },
          { label: "Unknown gap", value: null },
        ],
      },
      {
        kind: "table",
        title: "Per-doctor November distribution",
        columns,
        rows,
        rowQuestion: "Discuss this synthetic row.",
      },
    ],
  },
  evidence: {
    reportPath: "workspace/synthetic-report.json",
    reportSha256: "a".repeat(64),
    sources: [{ path: "workspace/synthetic.json", sha256: "b".repeat(64), bytes: 1 }],
    authority: "agent_analysis",
  },
};
const messages = [
  {
    id: "synthetic-report",
    threadId: "synthetic",
    botId: "b",
    role: "bot",
    createdAt: "2026-10-20T00:00:00Z",
    blocks: [block],
  },
] as any;
const nothing = () => {};
const asyncNothing = async () => {};
function Fixture() {
  const pane = new URLSearchParams(location.search).has("pane");
  const scroll = useRef<HTMLDivElement>(null);
  const [bot, setBot] = useState<any>({ id: "b", modelId: "flash", thinkingLevel: null });
  const [tick, setTick] = useState(0);
  return (
    <I18nProvider i18n={i18n}>
      <div
        className="qa-layout"
        style={{ height: "100dvh", display: "grid", gridTemplateRows: "48px minmax(0,1fr)" }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            minWidth: 0,
            padding: "0 12px",
          }}
        >
          <button onClick={() => setTick((n) => n + 1)}>Refresh metadata {tick}</button>
          <ManagedModelPicker bot={bot} defaultModel="flash" onChange={setBot} />
        </header>
        <div
          style={{
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: pane ? "minmax(0,1fr) 380px" : "minmax(0,1fr)",
            minWidth: 0,
          }}
        >
          <Transcript
            scrollRef={scroll}
            scrollRequest={null}
            onScrollRequestHandled={nothing}
            artifactTarget={{ botId: "b" }}
            messages={messages}
            showToolActivity={true}
            olderCursor={null}
            loadingOlder={false}
            answerableAskMessageId={null}
            running={false}
            workingBots={[]}
            onLoadOlder={asyncNothing}
            onOpenBot={nothing}
            onAnswer={asyncNothing}
            onCompose={nothing}
            onReply={nothing}
            onQuote={nothing}
            onReact={asyncNothing}
            onJumpToMessage={nothing}
            onOpenPeerMessages={nothing}
            peerBot={() => undefined}
            onRefresh={asyncNothing}
            onBotChanged={asyncNothing}
            onAddRoutine={nothing}
            voiceReady={false}
            speakingMessageId={null}
            onSpeak={nothing}
            onOpenComputer={nothing}
          />
          {pane && (
            <aside style={{ borderLeft: "1px solid #777", padding: 16 }}>
              Synthetic document pane
            </aside>
          )}
        </div>
      </div>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
