import { describe, expect, it } from 'vitest';
import { applyDocumentPolicy, DOCUMENT_CSP, DOCUMENT_CSP_HEADER } from '../shared/documentPolicy';

describe('document policy', () => {
  it('adds the report-only policy to HTML and leaves other responses alone', () => {
    const html = applyDocumentPolicy(new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect(html.headers.get(DOCUMENT_CSP_HEADER)).toBe(DOCUMENT_CSP);
    expect(DOCUMENT_CSP).toContain("script-src 'self'");
    expect(DOCUMENT_CSP).toContain("style-src 'self' 'unsafe-inline'");
    expect(DOCUMENT_CSP).not.toContain('unsafe-eval');

    const image = applyDocumentPolicy(new Response('png', { headers: { 'content-type': 'image/png' } }));
    expect(image.headers.get(DOCUMENT_CSP_HEADER)).toBeNull();
  });
});
