const ADMINISTRATIVE_KEYWORDS = new Set([
  "ANALYZE",
  "ATTACH",
  "DETACH",
  "DROP",
  "PRAGMA",
  "REINDEX",
  "VACUUM"
]);
const CROSS_TABLE_QUERY_KEYWORDS = new Set(["JOIN", "SELECT", "WITH"]);
const ALTER_DEFINITION_STATEMENT_KEYWORDS = new Set(["ALTER", "CREATE", "DELETE", "INSERT", "UPDATE"]);

export function parseMigrationStatements(sql) {
  const statements = [];
  let current = "";
  let quote;
  let bracketIdentifier = false;
  let blockComment = false;
  let lineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += "\n";
      }
      continue;
    }
    if (!quote && !bracketIdentifier && char === "/" && next === "*") {
      blockComment = true;
      current += " ";
      index += 1;
      continue;
    }
    if (!quote && !bracketIdentifier && char === "-" && next === "-") {
      lineComment = true;
      current += " ";
      index += 1;
      continue;
    }
    if (!quote && char === "[") {
      bracketIdentifier = true;
    } else if (bracketIdentifier && char === "]") {
      bracketIdentifier = false;
    } else if (!bracketIdentifier && (char === "'" || char === "\"" || char === "`")) {
      if (quote === char && next === char) {
        current += char + next;
        index += 1;
        continue;
      }
      quote = quote === char ? undefined : quote ?? char;
    }
    if (!quote && !bracketIdentifier && char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += char;
  }

  if (blockComment) throw new Error("Migration SQL contains an unterminated block comment");
  if (quote || bracketIdentifier) throw new Error("Migration SQL contains an unterminated literal or identifier");
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

export function analyzeMigrationStatement(statement, options = {}) {
  const tablePrefix = normalizeRequiredPrefix(options.tablePrefix);
  const tokens = tokenizeSql(statement);
  if (tokens.length === 0) throw new Error("Statement type is not allowed");
  rejectAdministrativeKeywords(tokens);

  if (isKeyword(tokens[0], "CREATE")) return validateCreate(tokens, tablePrefix);
  if (isKeyword(tokens[0], "ALTER")) return validateAlterTable(tokens, tablePrefix);
  if (isKeyword(tokens[0], "INSERT")) return validateInsert(tokens, tablePrefix);
  if (isKeyword(tokens[0], "UPDATE")) return validateUpdate(tokens, tablePrefix);
  if (isKeyword(tokens[0], "DELETE")) return validateDelete(tokens, tablePrefix);
  throw new Error("Statement type is not allowed");
}

function validateCreate(tokens, tablePrefix) {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("CREATE");
  if (cursor.matchKeyword("TABLE")) {
    cursor.expectKeyword("IF");
    cursor.expectKeyword("NOT");
    cursor.expectKeyword("EXISTS");
    const table = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(table, tablePrefix);
    cursor.expectSymbol("(");
    const closing = matchingParenIndex(tokens, cursor.position - 1);
    if (closing !== tokens.length - 1 || closing === cursor.position) throw unsupportedStatement();
    const definition = tokens.slice(cursor.position, closing);
    assertOwnedReferences(definition, tablePrefix);
    assertNoQueryKeywords(definition);
    return { category: "schema", table, type: "create_table" };
  }
  if (cursor.matchKeyword("INDEX")) {
    cursor.expectKeyword("IF");
    cursor.expectKeyword("NOT");
    cursor.expectKeyword("EXISTS");
    const indexName = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(indexName, tablePrefix);
    cursor.expectKeyword("ON");
    const table = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(table, tablePrefix);
    cursor.expectSymbol("(");
    const closing = matchingParenIndex(tokens, cursor.position - 1);
    if (closing === cursor.position) throw unsupportedStatement();
    const trailing = tokens.slice(closing + 1);
    if (trailing.length > 0 && (!isKeyword(trailing[0], "WHERE") || trailing.length === 1)) {
      throw unsupportedStatement();
    }
    assertNoQueryKeywords(tokens.slice(cursor.position, closing));
    assertNoQueryKeywords(trailing);
    return { category: "schema", table, type: "create_index" };
  }
  throw unsupportedStatement();
}

function validateAlterTable(tokens, tablePrefix) {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("ALTER");
  cursor.expectKeyword("TABLE");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, tablePrefix);
  cursor.expectKeyword("ADD");
  cursor.expectKeyword("COLUMN");
  cursor.readIdentifier();
  if (cursor.done()) throw unsupportedStatement();
  const definition = tokens.slice(cursor.position);
  assertOwnedReferences(definition, tablePrefix);
  assertNoQueryKeywords(definition);
  if (definition.some((token) => token.kind === "word" && ALTER_DEFINITION_STATEMENT_KEYWORDS.has(token.upper))) {
    throw unsupportedStatement();
  }
  return { category: "schema", table, type: "alter_table" };
}

