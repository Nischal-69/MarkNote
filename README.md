# MarkNote — PDF & Web Highlighter + Notes

> v0.6.0 — 7-day annotation expiration (vanilla JS, chrome.storage.local, no backend, no PDF yet).

## Scope of v0.6.0

Annotations expire 7 days after creation. Keeps all v0.1–v0.5 behavior otherwise.

What works (new/changed in v0.6.0):

- `expiresAt = createdAt + 7 days` on every save (timestamp-based `Date.now()` — restarts never reset it); editing a note preserves both stamps
- New helpers `isExpired()` / `purgeExpired()` in `storage/storage.js` (shared via `globalThis` with popup + service worker)
- Sweep points: service-worker startup/install, content-script page preload, content-script activation, popup open — expired deleted, only valid restored
- Missing `expiresAt` is backfilled (`createdAt + 7d`), never surprise-deleted
- Popup shows `Annotations: N` (valid count after sweep) + `Saved for 7 days`

## Scope of v0.5.0 (kept)

Pages stay untouched until the user activates MarkNote. Keeps all v0.1–v0.4 behavior otherwise.

What works (new/changed in v0.5.0):

- Page load only preloads (read-only `getAnnotations`) — zero DOM writes before activation
- Activation restores this URL's annotations: highlight + `📝` markers, matched by URL + selectedText + surroundingText (+ pageTitle soft signal)
- Fuzzy offsets tolerate whitespace/case drift; word-overlap scoring picks the best slot for duplicate text; cross-node fallback via bounded `window.find` walk
- Not found → kept stored, page untouched, counted as unavailable (console warning, never deleted)
- Guards: per-id skip (no duplicates on re-activation), `isRestoring` flag + per-run caps (no infinite loops), scroll/selection preserved
- Toast `#marknote-restore-status`: `"N saved annotations restored"` only when N > 0

## Scope of v0.4.0 (kept)

Makes highlights + notes survive refresh / browser restart. Keeps all v0.1–v0.3 UI behavior.

What works (new in v0.4.0):

- `storage/storage.js` (loaded before content script): `saveAnnotation()` / `getAnnotations()` / `updateAnnotation()` / `deleteAnnotation()` on key `marknote_annotations`
- Annotation model: `{ id, url, pageTitle, selectedText, surroundingText, note, highlightColor, createdAt, expiresAt }` (+ `type`)
- Highlight → `saveAnnotation({type:'highlight', note:''})`, tags marks with `data-annotation-id`
- Note save/edit/delete → save/update/delete in storage; in-memory `Map` is only a cache
- Page load auto-restores this page's annotations (exact-node match, then `window.find` fallback for cross-node)
- `expiresAt` stored (+7 days) but NOT enforced — no deletion system in this batch

## Scope of v0.3.0 (kept)

## Scope of v0.2.0 (kept)

## Scope of v0.1.0 (kept)

Foundation only. No highlighting, no notes, no PDF handling, no storage, no backend.

What works:

- Popup UI with **Activate Highlighter** button
- Popup → active tab message (`MARKNOTE_ACTIVATE`)
- Content script enters active state + shows **"MarkNote Active"** indicator
- Background service worker with clean message-handling scaffold

## Project Structure

```text
marknote/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── content.js
│   └── content.css
├── storage/
│   └── storage.js
├── background/
│   └── background.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `marknote/` folder (the one containing `manifest.json`)
5. Pin MarkNote to the toolbar if desired (puzzle icon → pin)

## Test "Activate Highlighter"

1. Go to any normal website (e.g. `https://example.com`)
   - It will NOT work on `chrome://`, `edge://`, `about:`, or the Chrome Web Store (Chrome blocks content scripts there).
2. Click the MarkNote toolbar icon
3. Verify popup shows:
   - Title: **MarkNote**
   - Subtitle: **PDF & Web Highlighter + Notes**
   - Text: **Highlight text and add notes while reading.**
   - Button: **Activate Highlighter**
4. Click **Activate Highlighter**
   - Popup should close
   - A dark pill badge **"MarkNote Active ×"** appears top-right of the page
5. If it doesn't appear, reload the page (after first install/load unpacked) and try again.

## Test Web Highlighting (v0.2.0)

1. Activate MarkNote (above) — indicator `MarkNote Active ×` must be visible.
2. Select text: drag over a paragraph on a normal article page (e.g. Wikipedia).
   - A small floating toolbar appears near the selection: `🟡 Highlight` + `📝 Note`.
   - Empty selection (single click, no drag) → no toolbar.
   - Selecting inside the toolbar/indicator itself → no toolbar.
