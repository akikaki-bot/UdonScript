import assert from "node:assert/strict";
import test from "node:test";
import { compile, generateDeclarations, importNodeDump } from "../src/index.js";

function successful(source: string): string {
  const result = compile(source, { fileName: "test.ts" });
  assert.deepEqual(result.diagnostics, []);
  return result.assembly;
}

test("treats export as module syntax without legacy Udon exposure", () => {
  const assembly = successful(`
    export let message: string = "hello";
    export let speed: float = 2.5;
    export function start(): void {
      Debug.log(message);
      Networking.localPlayer.setWalkSpeed(speed);
    }
  `);
  assert.doesNotMatch(assembly, /\.export message/);
  assert.doesNotMatch(assembly, /\.export _start/);
  assert.doesNotMatch(assembly, /UnityEngineDebug\.__Log__SystemObject__SystemVoid/);
});

test("exposes top-level udonVariable calls with defaults and sync options", () => {
  const assembly = successful(`
    let speed = udonVariable<float>(2.5, { sync: "linear" });
    let target = udonVariable<GameObject>(null);

    on("Start", () => {
      Networking.localPlayer.setWalkSpeed(speed);
      Debug.log(target);
    });
  `);
  assert.match(assembly, /\.export speed/);
  assert.match(assembly, /\.sync speed, linear/);
  assert.match(assembly, /speed: %SystemSingle, 2\.5/);
  assert.match(assembly, /\.export target/);
  assert.match(assembly, /target: %UnityEngineGameObject, null/);
});

test("exposes decorated UdonBehaviour fields", () => {
  const assembly = successful(`
    export class PlayerSettings extends UdonBehaviour {
      @udonVariable({ sync: "smooth" })
      speed: float = 4.5;

      @udonVariable
      target: GameObject = null;

      public internalCount: int = 3;

      public Start(): void {
        Debug.log(this.speed);
        Debug.log(this.target);
      }
    }
  `);
  assert.match(assembly, /\.export speed/);
  assert.match(assembly, /\.sync speed, smooth/);
  assert.match(assembly, /speed: %SystemSingle, 4\.5/);
  assert.match(assembly, /\.export target/);
  assert.doesNotMatch(assembly, /\.export internalCount/);
});

test("reports invalid udonVariable declarations", () => {
  const constant = compile("const speed = udonVariable<float>(2.5);", { fileName: "constant.ts" });
  assert.equal(constant.diagnostics.length, 1);
  assert.match(constant.diagnostics[0]!.message, /const/);

  const classCall = compile(`
    class Invalid extends UdonBehaviour {
      speed: float = udonVariable<float>(2.5);
    }
  `, { fileName: "class-call.ts" });
  assert.equal(classCall.diagnostics.length, 1);
  assert.match(classCall.diagnostics[0]!.message, /@udonVariable/);

  const invalidSync = compile(`
    let speed = udonVariable<float>(2.5, { sync: "fast" });
  `, { fileName: "sync.ts" });
  assert.equal(invalidSync.diagnostics.length, 1);
  assert.match(invalidSync.diagnostics[0]!.message, /linear.*smooth/);
});

test("registers standard and custom events with on", () => {
  const assembly = successful(`
    on("Start", () => {
      emit("OpenDoor");
    });

    on("OpenDoor", () => {
      Debug.log("first");
    });

    on("OpenDoor", () => {
      Debug.log("second");
    });

    on("OnPlayerJoined", (player) => {
      Debug.log(player.displayName);
    });
  `);
  assert.equal((assembly.match(/\.export OpenDoor/g) ?? []).length, 1);
  assert.match(assembly, /\.export _start/);
  assert.match(assembly, /\.export _onPlayerJoined/);
  assert.match(assembly, /playerJoinedPlayer: %VRCSDKBaseVRCPlayerApi/);
  assert.match(assembly, /"first"/);
  assert.match(assembly, /"second"/);
});

