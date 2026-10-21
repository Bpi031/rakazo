/** Browser lifecycle signals resume reads only; they never submit an agent turn. */
export function listenForThreadResume(resume: () => void): () => void {
  const visible = () => {
    if (document.visibilityState === "visible") resume();
  };
  window.addEventListener("focus", visible);
  window.addEventListener("online", visible);
  window.addEventListener("pageshow", visible);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("focus", visible);
    window.removeEventListener("online", visible);
    window.removeEventListener("pageshow", visible);
    document.removeEventListener("visibilitychange", visible);
  };
}
