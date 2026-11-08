import { describe, expect, it } from 'vitest';

/**
 * HTML 模板里的插值必须经过 esc / t / tr，或写在下面的允许表里。
 * 允许表是当前已经审过的静态片段和返回 HTML 的内部助手。
 * 未包 esc() 的用户文字会失败，例如 `<b>${title}</b>`。
 */
const uiSources = import.meta.glob(['../src/ui/**/*.ts', '../src/main.ts'], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

interface Interp {
  expr: string;
  line: number;
}

/** 调用 esc / t / tr 的插值视为已经处理。链式 replace 也从 esc 开始。 */
function isEscapedCall(expr: string): boolean {
  return /^(esc|t|tr)\s*\(/.test(expr.trim());
}

function lineAt(source: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos; i++) if (source[i] === '\n') line++;
  return line;
}

function htmlInterpolations(source: string): Interp[] {
  const found: Interp[] = [];
  let i = 0;
  const n = source.length;

  function skipLine() {
    while (i < n && source[i] !== '\n') i++;
  }
  function skipBlock() {
    i += 2;
    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
    i = Math.min(n, i + 2);
  }
  function skipQuoted(quote: string) {
    i++;
    while (i < n) {
      if (source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source[i] === quote) {
        i++;
        return;
      }
      i++;
    }
  }

  function parseTemplate(): boolean {
    i++;
    let staticText = '';
    const local: Array<Interp & { nestedHtml: boolean }> = [];
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        staticText += source[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        break;
      }
      if (c === '$' && source[i + 1] === '{') {
        const dollar = i;
        i += 2;
        const exprStart = i;
        let depth = 1;
        let nestedHtml = false;
        while (i < n && depth > 0) {
          const d = source[i];
          if (d === '/' && source[i + 1] === '/') {
            skipLine();
            continue;
          }
          if (d === '/' && source[i + 1] === '*') {
            skipBlock();
            continue;
          }
          if (d === "'" || d === '"') {
            skipQuoted(d);
            continue;
          }
          if (d === '`') {
            if (parseTemplate()) nestedHtml = true;
            continue;
          }
          if (d === '{') {
            depth++;
            i++;
            continue;
          }
          if (d === '}') {
            depth--;
            if (depth === 0) break;
            i++;
            continue;
          }
          i++;
        }
        local.push({ expr: source.slice(exprStart, i).trim(), line: lineAt(source, dollar), nestedHtml });
        if (source[i] === '}') i++;
        continue;
      }
      staticText += c;
      i++;
    }
    const html = staticText.includes('<') || local.some((item) => item.nestedHtml);
    if (html) for (const item of local) found.push({ expr: item.expr, line: item.line });
    return html;
  }

  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      skipLine();
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      skipBlock();
      continue;
    }
    if (c === "'" || c === '"') {
      skipQuoted(c);
      continue;
    }
    if (c === '`') {
      parseTemplate();
      continue;
    }
    i++;
  }
  return found;
}

const USER_FIELD = /\.(?:title|name|text|kick|body|closeReason)\b/y;

function stripNestedTemplates(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === '`') {
      let depth = 1;
      i++;
      while (i < expr.length && depth > 0) {
        if (expr[i] === '\\') {
          i += 2;
          continue;
        }
        if (expr[i] === '`') depth--;
        else if (expr[i] === '$' && expr[i + 1] === '{') {
          let braces = 1;
          i += 2;
          while (i < expr.length && braces > 0) {
            if (expr[i] === '{') braces++;
            else if (expr[i] === '}') braces--;
            if (braces > 0) i++;
          }
        }
        i++;
      }
      out += '``';
      continue;
    }
    out += expr[i];
    i++;
  }
  return out;
}

/** 用户字段出现在 esc / t / tr 之外时，就是直接进 HTML 的原文。 */
function userFieldsOutsideEsc(expr: string): string[] {
  const source = stripNestedTemplates(expr);
  const hits: string[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const word = source.slice(start, i);
      if (source[i] === '(') stack.push(word);
      continue;
    }
    if (c === ')') {
      stack.pop();
      i++;
      continue;
    }
    if (c === '.') {
      USER_FIELD.lastIndex = i;
      const match = USER_FIELD.exec(source);
      if (match) {
        const guarded = stack.includes('esc') || stack.includes('t') || stack.includes('tr');
        if (!guarded) hits.push(match[0]);
        i = match.index + match[0].length;
        continue;
      }
    }
    i++;
  }
  return hits;
}

function unescaped(source: string, allowed: ReadonlySet<string>): string[] {
  return htmlInterpolations(source)
    .filter((item) => !isEscapedCall(item.expr) && !allowed.has(item.expr))
    .flatMap((item) => userFieldsOutsideEsc(item.expr).map((field) => `${item.line}: ${field} in ${item.expr.replace(/\s+/g, ' ').slice(0, 180)}`));
}

describe('html interpolation escaping', () => {
  it('rejects an unescaped title and accepts esc() plus a reviewed fragment', () => {
    // `<b>${item.title}</b>` 必须失败；包过 esc() 的名字和审过的片段可以通过。
    const sample = 'el.innerHTML = `<b>${item.title}</b>${esc(item.name)}${ICON.check}`;';
    expect(unescaped(sample, new Set())).toEqual(['1: .title in item.title']);
    expect(unescaped(sample, new Set(['item.title']))).toEqual([]);
  });

  it('keeps UI templates escaped or explicitly reviewed', () => {
    const violations = Object.entries(uiSources).flatMap(([file, source]) => {
      const allowed = REVIEWED.get(file.replace('../', '')) ?? new Set<string>();
      return unescaped(source, allowed).map((item) => `${file.replace('../', '')} ${item}`);
    });
    expect(violations).toEqual([]);
  });
});

/**
 * 已经看过、不是用户原文的插值。新增未转义的 title / name / text 不要加进这里，
 * 应在模板里包上 esc()。
 */
const REVIEWED = new Map<string, Set<string>>([
  ['src/ui/modal.ts', new Set([
    // 条件只决定画不画；真正写进 HTML 的 kick 在嵌套模板里经过了 esc()。
    'o.kick ? `<div class="kick">${esc(o.kick)}</div>` : \'\'',
    // openModal 的 body 由调用方拼好，用户原文在那些模板里单独经过 esc()。
    'o.body',
  ])],
  ['src/ui/tracker.ts', new Set([
    // back$() 内部对 label 调用 esc()。
    'this.back$(p ? p.name : tr(\'tracker.dock\'))',
  ])],
]);
