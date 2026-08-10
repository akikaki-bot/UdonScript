import ts from "typescript";

function isComptimeCall(node: ts.Expression): boolean {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "comptime";
}

function hasComptimeDecorator(node: ts.MethodDeclaration): boolean {
  if (!ts.canHaveDecorators(node)) return false;
  return (ts.getDecorators(node) ?? []).some((decorator) =>
    ts.isIdentifier(decorator.expression) && decorator.expression.text === "comptime");
}

function isComptimeReference(node: ts.Node): boolean {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent) && isComptimeCall(parent) &&
      parent.arguments.some((argument) => argument === current)) return true;
    if (ts.isMethodDeclaration(parent) && hasComptimeDecorator(parent)) return true;
    current = parent;
  }
  return false;
}

function referencedDeclaration(checker: ts.TypeChecker, node: ts.Node): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.valueDeclaration ?? symbol.declarations?.find(ts.isVariableDeclaration);
}

function isModuleBinding(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
}

/** Finds comptime-created globals whose references can never escape into runtime UASM. */
export function findComptimeOnlyGlobals(
  sourceFile: ts.SourceFile,
  dependencies: readonly ts.SourceFile[] = [],
  checker?: ts.TypeChecker
): ReadonlySet<ts.VariableDeclaration> {
  const files = [sourceFile, ...dependencies];
  const candidates: ts.VariableDeclaration[] = [];
  for (const file of files) {
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && isComptimeCall(declaration.initializer)) {
          candidates.push(declaration);
        }
      }
    }
  }
  if (candidates.length === 0) return new Set();

  const candidateSet = new Set(candidates);
  const candidatesByName = new Map<string, ts.VariableDeclaration[]>();
  for (const candidate of candidates) {
    const name = (candidate.name as ts.Identifier).text;
    const named = candidatesByName.get(name) ?? [];
    named.push(candidate);
    candidatesByName.set(name, named);
  }

  const runtimeReferences = new Set<ts.VariableDeclaration>();
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const resolved = checker ? referencedDeclaration(checker, node) : undefined;
        const matched = resolved && ts.isVariableDeclaration(resolved) && candidateSet.has(resolved)
          ? [resolved]
          : checker ? [] : candidatesByName.get(node.text) ?? [];
        for (const candidate of matched) {
          if (node !== candidate.name && !isModuleBinding(node) && !isComptimeReference(node)) {
            runtimeReferences.add(candidate);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return new Set(candidates.filter((candidate) => !runtimeReferences.has(candidate)));
}
