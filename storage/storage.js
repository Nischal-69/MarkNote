// MarkNote Storage Helper — v0.6.0
// Separate from UI logic. Single responsibility: persist annotations in chrome.storage.local.
// No DOM access here. Content script, popup, and background use globalThis.MarkNoteStorage.
// Data survives page refresh / browser restart. No backend.
// Expiry: expiresAt = createdAt + 7 days (timestamp-based, survives restarts).
// purgeExpired() deletes expired annotations; callers invoke it on start/activation.

(function () {
  'use strict';

  const STORAGE_KEY = 'marknote_annotations';
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_SELECTED = 2000;
  const MAX_SURROUNDING = 2000;
  const MAX_NOTE = 5000;

  function normalizeUrl(url) {
    try {
      return String(url || '').split('#')[0];
    } catch (e) {
      return String(url || '');
    }
  }

  function makeId() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') {
        return `mn-${crypto.randomUUID()}`;
      }
    } catch (e) {
      // fall through
    }
    return `mn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function cap(str, max) {
    const s = String(str == null ? '' : str);
    return s.length > max ? s.slice(0, max) : s;
  }

  async function readMap() {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const map = res && res[STORAGE_KEY];
    return map && typeof map === 'object' ? map : {};
  }

  async function writeMap(map) {
    await chrome.storage.local.set({ [STORAGE_KEY]: map });
  }

  function withDefaults(input) {
    const now = Date.now();
    const src = input && typeof input === 'object' ? input : {};
    const note = cap((src.note || '').trim(), MAX_NOTE);
    const createdAt = Number(src.createdAt) || now;
    const expiresAt = Number(src.expiresAt) || createdAt + SEVEN_DAYS_MS;
    return {
      id: src.id ? String(src.id) : makeId(),
      url: normalizeUrl(src.url || ''),
      pageTitle: cap(src.pageTitle || '', 300),
      selectedText: cap((src.selectedText || '').trim(), MAX_SELECTED),
      surroundingText: cap(src.surroundingText || '', MAX_SURROUNDING),
      note,
      highlightColor: src.highlightColor || 'yellow',
      type: src.type || (note ? 'note' : 'highlight'),
      createdAt,
      expiresAt,
    };
  }

  // True when the annotation is expired at `now` (defaults to Date.now()).
  // Missing/invalid expiresAt is NOT treated as expired — it gets backfilled
  // on purge instead, so legacy or hand-edited entries are never surprise-deleted.
  function isExpired(annotation, now) {
    const t = now === undefined ? Date.now() : now;
    const exp = annotation && Number(annotation.expiresAt);
    return Number.isFinite(exp) && exp <= t;
  }

  // Delete all expired annotations across every URL. Returns { purged, kept }.
  // Timestamp-based (Date.now), so closing/reopening Chrome never resets the timer.
  async function purgeExpired(now) {
    const t = now === undefined ? Date.now() : now;
    const map = await readMap();
    let purged = 0;
    let backfilled = 0;
    for (const id of Object.keys(map)) {
      const a = map[id];
      if (!a || typeof a !== 'object') {
        delete map[id];
        purged += 1;
        continue;
      }
      const exp = Number(a.expiresAt);
      if (!Number.isFinite(exp)) {
        const created = Number(a.createdAt);
        a.expiresAt = (Number.isFinite(created) ? created : t) + SEVEN_DAYS_MS;
        backfilled += 1;
        continue;
      }
      if (exp <= t) {
        delete map[id];
        purged += 1;
      }
    }
    if (purged > 0 || backfilled > 0) {
      await writeMap(map);
    }
    return { purged, kept: Object.keys(map).length, backfilled };
  }
  // Save a new annotation. Returns the stored annotation.
  // expiresAt is always createdAt + 7 days (timestamp-based, survives restarts).
  async function saveAnnotation(input) {
    const annotation = withDefaults(input);
    if (!annotation.selectedText) {
      throw new Error('Cannot save annotation with empty selectedText.');
    }
    const map = await readMap();
    map[annotation.id] = annotation;
    await writeMap(map);
    return annotation;
  }

  // Get annotations, optionally filtered to one normalized page URL. Sorted oldest-first.
  // NOTE: does not purge; callers run purgeExpired() on start/activation, then
  // restore only the valid (non-expired) annotations returned here.
  async function getAnnotations(url) {
    const map = await readMap();
    let all = Object.values(map);
    if (url) {
      const target = normalizeUrl(url);
      all = all.filter((a) => normalizeUrl(a && a.url) === target);
    }
    all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return all;
  }

  // Merge a patch into an existing annotation. Returns the updated annotation.
  async function updateAnnotation(id, patch) {
    if (!id) {
      throw new Error('updateAnnotation requires an id.');
    }
    const map = await readMap();
    const current = map[id];
    if (!current) {
      throw new Error(`Annotation not found: ${id}`);
    }
    const p = patch && typeof patch === 'object' ? patch : {};
    const updated = {
      ...current,
      ...p,
      id: current.id, // immutable
      createdAt: current.createdAt, // immutable — editing never resets the 7-day timer
      expiresAt: current.expiresAt, // immutable — editing never extends the 7-day timer
      url: p.url ? normalizeUrl(p.url) : current.url,
      note: p.note !== undefined ? cap(String(p.note).trim(), MAX_NOTE) : current.note,
      selectedText: p.selectedText !== undefined ? cap(String(p.selectedText).trim(), MAX_SELECTED) : current.selectedText,
      surroundingText: p.surroundingText !== undefined ? cap(String(p.surroundingText), MAX_SURROUNDING) : current.surroundingText,
      type: p.type || current.type || (p.note || current.note ? 'note' : 'highlight'),
    };
    map[id] = updated;
    await writeMap(map);
    return updated;
  }

  // Remove one annotation. Returns true if it existed.
  async function deleteAnnotation(id) {
    if (!id) {
      return false;
    }
    const map = await readMap();
    if (!Object.prototype.hasOwnProperty.call(map, id)) {
      return false;
    }
    delete map[id];
    await writeMap(map);
    return true;
  }

  // Works in pages, popups, and the service worker (no `window` dependency).
  const scope = typeof globalThis !== 'undefined' ? globalThis : this;
  scope.MarkNoteStorage = {
    STORAGE_KEY,
    SEVEN_DAYS_MS,
    normalizeUrl,
    isExpired,
    purgeExpired,
    saveAnnotation,
    getAnnotations,
    updateAnnotation,
    deleteAnnotation,
  };
})();
