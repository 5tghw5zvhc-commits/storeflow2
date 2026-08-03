import { access, readFile } from 'node:fs/promises';

const requiredFiles = [
  'index.html',
  'src/styles.css',
  'src/app.js',
  'manifest.webmanifest',
  'sw.js',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

for (const file of requiredFiles) {
  await access(file);
}

const html = await readFile('index.html', 'utf8');
const expectedReferences = [
  'src/styles.css',
  'src/app.js',
  'manifest.webmanifest',
  'assets/icons/icon-180.png'
];

for (const reference of expectedReferences) {
  if (!html.includes(reference)) {
    throw new Error(`index.html is missing reference: ${reference}`);
  }
}

const forbiddenHtml = ['id="activeProjectSelect"', 'id="quickAddBtn"', 'ATTENTION NEEDED', 'name="size"'];
for (const fragment of forbiddenHtml) {
  if (html.includes(fragment)) throw new Error(`index.html still contains removed interface: ${fragment}`);
}

const requiredHtml = ['data-stock-filter="low"', 'data-stock-filter="out"', 'name="length"', 'name="width"', 'name="height"', 'id="photoDialog"'];
for (const fragment of requiredHtml) {
  if (!html.includes(fragment)) throw new Error(`index.html is missing requested interface: ${fragment}`);
}

const app = await readFile('src/app.js', 'utf8');
if (!app.includes("const STORAGE_KEY = 'storeflow-state-v1'")) {
  throw new Error('The existing StoreFlow storage key must remain unchanged.');
}
if (!app.includes('parseLegacyDimensions') || !app.includes('openExpandedProjectPhoto')) {
  throw new Error('The size migration or expandable-photo behavior is missing.');
}
if (!app.includes('includedPartIds') || !app.includes('data-action="edit-needed"') || !app.includes('updateOrderItemQuantity')) {
  throw new Error('The streamlined pallet checklist behavior is missing.');
}
if (app.includes('need-chip')) {
  throw new Error('The read-only checklist quantity chip should not remain.');
}

const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8'));
if (manifest.start_url !== './' || manifest.scope !== './') {
  throw new Error('Manifest must use relative start_url and scope for project hosting.');
}

console.log('StoreFlow project validation passed.');
