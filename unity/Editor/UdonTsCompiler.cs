#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using VRC.Udon;
using VRC.Udon.Editor.ProgramSources;

namespace UdonTs.Editor
{
    /// <summary>
    /// Compiles TypeScript assets with the udon-ts CLI. The VRChat Worlds SDK's
    /// built-in .uasm importer turns the generated file into an Udon program asset.
    /// </summary>
    public static class UdonTsCompiler
    {
        private const string CliPathKey = "UdonTs.Editor.CliPath";
        private const string ExternsPathKey = "UdonTs.Editor.ExternsPath";
        private const string LastProgramPathKey = "UdonTs.Editor.LastProgramPath";

        [MenuItem("Assets/UdonScript/Compile selected TypeScript", false, 2000)]
        private static void CompileSelectedFromAssetsMenu()
        {
            CompileSelected();
        }

        [MenuItem("Assets/UdonScript/Compile selected TypeScript", true)]
        private static bool ValidateCompileSelectedFromAssetsMenu()
        {
            return GetSelectedTypeScriptAssets().Count > 0;
        }

        [MenuItem("VRChat SDK/UdonScript/Compile selected TypeScript")]
        private static void CompileSelected()
        {
            List<string> sourcePaths = GetSelectedTypeScriptAssets();
            if (sourcePaths.Count == 0)
            {
                EditorUtility.DisplayDialog(
                    "UdonScript",
                    "Projectウィンドウでコンパイルする .ts ファイルを選択してください。",
                    "OK");
                return;
            }

            string cliPath;
            if (!TryResolveCliPath(out cliPath))
            {
                EditorUtility.DisplayDialog(
                    "udon-ts が見つかりません",
                    "先に npm link を実行してUnityを再起動するか、\n" +
                    "VRChat SDK > UdonScript > Set CLI path... から udon-ts.cmd を指定してください。",
                    "OK");
                return;
            }

            string lastProgramPath = null;
            try
            {
                foreach (string sourcePath in sourcePaths)
                {
                    lastProgramPath = CompileAsset(cliPath, sourcePath);
                }
            }
            catch (Exception exception)
            {
                UnityEngine.Debug.LogException(exception);
                EditorUtility.DisplayDialog("UdonScript compile failed", exception.Message, "OK");
                return;
            }

            if (!string.IsNullOrEmpty(lastProgramPath))
            {
                SessionState.SetString(LastProgramPathKey, lastProgramPath);
                AbstractUdonProgramSource program =
                    AssetDatabase.LoadAssetAtPath<AbstractUdonProgramSource>(lastProgramPath);
                if (program != null)
                {
                    Selection.activeObject = program;
                    EditorGUIUtility.PingObject(program);
                }
            }
        }

        [MenuItem("VRChat SDK/UdonScript/Attach last compiled program to selected GameObject")]
        private static void AttachLastProgram()
        {
            GameObject target = Selection.activeGameObject;
            if (target == null)
            {
                EditorUtility.DisplayDialog("UdonScript", "HierarchyでGameObjectを選択してください。", "OK");
                return;
            }

            string programPath = SessionState.GetString(LastProgramPathKey, string.Empty);
            AbstractUdonProgramSource program =
                AssetDatabase.LoadAssetAtPath<AbstractUdonProgramSource>(programPath);
            if (program == null)
            {
                EditorUtility.DisplayDialog(
                    "UdonScript",
                    "このUnityセッションでは、まだTypeScriptをコンパイルしていません。",
                    "OK");
                return;
            }

            UdonBehaviour[] behaviours = target.GetComponents<UdonBehaviour>();
            if (behaviours.Length > 1)
            {
                EditorUtility.DisplayDialog(
                    "UdonScript",
                    "このGameObjectにはUdon Behaviourが複数あります。\n" +
                    "Inspectorで目的のProgram Sourceへ生成した .uasm を割り当ててください。",
                    "OK");
                return;
            }

            UdonBehaviour behaviour = behaviours.Length == 1
                ? behaviours[0]
                : Undo.AddComponent<UdonBehaviour>(target);

            Undo.RecordObject(behaviour, "Attach UdonScript program");
            behaviour.programSource = program;
            EditorUtility.SetDirty(behaviour);
            PrefabUtility.RecordPrefabInstancePropertyModifications(behaviour);
            program.RefreshProgram();

            Selection.activeGameObject = target;
            EditorGUIUtility.PingObject(behaviour);
            UnityEngine.Debug.Log(
                string.Format("Attached UdonScript program '{0}' to '{1}'.", programPath, target.name),
                target);
        }

        [MenuItem("VRChat SDK/UdonScript/Set CLI path...")]
        private static void SetCliPath()
        {
            string current = EditorPrefs.GetString(CliPathKey, string.Empty);
            string directory = string.IsNullOrEmpty(current)
                ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                : Path.GetDirectoryName(current);
            string path = EditorUtility.OpenFilePanel("Select udon-ts CLI", directory, string.Empty);
            if (string.IsNullOrEmpty(path)) return;

            EditorPrefs.SetString(CliPathKey, path);
            UnityEngine.Debug.Log("UdonScript CLI: " + path);
        }

        [MenuItem("VRChat SDK/UdonScript/Set extern registry...")]
        private static void SetExternsPath()
        {
            string current = EditorPrefs.GetString(ExternsPathKey, string.Empty);
            string directory = string.IsNullOrEmpty(current)
                ? ProjectRoot
                : Path.GetDirectoryName(current);
            string path = EditorUtility.OpenFilePanel("Select Udon extern registry or node dump", directory, "json");
            if (string.IsNullOrEmpty(path)) return;

            EditorPrefs.SetString(ExternsPathKey, path);
            UnityEngine.Debug.Log("UdonScript extern registry: " + path);
        }

