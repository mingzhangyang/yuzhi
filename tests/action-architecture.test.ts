import { parseAst } from 'vite';
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

type Program = ReturnType<typeof parseAst>;
type Statement = Program['body'][number];

function moduleSource(statement: Statement): string | undefined {
  if (!('source' in statement)) return undefined;
  const source = statement.source;
  if (!source || typeof source !== 'object' || !('value' in source)) return undefined;
  return typeof source.value === 'string' ? source.value : undefined;
}

function isDomainReExport(statement: Statement): boolean {
  return (
    (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration')
    && moduleSource(statement)?.startsWith('./actions/') === true
  );
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
    const program = parseAst(barrel, null, 'actions.ts');
    expect(program.body.length).toBeGreaterThan(0);
    expect(program.body.filter((statement) => !isDomainReExport(statement))).toEqual([]);

    const semicolonlessBypass = parseAst(
      "export { a } from './actions/a'\nconst hidden = sideEffect()\nexport { b } from './actions/b';",
      null,
      'probe.ts',
    );
    expect(semicolonlessBypass.body.map((statement) => statement.type)).toEqual([
      'ExportNamedDeclaration',
      'VariableDeclaration',
      'ExportNamedDeclaration',
    ]);
    expect(semicolonlessBypass.body.filter((statement) => !isDomainReExport(statement))).toHaveLength(1);

    const executableExport = parseAst("export const createProject = () => 1", null, 'probe.ts');
    expect(executableExport.body.filter((statement) => !isDomainReExport(statement))).toHaveLength(1);
  });
});
