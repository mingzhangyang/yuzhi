/**
 * .ics 代理的核心逻辑：只转发，不保存任何数据。
 * 同时被 Cloudflare Pages Function（functions/api/ics.ts）和 Vite 开发服务器使用。
 */
export const MAX_ICS_BYTES = 5 * 1024 * 1024;

export class ProxyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

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
  if (PRIVATE_HOST.some((r) => r.test(u.hostname))) throw new ProxyError(400, '不能访问内网地址');
  return u;
}

/** 取回 .ics 文本。fetchImpl 便于测试替换。 */
export async function fetchIcsText(target: URL, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'yuzhi-ics-proxy/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProxyError(502, '日历服务器没有响应');
  }
  if (!res.ok) throw new ProxyError(502, `日历服务器返回 ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ICS_BYTES) throw new ProxyError(413, '日历文件太大');
  const text = await res.text();
  if (text.length > MAX_ICS_BYTES) throw new ProxyError(413, '日历文件太大');
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