test("emits local, delayed and network custom event calls", () => {
  const assembly = successful(`
    let target = udonVariable<NetworkEventTarget>();

    on("Start", () => {
      emit("OpenDoor");
      emitDelayed("OpenDoor", 1.5);
      emitDelayedFrames("OpenDoor", 2);
      emitNetwork(NetworkEventTarget.All, "OpenDoor");
      emitNetwork(target, "OpenDoor");
    });

    on("OpenDoor", () => {});
  `);
  assert.match(assembly, /IUdonEventReceiver\.__SendCustomEvent__SystemString__SystemVoid/);
  assert.match(assembly, /IUdonEventReceiver\.__SendCustomEventDelayedSeconds/);
  assert.match(assembly, /IUdonEventReceiver\.__SendCustomEventDelayedFrames/);
  assert.equal((assembly.match(/IUdonEventReceiver\.__SendCustomNetworkEvent/g) ?? []).length, 2);
  assert.equal((assembly.match(/%VRCUdonCommonEnumsEventTiming/g) ?? []).length, 1);
  assert.equal((assembly.match(/%SystemString, "OpenDoor"/g) ?? []).length, 1);
  assert.match(assembly, /target: %VRCUdonCommonInterfacesNetworkEventTarget, null/);
});

test("reports invalid event API usage", () => {
  const topLevelEmit = compile(`emit("Missing");`, { fileName: "top-level-emit.ts" });
  assert.equal(topLevelEmit.diagnostics.length, 1);
  assert.match(topLevelEmit.diagnostics[0]!.message, /ハンドラー内/);

  const customArguments = compile(`on("Custom", (value: int) => {});`, { fileName: "custom-args.ts" });
  assert.equal(customArguments.diagnostics.length, 1);
  assert.match(customArguments.diagnostics[0]!.message, /引数は指定できません/);

  const missing = compile(`on("Start", () => { emit("Missing"); });`, { fileName: "missing-event.ts" });
  assert.equal(missing.diagnostics.length, 1);
  assert.match(missing.diagnostics[0]!.message, /登録されていません/);

  const owner = compile(`
    on("Start", () => emitNetwork(NetworkEventTarget.Owner, "Custom"));
    on("Custom", () => {});
  `, { fileName: "owner.ts" });
  assert.equal(owner.diagnostics.length, 1);
  assert.match(owner.diagnostics[0]!.message, /All以外/);
});

test("lowers control flow and arithmetic operators", () => {
  const assembly = successful(`
    on("Update", () => {
      let i: int = 0;
      while (i < 3) {
        i++;
      }
    });
  `);
  assert.match(assembly, /SystemInt32\.__op_LessThan/);
  assert.match(assembly, /SystemInt32\.__op_Addition/);
  assert.match(assembly, /JUMP_IF_FALSE/);
});

test("inlines typed user functions", () => {
  const assembly = successful(`
    function twice(value: float): float { return value * 2; }
    on("Start", () => {
      const result: float = twice(1.5);
      Debug.log(result);
    });
  `);
  assert.doesNotMatch(assembly, /twice_value|twice_return/);
  assert.match(assembly, /%SystemSingle, 3/);
  assert.doesNotMatch(assembly, /SystemSingle\.__op_Multiplication/);
  assert.doesNotMatch(assembly, /\.export twice/);
});

test("keeps a value snapshot when an inlined identity receives mutable storage", () => {
  const assembly = successful(`
    let source = udonVariable<int>(1);
    function identity(value: int): int { return value; }
    function update(): int { source = 2; return 0; }
    on("Start", () => Debug.log(identity(source) + update()));
  `);
  assert.match(assembly, /identity_return/);
  assert.match(assembly, /PUSH, source\s+PUSH, identity_return[^\n]*\s+COPY/);
});

test("treats top-level arrow and function expressions as inline functions", () => {
  const assembly = successful(`
    const multiply = (left: uint, right: uint): uint => left * right;
    const double = function(value: uint): uint { return multiply(2, value); };

    on("Start", () => {
      Debug.log(double(4));
    });
  `);
  assert.match(assembly, /%SystemUInt32, 8u/);
  assert.doesNotMatch(assembly, /SystemUInt32\.__op_Multiplication/);
  assert.doesNotMatch(assembly, /multiply: %|double: %/);
});

