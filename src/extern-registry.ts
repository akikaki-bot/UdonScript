import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExternDefinition, UdonType } from "./model.js";

const staticOwners: Readonly<Record<string, UdonType>> = {
  Debug: "UnityEngineDebug",
  Time: "UnityEngineTime",
  Mathf: "UnityEngineMathf",
  Networking: "VRCSDKBaseNetworking"
};

export function staticSourceName(owner: UdonType): string | undefined {
  return Object.entries(staticOwners).find(([, type]) => type === owner)?.[0];
}

export class ExternRegistry {
  readonly definitions: readonly ExternDefinition[];

  constructor(additional: readonly ExternDefinition[] = []) {
    const packageUrl = new URL("../builtins/externs.json", import.meta.url);
    const location = existsSync(packageUrl) ? packageUrl : resolve("builtins/externs.json");
    const builtins = JSON.parse(readFileSync(location, "utf8")) as ExternDefinition[];
    this.definitions = [...builtins, ...additional];
  }

  staticOwner(name: string): UdonType | undefined {
    return staticOwners[name];
  }

  find(owner: UdonType, member: string, kind: "method" | "get" | "set" = "method"): ExternDefinition | undefined {
    return this.findAll(owner, member, kind)[0];
  }

  findAll(owner: UdonType, member: string, kind: "method" | "get" | "set" = "method"): ExternDefinition[] {
    return this.definitions.filter((definition) =>
      definition.owner === owner &&
      (definition.kind ?? "method") === kind &&
      (definition.member === member || definition.aliases?.includes(member))
    );
  }
}

const operatorNames: Readonly<Record<string, string>> = {
  "+": "Addition",
  "-": "Subtraction",
  "*": "Multiplication",
  "/": "Division",
  "%": "Modulus",
  "==": "Equality",
  "===": "Equality",
  "!=": "Inequality",
  "!==": "Inequality",
  "<": "LessThan",
  "<=": "LessThanOrEqual",
  ">": "GreaterThan",
  ">=": "GreaterThanOrEqual",
  "&": "BitwiseAnd",
  "|": "BitwiseOr",
  "^": "ExclusiveOr",
  "<<": "LeftShift",
  ">>": "RightShift"
};

export function binaryExtern(operator: string, left: UdonType, right: UdonType): { signature: string; returns: UdonType } | undefined {
  if (operator === "+" && left === "SystemString" && right === "SystemString") {
    return {
      signature: "SystemString.__Concat__SystemString_SystemString__SystemString",
      returns: "SystemString"
    };
  }
  const name = operatorNames[operator];
  if (!name) return undefined;
  const comparison = ["==", "===", "!=", "!==", "<", "<=", ">", ">="].includes(operator);
  return {
    signature: `${left}.__op_${name}__${left}_${right}__${comparison ? "SystemBoolean" : left}`,
    returns: comparison ? "SystemBoolean" : left
  };
}

export function unaryExtern(operator: string, operand: UdonType): { signature: string; returns: UdonType } | undefined {
  if (operator === "-") return {
    signature: `${operand}.__op_UnaryNegation__${operand}__${operand}`,
    returns: operand
  };
  if (operator === "!") return {
    signature: "SystemBoolean.__op_UnaryNegation__SystemBoolean__SystemBoolean",
    returns: "SystemBoolean"
  };
  if (operator === "~") return {
    signature: `${operand}.__op_OnesComplement__${operand}__${operand}`,
    returns: operand
  };
  return undefined;
}
