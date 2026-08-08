#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { compile } from "./compiler/index.js";
import { generateDeclarations } from "./declarations.js";
import { ExternRegistry } from "./extern-registry.js";
import { importNodeDump } from "./node-importer.js";
import type { ExternDefinition, UdonNodeDump } from "./model.js";

interface Arguments {
  input?: string;
  output?: string;
  emitTypes?: string;
  importNodes?: string;
  registryOut?: string;
  externFiles: string[];
  sourceMapComments: boolean;
  help: boolean;
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a file path`);
  return value;
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { externFiles: [], sourceMapComments: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg === "-o" || arg === "--out") result.output = requiredValue(argv, ++index, arg);
    else if (arg === "--externs") result.externFiles.push(requiredValue(argv, ++index, arg));
    else if (arg === "--emit-types") result.emitTypes = requiredValue(argv, ++index, arg);
    else if (arg === "--import-nodes") result.importNodes = requiredValue(argv, ++index, arg);
    else if (arg === "--registry-out") result.registryOut = requiredValue(argv, ++index, arg);
    else if (arg === "--source-comments") result.sourceMapComments = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (!result.input) result.input = arg;
    else throw new Error(`Only one input file can be compiled: ${arg}`);
  }
  return result;
}

function usage(): string {
  return `udon-ts - TypeScript to Udon Assembly transpiler

Usage:
  udon-ts <input.ts> [-o output.uasm] [--externs registry.json]
  udon-ts --emit-types generated.d.ts [--externs registry.json]
  udon-ts --import-nodes udon-nodes.json --registry-out externs.json

Options:
  -o, --out <file>       Output path (default: input-name.uasm)
  --externs <file>       Additional extern registry (node dumps are auto-detected)
  --emit-types <file>    Generate completion declarations from the registry
  --import-nodes <file>  Import a Unity Udon Graph node dump
  --registry-out <file>  Write imported extern metadata as JSON
  --source-comments      Include source line comments in the assembly
  -h, --help             Show this help
`;
}

function definitionsFromJson(value: unknown, file: string): ExternDefinition[] {
  if (Array.isArray(value)) return value as ExternDefinition[];
  if (value && typeof value === "object" && "nodes" in value && Array.isArray((value as { nodes?: unknown }).nodes)) {
    return importNodeDump(value as UdonNodeDump);
  }
  throw new Error(
    `${file}: expected an extern definition array or a Unity node dump shaped like { "nodes": [...] }`
  );
}

async function main(): Promise<void> {
  let args: Arguments;
  try { args = parseArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help || (!args.input && !args.emitTypes && !args.importNodes)) {
    console.log(usage());
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const externs: ExternDefinition[] = [];
  for (const file of args.externFiles) {
    const location = resolve(file);
    const value: unknown = JSON.parse(await readFile(location, "utf8"));
    externs.push(...definitionsFromJson(value, location));
  }
  if (args.importNodes) {
    const location = resolve(args.importNodes);
    const dump: unknown = JSON.parse(await readFile(location, "utf8"));
    if ((!Array.isArray(dump) && !(dump && typeof dump === "object" && "nodes" in dump))) {
      throw new Error(`${location}: expected a Unity node dump shaped like { "nodes": [...] }`);
    }
    const imported = importNodeDump(dump as UdonNodeDump);
    externs.push(...imported);
    if (args.registryOut) {
      const output = resolve(args.registryOut);
      await writeFile(output, `${JSON.stringify(imported, null, 2)}\n`, "utf8");
      console.log(`Generated ${output}`);
    }
  }
  if (args.emitTypes) {
    const output = resolve(args.emitTypes);
    const registry = new ExternRegistry(externs);
    await writeFile(output, generateDeclarations(registry.definitions), "utf8");
    console.log(`Generated ${output}`);
  }
  if (!args.input) return;

  const input = resolve(args.input);
  const source = await readFile(input, "utf8");
  const result = compile(source, { fileName: input, externs, sourceMapComments: args.sourceMapComments });
  if (result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) {
      console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const extension = extname(input);
  const output = resolve(args.output ?? join(dirname(input), `${basename(input, extension)}.uasm`));
  await writeFile(output, result.assembly, "utf8");
  console.log(`Generated ${output}`);
}

// This module is the package's dedicated bin entry point. Running it
// unconditionally also works through Windows npm junctions, whose argv path
// differs from import.meta.url even though they point at the same file.
void main().catch((error: unknown) => {
  console.error(`udon-ts: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
