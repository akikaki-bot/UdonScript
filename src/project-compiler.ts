import ts from "typescript";
import { basename, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { compileSourceFile } from "./compiler/index.js";
import type { BehaviorDefinition, CompilerProjectContext } from "./compiler/project-context.js";
import type { CompileOptions, Diagnostic, ProjectCompileResult } from "./model.js";

function normalized(fileName: string): string {
  return normalize(resolve(fileName));
}

function diagnostic(file: ts.SourceFile, node: ts.Node, message: string): Diagnostic {
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return {
    file: file.fileName,
    line: position.line + 1,
    column: position.character + 1,
    message
  };
}

function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const unique = new Map<string, Diagnostic>();
  for (const item of diagnostics) {
    const key = `${normalized(item.file)}:${item.line}:${item.column}:${item.message}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function extendsUdonBehaviour(node: ts.ClassDeclaration): boolean {
  return node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword &&
    clause.types.some((type) => ts.isIdentifier(type.expression) && type.expression.text === "UdonBehaviour")) ?? false;
}

function hasUdonVariableDecorator(node: ts.PropertyDeclaration): boolean {
  if (!ts.canHaveDecorators(node)) return false;
  return (ts.getDecorators(node) ?? []).some((decorator) => {
    const expression = decorator.expression;
    return (ts.isIdentifier(expression) && expression.text === "udonVariable") ||
      (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
        expression.expression.text === "udonVariable");
  });
}

function behaviorDefinition(node: ts.ClassDeclaration): BehaviorDefinition | undefined {
  if (!extendsUdonBehaviour(node)) return undefined;
  const name = node.name?.text ?? "default";
  const methods = new Map<string, ts.MethodDeclaration>();
  const fields = new Map<string, ts.PropertyDeclaration>();
  for (const member of node.members) {
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) continue;
    if (ts.isMethodDeclaration(member)) methods.set(member.name.text, member);
    if (ts.isPropertyDeclaration(member) && hasUdonVariableDecorator(member)) {
      fields.set(member.name.text, member);
    }
  }
  const sourceFile = node.getSourceFile();
  return {
    id: `${normalized(sourceFile.fileName)}#${name}`,
    name,
    sourceFile,
    declaration: node,
    methods,
    fields
  };
}

function importedSourceFiles(program: ts.Program, entry: ts.SourceFile): {
  files: ts.SourceFile[];
  dependenciesBySource: Map<ts.SourceFile, readonly ts.SourceFile[]>;
  diagnostics: Diagnostic[];
} {
  const compilerOptions = program.getCompilerOptions();
  const completed = new Set<string>();
  const activeIndexes = new Map<string, number>();
  const activeFiles: ts.SourceFile[] = [];
  const files: ts.SourceFile[] = [];
  const directDependencies = new Map<ts.SourceFile, ts.SourceFile[]>();
  const diagnostics: Diagnostic[] = [];

  const visit = (sourceFile: ts.SourceFile): void => {
    const key = normalized(sourceFile.fileName);
    if (completed.has(key)) return;
    activeIndexes.set(key, activeFiles.length);
    activeFiles.push(sourceFile);
    const dependencies: ts.SourceFile[] = [];
    for (const statement of sourceFile.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) {
        diagnostics.push(diagnostic(
          sourceFile,
          statement.moduleSpecifier,
          `UdonScriptの実行モジュールでは相対importだけを使用できます: '${specifier}'`
        ));
        continue;
      }
      const resolvedModule = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule;
      if (!resolvedModule) {
        diagnostics.push(diagnostic(sourceFile, statement.moduleSpecifier, `import '${specifier}' を解決できません`));
        continue;
      }
      const dependency = program.getSourceFile(normalized(resolvedModule.resolvedFileName))
        ?? program.getSourceFile(resolvedModule.resolvedFileName);
      if (!dependency || dependency.isDeclarationFile) {
        diagnostics.push(diagnostic(sourceFile, statement.moduleSpecifier, `import '${specifier}' は実行可能な.tsファイルではありません`));
        continue;
      }
      if (!dependencies.includes(dependency)) dependencies.push(dependency);
      const dependencyKey = normalized(dependency.fileName);
      const cycleStart = activeIndexes.get(dependencyKey);
      if (cycleStart !== undefined) {
        const cycle = [...activeFiles.slice(cycleStart), dependency]
          .map((file) => relative(dirname(entry.fileName), file.fileName).replaceAll("\\", "/") || basename(file.fileName))
          .join(" -> ");
        diagnostics.push(diagnostic(
          sourceFile,
          statement.moduleSpecifier,
          `Warning: 循環importを検出しました: ${cycle}。循環importはCompileErrorです`
        ));
        continue;
      }
      visit(dependency);
    }
    activeFiles.pop();
    activeIndexes.delete(key);
    completed.add(key);
    directDependencies.set(sourceFile, dependencies);
    files.push(sourceFile);
  };
  visit(entry);

  const dependenciesBySource = new Map<ts.SourceFile, readonly ts.SourceFile[]>();
  for (const sourceFile of files) {
    const dependencies: ts.SourceFile[] = [];
    const dependencySeen = new Set<ts.SourceFile>([sourceFile]);
    const collect = (current: ts.SourceFile): void => {
      for (const dependency of directDependencies.get(current) ?? []) {
        if (dependencySeen.has(dependency)) continue;
        dependencySeen.add(dependency);
        collect(dependency);
        dependencies.push(dependency);
      }
    };
    collect(sourceFile);
    dependenciesBySource.set(sourceFile, dependencies);
  }
  return { files, dependenciesBySource, diagnostics };
}

