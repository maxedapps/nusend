type Token = { readonly kind: "identifier" | "punctuation"; readonly value: string };

export function droppedTableNames(sql: string): string[] {
  const tokens = tokenize(sql);
  const names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isKeyword(tokens[index], "DROP")) continue;
    if (!isKeyword(tokens[index + 1], "TABLE")) continue;
    index += 2;
    if (isKeyword(tokens[index], "IF")) {
      if (!isKeyword(tokens[index + 1], "EXISTS")) {
        throw new Error("Malformed DROP TABLE IF EXISTS clause.");
      }
      index += 2;
    }

    const first = tokens[index];
    if (first?.kind !== "identifier") throw new Error("Malformed DROP TABLE statement.");
    let name = first.value;
    if (tokens[index + 1]?.value === ".") {
      const second = tokens[index + 2];
      if (second?.kind !== "identifier") throw new Error("Malformed qualified DROP TABLE name.");
      name = `${name}.${second.value}`;
      index += 2;
    }
    const boundary = tokens[index + 1];
    if (boundary && boundary.value !== ";") {
      throw new Error("Malformed trailing tokens in DROP TABLE statement.");
    }
    names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return token?.kind === "identifier" && token.value.toUpperCase() === keyword;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < sql.length; ) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index = skipLineComment(sql, index + 2);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = skipBlockComment(sql, index + 2);
      continue;
    }
    if (char === "'") {
      index = skipQuoted(sql, index, "'", "'");
      continue;
    }
    if (char === '"') {
      const parsed = readQuotedIdentifier(sql, index, '"', '"');
      tokens.push({ kind: "identifier", value: parsed.value });
      index = parsed.next;
      continue;
    }
    if (char === "`") {
      const parsed = readQuotedIdentifier(sql, index, "`", "`");
      tokens.push({ kind: "identifier", value: parsed.value });
      index = parsed.next;
      continue;
    }
    if (char === "[") {
      const parsed = readQuotedIdentifier(sql, index, "]", undefined);
      tokens.push({ kind: "identifier", value: parsed.value });
      index = parsed.next;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      tokens.push({ kind: "identifier", value: sql.slice(index, end) });
      index = end;
      continue;
    }
    if (char === "." || char === ";" || char === ",") {
      tokens.push({ kind: "punctuation", value: char });
      index += 1;
      continue;
    }
    tokens.push({ kind: "punctuation", value: char });
    index += 1;
  }
  return tokens;
}

function skipLineComment(sql: string, start: number): number {
  const newline = sql.indexOf("\n", start);
  return newline < 0 ? sql.length : newline + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const end = sql.indexOf("*/", start);
  if (end < 0) throw new Error("Unterminated SQL block comment.");
  return end + 2;
}

function skipQuoted(sql: string, start: number, closing: string, escape: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== closing) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === escape) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new Error("Unterminated SQL string literal.");
}

function readQuotedIdentifier(
  sql: string,
  start: number,
  closing: string,
  escape: string | undefined,
): { readonly next: number; readonly value: string } {
  const opening = sql[start]!;
  let index = start + 1;
  let value = "";
  while (index < sql.length) {
    const char = sql[index]!;
    if (char !== closing) {
      value += char;
      index += 1;
      continue;
    }
    if (escape && sql[index + 1] === escape) {
      value += closing;
      index += 2;
      continue;
    }
    if (value.length === 0) throw new Error("Empty quoted SQL identifier.");
    return { next: index + 1, value };
  }
  throw new Error(`Unterminated SQL identifier beginning with ${opening}.`);
}
