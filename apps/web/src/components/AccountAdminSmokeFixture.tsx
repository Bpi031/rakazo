import { createRoot } from "react-dom/client";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AccountAdminPanel } from "../pages/AccountAdminPanel";
import "../styles.css";
i18n.load("en", {});
i18n.activate("en");
createRoot(document.getElementById("root")!).render(<I18nProvider i18n={i18n}>
  <main className="mx-auto w-full min-w-0 max-w-5xl p-4 sm:p-6"><AccountAdminPanel/></main>
</I18nProvider>);
