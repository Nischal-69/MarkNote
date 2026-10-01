# MarkNote PDF Architecture — v0.9.0 (investigation phase)

> Status: architecture + detection only. **No PDF highlighting is implemented yet.**
> The existing web highlighting/storage system is untouched.

## 1. Findings: the Chrome PDF environment

When Chrome opens a PDF directly (e.g. `https://example.com/paper.pdf`), the tab
is rendered by Chrome's **built-in PDF viewer**, which runs as a private,
hard-coded extension (`mhjfbmdgcfjbbpaeojofohoefgiehjai`, PDFium front-end):

- The host page is an `<embed>` shell — the document, pages, and text live
  inside the viewer extension's own DOM.
- Third-party extensions **cannot** declare content scripts against another
  extension's pages (`chrome-extension://<other-id>/*` never matches), and the
  viewer's DOM is not scriptable from our content scripts.
- Pretending normal webpage DOM highlighting (`<mark>` wrapping via the
  Selection API) will work there would be a hack — so MarkNote explicitly does
  not try. Viewer-owned surfaces are hands-off by contract
  (see `capabilities()` in `pdf-detector.js`).

## 2. PDF contexts MarkNote distinguishes

| # | Context | Example | Extension access |
|---|---------|---------|------------------|
| 1 | **Direct PDF URL** | `https://…/paper.pdf` (path ends `.pdf`) | None — viewer-owned. Detect via tab URL. |
| 2 | **Built-in viewer page** | `chrome-extension://mhjfbmdg…/…` | None — not injectable, not matchable. |
| 3 | **Embedded PDF** | `<embed>/<object>/<iframe src="….pdf">` inside a normal page | Host page is normal web (web highlighting works around it); the embedded frame itself is untouched. Detected by a read-only DOM scan. |
| 4 | **PDF without `.pdf` name** | `/download?id=123` served as `application/pdf` | Invisible to URL sniffing — needs a response-header check (later phase). |
| 5 | **Restricted / special** | `chrome://`, Web Store, `blob:`, `data:` | No extension code may run / cannot be intercepted. |

Implemented in `pdf/pdf-detector.js` (pure functions, no DOM writes):
`classifyTabUrl(url)` → kinds `direct-pdf | chrome-viewer | embedded* |
web | restricted | special | unknown` (+ `needsHeaderCheck` flag);
`scanEmbedded(document)` → read-only list of embedded PDF frames;
`capabilities(kind)` → the inject/read/modify contract the rest of the
extension respects. (\* `embedded` is concluded only when the scan finds frames.)

## 3. Permissions: now vs later

- **This phase needs nothing new.** Detection uses only the active tab's URL
  (already visible via `activeTab`) plus a read-only DOM query. Manifest
  permissions are unchanged: `activeTab, scripting, storage, clipboardWrite`
  with `<all_urls>` host access.
- **Viewer phase will need:** bundled PDF.js assets (no new permission),
  `webNavigation` and/or `declarativeNetRequest` (+ `declarativeNetRequestWithHostAccess`)
  to reliably intercept direct PDFs including MIME-without-extension cases,
  and the user's opt-in for `file://` URLs (Chrome never grants that silently).

## 4. Chosen architecture (phases)

- **Phase A — done (v0.9.0):** `pdf/pdf-detector.js` classification +
  `MARKNOTE_PDF_SCAN` read-only probe + popup PDF states + PDF storage
  metadata (`docId`, `pdfUrl`, `pageNumber`, types `pdf-highlight`/`pdf-note`).
- **Phase B — next:** an **extension-owned viewer page** (`pdf/viewer.html`)
  bundling PDF.js. PDF tabs are routed there (redirect/intercept + an
  "Open in MarkNote" entry point). Because the viewer DOM is ours, text-layer
  selection and highlight overlays work exactly like the web system, anchored
  by `{ docId, pageNumber, selectedText, surroundingText }`.
- **Phase C — later:** restore/share flows reuse the existing
  `saveAnnotation/getAnnotations/updateAnnotation/deleteAnnotation` helpers
  and the 7-day expiry unchanged.

The web pipeline (`content/`, web annotation types, restore matching) is
frozen and shared only through storage helpers — never modified for PDF.

## 5. PDF annotation metadata (stored, not yet written by any UI)

```json
{
  "id": "mn-...",
  "type": "pdf-highlight | pdf-note",
  "docId": "pdf-<sha256 of normalized pdf url>",
  "pdfUrl": "https://... (no #hash)",
  "url": "https://... (same as pdfUrl)",
  "pageTitle": "...",
  "pageNumber": 3,
  "selectedText": "...",
  "surroundingText": "...",
  "note": "",
  "highlightColor": "yellow",
  "createdAt": 123,
  "expiresAt": 123
}
```

`pdfDocumentId()` / `buildPdfAnnotation()` (in `storage/storage.js`) produce
this shape. `docId` is timestamp-independent: the same document always maps
to the same id. `pageNumber` is 1-based or `null`. Web annotations carry
empty `docId`/`pdfUrl`/`pageNumber`, and edits never move anchors or timers.

## 6. Chrome limitations (do not work around with hacks)

- No content scripts, scripting, or DOM access inside the built-in viewer.
- `blob:`/`data:`/`filesystem:` PDF sources cannot be intercepted by extensions.
- Cross-origin PDF fetches are subject to CORS; some servers refuse them.
- Re-fetched POST-based PDFs lose their request body; attachments with
  `Content-Disposition: attachment` may download instead of rendering.
- `file://` PDFs require the user to enable "Allow access to file URLs".
- `chrome://`, Web Store, and other restricted pages remain fully off-limits.

## 7. Verification checklist for this phase

- [ ] New tab on `https://…/*.pdf` → popup shows `PDF` pill, Activate disabled,
      note "PDF annotation arrives in a later batch".
- [ ] Normal page → popup behaves exactly as v0.8.0 (Activate works, counts live).
- [ ] Page with an embedded PDF → popup notes the embedded document, Activate stays enabled.
- [ ] `node --check` clean on `pdf/pdf-detector.js`, `storage/storage.js`,
      `content/content.js`, `popup/popup.js`.
- [ ] Detector spot-checks: `.pdf?query`, uppercase `.PDF`, viewer URL,
      `chrome://`, `blob:` classify as documented.
