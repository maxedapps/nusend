// D1 allows at most 100 bound parameters per statement.
const maxBoundParamsPerStatement = 100;

// Chunk size for IN (...) lookups, leaving headroom for a handful of extra
// bound parameters next to the value list.
export const maxInLookupValues = 90;

type BoundValue = string | number | null;

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// Splits a multi-row INSERT into as many statements as the bound-parameter
// limit requires. `sql` receives the placeholder groups, e.g. "(?, ?), (?, ?)".
export function buildChunkedInsertStatements(
  db: D1Database,
  rows: BoundValue[][],
  sql: (placeholders: string) => string,
): D1PreparedStatement[] {
  if (rows.length === 0) return [];

  const paramsPerRow = rows[0].length;
  const rowsPerStatement = Math.floor(maxBoundParamsPerStatement / paramsPerRow);
  if (rowsPerStatement < 1) {
    throw new RangeError("A single row exceeds the D1 bound-parameter limit.");
  }

  const rowPlaceholders = `(${placeholders(paramsPerRow)})`;
  const statements: D1PreparedStatement[] = [];

  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    statements.push(
      db.prepare(sql(chunk.map(() => rowPlaceholders).join(", "))).bind(...chunk.flat()),
    );
  }

  return statements;
}

// Splits large IN (...) lookups so each query stays under the parameter limit.
export function chunkValues<T>(values: T[], chunkSize: number = maxInLookupValues): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    chunks.push(values.slice(offset, offset + chunkSize));
  }
  return chunks;
}
