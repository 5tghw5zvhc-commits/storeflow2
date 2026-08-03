import { access, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const requiredFiles = [
  'index.html',
  'src/styles.css',
  'src/i18n.js',
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
  'src/i18n.js',
  'src/app.js',
  'manifest.webmanifest',
  'assets/icons/icon-180.png'
];

for (const reference of expectedReferences) {
  if (!html.includes(reference)) {
    throw new Error(`index.html is missing reference: ${reference}`);
  }
}

const forbiddenHtml = ['id="activeProjectSelect"', 'id="quickAddBtn"', 'ATTENTION NEEDED', 'name="size"', 'id="inventoryTableBody"', '<span>▦</span>', '<span>▣</span>', '<span>◫</span>'];
for (const fragment of forbiddenHtml) {
  if (html.includes(fragment)) throw new Error(`index.html still contains removed interface: ${fragment}`);
}

const requiredHtml = ['data-stock-filter="low"', 'data-stock-filter="out"', 'name="length"', 'name="width"', 'name="height"', 'id="photoDialog"', 'id="partDuplicateWarning"', 'id="inventoryCategoryFilter"', 'class="inventory-fab"', 'id="stockView"', 'id="stockPalletDialog"', 'id="stockPalletDetailDialog"', 'id="stockPlannerOptions"', 'id="addStockSearchPart"', 'id="stockSelectedParts"', 'id="stockPlannerResults"', 'data-settings-tab="general"', 'data-settings-tab="data"', 'data-settings-tab="tips"', 'id="settingsDataPanel"', 'id="settingsTipsPanel"', 'name="overflowing"', 'data-dismiss-notice="inventory-info"', 'href="#icon-home"', 'href="#icon-projects"', 'href="#icon-box"', 'href="#icon-orders"', 'href="#icon-data"', 'id="languageSelect"', '<option value="en">English</option>', '<option value="uk">Українська</option>', '<option value="ru">Русский</option>', '<option value="pl">Polski</option>'];
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
if (!app.includes('partIdentityKey') || !app.includes('findDuplicateMasterPart') || !app.includes('updatePartDuplicateWarning')) {
  throw new Error('The exact master-part duplicate warning is missing.');
}
if (app.includes('part.code.toUpperCase() === code')) {
  throw new Error('Master parts must not be treated as duplicates by code alone.');
}
if (!app.includes('stockPallets') || !app.includes('renderStock') || !app.includes('storedQuantityForPart') || !app.includes('openStockPalletDetail')) {
  throw new Error('The undelivered Stock pallet workflow is missing.');
}
if (!app.includes('optimizeStockPallets') || !app.includes('comparePlannerPlans') || !app.includes('overflowUnits') || !app.includes('selectedStockPartIds')) {
  throw new Error('The multi-part optimal pallet planner is missing.');
}
if (!app.includes('dismissNotice') || !app.includes('stockAlertSignature') || !app.includes('inventoryInfo')) {
  throw new Error('Dismissible inventory notices are missing.');
}
if (!app.includes('togglePartOverflowing') || !app.includes("data.get('overflowing')")) {
  throw new Error('Overflowing master-part support is missing.');
}
if (!app.includes('expandedInventoryPartIds') || !app.includes('inventory-card-details') || !app.includes('code-status-${status.key}') || !app.includes('data-action="overflow-switch"')) {
  throw new Error('Expandable inventory cards, stock-coloured codes, or the overflowing switch are missing.');
}
if (app.includes('data-action="overflow"')) {
  throw new Error('The old inventory overflowing button must not return.');
}
if (!app.includes('inventoryCategoryFilter') || !app.includes('openInventoryMenuPartId') || !app.includes('renderSettingsTabs')) {
  throw new Error('The category filter, three-dot part menu, or Settings tabs are missing.');
}
if (!app.includes('language: LANGUAGE_CODES.has(source.language)') || !app.includes('applyTranslations') || !app.includes('languageSelect.addEventListener')) {
  throw new Error('Persistent interface language support is missing.');
}
if (/showToast\(\s*['"`]/.test(app) || /window\.confirm\(\s*['"`]/.test(app)) {
  throw new Error('Toast and confirmation text must come from the translation catalogue.');
}

const i18nSource = await readFile('src/i18n.js', 'utf8');
if (/\.\.\.en\b/.test(i18nSource)) {
  throw new Error('Translated catalogues must list every key explicitly; English spreading would hide missing translations.');
}
const sandbox = {};
vm.runInNewContext(i18nSource, sandbox, { filename: 'src/i18n.js' });
const i18n = sandbox.StoreFlowI18n;
if (!i18n || typeof i18n.t !== 'function') throw new Error('src/i18n.js did not expose StoreFlowI18n.');
const expectedLanguages = ['en', 'uk', 'ru', 'pl'];
if (JSON.stringify(i18n.languages.map(language => language.code)) !== JSON.stringify(expectedLanguages)) {
  throw new Error('StoreFlow must offer English, Ukrainian, Russian and Polish in that order.');
}
const englishKeys = Object.keys(i18n.translations.en).sort();
const placeholderNames = value => [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]).sort();
for (const language of expectedLanguages.slice(1)) {
  const catalogue = i18n.translations[language];
  const keys = Object.keys(catalogue || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(englishKeys)) {
    const missing = englishKeys.filter(key => !keys.includes(key));
    const extra = keys.filter(key => !englishKeys.includes(key));
    throw new Error(`${language} translation keys differ from English. Missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}.`);
  }
  for (const key of englishKeys) {
    if (!String(catalogue[key]).trim()) throw new Error(`${language} translation is empty for: ${key}`);
    if (JSON.stringify(placeholderNames(catalogue[key])) !== JSON.stringify(placeholderNames(i18n.translations.en[key]))) {
      throw new Error(`${language} translation placeholders differ for: ${key}`);
    }
  }
}

const referencedKeys = new Set();
for (const match of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)) referencedKeys.add(match[1]);
for (const match of app.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) referencedKeys.add(match[1]);
for (const match of app.matchAll(/\baddActivity\(\s*['"]([^'"]+)['"]/g)) referencedKeys.add(match[1]);
const missingReferences = [...referencedKeys].filter(key => !Object.hasOwn(i18n.translations.en, key));
if (missingReferences.length) throw new Error(`Translation keys are referenced but undefined: ${missingReferences.join(', ')}`);

const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8'));
if (manifest.start_url !== './' || manifest.scope !== './') {
  throw new Error('Manifest must use relative start_url and scope for project hosting.');
}

console.log('StoreFlow project validation passed.');
