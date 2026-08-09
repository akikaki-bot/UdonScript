export type UdonType = string;

export type ParameterMode = "in" | "ref" | "out";

export interface ExternParameter {
  type: UdonType;
  mode?: ParameterMode;
}

export interface ExternDefinition {
  owner: UdonType;
  member: string;
  signature: string;
  parameters: ExternParameter[];
  returns: UdonType;
  static: boolean;
  kind?: "method" | "get" | "set" | "operator";
  aliases?: string[];
}

export interface EventParameter {
  name: string;
  symbol: string;
  type: UdonType;
}

export interface EventDefinition {
  sourceName: string;
  assemblyName: string;
  parameters: EventParameter[];
  returns?: UdonType;
  returnSymbol?: string;
  description?: string;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface CompileOptions {
  fileName?: string;
  externs?: ExternDefinition[];
  sourceMapComments?: boolean;
  optimize?: boolean;
}

export interface OptimizationStats {
  heapSlotsBefore: number;
  heapSlotsAfter: number;
  instructionsBefore: number;
  instructionsAfter: number;
  copiesBefore: number;
  copiesAfter: number;
  externCallsBefore: number;
  externCallsAfter: number;
  constantsFolded: number;
}

export interface CompileResult {
  assembly: string;
  diagnostics: Diagnostic[];
  stats?: OptimizationStats;
}

export interface CompileArtifact {
  sourceFile: string;
  assembly: string;
  stats?: OptimizationStats;
}

export interface ProjectCompileResult {
  artifacts: CompileArtifact[];
  diagnostics: Diagnostic[];
}

/** Raw node metadata exported from a VRChat SDK Unity project. */
export interface UdonNodeDumpEntry {
  fullName: string;
  name?: string;
  inputNames?: string[];
  inputTypes?: string[];
  outputNames?: string[];
  outputTypes?: string[];
}

export interface UdonNodeDump {
  sdkVersion?: string;
  nodes: UdonNodeDumpEntry[];
}
