import type { UdonType } from "./model.js";

const aliases: Readonly<Record<string, UdonType>> = {
  void: "SystemVoid",
  boolean: "SystemBoolean",
  bool: "SystemBoolean",
  string: "SystemString",
  int: "SystemInt32",
  uint: "SystemUInt32",
  float: "SystemSingle",
  double: "SystemDouble",
  object: "SystemObject",
  unknown: "SystemObject",
  any: "SystemObject",
  GameObject: "UnityEngineGameObject",
  Transform: "UnityEngineTransform",
  Vector2: "UnityEngineVector2",
  Vector3: "UnityEngineVector3",
  Quaternion: "UnityEngineQuaternion",
  Color: "UnityEngineColor",
  VRCPlayerApi: "VRCSDKBaseVRCPlayerApi",
  UdonBehaviour: "VRCUdonUdonBehaviour",
  SerializationResult: "VRCUdonCommonSerializationResult",
  DeserializationResult: "VRCUdonCommonDeserializationResult",
  UdonInputEventArgs: "VRCUdonCommonUdonInputEventArgs",
  VideoError: "VRCSDK3ComponentsVideoVideoError",
  ControllerColliderPlayerHit: "VRCSDK3ControllerColliderPlayerHit",
  IVRCImageDownload: "VRCSDK3ImageIVRCImageDownload",
  IVRCStringDownload: "VRCSDK3StringLoadingIVRCStringDownload",
  VRCAsyncGPUReadbackRequest: "VRCSDK3RenderingVRCAsyncGPUReadbackRequest",
  ScreenUpdateData: "VRCSDK3PlatformScreenUpdateData",
  VRCInputMethod: "VRCSDKBaseVRCInputMethod",
  VRCCameraSettings: "VRCSDK3RenderingVRCCameraSettings",
  PlayerDataInfo: "VRCSDK3PersistencePlayerDataInfo"
};

const reverseAliases = new Map<UdonType, string>();
for (const [source, udon] of Object.entries(aliases)) {
  if (!reverseAliases.has(udon)) reverseAliases.set(udon, source);
}

export function typeFromAnnotation(text: string): UdonType | undefined {
  const normalized = text.replace(/\s/g, "");
  const genericArray = /^Array<(.+)>$/.exec(normalized);
  if (genericArray) {
    const element = typeFromAnnotation(genericArray[1]!);
    return element ? `${element}Array` : undefined;
  }
  if (normalized.endsWith("[]")) {
    const element = typeFromAnnotation(normalized.slice(0, -2));
    return element ? `${element}Array` : undefined;
  }
  return aliases[normalized] ?? (normalized.startsWith("Udon.")
    ? normalized.slice(5).replace(/[.+]/g, "")
    : undefined);
}

export function sourceTypeName(type: UdonType): string {
  if (type.endsWith("Array")) return `${sourceTypeName(type.slice(0, -5))}[]`;
  return reverseAliases.get(type) ?? `Udon.${type}`;
}

export function isNumeric(type: UdonType): boolean {
  return type === "SystemInt32" || type === "SystemUInt32" ||
    type === "SystemSingle" || type === "SystemDouble";
}

export function isArray(type: UdonType): boolean {
  return type.endsWith("Array") && type.length > "Array".length;
}

export function arrayElementType(type: UdonType): UdonType | undefined {
  return isArray(type) ? type.slice(0, -"Array".length) : undefined;
}

export function defaultValue(type: UdonType): string {
  if (type === "SystemInt32") return "0";
  if (type === "SystemUInt32") return "0u";
  if (type === "SystemSingle" || type === "SystemDouble") return "0.0";
  if (type === "SystemString") return "null";
  return "null";
}

export function escapeString(value: string): string {
  return JSON.stringify(value).replace(/\\u2028/g, "\\u2028").replace(/\\u2029/g, "\\u2029");
}