test("evaluates scalar functions and loops with comptime", () => {
  const result = compile(`
    function sumTo(limit: uint): uint {
      let total: uint = 0;
      for (let index: uint = 0; index < limit; index++) total += index;
      return total;
    }

    on("Start", () => {
      Debug.log(comptime((): uint => sumTo(5)));
    });
  `);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.assembly, /%SystemUInt32, 10u/);
  assert.doesNotMatch(result.assembly, /op_Addition|op_LessThan/);
});

test("evaluates comptime arrays and materializes only their final values", () => {
  const result = compile(`
    on("Start", () => {
      const values: int[] = comptime((): int[] => {
        const result: int[] = [0, 0, 0];
        for (let index: int = 0; index < result.length; index++) result[index] = index * 2;
        return result;
      });
      Debug.log(values[2]);
    });
  `);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.assembly, /%SystemInt32, 4/);
  assert.doesNotMatch(result.assembly, /op_Multiplication|op_LessThan/);
});

test("creates typed fixed-length arrays with new Array inside comptime", () => {
  const result = compile(`
    on("Start", () => {
      const numbers: uint[] = comptime((): uint[] => {
        const values = new Array<uint>(32);
        values[31] = 99;
        return values;
      });
      const flags: bool[] = comptime((): bool[] => {
        const values = new Array<bool>(2);
        values[1] = true;
        return values;
      });
      const objects: GameObject[] = comptime((): GameObject[] => new Array<GameObject>(2));
      Debug.log(numbers[31]);
      Debug.log(flags[1]);
      Debug.log(objects.length);
    });
  `);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.assembly, /%SystemInt32, 32/);
  assert.match(result.assembly, /%SystemUInt32, 99u/);
  assert.equal((result.assembly.match(/SystemUInt32Array\.__Set__/g) ?? []).length, 1);
  assert.equal((result.assembly.match(/SystemBooleanArray\.__Set__/g) ?? []).length, 1);
  assert.doesNotMatch(result.assembly, /SystemGameObjectArray\.__Set__|UnityEngineGameObjectArray\.__Set__/);
});

test("reports invalid comptime Array lengths and missing element types", () => {
  const negative = compile(`on("Start", () => comptime((): uint[] => new Array<uint>(-1)));`);
  assert.equal(negative.diagnostics.length, 1);
  assert.match(negative.diagnostics[0]!.message, /0以上/);

  const fractional = compile(`on("Start", () => comptime((): uint[] => new Array<uint>(2.5)));`);
  assert.equal(fractional.diagnostics.length, 1);
  assert.match(fractional.diagnostics[0]!.message, /確定するint/);

  const runtime = compile(`
    let length = udonVariable<int>(32);
    on("Start", () => comptime((): uint[] => new Array<uint>(length)));
  `);
  assert.equal(runtime.diagnostics.length, 1);
  assert.match(runtime.diagnostics[0]!.message, /comptimeで確定していません/);

  const missingType = compile(`on("Start", () => comptime(() => new Array(2)));`);
  assert.equal(missingType.diagnostics.length, 1);
  assert.match(missingType.diagnostics[0]!.message, /要素型を1つ指定/);

  const huge = compile(`on("Start", () => comptime((): uint[] => new Array<uint>(100001)));`);
  assert.equal(huge.diagnostics.length, 1);
  assert.match(huge.diagnostics[0]!.message, /長さが上限100000/);
});

test("evaluates private @comptime methods and rejects runtime inputs or side effects", () => {
  const valid = compile(`
    export class Ids extends UdonBehaviour {
      @comptime
      private id(category: uint, index: uint): uint { return category * 100 + index; }
      public Start(): void { Debug.log(this.id(1, 23)); }
    }
  `);
  assert.deepEqual(valid.diagnostics, []);
  assert.match(valid.assembly, /%SystemUInt32, 123u/);
  assert.doesNotMatch(valid.assembly, /op_Multiplication|op_Addition/);

  const dynamic = compile(`
    export class Invalid extends UdonBehaviour {
      @udonVariable index: uint = 0;
      @comptime private id(value: uint): uint { return value + 1; }
      public Start(): void { Debug.log(this.id(this.index)); }
    }
  `);
  assert.equal(dynamic.diagnostics.length, 1);
  assert.match(dynamic.diagnostics[0]!.message, /comptime.*確定していません/);

  const sideEffect = compile(`
    on("Start", () => comptime((): uint => {
      Debug.log("nope");
      return 1;
    }));
  `);
  assert.equal(sideEffect.diagnostics.length, 1);
  assert.match(sideEffect.diagnostics[0]!.message, /純粋なユーザー関数とMath\/Mathf/);

  const publicMethod = compile(`
    export class Invalid extends UdonBehaviour {
      @comptime public id(value: uint): uint { return value; }
    }
  `);
  assert.equal(publicMethod.diagnostics.length, 1);
  assert.match(publicMethod.diagnostics[0]!.message, /privateまたはprotected/);
});

