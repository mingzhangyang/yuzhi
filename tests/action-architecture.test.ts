import * as ts from 'typescript/lib/typescript.js';
import { describe, expect, it } from 'vitest';
import barrel from '../src/actions.ts?raw';
import calendarSource from '../src/actions/calendar.ts?raw';
import completionSource from '../src/actions/completion.ts?raw';
import projectsSource from '../src/actions/projects.ts?raw';
import settlementSource from '../src/actions/settlement.ts?raw';
import sharedSource from '../src/actions/shared.ts?raw';
import tasksSource from '../src/actions/tasks.ts?raw';

const domainSources = [
  ['calendar.ts', calendarSource],
  ['completion.ts', completionSource],
  ['projects.ts', projectsSource],
  ['settlement.ts', settlementSource],
  ['shared.ts', sharedSource],
  ['tasks.ts', tasksSource],
] as const;

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function dependencySpecifiers(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const specifiers: string[] = [];

  const addLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addLiteral(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return specifiers;
}

function resolvesToPublicActionBarrel(specifier: string): boolean {
  const path = specifier
    .replace(/[?#].*$/, '')
    .replace(/\.(?:[cm]?[jt]s)$/, '');
  return path === '../actions';
}

describe('action architecture boundaries', () => {
  it('domain modules never depend on the public action barrel', () => {
    const violations = domainSources.flatMap(([fileName, source]) =>
      dependencySpecifiers(fileName, source)
        .filter(resolvesToPublicActionBarrel)
        .map((specifier) => `${fileName}: ${specifier}`),
    );

    expect(violations).toEqual([]);
  });

  it('the public action module contains only top-level re-exports', () => {
    const file = parse('actions.ts', barrel);
    expect(file.statements.length).toBeGreaterThan(0);

    const invalidStatements = file.statements.filter(
      (statement) =>
        !ts.isExportDeclaration(statement)
        || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier),
    );

    expect(invalidStatements.map((statement) => statement.getText(file))).toEqual([]);
  });
});
