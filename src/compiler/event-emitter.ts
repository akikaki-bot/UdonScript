import ts from "typescript";

export type EventHandlerNode = ts.ArrowFunction | ts.FunctionExpression;

export interface EventRegistration {
  name: string;
  handler: EventHandlerNode;
  node: ts.CallExpression;
}

type Failure = (message: string, node: ts.Node) => never;

export const eventEmitterCalls = new Set([
  "on",
  "emit",
  "emitDelayed",
  "emitDelayedFrames",
  "emitNetwork"
]);

/** Parses the top-level event DSL without giving it runtime JavaScript semantics. */
export class EventEmitterParser {
  constructor(private readonly fail: Failure) {}

  registration(statement: ts.Statement): EventRegistration | undefined {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "on") return undefined;
    if (call.typeArguments?.length) this.fail("onには型引数を指定できません", call.typeArguments[0]!);
    if (call.arguments.length !== 2) this.fail("onはイベント名とハンドラーの2引数が必要です", call);
    const name = call.arguments[0]!;
    if (!ts.isStringLiteralLike(name)) this.fail("onのイベント名は文字列リテラルで指定してください", name);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name.text)) {
      this.fail("イベント名には英数字と_を使用し、英字から始めてください", name);
    }
    const handler = call.arguments[1]!;
    if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) {
      this.fail("onのハンドラーはその場で定義した関数またはアロー関数にしてください", handler);
    }
    if (this.hasModifier(handler, ts.SyntaxKind.AsyncKeyword)) this.fail("Udonイベントはasyncにできません", handler);
    if (ts.isFunctionExpression(handler) && handler.asteriskToken) this.fail("Udonイベントはgeneratorにできません", handler);
    return { name: name.text, handler, node: call };
  }

  callName(node: ts.CallExpression): string | undefined {
    return ts.isIdentifier(node.expression) && eventEmitterCalls.has(node.expression.text)
      ? node.expression.text
      : undefined;
  }

  private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
  }
}