/** Compiles an entry module and every relative TypeScript module reachable from it. */
export function compileProject(entryFile: string, options: CompileOptions = {}): ProjectCompileResult {
  const entryPath = normalized(entryFile);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true
  };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const text = ts.sys.readFile(fileName);
    if (text === undefined) {
      onError?.(`ファイルを読み込めません: ${fileName}`);
      return undefined;
    }
    return ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram([entryPath], compilerOptions, host);
  const entry = program.getSourceFile(entryPath);
  if (!entry) {
    return {
      artifacts: [],
      diagnostics: [{ file: entryPath, line: 1, column: 1, message: "入力ファイルを読み込めません" }]
    };
  }

  const graph = importedSourceFiles(program, entry);
  const behaviorsByDeclaration = new Map<ts.ClassDeclaration, BehaviorDefinition>();
  const behaviorsById = new Map<string, BehaviorDefinition>();
  for (const sourceFile of graph.files) {
    const behaviors = sourceFile.statements
      .filter(ts.isClassDeclaration)
      .map(behaviorDefinition)
      .filter((value): value is BehaviorDefinition => Boolean(value));
    if (behaviors.length > 1) {
      graph.diagnostics.push(diagnostic(
        sourceFile,
        behaviors[1]!.declaration,
        "1つの.tsファイルにはUdonBehaviourクラスを1つだけ定義してください"
      ));
    }
    for (const behavior of behaviors) {
      behaviorsByDeclaration.set(behavior.declaration, behavior);
      behaviorsById.set(behavior.id, behavior);
    }
  }
  if (graph.diagnostics.length > 0) return { artifacts: [], diagnostics: uniqueDiagnostics(graph.diagnostics) };

  const project: CompilerProjectContext = {
    checker: program.getTypeChecker(),
    dependenciesBySource: graph.dependenciesBySource,
    behaviorsByDeclaration,
    behaviorsById
  };
  const artifacts = [];
  const diagnostics: Diagnostic[] = [];
  for (const sourceFile of graph.files) {
    const result = compileSourceFile(sourceFile, options, project);
    diagnostics.push(...result.diagnostics);
    artifacts.push({ sourceFile: normalized(sourceFile.fileName), assembly: result.assembly });
  }
  const unique = uniqueDiagnostics(diagnostics);
  return { artifacts: unique.length > 0 ? [] : artifacts, diagnostics: unique };
}

export function defaultAssemblyPath(sourceFile: string): string {
  const extension = extname(sourceFile);
  return resolve(join(dirname(sourceFile), `${basename(sourceFile, extension)}.uasm`));
}
