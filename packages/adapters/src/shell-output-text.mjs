import { hasInvalidJsonbText } from "@rakazo/contracts/managed-text";

const ESCAPED_OUTPUT = "[Non-text shell output; JSON-escaped UTF-16 preview follows]\n";

/** Shell previews are text, not a binary file transport or workbook decoder. */
export function shellOutputText(text) {
  // Unicode mode matches lone surrogates, but leaves valid surrogate pairs alone.
  return hasInvalidJsonbText(text) ? ESCAPED_OUTPUT + JSON.stringify(text) : text;
}
