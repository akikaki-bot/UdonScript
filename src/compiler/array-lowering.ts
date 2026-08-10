import ts from "typescript";
import type { FlowContext, Scope, ValueRef } from "./compiler-context.js";
import type { UdonType } from "../model.js";
import { arrayElementType, isArray, sourceTypeName } from "../type-system.js";

function isDefaultElement(node: ts.Expression, elementType: UdonType): boolean {
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (elementType === "SystemBoolean" && node.kind === ts.SyntaxKind.FalseKeyword) return true;
  if ((elementType === "SystemInt32" || elementType === "SystemUInt32" ||
    elementType === "SystemSingle" || elementType === "SystemDouble") && ts.isNumericLiteral(node)) {
    return Number(node.text) === 0;
  }
  return false;
}

export interface ArrayExterns {
  elementType: UdonType;
  constructor: string;
  get: string;
  set: string;
  length: string;
}

export function arrayExterns(arrayType: UdonType): ArrayExterns | undefined {
  const elementType = arrayElementType(arrayType);
  if (!elementType) return undefined;
  return {
    elementType,
    constructor: `${arrayType}.__ctor__SystemInt32__${arrayType}`,
    get: `${arrayType}.__Get__SystemInt32__${elementType}`,
    set: `${arrayType}.__Set__SystemInt32_${elementType}__SystemVoid`,
    length: `${arrayType}.__get_Length__SystemInt32`
  };
}

export interface ArrayLoweringContext {
  compileExpression(node: ts.Expression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef;
  inferExpressionType(node: ts.Expression, scope: Scope): UdonType | undefined;
  allocate(base: string, type: UdonType, initial?: string): ValueRef;
  emitExtern(signature: string, args: readonly ValueRef[], output?: ValueRef): void;
  assertAssignable(actual: UdonType, expected: UdonType | undefined, node: ts.Node): void;
  requireType(node: ts.TypeNode): UdonType;
  fail(message: string, node: ts.Node): never;
}

/** Lowers TypeScript array syntax to Udon's type-specific array externs. */
export class ArrayLowerer {
  constructor(private readonly context: ArrayLoweringContext) {}

  compileLiteral(
    node: ts.ArrayLiteralExpression,
    scope: Scope,
    expected: UdonType | undefined,
    flow: FlowContext,
    skipDefaultElements = false
  ): ValueRef {
    const arrayType = expected && isArray(expected)
      ? expected
      : this.context.inferExpressionType(node, scope);
    const externs = arrayType ? arrayExterns(arrayType) : undefined;
    if (!arrayType || !externs) {
      this.context.fail("空の配列または型を推論できない配列には int[] のような型注釈が必要です", node);
    }
    const length = this.context.allocate("array_length", "SystemInt32", String(node.elements.length));
    const output = this.context.allocate("array", arrayType);
    this.context.emitExtern(externs.constructor, [length], output);
    node.elements.forEach((element, index) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        this.context.fail("配列のspreadと空要素には対応していません", element);
      }
      if (skipDefaultElements && isDefaultElement(element, externs.elementType)) return;
      const indexValue = this.context.allocate("array_index", "SystemInt32", String(index));
      const value = this.context.compileExpression(element, scope, externs.elementType, flow);
      this.context.emitExtern(externs.set, [output, indexValue, value]);
    });
    this.context.assertAssignable(output.type, expected, node);
    return output;
  }

  compileNew(node: ts.NewExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "Array") {
      this.context.fail("現在newで生成できるのは new Array<T>(length) のみです", node);
    }
    const typeArgument = node.typeArguments?.[0];
    if (!typeArgument || node.typeArguments?.length !== 1) {
      this.context.fail("new Array<T>(length) には要素型を1つ指定してください", node);
    }
    const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    if (args.length !== 1) this.context.fail("new Array<T>(length) には長さを1つ指定してください", node);
    const elementType = this.context.requireType(typeArgument);
    const arrayType = `${elementType}Array`;
    const externs = arrayExterns(arrayType)!;
    const length = this.context.compileExpression(args[0]!, scope, "SystemInt32", flow);
    const output = this.context.allocate("array", arrayType);
    this.context.emitExtern(externs.constructor, [length], output);
    this.context.assertAssignable(output.type, expected, node);
    return output;
  }

  compileGet(node: ts.ElementAccessExpression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const array = this.context.compileExpression(node.expression, scope, undefined, flow);
    const externs = arrayExterns(array.type);
    if (!externs) this.context.fail(`${sourceTypeName(array.type)} は配列ではありません`, node.expression);
    if (!node.argumentExpression) this.context.fail("配列のindexが必要です", node);
    const index = this.context.compileExpression(node.argumentExpression, scope, "SystemInt32", flow);
    const output = this.context.allocate("element", externs.elementType);
    this.context.emitExtern(externs.get, [array, index], output);
    this.context.assertAssignable(output.type, expected, node);
    return output;
  }

  compileSet(access: ts.ElementAccessExpression, expression: ts.Expression, scope: Scope, expected: UdonType | undefined, flow: FlowContext): ValueRef {
    const array = this.context.compileExpression(access.expression, scope, undefined, flow);
    const externs = arrayExterns(array.type);
    if (!externs) this.context.fail(`${sourceTypeName(array.type)} は配列ではありません`, access.expression);
    if (!access.argumentExpression) this.context.fail("配列のindexが必要です", access);
    const index = this.context.compileExpression(access.argumentExpression, scope, "SystemInt32", flow);
    const value = this.context.compileExpression(expression, scope, externs.elementType, flow);
    this.context.emitExtern(externs.set, [array, index, value]);
    this.context.assertAssignable(value.type, expected, expression);
    return value;
  }
}
