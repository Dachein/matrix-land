import { HttpError } from "../core/types";

export type MigrationStatementAnalysis = {
  category: "data" | "schema";
  table: string;
  type: "alter_table" | "create_index" | "create_table" | "delete" | "insert" | "update";
};

type MigrationValidationOptions = {
  allowDataMigrations: boolean;
  tablePrefix: string;
};

type SqlToken = {
  kind: "number" | "string" | "symbol" | "word";
  text: string;
  upper?: string;
};

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

export function parseMigrationStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | undefined;
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

  if (blockComment) throw new HttpError(400, "unterminated_migration_comment");
  if (quote || bracketIdentifier) throw new HttpError(400, "unterminated_migration_literal");

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

export function validateMigrationStatement(
  statement: string,
  options: MigrationValidationOptions
): MigrationStatementAnalysis {
  const tokens = tokenizeSql(statement);
  if (tokens.length === 0) throw new HttpError(400, "unsupported_migration_statement");
  rejectAdministrativeKeywords(tokens);

  if (isKeyword(tokens[0], "CREATE")) return validateCreate(tokens, options);
  if (isKeyword(tokens[0], "ALTER")) return validateAlterTable(tokens, options);
  if (isKeyword(tokens[0], "INSERT")) return validateInsert(tokens, options);
  if (isKeyword(tokens[0], "UPDATE")) return validateUpdate(tokens, options);
  if (isKeyword(tokens[0], "DELETE")) return validateDelete(tokens, options);
  throw new HttpError(400, "unsupported_migration_statement");
}

function validateCreate(tokens: SqlToken[], options: MigrationValidationOptions): MigrationStatementAnalysis {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("CREATE");

  if (cursor.matchKeyword("TABLE")) {
    cursor.expectKeyword("IF");
    cursor.expectKeyword("NOT");
    cursor.expectKeyword("EXISTS");
    const table = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(table, options.tablePrefix);
    cursor.expectSymbol("(");
    const closing = matchingParenIndex(tokens, cursor.position - 1);
    if (closing !== tokens.length - 1 || closing === cursor.position) {
      throw new HttpError(400, "unsupported_migration_statement");
    }
    const definition = tokens.slice(cursor.position, closing);
    assertOwnedReferences(definition, options.tablePrefix);
    assertNoQueryKeywords(definition);
    return { category: "schema", table, type: "create_table" };
  }

  if (cursor.matchKeyword("INDEX")) {
    cursor.expectKeyword("IF");
    cursor.expectKeyword("NOT");
    cursor.expectKeyword("EXISTS");
    const indexName = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(indexName, options.tablePrefix);
    cursor.expectKeyword("ON");
    const table = cursor.readIdentifier();
    assertOwnedMigrationIdentifier(table, options.tablePrefix);
    cursor.expectSymbol("(");
    const closing = matchingParenIndex(tokens, cursor.position - 1);
    if (closing === cursor.position) throw new HttpError(400, "unsupported_migration_statement");
    const trailing = tokens.slice(closing + 1);
    if (trailing.length > 0 && (!isKeyword(trailing[0], "WHERE") || trailing.length === 1)) {
      throw new HttpError(400, "unsupported_migration_statement");
    }
    assertNoQueryKeywords(tokens.slice(cursor.position, closing));
    assertNoQueryKeywords(trailing);
    return { category: "schema", table, type: "create_index" };
  }

  throw new HttpError(400, "unsupported_migration_statement");
}

function validateAlterTable(tokens: SqlToken[], options: MigrationValidationOptions): MigrationStatementAnalysis {
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("ALTER");
  cursor.expectKeyword("TABLE");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, options.tablePrefix);
  cursor.expectKeyword("ADD");
  cursor.expectKeyword("COLUMN");
  cursor.readIdentifier();
  if (cursor.done()) throw new HttpError(400, "unsupported_migration_statement");
  const definition = tokens.slice(cursor.position);
  assertOwnedReferences(definition, options.tablePrefix);
  assertNoQueryKeywords(definition);
  if (definition.some((token) => token.kind === "word" && ALTER_DEFINITION_STATEMENT_KEYWORDS.has(token.upper!))) {
    throw new HttpError(400, "unsupported_migration_statement");
  }
  return { category: "schema", table, type: "alter_table" };
}

