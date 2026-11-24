import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckpointsPanel } from "../../src/components/CheckpointsPanel";
import { CheckpointTree } from "../../src/components/CheckpointTree";
import { useCheckpointI18n } from "../../src/lib/checkpoint-i18n";
import { bootstrapI18n } from "../../src/lib/i18n";
import { normalizeUiLocale } from "../../src/lib/ui-locale";
import { checkpointBranchesPreview } from "./checkpoint-branches";
import "../../src/styles.css";

function Fixture() {
  const { copy } = useCheckpointI18n();
  const [restored, setRestored] = useState(false);
  const [preview, setPreview] = useState(checkpointBranchesPreview);
  const demo = new URLSearchParams(window.location.search).get("demo") === "branches";
  return (
    <main className="mx-auto min-h-screen max-w-md border-x border-border bg-background p-5 text-foreground">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{copy.title}</h1>
        {demo && <span className="text-xs text-muted-foreground">Preview</span>}
      </div>
      {demo ? (
        <CheckpointTree
          view={preview}
          disabled={false}
          onSelect={(node) =>
            setPreview({ ...preview, activeBranchId: node.branchId, currentCheckpointId: node.id })
          }
        />
      ) : restored ? (
        <p role="status">Restored</p>
      ) : (
        <CheckpointsPanel botId="fixture-bot" onRestored={() => setRestored(true)} />
      )}
    </main>
  );
}
const locale = normalizeUiLocale(new URLSearchParams(window.location.search).get("locale"));
void bootstrapI18n(locale).then(() =>
  createRoot(document.getElementById("root")!).render(<Fixture />),
);
