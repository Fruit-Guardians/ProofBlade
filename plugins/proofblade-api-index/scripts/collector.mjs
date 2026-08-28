import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import * as ts from "typescript";

export const PACKAGE_CONFIGS = {
  atoms: { name: "@proofblade/atoms", root: "packages/atoms" },
  molecules: { name: "@proofblade/molecules", root: "packages/molecules" },
  materials: { name: "@proofblade/materials", root: "packages/materials" },
};

export function collectApi({ repoRoot, packageId = "atoms" }) {
  const config = PACKAGE_CONFIGS[packageId];
  if (!config) throw new Error(`Unknown package: ${packageId}`);
  // TypeScript's module/documentation resolution can retain the path spelling
  // used to open a checkout.  On Windows a junction therefore makes the same
  // source file appear under a second identity, which changes documentation
  // lookup (for example tsdoc versus inferred summaries).  Resolve every
  // filesystem root before creating the Program so canonical and junction
  // workspaces share one source identity.
  const canonicalRepoRoot = canonicalPath(repoRoot);
  const packageRoot = canonicalPath(resolve(canonicalRepoRoot, config.root));
  const foundTsconfigPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, "tsconfig.json");
  const tsconfigPath = foundTsconfigPath ? canonicalPath(foundTsconfigPath) : undefined;
  if (!tsconfigPath) throw new Error(`Missing tsconfig.json for ${packageId}`);
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) throw new Error(formatDiagnostics([configFile.error]));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
  const fileNames = [...new Set(parsed.fileNames.map((file) => canonicalPath(file)))];
  const program = ts.createProgram(fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const indexPath = resolve(packageRoot, "src/index.ts");
  const indexSource = program.getSourceFile(indexPath);
  if (!indexSource) throw new Error(`Missing public entry: ${config.root}/src/index.ts`);
  const moduleSymbol = checker.getSymbolAtLocation(indexSource);
  if (!moduleSymbol) throw new Error(`Unable to resolve public entry: ${indexPath}`);
  const testFiles = findTestFiles(join(packageRoot, "tests"), canonicalRepoRoot);
  const symbols = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = declarationInPackage(symbol, packageRoot);
    if (!declaration) continue;
    const item = describeSymbol(symbol, declaration, checker, packageRoot, config.name, testFiles);
    if (item) symbols.push(item);
    if (item?.kind === "class") symbols.push(...describeMethods(symbol, declaration, checker, packageRoot, config.name, testFiles, item));
  }
  symbols.sort(compareSymbols);
  return {
    schemaVersion: 1,
    package: config.name,
    packageId,
    sourceRoot: config.root,
    moduleHashes: moduleHashes(packageRoot, fileNames),
    symbols,
  };
}

function describeSymbol(symbol, declaration, checker, packageRoot, packageName, testFiles) {
  const sourceFile = declaration.getSourceFile();
  const kind = symbolKind(symbol, declaration);
  if (!kind) return undefined;
  const name = symbol.getName();
  const position = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
  const docs = documentation(symbol, checker);
  const signature = signatureOf(symbol, declaration, checker, packageRoot);
  const module = normalize(relative(packageRoot, sourceFile.fileName));
  const summary = docs.summary || inferSummary(name, kind, declaration);
  return {
    id: `${packageName}::${kind}::${name}`,
    name,
    kind,
    visibility: "public",
    module,
    exportPath: packageName,
    line: position.line + 1,
    signature,
    summary,
    summarySource: docs.summary ? "tsdoc" : "inferred",
    tags: docs.tags,
    imports: importsOf(sourceFile),
    testRefs: testFiles.filter((file) => file.text.includes(name)).map((file) => file.path),
    structureHash: structureHash(declaration),
  };
}

function describeMethods(classSymbol, classDeclaration, checker, packageRoot, packageName, testFiles, parent) {
  const methods = [];
  for (const member of classDeclaration.members ?? []) {
    if (!ts.isMethodDeclaration(member) || !member.name || isPrivate(member)) continue;
    const methodSymbol = checker.getSymbolAtLocation(member.name);
    if (!methodSymbol) continue;
    const name = `${parent.name}.${member.name.getText()}`;
    const sourceFile = member.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
    const docs = documentation(methodSymbol, checker);
    const summary = docs.summary || inferSummary(name, "method", member);
    methods.push({
      id: `${packageName}::method::${name}`,
      name,
      kind: "method",
      visibility: "public",
      module: normalize(relative(packageRoot, sourceFile.fileName)),
      exportPath: packageName,
      line: position.line + 1,
      signature: signatureOf(methodSymbol, member, checker, packageRoot),
      summary,
      summarySource: docs.summary ? "tsdoc" : "inferred",
      tags: docs.tags,
      imports: importsOf(sourceFile),
      testRefs: testFiles.filter((file) => file.text.includes(member.name.getText())).map((file) => file.path),
      structureHash: structureHash(member),
      parentId: parent.id,
    });
  }
  return methods;
}

