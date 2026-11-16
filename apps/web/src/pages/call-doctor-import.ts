import type { CallDoctor } from "@rakazo/contracts";
import { callDoctorInput } from "@rakazo/contracts";

export type CallDoctorDetails = Pick<CallDoctor, "code" | "name" | "email" | "active">;

export class CallDoctorImportError extends Error {
  constructor(
    readonly kind: "columns" | "empty" | "row" | "duplicates" | "large",
    readonly row?: number,
  ) {
    super(kind);
  }
}

/** Read a small RFC 4180-style doctor list without exposing a raw data editor. */
export function parseCallDoctorCsv(source: string): CallDoctorDetails[] {
  if (source.length > 512 * 1024) throw new CallDoctorImportError("large");
  const rows: string[][] = [];
  let fields: string[] = [];
  let value = "";
  let quoted = false;
  let closed = false;
  const input = source.replace(/^\uFEFF/, "");
  for (let i = 0; i <= input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === undefined) throw new CallDoctorImportError("row", rows.length + 1);
      if (char === '"') {
        if (input[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += char;
      continue;
    }
    if (char === '"') {
      if (value || closed) throw new CallDoctorImportError("row", rows.length + 1);
      quoted = true;
      continue;
    }
    if (char === "," || char === "\r" || char === "\n" || char === undefined) {
      fields.push(value.trim());
      value = "";
      closed = false;
      if (char !== ",") {
        if (fields.some(Boolean)) rows.push(fields);
        fields = [];
        if (char === "\r" && input[i + 1] === "\n") i++;
      }
      continue;
    }
    if (closed && !/\s/.test(char)) throw new CallDoctorImportError("row", rows.length + 1);
    if (!closed) value += char;
  }
  if (!rows.length) throw new CallDoctorImportError("empty");
  const header = rows.shift()!.map((cell) => cell.toLowerCase().replace(/[ _-]/g, ""));
  const code = header.findIndex((cell) => cell === "staffid" || cell === "code");
  const name = header.indexOf("name");
  const email = header.indexOf("email");
  if (header.length !== 3 || code < 0 || name < 0 || email < 0)
    throw new CallDoctorImportError("columns");
  if (!rows.length) throw new CallDoctorImportError("empty");
  if (rows.length > 1000) throw new CallDoctorImportError("large");
  const codes = new Set<string>();
  const emails = new Set<string>();
  return rows.map((cells, index) => {
    const parsed = callDoctorInput.safeParse({
      code: cells[code],
      name: cells[name],
      email: cells[email],
      active: true,
    });
    if (cells.length !== 3 || !parsed.success) throw new CallDoctorImportError("row", index + 2);
    if (codes.has(parsed.data.code) || emails.has(parsed.data.email))
      throw new CallDoctorImportError("duplicates", index + 2);
    codes.add(parsed.data.code);
    emails.add(parsed.data.email);
    return parsed.data;
  });
}
