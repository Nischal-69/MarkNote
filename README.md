# MarkNote — PDF & Web Highlighter + Notes

**Read, highlight, and remember — right where you read.**

MarkNote is a lightweight Chrome extension for students, researchers, and
curious readers. Select any text on a webpage or inside a PDF, highlight it,
and attach notes without ever leaving the page. Everything lives privately
in your browser: no accounts, no servers, no tracking.

## Why MarkNote?

- 📖 **Highlight while you read** — one drag, one click, and the passage is
  marked in yellow. Links, buttons, and layouts keep working.
- 📝 **Notes that stick to the text** — every note is anchored to the exact
  passage it belongs to, marked with a small 📝 you can click anytime.
- 📄 **Real PDF support** — open PDFs in MarkNote's built-in reader and get
  the same highlight-and-note workflow, page by page.
- 🗂️ **Notes Manager** — every highlight and note in one searchable place,
  with filters, expiry countdowns, and one-click actions.
- 🔒 **Private by design** — your annotations never leave your machine.
- ⏳ **Self-cleaning** — annotations expire automatically after 7 days, so
  old clutter disappears on its own.

## Quick start

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose the `marknote/` folder.
4. Pin MarkNote to your toolbar (puzzle icon → pin).
5. Open any article, click the MarkNote icon, and press
   **🟡 Activate Highlighter**.

## How it works

### Highlight a webpage

1. Activate MarkNote from the popup.
2. Select any text — a small toolbar appears next to your selection.
3. Click **🟡 Highlight**. The passage turns yellow; the toolbar disappears.
4. Click the **×** on the `MarkNote Active` pill when you're done. Your
   highlights stay on the page.

### Add a note

1. Select text and click **📝 Note** in the toolbar.
2. You'll see what you selected, e.g. `"TCP provides reliable
   communication."`, and a box that says *Write your note...*.
3. Type something like *Important for my CN exam...* and press **Save**.
4. A 📝 marker appears next to the highlight. Click it anytime to view, edit
   (annotations tell you when they expire, e.g. *Annotation expires in
   6 days*), or delete it — deletion always asks first.

### Revisit your work

- Refresh the page and activate MarkNote: your highlights and markers come
  back with a *3 saved annotations restored* toast.
- Close Chrome, come back tomorrow: everything is still there.
- Open the popup → **Open Notes Manager** for the full picture: search across
  titles, domains, quotes, and notes; filter **All / Web / Expiring Soon**;
  open the source page, copy a quote, edit, or delete — each card shows its
  `WEB`/`PDF` badge, creation date, and days remaining.

### Read and annotate PDFs

1. Open any PDF in Chrome — the popup detects it and offers
   **📄 Open in MarkNote**.
2. In MarkNote's reader, press **Activate MarkNote** in the top bar.
3. Highlight and take notes exactly like on the web, across any page.
4. Reload the reader and activate again: your per-page highlights restore.

## Privacy

MarkNote has **no backend, no analytics, and no network calls of its own**.
Annotations are stored only in `chrome.storage.local` on your device. The
only network traffic is fetching a PDF you explicitly open in the reader.
Uninstalling the extension removes everything.

## Notes live for 7 days

Every annotation is timestamped at creation and deleted automatically 7 days
later — editing a note never extends the clock, and restarting Chrome never
resets it. You'll always see the countdown: *6 days remaining* in the
manager, *Annotation expires in 6 days* on notes, and *Saved for 7 days* in
the popup.

## Permissions used

| Permission | Why MarkNote needs it |
|---|---|
| `activeTab` | See the current tab's address and talk to the highlighter on it. |
| `storage` | Save your highlights and notes locally — the app's only database. |
| `clipboardWrite` | The *Copy text* button in the Notes Manager. |
| `<all_urls>` (host access) | Highlight on any website, and load remote PDFs into MarkNote's reader. |

## Limitations

- Chrome's own PDF viewer can't be annotated by any extension, which is why
  MarkNote opens PDFs in its reader instead.
- `chrome://` pages, the Web Store, and `blob:`/`data:` sources are
  off-limits to all extensions.
- Local `file://` PDFs need **Allow access to file URLs** enabled for
  MarkNote at `chrome://extensions`.
- Some servers block cross-origin PDF loading; POST-based or forced-download
  PDFs may not open in the reader.
- The reader has a fixed zoom level for now.

## FAQ

**Do my notes sync between devices?**
No — everything stays in the browser where you created it.

**Can I keep an annotation forever?**
Not yet — the 7-day expiry applies to everything. Copy important notes out
via the manager's *Copy text* action.

**I reloaded and my highlights are gone.**
Activate MarkNote on the page — restoration happens on activation, never
before, so pages stay untouched until you ask.

**Does MarkNote slow pages down?**
No. Content scripts are idle until activation, restoration is capped per
run, and PDF pages render lazily as you scroll.

## For developers

- Stack: Manifest V3 + vanilla HTML/CSS/JS. No build step, no dependencies
  (PDF.js 3.4.120 is vendored in `pdf/vendor/`).
- Structure: `popup/` dashboard · `content/` web highlighting ·
  `storage/` shared persistence (`MarkNoteStorage`) · `manager/` list UI ·
  `pdf/` detector + viewer + `PDF_ARCHITECTURE.md` · `background/` service
  worker · `icons/`.
- UI code must go through the storage helpers, never `chrome.storage`
  directly; rendering uses `textContent` only.
- Checks: `node --check <file>` per edited script; validate the manifest
  with `python -c "import json; json.load(open('manifest.json'))"`.
- Current version: **v0.12.0**.
