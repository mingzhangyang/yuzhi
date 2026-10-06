# Production acceptance

This is the release gate for the deployed Yuzhi application at
`https://yuzhi.orangely.xyz`. It is intentionally separate from normal PR CI:
Cloudflare builds and deploys `main` independently, so a green local/PR preview
does not prove that the public origin is serving the reviewed release.

## Release procedure

1. Merge the release PR to `main` and wait for the Cloudflare production build
   to finish.
2. Dispatch the **Production acceptance** workflow from the `main` branch.
   Dispatching another ref is rejected.
3. The workflow requests the revision-addressed build marker for its exact
   `github.sha`. Cloudflare Workers Builds injects `WORKERS_CI_COMMIT_SHA`
   and `WORKERS_CI_BRANCH` during the build, and `npm run build` emits those
   values into `dist/__yuzhi-build/`. A stale deployment therefore cannot pass
   acceptance merely because its behavior still looks compatible.
4. Treat that workflow run as the authoritative evidence for that exact
   deployment. Do not call the release closed while any assertion is failing.

The workflow verifies raw pre-JavaScript HTML for both locale URLs, canonical and
`hreflang` links, manifests, sitemap/robots, Open Graph/Twitter metadata,
localized social artwork, browser-language selection, explicit URL precedence,
locale persistence, mobile/desktop overflow, and the existing creation/history/
single-writer lifecycle invariants. Screenshots are retained as a short-lived
artifact for visual inspection.

A real iPhone Safari sanity pass remains useful before a major public launch.
The automated mobile focus smoke protects the known >=16px input and
keyboard-like viewport invariants, but Chromium emulation is not Safari.

## Localized image policy

Locale is a presentation concern, so an image is split only when the image itself
carries language-specific meaning.

| Asset | Locale policy | Reason |
| --- | --- | --- |
| Open Graph / Twitter social artwork | Per locale | The artwork contains product copy and is seen outside the app UI. |
| Marketing screenshots containing UI text | Per locale | Embedded UI text should match the linked locale. |
| Logo mark, favicon, app icon, Apple touch icon | Shared | These are language-neutral brand identity. |
| Textless decorative/island artwork | Shared | Duplicating it adds maintenance cost without changing meaning. |
| Web manifest icons | Shared | Manifest name/description/start URL can localize; the icon identity does not. |

The locale metadata table in `shared/locale.ts` owns social-image selection.
Both `/` and `/en/` run through the same Worker HTML rewriter before they
reach crawlers, while runtime language changes use the same policy in the
browser. Twitter/Open Graph and JSON-LD therefore derive the production image
URL from one policy even though `index.html` retains Chinese fallback values
for non-Worker development/static contexts. Do not add another production
metadata path outside this policy.

Chinese/default sharing keeps `/brand/yuzhi-og.jpg`. English uses
`/brand/yuzhi-og-en.png`. Other language-neutral brand assets remain shared.
