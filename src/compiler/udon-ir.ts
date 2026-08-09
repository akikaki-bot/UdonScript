import type { SyncMode } from "./compiler-context.js";
import type { OptimizationStats, UdonType } from "../model.js";

export interface IrHeapValue {
  symbol: string;
  type: UdonType;
  initial: string;
  exported: boolean;
  stableSymbol: boolean;
  sync?: SyncMode;
}

export type IrNode =
  | { kind: "directive"; text: string }
  | { kind: "comment"; text: string }
  | { kind: "label"; name: string }
  | { kind: "copy"; source: string; target: string }
  | { kind: "extern"; signature: string; args: string[]; output?: string; mutates: string[] }
  | { kind: "jump"; target: string }
  | { kind: "jumpIfFalse"; condition: string; target: string }
  | { kind: "nop" }
  | { kind: "raw"; text: string; symbols: string[] };

function instructionCount(nodes: readonly IrNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === "copy") count += 3;
    else if (node.kind === "extern") count += node.args.length + (node.output ? 1 : 0) + 1;
    else if (node.kind === "jumpIfFalse") count += 2;
    else if (node.kind === "jump" || node.kind === "nop" || node.kind === "raw") count += 1;
  }
  return count;
}

function copyCount(nodes: readonly IrNode[]): number {
  return nodes.filter((node) => node.kind === "copy").length;
}

function externCount(nodes: readonly IrNode[]): number {
  return nodes.filter((node) => node.kind === "extern").length;
}

function reads(node: IrNode): string[] {
  if (node.kind === "copy") return [node.source];
  if (node.kind === "extern") return node.args;
  if (node.kind === "jumpIfFalse") return [node.condition];
  if (node.kind === "raw") return node.symbols;
  return [];
}

function writes(node: IrNode): string[] {
  if (node.kind === "copy") return [node.target];
  if (node.kind === "extern") return [...(node.output ? [node.output] : []), ...node.mutates];
  return [];
}

function writeCounts(nodes: readonly IrNode[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const node of nodes) {
    for (const symbol of writes(node)) result.set(symbol, (result.get(symbol) ?? 0) + 1);
  }
  return result;
}

function replaceSymbol(node: IrNode, replacements: ReadonlyMap<string, string>): IrNode {
  const get = (symbol: string): string => replacements.get(symbol) ?? symbol;
  if (node.kind === "copy") return { ...node, source: get(node.source), target: get(node.target) };
  if (node.kind === "extern") return {
    ...node,
    args: node.args.map(get),
    ...(node.output ? { output: get(node.output) } : {}),
    mutates: node.mutates.map(get)
  };
  if (node.kind === "jumpIfFalse") return { ...node, condition: get(node.condition) };
  if (node.kind === "raw") return { ...node, symbols: node.symbols.map(get) };
  return node;
}

type Constant = bigint | number | string;

function parseConstant(value: IrHeapValue): Constant | undefined {
  const text = value.initial;
  try {
    if (value.type === "SystemInt32") return BigInt(text);
    if (value.type === "SystemUInt32") return BigInt(text.endsWith("u") ? text.slice(0, -1) : text);
    if (value.type === "SystemSingle" || value.type === "SystemDouble") return Number(text);
    if (value.type === "SystemString" && text !== "null") return JSON.parse(text) as string;
  } catch {
    return undefined;
  }
  return undefined;
}

function encodeConstant(type: UdonType, value: Constant): string | undefined {
  if (type === "SystemInt32" && typeof value === "bigint") return BigInt.asIntN(32, value).toString();
  if (type === "SystemUInt32" && typeof value === "bigint") return `${BigInt.asUintN(32, value)}u`;
  if (type === "SystemSingle" && typeof value === "number" && Number.isFinite(value)) return String(Math.fround(value));
  if (type === "SystemDouble" && typeof value === "number" && Number.isFinite(value)) return String(value);
  if (type === "SystemString" && typeof value === "string") return JSON.stringify(value);
  return undefined;
}

