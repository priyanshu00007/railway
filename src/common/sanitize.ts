// Defense-in-depth against stored-XSS-style payloads. The API speaks JSON only
// and consumers encode on render, but we normalize hostile inputs anyway:
// strip HTML markers and control characters, collapse whitespace.

// Constructed at runtime so no literal control characters land in source.
const CONTROL_CHARS = new RegExp("[" + "\\u0000-\\u001f\\u007f" + "]", "g");

export function sanitizeText(input: string, maxLength = 120): string {
  return input
    .slice(0, maxLength)
    .replace(/</g, "")
    .replace(/>/g, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}