test("lowers comptime boolean globals through valid Udon boolean instructions", () => {
  const result = compile(`
    const enabled: bool = comptime((): bool => true);
    on("Start", () => Debug.log(enabled));
  `);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotMatch(result.assembly, /%SystemBoolean, true/);
  assert.match(result.assembly, /SystemBoolean\.__op_UnaryNegation/);
});

test("can disable IR optimization and reports optimization statistics", () => {
  const source = `on("Start", () => Debug.log((2 as uint) * (3 as uint)));`;
  const optimized = compile(source);
  const raw = compile(source, { optimize: false });
  assert.deepEqual(optimized.diagnostics, []);
  assert.deepEqual(raw.diagnostics, []);
  assert.doesNotMatch(optimized.assembly, /op_Multiplication/);
  assert.match(raw.assembly, /op_Multiplication/);
  assert.ok(optimized.stats);
  assert.ok(optimized.stats.constantsFolded >= 1);
  assert.ok(optimized.stats.instructionsAfter < optimized.stats.instructionsBefore);
});

test("never folds Inspector or event values from their data-section defaults", () => {
  const inspector = compile(`
    let speed = udonVariable<float>(2.5);
    on("Start", () => Debug.log(speed * 2.0));
  `);
  assert.deepEqual(inspector.diagnostics, []);
  assert.match(inspector.assembly, /SystemSingle\.__op_Multiplication/);

  const event = compile(`
    on("InputJump", (value, args) => Debug.log(value == true));
  `);
  assert.deepEqual(event.diagnostics, []);
  assert.match(event.assembly, /SystemBoolean\.__op_Equality/);
});

test("maps event parameters to their required heap symbols", () => {
  const assembly = successful(`
    on("OnPlayerJoined", (player: VRCPlayerApi) => {
      Debug.log(player.displayName);
    });
  `);
  assert.match(assembly, /playerJoinedPlayer: %VRCSDKBaseVRCPlayerApi/);
  assert.match(assembly, /\.export _onPlayerJoined/);
});

test("supports raw extern escape hatch", () => {
  const assembly = successful(`
    on("Start", () => {
      let x: float = extern<float>("UnityEngineMathf.__Abs__SystemSingle__SystemSingle", -2.0);
    });
  `);
  assert.match(assembly, /UnityEngineMathf\.__Abs__SystemSingle__SystemSingle/);
});