3. Highlight it: click `🟡 Highlight`.
   - Selected text turns yellow (`mark.marknote-highlight`), page does not reload.
   - Toolbar disappears, selection clears.
   - Clicking `📝 Note` opens the note editor (v0.3.0).
   - Re-selecting an already-highlighted span does not double-wrap it.
4. Deactivate MarkNote: click `×` in the indicator.
   - Indicator + toolbar disappear, page `marknote-active` class removed.
   - Existing yellow highlights stay on the page (persisted; reappear on next activation after refresh).
   - Selecting text now shows no toolbar.
   - Re-activate anytime via the popup button (already-rendered ids skip, no duplicates).

## Test Expiry (v0.6.0)

1. Highlight + note as usual → popup shows `Annotations: N` growing.
2. To simulate expiry, age one annotation in the page console:
   ```js
   const S = window.MarkNoteStorage;
   const all = await S.getAnnotations(location.href);
   const m = (await chrome.storage.local.get(S.STORAGE_KEY))[S.STORAGE_KEY];
   m[all[0].id].expiresAt = Date.now() - 1000;
   await chrome.storage.local.set({ [S.STORAGE_KEY]: m });
   ```
3. Refresh → activate → the aged annotation is gone (deleted by the sweep, never restored); valid ones restore with the toast.
4. Restart Chrome → counts and remaining annotations persist; the 7-day clock kept running (no reset).

## Test Persistence (v0.4.0, gated since v0.5.0)

1. Highlight a sentence + create a note with text (above).
2. Refresh the page — page is untouched (no yellow) until you click **Activate Highlighter** → yellow + `📝` marker reappear with toast `2 saved annotations restored`.
3. Close Chrome completely, reopen the same URL, activate → annotations still there.
4. Edit a note via marker → refresh → activate → edited text kept. Delete → refresh → activate → stays deleted (no toast when zero).
5. Inspect data (see below) to confirm `chrome.storage.local`.

## Inspecting stored data (development)

- **Option A — Extension storage page:** open `chrome://extensions` → enable Developer mode → MarkNote **Inspect views: service worker** (or any page console) → Application/Storage is not available in service-worker DevTools, so use console:
  ```js
  chrome.storage.local.get('marknote_annotations').then(r => console.log(r.marknote_annotations));
  ```
- **Option B — Page console:** on any MarkNote-enabled page, run:
  ```js
  window.MarkNoteStorage.getAnnotations(location.href).then(a => console.log(a));
  ```
- **Option C — Clear during testing:**
  ```js
  chrome.storage.local.remove('marknote_annotations');
  ```
  then refresh — page should show no restored highlights.
- Data shape per annotation:
  ```json
  { "id": "mn-...", "url": "https://... (no #hash)", "pageTitle": "...", "selectedText": "...", "surroundingText": "...", "note": "", "highlightColor": "yellow", "type": "highlight|note", "createdAt": 123, "expiresAt": 123 }
  ```

## Test Session Notes (v0.3.0, now persistent)

1. Activate MarkNote, select a sentence (e.g. `TCP provides reliable communication.`).
   - Toolbar appears → click `📝 Note`.
   - Editor appears near selection with `Selected: "TCP provides..."`, textarea `Write your note...`, Save/Cancel.
2. Type `Important for my CN exam...` → Save.
   - Text turns yellow, small `📝` marker appears right after it, editor closes.
   - Cancel/Esc discards without a marker.
3. Click the `📝` marker → viewer shows preview + note + Edit/Delete/Close.
   - Edit → textarea prefilled → Save updates, Cancel back to view.
   - Delete → marker + its yellow marks removed (plain highlights untouched).
4. Reload the page → activate → notes persist (v0.4.0 storage, v0.5.0 gated restore).

## Troubleshooting

- **"Cannot activate on this page"** → you are on a restricted `chrome://` page. Switch to a normal site.
- **No indicator / "Could not establish connection"** in popup → reload the target tab, then reload the extension at `chrome://extensions` → try again.
- **Check logs:** right-click popup → Inspect, or `chrome://extensions` → *Inspect views: service worker* for background logs, or page DevTools console for `[MarkNote]` logs.

## Next Steps (not in v0.4.0)

- 7-day expiry enforcement
- PDF support
#   M a r k N o t e - P D F - W e b - H i g h l i g h t e r - N o t e s  
 