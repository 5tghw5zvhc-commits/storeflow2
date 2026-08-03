# StoreFlow

StoreFlow is a mobile-first Progressive Web App for managing shared warehouse stock and assembling furniture orders for accommodation projects.

## Version 1 features

- A master inventory where every physical part has one shared quantity.
- Link the same part to multiple projects without duplicating stock.
- Shared quantity updates across **All parts** and every linked project.
- Part code, name, category, separate length/width/height measurements, assembly position such as `2/5`, notes and quantity.
- Create, rename and delete projects.
- Upload, replace, remove and expand a project photo.
- Link and unlink existing master parts from a project.
- Assembly orders divided into Desk, Bed, Wardrobe and Kitchen.
- Parts already present on a pallet checklist are hidden from its add-part selector, including packed lines.
- Needed quantities can be edited directly on checklist rows, with packed-stock differences reconciled automatically.
- Packing an order item deducts it from master stock; unpacking restores it.
- Low-stock warnings at four units or fewer and out-of-stock warnings at zero.
- Open filtered low-stock and out-of-stock lists directly from the dashboard cards.
- JSON backup export and restore.
- iPhone Home Screen installation and offline app-shell support.

## Project structure

```text
storeflow/
├── .github/workflows/pages.yml  # automatic GitHub Pages deployment
├── assets/icons/                # iPhone and PWA icons
├── docs/                        # architecture and deployment notes
├── scripts/validate.mjs         # repository validation
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
