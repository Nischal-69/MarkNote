// MarkNote Background Service Worker (MV3) — v0.12.0 production review
// Storage lives in chrome.storage.local; expiry is enforced here on browser/
// extension start plus in the content script on page load/activation.
// Timestamp-based (Date.now) — restarts never reset the 7-day timer. No backend.
// PDF detection lives in pdf/pdf-detector.js; no PDF highlighting yet.

const MARKNOTE_VERSION = '0.12.0';

try {
  importScripts('../storage/storage.js');
} catch (e) {
  console.warn('[MarkNote] Storage helper failed to load in worker:', e);
}

async function sweepExpired(reason) {
  try {
    const storage = globalThis.MarkNoteStorage;
    if (!storage || !storage.purgeExpired) {
      return;
    }
    const result = await storage.purgeExpired();
    if (result.purged > 0) {
      console.log(`[MarkNote] Startup sweep (${reason}): removed ${result.purged} expired annotation(s), ${result.kept} kept.`);
    }
  } catch (err) {
    console.warn('[MarkNote] Startup sweep failed:', err);
  }
}

chrome.runtime.onStartup.addListener(() => {
  sweepExpired('browser startup');
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[MarkNote] Installed v${MARKNOTE_VERSION}:`, details.reason);
  sweepExpired(`installed (${details.reason})`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  switch (message.type) {
    case 'MARKNOTE_PING':
      sendResponse({ ok: true, version: MARKNOTE_VERSION });
      return false;

    // Future message types go here:
    // case 'MARKNOTE_GET_STATE': ...

    default:
      // Unknown message — ignore cleanly.
      return false;
  }
});
