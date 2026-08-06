#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using VRC.Udon.Editor;

namespace UdonTs.Editor
{
    /// <summary>Exports the installed SDK's Udon Graph node registry for udon-ts.</summary>
    public static class UdonTsNodeExporter
    {
        [Serializable]
        private sealed class NodeDump
        {
            public string sdkVersion;
            public NodeEntry[] nodes;
        }

        [Serializable]
        private sealed class NodeEntry
        {
            public string fullName;
            public string name;
            public string[] inputNames;
            public string[] inputTypes;
            public string[] outputNames;
            public string[] outputTypes;
        }

        [MenuItem("VRChat SDK/Udon TS/Export extern node registry")]
        private static void Export()
        {
            var path = EditorUtility.SaveFilePanel(
                "Export Udon node registry",
                Application.dataPath,
                "udon-nodes.json",
                "json");
            if (string.IsNullOrEmpty(path)) return;

            var entries = new List<NodeEntry>();
            foreach (var definition in UdonEditorManager.Instance.GetNodeDefinitions())
            {
                object boxed = definition;
                entries.Add(new NodeEntry
                {
                    fullName = ReadString(boxed, "fullName"),
                    name = ReadString(boxed, "name"),
                    inputNames = ReadStrings(boxed, "inputNames"),
                    inputTypes = ReadTypes(boxed, "inputTypes"),
                    outputNames = ReadStrings(boxed, "outputNames"),
                    outputTypes = ReadTypes(boxed, "outputTypes")
                });
            }

            var dump = new NodeDump
            {
                sdkVersion = $"Unity {Application.unityVersion}",
                nodes = entries.ToArray()
            };
            File.WriteAllText(path, JsonUtility.ToJson(dump, true));
            AssetDatabase.Refresh();
            Debug.Log($"Exported {entries.Count} Udon node definitions to {path}");
        }

        [MenuItem("VRChat SDK/Udon TS/Verify Udon Assembly")]
        private static void VerifyAssembly()
        {
            var path = EditorUtility.OpenFilePanel("Verify Udon Assembly", Application.dataPath, "uasm");
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                UdonEditorManager.Instance.Assemble(File.ReadAllText(path));
                Debug.Log($"Udon Assembly verification succeeded: {path}");
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
        }

        private static object ReadMember(object source, string name)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            var type = source.GetType();
            var field = type.GetField(name, flags);
            if (field != null) return field.GetValue(source);
            var property = type.GetProperty(name, flags);
            return property != null ? property.GetValue(source) : null;
        }

        private static string ReadString(object source, string name)
        {
            return ReadMember(source, name)?.ToString() ?? string.Empty;
        }

        private static string[] ReadStrings(object source, string name)
        {
            var values = new List<string>();
            if (ReadMember(source, name) is IEnumerable enumerable)
            {
                foreach (var value in enumerable) values.Add(value?.ToString() ?? string.Empty);
            }
            return values.ToArray();
        }

        private static string[] ReadTypes(object source, string name)
        {
            var values = new List<string>();
            if (ReadMember(source, name) is IEnumerable enumerable)
            {
                foreach (var value in enumerable)
                {
                    values.Add(value is Type type ? type.FullName : value?.ToString() ?? string.Empty);
                }
            }
            return values.ToArray();
        }
    }
}
#endif
