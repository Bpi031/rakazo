import { createRoot } from "react-dom/client";
import { AgentWorkbenchPanel } from "./AgentWorkbenchPanel";
import { QuestionFormCard } from "./QuestionFormCard";
import "../styles.css";
const id = "a1afc5c5-78f2-4bb2-8530-a2d9d98bb411",
  branch = "b1afc5c5-78f2-4bb2-8530-a2d9d98bb411";
const view: any = {
  goal: { objective: "Compare candidate distribution", status: "active", revision: 0 },
  skills: [
    {
      id: "a".repeat(64),
      name: "Office analysis",
      description: "Installed operator-reviewed skill",
      sha256: "b".repeat(64),
    },
  ],
  selectedSkill: null,
  hooks: [{ name: "private-owner", version: 1, description: "Owned private workspace" }],
  records: [
    { id, kind: "change", title: "workspace/policy.rost", status: "draft", digest: "d".repeat(64) },
  ],
};
let saved = false;
const scenario: any = { title: "Alternate weekends", sourceDigest: "f".repeat(64), messages: [] };
const native:any={enabled:true,preferences:{mode:'execute',persistence:true,action:'none',revision:0},records:[{id:'native',kind:'native_session',status:'completed',payload:{threadId:'offline-only'}}]};
window.fetch = async (url, init) => {
  const op = new URL(String(url), location.origin).pathname.split("/").at(-1);
  if (op === "view") return Response.json(view);
  if (op === "native") return Response.json(native);
  if (op === "detail")
    return Response.json(
      String(url).includes(branch)
        ? { id: branch, kind: "scenario", digest: "f".repeat(64), payload: scenario }
        : {
            id,
            kind: "change",
            status: saved ? "saved" : "draft",
            digest: "d".repeat(64),
            payload: {
              path: "workspace/policy.rost",
              before: "original reviewed policy\n",
              proposedText: "separate proposed policy\n",
              sourceSha256: "e".repeat(64),
            },
          },
    );
  const input = JSON.parse(String(init?.body));
  (window as any).__workbenchCalls ??= [];
  (window as any).__workbenchCalls.push(input.operation);
  if(input.operation==='native_settings')native.preferences={...input.preferences,revision:native.preferences.revision+1};
  if (input.operation === "goal") view.goal = { ...input.goal, revision: input.revision + 1 };
  if (input.operation === "select_skill") view.selectedSkill = { id: input.id };
  if (input.operation === "save_draft") {
    saved = true;
    view.records[0].status = "saved";
    return Response.json({ draftPath: "workspace/policy.review-fixture.rost" });
  }
  if (input.operation === "scenario") {
    view.records.push({
      id: branch,
      kind: "scenario",
      title: scenario.title,
      status: "draft",
      digest: "f".repeat(64),
    });
    return Response.json({ id: branch });
  }
  if (input.operation === "scenario_message")
    scenario.messages.push({
      nonce: input.nonce,
      question: input.message,
      answer: "Analysis only: review the distribution before adopting any change.",
      needsApproval: true,
    });
  return Response.json({ ok: true });
};
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen min-w-0 bg-background text-foreground">
    <AgentWorkbenchPanel botId="fixture" onClose={() => {}} />
    <div className="min-w-0 p-4">
      <QuestionFormCard
        question="Confirm the comparison inputs"
        form={{
          schema: "rakazo/question-form/v1",
          fields: [
            {
              id: "scope",
              label: "Scope",
              type: "choice",
              options: ["Weekends", "All calls"],
              required: true,
            },
            { id: "weight", label: "Weight", type: "number", min: 0, max: 10, required: true },
            { id: "date", label: "From date", type: "date", required: true },
          ],
        }}
        onAnswer={async (answer) => {
          (window as any).__formAnswer = JSON.parse(answer);
        }}
      />
    </div>
  </main>,
);
