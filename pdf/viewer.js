// MarkNote PDF Viewer — v0.10.0 extension-owned viewer (PDF.js, vendored).
// Own DOM: canvas + selectable text layer per page. No hacks against the
// built-in viewer; web highlighting/storage/expiry logic is untouched.
// Annotations persist via shared MarkNoteStorage (docId-anchored, 7-day TTL).

(function () {
  'use strict';

  const SCALE = 1.4;
  const HIGHLIGHT_CLASS = 'marknote-highlight';
  const MARKER_CLASS = 'marknote-note-marker';

  const params = new URLSearchParams(location.search);
  const pdfUrl = params.get('file') || '';

  const docTitleEl = document.getElementById('docTitle');
  const pageIndicator = document.getElementById('pageIndicator');
  const pill = document.getElementById('viewerPill');
  const pillText = document.getElementById('viewerPillText');
  const activateBtn = document.getElementById('viewerActivateBtn');
  const errorEl = document.getElementById('viewerError');
  const statusEl = document.getElementById('viewerStatus');
  const pagesEl = document.getElementById('pages');
  const toolbarEl = document.getElementById('marknote-pdf-toolbar');
  const highlightBtn = document.getElementById('pdf-highlight-btn');
  const noteBtn = document.getElementById('pdf-note-btn');
  const panelEl = document.getElementById('marknote-pdf-panel');

  let pdfDoc = null;
  let numPages = 0;
  let docId = '';
  let pageTitle = '';
  let isActive = false;
  let isRestoring = false;
  let lastRange = null;
  let lastRect = null;
  let panelMode = 'closed';
  let panelNoteId = null;
  let pendingPreview = '';
  let statusTimer = null;
  const rendered = new Set();
  const notes = new Map();

  boot().catch((err) => showError(`Could not open this PDF. ${err && err.message ? err.message : err}`));

  async function boot() {
    if (!pdfUrl) {
      throw new Error('No PDF file specified (?file= is missing).');
    }
    const pdfjsLib = globalThis.pdfjsLib;
    if (!pdfjsLib) {
      throw new Error('PDF engine failed to load.');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

    let data;
    try {
      const res = await fetch(pdfUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      data = await res.arrayBuffer();
    } catch (err) {
      throw new Error(
        'The file could not be fetched. ' +
        (pdfUrl.startsWith('file:') ? 'For local files, enable “Allow access to file URLs” for MarkNote at chrome://extensions. ' : '') +
        `(${err && err.message ? err.message : err})`
      );
    }

    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    numPages = pdfDoc.numPages;
    pageTitle = fileName(pdfUrl);
    docTitleEl.textContent = pageTitle;
    document.title = `${pageTitle} — MarkNote PDF`;

    const store = globalThis.MarkNoteStorage;
    docId = store ? await store.pdfDocumentId(pdfUrl) : `pdf-local-${Date.now().toString(36)}`;

    await buildShells();
    wireUi();
    observePages();
    console.log(`[MarkNote] PDF viewer ready: ${numPages} page(s), docId ${docId.slice(0, 18)}…`);
  }

  function fileName(url) {
    try {
      const path = new URL(url).pathname;
      const name = decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
      if (name) {
        return name;
      }
    } catch (e) {
      // fall through
    }
    return 'Document';
  }

  // ---------- Page shells + rendering ----------

  async function buildShells() {
    for (let n = 1; n <= numPages; n += 1) {
      const page = await pdfDoc.getPage(n);
      const viewport = page.getViewport({ scale: SCALE });
      const shell = document.createElement('div');
      shell.className = 'pdf-page';
      shell.dataset.pageNumber = String(n);
      shell.style.width = `${viewport.width}px`;
      shell.style.height = `${viewport.height}px`;
      pagesEl.appendChild(shell);
    }
    pageIndicator.textContent = `Page 1 of ${numPages}`;
  }

  function observePages() {
    const visible = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const n = Number(entry.target.dataset.pageNumber);
        if (entry.isIntersecting) {
          visible.add(n);
          renderPage(n).catch((err) => console.warn('[MarkNote] Page render failed:', err));
        } else {
          visible.delete(n);
        }
      }
      if (visible.size > 0) {
        pageIndicator.textContent = `Page ${Math.min(...visible)} of ${numPages}`;
      }
    }, { rootMargin: '400px' });
    pagesEl.querySelectorAll('.pdf-page').forEach((shell) => io.observe(shell));
  }

  async function ensureRendered(n) {
    if (!rendered.has(n)) {
      await renderPage(n);
    }
  }

  async function renderPage(n) {
    if (rendered.has(n)) {
      return;
    }
    rendered.add(n); // mark early; failures delete below so a retry can occur.
    const shell = pagesEl.querySelector(`.pdf-page[data-page-number="${n}"]`);
    if (!shell) {
      rendered.delete(n);
      return;
    }
    try {
      const page = await pdfDoc.getPage(n);
      const viewport = page.getViewport({ scale: SCALE });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      shell.appendChild(canvas);
      await page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      }).promise;

      const layer = document.createElement('div');
      layer.className = 'pdf-textlayer';
      const textContent = await page.getTextContent();
      const Util = globalThis.pdfjsLib.Util;
      for (const item of textContent.items) {
        if (!item.str) {
          continue;
        }
        const tx = Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
        if (!Number.isFinite(fontHeight) || fontHeight <= 0) {
          continue;
        }
        const span = document.createElement('span');
        span.textContent = item.str + (item.hasEOL ? ' ' : '');
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight}px`;
        span.style.fontSize = `${fontHeight}px`;
        const scaleX = tx[0] / fontHeight;
        if (Number.isFinite(scaleX) && scaleX > 0.3 && scaleX < 5) {
          span.style.transform = `scaleX(${scaleX})`;
        }
        layer.appendChild(span);
      }
      shell.appendChild(layer);
    } catch (err) {
      rendered.delete(n);
      throw err;
    }
  }

  // ---------- Activation (mirrors web: restore only after activation) ----------

  function wireUi() {
    activateBtn.addEventListener('click', () => {
      if (isActive) {
        deactivate();
      } else {
        activate().catch((err) => console.warn('[MarkNote] PDF activate failed:', err));
      }
    });

    toolbarEl.addEventListener('mousedown', (e) => e.preventDefault());
    highlightBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyHighlight().catch((err) => console.warn('[MarkNote] PDF highlight failed:', err));
    });
    noteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNoteEditor();
    });
    panelEl.addEventListener('mouseup', (e) => e.stopPropagation());

    document.addEventListener('mousedown', (e) => {
      if (!isActive || isMarkNoteUi(e.target)) {
        return;
      }
      hideToolbar();
    });
    pagesEl.addEventListener('mouseup', (e) => {
      if (!isActive || isMarkNoteUi(e.target)) {
        return;
      }
      setTimeout(handleSelection, 10);
    });
    document.addEventListener('keyup', (e) => {
      if (!isActive || isMarkNoteUi(e.target)) {
        return;
      }
      handleSelection();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelMode !== 'closed') {
        hidePanel();
      }
    });
  }

  async function activate() {
    if (isActive || isRestoring) {
      return;
    }
    isActive = true;
    pill.classList.add('is-active');
    pillText.textContent = 'Active';
    activateBtn.textContent = 'Deactivate';
    await restoreSaved();
  }

  function deactivate() {
    isActive = false;
    lastRange = null;
    lastRect = null;
    hideToolbar();
    hidePanel();
    clearSelection();
    pill.classList.remove('is-active');
    pillText.textContent = 'Idle';
    activateBtn.textContent = 'Activate MarkNote';
    console.log('[MarkNote] PDF mode deactivated. Highlights kept on page.');
  }

  // ---------- Selection + toolbar ----------

  function handleSelection() {
    if (!isActive || panelMode !== 'closed') {
      hideToolbar();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideToolbar();
      return;
    }
    const text = sel.toString();
    if (!text || !text.trim()) {
      hideToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (isRangeInUi(range) || !isRangeInPages(range)) {
      hideToolbar();
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideToolbar();
      return;
    }
    try {
      lastRange = range.cloneRange();
      lastRect = rect;
    } catch (err) {
      hideToolbar();
      return;
    }
    showToolbarNear(rect);
  }

  function showToolbarNear(rect) {
    toolbarEl.style.display = 'flex';
    toolbarEl.style.visibility = 'hidden';
    const w = toolbarEl.offsetWidth || 220;
    const h = toolbarEl.offsetHeight || 40;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.top - h - 10;
    if (top < 60) {
      top = rect.bottom + 10; // keep clear of the sticky viewer bar
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(56, Math.min(top, window.innerHeight - h - 8));
    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;
    toolbarEl.style.visibility = 'visible';
  }

  function hideToolbar() {
    toolbarEl.style.display = 'none';
  }

  // ---------- Highlight + note (persisted like web) ----------

  function pageNumberOf(range) {
    const el = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const page = el && el.closest ? el.closest('.pdf-page') : null;
    return page ? Number(page.dataset.pageNumber) : null;
  }

  function textNodesInRange(range) {
    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        try {
          if (!range.intersectsNode(node)) {
            return NodeFilter.FILTER_SKIP;
          }
        } catch (e) {
          return NodeFilter.FILTER_REJECT;
        }
        return isWrappable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let cur;
    while ((cur = walker.nextNode())) {
      nodes.push(cur);
    }
    return nodes;
  }

  function isWrappable(node) {
    if (!node || !node.nodeValue || !node.nodeValue.trim()) {
      return false;
    }
    const parent = node.parentElement;
    if (!parent || !parent.closest('.pdf-textlayer')) {
      return false;
    }
    if (parent.closest(`.${HIGHLIGHT_CLASS}, [data-marknote]`)) {
      return false;
    }
    return true;
  }

  function wrapSlice(node, start, end, attrs) {
    if (start >= end) {
      return null;
    }
    const slice = node.nodeValue.slice(start, end);
    if (!slice || !slice.trim()) {
      return null;
    }
    let target = node;
    if (start > 0) {
      target = target.splitText(start);
      end -= start;
    }
    if (end < target.length) {
      target.splitText(end);
    }
    const mark = document.createElement('mark');
    mark.className = HIGHLIGHT_CLASS;
    mark.setAttribute('data-marknote', 'highlight');
    if (attrs) {
      if (attrs.noteId) {
        mark.dataset.noteId = attrs.noteId;
      }
      if (attrs.annotationId) {
        mark.dataset.annotationId = attrs.annotationId;
      }
    }
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    return mark;
  }

  function wrapRangeNodes(range, attrs) {
    const nodes = textNodesInRange(range);
    const created = [];
    for (const node of nodes) {
      let start = 0;
      let end = node.length;
      if (node === range.startContainer && node === range.endContainer) {
        start = range.startOffset;
        end = range.endOffset;
      } else if (node === range.startContainer) {
        start = range.startOffset;
      } else if (node === range.endContainer) {
        end = range.endOffset;
      }
      const mark = wrapSlice(node, start, end, attrs);
      if (mark) {
        created.push(mark);
      }
    }
    return created;
  }

  function surroundingOf(range, selected) {
    try {
      const page = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
      ).closest('.pdf-page');
      const full = (page ? page.textContent : '').replace(/\s+/g, ' ').trim();
      const needle = (selected || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const idx = needle ? full.indexOf(needle) : -1;
      if (idx === -1) {
        return full.slice(0, 400);
      }
      return full.slice(Math.max(0, idx - 160), idx + needle.length + 160);
    } catch (e) {
      return '';
    }
  }

  async function persistSelection(range, noteText, kind) {
    const store = globalThis.MarkNoteStorage;
    const raw = range.toString();
    const pageNumber = pageNumberOf(range);
    if (!pageNumber) {
      throw new Error('Selection is outside any PDF page.');
    }
    if (!store) {
      throw new Error('Storage helper missing.');
    }
    const built = await store.buildPdfAnnotation({
      type: kind === 'note' ? 'pdf-note' : 'pdf-highlight',
      pdfUrl,
      pageTitle,
      pageNumber,
      selectedText: raw.trim(),
      surroundingText: surroundingOf(range, raw),
      note: noteText || '',
    });
    // buildPdfAnnotation derives the same stable docId; assert agreement.
    if (built.docId !== docId) {
      console.warn('[MarkNote] docId mismatch; using stored value.');
    }
    return store.saveAnnotation(built);
  }

  async function applyHighlight() {
    if (!lastRange) {
      hideToolbar();
      return;
    }
    const range = lastRange;
    try {
      if (!range.commonAncestorContainer.isConnected) {
        return;
      }
      const saved = await persistSelection(range, '', 'highlight');
      const marks = wrapRangeNodes(range, { annotationId: saved.id });
      console.log(`[MarkNote] PDF highlighted ${marks.length} node(s) on page ${saved.pageNumber}.`);
    } finally {
      hideToolbar();
      lastRange = null;
      lastRect = null;
      clearSelection();
    }
  }

  // ---------- Note editor / viewer (viewer-local panel) ----------

  function openNoteEditor() {
    if (!lastRange) {
      hideToolbar();
      return;
    }
    const raw = lastRange.toString();
    if (!raw || !raw.trim() || !pageNumberOf(lastRange)) {
      hideToolbar();
      return;
    }
    pendingPreview = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    const rect = lastRect && lastRect.width ? lastRect : lastRange.getBoundingClientRect();
    hideToolbar();
    panelMode = 'create';
    panelNoteId = null;
    renderPanel(
      '📝 New note',
      pendingPreview,
      '',
      [
        { label: 'Save', cls: 'pp-save', onClick: (ta) => saveNoteEditor(ta.value) },
        { label: 'Cancel', cls: '', onClick: () => { hidePanel(); lastRange = null; clearSelection(); } },
      ],
      true,
      rect
    );
  }

  async function saveNoteEditor(value) {
    const noteText = (value || '').trim();
    if (!noteText || !lastRange) {
      return;
    }
    const range = lastRange;
    const preview = range.toString().replace(/\s+/g, ' ').trim().slice(0, 200);
    const saved = await persistSelection(range, noteText, 'note');
    const marks = wrapRangeNodes(range, { noteId: saved.id, annotationId: saved.id });
    anchorMarker(createMarker(saved.id), marks);
    notes.set(saved.id, { id: saved.id, selectedText: preview, noteText });
    hidePanel();
    hideToolbar();
    lastRange = null;
    lastRect = null;
    clearSelection();
    console.log('[MarkNote] PDF note saved.');
  }

  function renderPanel(title, preview, noteText, buttons, editable, rect) {
    panelEl.innerHTML = '';
    const t = document.createElement('div');
    t.className = 'pp-title';
    t.textContent = title;
    const sel = document.createElement('div');
    sel.className = 'pp-selected';
    sel.textContent = `Selected: “${preview}”`;
    panelEl.appendChild(t);
    panelEl.appendChild(sel);

    let ta = null;
    if (editable) {
      ta = document.createElement('textarea');
      ta.placeholder = 'Write your note...';
      ta.value = noteText || '';
      panelEl.appendChild(ta);
    } else if (noteText) {
      const body = document.createElement('div');
      body.className = 'pp-note';
      body.textContent = noteText;
      panelEl.appendChild(body);
    }

    const row = document.createElement('div');
    row.className = 'pp-actions';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      if (b.cls) {
        btn.className = b.cls;
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        b.onClick(ta);
      });
      row.appendChild(btn);
    }
    panelEl.appendChild(row);

    panelEl.style.display = 'block';
    panelEl.style.visibility = 'hidden';
    const w = panelEl.offsetWidth || 300;
    const h = panelEl.offsetHeight || 200;
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) {
      top = rect.top - h - 10;
    }
    panelEl.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    panelEl.style.top = `${Math.max(56, Math.min(top, window.innerHeight - h - 8))}px`;
    panelEl.style.visibility = 'visible';
    if (ta) {
      setTimeout(() => ta.focus(), 0);
    }
  }

  function hidePanel() {
    panelMode = 'closed';
    panelNoteId = null;
    pendingPreview = '';
    panelEl.style.display = 'none';
    panelEl.innerHTML = '';
  }

  function showNote(noteId) {
    const note = notes.get(noteId);
    if (!note) {
      return;
    }
    panelMode = 'view';
    panelNoteId = noteId;
    const rect = markerRect(noteId) || { left: window.innerWidth / 2, top: 120, bottom: 130, width: 0 };
    renderPanel(
      '📝 Note',
      note.selectedText,
      note.noteText,
      [
        {
          label: 'Edit', cls: 'pp-save', onClick: () => {
            panelMode = 'edit';
            renderPanel(
              '📝 Edit note',
              note.selectedText,
              note.noteText,
              [
                {
                  label: 'Save', cls: 'pp-save', onClick: async (ta) => {
                    const next = (ta.value || '').trim();
                    if (!next) {
                      return;
                    }
                    await globalThis.MarkNoteStorage.updateAnnotation(noteId, { note: next });
                    note.noteText = next;
                    notes.set(noteId, note);
                    showNote(noteId);
                  },
                },
                { label: 'Cancel', cls: '', onClick: () => showNote(noteId) },
              ],
              true,
              rect
            );
          },
        },
        {
          label: 'Delete', cls: 'pp-delete', onClick: async () => {
            await deleteNote(noteId);
          },
        },
        { label: 'Close', cls: '', onClick: () => hidePanel() },
      ],
      false,
      rect
    );
  }

  async function deleteNote(noteId) {
    await globalThis.MarkNoteStorage.deleteAnnotation(noteId);
    const marker = pagesEl.querySelector(`.${MARKER_CLASS}[data-note-id="${CSS.escape(noteId)}"]`);
    if (marker) {
      marker.remove();
    }
    pagesEl.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-note-id="${CSS.escape(noteId)}"]`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) {
        return;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.remove();
      parent.normalize();
    });
    notes.delete(noteId);
    hidePanel();
  }

  function createMarker(noteId) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = MARKER_CLASS;
    marker.setAttribute('data-marknote', 'note-marker');
    marker.dataset.noteId = noteId;
    marker.dataset.annotationId = noteId;
    marker.textContent = '📝';
    marker.title = 'View note';
    marker.setAttribute('aria-label', 'View note');
    marker.addEventListener('mousedown', (e) => e.preventDefault());
    marker.addEventListener('mouseup', (e) => e.stopPropagation());
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      showNote(noteId);
    });
    return marker;
  }

  function anchorMarker(marker, marks) {
    if (marks.length > 0) {
      const last = marks[marks.length - 1];
      last.parentNode.insertBefore(marker, last.nextSibling);
    }
  }

  function markerRect(noteId) {
    const marker = pagesEl.querySelector(`.${MARKER_CLASS}[data-note-id="${CSS.escape(noteId)}"]`);
    if (!marker) {
      return null;
    }
    const rect = marker.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0 ? null : rect;
  }

  // ---------- Restore on activation ----------

  async function restoreSaved() {
    const store = globalThis.MarkNoteStorage;
    if (!store || isRestoring) {
      return;
    }
    isRestoring = true;
    let restored = 0;
    let unavailable = 0;
    try {
      const swept = await store.purgeExpired();
      if (swept.purged > 0) {
        console.log(`[MarkNote] Removed ${swept.purged} expired annotation(s).`);
      }
      const mine = (await store.getAnnotations(pdfUrl)).filter((a) => a.docId === docId);
      for (const a of mine.slice(0, 500)) {
        try {
          const outcome = await restoreOne(a);
          if (outcome === true) {
            restored += 1;
          } else if (outcome === false) {
            unavailable += 1;
          }
          // 'skipped' (already rendered) counts toward neither.
        } catch (err) {
          unavailable += 1;
          console.warn('[MarkNote] PDF restore failed for one annotation:', err);
        }
      }
    } catch (err) {
      console.warn('[MarkNote] PDF restore read failed:', err);
    } finally {
      isRestoring = false;
      clearSelection();
    }
    if (restored > 0) {
      flash(`${restored} saved annotation${restored === 1 ? '' : 's'} restored`);
    } else if (unavailable > 0) {
      console.log(`[MarkNote] No PDF annotations restored (${unavailable} unavailable, kept stored).`);
    }
  }

  function alreadyRendered(id) {
    try {
      return !!pagesEl.querySelector(`[data-annotation-id="${CSS.escape(id)}"]`);
    } catch (e) {
      return false;
    }
  }

  async function restoreOne(a) {
    if (!a || !a.selectedText || !a.selectedText.trim() || !a.pageNumber) {
      return false;
    }
    if (alreadyRendered(a.id)) {
      return 'skipped'; // idempotent: re-activation never duplicates or recounts.
    }
    const shell = pagesEl.querySelector(`.pdf-page[data-page-number="${a.pageNumber}"]`);
    if (!shell) {
      return false;
    }
    await ensureRendered(a.pageNumber);
    const isNote = a.type === 'pdf-note' || !!a.note;
    const slices = findInPage(shell, a.selectedText.trim());
    if (slices.length === 0) {
      console.warn(`[MarkNote] PDF annotation unavailable (kept stored): ${a.id}`);
      return false;
    }
    const marks = [];
    for (const s of slices) {
      const mark = wrapSlice(s.node, s.start, s.end, {
        noteId: isNote ? a.id : undefined,
        annotationId: a.id,
      });
      if (mark) {
        marks.push(mark);
      }
    }
    if (marks.length === 0) {
      return false;
    }
    if (isNote) {
      notes.set(a.id, {
        id: a.id,
        selectedText: a.selectedText.replace(/\s+/g, ' ').trim().slice(0, 200),
        noteText: a.note || '',
      });
      anchorMarker(createMarker(a.id), marks);
    }
    return true;
  }

  // Locate needle across a page's text nodes. Exact first, then
  // whitespace/case-tolerant matching with offsets mapped back.
  function pageTextNodes(shell) {
    const nodes = [];
    const walker = document.createTreeWalker(shell, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !parent.closest('.pdf-textlayer')) {
          return NodeFilter.FILTER_SKIP;
        }
        if (parent.closest(`.${HIGHLIGHT_CLASS}, [data-marknote], .${MARKER_CLASS}`)) {
          return NodeFilter.FILTER_SKIP;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let cur;
    while ((cur = walker.nextNode())) {
      nodes.push(cur);
    }
    return nodes;
  }

  function findInPage(shell, needle) {
    const nodes = pageTextNodes(shell);
    if (nodes.length === 0) {
      return [];
    }
    const concat = nodes.map((n) => n.nodeValue).join('');
    let start = concat.indexOf(needle);
    let end = start === -1 ? -1 : start + needle.length;
    if (start === -1) {
      const norm = normalizeWithMap(concat);
      const nNeedle = needle.replace(/\s+/g, ' ').trim().toLowerCase();
      const idx = norm.text.indexOf(nNeedle);
      if (idx === -1) {
        return [];
      }
      start = norm.map[idx];
      end = idx + nNeedle.length < norm.map.length ? norm.map[idx + nNeedle.length] : concat.length;
    }
    const slices = [];
    let offset = 0;
    for (const node of nodes) {
      const ns = offset;
      const ne = offset + node.length;
      if (ne > start && ns < end) {
        slices.push({ node, start: Math.max(0, start - ns), end: Math.min(node.length, end - ns) });
      }
      offset = ne;
    }
    return slices;
  }

  function normalizeWithMap(s) {
    let text = '';
    const map = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (/\s/.test(c)) {
        if (text.length > 0 && text[text.length - 1] !== ' ') {
          text += ' ';
          map.push(i);
        }
      } else {
        text += c.toLowerCase();
        map.push(i);
      }
    }
    return { text: text.trim(), map };
  }

  // ---------- Small helpers ----------

  function isMarkNoteUi(target) {
    return !!(target && target.closest && target.closest('[data-marknote]'));
  }

  function isRangeInUi(range) {
    const inUi = (node) => {
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return !!(el && el.closest && el.closest('[data-marknote]'));
    };
    if (inUi(range.startContainer) || inUi(range.endContainer)) {
      return true;
    }
    const anc = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    return !!(anc && anc.closest && anc.closest('[data-marknote]'));
  }

  function isRangeInPages(range) {
    const el = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    return !!(el && el.closest && el.closest('#pages'));
  }

  function clearSelection() {
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
      }
    } catch (e) {
      // ignore
    }
  }

  function flash(message) {
    statusEl.textContent = message;
    statusEl.style.display = 'block';
    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => {
      statusEl.style.display = 'none';
    }, 4500);
    console.log(`[MarkNote] ${message}`);
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
    docTitleEl.textContent = 'Failed to load';
    console.warn('[MarkNote]', message);
  }
})();
