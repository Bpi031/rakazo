export function hasAsciiControl(text, { allowLayout = false, includeDelete = false } = {}) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 127 && includeDelete) return true;
    if (code < 32 && (!allowLayout || (code !== 9 && code !== 10 && code !== 13))) return true;
  }
  return false;
}

/** JSONB accepts Unicode scalars but cannot store NUL or an unpaired UTF-16 surrogate. */
export function hasInvalidJsonbText(text) {
  for (const scalar of text) {
    const code = scalar.codePointAt(0);
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return true;
  }
  return false;
}
