import assert from "node:assert/strict";
import test from "node:test";
import { compile, generateDeclarations, importNodeDump } from "../src/index.js";

function successful(source: string): string {
  const result = compile(source, { fileName: "test.ts" });
  assert.deepEqual(result.diagnostics, []);
  return result.assembly;
}

test("emits exported data, sync metadata, events and externs", () => {
  const assembly = successful(`
    export let message: string = "hello";
    /** @sync linear */
    export let speed: float = 2.5;
    export function start(): void {
      Debug.log(message);
      Networking.localPlayer.setWalkSpeed(speed);
    }
  `);
  assert.match(assembly, /\.export message/);
  assert.match(assembly, /\.sync speed, linear/);
  assert.match(assembly, /\.export _start/);
  assert.match(assembly, /UnityEngineDebug\.__Log__SystemObject__SystemVoid/);
  assert.match(assembly, /VRCSDKBaseVRCPlayerApi\.__SetWalkSpeed__SystemSingle__SystemVoid/);
});

test("lowers control flow and arithmetic operators", () => {
  const assembly = successful(`
    export function update(): void {
      let i: int = 0;
      while (i < 3) {
        i++;
      }
    }
  `);
  assert.match(assembly, /SystemInt32\.__op_LessThan/);
  assert.match(assembly, /SystemInt32\.__op_Addition/);
  assert.match(assembly, /JUMP_IF_FALSE/);
});

test("inlines typed user functions", () => {
  const assembly = successful(`
    function twice(value: float): float { return value * 2; }
    export function start(): void {
      const result: float = twice(1.5);
      Debug.log(result);
    }
  `);
  assert.match(assembly, /twice_value/);
  assert.match(assembly, /SystemSingle\.__op_Multiplication/);
  assert.doesNotMatch(assembly, /\.export twice/);
});

test("maps event parameters to their required heap symbols", () => {
  const assembly = successful(`
    export function onPlayerJoined(player: VRCPlayerApi): void {
      Debug.log(player.displayName);
    }
  `);
  assert.match(assembly, /playerJoinedPlayer: %VRCSDKBaseVRCPlayerApi/);
  assert.match(assembly, /\.export _onPlayerJoined/);
});

test("supports raw extern escape hatch", () => {
  const assembly = successful(`
    export function start(): void {
      let x: float = extern<float>("UnityEngineMathf.__Abs__SystemSingle__SystemSingle", -2.0);
    }
  `);
  assert.match(assembly, /UnityEngineMathf\.__Abs__SystemSingle__SystemSingle/);
});

test("reports type errors with a source location", () => {
  const result = compile(`export function start(): void { let x: int = "oops"; }`, { fileName: "bad.ts" });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0]!.message, /string.*int/);
  assert.equal(result.diagnostics[0]!.file, "bad.ts");
});

test("generates completion declarations from extern metadata", () => {
  const declarations = generateDeclarations([{
    owner: "UnityEngineMathf",
    member: "abs",
    signature: "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    parameters: [{ type: "SystemSingle" }],
    returns: "SystemSingle",
    static: true,
    kind: "method"
  }]);
  assert.match(declarations, /namespace Mathf/);
  assert.match(declarations, /function abs\(arg0: float\): float/);
});

test("imports extern signatures from a Unity node dump", () => {
  const definitions = importNodeDump({ nodes: [{
    fullName: "VRCSDKBaseVRCPlayerApi.__SetWalkSpeed__SystemSingle__SystemVoid",
    inputNames: ["instance", "value"],
    inputTypes: ["VRC.SDKBase.VRCPlayerApi", "System.Single"]
  }, {
    fullName: "UnityEngineTime.__get_deltaTime__SystemSingle",
    inputNames: [],
    inputTypes: []
  }] });
  assert.equal(definitions.length, 2);
  assert.equal(definitions[0]!.static, false);
  assert.equal(definitions[0]!.parameters[0]!.type, "SystemSingle");
  assert.equal(definitions[1]!.kind, "get");
  assert.equal(definitions[1]!.static, true);
});

test("compiles UdonBehaviour classes, fields, this access and methods", () => {
  const assembly = successful(`
    export class Greeting extends UdonBehaviour {
      public message: string = "hello";
      private count: int = 0;

      private twice(value: int): int { return value * 2; }

      public Start(): void {
        this.count = this.twice(2);
        Debug.log(this.message);
      }
    }
  `);
  assert.match(assembly, /\.export message/);
  assert.doesNotMatch(assembly, /\.export count/);
  assert.match(assembly, /\.export _start/);
  assert.match(assembly, /SystemInt32\.__op_Multiplication/);
});