        [MenuItem("VRChat SDK/UdonScript/Clear extern registry")]
        private static void ClearExternsPath()
        {
            EditorPrefs.DeleteKey(ExternsPathKey);
            UnityEngine.Debug.Log("UdonScript extern registry cleared.");
        }

        private static string CompileAsset(string cliPath, string sourceAssetPath)
        {
            string outputAssetPath = Path.ChangeExtension(sourceAssetPath, ".uasm").Replace('\\', '/');
            string sourcePath = Path.GetFullPath(Path.Combine(ProjectRoot, sourceAssetPath));
            string outputPath = Path.GetFullPath(Path.Combine(ProjectRoot, outputAssetPath));
            string externsPath = EditorPrefs.GetString(ExternsPathKey, string.Empty);

            var arguments = new List<string> { sourcePath, "-o", outputPath };
            if (!string.IsNullOrEmpty(externsPath))
            {
                if (!File.Exists(externsPath))
                {
                    throw new FileNotFoundException("extern registryが見つかりません。", externsPath);
                }
                arguments.Add("--externs");
                arguments.Add(externsPath);
            }

            ProcessStartInfo startInfo = CreateStartInfo(cliPath, arguments);
            using (var process = new Process { StartInfo = startInfo })
            {
                process.Start();
                var standardOutputTask = process.StandardOutput.ReadToEndAsync();
                var standardErrorTask = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                string standardOutput = standardOutputTask.Result;
                string standardError = standardErrorTask.Result;

                if (process.ExitCode != 0)
                {
                    string details = string.IsNullOrWhiteSpace(standardError)
                        ? standardOutput
                        : standardError;
                    throw new InvalidOperationException(
                        string.Format("{0} のコンパイルに失敗しました。\n\n{1}", sourceAssetPath, details.Trim()));
                }

                if (!string.IsNullOrWhiteSpace(standardOutput))
                {
                    UnityEngine.Debug.Log(standardOutput.Trim());
                }
            }

            // The CLI also emits one .uasm beside every relative TypeScript dependency.
            // Refresh the whole AssetDatabase so those program assets are imported too.
            AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            AbstractUdonProgramSource program =
                AssetDatabase.LoadAssetAtPath<AbstractUdonProgramSource>(outputAssetPath);
            if (program == null)
            {
                throw new InvalidOperationException(
                    outputAssetPath + " をUdon Program Assetとして読み込めませんでした。" +
                    "VRChat Worlds SDKがインストールされているか確認してください。");
            }

            var assemblyProgram = program as UdonAssemblyProgramAsset;
            if (assemblyProgram != null && !string.IsNullOrEmpty(assemblyProgram.AssemblyError))
            {
                throw new InvalidOperationException(
                    outputAssetPath + " のUdon Assembly検証に失敗しました。\n\n" +
                    assemblyProgram.AssemblyError);
            }

            UnityEngine.Debug.Log("Compiled UdonScript: " + sourceAssetPath + " -> " + outputAssetPath, program);
            return outputAssetPath;
        }

        private static ProcessStartInfo CreateStartInfo(string cliPath, IList<string> arguments)
        {
            string executable = cliPath;
            var allArguments = new List<string>(arguments);

            if (cliPath.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            {
                executable = "node";
                allArguments.Insert(0, cliPath);
            }

            string argumentText = JoinArguments(allArguments);
            if (Application.platform == RuntimePlatform.WindowsEditor &&
                (executable.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
                 executable.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)))
            {
                string command = Quote(executable) + " " + argumentText;
                executable = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                argumentText = "/d /s /c \"" + command + "\"";
            }

            return new ProcessStartInfo
            {
                FileName = executable,
                Arguments = argumentText,
                WorkingDirectory = ProjectRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true
            };
        }

        private static bool TryResolveCliPath(out string cliPath)
        {
            cliPath = EditorPrefs.GetString(CliPathKey, string.Empty);
            if (!string.IsNullOrEmpty(cliPath) && File.Exists(cliPath)) return true;

            string locator = Application.platform == RuntimePlatform.WindowsEditor ? "where.exe" : "which";
            string candidate = Application.platform == RuntimePlatform.WindowsEditor ? "udon-ts.cmd" : "udon-ts";
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = locator,
                    Arguments = candidate,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var process = Process.Start(startInfo))
                {
                    if (process == null) return false;
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit();
                    if (process.ExitCode != 0) return false;

                    using (var reader = new StringReader(output))
                    {
                        string firstLine = reader.ReadLine();
                        if (!string.IsNullOrWhiteSpace(firstLine) && File.Exists(firstLine.Trim()))
                        {
                            cliPath = firstLine.Trim();
                            return true;
                        }
                    }
                }
            }
            catch (Exception)
            {
                return false;
            }
            return false;
        }

        private static List<string> GetSelectedTypeScriptAssets()
        {
            var result = new List<string>();
            foreach (string guid in Selection.assetGUIDs)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (path.EndsWith(".ts", StringComparison.OrdinalIgnoreCase)) result.Add(path);
            }
            return result;
        }

        private static string JoinArguments(IList<string> values)
        {
            var parts = new string[values.Count];
            for (int index = 0; index < values.Count; index++) parts[index] = Quote(values[index]);
            return string.Join(" ", parts);
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string ProjectRoot
        {
            get { return Directory.GetParent(Application.dataPath).FullName; }
        }
    }
}
#endif
