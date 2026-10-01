// MarkNote Popup — v0.9.0 polished UI + manager entry + PDF detection.
// Read-only dashboard: activation handoff, live counts, active status, notes list.
// PDF tabs are identified (never force-activated); core logic untouched.

document.addEventListener('DOMContentLoaded', () => {
  const activateBtn = document.getElementById('activateBtn');
  const viewerBtn = document.getElementById('viewerBtn');
  const statusMsg = document.getElementById('statusMsg');
  const activePill = document.getElementById('activePill');
  const activePillText = document.getElementById('activePillText');
  const totalCount = document.getElementById('totalCount');
  const pageCount = document.getElementById('pageCount');
  const viewNotesBtn = document.getElementById('viewNotesBtn');
  const notesList = document.getElementById('notesList');
  const managerBtn = document.getElementById('managerBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const pdfMsg = document.getElementById('pdfMsg');

  let currentTab = null;
  let isActive = false;
  let stateKnown = false;
  let pdfLocked = false;

  init().catch((err) => console.warn('[MarkNote] Popup init failed:', err));

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = tab || null;
    } catch (err) {
      console.warn('[MarkNote] No active tab:', err);
    }

    // Counts and status load independently — one failure never blocks the rest.
    refreshCounts().catch((err) => console.warn('[MarkNote] Count refresh failed:', err));
    refreshActiveState().catch((err) => console.warn('[MarkNote] State refresh failed:', err));
    refreshPdfState().catch((err) => console.warn('[MarkNote] PDF check failed:', err));
  }

  activateBtn.addEventListener('click', async () => {
    setStatus('');
    activateBtn.disabled = true;

    try {
      if (!currentTab || currentTab.id === undefined) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTab = tab || null;
      }
      if (!currentTab || currentTab.id === undefined) {
        throw new Error('No active tab found.');
      }
      if (currentTab.url && isRestrictedUrl(currentTab.url)) {
        throw new Error('Cannot activate on this page. Try a normal website.');
      }
      // Viewer-owned PDFs can never accept web highlighting — fail fast
      // with a clear message instead of a connection error.
      const pdf = globalThis.MarkNotePdf;
      if (pdf && currentTab.url) {
        if (currentTab.url.startsWith(chrome.runtime.getURL('pdf/viewer.html'))) {
          throw new Error('This PDF is already open in MarkNote. Use Activate in the viewer bar.');
        }
        const kind = pdf.classifyTabUrl(currentTab.url).kind;
        if (kind === 'direct-pdf' || kind === 'chrome-viewer') {
          throw new Error('This is a PDF document. Open it in MarkNote to annotate it.');
        }
      }

      if (stateKnown && isActive) {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'MARKNOTE_DEACTIVATE' });
        isActive = false;
        renderActiveState();
        renderActivateBtn();
      } else {
        await chrome.tabs.sendMessage(currentTab.id, { type: 'MARKNOTE_ACTIVATE' });
        window.close();
        return;
      }
    } catch (err) {
      console.warn('[MarkNote] Activate failed:', err);
      setStatus(err.message || 'Could not activate. Try reloading the page.', true);
    }
    activateBtn.disabled = false;
  });

  viewNotesBtn.addEventListener('click', async () => {
    const open = notesList.classList.toggle('open');
    viewNotesBtn.setAttribute('aria-expanded', String(open));
    viewNotesBtn.textContent = open ? 'Hide Notes' : 'View Notes';
    if (open) {
      await renderNotesList().catch((err) => {
        console.warn('[MarkNote] Notes list failed:', err);
        notesList.innerHTML = '';
        const empty = document.createElement('p');
        empty.className = 'notes-empty';
        empty.textContent = 'Could not load notes.';
        notesList.appendChild(empty);
      });
    }
  });

  viewerBtn.addEventListener('click', () => {
    if (!currentTab || !currentTab.url) {
      return;
    }
    chrome.tabs.create({
      url: `${chrome.runtime.getURL('pdf/viewer.html')}?file=${encodeURIComponent(currentTab.url)}`,
    });
    window.close();
  });

  managerBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
  });

  settingsBtn.addEventListener('click', () => {
    const hidden = settingsPanel.classList.toggle('hidden');
    settingsBtn.setAttribute('aria-expanded', String(!hidden));
  });

  function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.classList.toggle('error', isError);
  }

  function isRestrictedUrl(url) {
    return url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:');
  }

  // Sweep expired, then show total saved + this-page counts.
  async function refreshCounts() {
    const storage = globalThis.MarkNoteStorage;
    if (!storage) {
      totalCount.textContent = '–';
      pageCount.textContent = '–';
      return;
    }
    try {
      await storage.purgeExpired();
    } catch (err) {
      console.warn('[MarkNote] Expiry sweep failed:', err);
    }
    const [all, page] = await Promise.all([
      storage.getAnnotations().catch(() => []),
      storage.getAnnotations(currentTab && currentTab.url ? currentTab.url : '').catch(() => []),
    ]);
    totalCount.textContent = String(all.length);
    pageCount.textContent = currentTab && currentTab.url && !isRestrictedUrl(currentTab.url)
      ? String(page.length)
      : '–';
  }

  async function refreshActiveState() {
    if (!currentTab || currentTab.id === undefined) {
      renderUnknownState();
      return;
    }
    if (currentTab.url && isRestrictedUrl(currentTab.url)) {
      renderUnknownState();
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(currentTab.id, { type: 'MARKNOTE_GET_STATE' });
      isActive = !!(res && res.active);
      stateKnown = true;
    } catch (err) {
      // No content script on this page (not yet injected, or blocked page).
      renderUnknownState();
      return;
    }
    renderActiveState();
    renderActivateBtn();
  }

  function renderActiveState() {
    if (pdfLocked) {
      return;
    }
    activePill.classList.remove('is-loading');
    activePill.classList.toggle('is-active', isActive);
    activePillText.textContent = isActive ? 'Active' : 'Idle';
  }

  function renderUnknownState() {
    if (pdfLocked) {
      return;
    }
    stateKnown = false;
    activePill.classList.remove('is-loading', 'is-active');
    activePillText.textContent = 'N/A';
    renderActivateBtn();
  }

  function renderActivateBtn() {
    activateBtn.textContent = stateKnown && isActive
      ? 'Deactivate Highlighter'
      : '🟡 Activate Highlighter';
  }

  // Identify PDF contexts. Viewer-owned pages can never accept web
  // highlighting, so activation is disabled there with an explanation.
  // Embedded-PDF host pages stay fully usable for web highlighting.
  async function refreshPdfState() {
    const pdf = globalThis.MarkNotePdf;
    if (!pdf || !currentTab || !currentTab.url) {
      return;
    }
    const info = pdf.classifyTabUrl(currentTab.url);
    if (currentTab.url.startsWith(chrome.runtime.getURL('pdf/viewer.html'))) {
      renderPdfState('This PDF is already open in MarkNote — use Activate in the viewer bar.', true, false);
      return;
    }
    if (info.kind === 'direct-pdf' || info.kind === 'chrome-viewer') {
      renderPdfState('PDF document detected — open it in MarkNote to highlight text and add notes.', true, info.kind === 'direct-pdf');
      return;
    }
    if (info.kind !== 'web' || currentTab.id === undefined) {
      return;
    }
    // Ordinary page: ask the content script whether it embeds any PDFs.
    try {
      const res = await chrome.tabs.sendMessage(currentTab.id, { type: 'MARKNOTE_PDF_SCAN' });
      const embedded = res && res.embedded ? res.embedded : [];
      if (embedded.length > 0) {
        renderPdfState(
          `This page embeds ${embedded.length} PDF${embedded.length === 1 ? '' : 's'} — activating highlights the page around it; the embedded document stays untouched.`,
          false
        );
      }
    } catch (err) {
      // No content script on this page — nothing to report.
    }
  }

  function renderPdfState(message, disableActivate = true, offerViewer = false) {
    pdfLocked = true;
    activePill.classList.remove('is-loading', 'is-active');
    activePill.classList.add('is-pdf');
    activePillText.textContent = 'PDF';
    pdfMsg.textContent = message;
    pdfMsg.classList.remove('hidden');
    if (disableActivate) {
      activateBtn.disabled = true;
      // Offer the supported path: open the PDF in MarkNote's own viewer.
      if (offerViewer) {
        activateBtn.style.display = 'none';
        viewerBtn.classList.remove('hidden');
      }
    }
  }

  // Read-only list of this page's annotations (highlights + notes).
  async function renderNotesList() {
    notesList.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'notes-inner';
    const items = document.createElement('div');
    items.className = 'notes-items';
    wrap.appendChild(items);
    notesList.appendChild(wrap);

    const storage = globalThis.MarkNoteStorage;
    if (!storage || !currentTab || !currentTab.url || isRestrictedUrl(currentTab.url)) {
      const empty = document.createElement('p');
      empty.className = 'notes-empty';
      empty.textContent = 'No annotations on this page yet.';
      items.appendChild(empty);
      return;
    }

    let page = [];
    try {
      await storage.purgeExpired();
      page = await storage.getAnnotations(currentTab.url);
    } catch (err) {
      throw err;
    }

    if (page.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notes-empty';
      empty.textContent = 'No annotations on this page yet.';
      items.appendChild(empty);
      return;
    }

    for (const a of page) {
      const card = document.createElement('div');
      card.className = 'note-card';

      const quote = document.createElement('p');
      quote.className = 'note-quote';
      quote.textContent = `\u201C${collapse(a.selectedText)}\u201D`;
      card.appendChild(quote);

      if (a.note) {
        const text = document.createElement('p');
        text.className = 'note-text';
        text.textContent = a.note;
        card.appendChild(text);
      }

      const meta = document.createElement('p');
      meta.className = 'note-meta';
      meta.textContent = `${a.type === 'note' ? 'Note' : 'Highlight'} · ${daysLeft(a)}`;
      card.appendChild(meta);

      items.appendChild(card);
    }
  }

  function collapse(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function daysLeft(a) {
    const ms = Number(a.expiresAt) - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) {
      return 'expires today';
    }
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
    return days === 1 ? '1 day left' : `${days} days left`;
  }
});