function declarationInPackage(symbol, packageRoot) {
  return (symbol.declarations ?? []).find((declaration) => {
    const file = resolve(declaration.getSourceFile().fileName);
    return file.startsWith(`${resolve(packageRoot)}\\`) || file.startsWith(`${resolve(packageRoot)}/`);
  });
}

function symbolKind(symbol, declaration) {
  if (ts.isFunctionDeclaration(declaration) || symbol.flags & ts.SymbolFlags.Function) return "function";
  if (ts.isClassDeclaration(declaration) || symbol.flags & ts.SymbolFlags.Class) return "class";
  if (ts.isInterfaceDeclaration(declaration) || symbol.flags & ts.SymbolFlags.Interface) return "interface";
  if (ts.isTypeAliasDeclaration(declaration) || symbol.flags & ts.SymbolFlags.TypeAlias) return "type";
  if (ts.isEnumDeclaration(declaration) || symbol.flags & ts.SymbolFlags.Enum) return "enum";
  if (ts.isVariableDeclaration(declaration) || symbol.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.FunctionScopedVariable)) return "constant";
  return undefined;
}

function signatureOf(symbol, declaration, checker, packageRoot) {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration)) {
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (signature) return normalizeSignature(checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation), packageRoot);
  }
  const type = checker.getTypeAtLocation(declaration);
  return normalizeSignature(checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation), packageRoot);
}

/**
 * TypeScript prints imported types with the absolute file name used by the
 * current checkout.  Keep generated API indexes portable by expressing those
 * imports relative to the package root instead.
 */
function normalizeSignature(signature, packageRoot) {
  return signature.replace(/import\("([^"]+)"\)/g, (full, importedPath) => {
    if (!isAbsolute(importedPath)) return full;
    const file = resolve(importedPath);
    if (!isInside(packageRoot, file)) return full;
    const modulePath = normalize(relative(packageRoot, file)).replace(/\.d?\.(?:ts|tsx)$/, "");
    return `import("./${modulePath.replace(/^\.\//, "")}")`;
  });
}

function documentation(symbol, checker) {
  const summary = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim().split(/\r?\n/)[0] ?? "";
  const tags = symbol.getJsDocTags(checker).map((tag) => ({ name: tag.name, text: typeof tag.text === "string" ? tag.text : ts.displayPartsToString(tag.text ?? []) }));
  return { summary, tags };
}

function inferSummary(name, kind, declaration) {
  const leaf = name.split(".").at(-1) ?? name;
  const words = leaf.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().trim();
  const body = declaration.body?.getText() ?? "";
  const behavior = /dispatch|append|write|save|persist|create|insert|add/i.test(body)
    ? "perform a durable write"
    : /read|load|snapshot|replay|search|list|find/i.test(body)
      ? "read or inspect state"
      : /validate|assert|check|verify/i.test(body)
        ? "validate input or state"
        : /hash|digest|canonical|serialize/i.test(`${name} ${body}`)
          ? "produce a deterministic value"
          : "provide a reusable operation";
  const subject = kind === "class" ? "class" : kind === "interface" || kind === "type" ? "type contract" : kind === "constant" ? "constant" : "operation";
  return `Inferred summary: ${words || name} ${subject} used to ${behavior}.`;
}

function importsOf(sourceFile) {
  const imports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) imports.push(statement.moduleSpecifier.text);
  }
  return [...new Set(imports)].sort();
}

function structureHash(node) {
  if (!node.body) return undefined;
  const body = node.body.getText().replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "<str>").replace(/\b\d+(?:\.\d+)?\b/g, "<num>").replace(/\s+/g, " ").trim();
  return body.length < 24 ? undefined : sha256(body);
}

function moduleHashes(packageRoot, fileNames) {
  return Object.fromEntries(fileNames
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts") && isInside(packageRoot, name))
    .sort()
    .map((file) => [normalize(relative(packageRoot, file)), sha256(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))]));
}

function findTestFiles(directory, repoRoot) {
  if (!existsSync(directory)) return [];
  const files = [];
  walk(directory, files);
  return files.sort().map((file) => ({ path: normalize(relative(repoRoot, file)), text: readFileSync(file, "utf8") }));
}

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (/\.test\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
  }
}

function isPrivate(member) {
  return member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) ?? false;
}

function compareSymbols(left, right) {
  return left.visibility.localeCompare(right.visibility) || left.kind.localeCompare(right.kind) || left.module.localeCompare(right.module) || left.name.localeCompare(right.name) || left.signature.localeCompare(right.signature);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    // Keep diagnostics useful for virtual/non-existent compiler inputs while
    // still normalizing relative spellings.
    return resolve(path);
  }
}

function isInside(root, file) {
  const relativePath = relative(resolve(root), resolve(file));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":"));
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (file) => file, getNewLine: () => "\n" });
}
