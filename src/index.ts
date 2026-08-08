export { compile } from "./compiler/index.js";
export { compileProject } from "./project-compiler.js";
export { ExternRegistry } from "./extern-registry.js";
export { events } from "./events.js";
export { generateDeclarations } from "./declarations.js";
export { importNodeDump } from "./node-importer.js";
export type {
  CompileOptions,
  CompileResult,
  CompileArtifact,
  Diagnostic,
  EventDefinition,
  ExternDefinition,
  ExternParameter,
  ParameterMode,
  ProjectCompileResult,
  UdonNodeDump,
  UdonNodeDumpEntry,
  UdonType
} from "./model.js";
