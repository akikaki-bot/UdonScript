import type ts from "typescript";
import type { UdonType } from "../model.js";

export interface ValueRef {
  symbol: string;
  type: UdonType;
  /** Compile-time identity for a referenced UdonScript behaviour. */
  behaviorType?: string;
}

export type FunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
export type GlobalDeclaration = ts.VariableDeclaration | ts.PropertyDeclaration;
export type SyncMode = "none" | "linear" | "smooth";

export interface FunctionInfo {
  node: FunctionNode;
  name: string;
  returnType: UdonType;
  entry: boolean;
  entryKind?: "event" | "method";
  comptime?: boolean;
}

export interface FlowContext {
  breakLabel?: string;
  continueLabel?: string;
  returnLabel: string;
  returnValue?: ValueRef;
}

export class Scope {
  private readonly values = new Map<string, ValueRef>();

  constructor(readonly parent?: Scope) {}

  set(name: string, value: ValueRef): void {
    this.values.set(name, value);
  }

  get(name: string): ValueRef | undefined {
    return this.values.get(name) ?? this.parent?.get(name);
  }
}
