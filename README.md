# StoreFlow

StoreFlow is a mobile-first Progressive Web App for managing shared warehouse stock and assembling furniture orders for accommodation projects.

## Version 1 features

- A master inventory where every physical part has one shared quantity.
- Clean expandable inventory cards: code, name, assembly, quantity and overflowing switch remain visible, while category, dimensions, store quantity, notes and project links open on a single tap.
- Part-code colours replace text status badges: green for in stock, yellow for low stock and red for out of stock; Edit and Delete live in each card's three-dot menu.
- Category filtering and a floating add-part control keep the Inventory toolbar compact.
- Link the same part to multiple projects without duplicating stock.
- Shared quantity updates across **All parts** and every linked project.
- Part code, name, category, separate length/width/height measurements, assembly position such as `2/5`, notes and quantity.
- Live duplicate warnings use the exact combination of part code, part number and total parts; the same code remains valid when either numbering value differs.
- Dismissible master-inventory warnings and information banners.
- Mark parts as overflowing when no additional storage space is available.
- A separate Stock area for undelivered store pallets, identified by delivery and pallet number.
- Persistent interface languages: English, Ukrainian, Russian and Polish.
- Tabbed Settings separate preferences, data management and concise explanations of StoreFlow's shared-stock, checklist, pallet-planning and iPhone-storage rules.
- Search for several required parts at once and receive an optimized pallet set that avoids overflowing stock first, consolidates required parts onto fewer pallets, and minimizes unrelated stock.
- Recommendation cards identify primary and additional pallets, explain their requested-part coverage, and warn when an unavoidable pallet contains overflowing items.
- Edit stored-pallet quantities directly and create missing master parts from the pallet workflow.
- Master Inventory shows received quantities alongside totals still held at the store.
- Create, rename and delete projects.
- Upload, replace, remove and expand a project photo.
- Link and unlink existing master parts from a project.
- Assembly orders divided into Desk, Bed, Wardrobe and Kitchen.
- Parts already present on a pallet checklist are hidden from its add-part selector, including packed lines.
- Needed quantities can be edited directly on checklist rows, with packed-stock differences reconciled automatically.
- Packing an order item deducts it from master stock; unpacking restores it.
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

Version 1 stores data in the browser on each device using `localStorage`. This keeps the app fast and usable offline, but data is not yet shared between colleagues.

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
