import type { SyncMode, ValueRef } from "./compiler-context.js";
import type { UdonType } from "./model.js";
import { defaultValue, escapeString } from "./type-system.js";

interface HeapValue extends ValueRef {
  initial: string;
  exported: boolean;
  sync?: SyncMode;
}

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
  private readonly code: string[] = [];
  private serial = 0;

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
      ...(options.sync ? { sync: options.sync } : {})
    });
    return { symbol, type };
  }

  emitExtern(signature: string, args: readonly ValueRef[], output?: ValueRef): void {
    for (const arg of args) this.emit(`PUSH, ${arg.symbol}`);
    if (output) this.emit(`PUSH, ${output.symbol}`);
    this.emit(`EXTERN, ${escapeString(signature)}`);
  }

  label(label: string): void {
    if (this.code.at(-1)?.endsWith(":")) this.emit("NOP");
    this.code.push(`${label}:`);
  }

  emit(line: string): void {
    this.code.push(line);
  }

  uniqueLabel(base: string): string {
    return `__${sanitizeSymbol(base)}_${this.serial++}`;
  }

  render(): string {
    const lines = [".data_start"];
    for (const value of this.heap) {
      if (value.exported) lines.push(`    .export ${value.symbol}`);
      if (value.sync) lines.push(`    .sync ${value.symbol}, ${value.sync}`);
      lines.push(`    ${value.symbol}: %${value.type}, ${value.initial}`);
    }
    lines.push(".data_end", "", ".code_start");
    lines.push(...this.code.map((line) => line.endsWith(":") || line.startsWith(".") || line.startsWith("#") ? line : `    ${line}`));
    lines.push(".code_end", "");
    return lines.join("\n");
  }
}
