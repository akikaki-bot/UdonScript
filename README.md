<p align="center">
  <img src="icons/UdonScript.svg" alt="UdonScript logo" width="160">
</p>

# UdonScript (US)

**UdonScript**（略称 **US**）は、TypeScriptの構文・型注釈からVRChatで読み込めるUdon Assembly (`.uasm`) を生成するトランスパイラです。

CLIに加えて、Unityの`Assets`内に置いたTypeScriptをコンパイルし、Udon Behaviourへ割り当てるEditor拡張を同梱しています。

## セットアップ

```sh
npm install
npm run build
node dist/cli.js examples/hello.ts
```

エディタの型補完には `types/udon.d.ts` を参照します。各ソース先頭へ次を追加するか、プロジェクトの `tsconfig.json` の `files` / `include` に追加してください。

```ts
/// <reference path="../types/udon.d.ts" />
```

追加externを含む補完ファイルは、コンパイラが実際に使う同じレジストリから生成できます。

```sh
udon-ts --externs ./my-externs.json --emit-types ./types/udon.generated.d.ts
```

`--externs`へUnity exporterの`udon-nodes.json`を直接渡した場合も、node dump形式を自動判別して取り込みます。明示的に変換するときは`--import-nodes`を使用できます。

## Unityへ反映する

`.ts`を`Assets`へ置くだけではUnityは実行しません。Editor拡張で`.ts`を`.uasm`へ変換し、VRChat Worlds SDK内蔵のImporterにUdon Program Assetとして読み込ませます。

1. このリポジトリでCLIをビルドしてリンクします。

   ```sh
   npm install
   npm run build
   npm link
   ```

2. `unity/Editor/UdonTsCompiler.cs`と`unity/Editor/UdonTsNodeExporter.cs`を、VRChat Worldsプロジェクトの`Assets/Editor`へコピーします。
3. Unityを再起動し、Projectウィンドウで`Assets`内の`.ts`を選択します。
4. 右クリックの`UdonScript > Compile selected TypeScript`を実行します。選択したファイルと相対importされた各`.ts`の隣に、同名の`.uasm`が生成されます。Unityは生成された全ファイルをUdon Program Assetとして自動インポートします。
5. 初回だけ、生成された`.uasm`をGameObjectの`Udon Behaviour > Program Source`へドラッグします。またはGameObjectを選び、`VRChat SDK > UdonScript > Attach last compiled program to selected GameObject`を実行します。Udon Behaviourがなければ自動で追加されます。

以後は同じ`.ts`を再コンパイルすれば、同じ`.uasm`が更新されるため割り当て直しは不要です。コンパイル後、公開フィールドはUdon BehaviourのInspectorで設定できます。

Unityから`udon-ts`を発見できない場合は、`VRChat SDK > UdonScript > Set CLI path...`で`udon-ts.cmd`を指定してください。Unityの起動後に`npm link`した場合は、Unityを再起動するとPATHも更新されます。

SDKから出力したnode dumpや追加externを使う場合は、`VRChat SDK > UdonScript > Set extern registry...`でJSONを指定します。

## import / export

`import`と`export`は通常のTypeScriptモジュール構文として使えます。`.js`拡張子でimportすると、NodeNext方式で対応する`.ts`へ解決されます。

```ts
// math.ts
export function twice(value: float): float {
  return value * 2;
}

// door-controller.ts
export class DoorController extends UdonBehaviour {
  @udonVariable
  opened: bool = false;

  public Toggle(): bool {
    this.opened = !this.opened;
    return this.opened;
  }
}

// door-button.ts
import { DoorController } from "./door-controller.js";
import { twice } from "./math.js";

export class DoorButton extends UdonBehaviour {
  @udonVariable
  door!: DoorController;

  public override Interact(): void {
    Debug.log(twice(2.0));
    Debug.log(this.door.Toggle());
  }
}
```

```sh
udon-ts ./door-button.ts
```

この例では`door-button.uasm`、`door-controller.uasm`、`math.uasm`を生成します。通常の関数・定数は参照側のUdonプログラムへ組み込まれます。`UdonBehaviour`クラスは独立したUdonプログラムになり、型付きのフィールド参照とpublicメソッド呼び出しは、Udonの`SetProgramVariable`、`SendCustomEvent`、`GetProgramVariable`へ変換されます。

