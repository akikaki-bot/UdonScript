#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { compileProject, defaultAssemblyPath } from "./project-compiler.js";
import { generateDeclarations } from "./declarations.js";
import { ExternRegistry } from "./extern-registry.js";
import { importNodeDump } from "./node-importer.js";
import type { Diagnostic, ExternDefinition, UdonNodeDump } from "./model.js";

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
  -o, --out <file>       Entry output path (imported modules stay beside their .ts files)
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

const useColor = Boolean(process.stderr.isTTY) && !("NO_COLOR" in process.env);

function color(text: string, code: number): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function displayPath(file: string): string {
  const path = relative(process.cwd(), file) || file;
  return path.replaceAll("\\", "/");
}

async function reportDiagnostic(diagnostic: Diagnostic): Promise<void> {
  const location = `${displayPath(diagnostic.file)}:${diagnostic.line}:${diagnostic.column}`;
  const warning = diagnostic.message.startsWith("Warning:");
  const message = warning ? color(diagnostic.message, 33) : diagnostic.message;
  console.error(`\n${color("UdonScript CompileError", 31)}`);
  console.error(`  ${color("at", 90)} ${color(location, 36)}`);
  try {
    const source = await readFile(diagnostic.file, "utf8");
    const sourceLine = source.split(/\r?\n/u)[diagnostic.line - 1];
    if (sourceLine !== undefined) {
      const lineNumber = String(diagnostic.line);
      const gutter = " ".repeat(lineNumber.length);
      const visibleLine = sourceLine.replaceAll("\t", "    ");
      const pointerIndent = sourceLine.slice(0, Math.max(0, diagnostic.column - 1))
        .replace(/[^\t]/gu, " ")
        .replaceAll("\t", "    ");
      console.error(`  ${color(lineNumber, 90)} ${color("|", 90)} ${visibleLine}`);
      console.error(`  ${gutter} ${color("|", 90)} ${pointerIndent}${color("^", 31)} ${message}`);
      return;
    }
  } catch {
    // A location and message are still useful if the source disappeared after compilation.
  }
  console.error(`  ${color("^", 31)} ${message}`);
}

async function reportDiagnostics(diagnostics: readonly Diagnostic[]): Promise<void> {
  for (const diagnostic of diagnostics) await reportDiagnostic(diagnostic);
  const count = diagnostics.length;
  console.error(`\n${color(`Compilation failed with ${count} error${count === 1 ? "" : "s"}.`, 31)}`);
}

async function main(): Promise<void> {
  let args: Arguments;
  try { args = parseArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(`\n${color("UdonScript CLI Error", 31)}`);
    console.error(`  ${error instanceof Error ? error.message : error}`);
    console.error(`\n${usage()}`);
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
  const result = compileProject(input, { fileName: input, externs, sourceMapComments: args.sourceMapComments });
  if (result.diagnostics.length > 0) {
    await reportDiagnostics(result.diagnostics);
    process.exitCode = 1;
    return;
  }
  for (const artifact of result.artifacts) {
    const output = artifact.sourceFile === input && args.output
      ? resolve(args.output)
      : defaultAssemblyPath(artifact.sourceFile);
    await writeFile(output, artifact.assembly, "utf8");
    console.log(`Generated ${output}`);
  }
}

// This module is the package's dedicated bin entry point. Running it
// unconditionally also works through Windows npm junctions, whose argv path
// differs from import.meta.url even though they point at the same file.
void main().catch((error: unknown) => {
  console.error(`\n${color("UdonScript Error", 31)}`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
