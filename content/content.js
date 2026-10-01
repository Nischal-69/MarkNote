// MarkNote Content Script — v0.6.0 expiration (chrome.storage.local)
// - Preserves v0.1.0 foundation, v0.2.0 highlighting, v0.3.0 notes UI, v0.4.0 storage model,
//   v0.5.0 gated restoration.
// - Changes vs v0.5.0: purge expired annotations on preload and on activation;
//   restore only valid (non-expired) annotations.
// - Matching uses URL + selectedText + surroundingText (+ pageTitle as soft signal).
// - No PDF, no backend. No permanent storage (annotations expire after 7 days).

(function () {
  'use strict';

  const INDICATOR_ID = 'marknote-indicator';
  const INDICATOR_CLOSE_ID = 'marknote-indicator-close';
  const TOOLBAR_ID = 'marknote-toolbar';
  const HIGHLIGHT_BTN_ID = 'marknote-btn-highlight';
  const NOTE_BTN_ID = 'marknote-btn-note';
  const ACTIVE_CLASS = 'marknote-active';
  const HIGHLIGHT_CLASS = 'marknote-highlight';
  const NOTE_MARKER_CLASS = 'marknote-note-marker';
  const NOTE_PANEL_ID = 'marknote-note-panel';
  const RESTORE_STATUS_ID = 'marknote-restore-status';
  const HIGHLIGHT_COLOR = 'yellow';

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION']);

  // Restore tuning: bounded work per activation so a page with many annotations
  // can never lock up the tab or loop forever.
  const MAX_RESTORE_PER_RUN = 500;
  const MAX_FIND_ATTEMPTS = 12;
  const SURROUNDING_MIN_SCORE = 0.25;

  let isActive = false;
  let listenersAttached = false;
  let lastRange = null;
  let lastRect = null;
  let toolbarEl = null;
  let highlightBtn = null;
  let noteBtn = null;
  // Gated restoration state. Page load only preloads (read-only); DOM is
  // touched exclusively by restoreOnActivate().
  let pendingAnnotations = null;
  let isRestoring = false;
  let restoreStatusTimer = null;

  // ---- Notes cache (mirrors chrome.storage.local; storage is source of truth) ----
  let noteSeq = 0;
  const notes = new Map(); // id -> { id, selectedText, noteText }
  let panelEl = null;
  let panelMode = 'closed'; // 'closed' | 'create' | 'view' | 'edit'
  let panelNoteId = null;
  let pendingPreview = '';

  // ---------- Storage access (separate storage/storage.js; no direct chrome.storage here) ----------

  function store() {
    return window.MarkNoteStorage || null;
  }

  function currentPageInfo() {
    return {
      url: location.href,
      pageTitle: document.title || '',
    };
  }

  function getSurroundingText(range, selectedText, radius) {
    try {
      const r = radius || 160;
      const container = range.commonAncestorContainer;
      const el = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
      if (!el || !el.textContent) {
        return '';
      }
      const full = el.textContent.replace(/\s+/g, ' ').trim();
      if (!full) {
        return '';
      }
      const needle = (selectedText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const idx = needle ? full.indexOf(needle) : -1;
      if (idx === -1) {
        return full.slice(0, 400);
      }
      return full.slice(Math.max(0, idx - r), Math.min(full.length, idx + needle.length + r));
    } catch (e) {
      return '';
    }
  }

  function localFallbackId() {
    noteSeq += 1;
    return `mn-local-${Date.now().toString(36)}-${noteSeq}`;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === 'MARKNOTE_ACTIVATE') {
      activate();
      sendResponse({ ok: true, active: isActive });
      return false;
    }

    if (message.type === 'MARKNOTE_DEACTIVATE') {
      deactivate();
      sendResponse({ ok: true, active: isActive });
      return false;
    }

    if (message.type === 'MARKNOTE_GET_STATE') {
      sendResponse({ ok: true, active: isActive });
      return false;
    }

    // Read-only probe: does this host page embed any PDFs? No DOM writes.
    // Lets the popup report embedded PDFs without touching page content.
    if (message.type === 'MARKNOTE_PDF_SCAN') {
      let embedded = [];
      try {
        const pdf = globalThis.MarkNotePdf;
        if (pdf && typeof pdf.scanEmbedded === 'function') {
          embedded = pdf.scanEmbedded(document) || [];
        }
      } catch (e) {
        embedded = [];
      }
      sendResponse({ ok: true, embedded });
      return false;
    }

    return false;
  });

  // ---------- Activation / deactivation (unchanged behavior) ----------

  function activate() {
    if (isActive) {
      ensureIndicator();
      ensureToolbar();
      // Re-run restores picking up annotations added elsewhere (already-rendered ids skip).
      restoreOnActivate().catch((err) => console.warn('[MarkNote] Restore failed:', err));
      return;
    }

    isActive = true;
    document.documentElement.classList.add(ACTIVE_CLASS);
    if (document.body) {
      document.body.classList.add(ACTIVE_CLASS);
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => document.body.classList.add(ACTIVE_CLASS),
        { once: true }
      );
    }
    ensureIndicator();
    ensureToolbar();
    attachListeners();
    console.log('[MarkNote] Highlighter mode active.');
    // Restore saved highlights/markers now — never before activation.
    restoreOnActivate().catch((err) => console.warn('[MarkNote] Restore failed:', err));
  }

  function deactivate() {
    if (!isActive) {
      hideToolbar();
      return;
    }

    isActive = false;
    lastRange = null;
    lastRect = null;
    hideToolbar();
    hideNotePanel();
    hideRestoreStatus();
    clearSelection();

    document.documentElement.classList.remove(ACTIVE_CLASS);
    if (document.body) {
      document.body.classList.remove(ACTIVE_CLASS);
    }

    const indicator = document.getElementById(INDICATOR_ID);
    if (indicator) {
      indicator.remove();
    }

    console.log('[MarkNote] Highlighter mode deactivated. Persisted highlights/notes stay on page.');
  }

  // ---------- Indicator (unchanged) ----------

  function ensureIndicator() {
    if (document.getElementById(INDICATOR_ID)) {
      return;
    }

    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.setAttribute('data-marknote', 'indicator');

    const label = document.createElement('span');
    label.className = 'marknote-indicator-label';
    label.textContent = 'MarkNote Active';

    const close = document.createElement('button');
    close.id = INDICATOR_CLOSE_ID;
    close.type = 'button';
    close.textContent = '\u00D7'; // ×
    close.title = 'Deactivate MarkNote';
    close.setAttribute('aria-label', 'Deactivate MarkNote');
    close.setAttribute('data-marknote', 'close');

    close.addEventListener('mousedown', (e) => e.preventDefault());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      deactivate();
    });

    el.appendChild(label);
    el.appendChild(close);

    const parent = document.body || document.documentElement;
    parent.appendChild(el);
  }

  // ---------- Floating toolbar (unchanged UI; handlers now persist) ----------

  function ensureToolbar() {
    if (toolbarEl && document.getElementById(TOOLBAR_ID)) {
      return;
    }

    toolbarEl = document.createElement('div');
    toolbarEl.id = TOOLBAR_ID;
    toolbarEl.setAttribute('data-marknote', 'toolbar');
    toolbarEl.style.display = 'none';

    highlightBtn = document.createElement('button');
    highlightBtn.id = HIGHLIGHT_BTN_ID;
    highlightBtn.type = 'button';
    highlightBtn.setAttribute('data-marknote', 'highlight-btn');
    highlightBtn.title = 'Highlight selection';
    highlightBtn.textContent = '\uD83D\uDFE1 Highlight'; // 🟡 Highlight

    noteBtn = document.createElement('button');
    noteBtn.id = NOTE_BTN_ID;
    noteBtn.type = 'button';
    noteBtn.setAttribute('data-marknote', 'note-btn');
    noteBtn.title = 'Add note';
    noteBtn.textContent = '\uD83D\uDCDD Note'; // 📝 Note

    toolbarEl.addEventListener('mousedown', (e) => e.preventDefault());
    toolbarEl.addEventListener('mouseup', (e) => e.stopPropagation());

    highlightBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyHighlightFromStoredRange().catch((err) => console.warn('[MarkNote] Highlight failed:', err));
    });

    noteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNoteEditor();
    });

    toolbarEl.appendChild(highlightBtn);
    toolbarEl.appendChild(noteBtn);

    (document.body || document.documentElement).appendChild(toolbarEl);
  }

  function hideToolbar() {
    if (toolbarEl) {
      toolbarEl.style.display = 'none';
    }
  }

  function showToolbarNearRect(rect) {
    if (!toolbarEl) {
      return;
    }
    toolbarEl.style.display = 'flex';
    toolbarEl.style.visibility = 'hidden';

    const toolbarWidth = toolbarEl.offsetWidth || 220;
    const toolbarHeight = toolbarEl.offsetHeight || 40;

    let left = rect.left + rect.width / 2 - toolbarWidth / 2;
    let top = rect.top - toolbarHeight - 10;

    if (top < 8) {
      top = rect.bottom + 10;
    }

    left = Math.max(8, Math.min(left, window.innerWidth - toolbarWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - toolbarHeight - 8));

    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;
    toolbarEl.style.visibility = 'visible';
  }

  // ---------- Selection handling (unchanged) ----------

  function attachListeners() {
    if (listenersAttached) {
      return;
    }
    listenersAttached = true;

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, false);
    document.addEventListener('keyup', onKeyUp, false);
    document.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('scroll', onScroll, true);
  }

  function onMouseDown(e) {
    if (!isActive) {
      return;
    }
    if (isMarkNoteUI(e.target)) {
      return;
    }
    hideToolbar();
  }

  function onMouseUp(e) {
    if (!isActive) {
      return;
    }
    if (isMarkNoteUI(e.target)) {
      return;
    }
    setTimeout(handleSelection, 10);
  }

  function onKeyUp(e) {
    if (!isActive) {
      return;
    }
    if (isMarkNoteUI(e.target)) {
      return;
    }
    handleSelection();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isPanelOpen()) {
      e.stopPropagation();
      if (panelMode === 'view') {
        hideNotePanel();
      } else if (panelMode === 'edit') {
        showViewPanel(panelNoteId, null);
      } else {
        hideNotePanel();
      }
    }
  }

  function onScroll() {
    if (!isActive) {
      return;
    }
    hideToolbar();
  }

  function handleSelection() {
    if (!isActive) {
      return;
    }

    if (isPanelOpen()) {
      hideToolbar();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideToolbar();
      return;
    }

    const text = sel.toString();
    if (!text || text.trim() === '') {
      hideToolbar();
      return;
    }

    const range = sel.getRangeAt(0);

    if (isRangeInMarkNoteUI(range)) {
      hideToolbar();
      return;
    }

    if (isRangeInSkipContainer(range)) {
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
      console.warn('[MarkNote] Could not store selection:', err);
      hideToolbar();
      return;
    }

    ensureToolbar();
    showToolbarNearRect(rect);
  }

  // ---------- Highlighting (same DOM behavior + persistent save) ----------

  async function applyHighlightFromStoredRange() {
    if (!lastRange) {
      hideToolbar();
      return;
    }

    const range = lastRange;
    const rawSelected = range.toString();

    try {
      const container = range.commonAncestorContainer;
      if (!container || !container.isConnected) {
        hideToolbar();
        lastRange = null;
        return;
      }

      if (isRangeInMarkNoteUI(range)) {
        hideToolbar();
        lastRange = null;
        clearSelection();
        return;
      }

      if (isRangeInSkipContainer(range)) {
        hideToolbar();
        lastRange = null;
        clearSelection();
        return;
      }

      const textNodes = getHighlightableTextNodes(range);
      if (textNodes.length === 0) {
        hideToolbar();
        lastRange = null;
        clearSelection();
        return;
      }

      // Persist first so the annotation id can tag the DOM marks.
      const page = currentPageInfo();
      const surrounding = getSurroundingText(range, rawSelected);
      let annotationId = null;
      const s = store();
      if (s) {
        try {
          const saved = await s.saveAnnotation({
            url: page.url,
            pageTitle: page.pageTitle,
            selectedText: rawSelected.trim(),
            surroundingText: surrounding,
            note: '',
            highlightColor: HIGHLIGHT_COLOR,
            type: 'highlight',
          });
          annotationId = saved.id;
        } catch (err) {
          console.warn('[MarkNote] Storage save failed, keeping highlight in DOM only:', err);
        }
      }

      let wrapped = 0;
      const createdMarks = [];
      for (const node of textNodes) {
        const mark = wrapTextNodeInRange(node, range);
        if (mark) {
          wrapped += 1;
          createdMarks.push(mark);
          if (annotationId) {
            mark.dataset.annotationId = annotationId;
          }
        }
      }

      console.log(`[MarkNote] Highlighted ${wrapped} text node(s).`);
    } catch (err) {
      console.warn('[MarkNote] Highlight failed:', err);
    } finally {
      hideToolbar();
      lastRange = null;
      lastRect = null;
      clearSelection();
    }
  }

  function getHighlightableTextNodes(range) {
    const root = range.commonAncestorContainer;
    const nodes = [];

    if (root.nodeType === Node.TEXT_NODE) {
      if (range.intersectsNode(root) && isTextNodeHighlightable(root)) {
        nodes.push(root);
      }
      return nodes;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        try {
          if (!range.intersectsNode(node)) {
            return NodeFilter.FILTER_SKIP;
          }
        } catch (e) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isTextNodeHighlightable(node)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let current;
    while ((current = walker.nextNode())) {
      nodes.push(current);
    }
    return nodes;
  }

  function isTextNodeHighlightable(node) {
    if (!node || !node.nodeValue || node.nodeValue.trim() === '') {
      return false;
    }
    const parent = node.parentElement;
    if (!parent) {
      return false;
    }
    if (parent.closest(`.${HIGHLIGHT_CLASS}`)) {
      return false;
    }
    if (parent.closest('#marknote-toolbar, #marknote-indicator, [data-marknote]')) {
      return false;
    }
    const tag = parent.tagName;
    if (SKIP_TAGS.has(tag)) {
      return false;
    }
    if (parent.closest('input, textarea, select')) {
      return false;
    }
    if (parent.isContentEditable) {
      return false;
    }
    return true;
  }

  // Returns the created <mark> element on success, null otherwise.
  function wrapTextNodeInRange(textNode, range, noteId) {
    if (textNode.parentElement && textNode.parentElement.closest(`.${HIGHLIGHT_CLASS}`)) {
      return null;
    }

    let start = 0;
    let end = textNode.length;

    if (textNode === range.startContainer && textNode === range.endContainer) {
      start = range.startOffset;
      end = range.endOffset;
    } else if (textNode === range.startContainer) {
      start = range.startOffset;
      end = textNode.length;
    } else if (textNode === range.endContainer) {
      start = 0;
      end = range.endOffset;
    }

    if (start >= end) {
      return null;
    }

    const slice = textNode.nodeValue.slice(start, end);
    if (!slice || slice.trim() === '') {
      return null;
    }

    let target = textNode;

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
    if (noteId) {
      mark.dataset.noteId = noteId;
    }
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    return mark;
  }

  // ---------- Notes (same UI + persistent save/update/delete) ----------

  function ensureNotePanel() {
    if (panelEl && document.getElementById(NOTE_PANEL_ID)) {
      return panelEl;
    }

    panelEl = document.createElement('div');
    panelEl.id = NOTE_PANEL_ID;
    panelEl.setAttribute('data-marknote', 'note-panel');
    panelEl.style.display = 'none';
    panelEl.addEventListener('mouseup', (e) => e.stopPropagation());

    (document.body || document.documentElement).appendChild(panelEl);
    return panelEl;
  }

  function isPanelOpen() {
    return !!(panelEl && panelEl.style.display !== 'none' && panelMode !== 'closed');
  }

  function hideNotePanel() {
    panelMode = 'closed';
    panelNoteId = null;
    pendingPreview = '';
    if (panelEl) {
      panelEl.style.display = 'none';
      panelEl.innerHTML = '';
    }
  }

  function positionPanelNearRect(rect) {
    ensureNotePanel();
    panelEl.style.display = 'block';
    panelEl.style.visibility = 'hidden';

    const width = panelEl.offsetWidth || 300;
    const height = panelEl.offsetHeight || 200;

    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - 8) {
      top = rect.top - height - 10;
    }
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
    panelEl.style.visibility = 'visible';
  }

  function truncate(text, max) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) {
      return t;
    }
    return `${t.slice(0, max - 1).trimEnd()}\u2026`;
  }

  function openNoteEditor() {
    if (!lastRange) {
      hideToolbar();
      return;
    }
    const container = lastRange.commonAncestorContainer;
    if (!container || !container.isConnected || isRangeInMarkNoteUI(lastRange) || isRangeInSkipContainer(lastRange)) {
      hideToolbar();
      lastRange = null;
      return;
    }

    const raw = lastRange.toString();
    if (!raw || raw.trim() === '') {
      hideToolbar();
      return;
    }

    pendingPreview = truncate(raw, 200);
    const rect = lastRect && lastRect.width ? lastRect : lastRange.getBoundingClientRect();
    hideToolbar();
    panelMode = 'create';
    panelNoteId = null;
    renderCreatePanel(rect);
  }

  function renderCreatePanel(rect) {
    ensureNotePanel();
    panelEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'marknote-panel-title';
    title.textContent = '\uD83D\uDCDD New note';

    const selected = document.createElement('div');
    selected.className = 'marknote-panel-selected';
    const selectedLabel = document.createElement('span');
    selectedLabel.className = 'marknote-panel-label';
    selectedLabel.textContent = 'Selected: ';
    const quote = document.createElement('q');
    quote.textContent = pendingPreview;
    selected.appendChild(selectedLabel);
    selected.appendChild(quote);

    const textarea = document.createElement('textarea');
    textarea.className = 'marknote-panel-textarea';
    textarea.placeholder = 'Write your note...';
    textarea.rows = 3;
    textarea.setAttribute('aria-label', 'Write your note');

    const actions = document.createElement('div');
    actions.className = 'marknote-panel-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'marknote-btn-save';
    save.textContent = 'Save';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'marknote-btn-cancel';
    cancel.textContent = 'Cancel';

    save.addEventListener('click', (e) => {
      e.stopPropagation();
      saveNoteFromEditor(textarea.value).catch((err) => console.warn('[MarkNote] Note save failed:', err));
    });
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      hideNotePanel();
      lastRange = null;
      lastRect = null;
      clearSelection();
    });

    actions.appendChild(save);
    actions.appendChild(cancel);

    panelEl.appendChild(title);
    panelEl.appendChild(selected);
    panelEl.appendChild(textarea);
    panelEl.appendChild(actions);

    positionPanelNearRect(rect);
    setTimeout(() => textarea.focus(), 0);
  }

  async function saveNoteFromEditor(value) {
    const noteText = (value || '').trim();
    if (!noteText) {
      const ta = panelEl && panelEl.querySelector('textarea');
      if (ta) {
        ta.focus();
      }
      return;
    }
    if (!lastRange) {
      hideNotePanel();
      hideToolbar();
      return;
    }

    const range = lastRange;
    const rawSelected = range.toString();
    const selectedText = truncate(rawSelected, 200);
    const page = currentPageInfo();
    const surrounding = getSurroundingText(range, rawSelected);

    // Persist first so the returned id tags the DOM (single source of truth).
    let annotationId = localFallbackId();
    const s = store();
    if (s) {
      try {
        const saved = await s.saveAnnotation({
          url: page.url,
          pageTitle: page.pageTitle,
          selectedText: rawSelected.trim(),
          surroundingText: surrounding,
          note: noteText,
          highlightColor: HIGHLIGHT_COLOR,
          type: 'note',
        });
        annotationId = saved.id;
      } catch (err) {
        console.warn('[MarkNote] Storage save failed, keeping note in DOM only:', err);
      }
    }

    const marks = highlightRangeForNote(range, annotationId);
    for (const m of marks) {
      m.dataset.annotationId = annotationId;
    }
    const marker = createNoteMarker(annotationId);
    anchorMarker(marker, marks, range);

    notes.set(annotationId, { id: annotationId, selectedText, noteText });

    hideNotePanel();
    hideToolbar();
    lastRange = null;
    lastRect = null;
    clearSelection();
    console.log('[MarkNote] Note saved.');
  }

  function highlightRangeForNote(range, noteId) {
    const created = [];
    try {
      const nodes = getHighlightableTextNodes(range);
      for (const node of nodes) {
        const mark = wrapTextNodeInRange(node, range, noteId);
        if (mark) {
          created.push(mark);
        }
      }
    } catch (err) {
      console.warn('[MarkNote] Note highlight failed:', err);
    }
    return created;
  }

  function createNoteMarker(noteId) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = NOTE_MARKER_CLASS;
    marker.setAttribute('data-marknote', 'note-marker');
    marker.dataset.noteId = noteId;
    marker.dataset.annotationId = noteId;
    marker.textContent = '\uD83D\uDCDD'; // 📝
    marker.title = 'View note';
    marker.setAttribute('aria-label', 'View note');
    marker.addEventListener('mousedown', (e) => e.preventDefault());
    marker.addEventListener('mouseup', (e) => e.stopPropagation());
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      showViewPanel(noteId, null);
    });
    return marker;
  }

  function anchorMarker(marker, marks, range) {
    try {
      if (marks.length > 0) {
        const last = marks[marks.length - 1];
        last.parentNode.insertBefore(marker, last.nextSibling);
        return;
      }
      const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      const existing = startEl && startEl.closest ? startEl.closest(`.${HIGHLIGHT_CLASS}`) : null;
      if (existing && existing.parentNode) {
        existing.parentNode.insertBefore(marker, existing.nextSibling);
        return;
      }
      const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement;
      if (endEl && endEl.isConnected) {
        (endEl.closest('p, div, li, article, section') || endEl).appendChild(marker);
      }
    } catch (err) {
      console.warn('[MarkNote] Could not anchor note marker:', err);
    }
  }

  function showViewPanel(noteId, anchorRect) {
    const note = notes.get(noteId);
    if (!note) {
      // Cache miss (e.g. marker restored before Map hydrated) — try lazy load from storage.
      const s = store();
      if (s) {
        s.getAnnotations(location.href).then((all) => {
          const found = all.find((a) => a.id === noteId);
          if (found) {
            notes.set(noteId, { id: found.id, selectedText: truncate(found.selectedText, 200), noteText: found.note });
            showViewPanel(noteId, anchorRect);
          }
        }).catch(() => {});
      }
      return;
    }
    panelMode = 'view';
    panelNoteId = noteId;
    ensureNotePanel();
    panelEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'marknote-panel-title';
    title.textContent = '\uD83D\uDCDD Note';

    const selected = document.createElement('div');
    selected.className = 'marknote-panel-selected';
    const label = document.createElement('span');
    label.className = 'marknote-panel-label';
    label.textContent = 'Selected: ';
    const quote = document.createElement('q');
    quote.textContent = note.selectedText;
    selected.appendChild(label);
    selected.appendChild(quote);

    const body = document.createElement('div');
    body.className = 'marknote-panel-note';
    body.textContent = note.noteText;

    const actions = document.createElement('div');
    actions.className = 'marknote-panel-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'marknote-btn-edit';
    edit.textContent = 'Edit';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'marknote-btn-delete';
    del.textContent = 'Delete';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'marknote-btn-cancel';
    close.textContent = 'Close';

    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      showEditPanel(noteId);
    });
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(noteId).catch((err) => console.warn('[MarkNote] Note delete failed:', err));
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      hideNotePanel();
    });

    actions.appendChild(edit);
    actions.appendChild(del);
    actions.appendChild(close);

    panelEl.appendChild(title);
    panelEl.appendChild(selected);
    panelEl.appendChild(body);
    panelEl.appendChild(actions);

    positionPanelNearRect(anchorRect || markerRect(noteId) || lastRect || { left: window.innerWidth / 2, top: 100, bottom: 110, width: 0 });
  }

  function showEditPanel(noteId) {
    const note = notes.get(noteId);
    if (!note) {
      return;
    }
    panelMode = 'edit';
    panelNoteId = noteId;
    ensureNotePanel();
    panelEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'marknote-panel-title';
    title.textContent = '\uD83D\uDCDD Edit note';

    const selected = document.createElement('div');
    selected.className = 'marknote-panel-selected';
    const label = document.createElement('span');
    label.className = 'marknote-panel-label';
    label.textContent = 'Selected: ';
    const quote = document.createElement('q');
    quote.textContent = note.selectedText;
    selected.appendChild(label);
    selected.appendChild(quote);

    const textarea = document.createElement('textarea');
    textarea.className = 'marknote-panel-textarea';
    textarea.placeholder = 'Write your note...';
    textarea.rows = 3;
    textarea.value = note.noteText;

    const actions = document.createElement('div');
    actions.className = 'marknote-panel-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'marknote-btn-save';
    save.textContent = 'Save';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'marknote-btn-cancel';
    cancel.textContent = 'Cancel';

    save.addEventListener('click', (e) => {
      e.stopPropagation();
      updateNoteText(noteId, textarea.value).catch((err) => console.warn('[MarkNote] Note update failed:', err));
    });
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      showViewPanel(noteId, null);
    });

    actions.appendChild(save);
    actions.appendChild(cancel);

    panelEl.appendChild(title);
    panelEl.appendChild(selected);
    panelEl.appendChild(textarea);
    panelEl.appendChild(actions);

    positionPanelNearRect(markerRect(noteId) || { left: window.innerWidth / 2, top: 100, bottom: 110, width: 0 });
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, 0);
  }

  async function updateNoteText(noteId, value) {
    const next = (value || '').trim();
    if (!next) {
      const ta = panelEl && panelEl.querySelector('textarea');
      if (ta) {
        ta.focus();
      }
      return;
    }
    const note = notes.get(noteId);
    if (!note) {
      return;
    }
    const s = store();
    if (s) {
      try {
        await s.updateAnnotation(noteId, { note: next });
      } catch (err) {
        console.warn('[MarkNote] Storage update failed, updating UI only:', err);
      }
    }
    note.noteText = next;
    notes.set(noteId, note);
    showViewPanel(noteId, null);
  }

  function markerRect(noteId) {
    const marker = document.querySelector(`.${NOTE_MARKER_CLASS}[data-note-id="${CSS.escape(noteId)}"]`);
    if (!marker) {
      return null;
    }
    const rect = marker.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return null;
    }
    return rect;
  }

  async function deleteNote(noteId) {
    const s = store();
    if (s) {
      try {
        await s.deleteAnnotation(noteId);
      } catch (err) {
        console.warn('[MarkNote] Storage delete failed, removing from DOM only:', err);
      }
    }
    const marker = document.querySelector(`.${NOTE_MARKER_CLASS}[data-note-id="${CSS.escape(noteId)}"]`);
    if (marker && marker.parentNode) {
      marker.parentNode.removeChild(marker);
    }
    const marks = Array.from(document.querySelectorAll(`mark.${HIGHLIGHT_CLASS}[data-note-id="${CSS.escape(noteId)}"]`));
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      if (parent.normalize) {
        parent.normalize();
      }
    }
    notes.delete(noteId);
    hideNotePanel();
    console.log('[MarkNote] Note deleted.');
  }

  // ---------- Gated restoration (reads on load, renders only on activation) ----------

  // Read-only start step: purge expired annotations, then cache this URL's
  // valid ones. Makes ZERO DOM writes — safe to run on every page load.
  async function preloadAnnotations() {
    const s = store();
    if (!s) {
      return;
    }
    try {
      const swept = await s.purgeExpired();
      if (swept.purged > 0) {
        console.log(`[MarkNote] Removed ${swept.purged} expired annotation(s).`);
      }
      pendingAnnotations = await s.getAnnotations(location.href);
      if (pendingAnnotations && pendingAnnotations.length > 0) {
        console.log(`[MarkNote] ${pendingAnnotations.length} saved annotation(s) found — will restore on activation.`);
      }
    } catch (err) {
      console.warn('[MarkNote] Preload read failed:', err);
      pendingAnnotations = null;
    }
  }

  function annotationAlreadyRendered(id) {
    try {
      return !!document.querySelector(`[data-annotation-id="${CSS.escape(id)}"]`);
    } catch (e) {
      return false;
    }
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Locate `needle` inside a single text node's value.
  // Returns { start, end } offsets into the ORIGINAL node value, or null.
  // Exact substring first; then a whitespace/case-tolerant regex fallback so
  // slight content changes (line-breaks, extra spaces, casing) still locate.
  function findNeedleOffsets(nodeValue, needle) {
    if (!nodeValue || !needle) {
      return null;
    }
    const exact = nodeValue.indexOf(needle);
    if (exact !== -1) {
      return { start: exact, end: exact + needle.length };
    }
    const words = needle.split(/\s+/).filter(Boolean).slice(0, 30);
    if (words.length === 0) {
      return null;
    }
    try {
      const pattern = words.map(escapeRegExp).join('\\s+');
      const re = new RegExp(pattern, 'i');
      const m = re.exec(nodeValue);
      if (m) {
        return { start: m.index, end: m.index + m[0].length };
      }
    } catch (e) {
      // Invalid regex (shouldn't happen after escaping) — treat as no match.
    }
    return null;
  }

  // Word-overlap between stored surrounding context and the candidate's live
  // context. 1 = identical context, 0 = unrelated. Empty stored context is
  // neutral (0.5) so legacy annotations without surroundingText still restore.
  function surroundingScore(storedSurrounding, liveSurrounding) {
    if (!storedSurrounding) {
      return 0.5;
    }
    if (!liveSurrounding) {
      return 0;
    }
    const aWords = storedSurrounding.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (aWords.length === 0) {
      return 0.5;
    }
    const bSet = new Set(liveSurrounding.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    let hits = 0;
    for (const w of aWords) {
      if (bSet.has(w)) {
        hits += 1;
      }
    }
    return hits / aWords.length;
  }

  function pageTitleBonus(storedTitle) {
    try {
      const a = (storedTitle || '').trim().toLowerCase().slice(0, 24);
      const b = (document.title || '').trim().toLowerCase().slice(0, 24);
      if (a && b && (a.includes(b) || b.includes(a))) {
        return 0.1;
      }
    } catch (e) {
      // ignore
    }
    return 0;
  }

  // All single-node candidates for `needle` in live DOM order, best first.
  // Re-queried per annotation against the LIVE DOM so already-wrapped text
  // (from earlier restores in the same run) is naturally excluded — this is
  // what makes duplicate selectedText restore to distinct locations.
  function findRankedCandidates(annotation) {
    const needle = (annotation.selectedText || '').trim();
    if (!needle || !document.body) {
      return [];
    }
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !findNeedleOffsets(node.nodeValue, needle)) {
          return NodeFilter.FILTER_SKIP;
        }
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_SKIP;
        }
        if (parent.closest(`.${HIGHLIGHT_CLASS}`)) {
          return NodeFilter.FILTER_SKIP;
        }
        if (parent.closest('[data-marknote]')) {
          return NodeFilter.FILTER_SKIP;
        }
        const tag = parent.tagName;
        if (SKIP_TAGS.has(tag)) {
          return NodeFilter.FILTER_SKIP;
        }
        if (parent.closest('input, textarea, select')) {
          return NodeFilter.FILTER_SKIP;
        }
        if (parent.isContentEditable) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const offsets = findNeedleOffsets(node.nodeValue, needle);
      if (!offsets) {
        continue;
      }
      let score = 0;
      try {
        const probe = document.createRange();
        probe.setStart(node, offsets.start);
        probe.setEnd(node, offsets.end);
        score = surroundingScore(annotation.surroundingText, getSurroundingText(probe, needle))
          + pageTitleBonus(annotation.pageTitle);
      } catch (e) {
        score = 0;
      }
      out.push({ node, offsets, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function wrapRangeWithId(range, annotationId, isNote) {
    const nodes = getHighlightableTextNodes(range);
    const created = [];
    for (const node of nodes) {
      const mark = wrapTextNodeInRange(node, range, isNote ? annotationId : undefined);
      if (mark) {
        mark.dataset.annotationId = annotationId;
        created.push(mark);
      }
    }
    return created;
  }

  // Cross-node fallback: walks window.find occurrences (bounded), verifying
  // surrounding context so duplicate text resolves to the best match instead
  // of blindly taking the first occurrence.
  function restoreViaFindOccurrences(annotation, needle) {
    const sel = window.getSelection();
    if (!sel) {
      return false;
    }
    let best = null;
    try {
      // No selection -> window.find starts from the top for determinism.
      sel.removeAllRanges();
      for (let attempt = 0; attempt < MAX_FIND_ATTEMPTS; attempt += 1) {
        let found = false;
        try {
          found = window.find(needle, false, false, false, false, false, false);
        } catch (e) {
          break;
        }
        if (!found || sel.rangeCount === 0) {
          break;
        }
        const candidate = sel.getRangeAt(0).cloneRange();
        // Advance past this occurrence so the next attempt finds the next one.
        try {
          sel.collapseToEnd();
        } catch (e) {
          // ignore
        }
        if (isRangeInMarkNoteUI(candidate) || isRangeInSkipContainer(candidate)) {
          continue;
        }
        // Skip occurrences already claimed by an earlier restore.
        try {
          const probe = candidate.commonAncestorContainer;
          const el = probe.nodeType === Node.ELEMENT_NODE ? probe : probe.parentElement;
          if (el && el.closest && el.closest(`.${HIGHLIGHT_CLASS}`)) {
            continue;
          }
        } catch (e) {
          // ignore
        }
        const score = surroundingScore(annotation.surroundingText, getSurroundingText(candidate, needle))
          + pageTitleBonus(annotation.pageTitle);
        if (!best || score > best.score) {
          best = { range: candidate, score };
        }
        if (score >= 0.9) {
          break; // near-certain match; stop scanning.
        }
      }
    } finally {
      try {
        sel.removeAllRanges();
      } catch (e) {
        // ignore
      }
    }
    if (!best || best.score < SURROUNDING_MIN_SCORE) {
      return false;
    }
    const marks = wrapRangeWithId(best.range, annotation.id, (annotation.type === 'note') || !!annotation.note);
    if (marks.length === 0) {
      return false;
    }
    afterRestoreRender(annotation, marks);
    return true;
  }

  // Returns 'restored' (newly rendered) | 'skipped' (already on page) |
  // 'unavailable' (not found; stays stored). Never throws, never deletes
  // storage, never writes unrelated DOM.
  function restoreAnnotation(annotation) {
    if (!annotation || !annotation.selectedText || !(annotation.selectedText || '').trim()) {
      return 'unavailable';
    }
    if (annotationAlreadyRendered(annotation.id)) {
      return 'skipped'; // idempotent: re-activation never duplicates or recounts.
    }
    // Defensive: purge normally removes these first; never render expired ones.
    try {
      const s = store();
      if (s && s.isExpired && s.isExpired(annotation)) {
        return 'unavailable';
      }
    } catch (e) {
      // ignore — purge already ran above.
    }
    const isNote = (annotation.type === 'note') || !!annotation.note;
    const needle = annotation.selectedText.trim();

    // Strategy 1: ranked single-node candidates (exact + fuzzy offsets).
    try {
      const candidates = findRankedCandidates(annotation);
      for (const c of candidates) {
        if (c.score < SURROUNDING_MIN_SCORE && candidates.length > 1) {
          continue; // low-confidence duplicate-slot; try a better one first.
        }
        // Re-validate liveness: an earlier annotation in this run may have claimed it.
        if (!c.node.isConnected || !isTextNodeHighlightable(c.node)) {
          continue;
        }
        const offsets = findNeedleOffsets(c.node.nodeValue, needle);
        if (!offsets) {
          continue;
        }
        const range = document.createRange();
        range.setStart(c.node, offsets.start);
        range.setEnd(c.node, offsets.end);
        const marks = wrapRangeWithId(range, annotation.id, isNote);
        if (marks.length > 0) {
          afterRestoreRender(annotation, marks);
          return 'restored';
        }
      }
      // If every candidate was low-confidence, still accept the best one
      // rather than dropping the annotation — single weak signal beats loss.
      if (candidates.length > 0) {
        const c = candidates[0];
        if (c.node.isConnected && isTextNodeHighlightable(c.node)) {
          const offsets = findNeedleOffsets(c.node.nodeValue, needle);
          if (offsets) {
            const range = document.createRange();
            range.setStart(c.node, offsets.start);
            range.setEnd(c.node, offsets.end);
            const marks = wrapRangeWithId(range, annotation.id, isNote);
            if (marks.length > 0) {
              afterRestoreRender(annotation, marks);
              return 'restored';
            }
          }
        }
      }
    } catch (e) {
      console.warn('[MarkNote] Restore search failed:', e);
    }

    // Strategy 2: cross-node occurrences via window.find.
    try {
      if (restoreViaFindOccurrences(annotation, needle)) {
        return 'restored';
      }
    } catch (e) {
      console.warn('[MarkNote] Restore search failed:', e);
    }

    console.warn(`[MarkNote] Annotation unavailable on this page (kept stored): ${annotation.id}`);
    return 'unavailable';
  }

  function afterRestoreRender(annotation, marks) {
    if ((annotation.type === 'note') || annotation.note) {
      notes.set(annotation.id, {
        id: annotation.id,
        selectedText: truncate(annotation.selectedText, 200),
        noteText: annotation.note || '',
      });
      const marker = createNoteMarker(annotation.id);
      try {
        const last = marks[marks.length - 1];
        if (last && last.parentNode) {
          last.parentNode.insertBefore(marker, last.nextSibling);
        }
      } catch (e) {
        console.warn('[MarkNote] Could not anchor restored marker:', e);
      }
    }
  }

  // Runs ONLY after activation. Restores this URL's saved annotations once per
  // rendered id (idempotent across re-activations; bounded per run).
  async function restoreOnActivate() {
    if (!isActive || isRestoring) {
      return { restored: 0, unavailable: 0 };
    }
    const s = store();
    if (!s) {
      console.warn('[MarkNote] Storage helper missing; skipping restore.');
      return { restored: 0, unavailable: 0 };
    }
    if (!document.body) {
      return { restored: 0, unavailable: 0 };
    }
    isRestoring = true;
    let restored = 0;
    let unavailable = 0;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    try {
      // Fresh read (not the preload cache) so annotations added in another
      // tab are picked up. Expired annotations are deleted first; only valid
      // (non-expired) ones are restored below.
      const swept = await s.purgeExpired();
      if (swept.purged > 0) {
        console.log(`[MarkNote] Removed ${swept.purged} expired annotation(s).`);
      }
      const all = await s.getAnnotations(location.href);
      const queue = (all || []).slice(0, MAX_RESTORE_PER_RUN);
      for (const annotation of queue) {
        try {
          const outcome = restoreAnnotation(annotation);
          if (outcome === 'restored') {
            restored += 1;
          } else if (outcome === 'unavailable') {
            unavailable += 1;
          }
          // 'skipped' (already rendered) counts toward neither.
        } catch (err) {
          unavailable += 1;
          console.warn('[MarkNote] Restore failed for one annotation:', err);
        }
      }
    } catch (err) {
      console.warn('[MarkNote] Restore read failed:', err);
    } finally {
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
        }
      } catch (e) {
        // ignore
      }
      try {
        window.scrollTo(scrollX, scrollY);
      } catch (e) {
        // ignore
      }
      isRestoring = false;
    }
    if (restored > 0) {
      const msg = `${restored} saved annotation${restored === 1 ? '' : 's'} restored`;
      console.log(`[MarkNote] ${msg} (${unavailable} unavailable).`);
      showRestoreStatus(msg);
    } else if (unavailable > 0) {
      console.log(`[MarkNote] No annotations restored (${unavailable} unavailable, kept stored).`);
    }
    return { restored, unavailable };
  }

  function showRestoreStatus(message) {
    try {
      let el = document.getElementById(RESTORE_STATUS_ID);
      if (!el) {
        el = document.createElement('div');
        el.id = RESTORE_STATUS_ID;
        el.setAttribute('data-marknote', 'restore-status');
        el.setAttribute('role', 'status');
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = message;
      el.style.display = 'block';
      if (restoreStatusTimer) {
        clearTimeout(restoreStatusTimer);
      }
      restoreStatusTimer = setTimeout(hideRestoreStatus, 4500);
    } catch (e) {
      console.warn('[MarkNote] Could not show restore status:', e);
    }
  }

  function hideRestoreStatus() {
    if (restoreStatusTimer) {
      clearTimeout(restoreStatusTimer);
      restoreStatusTimer = null;
    }
    const el = document.getElementById(RESTORE_STATUS_ID);
    if (el) {
      el.remove();
    }
  }

  // ---------- Guards / helpers (unchanged) ----------

  function isMarkNoteUI(target) {
    if (!target || !target.closest) {
      const parent = target && target.parentElement;
      return !!(parent && parent.closest && parent.closest('[data-marknote]'));
    }
    return !!target.closest('[data-marknote]');
  }

  function nodeInUI(node) {
    if (!node) {
      return false;
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !el.closest) {
      return false;
    }
    return !!el.closest('#marknote-toolbar, #marknote-indicator, [data-marknote]');
  }

  function isRangeInMarkNoteUI(range) {
    if (nodeInUI(range.startContainer) || nodeInUI(range.endContainer)) {
      return true;
    }
    const ancestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    return !!(ancestor && ancestor.closest && ancestor.closest('[data-marknote]'));
  }

  function isRangeInSkipContainer(range) {
    const ancestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!ancestor || !ancestor.closest) {
      return false;
    }
    return !!ancestor.closest('input, textarea, select, [contenteditable="true"], video, audio, img, svg, canvas, iframe');
  }

  function clearSelection() {
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
      }
    } catch (e) {
      // Non-fatal.
    }
  }

  // Page load: check storage for this URL and prepare — read-only, no DOM writes.
  // Highlights and note markers render only after the user activates MarkNote.
  preloadAnnotations().catch((err) => console.warn('[MarkNote] Preload failed:', err));
})();