function foldInteger(name: string, left: bigint, right?: bigint): bigint | undefined {
  if (name === "UnaryNegation") return -left;
  if (right === undefined) return undefined;
  if (name === "Addition") return left + right;
  if (name === "Subtraction") return left - right;
  if (name === "Multiplication") return left * right;
  if (name === "Division") return right === 0n ? undefined : left / right;
  if (name === "Modulus") return right === 0n ? undefined : left % right;
  if (name === "BitwiseAnd") return left & right;
  if (name === "BitwiseOr") return left | right;
  if (name === "ExclusiveOr") return left ^ right;
  if (name === "LeftShift") return left << BigInt(Number(right & 31n));
  if (name === "RightShift") return left >> BigInt(Number(right & 31n));
  return undefined;
}

function foldNumber(name: string, left: number, right?: number): number | undefined {
  if (name === "UnaryNegation") return -left;
  if (right === undefined) return undefined;
  if (name === "Addition") return left + right;
  if (name === "Subtraction") return left - right;
  if (name === "Multiplication") return left * right;
  if (name === "Division") return right === 0 ? undefined : left / right;
  if (name === "Modulus") return right === 0 ? undefined : left % right;
  return undefined;
}

function foldExtern(node: Extract<IrNode, { kind: "extern" }>, heap: ReadonlyMap<string, IrHeapValue>): string | undefined {
  if (!node.output || node.mutates.length > 0) return undefined;
  const output = heap.get(node.output);
  const args = node.args.map((symbol) => heap.get(symbol)).filter((value): value is IrHeapValue => Boolean(value));
  if (!output || args.length !== node.args.length) return undefined;
  const values = args.map(parseConstant);
  if (values.some((value) => value === undefined)) return undefined;

  if (node.signature.startsWith("SystemString.__Concat__") && values.every((value) => typeof value === "string")) {
    return encodeConstant(output.type, values.join(""));
  }
  const operator = /\.__op_([A-Za-z0-9]+)__/.exec(node.signature)?.[1];
  if (operator) {
    const left = values[0];
    const right = values[1];
    const folded = typeof left === "bigint"
      ? foldInteger(operator, left, typeof right === "bigint" ? right : undefined)
      : typeof left === "number"
        ? foldNumber(operator, left, typeof right === "number" ? right : undefined)
        : undefined;
    return folded === undefined ? undefined : encodeConstant(output.type, folded);
  }
  if (node.signature.startsWith("UnityEngineMathf.__") && values.every((value) => typeof value === "number")) {
    const numbers = values as number[];
    let folded: number | undefined;
    if (node.signature.includes(".__Sin__")) folded = Math.sin(numbers[0]!);
    else if (node.signature.includes(".__Cos__")) folded = Math.cos(numbers[0]!);
    else if (node.signature.includes(".__Clamp__")) folded = Math.min(Math.max(numbers[0]!, numbers[1]!), numbers[2]!);
    return folded === undefined ? undefined : encodeConstant(output.type, folded);
  }
  return undefined;
}

function isCompileTimeConstant(value: IrHeapValue | undefined, counts: ReadonlyMap<string, number>): value is IrHeapValue {
  if (!value) return false;
  return !value.exported && !value.sync && !value.stableSymbol && (counts.get(value.symbol) ?? 0) === 0;
}

function removeDeadOperations(heap: readonly IrHeapValue[], input: readonly IrNode[]): IrNode[] {
  let nodes = [...input];
  for (;;) {
    const used = new Set<string>();
    for (const node of nodes) for (const symbol of reads(node)) used.add(symbol);
    for (const value of heap) if (value.exported || value.sync || value.stableSymbol) used.add(value.symbol);
    const next = nodes.filter((node) => {
      if (node.kind === "copy") return used.has(node.target);
      if (node.kind === "extern" && node.output && isPureExtern(node.signature)) return used.has(node.output);
      return true;
    });
    if (next.length === nodes.length) return next;
    nodes = next;
  }
}

