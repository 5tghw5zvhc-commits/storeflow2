# StoreFlow

StoreFlow is a mobile-first Progressive Web App for managing shared warehouse stock and assembling furniture orders for accommodation projects.

## Version 1 features

- A master inventory where every physical part has one shared quantity.
- Clean expandable inventory cards: code, name, assembly, quantity and overflowing switch remain visible, while category, dimensions, store quantity, notes and project links open on a single tap.
- Part-code colours replace text status badges: green for in stock, yellow for low stock and red for out of stock; Edit and Delete live in each card's three-dot menu.
- Full-width Inventory cards expand downward without changing width; category filtering and a fixed floating add-part control keep the toolbar compact.
- Link the same part to multiple projects without duplicating stock.
- Shared quantity updates across **All parts** and every linked project.
- Part code, name, category, separate length/width/height measurements, assembly position such as `2/5`, notes and quantity.
- Measurement-aware search accepts individual dimensions and combined forms such as `680×260×18` or `680*260*18` across Inventory, project assignment and Stock pallet entry.
- Live duplicate warnings use the exact combination of part code, part number and total parts; the same code remains valid when either numbering value differs.
- Dismissible master-inventory warnings and information banners.
- Mark parts as overflowing when no additional storage space is available.
- A separate Stock area for undelivered store pallets, identified by delivery and pallet number.
- Every pallet line records a required two-digit pack suffix: `25` is displayed after the part code as `-25` and labelled **Pack 2/5**.
- Pallet part entry shows live, tappable Master Inventory suggestions as each character is typed, including dimensions and assembly numbering to distinguish similar records.
- When typed text matches several master parts, it can still be saved exactly as entered with a **Several matches** marker; the record stays searchable and can be linked to the correct master part later without losing its pallet quantity.
- Compact two-column pallet cards expand downward on one tap. Their three-dot menus add parts, edit pallet details or delete, while stored quantities remain editable inside the expanded card.
- A fixed floating add-pallet control replaces the old Stock toolbar button.
- Persistent interface languages: English, Ukrainian, Russian and Polish.
- Tabbed Settings separate preferences, data management and concise explanations of StoreFlow's shared-stock, checklist, pallet-planning and iPhone-storage rules.
- Search pallets with separate part-name/code and pack-number fields. Corresponding comma-separated pairs still support several required parts at once and feed the optimized pallet selector.
- Receive an optimized pallet set that avoids overflowing stock first, consolidates required parts onto fewer pallets, and minimizes unrelated stock.
- Recommendation cards identify primary and additional pallets, explain their requested-part coverage, and warn when an unavoidable pallet contains overflowing items.
- Add unknown pallet contents immediately as unregistered name/code records. Searching or later creating the matching Master Inventory part prompts for confirmation and relinks every matching pallet quantity without losing data.
- New master parts begin with no project selected; project links are always an explicit choice.
- Edit stored-pallet quantities directly and create missing master parts from the pallet workflow.
- Master Inventory shows received quantities alongside totals still held at the store.
- Create, rename and delete projects.
- Upload, replace, remove and expand a project photo.
- Link and unlink existing master parts from a project.
- Assembly orders are divided into Desk, Bed, Wardrobe, Kitchen, Infills and Other. Each section only offers project parts assigned to that exact master-part category.
- Assembly Order checklist lines show their Master Inventory notes when present; parts without notes keep the compact existing layout.
- A persistent **Undo latest** control in Latest Updates reverses completed data changes one at a time, including related inventory and activity-log changes.
- Parts already present on a pallet checklist are hidden from its add-part selector, including packed lines.
- Needed quantities can be edited directly on checklist rows, with packed-stock differences reconciled automatically.
- Packing an order item deducts it from master stock; unpacking restores it.
- **Send the order** locks the completed order without restoring deducted stock, then immediately creates and opens a fresh copy with the same parts, quantities and notes but every checklist box unchecked.
- Low-stock warnings at four units or fewer and out-of-stock warnings at zero.
- Open filtered low-stock and out-of-stock lists directly from the dashboard cards.
- JSON backup export and restore, including stored pallets and overflow status.
- iPhone Home Screen installation and offline app-shell support.

## Project structure

