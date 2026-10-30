export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// SQLite length/substr count Unicode code points; JavaScript string.length counts UTF-16 units.
export function sqliteTextLength(value: string) {
  return Array.from(value).length;
}