function validateInsert(tokens, tablePrefix) {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("INSERT");
  cursor.expectKeyword("INTO");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, tablePrefix);
  rejectQualifiedTarget(cursor);
  assertNoDataQueryKeywords(tokens.slice(cursor.position));
  if (cursor.peekSymbol("(")) cursor.skipBalancedGroup();
  cursor.expectKeyword("VALUES", "INSERT data migrations must use VALUES");
  if (!cursor.peekSymbol("(")) throw new Error("INSERT data migrations must use VALUES");
  cursor.skipBalancedGroup();
  while (cursor.matchSymbol(",")) {
    if (!cursor.peekSymbol("(")) throw new Error("INSERT data migrations must use VALUES");
    cursor.skipBalancedGroup();
  }
  if (cursor.done()) return { category: "data", table, type: "insert" };
  cursor.expectKeyword("ON", "INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  cursor.expectKeyword("CONFLICT", "INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  if (cursor.peekSymbol("(")) cursor.skipBalancedGroup();
  if (cursor.matchKeyword("WHERE")) {
    const doIndex = findTopLevelKeyword(tokens, "DO", cursor.position);
    if (doIndex <= cursor.position) throw new Error("INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
    cursor.position = doIndex;
  }
  cursor.expectKeyword("DO", "INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  if (cursor.matchKeyword("NOTHING")) {
    if (!cursor.done()) throw new Error("INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
    return { category: "data", table, type: "insert" };
  }
  cursor.expectKeyword("UPDATE", "INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  cursor.expectKeyword("SET", "INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  if (cursor.done()) throw new Error("INSERT ON CONFLICT must use DO NOTHING or DO UPDATE SET");
  return { category: "data", table, type: "insert" };
}

function validateUpdate(tokens, tablePrefix) {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("UPDATE");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, tablePrefix);
  rejectQualifiedTarget(cursor);
  cursor.expectKeyword("SET");
  assertNoDataQueryKeywords(tokens.slice(cursor.position));
  const whereIndex = findTopLevelKeyword(tokens, "WHERE", cursor.position);
  if (whereIndex < 0 || whereIndex === tokens.length - 1) throw new Error("UPDATE data migrations must include WHERE");
  if (whereIndex === cursor.position) throw unsupportedStatement();
  return { category: "data", table, type: "update" };
}

function validateDelete(tokens, tablePrefix) {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("DELETE");
  cursor.expectKeyword("FROM");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, tablePrefix);
  rejectQualifiedTarget(cursor);
  assertNoDataQueryKeywords(tokens.slice(cursor.position));
  const whereIndex = findTopLevelKeyword(tokens, "WHERE", cursor.position);
  if (whereIndex < 0 || whereIndex === tokens.length - 1) throw new Error("DELETE data migrations must include WHERE");
  if (whereIndex !== cursor.position) throw unsupportedStatement();
  return { category: "data", table, type: "delete" };
}

function tokenizeSql(statement) {
  const tokens = [];
  for (let index = 0; index < statement.length;) {
    const char = statement[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (index < statement.length && isIdentifierPart(statement[index])) index += 1;
      const text = statement.slice(start, index);
      tokens.push({ kind: "word", text, upper: text.toUpperCase() });
      continue;
    }
    if (isDigit(char) || (char === "." && isDigit(statement[index + 1]))) {
      const end = readNumberEnd(statement, index);
      tokens.push({ kind: "number", text: statement.slice(index, end) });
      index = end;
      continue;
    }
    if (char === "'") {
      const start = index;
      index += 1;
      let terminated = false;
      while (index < statement.length) {
        if (statement[index] === "'" && statement[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (statement[index] === "'") {
          index += 1;
          terminated = true;
          break;
        }
        index += 1;
      }
      if (!terminated) throw new Error("Migration SQL contains an unterminated literal");
      tokens.push({ kind: "string", text: statement.slice(start, index) });
      continue;
    }
    if (char === "\"" || char === "`" || char === "[") {
      throw new Error("Quoted migration identifiers are not allowed");
    }
    if (isSymbolStart(char)) {
      const pair = statement.slice(index, index + 2);
      const symbol = isTwoCharacterSymbol(pair) ? pair : char;
      tokens.push({ kind: "symbol", text: symbol });
      index += symbol.length;
      continue;
    }
    throw new Error("Migration SQL contains an unsupported token");
  }
  assertBalancedParentheses(tokens);
  return tokens;
}

class TokenCursor {
  position = 0;

  constructor(tokens) {
    this.tokens = tokens;
  }

  done() {
    return this.position >= this.tokens.length;
  }

  expectKeyword(keyword, message = "Statement type is not allowed") {
    if (!this.matchKeyword(keyword)) throw new Error(message);
  }

  expectSymbol(symbol) {
    if (!this.matchSymbol(symbol)) throw unsupportedStatement();
  }

  matchKeyword(keyword) {
    if (!isKeyword(this.tokens[this.position], keyword)) return false;
    this.position += 1;
    return true;
  }

  matchSymbol(symbol) {
    if (!this.peekSymbol(symbol)) return false;
    this.position += 1;
    return true;
  }

  peekSymbol(symbol) {
    const token = this.tokens[this.position];
    return token?.kind === "symbol" && token.text === symbol;
  }

  readIdentifier() {
    const token = this.tokens[this.position];
    if (token?.kind !== "word") throw unsupportedStatement();
    this.position += 1;
    return token.text;
  }

  skipBalancedGroup() {
    if (!this.peekSymbol("(")) throw unsupportedStatement();
    this.position = matchingParenIndex(this.tokens, this.position) + 1;
  }
}

function normalizeRequiredPrefix(value) {
  const prefix = String(value ?? "").trim().toLowerCase();
  if (!prefix) throw new Error("App D1 migration preflight requires --table-prefix");
  return prefix;
}

function assertOwnedMigrationIdentifier(identifier, tablePrefix) {
  const normalized = identifier.toLowerCase();
  if (normalized.startsWith("sqlite_")) throw new Error("reserved_migration_identifier");
  if (!normalized.startsWith(tablePrefix)) {
    throw new Error(`Migration identifier ${identifier} is outside App prefix ${tablePrefix}`);
  }
}

function assertOwnedReferences(tokens, tablePrefix) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isKeyword(tokens[index], "REFERENCES")) continue;
    const referenced = tokens[index + 1];
    if (referenced?.kind !== "word") throw unsupportedStatement();
    assertOwnedMigrationIdentifier(referenced.text, tablePrefix);
    if (tokens[index + 2]?.kind === "symbol" && tokens[index + 2]?.text === ".") {
      throw new Error("Data migrations cannot query other tables or use administrative SQL");
    }
  }
}

