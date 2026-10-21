export function managedModalities(env?: NodeJS.ProcessEnv): Record<string, ("text" | "image")[]>;
export function codexImages(images: { name?: string; data: string | Uint8Array; mimeType: string }[] | undefined, allowed?: boolean): ({ type: "image"; url: string } | { type: "text"; text: string })[];
export function codexQuestion(params: any): import("@rakazo/adapter-kit").AgentRuntimeEvent;