test("uses real Udon externs for booleans and string concatenation", () => {
  const assembly = successful(`
    export function start(): void {
      const enabled: bool = !false;
      const text: string = "a" + "b";
      if (enabled) Debug.log(text);
    }
  `);
  assert.match(assembly, /SystemBoolean\.__op_UnaryNegation__SystemBoolean__SystemBoolean/);
  assert.match(assembly, /SystemString\.__Concat__SystemString_SystemString__SystemString/);
  assert.doesNotMatch(assembly, /SystemBoolean\.__Parse/);
});

test("resolves extern overloads by arity and argument type", () => {
  const externs = [{
    owner: "UnityEngineMathf", member: "abs", signature: "UnityEngineMathf.__Abs__SystemInt32__SystemInt32",
    parameters: [{ type: "SystemInt32" }], returns: "SystemInt32", static: true, kind: "method" as const
  }, {
    owner: "UnityEngineMathf", member: "abs", signature: "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    parameters: [{ type: "SystemSingle" }], returns: "SystemSingle", static: true, kind: "method" as const
  }];
  const result = compile(`export function start(): void { const x: int = Mathf.abs(-2); }`, { externs });
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.assembly, /__Abs__SystemInt32__SystemInt32/);
  assert.doesNotMatch(result.assembly, /__Abs__SystemSingle__SystemSingle/);
});

test("passes ref and out extern parameters as writable heap addresses", () => {
  const externs = [{
    owner: "SystemInt32", member: "tryParse", signature: "SystemInt32.__TryParse__SystemString_SystemInt32Ref__SystemBoolean",
    parameters: [{ type: "SystemString" }, { type: "SystemInt32", mode: "out" as const }],
    returns: "SystemBoolean", static: true, kind: "method" as const
  }];
  const result = compile(`
    export function start(): void {
      let value: int = 0;
      let ok: bool = Udon.SystemInt32.tryParse("42", value);
    }
  `, { externs });
  assert.deepEqual(result.diagnostics, []);
  const externAt = result.assembly.indexOf("SystemInt32.__TryParse");
  const beforeExtern = result.assembly.slice(Math.max(0, externAt - 180), externAt);
  assert.match(beforeExtern, /PUSH, value/);
});

test("generates UdonBehaviour event completion with typed parameters", () => {
  const declarations = generateDeclarations([]);
  assert.match(declarations, /OnPlayerJoined\(player: VRCPlayerApi\): void/);
  assert.match(declarations, /InputJump\(value: boolean, args: UdonInputEventArgs\): void/);
  assert.match(declarations, /OnPostSerialization\(result: SerializationResult\): void/);
  assert.match(declarations, /OnOwnershipRequest\(requestingPlayer: VRCPlayerApi, requestedOwner: VRCPlayerApi\): boolean/);
  assert.match(declarations, /OnDeserialization\(result\?: DeserializationResult\): void/);
});

test("compiles extended typed events to their reserved heap symbols", () => {
  const assembly = successful(`
    export class Events extends UdonBehaviour {
      public InputJump(value: bool, args: UdonInputEventArgs): void {
        if (value) Debug.log("jump");
      }

      public OnPostSerialization(result: SerializationResult): void {
        Debug.log(result);
      }
    }
  `);
  assert.match(assembly, /\.export _inputJump/);
  assert.match(assembly, /inputJumpValue: %SystemBoolean/);
  assert.match(assembly, /inputJumpArgs: %VRCUdonCommonUdonInputEventArgs/);
  assert.match(assembly, /postSerializationResult: %VRCUdonCommonSerializationResult/);
});

test("supports the boolean return value of OnOwnershipRequest", () => {
  const assembly = successful(`
    export class Ownership extends UdonBehaviour {
      public OnOwnershipRequest(requestingPlayer: VRCPlayerApi, requestedOwner: VRCPlayerApi): bool {
        return true;
      }
    }
  `);
  assert.match(assembly, /__returnValue: %SystemBoolean/);
  assert.match(assembly, /ownershipRequestRequestingPlayer: %VRCSDKBaseVRCPlayerApi/);
  assert.match(assembly, /PUSH, __returnValue/);
});

test("accepts both OnDeserialization callback variants", () => {
  const withoutResult = compile(`export function OnDeserialization(): void {}`, { fileName: "simple.ts" });
  const withResult = compile(`export function OnDeserialization(result: DeserializationResult): void { Debug.log(result); }`, { fileName: "result.ts" });
  assert.deepEqual(withoutResult.diagnostics, []);
  assert.deepEqual(withResult.diagnostics, []);
  assert.match(withResult.assembly, /deserializationResult: %VRCUdonCommonDeserializationResult/);
});
