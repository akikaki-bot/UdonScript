import ts from "typescript";
import type { SyncMode } from "./compiler-context.js";

export interface UdonVariableMarker {
  initializer?: ts.Expression;
  type?: ts.TypeNode;
  sync?: SyncMode;
}

type Failure = (message: string, node: ts.Node) => never;

const syncModes = new Set<SyncMode>(["none", "linear", "smooth"]);

export class UdonVariableParser {
  constructor(private readonly fail: Failure) {}

  topLevel(declaration: ts.VariableDeclaration): UdonVariableMarker | undefined {
    const call = declaration.initializer;
    if (!call || !this.isMarkerCall(call)) return undefined;
    if (call.typeArguments && call.typeArguments.length > 1) {
      this.fail("udonVariableの型引数は1つだけ指定できます", call.typeArguments[1]!);
    }
    if (call.arguments.length > 2) {
      this.fail("udonVariableの引数は初期値とオプションの2つまでです", call.arguments[2]!);
    }
    return {
      ...(call.arguments[0] ? { initializer: call.arguments[0] } : {}),
      ...(call.typeArguments?.[0] ? { type: call.typeArguments[0] } : {}),
      ...(call.arguments[1] ? this.options(call.arguments[1]) : {})
    };
  }

  classField(declaration: ts.PropertyDeclaration): UdonVariableMarker | undefined {
    if (declaration.initializer && this.isMarkerCall(declaration.initializer)) {
      this.fail("UdonBehaviourのフィールドでは@udonVariableを使用してください", declaration.initializer);
    }
    const decorators = ts.canHaveDecorators(declaration) ? ts.getDecorators(declaration) ?? [] : [];
    const markers = decorators.filter((decorator) => this.isMarkerDecorator(decorator.expression));
    if (markers.length === 0) return undefined;
    if (markers.length > 1) this.fail("@udonVariableは同じフィールドへ複数指定できません", markers[1]!);

    const expression = markers[0]!.expression;
    if (ts.isIdentifier(expression)) return {};
    if (!ts.isCallExpression(expression)) return undefined;
    if (expression.typeArguments?.length) {
      this.fail("@udonVariableには型引数を指定できません", expression.typeArguments[0]!);
    }
    if (expression.arguments.length > 1) {
      this.fail("@udonVariableの引数はオプション1つまでです", expression.arguments[1]!);
    }
    return expression.arguments[0] ? this.options(expression.arguments[0]) : {};
  }

  private isMarkerCall(node: ts.Expression): node is ts.CallExpression {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "udonVariable";
  }

  private isMarkerDecorator(node: ts.LeftHandSideExpression): node is ts.Identifier | ts.CallExpression {
    return (ts.isIdentifier(node) && node.text === "udonVariable") || this.isMarkerCall(node);
  }

  private options(node: ts.Expression): Pick<UdonVariableMarker, "sync"> {
    if (!ts.isObjectLiteralExpression(node)) {
      this.fail("udonVariableのオプションはオブジェクトリテラルで指定してください", node);
    }
    let sync: SyncMode | undefined;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !this.propertyName(property.name)) {
        this.fail("udonVariableのオプションには通常のプロパティだけを指定できます", property);
      }
      const name = this.propertyName(property.name)!;
      if (name !== "sync") this.fail(`udonVariableに不明なオプション '${name}' があります`, property.name);
      if (!ts.isStringLiteralLike(property.initializer) || !syncModes.has(property.initializer.text as SyncMode)) {
        this.fail("syncには 'none'、'linear'、'smooth' のいずれかを指定してください", property.initializer);
      }
      sync = property.initializer.text as SyncMode;
    }
    return sync ? { sync } : {};
  }

  private propertyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    return undefined;
  }
}
