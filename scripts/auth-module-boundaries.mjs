import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const handlerDirectories = ["apps/", "directory/", "identity/", "login/", "mcp/", "notifications/", "resources/", "session/"];

export function inspectAuthModuleBoundaries(files) {
  const graph = new Map();
  const problems = [];
  const pathFor = (from, specifier) => {
    if (!specifier.startsWith(".")) return undefined;
    const candidate = relative("/auth", resolve("/auth", dirname(from), specifier)).replaceAll("\\", "/");
    return [candidate, candidate.replace(/\.js$/, ".ts"), `${candidate}.ts`, `${candidate}/index.ts`]
      .find((path) => files.has(path)) ?? candidate;
  };
  const edge = (from, specifier, runtime) => {
    const target = pathFor(from, specifier);
    if (!target) return;
    if (target === "index.ts" && from !== target) problems.push(`${from} imports the route entrypoint`);
    if (from.startsWith("repositories/") && !target.startsWith("repositories/")
      && target !== "types.ts" && target !== "invitationEmail.ts") {
      problems.push(`${from} imports ${target} outside persistence ownership`);
    }
    if (handlerDirectories.some((prefix) => from.startsWith(prefix)) && target === "repository.ts") {
      problems.push(`${from} imports the compatibility facade instead of its repository owner`);
    }
    if (runtime && graph.has(target)) graph.get(from).add(target);
  };

  for (const path of files.keys()) graph.set(path, new Set());
  for (const [path, text] of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (path === "repository.ts" && source.statements.some((statement) => !ts.isExportDeclaration(statement) || !statement.moduleSpecifier)) {
      problems.push("repository.ts must remain a re-export compatibility facade");
    }
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node;
        const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
        const defaultImport = ts.isImportDeclaration(node) && clause?.name;
        const allBindingsAreTypes = !defaultImport && bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          && bindings.elements.length > 0 && bindings.elements.every((binding) => binding.isTypeOnly);
        edge(path, node.moduleSpecifier.text, !clause?.isTypeOnly && !allBindingsAreTypes);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
        edge(path, node.arguments[0].text, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const active = new Set();
  const finished = new Set();
  const visit = (path, trail) => {
    if (active.has(path)) {
      problems.push(`runtime dependency cycle: ${[...trail.slice(trail.indexOf(path)), path].join(" -> ")}`);
      return;
    }
    if (finished.has(path)) return;
    active.add(path);
    for (const target of graph.get(path)) visit(target, [...trail, path]);
    active.delete(path);
    finished.add(path);
  };
  for (const path of graph.keys()) visit(path, []);
  return { moduleCount: files.size, problems: [...new Set(problems)] };
}

async function readModules(directory, root = directory, files = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await readModules(path, root, files);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.set(relative(root, path).replaceAll("\\", "/"), await readFile(path, "utf8"));
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectAuthModuleBoundaries(await readModules(fileURLToPath(new URL("../workers/auth/src", import.meta.url))));
  if (result.problems.length) {
    console.error(result.problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Verified ${result.moduleCount} Auth modules: persistence ownership, compatibility facade and no runtime cycles.`);
  }
}
