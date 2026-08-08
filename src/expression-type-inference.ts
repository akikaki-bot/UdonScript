import ts from "typescript";
import type { Scope } from "./compiler-context.js";
import type { UdonType } from "./model.js";
import { arrayElementType, isArray } from "./type-system.js";

export interface TypeInferenceContext {
  functionReturnType(name: string): UdonType | undefined;
  externReturnType(owner: UdonType, member: string, kind: "method" | "get"): UdonType | undefined;
  staticOwner(node: ts.Expression): UdonType | undefined;
  requireType(node: ts.TypeNode): UdonType;
}

/** Performs syntax-directed Udon type inference without emitting assembly. */
export class ExpressionTypeInferer {
  constructor(private readonly context: TypeInferenceContext) {}

  infer(node: ts.Expression, scope: Scope): UdonType | undefined {
    if (ts.isParenthesizedExpression(node)) return this.infer(node.expression, scope);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return this.context.requireType(node.type);
    if (ts.isIdentifier(node)) return scope.get(node.text)?.type;
    if (ts.isNumericLiteral(node)) return this.inferLiteral(node);
    if (ts.isStringLiteralLike(node)) return "SystemString";
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "SystemBoolean";
    if (node.kind === ts.SyntaxKind.NullKeyword) return "SystemObject";
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements.find((element) => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element));
      const elementType = first ? this.infer(first, scope) : undefined;
      return elementType && elementType !== "SystemVoid" ? `${elementType}Array` : undefined;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Array") {
      const typeArgument = node.typeArguments?.[0];
      const elementType = typeArgument ? this.context.requireType(typeArgument) : undefined;
      return elementType ? `${elementType}Array` : undefined;
    }
    if (ts.isElementAccessExpression(node)) {
      const arrayType = this.infer(node.expression, scope);
      return arrayType ? arrayElementType(arrayType) : undefined;
    }
    if (ts.isConditionalExpression(node)) return this.infer(node.whenTrue, scope);
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return "SystemBoolean";
      return this.infer(node.operand, scope);
    }
    if (ts.isBinaryExpression(node)) {
      const operator = ts.tokenToString(node.operatorToken.kind) ?? "";
      if (["==", "===", "!=", "!==", "<", "<=", ">", ">=", "&&", "||"].includes(operator)) return "SystemBoolean";
      return this.infer(node.left, scope);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) return this.context.functionReturnType(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const owner = this.context.staticOwner(node.expression.expression)
          ?? this.infer(node.expression.expression, scope);
        return owner ? this.context.externReturnType(owner, node.expression.name.text, "method") : undefined;
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) return scope.get(node.name.text)?.type;
      const owner = this.context.staticOwner(node.expression)
        ?? this.infer(node.expression, scope);
      if (node.name.text === "length" && owner && isArray(owner)) return "SystemInt32";
      return owner ? this.context.externReturnType(owner, node.name.text, "get") : undefined;
    }
    return undefined;
  }

  inferLiteral(node: ts.Expression): UdonType | undefined {
    if (ts.isNumericLiteral(node)) return node.text.includes(".") || /e/i.test(node.text) ? "SystemSingle" : "SystemInt32";
    if (ts.isStringLiteralLike(node)) return "SystemString";
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "SystemBoolean";
    if (node.kind === ts.SyntaxKind.NullKeyword) return "SystemObject";
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements.find((element) => !ts.isOmittedExpression(element) && !ts.isSpreadElement(element));
      const elementType = first ? this.inferLiteral(first) : undefined;
      return elementType && elementType !== "SystemVoid" ? `${elementType}Array` : undefined;
    }
    return undefined;
  }
}