```text
storeflow/
├── .github/workflows/pages.yml  # automatic GitHub Pages deployment
├── assets/icons/                # iPhone and PWA icons
├── docs/                        # architecture and deployment notes
├── scripts/validate.mjs         # repository validation
├── src/i18n.js                  # complete four-language UI catalogue
├── src/app.js                   # application logic and data model
├── src/styles.css               # mobile-first interface
├── index.html                   # application shell
├── manifest.webmanifest         # installable PWA metadata
└── sw.js                        # offline app-shell cache
```

## Local data and future collaboration

StoreFlow stores data in the browser on each device using IndexedDB. Legacy localStorage data is copied and verified on first launch without modifying the old copy. The app remains usable offline; data is not shared between colleagues.

The data model already separates master parts, project links and orders. A future cloud adapter can replace local storage with Supabase or another database without changing the core inventory model.

## Run locally

No build step is required.

```bash
npm run validate
npm run serve
```

Then open `http://localhost:4173`.

## Deploy with GitHub Pages

The included workflow publishes the repository automatically whenever the `main` branch changes.

After the first push:

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions**.
3. Open the latest workflow run under **Actions** and wait for it to complete.
4. Open the generated Pages URL in Safari.
5. Use **Share → Add to Home Screen** on iPhone.

## Data safety

Use **Data & settings → Export backup** regularly. Project photos are stored inside the backup and may increase its size.

## Keeping translations current

All interface copy belongs in `src/i18n.js`; UI code and markup reference catalogue keys instead of embedding messages. Every new English key must be translated into Ukrainian, Russian and Polish with the same placeholders. `npm run validate` checks exact key parity, non-empty values, placeholder parity, and every catalogue key referenced by the HTML and JavaScript, so an incomplete language update cannot pass validation.

## Manufacturing planning

## Device database upgrade

StoreFlow now saves operational state and the ordinary Undo history together in IndexedDB (`storeflow-device-v1`). The first launch copies the exact legacy JSON and Undo text, verifies them inside the transaction and again after commit, and only then initializes the app. It never deletes or overwrites the old localStorage records; an additional original migration copy is retained in the database. Photos stay byte-for-byte unchanged during this upgrade. No cloud account or server storage is involved.

Writes are serialized, read-back checked, and use strict transaction durability where supported. Revision checks reject stale saves from another window. Initialization errors fail closed rather than saving an empty replacement. Data management reports saving/saved/failure status and offers retry. Import success is shown only after the database transaction commits; failed imports restore the previous in-memory workspace and Undo history. Stocktake reset/restore and pallet unload use the same atomic persistence path. JSON backup compatibility is unchanged; ordinary Undo remains device-local and is migrated directly, while stocktake restore records remain part of exported backups.

Keep independent exported backups: device-local databases can still be lost if website data is cleared, the app is removed, or the device fails. The retained legacy copy is a migration-time fallback, not a live replica. Changes that failed to save in the old app can only be recovered from an exported backup made while they were visible. Database tests use `fake-indexeddb`, and app interaction regressions use a DOM stub; these do not constitute a test on the user's iPhone.

Verification: `npm ci --ignore-scripts`, `npm run validate`, `node scripts/test-storage.mjs`, and `node scripts/test-planning.mjs`.

### Planning behavior

The Planning tab stores a remaining order count and an explicit Assembly Order template per project. Build a complete checklist with the quantities needed for one order, then select it in Planning. Demand is aggregated by master-part ID across projects before subtracting Inventory and linked store-pallet quantities once. Different pack identities remain separate. Unresolved pallet lines are reported and excluded until linked. Missing templates and project parts omitted from the template produce an incomplete-estimate warning.

Counts include the selected open order. Its already-packed quantities are credited once because they have already been deducted from Inventory. Other open orders are not credited: the user must include their remaining work in the entered counts. Sending the selected order decrements the count and follows its fresh copy. Planning changes and sending remain undoable, and counts/template choices survive backup import and reload. Sent historical templates receive no packed credit.

Verification: `node scripts/test-planning.mjs` exercises the production calculator, rendered markup, input handler, persistence, undo and Send Order in a DOM stub. This is a runtime test, not a visual browser test.
