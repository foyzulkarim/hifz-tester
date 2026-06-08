/**
 * Sanitize transliteration HTML from quran-enhanced.json.
 *
 * Allowlists: <u>, <b>, <i>, <strong> (and their closes, case-insensitive).
 * Maps them to colored <span class="tajweed-…"> elements.
 * Rejects unknown tags, tags with attributes, and orphan closes.
 * Drops unclosed open spans at end-of-input.
 */

const tagMap: Record<string, string> = {
  u: '<span class="tajweed-em">',
  b: '<span class="tajweed-heavy">',
  i: '<span class="tajweed-i">',
  strong: '<span class="tajweed-strong">',
};

const allowed = new Set(["u", "b", "i", "strong"]);

export function sanitizeTranslit(html: string): string {
  const stack: Array<{ tagName: string; pos: number }> = [];
  let result = "";

  // Split into text fragments and tag tokens.
  const tokens = html.split(/(<[^>]+>)/g);

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      result += token;
      continue;
    }

    const tagContent = token.slice(1, -1); // remove surrounding < >
    const hasAttrs = tagContent.includes(" ");
    const isClose = tagContent.startsWith("/");
    const rawName = isClose ? tagContent.slice(1) : tagContent;
    const tagName = rawName.toLowerCase();

    if (hasAttrs || !allowed.has(tagName)) {
      continue; // drop unknown tags and tags with attributes entirely
    }

    if (isClose) {
      if (stack.length > 0 && stack[stack.length - 1].tagName === tagName) {
        stack.pop();
        result += "</span>";
      }
      // orphan close: drop it
    } else {
      stack.push({ tagName, pos: result.length });
      result += tagMap[tagName];
    }
  }

  // Drop any unclosed open spans by splicing them out in reverse order.
  for (let i = stack.length - 1; i >= 0; i--) {
    const { pos, tagName } = stack[i];
    const openTag = tagMap[tagName];
    result = result.slice(0, pos) + result.slice(pos + openTag.length);
  }

  return result;
}