function validateInsert(tokens: SqlToken[], options: MigrationValidationOptions): MigrationStatementAnalysis {
  requireDataMigrationApproval(options.allowDataMigrations);
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("INSERT");
  cursor.expectKeyword("INTO");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, options.tablePrefix);
  rejectQualifiedTarget(cursor);
  assertNoDataQueryKeywords(tokens.slice(cursor.position));

  if (cursor.peekSymbol("(")) cursor.skipBalancedGroup();
  cursor.expectKeyword("VALUES", "data_migration_insert_values_required");
  if (!cursor.peekSymbol("(")) throw new HttpError(400, "data_migration_insert_values_required");
  cursor.skipBalancedGroup();
  while (cursor.matchSymbol(",")) {
    if (!cursor.peekSymbol("(")) throw new HttpError(400, "data_migration_insert_values_required");
    cursor.skipBalancedGroup();
  }

  if (cursor.done()) return { category: "data", table, type: "insert" };
  cursor.expectKeyword("ON", "invalid_data_migration_upsert");
  cursor.expectKeyword("CONFLICT", "invalid_data_migration_upsert");
  if (cursor.peekSymbol("(")) cursor.skipBalancedGroup();
  if (cursor.matchKeyword("WHERE")) {
    const doIndex = findTopLevelKeyword(tokens, "DO", cursor.position);
    if (doIndex <= cursor.position) throw new HttpError(400, "invalid_data_migration_upsert");
    cursor.position = doIndex;
  }
  cursor.expectKeyword("DO", "invalid_data_migration_upsert");
  if (cursor.matchKeyword("NOTHING")) {
    if (!cursor.done()) throw new HttpError(400, "invalid_data_migration_upsert");
    return { category: "data", table, type: "insert" };
  }
  cursor.expectKeyword("UPDATE", "invalid_data_migration_upsert");
  cursor.expectKeyword("SET", "invalid_data_migration_upsert");
  if (cursor.done()) throw new HttpError(400, "invalid_data_migration_upsert");
  return { category: "data", table, type: "insert" };
}

function validateUpdate(tokens: SqlToken[], options: MigrationValidationOptions): MigrationStatementAnalysis {
  requireDataMigrationApproval(options.allowDataMigrations);
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("UPDATE");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, options.tablePrefix);
  rejectQualifiedTarget(cursor);
  cursor.expectKeyword("SET");
  assertNoDataQueryKeywords(tokens.slice(cursor.position));
  const whereIndex = findTopLevelKeyword(tokens, "WHERE", cursor.position);
  if (whereIndex < 0 || whereIndex === tokens.length - 1) {
    throw new HttpError(400, "data_migration_where_required");
  }
  if (whereIndex === cursor.position) throw new HttpError(400, "unsupported_migration_statement");
  return { category: "data", table, type: "update" };
}

function validateDelete(tokens: SqlToken[], options: MigrationValidationOptions): MigrationStatementAnalysis {
  requireDataMigrationApproval(options.allowDataMigrations);
  const cursor = new TokenCursor(tokens);
  cursor.expectKeyword("DELETE");
  cursor.expectKeyword("FROM");
  const table = cursor.readIdentifier();
  assertOwnedMigrationIdentifier(table, options.tablePrefix);
  rejectQualifiedTarget(cursor);
  assertNoDataQueryKeywords(tokens.slice(cursor.position));
  const whereIndex = findTopLevelKeyword(tokens, "WHERE", cursor.position);
  if (whereIndex < 0 || whereIndex === tokens.length - 1) {
    throw new HttpError(400, "data_migration_where_required");
  }
  if (whereIndex !== cursor.position) throw new HttpError(400, "unsupported_migration_statement");
  return { category: "data", table, type: "delete" };
}

function tokenizeSql(statement: string) {
  const tokens: SqlToken[] = [];
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
      if (!terminated) throw new HttpError(400, "unterminated_migration_literal");
      tokens.push({ kind: "string", text: statement.slice(start, index) });
      continue;
    }
    if (char === "\"" || char === "`" || char === "[") {
      throw new HttpError(400, "quoted_migration_identifier_not_allowed");
    }
    if (isSymbolStart(char)) {
      const pair = statement.slice(index, index + 2);
      const symbol = isTwoCharacterSymbol(pair) ? pair : char;
      tokens.push({ kind: "symbol", text: symbol });
      index += symbol.length;
      continue;
    }
    throw new HttpError(400, "unsupported_migration_token");
  }
  assertBalancedParentheses(tokens);
  return tokens;
}

class TokenCursor {
  position = 0;

  constructor(private readonly tokens: SqlToken[]) {}

  done() {
    return this.position >= this.tokens.length;
  }

  expectKeyword(keyword: string, code = "unsupported_migration_statement") {
    if (!this.matchKeyword(keyword)) throw new HttpError(400, code);
  }

  expectSymbol(symbol: string) {
    if (!this.matchSymbol(symbol)) throw new HttpError(400, "unsupported_migration_statement");
  }

