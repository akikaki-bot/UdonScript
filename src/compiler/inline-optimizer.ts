import ts from "typescript";
import type { ExternDefinition } from "../model.js";
import type { FunctionInfo, FunctionNode } from "./compiler-context.js";

interface InlineOptimizerContext {
  readonly externs: readonly ExternDefinition[];
  resolveFunction(call: ts.CallExpression): FunctionInfo | undefined;
  isComptimeCall(node: ts.Expression): boolean;
}

/** Conservative AST analysis used before the lower-level Udon IR optimizer. */
export class InlineOptimizer {
  constructor(private readonly context: InlineOptimizerContext) {}

  directReturnExpression(node: FunctionNode): ts.Expression | undefined {
    if (!node.body) return undefined;
    if (!ts.isBlock(node.body)) return node.body;
    if (node.body.statements.length !== 1) return undefined;
    const statement = node.body.statements[0];
    return statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
  }

  canForwardParameters(node: FunctionNode): boolean {
    const directReturn = this.directReturnExpression(node);
    return Boolean(directReturn && this.isPureExpression(directReturn, new Set([node])));
  }

  canForwardReturn(node: FunctionNode, call: ts.CallExpression): boolean {
    const directReturn = this.directReturnExpression(node);
    if (!directReturn) return false;
    if (this.isSnapshotExpression(directReturn, new Set([node]))) return true;
    if (!ts.isIdentifier(directReturn)) return false;
    const parameterIndex = node.parameters.findIndex((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === directReturn.text);
    return parameterIndex >= 0 && this.isSnapshotExpression(call.arguments[parameterIndex]!, new Set());
  }

  parameterRequiresStorage(node: FunctionNode, parameterName: string): boolean {
    if (!node.body) return false;
    let required = false;
    const isParameter = (expression: ts.Expression): boolean =>
      ts.isIdentifier(expression) && expression.text === parameterName;
    const visit = (current: ts.Node): void => {
      if (required) return;
      if (current !== node.body && (ts.isFunctionLike(current) || ts.isClassLike(current))) return;
      if (ts.isBinaryExpression(current) &&
        current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        current.operatorToken.kind <= ts.SyntaxKind.LastAssignment && isParameter(current.left)) {
        required = true;
        return;
      }
      if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
        (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken) &&
        isParameter(current.operand)) {
        required = true;
        return;
      }
      if (ts.isCallExpression(current)) {
        const argumentIndex = current.arguments.findIndex(isParameter);
        if (argumentIndex >= 0) {
          if (ts.isIdentifier(current.expression) && current.expression.text === "extern") {
            required = true;
            return;
          }
          if (ts.isPropertyAccessExpression(current.expression)) {
            const member = current.expression.name.text;
            if (this.context.externs.some((definition) =>
              (definition.member === member || definition.aliases?.includes(member)) &&
              (definition.parameters[argumentIndex]?.mode === "ref" ||
                definition.parameters[argumentIndex]?.mode === "out"))) {
              required = true;
              return;
            }
          }
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node.body);
    return required;
  }

  /** True when evaluating an expression cannot mutate a heap value visible to its caller. */
  private isPureExpression(node: ts.Expression, seen: Set<FunctionNode>): boolean {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return this.isPureExpression(node.expression, seen);
    }
    if (ts.isLiteralExpression(node) || ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword ||
      node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) &&
        this.isPureExpression(element, seen));
    }
    if (ts.isElementAccessExpression(node)) {
      return this.isPureExpression(node.expression, seen) &&
        Boolean(node.argumentExpression && this.isPureExpression(node.argumentExpression, seen));
    }
    if (ts.isPropertyAccessExpression(node)) return this.isPureExpression(node.expression, seen);
    if (ts.isConditionalExpression(node)) {
      return this.isPureExpression(node.condition, seen) && this.isPureExpression(node.whenTrue, seen) &&
        this.isPureExpression(node.whenFalse, seen);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      return node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken &&
        this.isPureExpression(node.operand, seen);
    }
    if (ts.isPostfixUnaryExpression(node)) return false;
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
      return this.isPureExpression(node.left, seen) && this.isPureExpression(node.right, seen);
    }
    if (!ts.isCallExpression(node)) return false;
    if (this.context.isComptimeCall(node)) return true;
    if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Math" || node.expression.expression.text === "Mathf") &&
      ["sin", "cos", "clamp", "abs", "min", "max"].includes(node.expression.name.text.toLowerCase())) {
      return node.arguments.every((argument) => this.isPureExpression(argument, seen));
    }
    const called = this.context.resolveFunction(node);
    if (!called || seen.has(called.node)) return false;
    const body = this.directReturnExpression(called.node);
    if (!body) return false;
    const nested = new Set(seen);
    nested.add(called.node);
    return node.arguments.every((argument) => this.isPureExpression(argument, seen)) &&
      this.isPureExpression(body, nested);
  }

  /** True when the expression result is held by a fresh, immutable temporary heap slot. */
  private isSnapshotExpression(node: ts.Expression, seen: Set<FunctionNode>): boolean {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return this.isSnapshotExpression(node.expression, seen);
    }
    if (ts.isLiteralExpression(node) || node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) || ts.isNewExpression(node) || ts.isElementAccessExpression(node) ||
      ts.isPropertyAccessExpression(node) || ts.isConditionalExpression(node)) return true;
    if (ts.isPrefixUnaryExpression(node)) {
      return node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      return operator < ts.SyntaxKind.FirstAssignment || operator > ts.SyntaxKind.LastAssignment;
    }
    if (!ts.isCallExpression(node)) return false;
    if (this.context.isComptimeCall(node)) return true;
    const called = this.context.resolveFunction(node);
    if (!called) return true; // Extern and behaviour calls use a fresh output heap slot.
    if (seen.has(called.node)) return false;
    const body = this.directReturnExpression(called.node);
    if (!body) return false;
    const nested = new Set(seen);
    nested.add(called.node);
    return this.isSnapshotExpression(body, nested);
  }
}
