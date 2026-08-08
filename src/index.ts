export { compile } from "./compiler/index.js";
export { ExternRegistry } from "./extern-registry.js";
export { events } from "./events.js";
export { generateDeclarations } from "./declarations.js";
export { importNodeDump } from "./node-importer.js";
export type {
  CompileOptions,
  CompileResult,
  Diagnostic,
  EventDefinition,
  ExternDefinition,
  ExternParameter,
  ParameterMode,
  UdonNodeDump,
  UdonNodeDumpEntry,
  UdonType
} from "./model.js";