function rejectQualifiedTarget(cursor) {
  if (cursor.peekSymbol(".")) throw new Error("Data migrations cannot use qualified table names");
}

function rejectAdministrativeKeywords(tokens) {
  if (tokens.some((token) => token.kind === "word" && ADMINISTRATIVE_KEYWORDS.has(token.upper))) {
    throw unsupportedStatement();
  }
}

function assertNoQueryKeywords(tokens) {
  if (tokens.some((token) => token.kind === "word" && CROSS_TABLE_QUERY_KEYWORDS.has(token.upper))) {
    throw new Error("Migrations cannot query other tables");
  }
}

function assertNoDataQueryKeywords(tokens) {
  if (tokens.some((token) => token.kind === "word" && (token.upper === "FROM" || CROSS_TABLE_QUERY_KEYWORDS.has(token.upper)))) {
    throw new Error("Data migrations cannot query other tables or use administrative SQL");
  }
}

function assertBalancedParentheses(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== "symbol") continue;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth < 0) throw new Error("Migration SQL contains unbalanced parentheses");
  }
  if (depth !== 0) throw new Error("Migration SQL contains unbalanced parentheses");
}

function matchingParenIndex(tokens, openingIndex) {
  if (tokens[openingIndex]?.kind !== "symbol" || tokens[openingIndex]?.text !== "(") throw unsupportedStatement();
  let depth = 0;
  for (let index = openingIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "symbol") continue;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth === 0) return index;
  }
  throw new Error("Migration SQL contains unbalanced parentheses");
}

function findTopLevelKeyword(tokens, keyword, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.text === "(") {
      depth += 1;
      continue;
    }
    if (token.kind === "symbol" && token.text === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && isKeyword(token, keyword)) return index;
  }
  return -1;
}

function readNumberEnd(value, start) {
  let index = start;
  if (value[index] === "0" && (value[index + 1] === "x" || value[index + 1] === "X") && isHexDigit(value[index + 2])) {
    index += 3;
    while (isHexDigit(value[index])) index += 1;
    return index;
  }
  if (value[index] === ".") index += 1;
  while (isDigit(value[index])) index += 1;
  if (value[index] === ".") {
    index += 1;
    while (isDigit(value[index])) index += 1;
  }
  if (value[index] === "e" || value[index] === "E") {
    let exponent = index + 1;
    if (value[exponent] === "+" || value[exponent] === "-") exponent += 1;
    if (isDigit(value[exponent])) {
      index = exponent + 1;
      while (isDigit(value[index])) index += 1;
    }
  }
  return index;
}

function isIdentifierStart(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(char) {
  return isIdentifierStart(char) || isDigit(char);
}

function isDigit(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHexDigit(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return isDigit(char) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function isSymbolStart(char) {
  return Boolean(char && "(),.=+-*/%<>!|&~".includes(char));
}

function isTwoCharacterSymbol(value) {
  return value === "<=" || value === ">=" || value === "!=" || value === "<>" || value === "=="
    || value === "||" || value === "<<" || value === ">>";
}

function isKeyword(token, keyword) {
  return token?.kind === "word" && token.upper === keyword;
}

function unsupportedStatement() {
  return new Error("Statement type is not allowed");
}