Unityでは`door-controller.uasm`と`door-button.uasm`をそれぞれ別のUdon Behaviourへ割り当て、`DoorButton`の`door`欄へ前者のUdon Behaviourを設定してください。1つの`.ts`に定義できる`UdonBehaviour`クラスは1つです。現在は相対パスの実行モジュールだけを参照でき、importしたモジュールの可変なトップレベル変数は参照側プログラムごとに個別の状態を持ちます。

`export`自体にはUdonのInspector公開やイベント登録の意味はありません。Inspector公開は`udonVariable` / `@udonVariable`、トップレベルイベントは`on(...)`を使用します。

### UdonBehaviourイベント補完

`UdonBehaviour`を継承すると、イベント名、引数型、戻り値がエディタで補完されます。`override`を付けることでスペルやシグネチャの間違いもTypeScriptが検出します。

```ts
export class EventExample extends UdonBehaviour {
  public override Start(): void {
    Debug.log("started");
  }

  public override OnPlayerJoined(player: VRCPlayerApi): void {
    Debug.log(player.displayName);
  }

  public override InputJump(value: bool, args: UdonInputEventArgs): void {
    if (value) Debug.log(args);
  }

  public override OnOwnershipRequest(
    requestingPlayer: VRCPlayerApi,
    requestedOwner: VRCPlayerApi
  ): bool {
    return true;
  }
}
```

ライフサイクル、Pickup、Player、Collision、Networking、Video、Input、MIDI、Persistenceなどのイベントを補完します。イベント定義は`src/events.ts`を唯一の情報源として、コンパイラと`.d.ts`生成で共有されています。

イベント定義や組み込みexternを変更したあと、標準補完ファイルを再生成する場合：

```sh
npm run generate:types
```

## 言語モデル

Udon VMにローカル変数はないため、TypeScriptのトップレベル変数・ローカル変数・一時値はすべて一意なUdon Heap変数へ変換されます。ユーザー関数はインライン展開されるので、通常の引数と戻り値を使えますが、再帰はコンパイルエラーです。

```ts
let message = udonVariable<string>("hello");
let speed = udonVariable<float>(2.5, { sync: "linear" });

function twice(value: float): float {
  return value * 2;
}

on("Start", () => {                    // Udonイベント _start
  Debug.log(message);
  Networking.localPlayer.setWalkSpeed(twice(speed));
});
```

トップレベルでは`udonVariable<T>(初期値, オプション)`がUnity Inspectorへ公開する明示的な組み込み関数です。これは実行時の関数呼び出しではなく、コンパイラが`.export`と初期値へ変換します。Inspectorから変更できる値なので`const`では宣言できません。

クラス形式では同じ意味を持つ`@udonVariable`デコレーターを使用します。`public`だけではInspectorへ公開されないため、公開したいフィールドを明示してください。イベント名は `start` と `Start` の両方を受け付けます。

```ts
export class Greeting extends UdonBehaviour {
  @udonVariable
  message: string = "hello";

  @udonVariable({ sync: "linear" })
  speed: float = 2.5;

  private count: int = 0;

  private twice(value: int): int { return value * 2; }

  public Start(): void {
    this.count = this.twice(2);
    Debug.log(this.message);
  }
}
```

トップレベルのイベントは`on(イベント名, ハンドラー)`で登録します。標準イベントは引数も型推論され、未知の名前は引数なしのカスタムイベントとして扱われます。同じイベントへ複数回登録した場合は、ソースに書いた順で実行されます。

```ts
on("OnPlayerJoined", (player) => {
  Debug.log(player.displayName);
});

on("OpenDoor", () => {
  Debug.log("open");
});

on("Interact", () => {
  emit("OpenDoor");                 // このBehaviourですぐ実行
  emitDelayed("OpenDoor", 1.5);     // 秒後（Updateタイミング）
  emitDelayedFrames("OpenDoor", 2); // フレーム後（Updateタイミング）
  emitNetwork(NetworkEventTarget.All, "OpenDoor");
});
```

