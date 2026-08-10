import ts from "typescript";
import type { FunctionNode } from "./compiler-context.js";
import type { UdonType } from "../model.js";
import { arrayElementType, isArray, isNumeric, sourceTypeName } from "../type-system.js";

export type ComptimeScalar = bigint | number | string | boolean | null;

export interface ComptimeValue {
  type: UdonType;
  value: ComptimeScalar | ComptimeValue[];
}

export interface ComptimeFunction {
  node: FunctionNode;
  name: string;
  returnType: UdonType;
}

export interface ComptimeConstant {
  initializer: ts.Expression;
  type?: UdonType;
}

export interface ComptimeContext {
  resolveFunction(call: ts.CallExpression): ComptimeFunction | undefined;
  resolveConstant(identifier: ts.Identifier): ComptimeConstant | undefined;
  requireType(node: ts.TypeNode): UdonType;
  fail(message: string, node: ts.Node): never;
}

type Signal =
  | { kind: "normal" }
  | { kind: "return"; value?: ComptimeValue }
  | { kind: "break" }
  | { kind: "continue" };

const normal: Signal = { kind: "normal" };

function clone(value: ComptimeValue): ComptimeValue {
  return {
    type: value.type,
    value: Array.isArray(value.value) ? value.value.map(clone) : value.value
  };
}

function integer(type: UdonType, value: bigint): bigint {
  return type === "SystemUInt32" ? BigInt.asUintN(32, value) : BigInt.asIntN(32, value);
}

function numeric(type: UdonType, value: bigint | number): bigint | number {
  if (type === "SystemInt32" || type === "SystemUInt32") {
    return integer(type, typeof value === "bigint" ? value : BigInt(Math.trunc(value)));
  }
  const number = typeof value === "bigint" ? Number(value) : value;
  return type === "SystemSingle" ? Math.fround(number) : number;
}

function defaultComptimeValue(type: UdonType): ComptimeValue {
  if (type === "SystemInt32" || type === "SystemUInt32") return { type, value: 0n };
  if (type === "SystemSingle" || type === "SystemDouble") return { type, value: 0 };
  if (type === "SystemBoolean") return { type, value: false };
  return { type, value: null };
}

function truthy(value: ComptimeValue): boolean {
  if (typeof value.value === "boolean") return value.value;
  if (typeof value.value === "bigint") return value.value !== 0n;
  if (typeof value.value === "number") return value.value !== 0;
  if (typeof value.value === "string") return value.value.length > 0;
  return value.value !== null;
}

/** Deterministic, side-effect-free interpreter for the supported TypeScript subset. */
export class ComptimeEvaluator {
  private steps = 0;
  private depth = 0;
  private readonly constantCache = new Map<ts.Expression, ComptimeValue>();
  private readonly evaluatingConstants = new Set<ts.Expression>();

  constructor(private readonly context: ComptimeContext, private readonly maxSteps = 100_000) {}

