/** Reads share a live row as the target changes; other tools retain argument boundaries. */
export function continuesToolGroup(
  previous: { name: string; detail: string }, name: string, detail: string,
): boolean {
  return previous.name === name && (name === 'read' || previous.detail === detail.trim());
}
