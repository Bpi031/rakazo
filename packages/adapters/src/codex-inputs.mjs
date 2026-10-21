export function managedModalities(env = process.env) {
  const value = JSON.parse(env.CODEX_MODEL_MODALITIES ?? "{}");
  const models = (env.CODEX_DEPLOYMENTS ?? "").split(",");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([id, modes]) =>
    !models.includes(id) || !Array.isArray(modes) || modes.length < 1 || modes.length > 2 || modes[0] !== "text" || new Set(modes).size !== modes.length || modes.some((m) => !["text", "image"].includes(m)))) throw new Error("Invalid operator modalities");
  return value;
}

export function codexImages(images, allowed = false) {
  if (!images?.length) return [];
  if (!allowed) throw new Error("ROST_IMAGE_ROUTE_UNAVAILABLE: Select an operator-qualified image model. No provider was changed.");
  if (images.length > 4) throw new Error("At most four images per turn");
  let bytes = 0;
  return images.flatMap((image) => {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) throw new Error("Invalid image input");
    const raw = image.data instanceof Uint8Array ? Buffer.from(image.data) : typeof image.data === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data) ? Buffer.from(image.data, "base64") : null;
    if (!raw?.length || typeof image.data === "string" && raw.toString("base64") !== image.data) throw new Error("Invalid image bytes");
    bytes += raw.length;
    if (bytes > 1_000_000) throw new Error("Image transport exceeds the qualified one MiB allowance");
    const valid = image.mimeType === "image/png" ? raw.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mimeType === "image/jpeg" ? raw[0] === 255 && raw[1] === 216 : image.mimeType === "image/gif" ? /^GIF8[79]a$/.test(raw.subarray(0, 6).toString()) : raw.subarray(0,4).toString() === "RIFF" && raw.subarray(8,12).toString() === "WEBP";
    if (!valid) throw new Error("Image signature mismatch");
    return [{ type: "text", text: "Attached image: " + String(image.name ?? "image").slice(0,200) }, { type: "image", url: `data:${image.mimeType};base64,${raw.toString("base64")}` }];
  });
}

export function codexQuestion(params) {
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) throw new Error("Invalid native questions");
  const fields = params.questions.map((q, i) => {
    if (q.isSecret || typeof q.question !== "string" || !q.question.trim() || q.question.length > 200 || /[\u0000\uD800-\uDFFF]/u.test(q.question)) throw new Error("Invalid or secret question");
    const options = q.options?.map((o) => o.label);
    if (options && (options.length < 2 || options.length > 6 || new Set(options).size !== options.length || options.some((o) => typeof o !== "string" || !o || o.length > 200 || /[\u0000\uD800-\uDFFF]/u.test(o)))) throw new Error("Invalid question choices");
    return { id: `q${i + 1}`, label: q.question, type: options && !q.isOther ? "choice" : "text", ...(options && !q.isOther ? { options } : {}), required: true };
  });
  return { type: "ask", text: "Please review these questions", form: { schema: "rakazo/question-form/v1", fields } };
}
