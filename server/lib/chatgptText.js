/** Remove ChatGPT's opaque citation markup without changing ordinary Markdown. */
export function stripChatgptCitations(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\uE200cite\uE202[^\uE200\uE201\r\n]*\uE201/g, '')
    // Some exports omit the closing marker. Match only known reference IDs
    // at a line boundary, never arbitrary text after an unfinished opener.
    .replace(/\uE200cite\uE202turn\d+(?:search|view|fetch|file)\d+(?:\uE202turn\d+(?:search|view|fetch|file)\d+)*(?=\r?\n|$)/g, '')
    // Older imports could cut a token at the preview limit. Only recognize
    // that partial token immediately before the importer's truncation footer.
    .replace(/\uE200cite\uE202[^\uE200\uE201\r\n]*(?=\n\n…\(transcript truncated — open the full conversation to see everything\)$)/g, '');
}
