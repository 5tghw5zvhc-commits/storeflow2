(() => {
  'use strict';

  const STORAGE_KEY = 'storeflow-state-v1';
  const UNDO_STORAGE_KEY = 'storeflow-undo-v1';
  const UNDO_COLLECTION_KEYS = ['projects', 'parts', 'orders', 'stockPallets', 'activity'];
  const UNDO_SCALAR_KEYS = ['language', 'activeProjectId', 'selectedOrderId', 'dismissedNotices'];
  const MAX_UNDO_HISTORY = 20;
  const MAX_PERSISTED_UNDO_BYTES = 1500000;
  const I18N = window.StoreFlowI18n;
  const LANGUAGE_CODES = new Set(I18N.languages.map(language => language.code));
  const CATEGORIES = ['Desk', 'Bed', 'Wardrobe', 'Kitchen', 'Infills', 'Other'];
  let storageAvailable = true;
  let currentView = 'dashboard';
  let toastTimer;
  let projectPhotoDraft = '';
  let projectPhotoBusy = false;
  let projectPartsDraft = new Set();
  let openStockPalletId = null;
  let stockPartReturnPalletId = null;
  let selectedStockPartIds = new Set();
  let stockPlannerFeedback = null;
  let expandedInventoryPartIds = new Set();
  let openInventoryMenuPartId = null;
  let expandedStockPalletIds = new Set();
  let openStockPalletMenuId = null;
  let selectedStockSuggestionPartId = null;
  let activeStockSuggestionIndex = -1;
  let activeSettingsTab = 'general';
  let pendingUndoActivities = [];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const esc = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  function normalizeCategory(value) {
    const category = String(value || 'Other');
    return CATEGORIES.includes(category) ? category : 'Other';
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      storageAvailable = false;
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      storageAvailable = true;
      return true;
    } catch (error) {
      storageAvailable = false;
      console.warn('StoreFlow could not save to local storage:', error);
      return false;
    }
  }

  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      dialog.setAttribute('open', '');
      dialog.classList.add('dialog-fallback');
      document.body.classList.add('dialog-open');
    }
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    dialog.classList.remove('dialog-fallback');
    if (!document.querySelector('dialog.dialog-fallback[open]')) document.body.classList.remove('dialog-open');
  }

  function createInitialState() {
    const now = new Date().toISOString();
    return {
      version: 7,
      language: 'en',
      activeProjectId: null,
      selectedOrderId: null,
      projects: [],
      parts: [],
      orders: [],
      stockPallets: [],
      dismissedNotices: {},
      activity: [
        { id: uid('activity'), textKey: 'activity.workspaceReady', detailKey: 'activity.workspaceReadyHelp', createdAt: now }
      ]
    };
  }

  function cleanDimensionValue(value) {
    const normalized = String(value ?? '').trim().replace(',', '.');
    if (!normalized) return '';
    const match = normalized.match(/\d+(?:\.\d+)?/);
    if (!match) return '';
    const number = Number(match[0]);
    return Number.isFinite(number) && number >= 0 ? String(number) : '';
  }

  function parseLegacyDimensions(value) {
    const raw = String(value || '').trim();
    const values = raw.split(/\s*(?:×|x|\*)\s*/i);
    if (values.length < 3) return { length: '', width: '', height: '' };
    return {
      length: cleanDimensionValue(values[0]),
      width: cleanDimensionValue(values[1]),
      height: cleanDimensionValue(values[2])
    };
  }

  function dimensionsFromPart(part = {}) {
    const dimensionObject = part.dimensions && typeof part.dimensions === 'object' ? part.dimensions : {};
    const legacy = parseLegacyDimensions(typeof part.dimensions === 'string' ? part.dimensions : part.size);
    return {
      length: cleanDimensionValue(part.length ?? dimensionObject.length ?? legacy.length),
      width: cleanDimensionValue(part.width ?? dimensionObject.width ?? legacy.width),
      height: cleanDimensionValue(part.height ?? dimensionObject.height ?? legacy.height)
    };
  }

  function legacySizeValue(dimensions, fallback = '') {
    if (dimensions.length && dimensions.width && dimensions.height) {
      return `${dimensions.length} × ${dimensions.width} × ${dimensions.height} mm`;
    }
    return String(fallback || '');
  }

  function dimensionLabel(part) {
    const dimensions = dimensionsFromPart(part);
    const values = [
      dimensions.length ? `${t('dimensions.lengthShort')} ${dimensions.length}` : '',
      dimensions.width ? `${t('dimensions.widthShort')} ${dimensions.width}` : '',
      dimensions.height ? `${t('dimensions.heightShort')} ${dimensions.height}` : ''
    ].filter(Boolean);
    return values.length ? `${values.join(' × ')} mm` : String(part?.size || '—');
  }

  function normalizePartSearch(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/[×*]/g, ' ')
      .replace(/(\d)\s*x\s*(?=\d)/g, '$1 ')
      .replace(/[^\p{L}\p{N}.]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizePackDigits(value) {
    const raw = String(value ?? '').trim();
    const fraction = raw.match(/^([1-9])\s*\/\s*([1-9])$/);
    if (fraction) return `${fraction[1]}${fraction[2]}`;
    const digits = raw.replace(/\D/g, '');
    return /^[1-9]{2}$/.test(digits) ? digits : '';
  }

  function packDigitsForPart(part) {
    const position = String(part?.assemblyPosition || '');
    const total = String(part?.assemblyTotal || '');
    return /^[1-9]$/.test(position) && /^[1-9]$/.test(total) ? `${position}${total}` : '';
  }

  function packFractionFromDigits(value) {
    const digits = normalizePackDigits(value);
    return digits ? `${digits[0]}/${digits[1]}` : '';
  }

  function partMatchesPack(part, packDigits) {
    const normalized = normalizePackDigits(packDigits);
    return !normalized || packDigitsForPart(part) === normalized;
  }

  function codeWithPack(code, packDigits) {
    const raw = String(code || '').trim();
    const digits = normalizePackDigits(packDigits);
    if (!raw || !digits || raw.endsWith(`-${digits}`)) return raw;
    return `${raw}-${digits}`;
  }

  function partMeasurementAliases(part) {
    const dimensions = dimensionsFromPart(part);
    const ordered = [dimensions.length, dimensions.width, dimensions.height].filter(Boolean);
    return [
      dimensionLabel(part),
      dimensions.length,
      dimensions.width,
      dimensions.height,
      ordered.join(' '),
      ordered.join('x'),
      ordered.join('*'),
      ordered.join('×')
    ].filter(Boolean);
  }

  function partSearchAliases(part) {
    return [
      part.code,
      part.name,
      `${part.code} — ${part.name}`,
      part.category,
      assemblyLabel(part),
      ...partMeasurementAliases(part),
      ...getProjectNames(part)
    ].filter(Boolean);
  }

  function partLookupAliases(part) {
    return [part.code, part.name, `${part.code} — ${part.name}`, ...partMeasurementAliases(part)].filter(Boolean);
  }

  function partMatchesSearch(part, value) {
    const normalized = normalizePartSearch(value);
    if (!normalized) return true;
    const haystack = normalizePartSearch(partSearchAliases(part).join(' '));
    return normalized.split(' ').every(token => haystack.includes(token));
  }

  function resolveUniquePartSearch(value, packDigits = '') {
    const normalized = normalizePartSearch(value);
    if (!normalized) return { part: null, reason: 'missing', matches: [] };
    const eligibleParts = normalizePackDigits(packDigits) ? state.parts.filter(part => partMatchesPack(part, packDigits)) : state.parts;
    const byCode = (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name);
    const exact = eligibleParts.filter(part => partLookupAliases(part).some(alias => normalizePartSearch(alias) === normalized)).sort(byCode);
    if (exact.length === 1) return { part: exact[0], reason: '', matches: exact };
    if (exact.length > 1) return { part: null, reason: 'ambiguous', matches: exact };
    const tokens = normalized.split(' ');
    const partial = eligibleParts.filter(part => {
      const haystack = normalizePartSearch(partLookupAliases(part).join(' '));
      return tokens.every(token => haystack.includes(token));
    }).sort(byCode);
    if (partial.length === 1) return { part: partial[0], reason: '', matches: partial };
    return { part: null, reason: partial.length ? 'ambiguous' : 'missing', matches: partial };
  }

  function stockPartSuggestionMatches(value, packDigits = '') {
    const normalized = normalizePartSearch(value);
    if (!normalized) return [];
    const tokens = normalized.split(' ');
    const score = part => {
      const code = normalizePartSearch(part.code);
      const name = normalizePartSearch(part.name);
      const aliases = partLookupAliases(part).map(normalizePartSearch);
      if (aliases.includes(normalized)) return 0;
      if (code.startsWith(normalized)) return 1;
      if (name.startsWith(normalized)) return 2;
      return 3;
    };
    return state.parts
      .filter(part => !normalizePackDigits(packDigits) || partMatchesPack(part, packDigits))
      .filter(part => {
        const haystack = normalizePartSearch(partLookupAliases(part).join(' '));
        return tokens.every(token => haystack.includes(token));
      })
      .sort((a, b) => score(a) - score(b) || a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }

  function parsePendingPartInput(value) {
    const raw = String(value || '').trim();
    const separator = raw.indexOf(' — ');
    if (separator >= 0) {
      return {
        pendingCode: raw.slice(0, separator).trim().toUpperCase(),
        pendingName: raw.slice(separator + 3).trim()
      };
    }
    const looksLikeCode = /[\d_./-]/u.test(raw) || (raw === raw.toLocaleUpperCase() && raw !== raw.toLocaleLowerCase());
    return looksLikeCode
      ? { pendingCode: raw.toUpperCase(), pendingName: '' }
      : { pendingCode: '', pendingName: raw };
  }

  function isPendingStockItem(item) {
    return Boolean(item && !item.partId && (String(item.pendingCode || '').trim() || String(item.pendingName || '').trim()));
  }

  function pendingStockItemLabel(item) {
    return String(item?.pendingName || item?.pendingCode || '').trim();
  }

  function pendingStockItemAliases(item) {
    return [item?.pendingCode, item?.pendingName, `${item?.pendingCode || ''} — ${item?.pendingName || ''}`]
      .map(normalizePartSearch)
      .filter(Boolean);
  }

  function pendingStockItemKey(item) {
    const identity = pendingStockItemAliases(item)[0] || `pending-${item?.id || ''}`;
    return `${identity}|pack:${normalizePackDigits(item?.packCode) || 'none'}`;
  }

  function stockPlannerReferenceForItem(item) {
    return item?.partId || `pending:${pendingStockItemKey(item)}`;
  }

  function stockPlannerEntryForReference(reference) {
    const part = state.parts.find(candidate => candidate.id === reference);
    if (part) return { reference, part, item: null, label: `${part.code}${packDigitsForPart(part) ? ` · ${t('stock.packLabel', { pack: packFractionFromDigits(packDigitsForPart(part)) })}` : ''}` };
    const match = state.stockPallets.flatMap(pallet => pallet.items).find(item => isPendingStockItem(item) && stockPlannerReferenceForItem(item) === reference);
    return match ? { reference, part: null, item: match, label: `${pendingStockItemLabel(match)}${normalizePackDigits(match.packCode) ? ` · ${t('stock.packLabel', { pack: packFractionFromDigits(match.packCode) })}` : ''}` } : null;
  }

  function stockPlannerReferenceLabel(reference) {
    return stockPlannerEntryForReference(reference)?.label || t('common.part');
  }

  function pendingStockItemMatchesPart(item, part) {
    if (!isPendingStockItem(item) || !part) return false;
    const itemPack = normalizePackDigits(item.packCode);
    if (itemPack && !partMatchesPack(part, itemPack)) return false;
    if (part.id && Array.isArray(item.candidatePartIds) && item.candidatePartIds.includes(part.id)) return true;
    const pendingAliases = new Set(pendingStockItemAliases(item));
    return [part.code, part.name, `${part.code} — ${part.name}`]
      .map(normalizePartSearch)
      .filter(Boolean)
      .some(alias => pendingAliases.has(alias));
  }

  function pendingStockMatchesForText(value, packDigits = '') {
    const normalized = normalizePartSearch(value);
    const normalizedPack = normalizePackDigits(packDigits);
    if (!normalized) return [];
    return state.stockPallets.flatMap(pallet => pallet.items
      .filter(item => isPendingStockItem(item) && pendingStockItemAliases(item).includes(normalized) && (!normalizedPack || normalizePackDigits(item.packCode) === normalizedPack))
      .map(item => ({ pallet, item })));
  }

  function pendingStockMatchesForPart(part) {
    return state.stockPallets.flatMap(pallet => pallet.items
      .filter(item => pendingStockItemMatchesPart(item, part))
      .map(item => ({ pallet, item })));
  }

  function linkPendingStockItemsToPart(part) {
    let linkedCount = 0;
    state.stockPallets.forEach(pallet => {
      const matches = pallet.items.filter(item => pendingStockItemMatchesPart(item, part));
      if (!matches.length) return;
      let masterItem = pallet.items.find(item => item.partId === part.id) || null;
      matches.forEach(item => {
        linkedCount += 1;
        if (masterItem && masterItem !== item) {
          masterItem.packCode = normalizePackDigits(masterItem.packCode) || normalizePackDigits(item.packCode) || packDigitsForPart(part);
          masterItem.quantity += item.quantity;
          pallet.items = pallet.items.filter(candidate => candidate.id !== item.id);
          return;
        }
        item.partId = part.id;
        item.packCode = normalizePackDigits(item.packCode) || packDigitsForPart(part);
        delete item.pendingCode;
        delete item.pendingName;
        delete item.matchStatus;
        delete item.candidatePartIds;
        masterItem = item;
      });
    });
    return linkedCount;
  }

  function partIdentityKey(code, assemblyPosition, assemblyTotal) {
    return JSON.stringify([
      String(code || '').trim().toUpperCase(),
      positiveIntegerOrBlank(assemblyPosition) || null,
      positiveIntegerOrBlank(assemblyTotal) || null
    ]);
  }

  function migrateState(input) {
    const source = input && typeof input === 'object' ? input : createInitialState();
    const projects = Array.isArray(source.projects) ? source.projects.map(project => ({
      id: project.id || uid('project'),
      name: String(project.name || 'Untitled project'),
      location: String(project.location || ''),
      reference: String(project.reference || ''),
      photo: String(project.photo || project.photoDataUrl || ''),
      createdAt: project.createdAt || new Date().toISOString()
    })) : [];
    const validProjectIds = new Set(projects.map(project => project.id));

    const grouped = new Map();
    const oldToNew = new Map();
    const sourceParts = Array.isArray(source.parts) ? source.parts : [];

    sourceParts.forEach(oldPart => {
      const code = String(oldPart.code || '').trim().toUpperCase() || `PART-${grouped.size + 1}`;
      const assemblyPosition = positiveIntegerOrBlank(oldPart.assemblyPosition ?? oldPart.partNumber);
      const assemblyTotal = positiveIntegerOrBlank(oldPart.assemblyTotal ?? oldPart.totalParts);
      const key = partIdentityKey(code, assemblyPosition, assemblyTotal);
      const dimensions = dimensionsFromPart(oldPart);
      const links = [
        ...(Array.isArray(oldPart.projectIds) ? oldPart.projectIds : []),
        ...(oldPart.projectId ? [oldPart.projectId] : [])
      ].filter(id => validProjectIds.has(id));

      if (!grouped.has(key)) {
        const newPart = {
          id: oldPart.id || uid('part'),
          code,
          name: String(oldPart.name || 'Unnamed part'),
          category: normalizeCategory(oldPart.category),
          quantity: Math.max(0, Number(oldPart.quantity) || 0),
          length: dimensions.length,
          width: dimensions.width,
          height: dimensions.height,
          size: legacySizeValue(dimensions, typeof oldPart.dimensions === 'string' ? oldPart.dimensions : oldPart.size),
          assemblyPosition,
          assemblyTotal,
          overflowing: Boolean(oldPart.overflowing),
          projectIds: [...new Set(links)],
          notes: String(oldPart.notes || '')
        };
        grouped.set(key, newPart);
      } else {
        const existing = grouped.get(key);
        existing.quantity = Math.max(existing.quantity, Math.max(0, Number(oldPart.quantity) || 0));
        existing.projectIds = [...new Set([...existing.projectIds, ...links])];
        ['length', 'width', 'height'].forEach(field => {
          if (!existing[field] && dimensions[field]) existing[field] = dimensions[field];
        });
        if (!existing.size) existing.size = legacySizeValue(dimensions, typeof oldPart.dimensions === 'string' ? oldPart.dimensions : oldPart.size);
        existing.overflowing = existing.overflowing || Boolean(oldPart.overflowing);
      }
      oldToNew.set(oldPart.id, grouped.get(key).id);
    });

    const parts = [...grouped.values()];
    const validPartIds = new Set(parts.map(part => part.id));
    const partById = new Map(parts.map(part => [part.id, part]));
    const categoryByPartId = new Map(parts.map(part => [part.id, part.category]));
    const orders = (Array.isArray(source.orders) ? source.orders : [])
      .filter(order => validProjectIds.has(order.projectId))
      .map(order => ({
        id: order.id || uid('order'),
        projectId: order.projectId,
        name: String(order.name || 'Untitled order'),
        seriesName: String(order.seriesName || order.name || 'Untitled order'),
        cycle: positiveIntegerOrBlank(order.cycle) || 1,
        notes: String(order.notes || ''),
        createdAt: order.createdAt || new Date().toISOString(),
        sentAt: order.sentAt ? String(order.sentAt) : '',
        previousOrderId: String(order.previousOrderId || ''),
        items: (Array.isArray(order.items) ? order.items : []).map(item => {
          const partId = oldToNew.get(item.partId) || item.partId;
          return {
            id: item.id || uid('item'),
            partId,
            category: categoryByPartId.get(partId) || normalizeCategory(item.category),
            quantityNeeded: Math.max(1, Number(item.quantityNeeded) || 1),
            packed: Boolean(item.packed)
          };
        }).filter(item => validPartIds.has(item.partId))
      }));

    const stockPallets = (Array.isArray(source.stockPallets) ? source.stockPallets : (Array.isArray(source.storePallets) ? source.storePallets : []))
      .map(pallet => ({
        id: pallet.id || uid('stock_pallet'),
        deliveryNumber: String(pallet.deliveryNumber || pallet.delivery || '').trim(),
        palletNumber: String(pallet.palletNumber || pallet.number || '').trim(),
        notes: String(pallet.notes || ''),
        createdAt: pallet.createdAt || new Date().toISOString(),
        items: (Array.isArray(pallet.items) ? pallet.items : []).map(item => {
          const mappedPartId = oldToNew.get(item.partId) || item.partId;
          const hasMasterPart = validPartIds.has(mappedPartId);
          const linkedPart = partById.get(mappedPartId);
          const packCode = normalizePackDigits(item.packCode || item.packNumber || item.packDigits) || (hasMasterPart ? packDigitsForPart(linkedPart) : '');
          return {
            id: item.id || uid('stock_item'),
            partId: hasMasterPart ? mappedPartId : '',
            packCode,
            pendingCode: hasMasterPart ? '' : String(item.pendingCode || item.partCode || '').trim().toUpperCase(),
            pendingName: hasMasterPart ? '' : String(item.pendingName || item.partName || '').trim(),
            matchStatus: !hasMasterPart && item.matchStatus === 'ambiguous' ? 'ambiguous' : '',
            candidatePartIds: !hasMasterPart && Array.isArray(item.candidatePartIds)
              ? [...new Set(item.candidatePartIds.map(id => oldToNew.get(id) || id).filter(id => validPartIds.has(id) && (!packCode || partMatchesPack(partById.get(id), packCode))))]
              : [],
            quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
          };
        }).filter(item => item.partId || item.pendingCode || item.pendingName)
      }))
      .filter(pallet => pallet.deliveryNumber && pallet.palletNumber);

    return {
      version: 7,
      language: LANGUAGE_CODES.has(source.language) ? source.language : 'en',
      activeProjectId: validProjectIds.has(source.activeProjectId) ? source.activeProjectId : (projects[0]?.id || null),
      selectedOrderId: source.selectedOrderId || null,
      projects,
      parts,
      orders,
      stockPallets,
      dismissedNotices: source.dismissedNotices && typeof source.dismissedNotices === 'object' ? { ...source.dismissedNotices } : {},
      activity: Array.isArray(source.activity) ? source.activity : []
    };
  }

  function positiveIntegerOrBlank(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : '';
  }

  function loadState() {
    try {
      const raw = storageGet(STORAGE_KEY);
      if (!raw) return createInitialState();
      return migrateState(JSON.parse(raw));
    } catch (error) {
      console.error('Could not load StoreFlow data:', error);
      return createInitialState();
    }
  }

  let state = loadState();
  let undoHistory = loadUndoHistory();
  let undoBaseline = captureUndoState(state);

  function cloneData(value) {
    if (value === undefined) return undefined;
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function captureUndoState(source) {
    const snapshot = {};
    UNDO_SCALAR_KEYS.forEach(key => { snapshot[key] = cloneData(source[key]); });
    UNDO_COLLECTION_KEYS.forEach(key => { snapshot[key] = cloneData(Array.isArray(source[key]) ? source[key] : []); });
    return snapshot;
  }

  function sameData(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function buildUndoChanges(before, after) {
    const scalarChanges = {};
    const collectionChanges = {};

    UNDO_SCALAR_KEYS.forEach(key => {
      if (!sameData(before[key], after[key])) scalarChanges[key] = cloneData(before[key]);
    });

    UNDO_COLLECTION_KEYS.forEach(key => {
      const beforeItems = Array.isArray(before[key]) ? before[key] : [];
      const afterItems = Array.isArray(after[key]) ? after[key] : [];
      const beforeById = new Map(beforeItems.map(item => [item.id, item]));
      const afterById = new Map(afterItems.map(item => [item.id, item]));
      const records = [...new Set([...beforeById.keys(), ...afterById.keys()])]
        .filter(id => !sameData(beforeById.get(id), afterById.get(id)))
        .map(id => ({ id, before: beforeById.has(id) ? cloneData(beforeById.get(id)) : null }));
      if (records.length) collectionChanges[key] = { records, beforeOrder: beforeItems.map(item => item.id) };
    });

    if (!Object.keys(scalarChanges).length && !Object.keys(collectionChanges).length) return null;
    return { scalars: scalarChanges, collections: collectionChanges };
  }

  function loadUndoHistory() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(UNDO_STORAGE_KEY) || '[]');
      return Array.isArray(parsed)
        ? parsed.filter(entry => entry && entry.changes && typeof entry.changes === 'object').slice(0, MAX_UNDO_HISTORY)
        : [];
    } catch (error) {
      console.warn('StoreFlow could not load undo history:', error);
      return [];
    }
  }

  function persistUndoHistory() {
    undoHistory = undoHistory.slice(0, MAX_UNDO_HISTORY);
    let persisted = [...undoHistory];
    while (persisted.length && JSON.stringify(persisted).length > MAX_PERSISTED_UNDO_BYTES) persisted.pop();
    while (true) {
      try {
        if (persisted.length) window.localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(persisted));
        else window.localStorage.removeItem(UNDO_STORAGE_KEY);
        return;
      } catch (error) {
        if (!persisted.length) {
          console.warn('StoreFlow could not persist undo history:', error);
          return;
        }
        persisted.pop();
      }
    }
  }

  function commitPendingUndo() {
    const after = captureUndoState(state);
    if (pendingUndoActivities.length) {
      const changes = buildUndoChanges(undoBaseline, after);
      if (changes) {
        const activity = pendingUndoActivities[0];
        undoHistory.unshift({
          id: uid('undo'),
          createdAt: new Date().toISOString(),
          textKey: activity.textKey || '',
          textParams: cloneData(activity.textParams || {}),
          text: String(activity.text || ''),
          changes
        });
        persistUndoHistory();
      }
    }
    pendingUndoActivities = [];
    undoBaseline = after;
  }

  function syncUndoBaseline() {
    if (!pendingUndoActivities.length) undoBaseline = captureUndoState(state);
  }

  function applyUndoChanges(changes) {
    Object.entries(changes?.scalars || {}).forEach(([key, value]) => { state[key] = cloneData(value); });
    Object.entries(changes?.collections || {}).forEach(([key, change]) => {
      const current = Array.isArray(state[key]) ? state[key] : [];
      const byId = new Map(current.map(item => [item.id, item]));
      (change.records || []).forEach(record => {
        if (record.before === null) byId.delete(record.id);
        else byId.set(record.id, cloneData(record.before));
      });
      const beforeOrder = Array.isArray(change.beforeOrder) ? change.beforeOrder : [];
      const beforeIds = new Set(beforeOrder);
      state[key] = [
        ...beforeOrder.map(id => byId.get(id)).filter(Boolean),
        ...[...byId.values()].filter(item => !beforeIds.has(item.id))
      ];
    });
  }

  function undoActivityLabel(entry) {
    return entry?.textKey ? t(entry.textKey, entry.textParams || {}) : (entry?.text || t('dashboard.latestChange'));
  }

  function undoLatestChange() {
    const entry = undoHistory.shift();
    if (!entry) return;
    applyUndoChanges(entry.changes);
    pendingUndoActivities = [];
    persistUndoHistory();
    ensureValidSelections();
    undoBaseline = captureUndoState(state);
    renderAll();
    switchView(currentView);
    showToast(t('message.undoComplete', { action: undoActivityLabel(entry) }));
  }

  function t(key, params = {}) {
    return I18N.t(state.language, key, params);
  }

  function categoryLabel(category) {
    return t(`category.${category}`);
  }

  function orderItemCategory(item) {
    const part = state.parts.find(candidate => candidate.id === item?.partId);
    return normalizeCategory(part?.category || item?.category);
  }

  function applyTranslations() {
    document.documentElement.lang = state.language;
    document.title = t('meta.title');
    $$('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
    $$('[data-i18n-aria]').forEach(element => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
    if (els.languageSelect) els.languageSelect.value = state.language;
  }

  const els = {
    sidebar: $('.sidebar'), menuBtn: $('#menuBtn'), pageTitle: $('#pageTitle'), pageEyebrow: $('#pageEyebrow'),
    alertBar: $('#alertBar'), storageNotice: $('#storageNotice'), inventoryNote: $('#inventoryNote'),
    statProjects: $('#statProjects'), statParts: $('#statParts'), statLow: $('#statLow'), statOut: $('#statOut'), dashboardProjectName: $('#dashboardProjectName'),
    categoryProgress: $('#categoryProgress'), activityList: $('#activityList'), undoLatestBtn: $('#undoLatestBtn'),
    projectCards: $('#projectCards'), newProjectBtn: $('#newProjectBtn'),
    inventorySearch: $('#inventorySearch'), inventoryProjectFilter: $('#inventoryProjectFilter'), inventoryStockFilter: $('#inventoryStockFilter'), inventorySort: $('#inventorySort'), inventoryCategoryFilter: $('#inventoryCategoryFilter'),
    addPartBtn: $('#addPartBtn'), inventoryCards: $('#inventoryCards'), pendingPalletMatchNotice: $('#pendingPalletMatchNotice'),
    orderSelect: $('#orderSelect'), newOrderBtn: $('#newOrderBtn'), deleteOrderBtn: $('#deleteOrderBtn'), orderSummary: $('#orderSummary'), orderLifecycle: $('#orderLifecycle'), orderBoards: $('#orderBoards'), orderSendBar: $('#orderSendBar'), sendOrderBtn: $('#sendOrderBtn'),
    newStockPalletBtn: $('#newStockPalletBtn'), stockSummary: $('#stockSummary'), stockSearch: $('#stockSearch'), stockPackSearch: $('#stockPackSearch'), stockSearchInfo: $('#stockSearchInfo'), stockPlannerOptions: $('#stockPlannerOptions'), stockPlannerPackOptions: $('#stockPlannerPackOptions'), addStockSearchPart: $('#addStockSearchPart'), clearStockSearch: $('#clearStockSearch'), stockSelectedParts: $('#stockSelectedParts'), stockPlannerResults: $('#stockPlannerResults'), stockPalletGrid: $('#stockPalletGrid'),
    languageSelect: $('#languageSelect'), exportBtn: $('#exportBtn'), importInput: $('#importInput'), resetBtn: $('#resetBtn'), settingsTabs: $('.settings-tabs'),
    projectDialog: $('#projectDialog'), projectForm: $('#projectForm'), projectDialogTitle: $('#projectDialogTitle'), projectPhotoInput: $('#projectPhotoInput'),
    projectPhotoPreview: $('#projectPhotoPreview'), removeProjectPhotoBtn: $('#removeProjectPhotoBtn'),
    projectPartsDialog: $('#projectPartsDialog'), projectPartsForm: $('#projectPartsForm'), projectPartsTitle: $('#projectPartsTitle'), projectPartsSearch: $('#projectPartsSearch'), projectPartsList: $('#projectPartsList'),
    partDialog: $('#partDialog'), partForm: $('#partForm'), partDialogTitle: $('#partDialogTitle'), partProjectCheckboxes: $('#partProjectCheckboxes'), partDuplicateWarning: $('#partDuplicateWarning'),
    orderDialog: $('#orderDialog'), orderForm: $('#orderForm'), orderItemDialog: $('#orderItemDialog'), orderItemForm: $('#orderItemForm'), availabilityHint: $('#availabilityHint'),
    stockPalletDialog: $('#stockPalletDialog'), stockPalletForm: $('#stockPalletForm'), stockPalletDialogTitle: $('#stockPalletDialogTitle'),
    stockItemDialog: $('#stockItemDialog'), stockItemForm: $('#stockItemForm'), stockPartSearch: $('#stockPartSearch'), stockPartPack: $('#stockPartPack'), stockPartSuggestions: $('#stockPartSuggestions'), stockPartMatchHint: $('#stockPartMatchHint'), stockUnknownPart: $('#stockUnknownPart'), createStockMasterPartBtn: $('#createStockMasterPartBtn'), stockItemSubmitBtn: $('#stockItemSubmitBtn'),
    stockPalletDetailDialog: $('#stockPalletDetailDialog'), stockPalletDetailTitle: $('#stockPalletDetailTitle'), stockPalletDetailMeta: $('#stockPalletDetailMeta'), stockPalletItems: $('#stockPalletItems'), deleteStockPalletBtn: $('#deleteStockPalletBtn'), editStockPalletBtn: $('#editStockPalletBtn'), addStockPalletItemBtn: $('#addStockPalletItemBtn'),
    photoDialog: $('#photoDialog'), photoDialogTitle: $('#photoDialogTitle'), expandedProjectPhoto: $('#expandedProjectPhoto'), toast: $('#toast')
  };

  const viewMeta = {
    dashboard: ['view.dashboard.title', 'view.dashboard.eyebrow'], projects: ['view.projects.title', 'view.projects.eyebrow'], inventory: ['view.inventory.title', 'view.inventory.eyebrow'],
    orders: ['view.orders.title', 'view.orders.eyebrow'], stock: ['view.stock.title', 'view.stock.eyebrow'], settings: ['view.settings.title', 'view.settings.eyebrow']
  };

  function saveState() {
    storageSet(STORAGE_KEY, JSON.stringify(state));
    renderStorageNotice();
  }

  function renderStorageNotice() {
    els.storageNotice?.classList.toggle('hidden', storageAvailable);
  }

  function addActivity(textKey, detail = '') {
    const activity = { id: uid('activity'), textKey, detail, createdAt: new Date().toISOString() };
    state.activity.unshift(activity);
    state.activity = state.activity.slice(0, 40);
    pendingUndoActivities.push(activity);
  }

  function formatDate(iso) {
    try {
      const locale = I18N.languages.find(language => language.code === state.language)?.locale || 'en-GB';
      return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch (error) {
      return '';
    }
  }

  function getActiveProject() {
    return state.projects.find(project => project.id === state.activeProjectId) || null;
  }

  function getProjectName(id) {
    return state.projects.find(project => project.id === id)?.name || t('common.unknownProject');
  }

  function partInProject(part, projectId) {
    return Boolean(projectId && Array.isArray(part.projectIds) && part.projectIds.includes(projectId));
  }

  function getProjectParts(projectId) {
    return state.parts.filter(part => partInProject(part, projectId));
  }

  function getProjectNames(part) {
    return (part.projectIds || []).map(getProjectName).filter(name => name !== t('common.unknownProject'));
  }

  function getActiveOrders() {
    return state.orders.filter(order => order.projectId === state.activeProjectId);
  }

  function getSelectedOrder() {
    const activeOrders = getActiveOrders();
    let selected = activeOrders.find(order => order.id === state.selectedOrderId);
    if (!selected && activeOrders.length) {
      selected = activeOrders[0];
      state.selectedOrderId = selected.id;
    }
    return selected || null;
  }

  function orderSeriesName(order) {
    return String(order?.seriesName || order?.name || '').trim();
  }

  function nextOrderCycle(order) {
    const seriesName = orderSeriesName(order);
    const highestCycle = state.orders
      .filter(candidate => candidate.projectId === order.projectId && orderSeriesName(candidate) === seriesName)
      .reduce((highest, candidate) => Math.max(highest, positiveIntegerOrBlank(candidate.cycle) || 1), 1);
    return Math.max(highestCycle, positiveIntegerOrBlank(order.cycle) || 1) + 1;
  }

  function stockStatus(quantity) {
    if (quantity <= 0) return { key: 'out', label: t('status.out') };
    if (quantity <= 4) return { key: 'low', label: t('status.low') };
    return { key: 'healthy', label: t('status.healthy') };
  }

  function getStockPallet(id) {
    return state.stockPallets.find(pallet => pallet.id === id) || null;
  }

  function storedQuantityForPart(partId) {
    return state.stockPallets.reduce((total, pallet) => total + pallet.items.filter(item => item.partId === partId).reduce((sum, item) => sum + item.quantity, 0), 0);
  }

  function partIdentityMarkup(part) {
    if (!part) return `<strong class="part-name">${esc(t('inventory.deletedPart'))}</strong>`;
    return `<span class="part-code part-code-badge">${esc(part.code)}</span><strong class="part-name">${esc(part.name)}</strong>`;
  }

  function stockPackBadgeMarkup(packCode) {
    const fraction = packFractionFromDigits(packCode);
    return fraction ? `<span class="stock-pack-badge">${esc(t('stock.packLabel', { pack: fraction }))}</span>` : '';
  }

  function stockItemIdentityMarkup(item, part) {
    const packCode = normalizePackDigits(item?.packCode) || (part ? packDigitsForPart(part) : '');
    if (part) return `<span class="part-code part-code-badge">${esc(codeWithPack(part.code, packCode))}</span><strong class="part-name">${esc(part.name)}</strong>${stockPackBadgeMarkup(packCode)}`;
    if (!isPendingStockItem(item)) return partIdentityMarkup(null);
    const code = String(item.pendingCode || '').trim();
    const name = String(item.pendingName || '').trim();
    const ambiguous = item.matchStatus === 'ambiguous';
    return `<span class="unregistered-part-badge ${ambiguous ? 'multiple-match-badge' : ''}">${esc(t(ambiguous ? 'stock.multipleMatches' : 'stock.unregistered'))}</span>${code ? `<span class="part-code part-code-badge pending-part-code">${esc(codeWithPack(code, packCode))}</span>` : ''}<strong class="part-name">${esc(name || code)}</strong>${stockPackBadgeMarkup(packCode)}`;
  }

  function assemblyLabel(part) {
    return part.assemblyPosition && part.assemblyTotal ? `${part.assemblyPosition}/${part.assemblyTotal}` : '—';
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3400);
  }

  function switchView(view) {
    currentView = view;
    $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $$('.view').forEach(section => section.classList.toggle('active-view', section.id === `${view}View`));
    const [titleKey, eyebrowKey] = viewMeta[view] || viewMeta.dashboard;
    els.pageTitle.textContent = t(titleKey);
    els.pageEyebrow.textContent = t(eyebrowKey);
    els.sidebar.classList.remove('open');
    if (view === 'inventory') renderInventory();
    if (view === 'orders') renderOrders();
    if (view === 'stock') renderStock();
  }

  function ensureValidSelections() {
    if (!state.projects.some(project => project.id === state.activeProjectId)) state.activeProjectId = state.projects[0]?.id || null;
    const activeOrders = getActiveOrders();
    if (!activeOrders.some(order => order.id === state.selectedOrderId)) state.selectedOrderId = activeOrders[0]?.id || null;
  }

  function renderAll() {
    ensureValidSelections();
    commitPendingUndo();
    applyTranslations();
    renderProjectSelectors();
    renderDashboard();
    renderProjects();
    renderInventory();
    renderOrders();
    renderStock();
    renderAlertBar();
    renderInventoryNotice();
    renderSettingsTabs();
    saveState();
    syncUndoBaseline();
  }

  function renderProjectSelectors() {
    const projectOptions = state.projects.length
      ? state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')
      : `<option value="">${esc(t('projects.none'))}</option>`;

    const previousFilter = els.inventoryProjectFilter.value || 'all';
    els.inventoryProjectFilter.innerHTML = `<option value="all">${esc(t('inventory.allParts'))}</option><option value="unassigned">${esc(t('inventory.notInProject'))}</option>${projectOptions}`;
    els.inventoryProjectFilter.value = [...els.inventoryProjectFilter.options].some(option => option.value === previousFilter) ? previousFilter : 'all';

    els.newOrderBtn.disabled = !state.projects.length;
  }

  function renderAlertBar() {
    const parts = state.parts;
    const low = parts.filter(part => part.quantity > 0 && part.quantity <= 4).length;
    const out = parts.filter(part => part.quantity <= 0).length;
    const signature = `${out}:${low}`;
    if (!low && !out) {
      els.alertBar.classList.add('hidden');
      return;
    }
    if (state.dismissedNotices.stockAlertSignature === signature) {
      els.alertBar.classList.add('hidden');
      return;
    }
    const messages = [];
    if (out) messages.push(t('alert.out', { count: out }));
    if (low) messages.push(t('alert.low', { count: low }));
    els.alertBar.innerHTML = `<span>${esc(t('alert.message', { counts: messages.join(t('alert.join')) }))}</span><button type="button" class="notice-close" data-dismiss-notice="stock-alert" data-signature="${signature}" aria-label="${esc(t('alert.closeAria'))}">×</button>`;
    els.alertBar.classList.remove('hidden');
  }

  function renderInventoryNotice() {
    els.inventoryNote.classList.toggle('hidden', Boolean(state.dismissedNotices.inventoryInfo));
  }

  function renderSettingsTabs() {
    $$('[data-settings-tab]').forEach(button => {
      const active = button.dataset.settingsTab === activeSettingsTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$('[data-settings-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.settingsPanel !== activeSettingsTab));
  }

  function dismissNotice(key, signature = '') {
    if (key === 'inventory-info') state.dismissedNotices.inventoryInfo = true;
    if (key === 'stock-alert') state.dismissedNotices.stockAlertSignature = signature;
    renderAlertBar();
    renderInventoryNotice();
    saveState();
    syncUndoBaseline();
  }

  function renderDashboard() {
    const lowParts = state.parts.filter(part => part.quantity > 0 && part.quantity <= 4);
    const outParts = state.parts.filter(part => part.quantity <= 0);

    els.statProjects.textContent = state.projects.length;
    els.statParts.textContent = state.parts.length;
    els.statLow.textContent = lowParts.length;
    els.statOut.textContent = outParts.length;
    els.dashboardProjectName.textContent = getActiveProject()?.name || t('dashboard.createFirstProject');
    const latestUndo = undoHistory[0] || null;
    els.undoLatestBtn.disabled = !latestUndo;
    els.undoLatestBtn.setAttribute('aria-label', latestUndo
      ? t('dashboard.undoAria', { action: undoActivityLabel(latestUndo) })
      : t('dashboard.undoUnavailable'));
    els.undoLatestBtn.title = latestUndo
      ? t('dashboard.undoAria', { action: undoActivityLabel(latestUndo) })
      : t('dashboard.undoUnavailable');

    const order = getSelectedOrder();
    els.categoryProgress.innerHTML = CATEGORIES.map(category => {
      const items = order?.items.filter(item => orderItemCategory(item) === category) || [];
      const packed = items.filter(item => item.packed).length;
      const percentage = items.length ? Math.round((packed / items.length) * 100) : 0;
      return `<div class="category-card"><div class="top"><strong>${esc(categoryLabel(category))}</strong><span>${packed}/${items.length}</span></div><div class="progress-track"><div class="progress-fill" style="width:${percentage}%"></div></div></div>`;
    }).join('');

    els.activityList.innerHTML = state.activity.length
      ? state.activity.slice(0, 8).map(activity => `<div class="activity-item"><div><strong>${esc(activity.textKey ? t(activity.textKey, activity.textParams) : activity.text)}</strong><span>${esc(activity.detailKey ? t(activity.detailKey, activity.detailParams) : activity.detail)}</span></div><span>${formatDate(activity.createdAt)}</span></div>`).join('')
      : `<div class="empty-state"><strong>${esc(t('dashboard.noActivity'))}</strong><span>${esc(t('dashboard.activityHint'))}</span></div>`;
  }

  function renderProjects() {
    if (!state.projects.length) {
      els.projectCards.innerHTML = `<div class="empty-state panel"><strong>${esc(t('projects.none'))}</strong><span>${esc(t('projects.noneHint'))}</span></div>`;
      return;
    }

    els.projectCards.innerHTML = state.projects.map(project => {
      const linkedParts = getProjectParts(project.id);
      const totalQty = linkedParts.reduce((sum, part) => sum + part.quantity, 0);
      const orderCount = state.orders.filter(order => order.projectId === project.id).length;
      const isActive = project.id === state.activeProjectId;
      const photo = project.photo
        ? `<button type="button" class="project-card-photo project-photo-expand" data-id="${esc(project.id)}" aria-label="${esc(t('projects.expandPhotoAria', { name: project.name }))}"><img src="${esc(project.photo)}" alt="${esc(project.name)}" /><span class="photo-expand-hint">${esc(t('projects.tapExpand'))}</span></button>`
        : `<div class="project-card-photo"><div class="project-photo-placeholder"><span>SF</span><small>${esc(t('projects.addPhoto'))}</small></div></div>`;
      return `<article class="project-card ${isActive ? 'active' : ''}">
        ${photo}
        <div class="project-card-body">
          <div class="project-card-head"><div><p class="eyebrow">${esc(t('projects.label'))}</p><h3>${esc(project.name)}</h3></div><button class="icon-button project-delete" data-id="${esc(project.id)}" aria-label="${esc(t('projects.deleteAria'))}">×</button></div>
          <p class="muted">${esc(project.location || t('common.noLocationSet'))}${project.reference ? ` · ${esc(project.reference)}` : ''}</p>
          <div class="project-meta"><span class="meta-chip">${esc(t('common.linkedParts', { count: linkedParts.length }))}</span><span class="meta-chip">${esc(t('common.sharedUnits', { count: totalQty }))}</span><span class="meta-chip">${esc(t('common.orders', { count: orderCount }))}</span></div>
          <div class="project-actions project-actions-wrap">
            <button class="${isActive ? 'secondary' : 'primary'} project-open" data-id="${esc(project.id)}">${esc(t('projects.open'))}</button>
            <button class="secondary project-manage-parts" data-id="${esc(project.id)}">${esc(t('projects.manageParts'))}</button>
            <button class="secondary project-edit" data-id="${esc(project.id)}">${esc(t('projects.edit'))}</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  function getFilteredInventory() {
    const query = els.inventorySearch.value.trim();
    const projectFilter = els.inventoryProjectFilter.value || 'all';
    const stockFilter = els.inventoryStockFilter.value || 'all';
    const sort = els.inventorySort.value || 'name';
    const categoryFilter = els.inventoryCategoryFilter.value || 'all';

    const filtered = state.parts.filter(part => {
      const matchesQuery = partMatchesSearch(part, query);
      const matchesProject = projectFilter === 'all'
        || (projectFilter === 'unassigned' && !(part.projectIds || []).length)
        || partInProject(part, projectFilter);
      const matchesStock = stockFilter === 'all'
        || (stockFilter === 'low' && part.quantity > 0 && part.quantity <= 4)
        || (stockFilter === 'out' && part.quantity <= 0)
        || (stockFilter === 'healthy' && part.quantity >= 5)
        || (stockFilter === 'overflowing' && part.overflowing);
      const matchesCategory = categoryFilter === 'all' || part.category === categoryFilter;
      return matchesQuery && matchesProject && matchesStock && matchesCategory;
    });

    filtered.sort((a, b) => {
      if (sort === 'code') return a.code.localeCompare(b.code, undefined, { numeric: true });
      if (sort === 'qtyAsc') return a.quantity - b.quantity || a.name.localeCompare(b.name);
      if (sort === 'qtyDesc') return b.quantity - a.quantity || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
    return filtered;
  }

  function projectChips(part, limit = 3) {
    const names = getProjectNames(part);
    if (!names.length) return `<span class="meta-chip muted-chip">${esc(t('common.unassigned'))}</span>`;
    const shown = names.slice(0, limit).map(name => `<span class="meta-chip">${esc(name)}</span>`).join('');
    return `${shown}${names.length > limit ? `<span class="meta-chip">+${names.length - limit}</span>` : ''}`;
  }

  function renderInventory() {
    renderPendingPalletMatchNotice();
    const parts = getFilteredInventory();
    const visibleIds = new Set(parts.map(part => part.id));
    if (openInventoryMenuPartId && !visibleIds.has(openInventoryMenuPartId)) openInventoryMenuPartId = null;
    els.inventoryCards.innerHTML = parts.length ? parts.map(part => {
      const status = stockStatus(part.quantity);
      const storedQuantity = storedQuantityForPart(part.id);
      const expanded = expandedInventoryPartIds.has(part.id);
      const menuOpen = openInventoryMenuPartId === part.id;
      const details = expanded ? `<div class="inventory-card-details">
        <div class="inventory-detail-grid">
          <div class="inventory-detail"><span>${esc(t('inventory.table.category'))}</span><strong>${esc(categoryLabel(part.category))}</strong></div>
          <div class="inventory-detail"><span>${esc(t('inventory.table.size'))}</span><strong>${esc(dimensionLabel(part))}</strong></div>
          <div class="inventory-detail"><span>${esc(t('inventory.table.store'))}</span><strong>${storedQuantity}</strong></div>
          <div class="inventory-detail detail-wide"><span>${esc(t('common.notes'))}</span><strong>${esc(part.notes || t('inventory.noNotes'))}</strong></div>
          <div class="inventory-detail detail-wide"><span>${esc(t('inventory.table.projects'))}</span><div class="project-chip-row">${projectChips(part, 20)}</div></div>
        </div>
      </div>` : '';
      return `<article aria-expanded="${expanded}" aria-label="${esc(t('inventory.cardAria', { part: `${part.code} — ${part.name}` }))}" class="inventory-card ${expanded ? 'expanded' : ''}" data-part-card="${esc(part.id)}" tabindex="0">
        <div class="inventory-card-head">
          <div class="inventory-card-identity"><span aria-label="${esc(t('inventory.stockCodeAria', { code: part.code, status: status.label }))}" class="part-code part-code-badge code-status-${status.key}">${esc(part.code)}</span><strong class="part-name">${esc(part.name)}</strong><span class="assembly-persistent">${esc(t('inventory.assemblyLabel', { assembly: assemblyLabel(part) }))}</span></div>
          <button aria-expanded="${menuOpen}" aria-haspopup="menu" aria-label="${esc(t('inventory.moreActionsAria', { part: part.code }))}" class="inventory-menu-toggle" data-action="menu" data-id="${esc(part.id)}" type="button">⋯</button>
          <div class="inventory-card-menu ${menuOpen ? 'open' : ''}" role="menu"><button data-action="edit" data-id="${esc(part.id)}" role="menuitem" type="button">${esc(t('common.edit'))}</button><button class="danger-option" data-action="delete" data-id="${esc(part.id)}" role="menuitem" type="button">${esc(t('common.delete'))}</button></div>
        </div>
        ${details}
        <div class="inventory-card-bottom">
          <div class="inventory-quantity"><span class="inventory-control-label">${esc(t('inventory.quantityLabel'))}</span><div class="stock-control large"><button type="button" data-action="minus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.reduceAria'))}">−</button><strong>${part.quantity}</strong><button type="button" data-action="plus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.increaseAria'))}">+</button></div></div>
          <label class="overflow-switch"><span class="overflow-switch-label ${part.overflowing ? 'active' : ''}">${esc(t('status.overflowing'))}</span><input aria-label="${esc(t('inventory.overflowSwitchAria', { part: part.code }))}" data-action="overflow-switch" data-id="${esc(part.id)}" type="checkbox" ${part.overflowing ? 'checked' : ''}/><span aria-hidden="true" class="switch-track"><span class="switch-thumb"></span></span></label>
        </div>
      </article>`;
    }).join('') : `<div class="empty-state"><strong>${esc(t('inventory.noneMatch'))}</strong><span>${esc(t('inventory.noneMatchHint'))}</span></div>`;
  }

  function renderPendingPalletMatchNotice() {
    const matches = pendingStockMatchesForText(els.inventorySearch.value);
    if (!matches.length) {
      els.pendingPalletMatchNotice.classList.add('hidden');
      els.pendingPalletMatchNotice.innerHTML = '';
      return;
    }
    const firstItem = matches[0].item;
    const label = pendingStockItemLabel(firstItem);
    const candidateParts = state.parts.filter(part => pendingStockItemMatchesPart(firstItem, part));
    let help = t('inventory.pendingCreateHelp');
    let action = `<button class="secondary" data-pending-action="create" type="button">${esc(t('inventory.pendingCreate'))}</button>`;
    if (candidateParts.length === 1) {
      const part = candidateParts[0];
      help = t('inventory.pendingLinkHelp', { code: part.code, name: part.name });
      action = `<button class="secondary" data-part-id="${esc(part.id)}" data-pending-action="link" type="button">${esc(t('inventory.pendingLink'))}</button>`;
    } else if (candidateParts.length > 1) {
      help = t('inventory.pendingAmbiguousHelp');
      action = `<div class="pending-link-actions">${candidateParts.map(part => `<button class="secondary pending-candidate-link" data-part-id="${esc(part.id)}" data-pending-action="link" type="button"><span>${esc(part.code)} — ${esc(part.name)}</span><small>${esc(t('inventory.assemblyLabel', { assembly: assemblyLabel(part) }))}</small></button>`).join('')}</div>`;
    }
    els.pendingPalletMatchNotice.innerHTML = `<div><strong>${esc(t('inventory.pendingFound', { count: matches.length, part: label }))}</strong><span>${esc(help)}</span></div>${action}`;
    els.pendingPalletMatchNotice.classList.remove('hidden');
  }

  function renderOrders() {
    const orders = getActiveOrders();
    els.orderSelect.innerHTML = orders.length ? orders.map(order => `<option value="${esc(order.id)}">${esc(order.name)}${order.sentAt ? ` · ${esc(t('orders.sentStatus'))}` : ''}</option>`).join('') : `<option value="">${esc(t('orders.none'))}</option>`;
    els.orderSelect.disabled = !orders.length;
    els.deleteOrderBtn.disabled = !orders.length;
    const order = getSelectedOrder();
    if (order) els.orderSelect.value = order.id;
    els.orderLifecycle.classList.add('hidden');
    els.orderLifecycle.innerHTML = '';
    els.orderSendBar.classList.add('hidden');

    if (!state.activeProjectId) {
      els.orderSummary.innerHTML = '';
      els.orderBoards.innerHTML = `<div class="empty-state panel"><strong>${esc(t('orders.createProject'))}</strong><span>${esc(t('orders.createProjectHint'))}</span></div>`;
      return;
    }
    if (!order) {
      els.orderSummary.innerHTML = '';
      els.orderBoards.innerHTML = `<div class="empty-state panel"><strong>${esc(t('orders.noneForProject'))}</strong><span>${esc(t('orders.noneForProjectHint'))}</span></div>`;
      return;
    }

    const sent = Boolean(order.sentAt);
    const total = order.items.length;
    const packed = order.items.filter(item => item.packed).length;
    const shortages = order.items.filter(item => {
      if (item.packed) return false;
      const part = state.parts.find(candidate => candidate.id === item.partId);
      return !part || part.quantity < item.quantityNeeded;
    }).length;
    els.orderSummary.innerHTML = `<div class="summary-chip"><span>${esc(t('orders.requiredLines'))}</span><strong>${total}</strong></div><div class="summary-chip"><span>${esc(t('orders.packedLines'))}</span><strong>${packed}</strong></div><div class="summary-chip"><span>${esc(t('orders.shortages'))}</span><strong>${shortages}</strong></div>`;
    els.orderSendBar.classList.remove('hidden');
    els.orderSendBar.classList.toggle('sent', sent);
    els.sendOrderBtn.disabled = sent || !order.items.length;
    els.sendOrderBtn.textContent = t(sent ? 'orders.sentButton' : 'orders.send');
    els.sendOrderBtn.title = sent ? t('orders.sentLocked') : (!order.items.length ? t('orders.sendEmpty') : t('orders.sendHelp'));
    if (sent) {
      els.orderLifecycle.innerHTML = `<strong>${esc(t('orders.sentBannerTitle'))}</strong><span>${esc(t('orders.sentBannerBody', { date: formatDate(order.sentAt) }))}</span>`;
      els.orderLifecycle.classList.remove('hidden');
    }

    els.orderBoards.innerHTML = CATEGORIES.map(category => {
      const items = order.items.filter(item => orderItemCategory(item) === category);
      const itemHtml = items.length ? items.map(item => {
        const part = state.parts.find(candidate => candidate.id === item.partId);
        const available = part?.quantity ?? 0;
        const insufficient = !item.packed && available < item.quantityNeeded;
        const codeName = part ? `${part.code} — ${part.name}` : t('inventory.deletedPart');
        const size = part ? dimensionLabel(part) : '';
        const metadata = part ? [size !== '—' ? size : '', assemblyLabel(part) !== '—' ? t('orders.partMeta', { assembly: assemblyLabel(part) }) : ''].filter(Boolean).join(' · ') : '';
        const stockText = item.packed ? t('orders.packedStock') : t('orders.sharedStock', { count: available, metadata: metadata ? ` · ${metadata}` : '' });
        const notes = String(part?.notes || '').trim();
        return `<div class="check-item ${item.packed ? 'packed' : ''} ${sent ? 'sent-order-item' : ''}">
          <input type="checkbox" data-action="toggle-pack" data-item-id="${esc(item.id)}" ${item.packed ? 'checked' : ''} ${!part || sent ? 'disabled' : ''} />
          <div class="part-label"><div class="part-identity-inline">${partIdentityMarkup(part)}</div><span>${esc(stockText)}</span>${notes ? `<span class="order-part-notes">${esc(t('orders.partNotes', { notes }))}</span>` : ''}</div>
          <label class="needed-editor ${insufficient ? 'short' : ''}">
            <span>${esc(t('orders.needed'))}</span>
            <input type="number" min="1" step="1" inputmode="numeric" value="${item.quantityNeeded}" data-action="edit-needed" data-item-id="${esc(item.id)}" aria-label="${esc(t('orders.neededAria', { name: codeName }))}" ${!part || sent ? 'disabled' : ''} />
          </label>
          <button class="remove-item" data-action="remove-order-item" data-item-id="${esc(item.id)}" aria-label="${esc(t('orders.removeAria'))}" ${sent ? 'disabled' : ''}>×</button>
        </div>`;
      }).join('') : `<div class="column-empty">${esc(t('orders.noneInSection'))}</div>`;
      return `<article class="order-column ${sent ? 'sent-order-column' : ''}"><div class="order-column-head"><h3>${esc(categoryLabel(category))}</h3><button data-action="add-order-item" data-category="${category}" ${sent ? 'disabled' : ''}>${esc(t('orders.addPart'))}</button></div><div class="checklist">${itemHtml}</div></article>`;
    }).join('');
  }

  function stockPlannerPartLabel(part) {
    return `${part.code} — ${part.name}`;
  }

  function resolveStockPlannerPart(value, packCode) {
    return resolveUniquePartSearch(value, packCode);
  }

  function splitPlannerValues(value) {
    return String(value || '').split(/[,;\n]+/).map(item => item.trim()).filter(Boolean);
  }

  function addStockPlannerParts(rawValue = els.stockSearch.value, rawPackValue = els.stockPackSearch.value) {
    const tokens = String(rawValue || '').split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
    if (!tokens.length) return;
    const packTokens = splitPlannerValues(rawPackValue);
    if (packTokens.length !== tokens.length) {
      stockPlannerFeedback = { key: 'stock.planner.packCountMismatch', params: { count: tokens.length } };
      renderStock();
      return;
    }
    const packCodes = packTokens.map(normalizePackDigits);
    const invalidPackIndex = packCodes.findIndex(packCode => !packCode);
    if (invalidPackIndex >= 0) {
      stockPlannerFeedback = { key: 'stock.planner.packRequired', params: { part: tokens[invalidPackIndex] } };
      renderStock();
      return;
    }
    let added = 0;
    let duplicate = '';
    let unresolved = null;
    let pendingAdded = '';
    tokens.forEach((token, index) => {
      const packCode = packCodes[index];
      const result = resolveStockPlannerPart(token, packCode);
      const pendingMatch = pendingStockMatchesForText(token, packCode)[0]?.item || null;
      const reference = result.part?.id || (pendingMatch ? stockPlannerReferenceForItem(pendingMatch) : '');
      const packLabel = t('stock.packLabel', { pack: packFractionFromDigits(packCode) });
      const label = `${result.part?.code || pendingStockItemLabel(pendingMatch) || token} · ${packLabel}`;
      if (!reference) {
        if (!unresolved) unresolved = { token: `${token} · ${packLabel}`, reason: result.reason };
        return;
      }
      if (selectedStockPartIds.has(reference)) {
        if (!duplicate) duplicate = label;
        return;
      }
      selectedStockPartIds.add(reference);
      if (!result.part) pendingAdded = label;
      added += 1;
    });
    els.stockSearch.value = '';
    els.stockPackSearch.value = '';
    if (unresolved) stockPlannerFeedback = { key: unresolved.reason === 'ambiguous' ? 'stock.planner.ambiguous' : 'stock.planner.noMatch', params: { part: unresolved.token } };
    else if (duplicate && !added) stockPlannerFeedback = { key: 'stock.planner.alreadySelected', params: { part: duplicate } };
    else if (pendingAdded && added === 1) stockPlannerFeedback = { key: 'stock.planner.pendingAdded', params: { part: pendingAdded } };
    else stockPlannerFeedback = { key: added === 1 ? 'stock.planner.addedOne' : 'stock.planner.addedMany', params: { count: added } };
    renderStock();
  }

  function bitCount(value) {
    let count = 0;
    let remaining = value;
    while (remaining) {
      remaining &= remaining - 1n;
      count += 1;
    }
    return count;
  }

  function comparePlannerPlans(a, b) {
    for (const key of ['overflowUnits', 'overflowLines', 'palletCount', 'unrelatedUnits', 'unrelatedLines']) {
      if (a[key] !== b[key]) return a[key] - b[key];
    }
    if (a.requestedUnits !== b.requestedUnits) return b.requestedUnits - a.requestedUnits;
    return a.pallets.map(candidate => candidate.pallet.id).sort().join('|').localeCompare(b.pallets.map(candidate => candidate.pallet.id).sort().join('|'));
  }

  function stockPlannerCandidate(pallet, requestedIds, bitById) {
    let coverage = 0n;
    let requestedUnits = 0;
    let unrelatedUnits = 0;
    let unrelatedLines = 0;
    let overflowUnits = 0;
    let overflowLines = 0;
    const coveredPartIds = new Set();
    const overflowItems = [];
    pallet.items.forEach(item => {
      const part = state.parts.find(candidate => candidate.id === item.partId);
      const reference = stockPlannerReferenceForItem(item);
      if (requestedIds.has(reference)) {
        coverage |= bitById.get(reference) || 0n;
        coveredPartIds.add(reference);
        requestedUnits += item.quantity;
      } else {
        unrelatedUnits += item.quantity;
        unrelatedLines += 1;
      }
      if (part?.overflowing) {
        overflowUnits += item.quantity;
        overflowLines += 1;
        overflowItems.push({ part, quantity: item.quantity });
      }
    });
    return { pallet, coverage, coveredPartIds, requestedUnits, unrelatedUnits, unrelatedLines, overflowUnits, overflowLines, overflowItems };
  }

  function addCandidateToPlan(plan, candidate) {
    return {
      mask: plan.mask | candidate.coverage,
      pallets: [...plan.pallets, candidate],
      overflowUnits: plan.overflowUnits + candidate.overflowUnits,
      overflowLines: plan.overflowLines + candidate.overflowLines,
      palletCount: plan.palletCount + 1,
      unrelatedUnits: plan.unrelatedUnits + candidate.unrelatedUnits,
      unrelatedLines: plan.unrelatedLines + candidate.unrelatedLines,
      requestedUnits: plan.requestedUnits + candidate.requestedUnits
    };
  }

  function optimizeStockPallets(partIds) {
    const availableReferences = new Set([
      ...state.parts.map(part => part.id),
      ...state.stockPallets.flatMap(pallet => pallet.items.filter(isPendingStockItem).map(stockPlannerReferenceForItem))
    ]);
    const validIds = [...new Set(partIds)].filter(id => availableReferences.has(id));
    const requestedIds = new Set(validIds);
    const bitById = new Map(validIds.map((id, index) => [id, 1n << BigInt(index)]));
    const candidates = state.stockPallets.map(pallet => stockPlannerCandidate(pallet, requestedIds, bitById)).filter(candidate => candidate.coverage);
    const targetMask = candidates.reduce((mask, candidate) => mask | candidate.coverage, 0n);
    const unavailablePartIds = validIds.filter(id => !(targetMask & bitById.get(id)));
    const emptyPlan = { mask: 0n, pallets: [], overflowUnits: 0, overflowLines: 0, palletCount: 0, unrelatedUnits: 0, unrelatedLines: 0, requestedUnits: 0 };
    if (!targetMask) return { ...emptyPlan, unavailablePartIds, exact: true, targetMask };

    let bestPlan;
    let exact = validIds.length <= 16;
    if (exact) {
      const plans = new Map([[0n, emptyPlan]]);
      candidates.forEach(candidate => {
        const snapshot = [...plans.values()];
        snapshot.forEach(plan => {
          const nextMask = plan.mask | candidate.coverage;
          if (nextMask === plan.mask) return;
          const proposal = addCandidateToPlan(plan, candidate);
          const current = plans.get(nextMask);
          if (!current || comparePlannerPlans(proposal, current) < 0) plans.set(nextMask, proposal);
        });
      });
      bestPlan = plans.get(targetMask);
    } else {
      let plan = emptyPlan;
      const unused = new Set(candidates);
      while (plan.mask !== targetMask) {
        const remainingMask = targetMask & ~plan.mask;
        const useful = [...unused].filter(candidate => candidate.coverage & remainingMask);
        const zeroOverflowCoverage = useful.filter(candidate => !candidate.overflowUnits).reduce((mask, candidate) => mask | candidate.coverage, 0n);
        const forcedOverflowMask = remainingMask & ~zeroOverflowCoverage;
        const pool = forcedOverflowMask
          ? useful.filter(candidate => candidate.coverage & forcedOverflowMask)
          : useful.filter(candidate => !candidate.overflowUnits);
        pool.sort((a, b) => {
          const aNew = bitCount(a.coverage & remainingMask);
          const bNew = bitCount(b.coverage & remainingMask);
          const aForced = bitCount(a.coverage & forcedOverflowMask) || aNew;
          const bForced = bitCount(b.coverage & forcedOverflowMask) || bNew;
          const aOverflowRate = a.overflowUnits / aForced;
          const bOverflowRate = b.overflowUnits / bForced;
          return aOverflowRate - bOverflowRate || bForced - aForced || bNew - aNew || a.unrelatedUnits - b.unrelatedUnits || b.requestedUnits - a.requestedUnits;
        });
        const chosen = pool[0];
        if (!chosen) break;
        plan = addCandidateToPlan(plan, chosen);
        unused.delete(chosen);
      }
      bestPlan = plan;
    }

    const ordered = [];
    const remaining = new Set(bestPlan.pallets);
    let remainingMask = targetMask;
    while (remaining.size) {
      const ranked = [...remaining].sort((a, b) => {
        const aNew = bitCount(a.coverage & remainingMask);
        const bNew = bitCount(b.coverage & remainingMask);
        return bNew - aNew || a.overflowUnits - b.overflowUnits || a.unrelatedUnits - b.unrelatedUnits || b.requestedUnits - a.requestedUnits;
      });
      const chosen = ranked[0];
      ordered.push(chosen);
      remaining.delete(chosen);
      remainingMask &= ~chosen.coverage;
    }
    return { ...bestPlan, pallets: ordered, unavailablePartIds, exact, targetMask };
  }

  function stockPalletCardMarkup(pallet, plannerCandidate = null, recommendationIndex = 0, requestedIds = new Set()) {
    const units = pallet.items.reduce((sum, item) => sum + item.quantity, 0);
    const expanded = expandedStockPalletIds.has(pallet.id);
    const menuOpen = openStockPalletMenuId === pallet.id;
    const sortedItems = plannerCandidate
      ? [...pallet.items].sort((a, b) => Number(requestedIds.has(stockPlannerReferenceForItem(b))) - Number(requestedIds.has(stockPlannerReferenceForItem(a))))
      : pallet.items;
    const partRows = sortedItems.map(item => {
      const part = state.parts.find(candidate => candidate.id === item.partId);
      const match = plannerCandidate && requestedIds.has(stockPlannerReferenceForItem(item));
      const itemLabel = part?.code || pendingStockItemLabel(item) || t('common.part');
      return `<div class="stock-card-part ${match ? 'requested-part-match' : ''}">
        <div>${stockItemIdentityMarkup(item, part)}${match ? `<small class="needed-match-label">${esc(t('stock.planner.neededPart'))}</small>` : ''}</div>
        <label class="stock-card-quantity"><span>${esc(t('stock.onPallet'))}</span><input aria-label="${esc(t('stock.quantityAria', { part: itemLabel }))}" data-item-id="${esc(item.id)}" data-pallet-id="${esc(pallet.id)}" data-stock-action="edit-quantity" inputmode="numeric" min="1" step="1" type="number" value="${item.quantity}"/></label>
        <button aria-label="${esc(t('stock.removePartAria'))}" class="remove-item" data-item-id="${esc(item.id)}" data-pallet-id="${esc(pallet.id)}" data-stock-action="remove-item" type="button">×</button>
      </div>`;
    }).join('');
    const overflowItems = pallet.items.map(item => ({ item, part: state.parts.find(part => part.id === item.partId) })).filter(entry => entry.part?.overflowing);
    const recommendationLabel = plannerCandidate ? `<div class="recommendation-label">${esc(t(recommendationIndex ? 'stock.planner.additional' : 'stock.planner.primary'))}</div>` : '';
    const recommendationDetails = plannerCandidate ? `
      <div class="planner-card-coverage">${esc(t('stock.planner.covers', { parts: [...plannerCandidate.coveredPartIds].map(stockPlannerReferenceLabel).filter(Boolean).join(', ') }))}</div>
      ${plannerCandidate.unrelatedLines ? `<div class="planner-card-extra">${esc(t('stock.planner.otherLines', { count: plannerCandidate.unrelatedLines, units: plannerCandidate.unrelatedUnits }))}</div>` : ''}
      ${plannerCandidate.overflowUnits ? `<div class="planner-overflow-warning" role="status"><strong>${esc(t('stock.planner.overflowWarning'))}</strong><span>${esc(t('stock.planner.overflowContents', { parts: plannerCandidate.overflowItems.map(entry => `${entry.part.code} ×${entry.quantity}`).join(', ') }))}</span></div>` : ''}` : '';
    const expandedContent = expanded ? `<div class="stock-card-expanded">
      ${recommendationDetails}
      <div class="stock-card-parts">${partRows || `<span class="muted">${esc(t('stock.noPartsYet'))}</span>`}</div>
      ${pallet.notes ? `<p class="stock-pallet-note">${esc(pallet.notes)}</p>` : ''}
    </div>` : '';
    return `<article aria-expanded="${expanded}" aria-label="${esc(t('stock.cardAria', { delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))}" class="stock-pallet-card ${expanded ? 'expanded' : ''} ${menuOpen ? 'menu-open' : ''} ${plannerCandidate ? 'recommended-pallet' : ''} ${plannerCandidate?.overflowUnits ? 'overflow-risk' : ''}" data-stock-pallet-card="${esc(pallet.id)}" tabindex="0">
      <div class="stock-pallet-card-head"><div><span class="delivery-label">${esc(t('common.delivery'))} ${esc(pallet.deliveryNumber)}</span><h3>${esc(t('common.pallet'))} ${esc(pallet.palletNumber)}</h3></div><button aria-expanded="${menuOpen}" aria-haspopup="menu" aria-label="${esc(t('stock.moreActionsAria', { delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))}" class="stock-pallet-menu-toggle" data-pallet-id="${esc(pallet.id)}" data-stock-action="menu" type="button">⋯</button><div class="stock-pallet-card-menu ${menuOpen ? 'open' : ''}" role="menu"><button data-pallet-id="${esc(pallet.id)}" data-stock-action="add-part" role="menuitem" type="button">${esc(t('stock.addParts'))}</button><button data-pallet-id="${esc(pallet.id)}" data-stock-action="edit-details" role="menuitem" type="button">${esc(t('stock.editDetails'))}</button><button class="danger-option" data-pallet-id="${esc(pallet.id)}" data-stock-action="delete" role="menuitem" type="button">${esc(t('common.delete'))}</button></div></div>
      ${recommendationLabel}
      <div class="stock-pallet-meta"><span>${esc(t('common.partLines', { count: pallet.items.length }))}</span><span>${esc(t('common.units', { count: units }))}</span>${overflowItems.length ? `<span class="overflow-text">${esc(t('stock.overflowingCount', { count: overflowItems.length }))}</span>` : ''}</div>
      ${expandedContent}
    </article>`;
  }

  function renderStock() {
    const validReferences = new Set([
      ...state.parts.map(part => part.id),
      ...state.stockPallets.flatMap(pallet => pallet.items.filter(isPendingStockItem).map(stockPlannerReferenceForItem))
    ]);
    selectedStockPartIds = new Set([...selectedStockPartIds].filter(reference => validReferences.has(reference)));
    const selectedEntries = [...selectedStockPartIds].map(stockPlannerEntryForReference).filter(Boolean);
    const requestedIds = new Set(selectedEntries.map(entry => entry.reference));
    const pallets = [...state.stockPallets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const storedUnits = state.stockPallets.reduce((sum, pallet) => sum + pallet.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
    const distinctParts = new Set(state.stockPallets.flatMap(pallet => pallet.items.map(item => item.partId || pendingStockItemKey(item)))).size;
    els.stockSummary.innerHTML = `<div class="summary-chip"><span>${esc(t('stock.storedPallets'))}</span><strong>${state.stockPallets.length}</strong></div><div class="summary-chip"><span>${esc(t('stock.differentParts'))}</span><strong>${distinctParts}</strong></div><div class="summary-chip"><span>${esc(t('stock.unitsAtStore'))}</span><strong>${storedUnits}</strong></div>`;

    const pendingOptions = [...new Map(state.stockPallets.flatMap(pallet => pallet.items.filter(isPendingStockItem).map(item => [stockPlannerReferenceForItem(item), item]))).values()];
    els.stockPlannerOptions.innerHTML = `${state.parts.filter(part => !requestedIds.has(part.id)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).map(part => `<option value="${esc(stockPlannerPartLabel(part))}"></option>`).join('')}${pendingOptions.filter(item => !requestedIds.has(stockPlannerReferenceForItem(item))).map(item => `<option value="${esc(pendingStockItemLabel(item))}"></option>`).join('')}`;
    const plannerPackCodes = [...new Set([...state.parts.map(packDigitsForPart), ...pendingOptions.map(item => normalizePackDigits(item.packCode))].filter(Boolean))].sort();
    els.stockPlannerPackOptions.innerHTML = plannerPackCodes.map(packCode => `<option value="${esc(packFractionFromDigits(packCode))}"></option>`).join('');
    els.stockSelectedParts.innerHTML = selectedEntries.map(entry => `<span class="stock-part-chip ${entry.item?.matchStatus === 'ambiguous' ? 'ambiguous-chip' : ''}"><span>${entry.part ? stockItemIdentityMarkup({ packCode: packDigitsForPart(entry.part) }, entry.part) : stockItemIdentityMarkup(entry.item, null)}</span><button aria-label="${esc(t('stock.planner.removeAria', { part: entry.label }))}" data-remove-stock-planner="${esc(entry.reference)}" type="button">×</button></span>`).join('');
    els.clearStockSearch.classList.toggle('hidden', !selectedEntries.length);
    els.stockSearchInfo.textContent = stockPlannerFeedback ? t(stockPlannerFeedback.key, stockPlannerFeedback.params) : (selectedEntries.length ? t('stock.planner.selectedCount', { count: selectedEntries.length }) : '');

    if (!selectedEntries.length) {
      if (openStockPalletMenuId && !pallets.some(pallet => pallet.id === openStockPalletMenuId)) openStockPalletMenuId = null;
      els.stockPlannerResults.classList.add('hidden');
      els.stockPlannerResults.innerHTML = '';
      els.stockPalletGrid.innerHTML = pallets.length ? pallets.map(pallet => stockPalletCardMarkup(pallet)).join('') : `<div class="empty-state panel stock-empty"><strong>${esc(t('stock.none'))}</strong><span>${esc(t('stock.noneHint'))}</span></div>`;
      return;
    }

    const result = optimizeStockPallets(selectedEntries.map(entry => entry.reference));
    const coveredCount = bitCount(result.mask);
    const unavailableParts = result.unavailablePartIds.map(stockPlannerEntryForReference).filter(Boolean);
    const recommendationKey = result.palletCount === 1 ? 'stock.planner.recommendOne' : 'stock.planner.recommendMany';
    els.stockPlannerResults.classList.remove('hidden');
    els.stockPlannerResults.innerHTML = `<div class="planner-result-head"><div><p class="eyebrow">${esc(t('stock.planner.resultEyebrow'))}</p><h3>${esc(t(recommendationKey, { count: result.palletCount }))}</h3></div><span class="planner-coverage">${esc(t('stock.planner.coverage', { covered: coveredCount, total: selectedEntries.length }))}</span></div>
      <div class="planner-result-metrics"><span class="${result.overflowUnits ? 'risk' : 'safe'}">${esc(result.overflowUnits ? t('stock.planner.overflowUnits', { count: result.overflowUnits }) : t('stock.planner.noOverflow'))}</span><span>${esc(t('stock.planner.unrelatedUnits', { count: result.unrelatedUnits }))}</span><span>${esc(t('stock.planner.optimized'))}</span></div>
      ${unavailableParts.length ? `<div class="planner-unavailable"><strong>${esc(t('stock.planner.unavailableTitle'))}</strong><span>${esc(t('stock.planner.unavailable', { parts: unavailableParts.map(entry => entry.label).join(', ') }))}</span></div>` : ''}`;

    if (openStockPalletMenuId && !result.pallets.some(candidate => candidate.pallet.id === openStockPalletMenuId)) openStockPalletMenuId = null;
    els.stockPalletGrid.innerHTML = result.pallets.length
      ? result.pallets.map((candidate, index) => stockPalletCardMarkup(candidate.pallet, candidate, index, requestedIds)).join('')
      : `<div class="empty-state panel stock-empty"><strong>${esc(t('stock.planner.noRecommendation'))}</strong><span>${esc(t('stock.planner.noRecommendationHint'))}</span></div>`;
  }

  function openStockPalletDialog(pallet = null) {
    els.stockPalletForm.reset();
    $('[name="id"]', els.stockPalletForm).value = pallet?.id || '';
    $('[name="deliveryNumber"]', els.stockPalletForm).value = pallet?.deliveryNumber || '';
    $('[name="palletNumber"]', els.stockPalletForm).value = pallet?.palletNumber || '';
    $('[name="notes"]', els.stockPalletForm).value = pallet?.notes || '';
    els.stockPalletDialogTitle.textContent = t(pallet ? 'stockPalletDialog.editTitle' : 'stockPalletDialog.createTitle');
    closeDialog(els.stockPalletDetailDialog);
    openDialog(els.stockPalletDialog);
  }

  function resolveStockPartSearch(value, packCode = '') {
    return resolveUniquePartSearch(value, packCode);
  }

  function closeStockPartSuggestions() {
    activeStockSuggestionIndex = -1;
    els.stockPartSuggestions.classList.add('hidden');
    els.stockPartSearch.setAttribute('aria-expanded', 'false');
    els.stockPartSearch.removeAttribute('aria-activedescendant');
  }

  function setActiveStockSuggestion(index) {
    const buttons = $$('button[data-stock-suggestion-part-id]:not([disabled])', els.stockPartSuggestions);
    if (!buttons.length) return closeStockPartSuggestions();
    activeStockSuggestionIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === activeStockSuggestionIndex;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    const activeButton = buttons[activeStockSuggestionIndex];
    els.stockPartSearch.setAttribute('aria-activedescendant', activeButton.id);
    activeButton.scrollIntoView?.({ block: 'nearest' });
  }

  function renderStockPartSuggestions() {
    const raw = els.stockPartSearch.value.trim();
    const packCode = normalizePackDigits(els.stockPartPack.value);
    const pallet = getStockPallet($('[name="palletId"]', els.stockItemForm).value);
    const matches = stockPartSuggestionMatches(raw, packCode);
    activeStockSuggestionIndex = -1;
    if (!raw || !matches.length) {
      els.stockPartSuggestions.innerHTML = '';
      closeStockPartSuggestions();
      return;
    }
    els.stockPartSuggestions.innerHTML = matches.map((part, index) => {
      const alreadyAdded = Boolean(pallet?.items.some(item => item.partId === part.id));
      return `<button aria-selected="false" class="stock-part-suggestion ${alreadyAdded ? 'already-added' : ''}" data-stock-suggestion-part-id="${esc(part.id)}" id="stockPartSuggestion${index}" role="option" type="button" ${alreadyAdded ? 'disabled' : ''}>
        <span class="suggestion-identity">${stockItemIdentityMarkup({ packCode: packDigitsForPart(part) }, part)}</span>
        <small>${esc(t('stockItem.suggestionMeta', { size: dimensionLabel(part), assembly: assemblyLabel(part), received: part.quantity, stored: storedQuantityForPart(part.id) }))}</small>
        ${alreadyAdded ? `<em>${esc(t('stockItem.alreadyAddedSuggestion'))}</em>` : ''}
      </button>`;
    }).join('');
    els.stockPartSuggestions.classList.remove('hidden');
    els.stockPartSearch.setAttribute('aria-expanded', 'true');
  }

  function chooseStockPartSuggestion(partId) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    selectedStockSuggestionPartId = part.id;
    els.stockPartSearch.value = `${part.code} — ${part.name}`;
    els.stockPartPack.value = packDigitsForPart(part);
    closeStockPartSuggestions();
    updateStockPartMatch();
  }

  function updateStockPartMatch() {
    const pallet = getStockPallet($('[name="palletId"]', els.stockItemForm).value);
    const raw = els.stockPartSearch.value.trim();
    const rawPack = els.stockPartPack.value.trim();
    const packCode = normalizePackDigits(rawPack);
    const result = resolveStockPartSearch(raw, packCode);
    const selectedCandidate = state.parts.find(candidate => candidate.id === selectedStockSuggestionPartId) || null;
    const selectedPart = selectedCandidate && packCode && partMatchesPack(selectedCandidate, packCode) ? selectedCandidate : null;
    const part = selectedPart || result.part;
    const alreadyAdded = part && pallet?.items.some(item => item.partId === part.id);
    const pendingAlreadyAdded = !part && packCode && pallet?.items.some(item => isPendingStockItem(item) && normalizePackDigits(item.packCode) === packCode && pendingStockItemAliases(item).includes(normalizePartSearch(raw)));
    const submitButton = els.stockItemSubmitBtn;
    $('[name="partId"]', els.stockItemForm).value = part && packCode && /^[1-9]{2}$/.test(rawPack) && !alreadyAdded ? part.id : '';
    els.stockPartMatchHint.className = 'availability-hint';
    els.stockUnknownPart.classList.add('hidden');

    if (!raw) {
      els.stockPartMatchHint.textContent = t('stock.chooseMaster');
      submitButton.textContent = t('stockItem.add');
      submitButton.disabled = true;
      return;
    }
    if (!packCode || !/^[1-9]{2}$/.test(rawPack)) {
      els.stockPartMatchHint.textContent = t('stockItem.packRequired');
      els.stockPartMatchHint.classList.add('warning');
      submitButton.textContent = t('stockItem.add');
      submitButton.disabled = true;
      return;
    }
    if (alreadyAdded) {
      els.stockPartMatchHint.textContent = t('stock.alreadyOnPallet');
      els.stockPartMatchHint.classList.add('warning');
      submitButton.textContent = t('stockItem.add');
      submitButton.disabled = true;
      return;
    }
    if (pendingAlreadyAdded) {
      els.stockPartMatchHint.textContent = t('stock.unregisteredAlreadyOnPallet');
      els.stockPartMatchHint.classList.add('warning');
      els.stockUnknownPart.classList.remove('hidden');
      submitButton.textContent = t('stockItem.addUnregistered');
      submitButton.disabled = true;
      return;
    }
    if (part) {
      els.stockPartMatchHint.textContent = t('stock.matchDetails', { received: part.quantity, stored: storedQuantityForPart(part.id), overflowing: part.overflowing ? t('stock.markedOverflowingSuffix') : '' });
      if (part.overflowing) els.stockPartMatchHint.classList.add('warning');
      submitButton.textContent = t('stockItem.add');
      submitButton.disabled = false;
      return;
    }
    if (result.reason === 'ambiguous') {
      els.stockPartMatchHint.textContent = t('stockItem.ambiguousCanAdd', { count: result.matches.length });
      els.stockPartMatchHint.classList.add('warning');
      submitButton.textContent = t('stockItem.addAsTyped');
      submitButton.disabled = false;
      return;
    }
    els.stockPartMatchHint.textContent = t('stock.noExactMatch');
    els.stockPartMatchHint.classList.add('warning');
    els.stockUnknownPart.classList.remove('hidden');
    submitButton.textContent = t('stockItem.addUnregistered');
    submitButton.disabled = false;
  }

  function openStockItemDialog(palletId, preferredPartId = '') {
    const pallet = getStockPallet(palletId);
    if (!pallet) return;
    els.stockItemForm.reset();
    $('[name="palletId"]', els.stockItemForm).value = palletId;
    $('[name="quantity"]', els.stockItemForm).value = 1;
    const preferred = state.parts.find(part => part.id === preferredPartId);
    selectedStockSuggestionPartId = preferred?.id || null;
    els.stockPartSearch.value = preferred ? `${preferred.code} — ${preferred.name}` : '';
    els.stockPartPack.value = preferred ? packDigitsForPart(preferred) : '';
    els.stockPartSuggestions.innerHTML = '';
    closeStockPartSuggestions();
    closeDialog(els.stockPalletDetailDialog);
    updateStockPartMatch();
    openDialog(els.stockItemDialog);
  }

  function renderStockPalletDetail(palletId = openStockPalletId) {
    const pallet = getStockPallet(palletId);
    if (!pallet) {
      openStockPalletId = null;
      closeDialog(els.stockPalletDetailDialog);
      return;
    }
    openStockPalletId = pallet.id;
    const units = pallet.items.reduce((sum, item) => sum + item.quantity, 0);
    els.stockPalletDetailTitle.textContent = t('stock.detailTitle', { delivery: pallet.deliveryNumber, pallet: pallet.palletNumber });
    els.stockPalletDetailMeta.innerHTML = `<span class="meta-chip">${esc(t('common.partLines', { count: pallet.items.length }))}</span><span class="meta-chip">${esc(t('stock.storedUnits', { count: units }))}</span><span class="meta-chip">${esc(t('stock.createdAt', { date: formatDate(pallet.createdAt) }))}</span>${pallet.notes ? `<span class="meta-chip detail-note">${esc(pallet.notes)}</span>` : ''}`;
    els.stockPalletItems.innerHTML = pallet.items.length ? pallet.items.map(item => {
      const part = state.parts.find(candidate => candidate.id === item.partId);
      return `<div class="stock-detail-item">
        <div class="stock-detail-part"><div class="part-identity-stack">${stockItemIdentityMarkup(item, part)}</div><span>${part ? esc(t('stock.partDetail', { category: categoryLabel(part.category), size: dimensionLabel(part), received: part.quantity, stored: storedQuantityForPart(part.id) })) : esc(t(isPendingStockItem(item) ? (item.matchStatus === 'ambiguous' ? 'stock.multipleMatchesDetail' : 'stock.unregisteredDetail') : 'stock.masterUnavailable'))}</span>${part?.overflowing ? `<span class="status overflowing">${esc(t('status.overflowing'))}</span>` : ''}</div>
        <label class="stored-quantity-editor"><span>${esc(t('stock.onPallet'))}</span><input type="number" min="1" step="1" inputmode="numeric" value="${item.quantity}" data-action="stock-edit-quantity" data-item-id="${esc(item.id)}" /></label>
        <button class="remove-item" data-action="stock-remove-item" data-item-id="${esc(item.id)}" aria-label="${esc(t('stock.removePartAria'))}" type="button">×</button>
      </div>`;
    }).join('') : `<div class="empty-state"><strong>${esc(t('stock.noParts'))}</strong><span>${esc(t('stock.noPartsHint'))}</span></div>`;
  }

  function openStockPalletDetail(palletId) {
    renderStockPalletDetail(palletId);
    openDialog(els.stockPalletDetailDialog);
  }

  function renderPartProjectCheckboxes(selectedIds = []) {
    const selected = new Set(selectedIds);
    els.partProjectCheckboxes.innerHTML = state.projects.length
      ? state.projects.map(project => `<label class="check-row"><input type="checkbox" name="projectIds" value="${esc(project.id)}" ${selected.has(project.id) ? 'checked' : ''} /><span><strong>${esc(project.name)}</strong><small>${esc(project.location || t('common.noLocation'))}</small></span></label>`).join('')
      : `<div class="checkbox-empty">${esc(t('partDialog.noProjects'))}</div>`;
  }

  function findDuplicateMasterPart(id, code, assemblyPosition, assemblyTotal) {
    if (!String(code || '').trim()) return null;
    const identity = partIdentityKey(code, assemblyPosition, assemblyTotal);
    return state.parts.find(part => part.id !== id && partIdentityKey(part.code, part.assemblyPosition, part.assemblyTotal) === identity) || null;
  }

  function updatePartDuplicateWarning() {
    const id = $('[name="id"]', els.partForm).value;
    const code = $('[name="code"]', els.partForm).value;
    const position = positiveIntegerOrBlank($('[name="assemblyPosition"]', els.partForm).value);
    const total = positiveIntegerOrBlank($('[name="assemblyTotal"]', els.partForm).value);
    const numberingIsIncomplete = Boolean(position) !== Boolean(total);
    const duplicate = numberingIsIncomplete ? null : findDuplicateMasterPart(id, code, position, total);

    els.partDuplicateWarning.classList.toggle('hidden', !duplicate);
    els.partDuplicateWarning.textContent = duplicate
      ? t('partDialog.duplicate', { code: duplicate.code, numbering: position && total ? t('partDialog.numbering', { position, total }) : t('partDialog.noNumbering') })
      : '';
    return duplicate;
  }

  function openPartDialog(part = null, defaults = {}) {
    const source = part || defaults;
    stockPartReturnPalletId = defaults.returnPalletId || null;
    els.partForm.reset();
    $('[name="id"]', els.partForm).value = part?.id || '';
    $('[name="code"]', els.partForm).value = source.code || '';
    $('[name="name"]', els.partForm).value = source.name || '';
    $('[name="quantity"]', els.partForm).value = source.quantity ?? 1;
    const dimensions = dimensionsFromPart(source);
    $('[name="length"]', els.partForm).value = dimensions.length;
    $('[name="width"]', els.partForm).value = dimensions.width;
    $('[name="height"]', els.partForm).value = dimensions.height;
    $('[name="category"]', els.partForm).value = source.category || 'Desk';
    $('[name="assemblyPosition"]', els.partForm).value = source.assemblyPosition || '';
    $('[name="assemblyTotal"]', els.partForm).value = source.assemblyTotal || '';
    $('[name="overflowing"]', els.partForm).checked = Boolean(source.overflowing);
    $('[name="notes"]', els.partForm).value = source.notes || '';
    renderPartProjectCheckboxes(part ? (part.projectIds || []) : (defaults.projectIds || []));
    els.partDialogTitle.textContent = t(part ? 'partDialog.editTitle' : 'partDialog.addTitle');
    updatePartDuplicateWarning();
    openDialog(els.partDialog);
  }

  function updateProjectPhotoPreview() {
    els.projectPhotoPreview.innerHTML = projectPhotoDraft
      ? `<img src="${esc(projectPhotoDraft)}" alt="${esc(t('projectDialog.previewAlt'))}" />`
      : `<span>${esc(t('projectDialog.noPhoto'))}</span>`;
    els.removeProjectPhotoBtn.disabled = !projectPhotoDraft;
  }

  function openProjectDialog(project = null) {
    els.projectForm.reset();
    $('[name="id"]', els.projectForm).value = project?.id || '';
    $('[name="name"]', els.projectForm).value = project?.name || '';
    $('[name="location"]', els.projectForm).value = project?.location || '';
    $('[name="reference"]', els.projectForm).value = project?.reference || '';
    projectPhotoDraft = project?.photo || '';
    projectPhotoBusy = false;
    els.projectDialogTitle.textContent = t(project ? 'projectDialog.editTitle' : 'projectDialog.createTitle');
    updateProjectPhotoPreview();
    openDialog(els.projectDialog);
  }

  function openExpandedProjectPhoto(project) {
    if (!project?.photo) return;
    els.photoDialogTitle.textContent = project.name;
    els.expandedProjectPhoto.src = project.photo;
    els.expandedProjectPhoto.alt = t('projectDialog.expandedAlt', { name: project.name });
    openDialog(els.photoDialog);
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) return reject(new Error('Choose an image file.'));
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          const maxDimension = 1200;
          const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0, width, height);
          URL.revokeObjectURL(objectUrl);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        } catch (error) {
          URL.revokeObjectURL(objectUrl);
          reject(error);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('This photo could not be opened.'));
      };
      image.src = objectUrl;
    });
  }

  function renderProjectPartsList() {
    const projectId = $('[name="projectId"]', els.projectPartsForm).value;
    const query = els.projectPartsSearch.value.trim();
    const parts = state.parts.filter(part => partMatchesSearch(part, query));
    els.projectPartsList.innerHTML = parts.length
      ? parts.map(part => {
        const size = dimensionLabel(part);
        return `<label class="check-row"><input type="checkbox" value="${esc(part.id)}" ${projectPartsDraft.has(part.id) ? 'checked' : ''} /><span><span class="part-identity-inline">${partIdentityMarkup(part)}</span><small>${esc(categoryLabel(part.category))} · ${esc(t('common.received', { count: part.quantity }))} · ${esc(t('common.atStore', { count: storedQuantityForPart(part.id) }))}${size !== '—' ? ` · ${esc(size)}` : ''}${assemblyLabel(part) !== '—' ? ` · ${esc(assemblyLabel(part))}` : ''}</small></span></label>`;
      }).join('')
      : `<div class="checkbox-empty">${esc(t(state.parts.length ? 'projectParts.noneSearch' : 'projectParts.none'))}</div>`;
    if (!projectId) closeDialog(els.projectPartsDialog);
  }

  function openProjectPartsDialog(projectId) {
    const project = state.projects.find(candidate => candidate.id === projectId);
    if (!project) return;
    $('[name="projectId"]', els.projectPartsForm).value = projectId;
    projectPartsDraft = new Set(state.parts.filter(part => partInProject(part, projectId)).map(part => part.id));
    els.projectPartsSearch.value = '';
    els.projectPartsTitle.textContent = t('projectParts.forProject', { name: project.name });
    renderProjectPartsList();
    openDialog(els.projectPartsDialog);
  }

  function openOrderItemDialog(category) {
    const order = getSelectedOrder();
    if (!order) return showToast(t('message.createOrderFirst'));
    if (order.sentAt) return showToast(t('message.sentOrderLocked'));
    const includedPartIds = new Set(order.items.map(item => item.partId));
    const matchingParts = state.parts
      .filter(part => partInProject(part, state.activeProjectId) && part.category === category)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const availableParts = matchingParts.filter(part => !includedPartIds.has(part.id));
    const select = $('[name="partId"]', els.orderItemForm);
    select.innerHTML = availableParts.length
      ? availableParts.map(part => `<option value="${esc(part.id)}">${esc(t('orderItem.option', { code: part.code, name: part.name, quantity: part.quantity }))}</option>`).join('')
      : `<option value="">${esc(t(matchingParts.length ? 'orderItem.allAdded' : 'orderItem.noneMatch'))}</option>`;
    select.disabled = !availableParts.length;
    $('[name="category"]', els.orderItemForm).value = category;
    $('[name="quantityNeeded"]', els.orderItemForm).value = 1;
    $('button[type="submit"]', els.orderItemForm).disabled = !availableParts.length;
    if (!availableParts.length) {
      els.availabilityHint.className = 'availability-hint';
      els.availabilityHint.textContent = matchingParts.length
        ? t('orderItem.everyAdded')
        : t('orderItem.includeFirst');
      if (!matchingParts.length) els.availabilityHint.classList.add('danger');
      openDialog(els.orderItemDialog);
      return;
    }
    updateAvailabilityHint();
    openDialog(els.orderItemDialog);
  }

  function updateAvailabilityHint() {
    const partId = $('[name="partId"]', els.orderItemForm).value;
    const needed = Math.max(1, Number($('[name="quantityNeeded"]', els.orderItemForm).value) || 1);
    const part = state.parts.find(candidate => candidate.id === partId);
    els.availabilityHint.className = 'availability-hint';
    if (!part) {
      els.availabilityHint.textContent = t('orderItem.includeFirst');
      els.availabilityHint.classList.add('danger');
      return;
    }
    if (part.quantity <= 0) {
      els.availabilityHint.textContent = t('orderItem.out', { needed });
      els.availabilityHint.classList.add('danger');
    } else if (part.quantity < needed) {
      els.availabilityHint.textContent = t('orderItem.shortage', { needed, available: part.quantity });
      els.availabilityHint.classList.add('danger');
    } else if (part.quantity <= 4 || part.quantity - needed <= 4) {
      els.availabilityHint.textContent = t('orderItem.lowAfter', { available: part.quantity, remaining: part.quantity - needed });
      els.availabilityHint.classList.add('warning');
    } else {
      els.availabilityHint.textContent = t('orderItem.availableAfter', { available: part.quantity, remaining: part.quantity - needed });
    }
  }

  function removePartFromProject(part, projectId) {
    if (!partInProject(part, projectId)) return 0;
    let removedItems = 0;
    state.orders.filter(order => order.projectId === projectId && !order.sentAt).forEach(order => {
      order.items.filter(item => item.partId === part.id).forEach(item => {
        if (item.packed) part.quantity += item.quantityNeeded;
        removedItems += 1;
      });
      order.items = order.items.filter(item => item.partId !== part.id);
    });
    part.projectIds = part.projectIds.filter(id => id !== projectId);
    return removedItems;
  }

  function setPartProjects(part, nextProjectIds) {
    const next = new Set(nextProjectIds.filter(id => state.projects.some(project => project.id === id)));
    let removedItems = 0;
    [...(part.projectIds || [])].forEach(projectId => {
      if (!next.has(projectId)) removedItems += removePartFromProject(part, projectId);
    });
    next.forEach(projectId => {
      if (!part.projectIds.includes(projectId)) part.projectIds.push(projectId);
    });
    part.projectIds = [...new Set(part.projectIds)].filter(id => next.has(id));
    return removedItems;
  }

  function restorePackedStockForOrders(orders) {
    orders.filter(order => !order.sentAt).forEach(order => order.items.filter(item => item.packed).forEach(item => {
      const part = state.parts.find(candidate => candidate.id === item.partId);
      if (part) part.quantity += item.quantityNeeded;
    }));
  }

  function deleteProject(projectId) {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) return;
    if (!window.confirm(t('message.projectDeletedConfirm', { name: project.name }))) return;
    const projectOrders = state.orders.filter(order => order.projectId === projectId);
    restorePackedStockForOrders(projectOrders);
    state.orders = state.orders.filter(order => order.projectId !== projectId);
    state.parts.forEach(part => { part.projectIds = (part.projectIds || []).filter(id => id !== projectId); });
    state.projects = state.projects.filter(item => item.id !== projectId);
    addActivity('activity.projectDeleted', project.name);
    ensureValidSelections();
    renderAll();
    showToast(t('message.projectDeleted'));
  }

  function deleteOrder(orderId) {
    const order = state.orders.find(candidate => candidate.id === orderId);
    if (!order) return;
    if (!window.confirm(t(order.sentAt ? 'message.sentOrderDeletedConfirm' : 'message.orderDeletedConfirm', { name: order.name }))) return;
    restorePackedStockForOrders([order]);
    state.orders = state.orders.filter(candidate => candidate.id !== orderId);
    addActivity('activity.orderDeleted', order.name);
    state.selectedOrderId = null;
    renderAll();
    showToast(t(order.sentAt ? 'message.sentOrderDeleted' : 'message.orderDeleted'));
  }

  function sendOrder() {
    const order = getSelectedOrder();
    if (!order) return showToast(t('message.createOrderFirst'));
    if (order.sentAt) return showToast(t('message.sentOrderLocked'));
    if (!order.items.length) return showToast(t('message.sendOrderEmpty'));
    if (!window.confirm(t('message.sendOrderConfirm', { name: order.name }))) return;

    const now = new Date().toISOString();
    const seriesName = orderSeriesName(order);
    const cycle = nextOrderCycle(order);
    const nextOrder = {
      id: uid('order'),
      projectId: order.projectId,
      name: t('orders.repeatName', { name: seriesName, number: cycle }),
      seriesName,
      cycle,
      notes: order.notes,
      createdAt: now,
      sentAt: '',
      previousOrderId: order.id,
      items: order.items.map(item => ({
        id: uid('item'),
        partId: item.partId,
        category: orderItemCategory(item),
        quantityNeeded: item.quantityNeeded,
        packed: false
      }))
    };
    order.sentAt = now;
    state.orders.push(nextOrder);
    state.selectedOrderId = nextOrder.id;
    addActivity('activity.orderSent', `${order.name} → ${nextOrder.name}`);
    renderAll();
    showToast(t('message.orderSent', { name: nextOrder.name }));
  }

  function deletePart(partId) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    const referenced = state.orders.some(order => order.items.some(item => item.partId === partId));
    const storedReferences = state.stockPallets.reduce((count, pallet) => count + pallet.items.filter(item => item.partId === partId).length, 0);
    const message = referenced || storedReferences
      ? t('message.deletePartReferences', { code: part.code, name: part.name, stored: storedReferences ? t('message.storedLinesSuffix', { count: storedReferences }) : '' })
      : t('message.deletePartSimple', { code: part.code, name: part.name });
    if (!window.confirm(message)) return;
    state.orders.forEach(order => { order.items = order.items.filter(item => item.partId !== partId); });
    state.stockPallets.forEach(pallet => { pallet.items = pallet.items.filter(item => item.partId !== partId); });
    state.parts = state.parts.filter(candidate => candidate.id !== partId);
    addActivity('activity.partDeleted', `${part.code} — ${part.name}`);
    renderAll();
    showToast(t('message.partDeleted'));
  }

  function adjustPartQuantity(partId, delta) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    const next = Math.max(0, part.quantity + delta);
    if (next === part.quantity) return;
    part.quantity = next;
    addActivity('activity.sharedStockChanged', `${part.code}: ${part.quantity}`);
    renderAll();
  }

  function togglePartOverflowing(partId, nextValue = null) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    const overflowing = typeof nextValue === 'boolean' ? nextValue : !part.overflowing;
    if (overflowing === part.overflowing) return;
    part.overflowing = overflowing;
    addActivity(part.overflowing ? 'activity.overflowing' : 'activity.spaceRestored', `${part.code} — ${part.name}`);
    renderAll();
    if (openStockPalletId) renderStockPalletDetail();
    showToast(t(part.overflowing ? 'message.overflowing' : 'message.spaceAvailable'));
  }

  function updateStockPalletItemQuantity(itemId, requestedQuantity, palletId = openStockPalletId) {
    const pallet = getStockPallet(palletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const numericQuantity = Number(requestedQuantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      showToast(t('message.storedMinimum'));
      renderStock();
      if (els.stockPalletDetailDialog.hasAttribute('open') && openStockPalletId === pallet.id) renderStockPalletDetail();
      return;
    }
    const nextQuantity = Math.floor(numericQuantity);
    if (nextQuantity === item.quantity) return;
    const previousQuantity = item.quantity;
    item.quantity = nextQuantity;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    addActivity('activity.stockPalletQuantityChanged', `${part?.code || pendingStockItemLabel(item) || t('common.part')}: ${previousQuantity} → ${nextQuantity} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    renderAll();
    if (els.stockPalletDetailDialog.hasAttribute('open') && openStockPalletId === pallet.id) renderStockPalletDetail();
    showToast(t('message.storedUpdated'));
  }

  function removeStockPalletItem(itemId, palletId = openStockPalletId) {
    const pallet = getStockPallet(palletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    const itemLabel = part?.code || pendingStockItemLabel(item) || t('common.part');
    if (!window.confirm(t('message.removeStoredConfirm', { part: itemLabel, delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))) return;
    pallet.items = pallet.items.filter(candidate => candidate.id !== itemId);
    addActivity('activity.stockPalletPartRemoved', `${itemLabel} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    renderAll();
    if (els.stockPalletDetailDialog.hasAttribute('open') && openStockPalletId === pallet.id) renderStockPalletDetail();
    showToast(t('message.storedPartRemoved'));
  }

  function deleteStockPallet(palletId) {
    const pallet = getStockPallet(palletId);
    if (!pallet) return;
    if (!window.confirm(t('message.deletePalletConfirm', { delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))) return;
    state.stockPallets = state.stockPallets.filter(candidate => candidate.id !== palletId);
    addActivity('activity.stockPalletDeleted', `${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    expandedStockPalletIds.delete(palletId);
    if (openStockPalletMenuId === palletId) openStockPalletMenuId = null;
    openStockPalletId = null;
    closeDialog(els.stockPalletDetailDialog);
    renderAll();
    showToast(t('message.palletDeleted'));
  }

  function togglePacked(itemId, shouldPack) {
    const order = getSelectedOrder();
    if (order?.sentAt) return showToast(t('message.sentOrderLocked'));
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!part) {
      showToast(t('message.partMissing'));
      renderOrders();
      return;
    }
    if (shouldPack && !item.packed) {
      if (part.quantity < item.quantityNeeded) {
        showToast(t('message.notEnough', { code: part.code, needed: item.quantityNeeded, available: part.quantity }));
        renderOrders();
        return;
      }
      part.quantity -= item.quantityNeeded;
      item.packed = true;
      addActivity('activity.partPacked', `${part.code} × ${item.quantityNeeded}`);
    } else if (!shouldPack && item.packed) {
      part.quantity += item.quantityNeeded;
      item.packed = false;
      addActivity('activity.partUnpacked', `${part.code} × ${item.quantityNeeded}`);
    }
    renderAll();
  }

  function updateOrderItemQuantity(itemId, requestedQuantity) {
    const order = getSelectedOrder();
    if (order?.sentAt) return showToast(t('message.sentOrderLocked'));
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!part) {
      showToast(t('message.partMissing'));
      renderOrders();
      return;
    }

    const numericQuantity = Number(requestedQuantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      showToast(t('message.neededMinimum'));
      renderOrders();
      return;
    }
    const nextQuantity = Math.floor(numericQuantity);
    const previousQuantity = item.quantityNeeded;
    if (nextQuantity === previousQuantity) {
      renderOrders();
      return;
    }

    const difference = nextQuantity - previousQuantity;
    if (item.packed && difference > 0 && part.quantity < difference) {
      showToast(t('message.notEnoughIncrease', { code: part.code, difference, available: part.quantity }));
      renderOrders();
      return;
    }
    if (item.packed) part.quantity -= difference;
    item.quantityNeeded = nextQuantity;
    addActivity('activity.checklistChanged', `${part.code}: ${previousQuantity} → ${nextQuantity}`);
    renderAll();
    showToast(t(item.packed ? 'message.amountStockUpdated' : 'message.amountUpdated'));
  }

  function removeOrderItem(itemId) {
    const order = getSelectedOrder();
    if (order?.sentAt) return showToast(t('message.sentOrderLocked'));
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (item.packed && part) part.quantity += item.quantityNeeded;
    order.items = order.items.filter(candidate => candidate.id !== itemId);
    addActivity('activity.checklistRemoved', part ? `${part.code} · ${order.name}` : order.name);
    renderAll();
  }

  els.menuBtn.addEventListener('click', () => els.sidebar.classList.toggle('open'));
  els.undoLatestBtn.addEventListener('click', undoLatestChange);
  document.addEventListener('click', event => {
    if (window.innerWidth <= 820 && els.sidebar.classList.contains('open') && !els.sidebar.contains(event.target) && event.target !== els.menuBtn) els.sidebar.classList.remove('open');
    if (!event.target.closest('.stock-part-search-shell')) closeStockPartSuggestions();
    const dismissButton = event.target.closest('[data-dismiss-notice]');
    if (dismissButton) dismissNotice(dismissButton.dataset.dismissNotice, dismissButton.dataset.signature || '');
    if (openInventoryMenuPartId && !event.target.closest('.inventory-menu-toggle, .inventory-card-menu')) {
      openInventoryMenuPartId = null;
      renderInventory();
    }
    if (openStockPalletMenuId && !event.target.closest('.stock-pallet-menu-toggle, .stock-pallet-card-menu')) {
      openStockPalletMenuId = null;
      renderStock();
    }
  });
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('[data-jump]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.jump)));
  $$('.close-dialog').forEach(button => button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog === els.partDialog && stockPartReturnPalletId) {
      const palletId = stockPartReturnPalletId;
      stockPartReturnPalletId = null;
      closeDialog(dialog);
      openStockItemDialog(palletId);
      return;
    }
    const returnToPallet = (dialog === els.stockItemDialog || dialog === els.stockPalletDialog) && openStockPalletId;
    if (dialog === els.stockItemDialog) {
      selectedStockSuggestionPartId = null;
      closeStockPartSuggestions();
    }
    if (dialog === els.stockPalletDetailDialog) openStockPalletId = null;
    closeDialog(dialog);
    if (returnToPallet) openStockPalletDetail(openStockPalletId);
  }));
  $$('[data-stock-filter]').forEach(button => button.addEventListener('click', () => {
    els.inventorySearch.value = '';
    els.inventoryProjectFilter.value = 'all';
    els.inventoryCategoryFilter.value = 'all';
    els.inventoryStockFilter.value = button.dataset.stockFilter;
    switchView('inventory');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));

  els.addPartBtn.addEventListener('click', () => openPartDialog());
  els.newProjectBtn.addEventListener('click', () => openProjectDialog());
  els.newStockPalletBtn.addEventListener('click', () => {
    openStockPalletId = null;
    openStockPalletDialog();
  });
  els.newOrderBtn.addEventListener('click', () => {
    if (!state.activeProjectId) return showToast(t('orders.createProject'));
    els.orderForm.reset();
    openDialog(els.orderDialog);
  });

  els.projectPhotoInput.addEventListener('change', async () => {
    const file = els.projectPhotoInput.files?.[0];
    if (!file) return;
    projectPhotoBusy = true;
    els.projectPhotoPreview.innerHTML = `<span>${esc(t('message.photoPreparing'))}</span>`;
    try {
      projectPhotoDraft = await compressImage(file);
      updateProjectPhotoPreview();
      showToast(t('message.photoReady'));
    } catch (error) {
      console.error(error);
      projectPhotoDraft = '';
      updateProjectPhotoPreview();
      showToast(t('message.photoFailed'));
    } finally {
      projectPhotoBusy = false;
    }
  });

  els.removeProjectPhotoBtn.addEventListener('click', () => {
    projectPhotoDraft = '';
    els.projectPhotoInput.value = '';
    updateProjectPhotoPreview();
  });

  ['code', 'assemblyPosition', 'assemblyTotal'].forEach(name => {
    $(`[name="${name}"]`, els.partForm).addEventListener('input', updatePartDuplicateWarning);
  });

  els.projectForm.addEventListener('submit', event => {
    event.preventDefault();
    if (projectPhotoBusy) return showToast(t('message.photoStillPreparing'));
    const data = new FormData(els.projectForm);
    const id = String(data.get('id') || '');
    const payload = {
      name: String(data.get('name') || '').trim(),
      location: String(data.get('location') || '').trim(),
      reference: String(data.get('reference') || '').trim(),
      photo: projectPhotoDraft
    };
    if (!payload.name) return;
    if (id) {
      const project = state.projects.find(candidate => candidate.id === id);
      if (!project) return;
      Object.assign(project, payload);
      addActivity('activity.projectUpdated', project.name);
    } else {
      const project = { id: uid('project'), ...payload, createdAt: new Date().toISOString() };
      state.projects.push(project);
      state.activeProjectId = project.id;
      state.selectedOrderId = null;
      addActivity('activity.projectCreated', project.name);
    }
    closeDialog(els.projectDialog);
    renderAll();
    showToast(t(id ? 'message.projectUpdated' : 'message.projectCreated'));
  });

  els.partForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.partForm);
    const id = String(data.get('id') || '');
    const code = String(data.get('code') || '').trim().toUpperCase();
    const position = positiveIntegerOrBlank(data.get('assemblyPosition'));
    const total = positiveIntegerOrBlank(data.get('assemblyTotal'));
    if ((position && !total) || (!position && total)) return showToast(t('message.assemblyBoth'));
    if (position && total && position > total) return showToast(t('message.assemblyOrder'));
    const duplicate = findDuplicateMasterPart(id, code, position, total);
    if (duplicate) {
      updatePartDuplicateWarning();
      return showToast(t('message.duplicateNotSaved', { code, numbering: position && total ? `${position}/${total}` : t('partDialog.noNumbering') }));
    }

    const nextProjectIds = data.getAll('projectIds').map(String);
    const dimensions = {
      length: cleanDimensionValue(data.get('length')),
      width: cleanDimensionValue(data.get('width')),
      height: cleanDimensionValue(data.get('height'))
    };
    const payload = {
      code,
      name: String(data.get('name') || '').trim(),
      quantity: Math.max(0, Number(data.get('quantity')) || 0),
      ...dimensions,
      size: legacySizeValue(dimensions),
      category: normalizeCategory(data.get('category')),
      assemblyPosition: position,
      assemblyTotal: total,
      overflowing: data.get('overflowing') === 'on',
      notes: String(data.get('notes') || '').trim()
    };
    if (!payload.code || !payload.name) return;

    const pendingMatches = id ? [] : pendingStockMatchesForPart(payload);
    const shouldLinkPending = Boolean(pendingMatches.length && window.confirm(t('message.pendingPalletConfirm', {
      part: `${payload.code} — ${payload.name}`,
      count: pendingMatches.length
    })));

    let removedItems = 0;
    let savedPart = null;
    let linkedPendingItems = 0;
    if (id) {
      const part = state.parts.find(candidate => candidate.id === id);
      if (!part) return;
      removedItems = setPartProjects(part, nextProjectIds);
      Object.assign(part, payload);
      state.orders.forEach(order => order.items.forEach(item => {
        if (item.partId === part.id) item.category = part.category;
      }));
      savedPart = part;
      addActivity('activity.masterUpdated', `${payload.code} — ${payload.name}`);
    } else {
      savedPart = { id: uid('part'), ...payload, projectIds: [...new Set(nextProjectIds)] };
      state.parts.push(savedPart);
      addActivity('activity.masterAdded', `${payload.code} × ${payload.quantity}`);
      if (shouldLinkPending) {
        linkedPendingItems = linkPendingStockItemsToPart(savedPart);
        addActivity('activity.pendingStockLinked', `${payload.code} × ${linkedPendingItems}`);
      }
    }
    const returnPalletId = stockPartReturnPalletId;
    stockPartReturnPalletId = null;
    closeDialog(els.partDialog);
    renderAll();
    if (!id && returnPalletId && getStockPallet(returnPalletId) && !getStockPallet(returnPalletId).items.some(item => item.partId === savedPart.id)) {
      openStockItemDialog(returnPalletId, savedPart.id);
      showToast(t('message.masterCreatedReturn'));
      return;
    }
    if (linkedPendingItems) {
      showToast(t('message.pendingPalletLinked', { count: linkedPendingItems, part: savedPart.code }));
      return;
    }
    showToast(removedItems ? t('message.partUpdatedRemoved', { count: removedItems }) : t(id ? 'message.masterUpdated' : 'message.masterAdded'));
  });

  els.projectPartsSearch.addEventListener('input', renderProjectPartsList);
  els.projectPartsList.addEventListener('change', event => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    if (checkbox.checked) projectPartsDraft.add(checkbox.value);
    else projectPartsDraft.delete(checkbox.value);
  });

  els.projectPartsForm.addEventListener('submit', event => {
    event.preventDefault();
    const projectId = String(new FormData(els.projectPartsForm).get('projectId') || '');
    const project = state.projects.find(candidate => candidate.id === projectId);
    if (!project) return;
    let removedItems = 0;
    state.parts.forEach(part => {
      const shouldInclude = projectPartsDraft.has(part.id);
      const isIncluded = partInProject(part, projectId);
      if (shouldInclude && !isIncluded) part.projectIds.push(projectId);
      if (!shouldInclude && isIncluded) removedItems += removePartFromProject(part, projectId);
    });
    addActivity('activity.projectPartsUpdated', `${project.name}: ${projectPartsDraft.size}`);
    closeDialog(els.projectPartsDialog);
    renderAll();
    showToast(removedItems ? t('message.projectPartsRemoved', { count: removedItems }) : t('message.projectPartsSaved'));
  });

  els.orderForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.orderForm);
    const name = String(data.get('name') || '').trim();
    const order = { id: uid('order'), projectId: state.activeProjectId, name, seriesName: name, cycle: 1, notes: String(data.get('notes') || '').trim(), createdAt: new Date().toISOString(), sentAt: '', previousOrderId: '', items: [] };
    if (!order.name) return;
    state.orders.push(order);
    state.selectedOrderId = order.id;
    addActivity('activity.orderCreated', order.name);
    closeDialog(els.orderDialog);
    renderAll();
    showToast(t('message.orderCreated'));
  });

  els.orderItemForm.addEventListener('submit', event => {
    event.preventDefault();
    const order = getSelectedOrder();
    if (!order) return;
    if (order.sentAt) return showToast(t('message.sentOrderLocked'));
    const data = new FormData(els.orderItemForm);
    const partId = String(data.get('partId') || '');
    const quantityNeeded = Math.max(1, Number(data.get('quantityNeeded')) || 1);
    const category = String(data.get('category') || 'Other');
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part || !partInProject(part, state.activeProjectId) || part.category !== category) return showToast(t('message.chooseProjectPart'));
    if (order.items.some(item => item.partId === partId)) {
      closeDialog(els.orderItemDialog);
      renderAll();
      return showToast(t('message.checklistDuplicate'));
    }
    order.items.push({ id: uid('item'), partId, category: part.category, quantityNeeded, packed: false });
    addActivity('activity.partAddedOrder', `${part.code} × ${quantityNeeded} · ${order.name}`);
    closeDialog(els.orderItemDialog);
    renderAll();
    if (part.quantity < quantityNeeded) showToast(t('message.partAddedShort'));
    else if (part.quantity <= 4 || part.quantity - quantityNeeded <= 4) showToast(t('message.partAddedLow'));
    else showToast(t('message.partAddedChecklist'));
  });

  $('[name="partId"]', els.orderItemForm).addEventListener('change', updateAvailabilityHint);
  $('[name="quantityNeeded"]', els.orderItemForm).addEventListener('input', updateAvailabilityHint);

  els.stockPalletForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.stockPalletForm);
    const id = String(data.get('id') || '');
    const deliveryNumber = String(data.get('deliveryNumber') || '').trim();
    const palletNumber = String(data.get('palletNumber') || '').trim();
    const notes = String(data.get('notes') || '').trim();
    if (!deliveryNumber || !palletNumber) return;
    const duplicate = state.stockPallets.find(pallet => pallet.id !== id && pallet.deliveryNumber.toLowerCase() === deliveryNumber.toLowerCase() && pallet.palletNumber.toLowerCase() === palletNumber.toLowerCase());
    if (duplicate) return showToast(t('message.palletDuplicate'));

    let pallet;
    if (id) {
      pallet = getStockPallet(id);
      if (!pallet) return;
      Object.assign(pallet, { deliveryNumber, palletNumber, notes });
      addActivity('activity.stockPalletUpdated', `${deliveryNumber} / ${palletNumber}`);
    } else {
      pallet = { id: uid('stock_pallet'), deliveryNumber, palletNumber, notes, createdAt: new Date().toISOString(), items: [] };
      state.stockPallets.push(pallet);
      addActivity('activity.stockPalletCreated', `${deliveryNumber} / ${palletNumber}`);
    }
    expandedStockPalletIds.add(pallet.id);
    openStockPalletId = null;
    closeDialog(els.stockPalletDialog);
    renderAll();
    showToast(t(id ? 'message.palletUpdated' : 'message.palletCreated'));
  });

  els.stockPartSearch.addEventListener('input', () => {
    selectedStockSuggestionPartId = null;
    updateStockPartMatch();
    renderStockPartSuggestions();
  });
  els.stockPartPack.addEventListener('input', () => {
    const digits = els.stockPartPack.value.replace(/\D/g, '').slice(0, 2);
    if (els.stockPartPack.value !== digits) els.stockPartPack.value = digits;
    selectedStockSuggestionPartId = null;
    updateStockPartMatch();
    renderStockPartSuggestions();
  });
  els.stockPartSearch.addEventListener('focus', renderStockPartSuggestions);
  els.stockPartSearch.addEventListener('keydown', event => {
    const buttons = $$('button[data-stock-suggestion-part-id]:not([disabled])', els.stockPartSuggestions);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (els.stockPartSuggestions.classList.contains('hidden')) renderStockPartSuggestions();
      setActiveStockSuggestion(activeStockSuggestionIndex + 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (els.stockPartSuggestions.classList.contains('hidden')) renderStockPartSuggestions();
      setActiveStockSuggestion(activeStockSuggestionIndex < 0 ? -1 : activeStockSuggestionIndex - 1);
    }
    if (event.key === 'Enter' && activeStockSuggestionIndex >= 0 && buttons[activeStockSuggestionIndex]) {
      event.preventDefault();
      chooseStockPartSuggestion(buttons[activeStockSuggestionIndex].dataset.stockSuggestionPartId);
    }
    if (event.key === 'Escape') closeStockPartSuggestions();
  });
  els.stockPartSuggestions.addEventListener('click', event => {
    const button = event.target.closest('button[data-stock-suggestion-part-id]');
    if (button && !button.disabled) chooseStockPartSuggestion(button.dataset.stockSuggestionPartId);
  });
  els.stockItemForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.stockItemForm);
    const pallet = getStockPallet(String(data.get('palletId') || ''));
    const raw = els.stockPartSearch.value.trim();
    const rawPack = String(data.get('packCode') || '').trim();
    const packCode = normalizePackDigits(rawPack);
    const result = resolveStockPartSearch(raw, packCode);
    const part = state.parts.find(candidate => candidate.id === String(data.get('partId') || '')) || result.part;
    const quantity = Math.max(1, Math.floor(Number(data.get('quantity')) || 1));
    if (!pallet || !raw) return showToast(t('message.chooseOrCreatePart'));
    if (!packCode || !/^[1-9]{2}$/.test(rawPack)) return showToast(t('message.packDigitsRequired'));
    let addedMatchStatus = '';
    if (part) {
      if (pallet.items.some(item => item.partId === part.id)) return showToast(t('message.palletPartDuplicate'));
      if (!partMatchesPack(part, packCode)) return showToast(t('message.packDoesNotMatch'));
      pallet.items.push({ id: uid('stock_item'), partId: part.id, packCode, quantity });
      addActivity('activity.partAddedStockPallet', `${codeWithPack(part.code, packCode)} × ${quantity} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    } else {
      const pending = parsePendingPartInput(raw);
      const aliases = [pending.pendingCode, pending.pendingName].map(normalizePartSearch).filter(Boolean);
      if (!aliases.length) return showToast(t('message.chooseOrCreatePart'));
      if (pallet.items.some(item => isPendingStockItem(item) && normalizePackDigits(item.packCode) === packCode && pendingStockItemAliases(item).some(alias => aliases.includes(alias)))) return showToast(t('stock.unregisteredAlreadyOnPallet'));
      const ambiguous = result.reason === 'ambiguous' && result.matches.length > 1;
      addedMatchStatus = ambiguous ? 'ambiguous' : 'unregistered';
      pallet.items.push({
        id: uid('stock_item'),
        partId: '',
        ...pending,
        packCode,
        matchStatus: ambiguous ? 'ambiguous' : '',
        candidatePartIds: ambiguous ? result.matches.map(candidate => candidate.id) : [],
        quantity
      });
      addActivity(ambiguous ? 'activity.ambiguousStockPartAdded' : 'activity.unregisteredStockPartAdded', `${codeWithPack(pending.pendingName || pending.pendingCode, packCode)} × ${quantity} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    }
    expandedStockPalletIds.add(pallet.id);
    openStockPalletId = null;
    closeDialog(els.stockItemDialog);
    renderAll();
    showToast(part ? t(part.overflowing ? 'message.partAddedOverflowing' : 'message.partAddedPallet') : t(addedMatchStatus === 'ambiguous' ? 'message.ambiguousPartAdded' : 'message.unregisteredPartAdded'));
  });

  els.createStockMasterPartBtn.addEventListener('click', () => {
    const palletId = $('[name="palletId"]', els.stockItemForm).value;
    const raw = els.stockPartSearch.value.trim();
    const packCode = normalizePackDigits(els.stockPartPack.value);
    if (!palletId || !raw) return;
    const pending = parsePendingPartInput(raw);
    const code = pending.pendingCode;
    const name = pending.pendingName || pending.pendingCode;
    closeDialog(els.stockItemDialog);
    openPartDialog(null, { code, name, quantity: 0, assemblyPosition: packCode ? Number(packCode[0]) : '', assemblyTotal: packCode ? Number(packCode[1]) : '', returnPalletId: palletId });
  });

  els.addStockSearchPart.addEventListener('click', () => addStockPlannerParts());
  els.stockSearch.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addStockPlannerParts();
  });
  els.stockPackSearch.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addStockPlannerParts();
  });
  [els.stockSearch, els.stockPackSearch].forEach(input => input.addEventListener('input', () => {
    stockPlannerFeedback = null;
    els.stockSearchInfo.textContent = selectedStockPartIds.size ? t('stock.planner.selectedCount', { count: selectedStockPartIds.size }) : '';
  }));
  els.clearStockSearch.addEventListener('click', () => {
    selectedStockPartIds.clear();
    stockPlannerFeedback = null;
    els.stockSearch.value = '';
    els.stockPackSearch.value = '';
    renderStock();
  });
  els.stockSelectedParts.addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-stock-planner]');
    if (!button) return;
    selectedStockPartIds.delete(button.dataset.removeStockPlanner);
    stockPlannerFeedback = null;
    renderStock();
  });
  function handleStockPalletAction(event) {
    const control = event.target.closest('[data-stock-action]');
    if (!control) return false;
    const palletId = control.dataset.palletId;
    if (control.dataset.stockAction === 'menu') {
      openStockPalletMenuId = openStockPalletMenuId === palletId ? null : palletId;
      renderStock();
    }
    if (control.dataset.stockAction === 'add-part') {
      openStockPalletMenuId = null;
      openStockPalletId = null;
      renderStock();
      openStockItemDialog(palletId);
    }
    if (control.dataset.stockAction === 'edit-details') {
      const pallet = getStockPallet(palletId);
      openStockPalletMenuId = null;
      openStockPalletId = null;
      renderStock();
      if (pallet) openStockPalletDialog(pallet);
    }
    if (control.dataset.stockAction === 'delete') {
      openStockPalletMenuId = null;
      renderStock();
      deleteStockPallet(palletId);
    }
    if (control.dataset.stockAction === 'remove-item') removeStockPalletItem(control.dataset.itemId, palletId);
    return true;
  }
  els.stockPalletGrid.addEventListener('click', event => {
    if (handleStockPalletAction(event)) return;
    if (event.target.closest('input, label, .stock-pallet-card-menu')) return;
    const card = event.target.closest('[data-stock-pallet-card]');
    if (!card) return;
    if (openStockPalletMenuId) {
      openStockPalletMenuId = null;
      renderStock();
      return;
    }
    if (expandedStockPalletIds.has(card.dataset.stockPalletCard)) expandedStockPalletIds.delete(card.dataset.stockPalletCard);
    else expandedStockPalletIds.add(card.dataset.stockPalletCard);
    renderStock();
  });
  els.stockPalletGrid.addEventListener('change', event => {
    const input = event.target.closest('input[data-stock-action="edit-quantity"]');
    if (input) updateStockPalletItemQuantity(input.dataset.itemId, input.value, input.dataset.palletId);
  });
  els.stockPalletGrid.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || event.target !== event.target.closest('[data-stock-pallet-card]')) return;
    event.preventDefault();
    const palletId = event.target.dataset.stockPalletCard;
    if (expandedStockPalletIds.has(palletId)) expandedStockPalletIds.delete(palletId);
    else expandedStockPalletIds.add(palletId);
    renderStock();
  });

  els.addStockPalletItemBtn.addEventListener('click', () => {
    if (openStockPalletId) openStockItemDialog(openStockPalletId);
  });
  els.editStockPalletBtn.addEventListener('click', () => {
    const pallet = getStockPallet(openStockPalletId);
    if (pallet) openStockPalletDialog(pallet);
  });
  els.deleteStockPalletBtn.addEventListener('click', () => {
    if (openStockPalletId) deleteStockPallet(openStockPalletId);
  });
  els.stockPalletItems.addEventListener('click', event => {
    const button = event.target.closest('button[data-action="stock-remove-item"]');
    if (button) removeStockPalletItem(button.dataset.itemId);
  });
  els.stockPalletItems.addEventListener('change', event => {
    const input = event.target.closest('input[data-action="stock-edit-quantity"]');
    if (input) updateStockPalletItemQuantity(input.dataset.itemId, input.value);
  });

  els.projectCards.addEventListener('click', event => {
    const photoButton = event.target.closest('.project-photo-expand');
    const openButton = event.target.closest('.project-open');
    const manageButton = event.target.closest('.project-manage-parts');
    const editButton = event.target.closest('.project-edit');
    const deleteButton = event.target.closest('.project-delete');
    if (photoButton) openExpandedProjectPhoto(state.projects.find(project => project.id === photoButton.dataset.id));
    if (openButton) {
      const projectId = openButton.dataset.id;
      state.activeProjectId = projectId;
      state.selectedOrderId = state.orders.find(order => order.projectId === projectId)?.id || null;
      els.inventoryProjectFilter.value = projectId;
      renderAll();
      els.inventoryProjectFilter.value = projectId;
      switchView('inventory');
      showToast(t('message.projectOpened', { name: getProjectName(projectId) }));
    }
    if (manageButton) openProjectPartsDialog(manageButton.dataset.id);
    if (editButton) openProjectDialog(state.projects.find(project => project.id === editButton.dataset.id));
    if (deleteButton) deleteProject(deleteButton.dataset.id);
  });

  [els.inventorySearch, els.inventoryProjectFilter, els.inventoryStockFilter, els.inventorySort, els.inventoryCategoryFilter].forEach(control => control.addEventListener(control === els.inventorySearch ? 'input' : 'change', renderInventory));

  els.pendingPalletMatchNotice.addEventListener('click', event => {
    const button = event.target.closest('button[data-pending-action]');
    if (!button) return;
    if (button.dataset.pendingAction === 'create') {
      const match = pendingStockMatchesForText(els.inventorySearch.value)[0];
      if (!match) return renderInventory();
      openPartDialog(null, {
        code: match.item.pendingCode || '',
        name: match.item.pendingName || match.item.pendingCode || '',
        quantity: 0
      });
      return;
    }
    const part = state.parts.find(candidate => candidate.id === button.dataset.partId);
    if (!part) return renderInventory();
    const matches = pendingStockMatchesForPart(part);
    if (!matches.length) return renderInventory();
    if (!window.confirm(t('message.pendingPalletConfirm', { part: `${part.code} — ${part.name}`, count: matches.length }))) return;
    const linkedCount = linkPendingStockItemsToPart(part);
    addActivity('activity.pendingStockLinked', `${part.code} × ${linkedCount}`);
    renderAll();
    showToast(t('message.pendingPalletLinked', { count: linkedCount, part: part.code }));
  });

  function handleInventoryAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return false;
    if (button.dataset.action === 'menu') {
      openInventoryMenuPartId = openInventoryMenuPartId === button.dataset.id ? null : button.dataset.id;
      renderInventory();
      return true;
    }
    if (button.dataset.action === 'minus') adjustPartQuantity(button.dataset.id, -1);
    if (button.dataset.action === 'plus') adjustPartQuantity(button.dataset.id, 1);
    if (button.dataset.action === 'edit') {
      openInventoryMenuPartId = null;
      const part = state.parts.find(candidate => candidate.id === button.dataset.id);
      renderInventory();
      openPartDialog(part);
    }
    if (button.dataset.action === 'delete') {
      openInventoryMenuPartId = null;
      renderInventory();
      deletePart(button.dataset.id);
    }
    return true;
  }
  els.inventoryCards.addEventListener('click', event => {
    if (handleInventoryAction(event)) return;
    if (event.target.closest('input, label, .inventory-card-menu')) return;
    const card = event.target.closest('[data-part-card]');
    if (!card) return;
    if (openInventoryMenuPartId) {
      openInventoryMenuPartId = null;
      renderInventory();
      return;
    }
    if (expandedInventoryPartIds.has(card.dataset.partCard)) expandedInventoryPartIds.delete(card.dataset.partCard);
    else expandedInventoryPartIds.add(card.dataset.partCard);
    renderInventory();
  });
  els.inventoryCards.addEventListener('change', event => {
    const input = event.target.closest('input[data-action="overflow-switch"]');
    if (input) togglePartOverflowing(input.dataset.id, input.checked);
  });
  els.inventoryCards.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || event.target !== event.target.closest('[data-part-card]')) return;
    event.preventDefault();
    const partId = event.target.dataset.partCard;
    if (expandedInventoryPartIds.has(partId)) expandedInventoryPartIds.delete(partId);
    else expandedInventoryPartIds.add(partId);
    renderInventory();
  });

  els.settingsTabs.addEventListener('click', event => {
    const button = event.target.closest('[data-settings-tab]');
    if (!button) return;
    activeSettingsTab = button.dataset.settingsTab;
    renderSettingsTabs();
  });

  els.orderSelect.addEventListener('change', () => { state.selectedOrderId = els.orderSelect.value || null; renderAll(); });
  els.deleteOrderBtn.addEventListener('click', () => { const order = getSelectedOrder(); if (order) deleteOrder(order.id); });
  els.sendOrderBtn.addEventListener('click', sendOrder);
  els.orderBoards.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'add-order-item') openOrderItemDialog(button.dataset.category);
    if (button.dataset.action === 'remove-order-item') removeOrderItem(button.dataset.itemId);
  });
  els.orderBoards.addEventListener('change', event => {
    const checkbox = event.target.closest('input[data-action="toggle-pack"]');
    if (checkbox) togglePacked(checkbox.dataset.itemId, checkbox.checked);
    const quantityInput = event.target.closest('input[data-action="edit-needed"]');
    if (quantityInput) updateOrderItemQuantity(quantityInput.dataset.itemId, quantityInput.value);
  });

  els.languageSelect.addEventListener('change', () => {
    const nextLanguage = els.languageSelect.value;
    if (!LANGUAGE_CODES.has(nextLanguage) || nextLanguage === state.language) return;
    state.language = nextLanguage;
    renderAll();
    switchView(currentView);
    const languageName = I18N.languages.find(language => language.code === nextLanguage)?.name || nextLanguage;
    showToast(t('message.languageChanged', { language: languageName }));
  });

  els.exportBtn.addEventListener('click', () => {
    const backup = { ...state, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `storeflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    showToast(t('message.backupExported'));
  });

  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    if (!file) return;
    try {
      const imported = migrateState(JSON.parse(await file.text()));
      if (!window.confirm(t('message.importConfirm'))) return;
      state = imported;
      addActivity('activity.backupImported', file.name);
      ensureValidSelections();
      renderAll();
      showToast(t('message.backupImported'));
    } catch (error) {
      console.error(error);
      showToast(t('message.backupInvalid'));
    } finally {
      els.importInput.value = '';
    }
  });

  els.resetBtn.addEventListener('click', () => {
    if (!window.confirm(t('message.resetConfirm'))) return;
    const language = state.language;
    state = createInitialState();
    state.language = language;
    addActivity('activity.dataReset');
    renderAll();
    showToast(t('message.resetDone'));
  });

  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:') && !location.hostname.includes('livecodes')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker unavailable:', error)));
  }

  renderAll();
  switchView(currentView);
})();
