import { createRoot } from "react-dom/client";
import { TeamWorkflowsPanel } from "./TeamWorkflowsPanel";
import "../styles.css";
const row = {
  id: "flow",
  digest: "d".repeat(64),
  name: "Weekly department information review",
  status: "draft",
  ready: false,
  manager: true,
  leadBotId: "lead",
  expiresAt: "2099-01-01T00:00:00Z",
  reviewExpiresAt: "2099-01-01T00:00:00Z",
  definition: {
    name: "Weekly department information review",
    leadBotId: "lead",
    objective:
      "Consolidate the information explicitly submitted by departments. Ask for a human decision before changing any roster input or policy.",
    modelId: "approved-model",
    participants: [
      {
        botId: "peer",
        instruction: "Summarize supplied staffing needs and identify missing facts.",
      },
    ],
    allowParticipantStart: true,
    maxStartsPerDay: 2,
    maxOutputTokens: 512,
    grantDays: 7,
  },
  participants: [
    { botId: "lead", name: "Team lead", consented: false, you: true },
    { botId: "peer", name: "Department assistant", consented: false, you: false },
  ],
  executions: [
    {
      id: "e",
      status: "needs_approval",
      createdAt: "2026-10-21T00:00:00Z",
      steps: [
        {
          botId: "peer",
          lead: false,
          status: "needs_approval",
          text: "A staffing input change needs the manager's review. No policy or files changed.",
        },
      ],
    },
  ],
};
const handover = {
  id: "handover", digest: "a".repeat(64), status: "draft", sender: true,
  fromBotId: "lead", toBotId: "successor", fromName: "Current team lead",
  toName: "Successor's private assistant", sourceRemainsOwner: false,
  workflows: [{ id: "flow", name: row.name }], expiresAt: "2099-01-01T00:00:00Z",
};
window.fetch = async (url, options) => {
  const operation = options?.method === "POST" ? JSON.parse(String(options.body)).operation : null;
  if (String(url).includes("/team-leadership/")) {
    if (operation) {
      handover.status = operation === "offer" ? "offered" : "applied";
      handover.sender = false;
    }
    return Response.json(operation ? { ok: true } : [handover]);
  }
  if (operation) {
    row.status = operation === "pause" ? "paused" : "active";
    row.participants[0]!.consented = true;
  }
  return Response.json(operation ? { ok: true } : [row]);
};
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full min-w-0 max-w-5xl p-4">
    <TeamWorkflowsPanel botId="lead" onClose={() => {}} />
  </main>,
);