`emit`系のイベント名は文字列リテラルで指定し、同じファイル内で`on`登録したイベントを呼び出します。現在のネットワークイベントは引数なしだけに対応しています。`NetworkEventTarget.All`は直接指定できますが、`Owner`、`Others`、`Self`はraw UASMでenum値を表現できないため、Inspector公開変数にして選択します。

```ts
let networkTarget = udonVariable<NetworkEventTarget>();

on("Interact", () => {
  emitNetwork(networkTarget, "OpenDoor");
});
```

これらは非同期関数やイベントごとのstate machineを生成せず、UdonのCustom Event APIを直接呼び出します。

現在の制御構文は `if/else`, `while`, `for`, `break`, `continue`, `return`, 三項演算子、短絡する `&&` / `||` です。基本型は `bool`, `int`, `uint`, `float`, `double`, `string` と、定義済みUnity/VRChat型です。

### 配列

Udonの型別配列externへ変換し、配列リテラル、長さ指定の生成、要素取得、要素代入、`length`を使用できます。空の配列には型注釈が必要です。

```ts
let targets = udonVariable<GameObject[]>(); // Inspectorで要素を割り当て

on("Start", () => {
  const scores: int[] = [10, 20, 30];
  const copy: int[] = new Array<int>(scores.length);

  copy[0] = scores[1];
  Debug.log(copy[0]);
});
```

`Array<int>`形式の型注釈も`int[]`と同じ意味で使用できます。現在、spread、空要素、要素への`++`、要素を`ref`/`out`引数として渡す操作には対応していません。

## extern

`builtins/externs.json` は補完可能なTypeScript APIと、実際のUdon extern署名を結びます。追加APIは同じ形式のJSONを作り、CLIへ渡せます。

```sh
udon-ts behaviour.ts --externs ./my-externs.json -o behaviour.uasm
```

```json
[
  {
    "owner": "UnityEngineMathf",
    "member": "abs",
    "signature": "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
    "parameters": [{ "type": "SystemSingle" }],
    "returns": "SystemSingle",
    "static": true,
    "kind": "method",
    "aliases": ["Abs"]
  }
]
```

レジストリにないexternは、署名を明示して呼び出せます。

```ts
const value = extern<float>(
  "UnityEngineMathf.__Abs__SystemSingle__SystemSingle",
  input
);
```

レジストリでは `mode: "ref"` / `mode: "out"` も指定できます。その引数には変数を渡す必要があり、同じheapアドレスがexternへ渡されます。

### VRChat SDKから完全な一覧を取り込む

公式仕様が推奨するUdon Graphノードの取得用に、`unity/Editor/UdonTsNodeExporter.cs` を同梱しています。このファイルをVRChat Worlds Unityプロジェクトの `Assets/Editor` へコピーし、メニューの `VRChat SDK > UdonScript > Export extern node registry` を実行します。その後、出力したdumpを変換します。

```sh
udon-ts --import-nodes ./udon-nodes.json \
  --registry-out ./externs.sdk.json \
  --emit-types ./types/udon.sdk.d.ts
```

この方式では、インストール済みSDKバージョンが実際に公開しているextern署名をコンパイラと型補完の両方へ反映できます。SDK更新時は再エクスポートしてください。

同じUnity Editor拡張の `VRChat SDK > UdonScript > Verify Udon Assembly` では、生成した`.uasm`をSDK内蔵Assemblerへ渡して、そのSDKバージョンで受理されることを検証できます。

## CLI

```text
udon-ts <input.ts> [-o output.uasm] [--externs registry.json]
```

`-o`は入力ファイルの出力先だけを変更します。相対importされたファイルの`.uasm`は、各`.ts`と同じディレクトリへ生成されます。

`--source-comments` を付けると、元ファイルと行番号をAssemblyコメントとして埋め込みます。

## 現在の制限

- 配列以外のオブジェクト生成、`switch`、`foreach` は未実装です。

Udon VM/Assemblyの仕様は [VRChat公式ドキュメント](https://creators.vrchat.com/worlds/udon/vm-and-assembly/) を参照しています。
