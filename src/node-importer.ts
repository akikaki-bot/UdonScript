import type { ExternDefinition, ExternParameter, UdonNodeDump, UdonNodeDumpEntry } from "./model.js";

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

function normalizeUdonType(type: string): string {
  const trimmed = type.trim();
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) return trimmed;
  return trimmed.replace(/\[\]$/, "Array").replace(/[.+,`\[\]\s]/g, "");
}

function parseNode(node: UdonNodeDumpEntry): ExternDefinition | undefined {
  // Flow/event/variable nodes do not contain an extern signature.
  const ownerSeparator = node.fullName.indexOf(".__");
  if (ownerSeparator < 1) return undefined;
  const ownerText = node.fullName.slice(0, ownerSeparator);
  const body = node.fullName.slice(ownerSeparator + 3);
  const returnSeparator = body.lastIndexOf("__");
  if (returnSeparator < 1) return undefined;
  const callPart = body.slice(0, returnSeparator);
  const returnText = body.slice(returnSeparator + 2);
  const parameterSeparator = callPart.indexOf("__");
  const rawMember = parameterSeparator < 0 ? callPart : callPart.slice(0, parameterSeparator);
  const rawParameters = parameterSeparator < 0 ? "" : callPart.slice(parameterSeparator + 2);
  if (!ownerText || !rawMember || !returnText) return undefined;
  const owner = normalizeUdonType(ownerText);
  const parameterTypes = rawParameters === "" ? [] : rawParameters.split("_");
  const parameters: ExternParameter[] = parameterTypes.map((rawType) => {
    const byRef = rawType.endsWith("Ref");
    return {
      type: normalizeUdonType(byRef ? rawType.slice(0, -3) : rawType),
      ...(byRef ? { mode: "ref" as const } : {})
    };
  });

  const inputTypes = (node.inputTypes ?? []).map(normalizeUdonType);
  const firstInputName = node.inputNames?.[0]?.toLowerCase();
  const hasInstancePort = firstInputName === "instance" || firstInputName === "this" ||
    (!firstInputName && inputTypes.length > parameters.length);
  const staticCall = !hasInstancePort;
  let kind: ExternDefinition["kind"] = "method";
  let sourceMember = rawMember;
  if (rawMember.startsWith("get_")) {
    kind = "get";
    sourceMember = rawMember.slice(4);
  } else if (rawMember.startsWith("set_")) {
    kind = "set";
    sourceMember = rawMember.slice(4);
  } else if (rawMember.startsWith("op_")) {
    kind = "operator";
  }
  const member = lowerFirst(sourceMember);
  return {
    owner,
    member,
    signature: node.fullName,
    parameters,
    returns: normalizeUdonType(returnText),
    static: staticCall,
    kind,
    ...(member !== sourceMember ? { aliases: [sourceMember] } : {})
  };
}

/** Converts a node dump produced by the Unity exporter into compiler extern metadata. */
export function importNodeDump(dump: UdonNodeDump | readonly UdonNodeDumpEntry[]): ExternDefinition[] {
  const nodes: readonly UdonNodeDumpEntry[] = Array.isArray(dump)
    ? dump
    : (dump as UdonNodeDump).nodes;
  const definitions: ExternDefinition[] = [];
  const signatures = new Set<string>();
  for (const node of nodes) {
    const definition = parseNode(node);
    if (!definition || signatures.has(definition.signature)) continue;
    signatures.add(definition.signature);
    definitions.push(definition);
  }
  return definitions;
}
