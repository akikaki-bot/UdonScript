import type ts from "typescript";

export interface BehaviorDefinition {
  id: string;
  name: string;
  sourceFile: ts.SourceFile;
  declaration: ts.ClassDeclaration;
  methods: ReadonlyMap<string, ts.MethodDeclaration>;
  fields: ReadonlyMap<string, ts.PropertyDeclaration>;
}

export interface CompilerProjectContext {
  checker: ts.TypeChecker;
  dependenciesBySource: ReadonlyMap<ts.SourceFile, readonly ts.SourceFile[]>;
  behaviorsByDeclaration: ReadonlyMap<ts.ClassDeclaration, BehaviorDefinition>;
  behaviorsById: ReadonlyMap<string, BehaviorDefinition>;
}
