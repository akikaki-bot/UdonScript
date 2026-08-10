import ts from "typescript";
import { ArrayLowerer, arrayExterns } from "./array-lowering.js";
import { AssemblyBuilder, type AllocationOptions, sanitizeSymbol } from "./assembly-builder.js";
import {
  type FlowContext,
  type FunctionInfo,
  type FunctionNode,
  type GlobalDeclaration,
  Scope,
  type SyncMode,
  type ValueRef
} from "./compiler-context.js";
import { eventsBySourceName } from "../events.js";
import { ExpressionTypeInferer } from "./expression-type-inference.js";
import { EventEmitterParser } from "./event-emitter.js";
import { UdonVariableParser, type UdonVariableMarker } from "./udon-variable.js";
import {
  ComptimeEvaluator,
  type ComptimeConstant,
  type ComptimeValue,
  encodeComptimeScalar
} from "./comptime-evaluator.js";
import { InlineOptimizer } from "./inline-optimizer.js";
import { findComptimeOnlyGlobals } from "./comptime-usage.js";
import type { BehaviorDefinition, CompilerProjectContext } from "./project-context.js";
import { binaryExtern, ExternRegistry, unaryExtern } from "../extern-registry.js";
import type {
  CompileOptions,
  CompileResult,
  Diagnostic,
  EventDefinition,
  ExternDefinition,
  UdonType
} from "../model.js";
import { defaultValue, escapeString, isArray, isNumeric, sourceTypeName, typeFromAnnotation } from "../type-system.js";

class CompileFailure extends Error {
  constructor(message: string, readonly node: ts.Node) { super(message); }
}

const eventExterns = {
  emit: "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEvent__SystemString__SystemVoid",
  delayedSeconds: "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEventDelayedSeconds__SystemString_SystemSingle_VRCUdonCommonEnumsEventTiming__SystemVoid",
  delayedFrames: "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEventDelayedFrames__SystemString_SystemInt32_VRCUdonCommonEnumsEventTiming__SystemVoid",
  network: "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomNetworkEvent__VRCUdonCommonInterfacesNetworkEventTarget_SystemString__SystemVoid"
} as const;

class Compiler {
  private readonly sourceFile: ts.SourceFile;
  private readonly registry: ExternRegistry;
  private readonly typeInference: ExpressionTypeInferer;
  private readonly arrays: ArrayLowerer;
  private readonly eventEmitter: EventEmitterParser;
  private readonly udonVariables: UdonVariableParser;
  private readonly comptime: ComptimeEvaluator;
  private readonly inlineOptimizer: InlineOptimizer;
  private readonly selfReceiver: ValueRef;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly assembly: AssemblyBuilder;
  private readonly functions = new Map<string, FunctionInfo>();
  private readonly entries: FunctionInfo[] = [];
  private readonly eventNameValues = new Map<string, ValueRef>();
  private readonly globalScope = new Scope();
  private readonly globalInitializers: Array<{ declaration: GlobalDeclaration; initializer: ts.Expression; target: ValueRef }> = [];
  private readonly callStack: FunctionInfo[] = [];
  private updateEventTiming?: ValueRef;
  private networkTargetAll?: ValueRef;
  private readonly project: CompilerProjectContext | undefined;
  private readonly functionsByDeclaration = new Map<ts.Declaration, FunctionInfo>();
  private readonly globalsByDeclaration = new Map<ts.VariableDeclaration, ValueRef>();
  private readonly comptimeOnlyGlobals: ReadonlySet<ts.VariableDeclaration>;

  constructor(source: string | ts.SourceFile, private readonly options: CompileOptions, project?: CompilerProjectContext) {
    const fileName = options.fileName ?? "input.ts";
    this.sourceFile = typeof source === "string"
      ? ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      : source;
    this.project = project;
    this.comptimeOnlyGlobals = findComptimeOnlyGlobals(
      this.sourceFile,
      this.project?.dependenciesBySource.get(this.sourceFile) ?? [],
      this.project?.checker
    );
    this.assembly = new AssemblyBuilder(options.optimize !== false);
    this.registry = new ExternRegistry(options.externs);
    this.typeInference = new ExpressionTypeInferer({
      functionReturnType: (name) => this.functions.get(name)?.returnType,
      externReturnType: (owner, member, kind) => this.registry.find(owner, member, kind)?.returns,
      staticOwner: (node) => this.staticOwnerFromExpression(node),
      requireType: (node) => this.requireType(node)
    });
    this.arrays = new ArrayLowerer({
      compileExpression: (node, scope, expected, flow) => this.compileExpression(node, scope, expected, flow),
      inferExpressionType: (node, scope) => this.inferExpressionType(node, scope),
      allocate: (base, type, initial) => this.allocate(base, type, initial),
      emitExtern: (signature, args, output) => this.emitExtern(signature, args, output),
      assertAssignable: (actual, expected, node) => this.assertAssignable(actual, expected, node),
      requireType: (node) => this.requireType(node),
      fail: (message, node) => this.fail(message, node)
    });
    this.eventEmitter = new EventEmitterParser((message, node) => this.fail(message, node));
    this.udonVariables = new UdonVariableParser((message, node) => this.fail(message, node));
    this.comptime = new ComptimeEvaluator({
      resolveFunction: (call) => this.resolveComptimeFunction(call),
      resolveConstant: (identifier) => this.resolveComptimeConstant(identifier),
      requireType: (node) => this.requireType(node),
      fail: (message, node) => this.fail(message, node)
    });
    this.inlineOptimizer = new InlineOptimizer({
      externs: this.registry.definitions,
      resolveFunction: (call) => this.resolveComptimeFunction(call),
      isComptimeCall: (node) => this.isComptimeCall(node)
    });
    this.selfReceiver = this.allocate(
      "__this_udonBehaviour",
      "VRCUdonUdonBehaviour",
      "this",
      { exact: true }
    );
  }