  matchKeyword(keyword: string) {
    if (!isKeyword(this.tokens[this.position], keyword)) return false;
    this.position += 1;
    return true;
  }

  matchSymbol(symbol: string) {
    if (!this.peekSymbol(symbol)) return false;
    this.position += 1;
    return true;
  }

  peekSymbol(symbol: string) {
    const token = this.tokens[this.position];
    return token?.kind === "symbol" && token.text === symbol;
  }

  readIdentifier() {
    const token = this.tokens[this.position];
    if (token?.kind !== "word") throw new HttpError(400, "unsupported_migration_statement");
    this.position += 1;
    return token.text;
  }

  skipBalancedGroup() {
    if (!this.peekSymbol("(")) throw new HttpError(400, "unsupported_migration_statement");
    this.position = matchingParenIndex(this.tokens, this.position) + 1;
  }
}

function rejectQualifiedTarget(cursor: TokenCursor) {
  if (cursor.peekSymbol(".")) {
    throw new HttpError(400, "data_migration_cross_resource_query_not_allowed");
  }
}

function rejectAdministrativeKeywords(tokens: SqlToken[]) {
  if (tokens.some((token) => token.kind === "word" && ADMINISTRATIVE_KEYWORDS.has(token.upper!))) {
    throw new HttpError(400, "unsupported_migration_statement");
  }
}

function assertNoQueryKeywords(tokens: SqlToken[]) {
  if (tokens.some((token) => token.kind === "word" && CROSS_TABLE_QUERY_KEYWORDS.has(token.upper!))) {
    throw new HttpError(400, "data_migration_cross_resource_query_not_allowed");
  }
}

function assertNoDataQueryKeywords(tokens: SqlToken[]) {
  if (tokens.some((token) => token.kind === "word" && (token.upper === "FROM" || CROSS_TABLE_QUERY_KEYWORDS.has(token.upper!)))) {
    throw new HttpError(400, "data_migration_cross_resource_query_not_allowed");
  }
}

function assertOwnedReferences(tokens: SqlToken[], tablePrefix: string) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isKeyword(tokens[index], "REFERENCES")) continue;
    const referenced = tokens[index + 1];
    if (referenced?.kind !== "word") throw new HttpError(400, "unsupported_migration_statement");
    assertOwnedMigrationIdentifier(referenced.text, tablePrefix);
    if (tokens[index + 2]?.kind === "symbol" && tokens[index + 2]?.text === ".") {
      throw new HttpError(400, "data_migration_cross_resource_query_not_allowed");
    }
  }
}

function requireDataMigrationApproval(approved: boolean) {
  if (!approved) throw new HttpError(409, "data_migration_approval_required");
}

function assertOwnedMigrationIdentifier(identifier: string, tablePrefix: string) {
  const normalized = identifier.toLowerCase();
  if (normalized.startsWith("sqlite_")) throw new HttpError(400, "reserved_migration_identifier");
  if (!normalized.startsWith(tablePrefix)) throw new HttpError(400, "migration_table_outside_app_prefix");
}

function assertBalancedParentheses(tokens: SqlToken[]) {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== "symbol") continue;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth < 0) throw new HttpError(400, "unbalanced_migration_parentheses");
  }
  if (depth !== 0) throw new HttpError(400, "unbalanced_migration_parentheses");
}

function matchingParenIndex(tokens: SqlToken[], openingIndex: number) {
  if (tokens[openingIndex]?.kind !== "symbol" || tokens[openingIndex]?.text !== "(") {
    throw new HttpError(400, "unsupported_migration_statement");
  }
  let depth = 0;
  for (let index = openingIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "symbol") continue;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth -= 1;
    if (depth === 0) return index;
  }
  throw new HttpError(400, "unbalanced_migration_parentheses");
}

function findTopLevelKeyword(tokens: SqlToken[], keyword: string, start: number) {
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

function readNumberEnd(value: string, start: number) {
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

function isIdentifierStart(char: string | undefined) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return char === "_" || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(char: string | undefined) {
  return isIdentifierStart(char) || isDigit(char);
}

function isDigit(char: string | undefined) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHexDigit(char: string | undefined) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return isDigit(char) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isWhitespace(char: string | undefined) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function isSymbolStart(char: string | undefined) {
  return Boolean(char && "(),.=+-*/%<>!|&~".includes(char));
}

function isTwoCharacterSymbol(value: string) {
  return value === "<=" || value === ">=" || value === "!=" || value === "<>" || value === "=="
    || value === "||" || value === "<<" || value === ">>";
}

function isKeyword(token: SqlToken | undefined, keyword: string) {
  return token?.kind === "word" && token.upper === keyword;
}
