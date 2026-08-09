import type { SyncMode, ValueRef } from "./compiler-context.js";
import type { OptimizationStats, UdonType } from "../model.js";
import { defaultValue, escapeString } from "../type-system.js";
import { optimizeIr, type IrHeapValue, type IrNode, unoptimizedStats } from "./udon-ir.js";

interface HeapValue extends ValueRef, IrHeapValue {}

export interface AllocationOptions {
  exported?: boolean;
  sync?: SyncMode;
  exact?: boolean;
}

export function sanitizeSymbol(name: string): string {
  const value = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(value) ? value : `_${value}`;
}

/** Owns Udon heap symbols and code emission, independent of TypeScript AST lowering. */
export class AssemblyBuilder {
  private readonly heap: HeapValue[] = [];
  private readonly usedSymbols = new Set<string>();
  private readonly code: IrNode[] = [];
  private serial = 0;
  private statsValue?: OptimizationStats;

  constructor(private readonly optimize = true) {}

  allocate(base: string, type: UdonType, initial = defaultValue(type), options: AllocationOptions = {}): ValueRef {
    let symbol = sanitizeSymbol(base);
    if (!options.exact || this.usedSymbols.has(symbol)) {
      const root = symbol;
      do { symbol = `${root}_${this.serial++}`; } while (this.usedSymbols.has(symbol));
    }
    if (this.usedSymbols.has(symbol)) {
      const existing = this.heap.find((value) => value.symbol === symbol);
      if (existing?.type === type) return { symbol, type };
      throw new Error(`heap symbol collision: ${symbol}`);
    }
    this.usedSymbols.add(symbol);
    this.heap.push({
      symbol,
      type,
      initial,
      exported: options.exported ?? false,
      stableSymbol: options.exact ?? false,
      ...(options.sync ? { sync: options.sync } : {})
    });
    return { symbol, type };
  }

  emitExtern(signature: string, args: readonly ValueRef[], output?: ValueRef, mutates: readonly ValueRef[] = []): void {
    this.code.push({
      kind: "extern",
      signature,
      args: args.map((arg) => arg.symbol),
      ...(output ? { output: output.symbol } : {}),
      mutates: mutates.map((value) => value.symbol)
    });
  }

  copy(source: ValueRef, target: ValueRef): void {
    this.code.push({ kind: "copy", source: source.symbol, target: target.symbol });
  }

  jumpIfFalse(condition: ValueRef, target: string): void {
    this.code.push({ kind: "jumpIfFalse", condition: condition.symbol, target });
  }

  label(label: string): void {
    if (this.code.at(-1)?.kind === "label") this.code.push({ kind: "nop" });
    this.code.push({ kind: "label", name: label });
  }

  emit(line: string): void {
    if (line.startsWith(".export ")) this.code.push({ kind: "directive", text: line });
    else if (line.startsWith("#")) this.code.push({ kind: "comment", text: line });
    else if (line === "NOP") this.code.push({ kind: "nop" });
    else if (line.startsWith("JUMP_IF_FALSE, ")) {
      throw new Error("use jumpIfFalse(condition, target) for structured IR emission");
    } else if (line.startsWith("JUMP, ")) this.code.push({ kind: "jump", target: line.slice("JUMP, ".length) });
    else this.code.push({ kind: "raw", text: line, symbols: [] });
  }

  uniqueLabel(base: string): string {
    return `__${sanitizeSymbol(base)}_${this.serial++}`;
  }

  render(): string {
    const optimized = this.optimize ? optimizeIr(this.heap, this.code) : {
      heap: [...this.heap],
      nodes: [...this.code],
      stats: unoptimizedStats(this.heap, this.code)
    };
    this.statsValue = optimized.stats;
    const lines = [".data_start"];
    for (const value of optimized.heap) {
      if (value.exported) lines.push(`    .export ${value.symbol}`);
      if (value.sync) lines.push(`    .sync ${value.symbol}, ${value.sync}`);
      lines.push(`    ${value.symbol}: %${value.type}, ${value.initial}`);
    }
    lines.push(".data_end", "", ".code_start");
    for (const node of optimized.nodes) lines.push(...this.renderNode(node));
    lines.push(".code_end", "");
    return lines.join("\n");
  }

  stats(): OptimizationStats | undefined {
    return this.statsValue;
  }

  private renderNode(node: IrNode): string[] {
    if (node.kind === "directive" || node.kind === "comment") return [node.text];
    if (node.kind === "label") return [`${node.name}:`];
    if (node.kind === "copy") return [
      `    PUSH, ${node.source}`,
      `    PUSH, ${node.target}`,
      "    COPY"
    ];
    if (node.kind === "extern") return [
      ...node.args.map((symbol) => `    PUSH, ${symbol}`),
      ...(node.output ? [`    PUSH, ${node.output}`] : []),
      `    EXTERN, ${escapeString(node.signature)}`
    ];
    if (node.kind === "jump") return [`    JUMP, ${node.target}`];
    if (node.kind === "jumpIfFalse") return [
      `    PUSH, ${node.condition}`,
      `    JUMP_IF_FALSE, ${node.target}`
    ];
    if (node.kind === "nop") return ["    NOP"];
    return [`    ${node.text}`];
  }
}
