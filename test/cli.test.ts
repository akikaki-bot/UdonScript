import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

test("CLI auto-detects Unity node dumps passed through --externs", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udon-ts-cli-"));
  try {
    const dump = resolve(directory, "udon-nodes.json");
    const declarations = resolve(directory, "udon-generated.d.ts");
    writeFileSync(dump, JSON.stringify({ nodes: [{
      fullName: "SystemInt32.__TryParse__SystemString_SystemInt32Ref__SystemBoolean",
      inputNames: ["value", "result"],
      inputTypes: ["System.String", "System.Int32"]
    }] }), "utf8");

    const result = spawnSync(process.execPath, [
      resolve("dist/cli.js"), "--externs", dump, "--emit-types", declarations
    ], { cwd: resolve("."), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(declarations, "utf8"), /namespace SystemInt32/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports malformed extern JSON without an internal TypeError", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udon-ts-cli-"));
  try {
    const invalid = resolve(directory, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ invalid: true }), "utf8");
    const result = spawnSync(process.execPath, [
      resolve("dist/cli.js"), "--externs", invalid, "--emit-types", resolve(directory, "out.d.ts")
    ], { cwd: resolve("."), encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected an extern definition array or a Unity node dump/);
    assert.doesNotMatch(result.stderr, /TypeError|at main/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI emits the entry and every relative TypeScript dependency", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "udon-ts-cli-"));
  try {
    const entry = resolve(directory, "main.ts");
    const dependency = resolve(directory, "math.ts");
    const customEntryOutput = resolve(directory, "program.uasm");
    writeFileSync(dependency, `export function twice(value: float): float { return value * 2; }`, "utf8");
    writeFileSync(entry, `
      import { twice } from "./math.js";
      on("Start", () => Debug.log(twice(2.0)));
    `, "utf8");

    const result = spawnSync(process.execPath, [
      resolve("dist/cli.js"), entry, "-o", customEntryOutput
    ], { cwd: resolve("."), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(customEntryOutput), true);
    assert.equal(existsSync(resolve(directory, "math.uasm")), true);
    assert.match(readFileSync(customEntryOutput, "utf8"), /SystemSingle\.__op_Multiplication/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
