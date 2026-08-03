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

const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8'));
if (manifest.start_url !== './' || manifest.scope !== './') {
  throw new Error('Manifest must use relative start_url and scope for project hosting.');
}

console.log('StoreFlow project validation passed.');
