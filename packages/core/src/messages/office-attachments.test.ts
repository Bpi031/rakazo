import { describe, expect, it } from "vitest";
import {
  attachmentExtensionForMimeType,
  attachmentKindForMimeType,
  decodeAttachmentBase64,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "./attachments.js";

describe("Office file delivery", () => {
  const formats = [
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
    ["doc", "application/msword"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["docm", "application/vnd.ms-word.document.macroEnabled.12"],
    ["dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.template"],
    ["dotm", "application/vnd.ms-word.template.macroEnabled.12"],
    ["xls", "application/vnd.ms-excel"],
    ["xlsb", "application/vnd.ms-excel.sheet.binary.macroEnabled.12"],
    ["xltx", "application/vnd.openxmlformats-officedocument.spreadsheetml.template"],
    ["xltm", "application/vnd.ms-excel.template.macroEnabled.12"],
    ["ppt", "application/vnd.ms-powerpoint"],
    ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["pptm", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
    ["potx", "application/vnd.openxmlformats-officedocument.presentationml.template"],
    ["potm", "application/vnd.ms-powerpoint.template.macroEnabled.12"],
    ["ppsx", "application/vnd.openxmlformats-officedocument.presentationml.slideshow"],
    ["ppsm", "application/vnd.ms-powerpoint.slideshow.macroEnabled.12"],
    ["odt", "application/vnd.oasis.opendocument.text"],
    ["ott", "application/vnd.oasis.opendocument.text-template"],
    ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
    ["ots", "application/vnd.oasis.opendocument.spreadsheet-template"],
    ["odp", "application/vnd.oasis.opendocument.presentation"],
    ["otp", "application/vnd.oasis.opendocument.presentation-template"],
    ["rtf", "application/rtf"],
    ["tsv", "text/tab-separated-values"],
    ["pdf", "application/pdf"],
  ];
  for (const [extension, mime] of formats) {
    it(`delivers ${extension} as an opaque file, not an image`, () => {
      expect(() => validateAttachmentMimeType(mime!)).not.toThrow();
      expect(attachmentKindForMimeType(mime!)).toBe("file");
      expect(attachmentExtensionForMimeType(mime!)).toBe(`.${extension}`);
      expect(inferAttachmentMimeType(`roster.${extension}`, mime)).toBe(mime);
      expect(messageBlockForArtifact({ id: "a", name: `roster.${extension}`, mimeType: mime!, size: 5 }))
        .toEqual({ kind: "file", artifactId: "a", name: `roster.${extension}`, mimeType: mime, size: 5 });
    });
    it.each(["", "application/octet-stream", "application/zip", "application/x-zip-compressed",
      "application/x-zip", "multipart/x-zip"])(`preserves ${extension} when reported as %s`, reported => {
      expect(inferAttachmentMimeType(`roster.${extension!.toUpperCase()}`, reported)).toBe(mime);
    });
  }
  it.each([["dot", "application/msword"], ["xlt", "application/vnd.ms-excel"],
    ["pot", "application/vnd.ms-powerpoint"], ["pps", "application/vnd.ms-powerpoint"]])(
    "recognizes the legacy %s template/slideshow alias", (extension, mime) => {
      expect(inferAttachmentMimeType(`template.${extension}`, "application/octet-stream")).toBe(mime);
      expect(inferAttachmentMimeType(`template.${extension!.toUpperCase()}`)).toBe(mime);
    });
  it("does not broaden the allowlist to executables or arbitrary binary files", () => {
    expect(inferAttachmentMimeType("program.exe", "application/octet-stream")).toBeNull();
    expect(() => validateAttachmentMimeType("application/octet-stream")).toThrow();
    expect(inferAttachmentMimeType("bundle.zip", "application/x-zip-compressed")).toBe("application/zip");
    expect(() => decodeAttachmentBase64(Buffer.alloc(12).toString("base64"), 11)).toThrow();
  });
});
