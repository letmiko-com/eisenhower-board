const MAX_TEXT_LENGTH = 500;

/**
 * Sanitize text input by removing HTML tags, Unicode control/format
 * characters and trimming whitespace
 */
export function sanitizeText(input: string): string {
  // Remove HTML tags
  let sanitized = input.replace(/<[^>]*>/g, '');

  // Remove a trailing unclosed tag (a remaining "<" never followed by ">")
  sanitized = sanitized.replace(/<[^>]*$/, '');

  // Strip Unicode control (Cc) and format (Cf) characters, keeping
  // tab/newline-style whitespace (U+0009 to U+000D) for normalization below
  sanitized = sanitized.replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\p{Cf}]/gu, '');

  // Trim whitespace and normalize multiple spaces
  sanitized = sanitized.trim().replace(/\s+/g, ' ');

  // Truncate to max length
  if (sanitized.length > MAX_TEXT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_TEXT_LENGTH);
  }

  return sanitized;
}

/**
 * Check if task text is valid (non-empty and within length limit).
 * Expects already-sanitized input.
 */
export function isValidTaskText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH;
}
