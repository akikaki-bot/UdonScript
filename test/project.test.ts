import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { compileProject } from "../src/index.js";

test("resolves imports, emits every module and lowers cross-behaviour calls", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udonscript-project-"));
  try {
    const entry = resolve(directory, "main.ts");
    writeFileSync(resolve(directory, "math.ts"), `
      export function twice(value: float): float {
        return value * 2;
      }
    `, "utf8");
    writeFileSync(resolve(directory, "door.ts"), `
      export class Door extends UdonBehaviour {
        @udonVariable
        opened: bool = false;

        public SetOpened(value: bool): bool {
          this.opened = value;
          return this.opened;
        }
      }
    `, "utf8");
    writeFileSync(entry, `
      import { Door } from "./door.js";
      import { twice } from "./math.js";

      let door = udonVariable<Door>();

      on("Interact", () => {
        const linkedDoor = door;
        const scaled = twice(1.0);
        const opened: bool = linkedDoor.SetOpened(scaled > 1.0);
        linkedDoor.opened = opened;
        Debug.log(opened);
        Debug.log(linkedDoor.opened);
      });
    `, "utf8");

    const result = compileProject(entry);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.artifacts.map((artifact) => basename(artifact.sourceFile)).sort(),
      ["door.ts", "main.ts", "math.ts"]
    );
    const main = result.artifacts.find((artifact) => basename(artifact.sourceFile) === "main.ts")!.assembly;
    const door = result.artifacts.find((artifact) => basename(artifact.sourceFile) === "door.ts")!.assembly;
    const math = result.artifacts.find((artifact) => basename(artifact.sourceFile) === "math.ts")!.assembly;
    assert.match(main, /%SystemSingle, 2/);
    assert.doesNotMatch(main, /SystemSingle\.__op_Multiplication/);
    assert.match(main, /__SetProgramVariable__SystemString_SystemObject__SystemVoid/);
    assert.match(main, /__SendCustomEvent__SystemString__SystemVoid/);
    assert.match(main, /__GetProgramVariable__SystemString__SystemObject/);
    assert.match(door, /\.export SetOpened/);
    assert.match(door, /\.export __method_SetOpened_arg0_value/);
    assert.match(door, /\.export __method_SetOpened_return/);
    assert.doesNotMatch(door, /SystemSingle\.__op_Multiplication/);
    assert.doesNotMatch(math, /SetOpened|Interact/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects runtime imports outside the relative TypeScript graph", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udonscript-project-"));
  try {
    const entry = resolve(directory, "main.ts");
    writeFileSync(entry, `import { value } from "some-package"; on("Start", () => Debug.log(value));`, "utf8");
    const result = compileProject(entry);
    assert.equal(result.artifacts.length, 0);
    assert.match(result.diagnostics[0]!.message, /相対import/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves transitive re-exports and anonymous default functions", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udonscript-project-"));
  try {
    const entry = resolve(directory, "main.ts");
    writeFileSync(resolve(directory, "math.ts"), `
      export default function(value: int): int { return value * 3; }
    `, "utf8");
    writeFileSync(resolve(directory, "api.ts"), `
      export { default as triple } from "./math.js";
    `, "utf8");
    writeFileSync(entry, `
      import { triple } from "./api.js";
      on("Start", () => {
        const result = triple(4);
        Debug.log(result);
      });
    `, "utf8");

    const result = compileProject(entry);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.artifacts.map((artifact) => basename(artifact.sourceFile)),
      ["math.ts", "api.ts", "main.ts"]
    );
    assert.match(result.artifacts[2]!.assembly, /%SystemInt32, 12/);
    assert.doesNotMatch(result.artifacts[2]!.assembly, /SystemInt32\.__op_Multiplication/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects transitive circular imports with the complete cycle path", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udonscript-project-"));
  try {
    const entry = resolve(directory, "main.ts");
    writeFileSync(entry, `import { a } from "./a.js"; export const main: int = a;`, "utf8");
    writeFileSync(resolve(directory, "a.ts"), `import { b } from "./b.js"; export const a: int = b;`, "utf8");
    writeFileSync(resolve(directory, "b.ts"), `import { main } from "./main.js"; export const b: int = main;`, "utf8");

    const result = compileProject(entry);
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0]!.message, /Warning: 循環import/);
    assert.match(result.diagnostics[0]!.message, /main\.ts -> a\.ts -> b\.ts -> main\.ts/);
    assert.match(result.diagnostics[0]!.message, /CompileError/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("imports exported arrow functions and removes duplicate diagnostics", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udonscript-project-"));
  try {
    const entry = resolve(directory, "main.ts");
    writeFileSync(resolve(directory, "numberUtil.ts"), `
      export const getNdouble = (n: uint, number: uint): uint => n * number;
    `, "utf8");
    writeFileSync(resolve(directory, "util.ts"), `
      import { getNdouble } from "./numberUtil.js";
      export const getDouble = (number: uint): uint => getNdouble(2, number);
    `, "utf8");
    writeFileSync(entry, `
      import { getDouble } from "./util.js";

      export class BaseComponent extends UdonBehaviour {
        @udonVariable
        public isEnabled: bool = false;

        public override OnEnable() {
          this.isEnabled = true;
          Debug.log(this.getDouble(3));
        }

        private getDouble(number: uint) {
          return getDouble(number);
        }
      }
    `, "utf8");

    const result = compileProject(entry);
    assert.deepEqual(result.diagnostics, []);
    const optimized = result.artifacts.at(-1)!.assembly;
    assert.match(optimized, /%SystemUInt32, 6u/);
    assert.doesNotMatch(optimized, /SystemUInt32\.__op_Multiplication/);
    assert.doesNotMatch(optimized, /getDouble_number|getDouble_return|getNdouble_n|getNdouble_number|getNdouble_return/);

    writeFileSync(entry, `
      import { getDouble } from "./util.js";

      export class BaseComponent extends UdonBehaviour {
        @udonVariable public amount: uint = 3;
        public override Start(): void { Debug.log(this.getDouble(this.amount)); }
        private getDouble(number: uint): uint { return getDouble(number); }
      }
    `, "utf8");
    const dynamic = compileProject(entry);
    assert.deepEqual(dynamic.diagnostics, []);
    const dynamicAssembly = dynamic.artifacts.at(-1)!.assembly;
    assert.equal((dynamicAssembly.match(/SystemUInt32\.__op_Multiplication/g) ?? []).length, 1);
    assert.doesNotMatch(dynamicAssembly, /getDouble_number|getDouble_return|getNdouble_n|getNdouble_number|getNdouble_return/);

    writeFileSync(resolve(directory, "numberUtil.ts"), `export const unsupported = {};`, "utf8");
    writeFileSync(resolve(directory, "util.ts"), `export { unsupported } from "./numberUtil.js";`, "utf8");
    writeFileSync(entry, `import { unsupported } from "./util.js"; on("Start", () => Debug.log("loaded"));`, "utf8");
    const invalid = compileProject(entry);
    assert.equal(invalid.artifacts.length, 0);
    assert.equal(invalid.diagnostics.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
