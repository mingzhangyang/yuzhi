import { describe, expect, it } from 'vitest';
import barrel from '../src/actions.ts?raw';

const domainSources = import.meta.glob('../src/actions/*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

/**
 * Remove comments without touching quoted module specifiers. This keeps the
 * architecture checks semantic enough to ignore documentation examples while
 * still treating strings and template literals as code.
 */
function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: "'" | '"' | '`' | undefined;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === '\\') {
        if (i + 1 < source.length) out += source[++i];
      } else if (char === quote) {
        quote = undefined;
      }
      i++;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      i++;
      continue;
    }

    if (char === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out += '  ';
          i += 2;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += char;
    i++;
  }

  return out;
}

/**
 * The barrel deliberately uses semicolon-terminated module declarations.
 * Splitting only on semicolons outside strings means implementation statements
 * cannot hide behind a particular function/variable spelling.
 */
function topLevelStatements(source: string): string[] {
  const code = withoutComments(source);
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | undefined;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];

    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === ';') {
      const statement = code.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const tail = code.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function isDomainReExport(statement: string): boolean {
  const named = /^export\s+(?:type\s+)?\{[\s\S]*\}\s+from\s+(['"])\.\/actions\/[^'"]+\1$/;
  const star = /^export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+(['"])\.\/actions\/[^'"]+\1$/;
  return named.test(statement) || star.test(statement);
}

function publicBarrelReferences(source: string): string[] {
  const code = withoutComments(source);
  const pattern = /(['"`])\.\.\/actions(?:\.ts)?(?:[?#][^'"`]*)?\1/g;
  return [...code.matchAll(pattern)].map((match) => match[0]);
}

describe('action architecture boundaries', () => {
  it('domain modules never depend on the public action barrel, with or without .ts', () => {
    const files = Object.entries(domainSources);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(([fileName, source]) =>
      publicBarrelReferences(source).map((specifier) => `${fileName}: ${specifier}`),
    );

    expect(violations).toEqual([]);

    // Guard the exact bypass that prompted this regression check.
    expect(publicBarrelReferences("import { createProject } from '../actions.ts';")).toEqual(["'../actions.ts'"]);
    expect(publicBarrelReferences("type A = typeof import('../actions');")).toEqual(["'../actions'"]);
    expect(publicBarrelReferences("// import from '../actions.ts' is forbidden")).toEqual([]);
  });

  it('the public action module contains only top-level domain re-exports', () => {
    const statements = topLevelStatements(barrel);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((statement) => !isDomainReExport(statement))).toEqual([]);

    // Prove implementation shapes cannot pass merely because their spelling
    // differs from a blacklist.
    expect(
      topLevelStatements(
        "export { createProject } from './actions/projects'; const createProjectImpl = () => 1;",
      ).filter((statement) => !isDomainReExport(statement)),
    ).toEqual(['const createProjectImpl = () => 1']);

    expect(isDomainReExport("export const createProject = () => 1")).toBe(false);
  });
});
