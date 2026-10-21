/** Default for deployments and clients connected to older servers. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
export const ARTIFACT_NAME_MAX_LENGTH = 255;
export const ARTIFACT_DESCRIPTION_MAX_LENGTH = 280;
/** Base64 expands payload by 4/3; cap before decode to reject oversize uploads cheaply. */
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.template.macroEnabled.12",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.ms-powerpoint.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.text-template",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet-template",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.presentation-template",
  "application/rtf",
  "text/tab-separated-values",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/zip",
] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_FILE_MIME_TYPES,
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isAllowedAttachmentMimeType(mimeType: string): mimeType is AttachmentMimeType {
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateThreadsSendInput(input: {
  text?: string;
  artifactIds?: string[];
}): boolean {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  return Boolean(text || artifactIds.length);
}

/** Effective per-file upload limit advertised in me/bootstrap. */
export function attachmentMaxBytes(config?: { maxUploadSizeBytes?: number } | null): number {
  return config?.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
}

export function attachmentSizeLabel(maxBytes: number): string {
  return `${maxBytes / (1024 * 1024)} MiB`;
}