export function isPureExtern(signature: string): boolean {
  return signature.includes(".__op_") || signature.startsWith("SystemString.__Concat__") ||
    signature.startsWith("UnityEngineMathf.__Sin__") || signature.startsWith("UnityEngineMathf.__Cos__") ||
    signature.startsWith("UnityEngineMathf.__Clamp__");
}

export function optimizeIr(heapInput: readonly IrHeapValue[], nodesInput: readonly IrNode[]): {
  heap: IrHeapValue[];
  nodes: IrNode[];
  stats: OptimizationStats;
} {
  let heap = heapInput.map((value) => ({ ...value }));
  let nodes = [...nodesInput];
  const before = {
    heapSlots: heap.length,
    instructions: instructionCount(nodes),
    copies: copyCount(nodes),
    externCalls: externCount(nodes)
  };
  let constantsFolded = 0;

  for (;;) {
    const counts = writeCounts(nodes);
    const heapMap = new Map(heap.map((value) => [value.symbol, value]));
    let changed = false;
    nodes = nodes.filter((node) => {
      if (node.kind === "copy" && node.source === node.target) {
        changed = true;
        return false;
      }
      if (node.kind === "extern" && node.output && counts.get(node.output) === 1 && isPureExtern(node.signature)) {
        // Exact symbols include Inspector fields, event parameters and other ABI-visible
        // heap values. Their data-section initializer is not their runtime value.
        const inputsAreConstant = node.args.every((symbol) => isCompileTimeConstant(heapMap.get(symbol), counts));
        const folded = inputsAreConstant ? foldExtern(node, heapMap) : undefined;
        const output = heapMap.get(node.output);
        if (folded !== undefined && output && !output.exported && !output.sync) {
          output.initial = folded;
          constantsFolded++;
          changed = true;
          return false;
        }
      }
      return true;
    });
    if (!changed) break;
  }

  const counts = writeCounts(nodes);
  const replacements = new Map<string, string>();
  const constants = new Map<string, string>();
  for (const value of heap) {
    if (value.exported || value.sync || value.stableSymbol || (counts.get(value.symbol) ?? 0) > 0) continue;
    const key = `${value.type}:${value.initial}`;
    const existing = constants.get(key);
    if (existing) replacements.set(value.symbol, existing);
    else constants.set(key, value.symbol);
  }
  if (replacements.size > 0) {
    nodes = nodes.map((node) => replaceSymbol(node, replacements));
    heap = heap.filter((value) => !replacements.has(value.symbol));
  }

  nodes = removeDeadOperations(heap, nodes);
  const referenced = new Set<string>();
  for (const node of nodes) {
    for (const symbol of reads(node)) referenced.add(symbol);
    for (const symbol of writes(node)) referenced.add(symbol);
  }
  heap = heap.filter((value) => value.exported || Boolean(value.sync) || value.stableSymbol || referenced.has(value.symbol));

  return {
    heap,
    nodes,
    stats: {
      heapSlotsBefore: before.heapSlots,
      heapSlotsAfter: heap.length,
      instructionsBefore: before.instructions,
      instructionsAfter: instructionCount(nodes),
      copiesBefore: before.copies,
      copiesAfter: copyCount(nodes),
      externCallsBefore: before.externCalls,
      externCallsAfter: externCount(nodes),
      constantsFolded
    }
  };
}

export function unoptimizedStats(heap: readonly IrHeapValue[], nodes: readonly IrNode[]): OptimizationStats {
  return {
    heapSlotsBefore: heap.length,
    heapSlotsAfter: heap.length,
    instructionsBefore: instructionCount(nodes),
    instructionsAfter: instructionCount(nodes),
    copiesBefore: copyCount(nodes),
    copiesAfter: copyCount(nodes),
    externCallsBefore: externCount(nodes),
    externCallsAfter: externCount(nodes),
    constantsFolded: 0
  };
}
