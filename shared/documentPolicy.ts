/** 生产 HTML 的报告型 CSP。强制执行留到生产验收确认没有违规之后。 */
export const DOCUMENT_CSP_HEADER = 'content-security-policy-report-only';

export const DOCUMENT_CSP = [
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** 只给 HTML 文档加策略。日历代理和静态图片保持原响应头。 */
export function applyDocumentPolicy(response: Response): Response {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.set(DOCUMENT_CSP_HEADER, DOCUMENT_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
