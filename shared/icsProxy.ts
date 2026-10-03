/**
 * .ics 代理的核心逻辑：只转发，不保存任何数据。
 * 同时被 Cloudflare Worker（worker/index.ts）、Pages Function（functions/api/ics.ts）和 Vite 开发服务器使用。
 */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;

export class ProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 内网和特殊用途的主机名 */
const PRIVATE_NAME = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i, /^metadata\.google\.internal$/i];

/** 解析点分十进制 IPv4；不是 IPv4 时返回 null（URL 会把 0x7f.1、2130706433 之类规范成点分形式） */
function parseIPv4(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((x) => x <= 255) ? parts : null;
}

/** 不可从公网访问的 IPv4：本机、内网、链路本地、运营商 NAT、保留、组播等 */
export function isPrivateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** 把 IPv6 文本（URL 已规范化，可能含 :: 和末尾的点分 IPv4）展开成 8 个 16 位整数 */
function parseIPv6(h: string): number[] | null {
  let s = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (!s.includes(':')) return null;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const p = parseIPv4(v4[1]);
    if (!p) return null;
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return null;
  const hs = head ? head.split(':') : [];
  const ts = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - hs.length - ts.length;
  if (fill < 0 || (tail === undefined && hs.length !== 8)) return null;
  const groups = [...hs, ...Array(fill).fill('0'), ...ts].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

export function isPrivateIPv6(g: number[]): boolean {
  const embedded = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地（已废弃）
  if ((g[0] & 0xff00) === 0xff00) return true; // 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 文档用途
  // IPv4 映射 / 兼容地址（::ffff:a.b.c.d、::a.b.c.d）和 NAT64（64:ff9b::/96）里嵌着的 IPv4
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIPv4(embedded());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIPv4(embedded());
  // 6to4（2002::/16）里嵌着的 IPv4
  if (g[0] === 0x2002) return isPrivateIPv4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]);
  return false;
}

/** 主机是否指向内网或特殊地址。按规范解析，而不是靠字符串匹配 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h || PRIVATE_NAME.some((r) => r.test(h))) return true;
  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (h.startsWith('[') || h.includes(':')) {
    const v6 = parseIPv6(h);
    return v6 ? isPrivateIPv6(v6) : true; // 解析不了的 IPv6 一律拒绝
  }
  // 只由数字和点组成、却不是合法 IPv4 的主机名，拒绝
  return /^[\d.]+$/.test(h);
}

/** 校验并规范化用户给的订阅链接；webcal:// 视为 https:// */
export function normalizeIcsUrl(raw: string | null): URL {
  if (!raw) throw new ProxyError(400, '缺少 url 参数');
  let s = raw.trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:/i, 'https:');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ProxyError(400, '链接格式不对');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ProxyError(400, '只支持 http、https 或 webcal 链接');
  if (u.username || u.password) throw new ProxyError(400, '链接里不能带用户名和密码');
  if (isPrivateHost(u.hostname)) throw new ProxyError(400, '不能访问内网地址');
  return u;
}

const MAX_REDIRECTS = 5;

/** 读响应体，超过上限立刻停止，不把整个大文件读进内存 */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ICS_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ProxyError(413, '日历文件太大');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * 取回 .ics 文本。重定向手动跟随，每一跳都重新校验地址，避免被重定向到内网。
 * fetchImpl 便于测试替换。
 */
export async function fetchIcsText(target: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url = target;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await fetchImpl(url.toString(), {
        headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'yuzhi-ics-proxy/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ProxyError(502, '日历服务器没有响应');
    }
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get('location');
    if (!loc) throw new ProxyError(502, '日历服务器的重定向缺少地址');
    if (hop === MAX_REDIRECTS) throw new ProxyError(502, '重定向次数太多');
    let next: URL;
    try {
      next = new URL(loc, url);
    } catch {
      throw new ProxyError(502, '日历服务器重定向到了无效地址');
    }
    url = normalizeIcsUrl(next.toString());
  }
  if (!res || !res.ok) throw new ProxyError(502, `日历服务器返回 ${res?.status ?? '错误'}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ICS_BYTES) throw new ProxyError(413, '日历文件太大');
  const text = await readCapped(res);
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new ProxyError(422, '这个链接返回的不是日历（.ics）内容');
  return text;
}

export async function handleIcsRequest(requestUrl: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  try {
    const target = normalizeIcsUrl(new URL(requestUrl).searchParams.get('url'));
    const text = await fetchIcsText(target, fetchImpl);
    return new Response(text, { status: 200, headers: { ...headers, 'content-type': 'text/calendar; charset=utf-8' } });
  } catch (e) {
    const status = e instanceof ProxyError ? e.status : 500;
    const message = e instanceof ProxyError ? e.message : '代理出错了';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
