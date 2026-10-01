// MarkNote PDF Detector — v0.9.0 (investigation phase, no highlighting)
// Pure classification helpers. No DOM writes, no storage access, no chrome.*
// calls — safe to load in content scripts, popups, and unit-style checks.
// Purpose: answer "what kind of PDF context is this?" BEFORE any annotation
// work, so the extension never pretends normal webpage DOM highlighting will
// work inside Chrome's built-in PDF viewer.

(function () {
  'use strict';

  // Internal extension ID of Chrome's built-in PDF viewer (PDFium front-end).
  // Third-party extensions cannot match content scripts against another
  // extension's pages, which is exactly why this ID matters here.
  const VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

  const RESTRICTED_PREFIXES = ['chrome://', 'edge://', 'about:'];
  const UNSUPPORTED_SCHEMES = ['blob:', 'data:', 'filesystem:'];

  // kinds:
  //  direct-pdf    — top-level navigation whose path ends in .pdf (viewer-owned)
  //  chrome-viewer — an actual chrome-extension:// viewer page (not injectable)
  //  embedded      — decided only by scanEmbedded() on a normal host page
  //  web           — ordinary page (may still serve PDF MIME without .pdf name)
  //  restricted    — browser UI pages where no extension code may run
  //  special       — blob:/data:/filesystem: sources extensions cannot intercept
  //  unknown       — empty/unparseable input

  function basePath(url) {
    const s = String(url || '');
    try {
      return new URL(s).pathname.toLowerCase();
    } catch (e) {
      return s.split(/[?#]/)[0].toLowerCase();
    }
  }

  function schemeOf(url) {
    const s = String(url || '').toLowerCase();
    const idx = s.indexOf(':');
    return idx === -1 ? '' : s.slice(0, idx + 1);
  }

  function looksLikePdfPath(url) {
    return basePath(url).endsWith('.pdf');
  }

  // Classify from a tab URL alone. Never throws; never touches the DOM.
  function classifyTabUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) {
      return { kind: 'unknown', confidence: 'low', reasons: ['empty url'], needsHeaderCheck: false };
    }
    const lower = raw.toLowerCase();

    for (const prefix of RESTRICTED_PREFIXES) {
      if (lower.startsWith(prefix)) {
        return { kind: 'restricted', confidence: 'high', reasons: [`starts with ${prefix}`], needsHeaderCheck: false };
      }
    }

    if (lower.startsWith('chrome-extension://')) {
      if (lower.startsWith(`chrome-extension://${VIEWER_EXTENSION_ID}`)) {
        return { kind: 'chrome-viewer', confidence: 'high', reasons: ['built-in PDF viewer page'], needsHeaderCheck: false };
      }
      return { kind: 'restricted', confidence: 'high', reasons: ['foreign extension page'], needsHeaderCheck: false };
    }

    const scheme = schemeOf(raw);
    if (UNSUPPORTED_SCHEMES.indexOf(scheme) !== -1) {
      return { kind: 'special', confidence: 'high', reasons: [`${scheme} source`], needsHeaderCheck: false };
    }

    if (looksLikePdfPath(raw)) {
      return { kind: 'direct-pdf', confidence: 'high', reasons: ['path ends with .pdf'], needsHeaderCheck: false };
    }

    // Ordinary page. Caveat: a PDF served with Content-Type: application/pdf
    // but WITHOUT .pdf in the URL is invisible to URL sniffing — that needs a
    // header check (declarativeNetRequest, a later phase).
    return { kind: 'web', confidence: 'medium', reasons: ['no pdf path marker'], needsHeaderCheck: true };
  }

  // Read-only scan of a host page for embedded PDF frames. Returns at most
  // MAX_EMBEDDED entries: [{ tag, src }]. No DOM mutation.
  const MAX_EMBEDDED = 20;

  function scanEmbedded(root) {
    const found = [];
    try {
      const doc = root && root.querySelectorAll ? root : (typeof document !== 'undefined' ? document : null);
      if (!doc) {
        return found;
      }
      const nodes = doc.querySelectorAll('embed, object, iframe');
      for (let i = 0; i < nodes.length && found.length < MAX_EMBEDDED; i += 1) {
        const el = nodes[i];
        const src = el.getAttribute('src') || el.getAttribute('data') || '';
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (!src) {
          continue;
        }
        if (type === 'application/pdf' || looksLikePdfPath(src)) {
          found.push({ tag: el.tagName.toLowerCase(), src });
        }
      }
    } catch (e) {
      // Read-only probe must never break the host page.
    }
    return found;
  }

  // What the extension may safely do in each context. This is the contract
  // the rest of MarkNote respects: viewer-owned surfaces are hands-off.
  function capabilities(kind) {
    switch (kind) {
      case 'direct-pdf':
      case 'chrome-viewer':
        return {
          canInject: false,
          canReadDom: false,
          canModifyDom: false,
          strategy: 'extension-viewer',
          reason: 'Page is owned by the built-in PDF viewer; use the MarkNote viewer page instead.',
        };
      case 'embedded':
        return {
          canInject: true,
          canReadDom: true,
          canModifyDom: true,
          scope: 'host-page-only',
          strategy: 'web-highlight',
          reason: 'Host page is normal web; the embedded frame itself stays untouched.',
        };
      case 'web':
        return {
          canInject: true,
          canReadDom: true,
          canModifyDom: true,
          scope: 'full-page',
          strategy: 'web-highlight',
          reason: 'Ordinary webpage; existing web highlighting applies.',
        };
      default:
        return {
          canInject: false,
          canReadDom: false,
          canModifyDom: false,
          strategy: 'none',
          reason: `Unsupported context (${kind}); do nothing.`,
        };
    }
  }

  const scope = typeof globalThis !== 'undefined' ? globalThis : this;
  scope.MarkNotePdf = {
    VIEWER_EXTENSION_ID,
    classifyTabUrl,
    scanEmbedded,
    capabilities,
    looksLikePdfPath,
  };
})();