  compile(): CompileResult {
    const parseDiagnostics = (this.sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    for (const parseDiagnostic of parseDiagnostics) {
      const start = parseDiagnostic.start ?? 0;
      const position = this.sourceFile.getLineAndCharacterOfPosition(start);
      this.diagnostics.push({
        file: this.sourceFile.fileName,
        line: position.line + 1,
        column: position.character + 1,
        message: ts.flattenDiagnosticMessageText(parseDiagnostic.messageText, "\n")
      });
    }
    if (this.diagnostics.length > 0) return { assembly: "", diagnostics: this.diagnostics };

    this.collectDeclarations();
    // Declaration failures can leave globals or functions intentionally unregistered.
    // Continuing into event lowering would only add misleading "undefined" diagnostics.
    if (this.diagnostics.length > 0) return { assembly: "", diagnostics: this.diagnostics };
    const declaredEvents = new Set<string>();
    const entryGroups = new Map<string, FunctionInfo[]>();
    for (const info of this.entries) {
      if (info.entryKind === "method") {
        this.tryCompile(info.node, () => this.compileExternalMethod(info));
        continue;
      }
      const event = this.eventForName(info.name, info.node.parameters.length);
      declaredEvents.add(event?.sourceName ?? info.name);
      const key = event?.assemblyName ?? sanitizeSymbol(info.name);
      const group = entryGroups.get(key) ?? [];
      group.push(info);
      entryGroups.set(key, group);
    }
    for (const group of entryGroups.values()) {
      const first = group[0]!;
      const event = this.eventForName(first.name, first.node.parameters.length);
      this.tryCompile(first.node, () => this.compileEntryPoint(group, event));
    }

    if (this.globalInitializers.length > 0 && !declaredEvents.has("onEnable")) {
      this.emit(".export _onEnable");
      this.label("_onEnable");
      const flow: FlowContext = { returnLabel: this.uniqueLabel("onEnable_end") };
      this.emitGlobalInitializers(flow);
      this.label(flow.returnLabel);
      this.emit("JUMP, 0xFFFFFFFC");
    }

    const assembly = this.assembly.render();
    const stats = this.assembly.stats();
    return { assembly, diagnostics: this.diagnostics, ...(stats ? { stats } : {}) };
  }

  private collectDeclarations(): void {
    this.globalScope.set("gameObject", this.allocate("__this_gameObject", "UnityEngineGameObject", "this", { exact: true }));
    this.globalScope.set("transform", this.allocate("__this_transform", "UnityEngineTransform", "this", { exact: true }));
    this.collectImportedLibraries();
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
      if (ts.isExpressionStatement(statement)) {
        try {
          const registration = this.eventEmitter.registration(statement);
          if (registration) {
            const event = this.eventForName(registration.name, registration.handler.parameters.length);
            this.registerFunction(
              registration.handler,
              registration.name,
              true,
              event?.returns ?? "SystemVoid",
              false
            );
            continue;
          }
          if (ts.isCallExpression(statement.expression) && this.eventEmitter.callName(statement.expression)) {
            this.fail(`${this.eventEmitter.callName(statement.expression)}はイベントハンドラー内で使用してください`, statement);
          }
        } catch (error) {
          this.capture(error, statement);
          continue;
        }
      }
      if (ts.isFunctionDeclaration(statement)) {
        this.registerFunction(statement, statement.name?.text ?? "default", false, "SystemVoid", Boolean(statement.name));
      }
      if (ts.isVariableStatement(statement)) {
        const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of statement.declarationList.declarations) {
          try {
            const marker = this.udonVariables.topLevel(declaration);
            if (marker && constant) this.fail("udonVariableはInspectorから変更されるためconstでは宣言できません", declaration);
            if (declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
              if (!ts.isIdentifier(declaration.name)) this.fail("関数の分割代入は使えません", declaration.name);
              this.registerFunction(
                declaration.initializer,
                declaration.name.text,
                false,
                "SystemVoid",
                true,
                "event",
                declaration
              );
              continue;
            }
            this.collectGlobal(declaration, Boolean(marker), marker?.sync, marker);
          } catch (error) { this.capture(error, declaration); }
        }
      }
      if (ts.isClassDeclaration(statement)) {
        const extendsUdon = statement.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((type) => ts.isIdentifier(type.expression) && type.expression.text === "UdonBehaviour")) ?? false;
        if (!extendsUdon) continue;
        for (const member of statement.members) {
          if (ts.isPropertyDeclaration(member)) {
            try {
              const marker = this.udonVariables.classField(member);
              if (marker && (this.hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
                this.hasModifier(member, ts.SyntaxKind.ProtectedKeyword))) {
                this.fail("@udonVariableフィールドはprivateまたはprotectedにできません", member);
              }
              if (marker && this.hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)) {
                this.fail("@udonVariableはInspectorから変更されるためreadonlyにはできません", member);
              }
              if (marker && this.hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
                this.fail("@udonVariableをstaticフィールドには指定できません", member);
              }
              this.collectGlobal(member, Boolean(marker), marker?.sync, marker);
            } catch (error) { this.capture(error, member); }
          } else if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            try {
              const name = member.name.text;
              const isPublic = !this.hasModifier(member, ts.SyntaxKind.PrivateKeyword) &&
                !this.hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
              const event = this.eventForName(name, member.parameters.length);
              const comptime = this.hasDecorator(member, "comptime");
              if (comptime && isPublic) this.fail("@comptimeメソッドはprivateまたはprotectedにしてください", member);
              this.registerFunction(
                member,
                name,
                isPublic || Boolean(event),
                event?.returns ?? "SystemVoid",
                true,
                event ? "event" : "method",
                undefined,
                comptime
              );
            } catch (error) { this.capture(error, member); }
          }
        }
      }
    }
  }

  private collectImportedLibraries(): void {
    if (!this.project) return;
    for (const sourceFile of this.project.dependenciesBySource.get(this.sourceFile) ?? []) {
      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement)) {
          this.registerFunction(statement, statement.name?.text ?? "default", false, "SystemVoid", false);
        }
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          if (declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
            this.registerFunction(
              declaration.initializer,
              declaration.name.text,
              false,
              "SystemVoid",
              false,
              "event",
              declaration
            );
            continue;
          }
          if (declaration.initializer && ts.isCallExpression(declaration.initializer) &&
            ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "udonVariable") {
            continue;
          }
          this.collectGlobal(declaration, false, undefined, undefined, `__module_${declaration.name.text}`, false);
        }
      }
    }
  }

  private collectGlobal(
    declaration: GlobalDeclaration,
    exported: boolean,
    sync?: SyncMode,
    marker?: UdonVariableMarker,
    symbolBase?: string,
    exact = true
  ): void {
    this.tryCompile(declaration, () => {
      if (!ts.isIdentifier(declaration.name)) this.fail("分割代入はまだフィールドでは使えません", declaration.name);
      const name = declaration.name.text;
      const declaredType = declaration.type ? this.requireType(declaration.type) : undefined;
      const markerType = marker?.type ? this.requireType(marker.type) : undefined;
      if (declaredType && markerType && declaredType !== markerType) {
        this.fail(`${sourceTypeName(markerType)} を ${sourceTypeName(declaredType)} として使用できません`, marker!.type!);
      }
      const initializer = marker && ts.isVariableDeclaration(declaration)
        ? marker.initializer
        : declaration.initializer;
      const comptimeValue = initializer && this.isComptimeCall(initializer)
        ? this.comptime.evaluateFactory(initializer as ts.CallExpression)
        : undefined;
      const type = declaredType ?? markerType ?? comptimeValue?.type ?? (initializer
        ? this.inferLiteralType(initializer)
        : undefined);
      if (!type) this.fail(`変数 '${name}' にはUdon型注釈が必要です`, declaration);
      if (comptimeValue) this.assertAssignable(comptimeValue.type, type, initializer!);
      if (ts.isVariableDeclaration(declaration) && this.comptimeOnlyGlobals.has(declaration)) return;
      const constant = comptimeValue ? encodeComptimeScalar(comptimeValue) : initializer ? this.dataLiteral(initializer, type) : undefined;
      const target = this.allocate(symbolBase ?? name, type, constant ?? defaultValue(type), {
        exported,
        exact,
        ...(sync ? { sync } : {})
      });
      const behavior = declaration.type ? this.behaviorForTypeNode(declaration.type) : marker?.type
        ? this.behaviorForTypeNode(marker.type)
        : undefined;
      if (behavior) target.behaviorType = behavior.id;
      if (declaration.getSourceFile() === this.sourceFile) this.globalScope.set(name, target);
      if (ts.isVariableDeclaration(declaration)) this.globalsByDeclaration.set(declaration, target);
      if (initializer && constant === undefined) this.globalInitializers.push({ declaration, initializer, target });
    });
  }

  private registerFunction(
    node: FunctionNode,
    name: string,
    entry: boolean,
    defaultReturn: UdonType = "SystemVoid",
    registerForCalls = true,
    entryKind: "event" | "method" = "event",
    referenceDeclaration?: ts.Declaration,
    comptime = false
  ): void {
    try {
      const returnType = node.type
        ? this.requireType(node.type)
        : entry && entryKind === "event"
          ? defaultReturn
          : this.inferFunctionReturnType(node, defaultReturn);
      const info: FunctionInfo = { node, name, returnType, entry, ...(entry ? { entryKind } : {}), ...(comptime ? { comptime } : {}) };
      if (registerForCalls) this.functions.set(name, info);
      this.functionsByDeclaration.set(node, info);
      if (referenceDeclaration) this.functionsByDeclaration.set(referenceDeclaration, info);
      if (entry) this.entries.push(info);
    } catch (error) { this.capture(error, node); }
  }

  private inferFunctionReturnType(node: FunctionNode, defaultReturn: UdonType): UdonType {
    if (!node.body) return defaultReturn;
    const scope = new Scope(this.globalScope);
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name) || !parameter.type) continue;
      scope.set(parameter.name.text, { symbol: "", type: this.requireType(parameter.type) });
    }

    const expressions: ts.Expression[] = [];
    let hasBareReturn = false;
    if (!ts.isBlock(node.body)) {
      expressions.push(node.body);
    } else {
      const visit = (current: ts.Node): void => {
        if (current !== node.body && (ts.isFunctionLike(current) || ts.isClassLike(current))) return;
        if (ts.isReturnStatement(current)) {
          if (current.expression) expressions.push(current.expression);
          else hasBareReturn = true;
          return;
        }
        ts.forEachChild(current, visit);
      };
      visit(node.body);
    }
    if (expressions.length === 0) return defaultReturn;
    if (hasBareReturn) {
      this.fail("値ありreturnと値なしreturnを併用する場合は戻り値型を明示してください", node);
    }

    let inferred: UdonType | undefined;
    for (const expression of expressions) {
      const type = this.inferExpressionType(expression, scope);
      if (!type || type === "SystemVoid") {
        this.fail("戻り値のUdon型を推論できません。戻り値型を明示してください", expression);
      }
      if (inferred && inferred !== type) {
        this.fail(
          `戻り値に${sourceTypeName(inferred)}と${sourceTypeName(type)}が混在しています。戻り値型を明示してください`,
          expression
        );
      }
      inferred = type;
    }
    return inferred ?? defaultReturn;
  }

  private compileEntryPoint(infos: readonly FunctionInfo[], event?: EventDefinition): void {
    const first = infos[0]!;
    const sourceName = first.name;
    const assemblyName = event?.assemblyName ?? sanitizeSymbol(sourceName);
    if (event?.returns && infos.length > 1) {
      this.fail(`戻り値を持つイベント '${sourceName}' には複数のハンドラーを登録できません`, infos[1]!.node);
    }
    for (const info of infos) this.validateEventHandler(info, event, assemblyName);
    this.emit(`.export ${assemblyName}`);
    this.label(assemblyName);
    const expectedReturn = event?.returns ?? "SystemVoid";
    const eventReturn = event?.returns
      ? this.allocate(event.returnSymbol ?? "__returnValue", event.returns, defaultValue(event.returns), { exact: true })
      : undefined;
    if (event?.sourceName === "onEnable") {
      const initializerEnd = this.uniqueLabel("onEnable_initializer_end");
      this.emitGlobalInitializers({ returnLabel: initializerEnd });
      this.label(initializerEnd);
    }
    for (const info of infos) {
      const node = info.node;
      if (!node.body) continue;
      const scope = this.eventHandlerScope(node, event);
      const flow: FlowContext = {
        returnLabel: this.uniqueLabel(`${sourceName}_handler_end`),
        ...(eventReturn ? { returnValue: eventReturn } : {})
      };
      if (ts.isBlock(node.body)) {
        this.compileStatements(node.body.statements, scope, flow);
      } else if (eventReturn) {
        this.copy(this.compileExpression(node.body, scope, expectedReturn, flow), eventReturn, node.body);
      } else {
        this.compileExpression(node.body, scope, undefined, flow);
      }
      this.label(flow.returnLabel);
    }
    this.emit("JUMP, 0xFFFFFFFC");
  }

  private compileExternalMethod(info: FunctionInfo): void {
    const node = info.node;
    if (!node.body || !ts.isBlock(node.body)) this.fail(`公開メソッド '${info.name}' に本体が必要です`, node);
    const scope = new Scope(this.globalScope);
    node.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) this.fail("分割代入パラメータは使えません", parameter.name);
      if (!parameter.type) this.fail(`公開メソッド引数 '${parameter.name.text}' に型注釈が必要です`, parameter);
      const type = this.requireType(parameter.type);
      const value = this.allocate(this.methodParameterSymbol(info.name, parameter.name.text, index), type, defaultValue(type), {
        exported: true,
        exact: true
      });
      const behavior = this.behaviorForTypeNode(parameter.type);
      if (behavior) value.behaviorType = behavior.id;
      scope.set(parameter.name.text, value);
    });
    const result = info.returnType === "SystemVoid"
      ? undefined
      : this.allocate(this.methodReturnSymbol(info.name), info.returnType, defaultValue(info.returnType), {
        exported: true,
        exact: true
      });
    this.emit(`.export ${sanitizeSymbol(info.name)}`);
    this.label(sanitizeSymbol(info.name));
    const flow: FlowContext = {
      returnLabel: this.uniqueLabel(`${info.name}_method_end`),
      ...(result ? { returnValue: result } : {})
    };
    this.compileStatements(node.body.statements, scope, flow);
    this.label(flow.returnLabel);
    this.emit("JUMP, 0xFFFFFFFC");
  }

  private methodParameterSymbol(method: string, parameter: string, index: number): string {
    return `__method_${sanitizeSymbol(method)}_arg${index}_${sanitizeSymbol(parameter)}`;
  }

  private methodReturnSymbol(method: string): string {
    return `__method_${sanitizeSymbol(method)}_return`;
  }

  private validateEventHandler(info: FunctionInfo, event: EventDefinition | undefined, assemblyName: string): void {
    const node = info.node;
    const sourceName = info.name;
    const handlerEvent = this.eventForName(sourceName, node.parameters.length);
    if (!handlerEvent && this.eventForName(sourceName)) {
      const arities = this.eventDefinitionsForName(sourceName).map((definition) => definition.parameters.length).join(" / ");
      this.fail(`イベント '${sourceName}' の引数は ${arities} 個必要です`, node);
    }
    if (!handlerEvent && node.parameters.length > 0) this.fail("カスタムイベントに引数は指定できません", node.parameters[0]!);
    if (handlerEvent?.assemblyName !== event?.assemblyName || (handlerEvent?.assemblyName ?? sanitizeSymbol(sourceName)) !== assemblyName) {
      this.fail(`イベント '${sourceName}' のハンドラー署名が一致しません`, node);
    }
    if (handlerEvent && event && (handlerEvent.parameters.length !== event.parameters.length ||
      handlerEvent.parameters.some((parameter, index) => parameter.type !== event.parameters[index]?.type))) {
      this.fail(`イベント '${sourceName}' に異なる引数形式のハンドラーを同時登録できません`, node);
    }
    const expectedReturn = handlerEvent?.returns ?? "SystemVoid";
    if (info.returnType !== expectedReturn) {
      this.fail(`イベント '${sourceName}' の戻り値は ${sourceTypeName(expectedReturn)} 型です`, node);
    }
  }

  private eventHandlerScope(node: FunctionNode, event?: EventDefinition): Scope {
    const scope = new Scope(this.globalScope);
    if (!event) return scope;
    event.parameters.forEach((parameter, index) => {
      const sourceParameter = node.parameters[index];
      if (!sourceParameter || !ts.isIdentifier(sourceParameter.name)) return;
      if (sourceParameter.type) {
        const annotated = this.requireType(sourceParameter.type);
        if (annotated !== parameter.type) {
          this.fail(`イベント引数 '${sourceParameter.name.text}' は ${sourceTypeName(parameter.type)} 型です`, sourceParameter);
        }
      }
      const value = this.allocate(parameter.symbol, parameter.type, "null", { exact: true });
      scope.set(sourceParameter.name.text, value);
    });
    return scope;
  }

  private emitGlobalInitializers(flow: FlowContext): void {
    for (const { declaration, initializer, target } of this.globalInitializers) {
      const value = this.compileExpression(initializer, this.globalScope, target.type, flow);
      this.copy(value, target, declaration);
    }
  }

  private compileStatements(statements: ts.NodeArray<ts.Statement>, scope: Scope, flow: FlowContext): void {
    for (const statement of statements) this.tryCompile(statement, () => this.compileStatement(statement, scope, flow));
  }

  private compileStatement(statement: ts.Statement, scope: Scope, flow: FlowContext): void {
    this.sourceComment(statement);
    if (ts.isBlock(statement)) {
      this.compileStatements(statement.statements, new Scope(scope), flow);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) this.fail("分割代入はまだ使えません", declaration.name);
        const type = declaration.type
          ? this.requireType(declaration.type)
          : declaration.initializer
            ? this.inferExpressionType(declaration.initializer, scope)
            : undefined;
        if (!type || type === "SystemVoid") this.fail(`変数 '${declaration.name.text}' の型を推論できません`, declaration);
        const target = this.allocate(declaration.name.text, type);
        const behavior = declaration.type ? this.behaviorForTypeNode(declaration.type) : undefined;
        if (behavior) target.behaviorType = behavior.id;
        scope.set(declaration.name.text, target);
        if (declaration.initializer) {
          const value = this.compileExpression(declaration.initializer, scope, type, flow);
          if (value.behaviorType) target.behaviorType = value.behaviorType;
          this.copy(value, target, declaration);
        }
      }
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      this.compileExpression(statement.expression, scope, undefined, flow);
      return;
    }
    if (ts.isIfStatement(statement)) {
      const elseLabel = this.uniqueLabel("if_else");
      const endLabel = this.uniqueLabel("if_end");
      const condition = this.compileExpression(statement.expression, scope, "SystemBoolean", flow);
      this.jumpIfFalse(condition, elseLabel);
      this.compileStatement(statement.thenStatement, new Scope(scope), flow);
      this.emit(`JUMP, ${endLabel}`);
      this.label(elseLabel);
      if (statement.elseStatement) this.compileStatement(statement.elseStatement, new Scope(scope), flow);
      this.label(endLabel);
      return;
    }
    if (ts.isWhileStatement(statement)) {
      const testLabel = this.uniqueLabel("while_test");
      const endLabel = this.uniqueLabel("while_end");
      this.label(testLabel);
      const condition = this.compileExpression(statement.expression, scope, "SystemBoolean", flow);
      this.jumpIfFalse(condition, endLabel);
      this.compileStatement(statement.statement, new Scope(scope), { ...flow, breakLabel: endLabel, continueLabel: testLabel });
      this.emit(`JUMP, ${testLabel}`);
      this.label(endLabel);
      return;
    }
    if (ts.isForStatement(statement)) {
      const loopScope = new Scope(scope);
      if (statement.initializer) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          const variableStatement = ts.factory.createVariableStatement(undefined, statement.initializer);
          this.compileStatement(variableStatement, loopScope, flow);
        } else this.compileExpression(statement.initializer, loopScope, undefined, flow);
      }
      const testLabel = this.uniqueLabel("for_test");
      const incrementLabel = this.uniqueLabel("for_increment");
      const endLabel = this.uniqueLabel("for_end");
      this.label(testLabel);
      if (statement.condition) {
        const condition = this.compileExpression(statement.condition, loopScope, "SystemBoolean", flow);
        this.jumpIfFalse(condition, endLabel);
      }
      this.compileStatement(statement.statement, loopScope, { ...flow, breakLabel: endLabel, continueLabel: incrementLabel });
      this.label(incrementLabel);
      if (statement.incrementor) this.compileExpression(statement.incrementor, loopScope, undefined, flow);
      this.emit(`JUMP, ${testLabel}`);
      this.label(endLabel);
      return;
    }
    if (ts.isReturnStatement(statement)) {
      if (statement.expression) {
        if (!flow.returnValue) this.fail("このイベント/関数は値を返せません", statement);
        const value = this.compileExpression(statement.expression, scope, flow.returnValue.type, flow);
        this.copy(value, flow.returnValue, statement);
      } else if (flow.returnValue) this.fail("戻り値が必要です", statement);
      this.emit(`JUMP, ${flow.returnLabel}`);
      return;
    }
    if (ts.isBreakStatement(statement)) {
      if (!flow.breakLabel) this.fail("break はループ内でのみ使えます", statement);
      this.emit(`JUMP, ${flow.breakLabel}`);
      return;
    }
    if (ts.isContinueStatement(statement)) {
      if (!flow.continueLabel) this.fail("continue はループ内でのみ使えます", statement);
      this.emit(`JUMP, ${flow.continueLabel}`);
      return;
    }
    if (ts.isEmptyStatement(statement)) return;
    this.fail(`未対応の文です: ${ts.SyntaxKind[statement.kind]}`, statement);
  }

  private compileExpression(node: ts.Expression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    if (ts.isParenthesizedExpression(node)) return this.compileExpression(node.expression, scope, expected, flow);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const asserted = this.requireType(node.type);
      return this.compileExpression(node.expression, scope, asserted, flow);
    }
    if (ts.isIdentifier(node)) {
      const value = scope.get(node.text) ?? this.importedGlobal(node);
      if (!value) this.fail(`未定義の識別子 '${node.text}' です`, node);
      this.assertAssignable(value.type, expected, node);
      return value;
    }
    if (ts.isNumericLiteral(node)) {
      const type = expected && isNumeric(expected)
        ? expected
        : node.text.includes(".") || /e/i.test(node.text) ? "SystemSingle" : "SystemInt32";
      const initial = type === "SystemUInt32" ? `${node.text}u` : node.text;
      return this.allocate("const", type, initial);
    }
    if (ts.isStringLiteralLike(node)) {
      const value = this.allocate("const", "SystemString", escapeString(node.text));
      this.assertAssignable(value.type, expected, node);
      return value;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const falseValue = this.allocate("false", "SystemBoolean", "null");
      if (node.kind === ts.SyntaxKind.FalseKeyword) {
        this.assertAssignable(falseValue.type, expected, node);
        return falseValue;
      }
      const trueValue = this.allocate("true", "SystemBoolean", "null");
      this.emitExtern("SystemBoolean.__op_UnaryNegation__SystemBoolean__SystemBoolean", [falseValue], trueValue);
      this.assertAssignable(trueValue.type, expected, node);
      return trueValue;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return this.allocate("null", expected && expected !== "SystemVoid" ? expected : "SystemObject", "null");
    }
    if (ts.isArrayLiteralExpression(node)) return this.arrays.compileLiteral(node, scope, expected, flow);
    if (ts.isNewExpression(node)) return this.arrays.compileNew(node, scope, expected, flow);
    if (ts.isElementAccessExpression(node)) return this.arrays.compileGet(node, scope, expected, flow);
    if (ts.isBinaryExpression(node)) return this.compileBinary(node, scope, expected, flow);
    if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        return this.compileIncrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", scope, flow);
      }
      const operator = ts.tokenToString(node.operator) ?? "";
      const operandExpected = operator === "!" ? "SystemBoolean" : expected;
      const operand = this.compileExpression(node.operand, scope, operandExpected, flow);
      const extern = unaryExtern(operator, operand.type);
      if (!extern) this.fail(`単項演算子 '${operator}' は ${sourceTypeName(operand.type)} に使えません`, node);
      const output = this.allocate("unary", extern.returns);
      this.emitExtern(extern.signature, [operand], output);
      this.assertAssignable(output.type, expected, node);
      return output;
    }
    if (ts.isPostfixUnaryExpression(node)) {
      const target = this.requireLValue(node.operand, scope);
      const previous = this.allocate("previous", target.type);
      this.copy(target, previous, node);
      this.compileIncrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-", scope, flow);
      return previous;
    }
    if (ts.isConditionalExpression(node)) {
      const resultType = expected ?? this.inferExpressionType(node.whenTrue, scope);
      if (!resultType || resultType === "SystemVoid") this.fail("三項演算子の型を推論できません", node);
      const result = this.allocate("conditional", resultType);
      const falseLabel = this.uniqueLabel("conditional_false");
      const endLabel = this.uniqueLabel("conditional_end");
      const condition = this.compileExpression(node.condition, scope, "SystemBoolean", flow);
      this.jumpIfFalse(condition, falseLabel);
      this.copy(this.compileExpression(node.whenTrue, scope, resultType, flow), result, node.whenTrue);
      this.emit(`JUMP, ${endLabel}`);
      this.label(falseLabel);
      this.copy(this.compileExpression(node.whenFalse, scope, resultType, flow), result, node.whenFalse);
      this.label(endLabel);
      return result;
    }
    if (ts.isCallExpression(node)) return this.compileCall(node, scope, expected, flow);
    if (ts.isPropertyAccessExpression(node)) return this.compilePropertyGet(node, scope, expected, flow);
    this.fail(`未対応の式です: ${ts.SyntaxKind[node.kind]}`, node);
  }

  private compileBinary(node: ts.BinaryExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const operator = ts.tokenToString(node.operatorToken.kind) ?? "";
    if (operator === "=" && ts.isElementAccessExpression(node.left)) {
      return this.arrays.compileSet(node.left, node.right, scope, expected, flow);
    }
    if (operator === "=" && ts.isPropertyAccessExpression(node.left)) {
      return this.compilePropertySet(node.left, node.right, scope, expected, flow);
    }
    if (["=", "+=", "-=", "*=", "/=", "%="].includes(operator)) {
      const target = this.requireLValue(node.left, scope);
      if (operator === "=") {
        const value = this.compileExpression(node.right, scope, target.type, flow);
        this.copy(value, target, node);
      } else {
        const simpleOperator = operator.slice(0, -1);
        const right = this.compileExpression(node.right, scope, target.type, flow);
        const extern = binaryExtern(simpleOperator, target.type, right.type);
        if (!extern) this.fail(`演算子 '${operator}' は使えません`, node);
        const result = this.allocate("assignment", extern.returns);
        this.emitExtern(extern.signature, [target, right], result);
        this.copy(result, target, node);
      }
      return target;
    }
    if (operator === "&&" || operator === "||") return this.compileLogical(node, operator, scope, flow);
    const left = this.compileExpression(node.left, scope, undefined, flow);
    const right = this.compileExpression(node.right, scope, left.type, flow);
    const extern = binaryExtern(operator, left.type, right.type);
    if (!extern) this.fail(`演算子 '${operator}' は ${sourceTypeName(left.type)} に使えません`, node);
    const output = this.allocate("binary", extern.returns);
    this.emitExtern(extern.signature, [left, right], output);
    this.assertAssignable(output.type, expected, node);
    return output;
  }

  private compileLogical(node: ts.BinaryExpression, operator: string, scope: Scope, flow: FlowContext): ValueRef {
    const result = this.allocate("logical", "SystemBoolean");
    const shortLabel = this.uniqueLabel("logical_short");
    const endLabel = this.uniqueLabel("logical_end");
    const left = this.compileExpression(node.left, scope, "SystemBoolean", flow);
    if (operator === "&&") {
      this.jumpIfFalse(left, shortLabel);
      this.copy(this.compileExpression(node.right, scope, "SystemBoolean", flow), result, node.right);
      this.emit(`JUMP, ${endLabel}`);
      this.label(shortLabel);
      this.copy(left, result, node.left);
    } else {
      const evaluateRight = this.uniqueLabel("logical_right");
      this.jumpIfFalse(left, evaluateRight);
      this.copy(left, result, node.left);
      this.emit(`JUMP, ${endLabel}`);
      this.label(evaluateRight);
      this.copy(this.compileExpression(node.right, scope, "SystemBoolean", flow), result, node.right);
    }
    this.label(endLabel);
    return result;
  }

  private compileIncrement(node: ts.Expression, operator: "+" | "-", scope: Scope, flow: FlowContext): ValueRef {
    const target = this.requireLValue(node, scope);
    if (!isNumeric(target.type)) this.fail("++/-- は数値にのみ使えます", node);
    const one = this.compileExpression(ts.factory.createNumericLiteral("1"), scope, target.type, flow);
    const extern = binaryExtern(operator, target.type, target.type)!;
    const result = this.allocate("increment", target.type);
    this.emitExtern(extern.signature, [target, one], result);
    this.copy(result, target, node);
    return target;
  }

  private compileCall(node: ts.CallExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    if (this.isComptimeCall(node)) {
      return this.materializeComptime(this.comptime.evaluateFactory(node), node, scope, expected, flow);
    }
    if (ts.isIdentifier(node.expression) && node.expression.text === "extern") {
      return this.compileRawExtern(node, scope, expected, flow);
    }
    const eventCall = this.eventEmitter.callName(node);
    if (eventCall) return this.compileEventEmitterCall(eventCall, node, scope, expected, flow);
    if (ts.isIdentifier(node.expression)) {
      const fn = this.functionForReference(node.expression) ?? this.functions.get(node.expression.text);
      if (fn && fn.entryKind !== "event") return this.inlineFunction(fn, node, scope, expected, flow);
    }
    if (!ts.isPropertyAccessExpression(node.expression)) this.fail("呼び出せない式です", node.expression);
    const access = node.expression;
    const member = access.name.text;
    const importedFunction = this.functionForReference(access.name);
    if (importedFunction) return this.inlineFunction(importedFunction, node, scope, expected, flow);
    if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const fn = this.functions.get(member);
      if (!fn || this.eventForName(fn.name)) this.fail(`呼び出せるヘルパーメソッド '${member}' がありません`, access.name);
      return this.inlineFunction(fn, node, scope, expected, flow);
    }
    let receiver: ValueRef | undefined;
    let owner: UdonType | undefined;
    owner = this.staticOwnerFromExpression(access.expression);
    if (!owner) {
      receiver = this.compileExpression(access.expression, scope, undefined, flow);
      owner = receiver.type;
    }
    const behavior = receiver?.behaviorType ? this.project?.behaviorsById.get(receiver.behaviorType) : undefined;
    if (receiver && behavior) {
      const method = behavior.methods.get(member);
      if (!method) this.fail(`Behaviour '${behavior.name}' に公開メソッド '${member}' がありません`, access.name);
      return this.compileBehaviorMethodCall(receiver, method, node, scope, expected, flow);
    }
    const definition = this.selectExtern(owner, member, "method", node.arguments, scope, access.name);
    const args = this.compileExternArguments(node, definition, scope, flow);
    const output = definition.returns === "SystemVoid" ? undefined : this.allocate(member, definition.returns);
    this.emitExtern(definition.signature, receiver ? [receiver, ...args] : args, output);
    if (!output) return { symbol: "", type: "SystemVoid" };
    this.assertAssignable(output.type, expected, node);
    return output;
  }

  private compileEventEmitterCall(
    name: string,
    node: ts.CallExpression,
    scope: Scope,
    expected: UdonType | undefined,
    flow: FlowContext
  ): ValueRef {
    if (node.typeArguments?.length) this.fail(`${name}には型引数を指定できません`, node.typeArguments[0]!);
    if (name === "on") this.fail("onはトップレベルでのみ使用できます", node);
    if (name === "emit") {
      this.requireArgumentCount(node, 1);
      const eventName = this.compileEventName(node.arguments[0]!);
      this.emitExtern(eventExterns.emit, [this.selfReceiver, eventName]);
      return this.voidValue(expected, node);
    }
    if (name === "emitDelayed") {
      this.requireArgumentCount(node, 2);
      const eventName = this.compileEventName(node.arguments[0]!);
      const seconds = this.compileExpression(node.arguments[1]!, scope, "SystemSingle", flow);
      const timing = this.updateTimingValue();
      this.emitExtern(eventExterns.delayedSeconds, [this.selfReceiver, eventName, seconds, timing]);
      return this.voidValue(expected, node);
    }
    if (name === "emitDelayedFrames") {
      this.requireArgumentCount(node, 2);
      const eventName = this.compileEventName(node.arguments[0]!);
      const frames = this.compileExpression(node.arguments[1]!, scope, "SystemInt32", flow);
      const timing = this.updateTimingValue();
      this.emitExtern(eventExterns.delayedFrames, [this.selfReceiver, eventName, frames, timing]);
      return this.voidValue(expected, node);
    }
    if (name === "emitNetwork") {
      this.requireArgumentCount(node, 2);
      const target = this.compileNetworkTarget(node.arguments[0]!, scope, flow);
      const eventName = this.compileEventName(node.arguments[1]!, true);
      this.emitExtern(eventExterns.network, [this.selfReceiver, target, eventName]);
      return this.voidValue(expected, node);
    }
    this.fail(`未対応のイベントAPIです: ${name}`, node);
  }

  private compileBehaviorMethodCall(
    receiver: ValueRef,
    method: ts.MethodDeclaration,
    call: ts.CallExpression,
    scope: Scope,
    expected: UdonType | undefined,
    flow: FlowContext
  ): ValueRef {
    if (!method.name || !ts.isIdentifier(method.name)) this.fail("Behaviourメソッド名を解決できません", call.expression);
    const methodName = method.name.text;
    if (this.eventForName(methodName, method.parameters.length)) {
      this.fail(`標準Udonイベント '${methodName}' は別Behaviourの通常メソッドとして呼び出せません`, call.expression);
    }
    if (call.arguments.length !== method.parameters.length) {
      this.fail(`${methodName}は${method.parameters.length}引数ですが、${call.arguments.length}個渡されています`, call);
    }
    method.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name) || !parameter.type) {
        this.fail(`Behaviour公開メソッド '${methodName}' の引数には名前と型注釈が必要です`, parameter);
      }
      const type = this.requireType(parameter.type);
      const value = this.compileExpression(call.arguments[index]!, scope, type, flow);
      const symbolName = this.methodParameterSymbol(methodName, parameter.name.text, index);
      const name = this.allocate(`__remote_${symbolName}`, "SystemString", escapeString(symbolName));
      this.emitExtern(
        "VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid",
        [receiver, name, value]
      );
    });
    const eventName = this.allocate(`__remote_method_${methodName}`, "SystemString", escapeString(sanitizeSymbol(methodName)));
    this.emitExtern(eventExterns.emit, [receiver, eventName]);
    const returnType = method.type ? this.requireType(method.type) : "SystemVoid";
    if (returnType === "SystemVoid") return this.voidValue(expected, call);
    const returnName = this.methodReturnSymbol(methodName);
    const name = this.allocate(`__remote_${returnName}`, "SystemString", escapeString(returnName));
    const boxed = this.allocate(`${methodName}_return_boxed`, "SystemObject");
    this.emitExtern(
      "VRCUdonCommonInterfacesIUdonEventReceiver.__GetProgramVariable__SystemString__SystemObject",
      [receiver, name],
      boxed
    );
    const output = this.allocate(`${methodName}_return`, returnType);
    this.copyUnchecked(boxed, output);
    const behavior = method.type ? this.behaviorForTypeNode(method.type) : undefined;
    if (behavior) output.behaviorType = behavior.id;
    this.assertAssignable(output.type, expected, call);
    return output;
  }

  private compileEventName(node: ts.Expression, network = false): ValueRef {
    if (!ts.isStringLiteralLike(node)) this.fail("イベント名は文字列リテラルで指定してください", node);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(node.text)) {
      this.fail("イベント名には英数字と_を使用し、英字から始めてください", node);
    }
    const event = this.eventForName(node.text);
    if (network && event) this.fail("標準UdonイベントはemitNetworkで送信できません", node);
    const runtimeName = event?.assemblyName ?? sanitizeSymbol(node.text);
    const declared = this.entries.some((info) => {
      const definition = this.eventForName(info.name, info.node.parameters.length);
      return (definition?.assemblyName ?? sanitizeSymbol(info.name)) === runtimeName;
    });
    if (!declared) this.fail(`イベント '${node.text}' がこのBehaviourに登録されていません`, node);
    const existing = this.eventNameValues.get(runtimeName);
    if (existing) return existing;
    const value = this.allocate(`__event_${runtimeName}`, "SystemString", escapeString(runtimeName));
    this.eventNameValues.set(runtimeName, value);
    return value;
  }

  private compileNetworkTarget(node: ts.Expression, scope: Scope, flow: FlowContext): ValueRef {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "NetworkEventTarget") {
      if (node.name.text !== "All") {
        this.fail("生UASMではAll以外のNetworkEventTarget定数を埋め込めません。udonVariable<NetworkEventTarget>()をInspectorで設定して渡してください", node);
      }
      this.networkTargetAll ??= this.allocate(
        "__networkTargetAll",
        "VRCUdonCommonInterfacesNetworkEventTarget",
        "null"
      );
      return this.networkTargetAll;
    }
    return this.compileExpression(node, scope, "VRCUdonCommonInterfacesNetworkEventTarget", flow);
  }

  private requireArgumentCount(node: ts.CallExpression, count: number): void {
    if (node.arguments.length !== count) {
      this.fail(`${node.expression.getText(this.sourceFile)}は${count}引数ですが、${node.arguments.length}個渡されています`, node);
    }
  }

  private updateTimingValue(): ValueRef {
    this.updateEventTiming ??= this.allocate(
      "__eventTimingUpdate",
      "VRCUdonCommonEnumsEventTiming",
      "null"
    );
    return this.updateEventTiming;
  }

  private voidValue(expected: UdonType | undefined, node: ts.Node): ValueRef {
    this.assertAssignable("SystemVoid", expected, node);
    return { symbol: "", type: "SystemVoid" };
  }

  private compileExternArguments(node: ts.CallExpression, definition: ExternDefinition, scope: Scope, flow: FlowContext): ValueRef[] {
    if (node.arguments.length !== definition.parameters.length) {
      this.fail(`${definition.member} は ${definition.parameters.length} 引数ですが、${node.arguments.length} 個渡されています`, node);
    }
    return definition.parameters.map((parameter, index) => {
      const argument = node.arguments[index]!;
      if (parameter.mode === "ref" || parameter.mode === "out") {
        const value = this.requireLValue(argument, scope);
        this.assertAssignable(value.type, parameter.type, argument);
        return value;
      }
      return this.compileExpression(argument, scope, parameter.type, flow);
    });
  }

  private compileRawExtern(node: ts.CallExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const signatureNode = node.arguments[0];
    if (!signatureNode || !ts.isStringLiteralLike(signatureNode)) this.fail("extern の第1引数は文字列リテラルの署名にしてください", node);
    let returnType: UdonType = "SystemVoid";
    const typeArgument = node.typeArguments?.[0];
    if (typeArgument) returnType = this.requireType(typeArgument);
    else if (expected) returnType = expected;
    const args = node.arguments.slice(1).map((argument) => this.compileExpression(argument, scope, undefined, flow));
    const output = returnType === "SystemVoid" ? undefined : this.allocate("extern_result", returnType);
    this.emitExtern(signatureNode.text, args, output, true);
    return output ?? { symbol: "", type: "SystemVoid" };
  }

  private compilePropertyGet(node: ts.PropertyAccessExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const member = node.name.text;
    const imported = this.importedGlobal(node.name);
    if (imported) {
      this.assertAssignable(imported.type, expected, node);
      return imported;
    }
    if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const value = scope.get(member);
      if (!value) this.fail(`フィールド '${member}' がありません`, node.name);
      this.assertAssignable(value.type, expected, node);
      return value;
    }
    const receiverType = this.inferExpressionType(node.expression, scope);
    if (member === "length" && receiverType && isArray(receiverType)) {
      const externs = arrayExterns(receiverType)!;
      const receiver = this.compileExpression(node.expression, scope, receiverType, flow);
      const output = this.allocate("length", "SystemInt32");
      this.emitExtern(externs.length, [receiver], output);
      this.assertAssignable(output.type, expected, node);
      return output;
    }
    let receiver: ValueRef | undefined;
    let owner: UdonType | undefined;
    owner = this.staticOwnerFromExpression(node.expression);
    if (!owner) {
      receiver = this.compileExpression(node.expression, scope, undefined, flow);
      owner = receiver.type;
    }
    const behavior = receiver?.behaviorType ? this.project?.behaviorsById.get(receiver.behaviorType) : undefined;
    if (receiver && behavior) {
      const field = behavior.fields.get(member);
      if (!field?.type) this.fail(`Behaviour '${behavior.name}' に型付き公開フィールド '${member}' がありません`, node.name);
      const type = this.requireType(field.type);
      const output = this.allocate(`${member}_remote`, type);
      const name = this.allocate(`__field_${member}`, "SystemString", escapeString(member));
      const boxed = this.allocate(`${member}_boxed`, "SystemObject");
      this.emitExtern("VRCUdonCommonInterfacesIUdonEventReceiver.__GetProgramVariable__SystemString__SystemObject", [receiver, name], boxed);
      this.copyUnchecked(boxed, output);
      const referencedBehavior = this.behaviorForTypeNode(field.type);
      if (referencedBehavior) output.behaviorType = referencedBehavior.id;
      this.assertAssignable(output.type, expected, node);
      return output;
    }
    const definition = this.registry.find(owner, member, "get");
    if (!definition) this.fail(`プロパティextern '${sourceTypeName(owner)}.${member}' がレジストリにありません`, node.name);
    const output = this.allocate(member, definition.returns);
    this.emitExtern(definition.signature, receiver ? [receiver] : [], output);
    this.assertAssignable(output.type, expected, node);
    return output;
  }

  private compilePropertySet(access: ts.PropertyAccessExpression, expression: ts.Expression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const member = access.name.text;
    if (access.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const target = scope.get(member);
      if (!target) this.fail(`フィールド '${member}' がありません`, access.name);
      const value = this.compileExpression(expression, scope, target.type, flow);
      this.copy(value, target, access);
      this.assertAssignable(value.type, expected, expression);
      return value;
    }
    let receiver: ValueRef | undefined;
    let owner = this.staticOwnerFromExpression(access.expression);
    if (!owner) {
      receiver = this.compileExpression(access.expression, scope, undefined, flow);
      owner = receiver.type;
    }
    const behavior = receiver?.behaviorType ? this.project?.behaviorsById.get(receiver.behaviorType) : undefined;
    if (receiver && behavior) {
      const field = behavior.fields.get(member);
      if (!field?.type) this.fail(`Behaviour '${behavior.name}' に型付き公開フィールド '${member}' がありません`, access.name);
      const type = this.requireType(field.type);
      const value = this.compileExpression(expression, scope, type, flow);
      const name = this.allocate(`__field_${member}`, "SystemString", escapeString(member));
      this.emitExtern("VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid", [receiver, name, value]);
      this.assertAssignable(value.type, expected, expression);
      return value;
    }
    const definition = this.selectExtern(owner, member, "set", [expression], scope, access.name);
    const parameter = definition.parameters[0];
    if (!parameter) this.fail(`setter extern '${definition.signature}' に値引数がありません`, access.name);
    const value = this.compileExpression(expression, scope, parameter.type, flow);
    this.emitExtern(definition.signature, receiver ? [receiver, value] : [value]);
    this.assertAssignable(value.type, expected, expression);
    return value;
  }

  private inlineFunction(fn: FunctionInfo, call: ts.CallExpression, callerScope: Scope, expected: UdonType | undefined, outerFlow: FlowContext): ValueRef {
    const body = fn.node.body;
    if (!body) this.fail(`関数 '${fn.name}' に本体がありません`, fn.node);
    if (this.callStack.includes(fn)) this.fail(`再帰呼び出し '${fn.name}' はUdon VMでは安全に展開できません`, call);
    if (call.arguments.length !== fn.node.parameters.length) this.fail(`関数 '${fn.name}' の引数の数が違います`, call);
    if (fn.comptime) {
      return this.materializeComptime(this.comptime.evaluateCall(fn, call), call, callerScope, expected, outerFlow);
    }
    this.callStack.push(fn);
    try {
      const scope = new Scope(this.globalScope);
      const directReturn = this.inlineOptimizer.directReturnExpression(fn.node);
      const canForwardParameters = this.inlineOptimizer.canForwardParameters(fn.node);
      fn.node.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) this.fail("分割代入パラメータは使えません", parameter.name);
        if (!parameter.type) this.fail(`引数 '${parameter.name.text}' に型注釈が必要です`, parameter);
        const type = this.requireType(parameter.type);
        const argument = this.compileExpression(call.arguments[index]!, callerScope, type, outerFlow);
        if (canForwardParameters && !this.inlineOptimizer.parameterRequiresStorage(fn.node, parameter.name.text)) {
          scope.set(parameter.name.text, argument);
          return;
        }
        const local = this.allocate(`${fn.name}_${parameter.name.text}`, type);
        const behavior = this.behaviorForTypeNode(parameter.type);
        if (behavior) local.behaviorType = behavior.id;
        this.copy(argument, local, call.arguments[index]!);
        scope.set(parameter.name.text, local);
      });
      if (directReturn && this.inlineOptimizer.canForwardReturn(fn.node, call)) {
        const value = this.compileExpression(
          directReturn,
          scope,
          fn.returnType === "SystemVoid" ? undefined : fn.returnType,
          outerFlow
        );
        this.assertAssignable(value.type, expected, call);
        return value;
      }
      const result = fn.returnType === "SystemVoid" ? undefined : this.allocate(`${fn.name}_return`, fn.returnType);
      const returnBehavior = fn.node.type ? this.behaviorForTypeNode(fn.node.type) : undefined;
      if (result && returnBehavior) result.behaviorType = returnBehavior.id;
      const endLabel = this.uniqueLabel(`${fn.name}_inline_end`);
      const functionFlow: FlowContext = { returnLabel: endLabel, ...(result ? { returnValue: result } : {}) };
      if (ts.isBlock(body)) {
        this.compileStatements(body.statements, scope, functionFlow);
      } else if (result) {
        this.copy(this.compileExpression(body, scope, fn.returnType, functionFlow), result, body);
      } else {
        this.compileExpression(body, scope, undefined, functionFlow);
      }
      this.label(endLabel);
      if (!result) return { symbol: "", type: "SystemVoid" };
      this.assertAssignable(result.type, expected, call);
      return result;
    } finally {
      this.callStack.pop();
    }
  }

  private inferExpressionType(node: ts.Expression, scope: Scope): UdonType | undefined {
    if (ts.isIdentifier(node)) {
      const value = scope.get(node.text) ?? this.importedGlobal(node);
      if (value) return value.type;
    }
    if (this.isComptimeCall(node)) return this.comptime.evaluateFactory(node as ts.CallExpression).type;
    if (ts.isCallExpression(node)) {
      const reference = ts.isIdentifier(node.expression)
        ? node.expression
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : undefined;
      const importedFunction = reference ? this.functionForReference(reference) : undefined;
      if (importedFunction) return importedFunction.returnType;
      if (ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const localMethod = this.functions.get(node.expression.name.text);
          if (localMethod) return localMethod.returnType;
        }
        const behavior = this.behaviorForExpression(node.expression.expression, scope);
        const method = behavior?.methods.get(node.expression.name.text);
        if (method) return method.type ? this.requireType(method.type) : "SystemVoid";
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const imported = this.importedGlobal(node.name);
      if (imported) return imported.type;
      const behavior = this.behaviorForExpression(node.expression, scope);
      const field = behavior?.fields.get(node.name.text);
      if (field?.type) return this.requireType(field.type);
    }
    return this.typeInference.infer(node, scope);
  }

  private inferLiteralType(node: ts.Expression): UdonType | undefined {
    return this.typeInference.inferLiteral(node);
  }

  private selectExtern(owner: UdonType, member: string, kind: "method" | "get" | "set", args: readonly ts.Expression[], scope: Scope, node: ts.Node): ExternDefinition {
    const named = this.registry.findAll(owner, member, kind);
    if (named.length === 0) this.fail(`extern '${sourceTypeName(owner)}.${member}' がレジストリにありません`, node);
    const sameArity = named.filter((definition) => definition.parameters.length === args.length);
    if (sameArity.length === 0) {
      const arities = [...new Set(named.map((definition) => definition.parameters.length))].join(" / ");
      this.fail(`${sourceTypeName(owner)}.${member} の引数は ${arities} 個ですが、${args.length} 個渡されています`, node);
    }
    const scored = sameArity.map((definition) => {
      let score = 0;
      for (let index = 0; index < args.length; index++) {
        const actual = this.inferExpressionType(args[index]!, scope);
        const expected = definition.parameters[index]!.type;
        if (!actual) continue;
        if (actual === expected) score += 2;
        else if (expected === "SystemObject") score += 1;
        else return { definition, score: -1 };
      }
      return { definition, score };
    }).filter((candidate) => candidate.score >= 0).sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      const actual = args.map((arg) => sourceTypeName(this.inferExpressionType(arg, scope) ?? "SystemObject")).join(", ");
      this.fail(`${sourceTypeName(owner)}.${member}(${actual}) に一致するexternオーバーロードがありません`, node);
    }
    if (scored.length > 1 && scored[0]!.score === scored[1]!.score && scored[0]!.definition.signature !== scored[1]!.definition.signature) {
      this.fail(`${sourceTypeName(owner)}.${member} のexternオーバーロードを一意に決定できません。引数へ型注釈を追加してください`, node);
    }
    return scored[0]!.definition;
  }

  private staticOwnerFromExpression(node: ts.Expression): UdonType | undefined {
    if (ts.isIdentifier(node)) return this.registry.staticOwner(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Udon") {
      return node.name.text;
    }
    return undefined;
  }

  private eventDefinitionsForName(name: string): readonly EventDefinition[] {
    const normalized = name.length > 0 ? name[0]!.toLowerCase() + name.slice(1) : name;
    return eventsBySourceName.get(name) ?? eventsBySourceName.get(normalized) ?? [];
  }

  private eventForName(name: string, arity?: number): EventDefinition | undefined {
    const definitions = this.eventDefinitionsForName(name);
    return arity === undefined
      ? definitions[0]
      : definitions.find((definition) => definition.parameters.length === arity);
  }

  private dataLiteral(node: ts.Expression, type: UdonType): string | undefined {
    if (ts.isNumericLiteral(node) && isNumeric(type)) return type === "SystemUInt32" ? `${node.text}u` : node.text;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand) && isNumeric(type)) {
      return `-${node.operand.text}`;
    }
    if (ts.isStringLiteralLike(node) && type === "SystemString") return escapeString(node.text);
    if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
    return undefined;
  }

  private requireLValue(node: ts.Expression, scope: Scope): ValueRef {
    if (!ts.isIdentifier(node)) this.fail("代入先/ref/out引数は現在、単純な変数である必要があります", node);
    const value = scope.get(node.text);
    if (!value) this.fail(`未定義の変数 '${node.text}' です`, node);
    return value;
  }

  private requireType(node: ts.TypeNode): UdonType {
    const sourceFile = node.getSourceFile();
    const behavior = this.behaviorForTypeNode(node);
    if (behavior) return "VRCUdonCommonInterfacesIUdonEventReceiver";
    const typeText = node.getText(sourceFile);
    const type = typeFromAnnotation(typeText);
    if (!type) this.fail(`Udon型として解決できません: ${typeText}`, node);
    return type;
  }

  private behaviorForTypeNode(node: ts.TypeNode): BehaviorDefinition | undefined {
    if (!this.project || !ts.isTypeReferenceNode(node)) return undefined;
    const declaration = this.declarationForReference(node.typeName);
    return declaration && ts.isClassDeclaration(declaration)
      ? this.project.behaviorsByDeclaration.get(declaration)
      : undefined;
  }

  private behaviorForExpression(node: ts.Expression, scope: Scope): BehaviorDefinition | undefined {
    if (ts.isParenthesizedExpression(node)) return this.behaviorForExpression(node.expression, scope);
    if (ts.isIdentifier(node)) {
      const value = scope.get(node.text) ?? this.importedGlobal(node);
      return value?.behaviorType ? this.project?.behaviorsById.get(value.behaviorType) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const value = scope.get(node.name.text);
      return value?.behaviorType ? this.project?.behaviorsById.get(value.behaviorType) : undefined;
    }
    return undefined;
  }

  private declarationForReference(node: ts.Node): ts.Declaration | undefined {
    if (!this.project) return undefined;
    let symbol = this.project.checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = this.project.checker.getAliasedSymbol(symbol);
    return symbol.valueDeclaration ?? symbol.declarations?.find((declaration) =>
      ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration) || ts.isClassDeclaration(declaration));
  }

  private functionForReference(node: ts.Node): FunctionInfo | undefined {
    const declaration = this.declarationForReference(node);
    return declaration ? this.functionsByDeclaration.get(declaration) : undefined;
  }

  private importedGlobal(node: ts.Node): ValueRef | undefined {
    const declaration = this.declarationForReference(node);
    return declaration && ts.isVariableDeclaration(declaration) ? this.globalsByDeclaration.get(declaration) : undefined;
  }

  private isComptimeCall(node: ts.Expression): boolean {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "comptime";
  }

  private resolveComptimeFunction(call: ts.CallExpression): FunctionInfo | undefined {
    let info: FunctionInfo | undefined;
    if (ts.isIdentifier(call.expression)) {
      info = this.functionForReference(call.expression) ?? this.functions.get(call.expression.text);
    } else if (ts.isPropertyAccessExpression(call.expression)) {
      info = this.functionForReference(call.expression.name);
      if (!info && call.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        info = this.functions.get(call.expression.name.text);
      }
    }
    return info;
  }

  private resolveComptimeConstant(identifier: ts.Identifier): ComptimeConstant | undefined {
    let declaration = this.declarationForReference(identifier);
    if (!declaration) {
      for (const statement of this.sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const found = statement.declarationList.declarations.find((item) =>
          ts.isIdentifier(item.name) && item.name.text === identifier.text);
        if (found) {
          declaration = found;
          break;
        }
      }
    }
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
      return undefined;
    }
    return {
      initializer: declaration.initializer,
      ...(declaration.type ? { type: this.requireType(declaration.type) } : {})
    };
  }

  private materializeComptime(
    value: ComptimeValue,
    node: ts.Node,
    scope: Scope,
    expected: UdonType | undefined,
    flow: FlowContext
  ): ValueRef {
    this.assertAssignable(value.type, expected, node);
    if (Array.isArray(value.value)) {
      const expression = this.comptimeValueExpression(value);
      if (!ts.isArrayLiteralExpression(expression)) this.fail("comptime配列を生成できません", node);
      return this.arrays.compileLiteral(expression, scope, value.type, flow, true);
    }
    if (value.type === "SystemBoolean" && typeof value.value === "boolean") {
      const expression = value.value ? ts.factory.createTrue() : ts.factory.createFalse();
      return this.compileExpression(expression, scope, expected ?? value.type, flow);
    }
    const initial = encodeComptimeScalar(value);
    if (initial === undefined) this.fail(`${sourceTypeName(value.type)}のcomptime値をUASMへ変換できません`, node);
    return this.allocate("comptime", value.type, initial);
  }

  private comptimeValueExpression(value: ComptimeValue): ts.Expression {
    if (Array.isArray(value.value)) {
      return ts.factory.createArrayLiteralExpression(value.value.map((item) => this.comptimeValueExpression(item)));
    }
    if (value.value === null) return ts.factory.createNull();
    if (typeof value.value === "boolean") return value.value ? ts.factory.createTrue() : ts.factory.createFalse();
    if (typeof value.value === "string") return ts.factory.createStringLiteral(value.value);
    const text = value.value.toString();
    return text.startsWith("-")
      ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(text.slice(1)))
      : ts.factory.createNumericLiteral(text);
  }

  private assertAssignable(actual: UdonType, expected: UdonType | undefined, node: ts.Node): void {
    if (!expected || expected === actual || expected === "SystemObject" || actual === "SystemVoid") return;
    this.fail(`${sourceTypeName(actual)} を ${sourceTypeName(expected)} として使用できません`, node);
  }

  private copy(source: ValueRef, target: ValueRef, node: ts.Node): void {
    this.assertAssignable(source.type, target.type, node);
    this.assembly.copy(source, target);
  }

  private copyUnchecked(source: ValueRef, target: ValueRef): void {
    this.assembly.copy(source, target);
  }

  private emitExtern(signature: string, args: readonly ValueRef[], output?: ValueRef, conservativeMutates = false): void {
    const definition = this.registry.definitions.find((item) => item.signature === signature);
    const mutates = conservativeMutates
      ? args
      : definition
        ? definition.parameters.flatMap((parameter, index) => {
            if (parameter.mode !== "ref" && parameter.mode !== "out") return [];
            const argument = args[index + (definition.static ? 0 : 1)];
            return argument ? [argument] : [];
          })
        : [];
    this.assembly.emitExtern(signature, args, output, mutates);
  }

  private allocate(base: string, type: UdonType, initial = defaultValue(type), options: AllocationOptions = {}): ValueRef {
    return this.assembly.allocate(base, type, initial, options);
  }

  private label(label: string): void {
    this.assembly.label(label);
  }
  private jumpIfFalse(condition: ValueRef, target: string): void { this.assembly.jumpIfFalse(condition, target); }
  private emit(line: string): void { this.assembly.emit(line); }
  private uniqueLabel(base: string): string { return this.assembly.uniqueLabel(base); }
  private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
  }
  private hasDecorator(node: ts.Node, name: string): boolean {
    if (!ts.canHaveDecorators(node)) return false;
    return (ts.getDecorators(node) ?? []).some((decorator) =>
      ts.isIdentifier(decorator.expression) && decorator.expression.text === name);
  }
  private sourceComment(node: ts.Node): void {
    if (!this.options.sourceMapComments) return;
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.emit(`# ${sourceFile.fileName}:${position.line + 1}`);
  }
  private fail(message: string, node: ts.Node): never { throw new CompileFailure(message, node); }
  private tryCompile(node: ts.Node, action: () => void): void {
    try { action(); } catch (error) { this.capture(error, node); }
  }
  private capture(error: unknown, fallback?: ts.Node): void {
    const node = error instanceof CompileFailure ? error.node : fallback ?? this.sourceFile;
    const sourceFile = node.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.diagnostics.push({
      file: sourceFile.fileName,
      line: position.line + 1,
      column: position.character + 1,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  return new Compiler(source, options).compile();
}

export function compileSourceFile(
  sourceFile: ts.SourceFile,
  options: CompileOptions,
  project: CompilerProjectContext
): CompileResult {
  return new Compiler(sourceFile, { ...options, fileName: sourceFile.fileName }, project).compile();
}
