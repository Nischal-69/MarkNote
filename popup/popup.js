// MarkNote Popup — v0.6.0 (activation + annotation count)
// Responsibility: send activation message to the active tab, then close.
// Also shows the stored annotation count (expired ones swept first).

document.addEventListener('DOMContentLoaded', () => {
  const activateBtn = document.getElementById('activateBtn');
  const infoBtn = document.getElementById('infoBtn');
  const infoPanel = document.getElementById('infoPanel');
  const statusMsg = document.getElementById('statusMsg');
  const annotationCount = document.getElementById('annotationCount');

  refreshAnnotationCount().catch((err) => {
    console.warn('[MarkNote] Count refresh failed:', err);
    if (annotationCount) {
      annotationCount.textContent = 'Annotations: —';
    }
  });

  // Settings/info placeholder — not implemented yet.
  infoBtn.addEventListener('click', () => {
    infoPanel.classList.toggle('hidden');
  });

  activateBtn.addEventListener('click', async () => {
    setStatus('');
    activateBtn.disabled = true;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || tab.id === undefined) {
        throw new Error('No active tab found.');
      }

      // Restricted pages (chrome://, edge://, Chrome Web Store, etc.)
      // cannot receive messages from content scripts.
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
        throw new Error('Cannot activate on this page. Try a normal website.');
      }

      await chrome.tabs.sendMessage(tab.id, { type: 'MARKNOTE_ACTIVATE' });

      // Close popup after successful handoff.
      window.close();
    } catch (err) {
      console.warn('[MarkNote] Activate failed:', err);
      setStatus(err.message || 'Could not activate. Try reloading the page.', true);
      activateBtn.disabled = false;
    }
  });

  function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.classList.toggle('error', isError);
  }

  // Sweep expired annotations, then show how many valid ones remain stored.
  async function refreshAnnotationCount() {
    if (!annotationCount) {
      return;
    }
    const storage = globalThis.MarkNoteStorage;
    if (!storage) {
      annotationCount.textContent = 'Annotations: —';
      return;
    }
    try {
      await storage.purgeExpired();
    } catch (err) {
      console.warn('[MarkNote] Expiry sweep failed:', err);
    }
    const all = await storage.getAnnotations();
    annotationCount.textContent = `Annotations: ${all.length}`;
  }
});