  evaluateFactory(call: ts.CallExpression): ComptimeValue {
    if (this.depth === 0) this.steps = 0;
    if (call.arguments.length !== 1 || call.typeArguments?.length) {
      this.context.fail("comptimeには引数なし関数を1つ指定してください", call);
    }
    const factory = call.arguments[0]!;
    if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) {
      this.context.fail("comptimeの引数にはアロー関数または関数式を指定してください", factory);
    }
    if (factory.parameters.length > 0) this.context.fail("comptimeファクトリに引数は指定できません", factory.parameters[0]!);
    const returnType = factory.type ? this.context.requireType(factory.type) : undefined;
    return this.evaluateFunction({ node: factory, name: "comptime", returnType: returnType ?? "SystemVoid" }, [], returnType);
  }

  evaluateCall(fn: ComptimeFunction, call: ts.CallExpression): ComptimeValue {
    if (this.depth === 0) this.steps = 0;
    const args = call.arguments.map((argument, index) => {
      const parameter = fn.node.parameters[index];
      const expected = parameter?.type ? this.context.requireType(parameter.type) : undefined;
      return this.evaluateExpression(argument, new Map(), expected);
    });
    return this.evaluateFunction(fn, args);
  }

  inferFactoryType(call: ts.CallExpression): UdonType | undefined {
    try { return this.evaluateFactory(call).type; }
    catch { return undefined; }
  }

  private tick(node: ts.Node): void {
    this.steps++;
    if (this.steps > this.maxSteps) {
      this.context.fail(`comptimeの評価ステップ数が上限${this.maxSteps}を超えました`, node);
    }
  }

  private evaluateFunction(fn: ComptimeFunction, args: readonly ComptimeValue[], expectedReturn?: UdonType): ComptimeValue {
    this.depth++;
    if (this.depth > 64) this.context.fail("comptimeの呼び出し深度が64を超えました", fn.node);
    try {
      if (args.length !== fn.node.parameters.length) {
        this.context.fail(`comptime関数 '${fn.name}' の引数の数が違います`, fn.node);
      }
      const env = new Map<string, ComptimeValue>();
      fn.node.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) this.context.fail("comptimeでは分割代入引数を使用できません", parameter.name);
        const value = args[index]!;
        const expected = parameter.type ? this.context.requireType(parameter.type) : value.type;
        this.assertType(value, expected, parameter);
        env.set(parameter.name.text, clone(value));
      });
      if (!fn.node.body) this.context.fail(`comptime関数 '${fn.name}' に本体がありません`, fn.node);
      const returnType = expectedReturn ?? fn.returnType;
      if (!ts.isBlock(fn.node.body)) {
        const value = this.evaluateExpression(fn.node.body, env, returnType);
        if (returnType !== "SystemVoid") this.assertType(value, returnType, fn.node.body);
        return value;
      }
      const signal = this.executeStatements(fn.node.body.statements, env, returnType);
      if (signal.kind !== "return" || !signal.value) {
        this.context.fail(`comptime関数 '${fn.name}' は値を返す必要があります`, fn.node);
      }
      if (returnType !== "SystemVoid") this.assertType(signal.value, returnType, fn.node);
      return signal.value;
    } finally {
      this.depth--;
    }
  }

  private executeStatements(statements: readonly ts.Statement[], env: Map<string, ComptimeValue>, returnType: UdonType): Signal {
    for (const statement of statements) {
      const signal = this.executeStatement(statement, env, returnType);
      if (signal.kind !== "normal") return signal;
    }
    return normal;
  }

  private executeStatement(statement: ts.Statement, env: Map<string, ComptimeValue>, returnType: UdonType): Signal {
    this.tick(statement);
    if (ts.isBlock(statement)) return this.executeStatements(statement.statements, env, returnType);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          this.context.fail("comptime変数には単純な名前と初期値が必要です", declaration);
        }
        const expected = declaration.type ? this.context.requireType(declaration.type) : undefined;
        const value = this.evaluateExpression(declaration.initializer, env, expected);
        if (expected) this.assertType(value, expected, declaration.initializer);
        env.set(declaration.name.text, value);
      }
      return normal;
    }
    if (ts.isExpressionStatement(statement)) {
      this.evaluateExpression(statement.expression, env);
      return normal;
    }
    if (ts.isReturnStatement(statement)) {
      return {
        kind: "return",
        ...(statement.expression ? { value: this.evaluateExpression(statement.expression, env, returnType) } : {})
      };
    }
    if (ts.isIfStatement(statement)) {
      const branch = truthy(this.evaluateExpression(statement.expression, env, "SystemBoolean"))
        ? statement.thenStatement
        : statement.elseStatement;
      return branch ? this.executeStatement(branch, env, returnType) : normal;
    }
    if (ts.isWhileStatement(statement)) {
      while (truthy(this.evaluateExpression(statement.expression, env, "SystemBoolean"))) {
        this.tick(statement);
        const signal = this.executeStatement(statement.statement, env, returnType);
        if (signal.kind === "return") return signal;
        if (signal.kind === "break") break;
      }
      return normal;
    }
    if (ts.isForStatement(statement)) {
      if (statement.initializer) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          const variable = ts.factory.createVariableStatement(undefined, statement.initializer);
          this.executeStatement(variable, env, returnType);
        } else this.evaluateExpression(statement.initializer, env);
      }
      while (!statement.condition || truthy(this.evaluateExpression(statement.condition, env, "SystemBoolean"))) {
        this.tick(statement);
        const signal = this.executeStatement(statement.statement, env, returnType);
        if (signal.kind === "return") return signal;
        if (signal.kind === "break") break;
        if (statement.incrementor) this.evaluateExpression(statement.incrementor, env);
      }
      return normal;
    }
    if (ts.isBreakStatement(statement)) return { kind: "break" };
    if (ts.isContinueStatement(statement)) return { kind: "continue" };
    this.context.fail(`comptimeでは${ts.SyntaxKind[statement.kind]}文を使用できません`, statement);
  }

  private evaluateExpression(node: ts.Expression, env: Map<string, ComptimeValue>, expected?: UdonType): ComptimeValue {
    this.tick(node);
    if (ts.isParenthesizedExpression(node)) return this.evaluateExpression(node.expression, env, expected);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return this.evaluateExpression(node.expression, env, this.context.requireType(node.type));
    }
    if (ts.isNumericLiteral(node)) {
      const type = expected && isNumeric(expected)
        ? expected
        : node.text.includes(".") || /e/iu.test(node.text) ? "SystemSingle" : "SystemInt32";
      return { type, value: numeric(type, type === "SystemInt32" || type === "SystemUInt32" ? BigInt(node.text) : Number(node.text)) };
    }
    if (ts.isStringLiteralLike(node)) return { type: "SystemString", value: node.text };
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: "SystemBoolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return { type: expected ?? "SystemObject", value: null };
    if (ts.isIdentifier(node)) {
      const local = env.get(node.text);
      if (local) return clone(local);
      const constant = this.context.resolveConstant(node);
      if (!constant) this.context.fail(`'${node.text}' はcomptimeで確定していません`, node);
      const cached = this.constantCache.get(constant.initializer);
      if (cached) return clone(cached);
      if (this.evaluatingConstants.has(constant.initializer)) {
        this.context.fail(`comptime定数 '${node.text}' が循環参照しています`, node);
      }
      this.evaluatingConstants.add(constant.initializer);
      try {
        const value = this.evaluateExpression(constant.initializer, env, constant.type ?? expected);
        this.constantCache.set(constant.initializer, clone(value));
        return value;
      } finally {
        this.evaluatingConstants.delete(constant.initializer);
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      const elementType = expected ? arrayElementType(expected) : undefined;
      const values = node.elements.map((element) => {
        if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
          this.context.fail("comptime配列ではspreadと空要素を使用できません", element);
        }
        return this.evaluateExpression(element, env, elementType);
      });
      const inferredElement = elementType ?? values[0]?.type;
      if (!inferredElement) this.context.fail("空のcomptime配列には型注釈が必要です", node);
      return { type: expected ?? `${inferredElement}Array`, value: values };
    }
    if (ts.isNewExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "Array") {
        this.context.fail("comptimeでnewできるのは new Array<T>(length) のみです", node);
      }
      const typeArgument = node.typeArguments?.[0];
      if (!typeArgument || node.typeArguments?.length !== 1) {
        this.context.fail("comptimeのnew Array<T>(length)には要素型を1つ指定してください", node);
      }
      const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      if (args.length !== 1) {
        this.context.fail("comptimeのnew Array<T>(length)には長さを1つ指定してください", node);
      }
      const elementType = this.context.requireType(typeArgument);
      const arrayType = `${elementType}Array`;
      const length = this.evaluateExpression(args[0]!, env);
      if (length.type !== "SystemInt32" || typeof length.value !== "bigint") {
        this.context.fail("comptime配列の長さはコンパイル時に確定するintで指定してください", args[0]!);
      }
      if (length.value < 0n) this.context.fail("comptime配列の長さは0以上にしてください", args[0]!);
      if (length.value > BigInt(this.maxSteps)) {
        this.context.fail(`comptime配列の長さが上限${this.maxSteps}を超えています`, args[0]!);
      }
      const values: ComptimeValue[] = [];
      const initial = defaultComptimeValue(elementType);
      for (let index = 0; index < Number(length.value); index++) {
        this.tick(node);
        values.push(clone(initial));
      }
      const value = { type: arrayType, value: values } satisfies ComptimeValue;
      if (expected) this.assertType(value, expected, node);
      return value;
    }
    if (ts.isElementAccessExpression(node)) {
      const array = this.evaluateExpression(node.expression, env);
      const index = node.argumentExpression ? this.evaluateExpression(node.argumentExpression, env, "SystemInt32") : undefined;
      if (!Array.isArray(array.value) || !index || typeof index.value !== "bigint") {
        this.context.fail("comptime配列のindexを解決できません", node);
      }
      const value = array.value[Number(index.value)];
      if (!value) this.context.fail("comptime配列のindexが範囲外です", node);
      return clone(value);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "length") {
      const target = this.evaluateExpression(node.expression, env);
      if (!Array.isArray(target.value) && typeof target.value !== "string") {
        this.context.fail("comptimeでlengthを取得できない値です", node);
      }
      return { type: "SystemInt32", value: BigInt(target.value.length) };
    }
    if (ts.isPropertyAccessExpression(node)) {
      this.context.fail(`'${node.getText()}' はcomptimeで確定していません`, node);
    }
    if (ts.isConditionalExpression(node)) {
      return truthy(this.evaluateExpression(node.condition, env, "SystemBoolean"))
        ? this.evaluateExpression(node.whenTrue, env, expected)
        : this.evaluateExpression(node.whenFalse, env, expected);
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      return this.evaluateUnary(node, env, expected);
    }
    if (ts.isBinaryExpression(node)) return this.evaluateBinary(node, env, expected);
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "comptime") return this.evaluateFactory(node);
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === "Math" || node.expression.expression.text === "Mathf")) {
        return this.evaluateMath(node, env, expected);
      }
      const fn = this.context.resolveFunction(node);
      if (!fn) this.context.fail("comptimeでは純粋なユーザー関数とMath/Mathfだけを呼び出せます", node.expression);
      const args = node.arguments.map((argument, index) => {
        const parameter = fn.node.parameters[index];
        return this.evaluateExpression(argument, env, parameter?.type ? this.context.requireType(parameter.type) : undefined);
      });
      return this.evaluateFunction(fn, args);
    }
    this.context.fail(`comptimeでは式${ts.SyntaxKind[node.kind]}を使用できません`, node);
  }

  private evaluateUnary(
    node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
    env: Map<string, ComptimeValue>,
    expected?: UdonType
  ): ComptimeValue {
    const operand = this.evaluateExpression(node.operand, env, expected);
    const operator = node.operator;
    if (operator === ts.SyntaxKind.ExclamationToken) return { type: "SystemBoolean", value: !truthy(operand) };
    if (operator === ts.SyntaxKind.MinusToken && (typeof operand.value === "bigint" || typeof operand.value === "number")) {
      return { type: operand.type, value: numeric(operand.type, typeof operand.value === "bigint" ? -operand.value : -operand.value) };
    }
    if (operator === ts.SyntaxKind.TildeToken && typeof operand.value === "bigint") {
      return { type: operand.type, value: integer(operand.type, ~operand.value) };
    }
    if ((operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(node.operand)) {
      const delta = operator === ts.SyntaxKind.PlusPlusToken ? 1n : -1n;
      if (typeof operand.value !== "bigint") this.context.fail("comptimeの++/--は整数だけに使用できます", node);
      const updated = { type: operand.type, value: integer(operand.type, operand.value + delta) } satisfies ComptimeValue;
      env.set(node.operand.text, updated);
      return ts.isPostfixUnaryExpression(node) ? operand : clone(updated);
    }
    this.context.fail("comptimeで未対応の単項演算です", node);
  }

  private evaluateBinary(node: ts.BinaryExpression, env: Map<string, ComptimeValue>, expected?: UdonType): ComptimeValue {
    const operator = ts.tokenToString(node.operatorToken.kind) ?? "";
    if (["=", "+=", "-=", "*=", "/=", "%="].includes(operator)) {
      if (ts.isElementAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && node.left.argumentExpression) {
        const array = env.get(node.left.expression.text);
        const index = this.evaluateExpression(node.left.argumentExpression, env, "SystemInt32");
        if (!array || !Array.isArray(array.value) || typeof index.value !== "bigint") {
          this.context.fail("comptime配列の代入先を解決できません", node.left);
        }
        const position = Number(index.value);
        const current = array.value[position];
        const elementType = arrayElementType(array.type);
        if (!current || !elementType) this.context.fail("comptime配列のindexが範囲外です", node.left);
        const value = operator === "="
          ? this.evaluateExpression(node.right, env, elementType)
          : this.applyBinary(operator.slice(0, -1), current, this.evaluateExpression(node.right, env, elementType), node);
        array.value[position] = clone(value);
        return value;
      }
      if (!ts.isIdentifier(node.left)) this.context.fail("comptimeの代入先は単純な変数である必要があります", node.left);
      const current = env.get(node.left.text);
      if (!current) this.context.fail(`comptime変数 '${node.left.text}' がありません`, node.left);
      const value = operator === "="
        ? this.evaluateExpression(node.right, env, current.type)
        : this.applyBinary(operator.slice(0, -1), current, this.evaluateExpression(node.right, env, current.type), node);
      env.set(node.left.text, clone(value));
      return value;
    }
    if (operator === "&&") {
      const left = this.evaluateExpression(node.left, env, "SystemBoolean");
      return truthy(left) ? this.evaluateExpression(node.right, env, "SystemBoolean") : left;
    }
    if (operator === "||") {
      const left = this.evaluateExpression(node.left, env, "SystemBoolean");
      return truthy(left) ? left : this.evaluateExpression(node.right, env, "SystemBoolean");
    }
    const left = this.evaluateExpression(node.left, env, expected);
    const right = this.evaluateExpression(node.right, env, left.type);
    return this.applyBinary(operator, left, right, node);
  }

  private applyBinary(operator: string, left: ComptimeValue, right: ComptimeValue, node: ts.Node): ComptimeValue {
    this.assertType(right, left.type, node);
    if (operator === "+" && typeof left.value === "string" && typeof right.value === "string") {
      return { type: "SystemString", value: left.value + right.value };
    }
    if (["==", "===", "!=", "!==", "<", "<=", ">", ">="].includes(operator)) {
      const a = left.value as ComptimeScalar;
      const b = right.value as ComptimeScalar;
      let result: boolean;
      if (operator === "==" || operator === "===") result = a === b;
      else if (operator === "!=" || operator === "!==") result = a !== b;
      else if (operator === "<") result = a! < b!;
      else if (operator === "<=") result = a! <= b!;
      else if (operator === ">") result = a! > b!;
      else result = a! >= b!;
      return { type: "SystemBoolean", value: result };
    }
    if ((typeof left.value !== "bigint" && typeof left.value !== "number") ||
      (typeof right.value !== "bigint" && typeof right.value !== "number")) {
      this.context.fail(`comptime演算子'${operator}'を${sourceTypeName(left.type)}へ使用できません`, node);
    }
    if (typeof left.value === "bigint" && typeof right.value === "bigint") {
      let result: bigint;
      if (operator === "+") result = left.value + right.value;
      else if (operator === "-") result = left.value - right.value;
      else if (operator === "*") result = left.value * right.value;
      else if (operator === "/") {
        if (right.value === 0n) this.context.fail("comptimeで0除算はできません", node);
        result = left.value / right.value;
      } else if (operator === "%") {
        if (right.value === 0n) this.context.fail("comptimeで0除算はできません", node);
        result = left.value % right.value;
      } else if (operator === "&") result = left.value & right.value;
      else if (operator === "|") result = left.value | right.value;
      else if (operator === "^") result = left.value ^ right.value;
      else if (operator === "<<") result = left.value << BigInt(Number(right.value & 31n));
      else if (operator === ">>") result = left.value >> BigInt(Number(right.value & 31n));
      else this.context.fail(`comptimeで未対応の演算子'${operator}'です`, node);
      return { type: left.type, value: integer(left.type, result) };
    }
    const a = Number(left.value);
    const b = Number(right.value);
    let result: number;
    if (operator === "+") result = a + b;
    else if (operator === "-") result = a - b;
    else if (operator === "*") result = a * b;
    else if (operator === "/") result = a / b;
    else if (operator === "%") result = a % b;
    else this.context.fail(`comptimeで未対応の演算子'${operator}'です`, node);
    return { type: left.type, value: numeric(left.type, result) };
  }

  private evaluateMath(node: ts.CallExpression, env: Map<string, ComptimeValue>, expected?: UdonType): ComptimeValue {
    const access = node.expression as ts.PropertyAccessExpression;
    const name = access.name.text.toLowerCase();
    const args = node.arguments.map((argument) => this.evaluateExpression(argument, env, expected ?? "SystemSingle"));
    const numbers = args.map((value) => Number(value.value));
    let result: number | undefined;
    if (name === "sin") result = Math.sin(numbers[0]!);
    else if (name === "cos") result = Math.cos(numbers[0]!);
    else if (name === "clamp") result = Math.min(Math.max(numbers[0]!, numbers[1]!), numbers[2]!);
    else if (name === "abs") result = Math.abs(numbers[0]!);
    else if (name === "min") result = Math.min(...numbers);
    else if (name === "max") result = Math.max(...numbers);
    else this.context.fail(`Math.${access.name.text}はcomptimeで許可されていません`, access.name);
    const type = expected && isNumeric(expected) ? expected : args[0]?.type ?? "SystemSingle";
    return { type, value: numeric(type, result) };
  }

  private assertType(value: ComptimeValue, expected: UdonType, node: ts.Node): void {
    if (value.type !== expected && expected !== "SystemObject") {
      this.context.fail(`${sourceTypeName(value.type)}を${sourceTypeName(expected)}としてcomptime評価できません`, node);
    }
  }
}

export function encodeComptimeScalar(value: ComptimeValue): string | undefined {
  if (Array.isArray(value.value)) return undefined;
  if (value.value === null) return "null";
  if (value.type === "SystemString" && typeof value.value === "string") return JSON.stringify(value.value);
  // Udon represents false as null. true needs the normal boolean lowering path
  // (logical negation of false); "true" is not a portable data-section literal.
  if (value.type === "SystemBoolean" && typeof value.value === "boolean") return value.value ? undefined : "null";
  if (value.type === "SystemUInt32" && typeof value.value === "bigint") return `${BigInt.asUintN(32, value.value)}u`;
  if (value.type === "SystemInt32" && typeof value.value === "bigint") return BigInt.asIntN(32, value.value).toString();
  if ((value.type === "SystemSingle" || value.type === "SystemDouble") && typeof value.value === "number") {
    const number = value.type === "SystemSingle" ? Math.fround(value.value) : value.value;
    return Number.isFinite(number) ? String(number) : undefined;
  }
  return undefined;
}