test("reports type errors with a source location", () => {
  const result = compile(`on("Start", () => { let x: int = "oops"; });`, { fileName: "bad.ts" });
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
  assert.match(declarations, /function udonVariable<T>/);
  assert.match(declarations, /UdonVariableDecorator/);
  assert.match(declarations, /function on\(event: "OnPlayerJoined"/);
  assert.match(declarations, /function emitDelayed/);
  assert.match(declarations, /function emitNetwork/);
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
      @udonVariable
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
  assert.match(assembly, /%SystemInt32, 4/);
  assert.doesNotMatch(assembly, /SystemInt32\.__op_Multiplication/);
});

test("infers private method return types from typed parameters", () => {
  const assembly = successful(`
    export class MathComponent extends UdonBehaviour {
      private identity(value: uint) { return value; }

      public Start(): void {
        const result = this.identity(3);
        Debug.log(result);
      }
    }
  `);
  assert.match(assembly, /result_\d+: %SystemUInt32/);
  assert.doesNotMatch(assembly, /identity_value|identity_return/);
});

test("uses real Udon externs for booleans and string concatenation", () => {
  const assembly = successful(`
    on("Start", () => {
      const enabled: bool = !false;
      const text: string = "a" + "b";
      if (enabled) Debug.log(text);
    });
  `);
  assert.match(assembly, /SystemBoolean\.__op_UnaryNegation__SystemBoolean__SystemBoolean/);
  assert.match(assembly, /%SystemString, "ab"/);
  assert.doesNotMatch(assembly, /SystemString\.__Concat__SystemString_SystemString__SystemString/);
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
  const result = compile(`on("Start", () => { const x: int = Mathf.abs(-2); });`, { externs });
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
    on("Start", () => {
      let value: int = 0;
      let ok: bool = Udon.SystemInt32.tryParse("42", value);
    });
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
  const withoutResult = compile(`on("OnDeserialization", () => {});`, { fileName: "simple.ts" });
  const withResult = compile(`on("OnDeserialization", (result: DeserializationResult) => { Debug.log(result); });`, { fileName: "result.ts" });
  assert.deepEqual(withoutResult.diagnostics, []);
  assert.deepEqual(withResult.diagnostics, []);
  assert.match(withResult.assembly, /deserializationResult: %VRCUdonCommonDeserializationResult/);
});

test("constructs arrays and supports element get, set and length", () => {
  const assembly = successful(`
    let targets = udonVariable<GameObject[]>();
    let scores: int[] = [10, 20, 30];

    on("Start", () => {
      const count: int = scores.length;
      const first: int = scores[0];
      scores[1] = first + 5;
      const players: VRCPlayerApi[] = new Array<VRCPlayerApi>(count);
      Debug.log(targets[0]);
      Debug.log(players.length);
    });
  `);
  assert.match(assembly, /scores: %SystemInt32Array/);
  assert.match(assembly, /SystemInt32Array\.__ctor__SystemInt32__SystemInt32Array/);
  assert.match(assembly, /SystemInt32Array\.__Get__SystemInt32__SystemInt32/);
  assert.match(assembly, /SystemInt32Array\.__Set__SystemInt32_SystemInt32__SystemVoid/);
  assert.match(assembly, /SystemInt32Array\.__get_Length__SystemInt32/);
  assert.match(assembly, /VRCSDKBaseVRCPlayerApiArray\.__ctor__SystemInt32__VRCSDKBaseVRCPlayerApiArray/);
  assert.match(assembly, /UnityEngineGameObjectArray\.__Get__SystemInt32__UnityEngineGameObject/);
});

test("infers array literals and accepts Array<T> annotations", () => {
  const assembly = successful(`
    on("Start", () => {
      const inferred = [1, 2, 3];
      const generic: Array<int> = inferred;
      Debug.log(generic[2]);
    });
  `);
  assert.match(assembly, /inferred.*%SystemInt32Array/);
  assert.match(assembly, /SystemInt32Array\.__Get__SystemInt32__SystemInt32/);
});

test("supports array fields through this access", () => {
  const assembly = successful(`
    export class Arrays extends UdonBehaviour {
      private values: int[] = [1, 2, 3];

      public Start(): void {
        const last: int = this.values[this.values.length - 1];
        this.values[0] = last;
      }
    }
  `);
  assert.match(assembly, /SystemInt32Array\.__get_Length__SystemInt32/);
  assert.match(assembly, /SystemInt32Array\.__Get__SystemInt32__SystemInt32/);
  assert.match(assembly, /SystemInt32Array\.__Set__SystemInt32_SystemInt32__SystemVoid/);
});

test("reports invalid array elements and untyped empty arrays", () => {
  const wrongElement = compile(`
    on("Start", () => {
      const values: int[] = [1, "oops"];
    });
  `, { fileName: "wrong-element.ts" });
  assert.equal(wrongElement.diagnostics.length, 1);
  assert.match(wrongElement.diagnostics[0]!.message, /string.*int/);

  const empty = compile(`
    on("Start", () => {
      const values = [];
    });
  `, { fileName: "empty-array.ts" });
  assert.equal(empty.diagnostics.length, 1);
  assert.match(empty.diagnostics[0]!.message, /型を推論|型注釈/);
});
