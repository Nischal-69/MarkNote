// MarkNote Notes Manager — v0.8.0.
// Read/write list over chrome.storage.local via shared MarkNoteStorage.
// Vanilla JS, textContent-only rendering. No PDF support.

(function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const SOON_MS = 2 * DAY_MS; // "Expiring Soon" threshold.

  const searchInput = document.getElementById('searchInput');
  const countLine = document.getElementById('countLine');
  const statusMsg = document.getElementById('statusMsg');
  const list = document.getElementById('list');
  const filterBtns = Array.from(document.querySelectorAll('.filter'));

  let all = [];
  let query = '';
  let filter = 'all';
  let statusTimer = null;

  // Inline SVG icons (presentation only — no logic depends on button content).
  const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  const SVG_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>';
  const SVG_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const SVG_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  const SVG_SAVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  const SVG_CANCEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const SVG_EMPTY = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';

  // Build an icon + text action button. Label changes go through the
  // inner span so the SVG is never disturbed.
  function actionBtn(icon, label, className) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (className) {
      btn.className = className;
    }
    btn.innerHTML = `${icon}<span class="btn-label"></span>`;
    btn.querySelector('.btn-label').textContent = label;
    btn.setAttribute('aria-label', label);
    return btn;
  }

  function setBtnLabel(btn, text) {
    const label = btn.querySelector('.btn-label');
    if (label) {
      label.textContent = text;
    } else {
      btn.textContent = text;
    }
    btn.setAttribute('aria-label', text);
  }

  // Structured empty state. Same branches/conditions as before, only markup.
  function showEmpty(kind) {
    list.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = SVG_EMPTY;
    const title = document.createElement('p');
    title.className = 'empty-title';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    if (kind === 'error') {
      title.textContent = 'Could not load annotations';
      sub.textContent = 'Check storage access and try again.';
    } else if (kind === 'nomatch') {
      title.textContent = 'No matching annotations';
      sub.textContent = 'Try a different search or filter.';
    } else {
      title.textContent = 'No saved annotations';
      sub.textContent = 'Your highlights and notes will appear here.';
    }
    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(sub);
    list.appendChild(wrap);
  }

  init().catch((err) => {
    console.warn('[MarkNote] Manager init failed:', err);
    setStatus('Could not load annotations.');
  });

  async function init() {
    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        filter = btn.dataset.filter;
        filterBtns.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-selected', String(on));
        });
        render();
      });
    });

    searchInput.addEventListener('input', () => {
      query = searchInput.value.trim().toLowerCase();
      render();
    });

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        const key = globalThis.MarkNoteStorage && globalThis.MarkNoteStorage.STORAGE_KEY;
        if (area === 'local' && key && changes && Object.prototype.hasOwnProperty.call(changes, key)) {
          reload().catch((err) => console.warn('[MarkNote] Reload failed:', err));
        }
      });
    }

    await reload();
  }

  async function reload() {
    const storage = globalThis.MarkNoteStorage;
    if (!storage) {
      setStatus('Storage helper missing. Reload the extension.');
      return;
    }
    try {
      await storage.purgeExpired();
      all = await storage.getAnnotations();
    } catch (err) {
      console.warn('[MarkNote] Load failed:', err);
      showEmpty('error');
      setStatus('Could not load annotations.');
      return;
    }
    render();
  }

  function visible() {
    const q = query;
    return all
      .filter((a) => {
        if (filter === 'web' && !isWeb(a)) {
          return false;
        }
        if (filter === 'pdf' && !isPdf(a)) {
          return false;
        }
        if (filter === 'soon' && remainingMs(a) > SOON_MS) {
          return false;
        }
        if (!q) {
          return true;
        }
        return (
          contains(a.pageTitle, q) ||
          contains(a.url, q) ||
          contains(domainOf(a.url), q) ||
          contains(a.selectedText, q) ||
          contains(a.note, q)
        );
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function render() {
    list.innerHTML = '';
    const items = visible();
    countLine.textContent = query || filter !== 'all'
      ? `${items.length} of ${all.length} annotations`
      : `${all.length} annotation${all.length === 1 ? '' : 's'}`;

    if (items.length === 0) {
      showEmpty(all.length === 0 ? 'empty' : 'nomatch');
      return;
    }

    const frag = document.createDocumentFragment();
    for (const a of items) {
      frag.appendChild(card(a));
    }
    list.appendChild(frag);
  }

  function card(a) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.id = a.id;

    const top = document.createElement('div');
    top.className = 'card-top';
    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = a.pageTitle || '(Untitled page)';
    title.title = a.pageTitle || '';
    const badge = document.createElement('span');
    const pdfKind = isPdf(a);
    badge.className = `badge ${pdfKind ? 'pdf' : 'web'}`;
    badge.textContent = pdfKind ? 'PDF' : 'WEB';
    badge.title = pdfKind ? 'PDF document' : 'Web page';
    const domain = document.createElement('span');
    domain.className = 'card-domain';
    domain.textContent = domainOf(a.url);
    domain.title = a.url || '';
    top.appendChild(title);
    top.appendChild(badge);
    top.appendChild(domain);
    el.appendChild(top);

    const quote = document.createElement('p');
    quote.className = 'card-quote';
    quote.textContent = `\u201C${collapse(a.selectedText)}\u201D`;
    el.appendChild(quote);

    if (a.note) {
      const label = document.createElement('p');
      label.className = 'card-note-label';
      label.textContent = 'Note';
      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = a.note;
      el.appendChild(label);
      el.appendChild(note);
    }

    const meta = document.createElement('p');
    meta.className = 'card-meta';
    const kindText = a.note ? 'Note' : 'Highlight';
    const pageText = isPdf(a) && Number.isInteger(a.pageNumber) ? ` · Page ${a.pageNumber}` : '';
    meta.appendChild(document.createTextNode(`${kindText}${pageText} · Created ${formatDate(a.createdAt)} · `));
    const remain = document.createElement('span');
    const ms = remainingMs(a);
    if (ms <= SOON_MS) {
      remain.className = 'soon';
    }
    remain.textContent = daysText(ms);
    meta.appendChild(remain);
    el.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const openBtn = actionBtn(SVG_OPEN, 'Open');
    openBtn.title = 'Open page';
    openBtn.addEventListener('click', () => {
      // PDF annotations reopen inside MarkNote's own viewer (restorable);
      // web annotations open the original page.
      if (a.type && a.type.indexOf('pdf-') === 0 && a.pdfUrl) {
        chrome.tabs.create({
          url: `${chrome.runtime.getURL('pdf/viewer.html')}?file=${encodeURIComponent(a.pdfUrl)}`,
        });
      } else if (a.url) {
        chrome.tabs.create({ url: a.url });
      }
    });

    const editBtn = actionBtn(SVG_EDIT, a.note ? 'Edit note' : 'Add note');
    editBtn.addEventListener('click', () => startEdit(el, a));

    const copyBtn = actionBtn(SVG_COPY, 'Copy');
    copyBtn.title = 'Copy text';
    copyBtn.addEventListener('click', () => copyText(a.selectedText, copyBtn));

    const delBtn = actionBtn(SVG_DELETE, 'Delete', 'danger');
    delBtn.addEventListener('click', () => removeItem(el, a));

    actions.appendChild(openBtn);
    actions.appendChild(editBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);
    el.appendChild(actions);

    return el;
  }

  function startEdit(cardEl, a) {
    if (cardEl.querySelector('.card-edit-area')) {
      return;
    }
    const area = document.createElement('textarea');
    area.className = 'card-edit-area';
    area.value = a.note || '';
    area.placeholder = 'Write your note...';
    area.setAttribute('aria-label', 'Edit note');

    const row = document.createElement('div');
    row.className = 'card-actions';
    const save = actionBtn(SVG_SAVE, 'Save');
    const cancel = actionBtn(SVG_CANCEL, 'Cancel');
    row.appendChild(save);
    row.appendChild(cancel);

    const actions = cardEl.querySelector('.card-actions');
    cardEl.insertBefore(area, actions);
    cardEl.insertBefore(row, actions);
    area.focus();

    cancel.addEventListener('click', () => {
      area.remove();
      row.remove();
    });
    save.addEventListener('click', async () => {
      const next = area.value.trim();
      if (!next) {
        area.focus();
        return;
      }
      save.disabled = true;
      try {
        // Adding a first note to a plain highlight promotes its kind so
        // badges, filters, and counts stay consistent.
        const patch = { note: next };
        if (!a.note) {
          patch.type = isPdf(a) ? 'pdf-note' : 'note';
        }
        await globalThis.MarkNoteStorage.updateAnnotation(a.id, patch);
        flash('Note saved.');
        await reload();
      } catch (err) {
        console.warn('[MarkNote] Edit failed:', err);
        flash('Could not save note.');
        save.disabled = false;
      }
    });
  }

  async function removeItem(cardEl, a) {
    if (!window.confirm('Delete this annotation?')) {
      return;
    }
    try {
      await globalThis.MarkNoteStorage.deleteAnnotation(a.id);
      cardEl.remove();
      all = all.filter((x) => x.id !== a.id);
      render();
      flash('Annotation deleted.');
    } catch (err) {
      console.warn('[MarkNote] Delete failed:', err);
      flash('Could not delete annotation.');
    }
  }

  async function copyText(text, btn) {
    const value = collapse(text);
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      // Fallback for contexts without async clipboard access.
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (e) {
        ta.remove();
        flash('Copy failed.');
        return;
      }
      ta.remove();
    }
    const label = btn.querySelector('.btn-label');
    const original = label ? label.textContent : btn.textContent;
    setBtnLabel(btn, 'Copied!');
    setTimeout(() => { setBtnLabel(btn, original); }, 1200);
  }

  // ---------- Helpers ----------

  function isWeb(a) {
    if (!a) {
      return false;
    }
    if (a.type === 'pdf' || isPdf(a)) {
      return false;
    }
    return !/\.pdf($|[?#])/i.test(a.url || '');
  }

  function isPdf(a) {
    return !!a && typeof a.type === 'string' && a.type.indexOf('pdf-') === 0;
  }

  function remainingMs(a) {
    const ms = Number(a.expiresAt) - Date.now();
    return Number.isFinite(ms) ? ms : 0;
  }

  function daysText(ms) {
    if (ms <= 0) {
      return 'expires today';
    }
    const days = Math.ceil(ms / DAY_MS);
    return days === 1 ? '1 day remaining' : `${days} days remaining`;
  }

  function formatDate(ts) {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) {
      return 'unknown date';
    }
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return (url || '').split('/')[0] || 'unknown';
    }
  }

  function collapse(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function contains(field, q) {
    return (field || '').toLowerCase().includes(q);
  }

  function flash(msg) {
    statusMsg.textContent = msg;
    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    statusTimer = setTimeout(() => { statusMsg.textContent = ''; }, 2500);
  }

  function setStatus(msg) {
    statusMsg.textContent = msg;
  }
})();
