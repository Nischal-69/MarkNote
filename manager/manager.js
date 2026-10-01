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
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = all.length === 0
        ? 'No saved annotations yet. Highlight text on any page to start.'
        : 'No annotations match your search.';
      list.appendChild(empty);
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
    const domain = document.createElement('span');
    domain.className = 'card-domain';
    domain.textContent = domainOf(a.url);
    domain.title = a.url || '';
    top.appendChild(title);
    top.appendChild(domain);
    el.appendChild(top);

    const quote = document.createElement('p');
    quote.className = 'card-quote';
    quote.textContent = `\u201C${collapse(a.selectedText)}\u201D`;
    el.appendChild(quote);

    if (a.note) {
      const label = document.createElement('p');
      label.className = 'card-note-label';
      label.textContent = 'My note';
      const note = document.createElement('p');
      note.className = 'card-note';
      note.textContent = a.note;
      el.appendChild(label);
      el.appendChild(note);
    }

    const meta = document.createElement('p');
    meta.className = 'card-meta';
    meta.appendChild(document.createTextNode(`Created ${formatDate(a.createdAt)} · `));
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

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open page';
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

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = a.note ? 'Edit note' : 'Add note';
    editBtn.addEventListener('click', () => startEdit(el, a));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy text';
    copyBtn.addEventListener('click', () => copyText(a.selectedText, copyBtn));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
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
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
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
        await globalThis.MarkNoteStorage.updateAnnotation(a.id, { note: next });
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
    const label = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = label; }, 1200);
  }

  // ---------- Helpers ----------

  function isWeb(a) {
    if (!a) {
      return false;
    }
    if (a.type === 'pdf') {
      return false;
    }
    return !/\.pdf($|[?#])/i.test(a.url || '');
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
