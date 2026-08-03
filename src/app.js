(() => {
  'use strict';

  const STORAGE_KEY = 'storeflow-state-v1';
  const I18N = window.StoreFlowI18n;
  const LANGUAGE_CODES = new Set(I18N.languages.map(language => language.code));
  const CATEGORIES = ['Desk', 'Bed', 'Wardrobe', 'Kitchen'];
  let storageAvailable = true;
  let currentView = 'dashboard';
  let toastTimer;
  let projectPhotoDraft = '';
  let projectPhotoBusy = false;
  let projectPartsDraft = new Set();
  let openStockPalletId = null;
  let stockPartReturnPalletId = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const esc = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

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
      version: 6,
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
          category: String(oldPart.category || 'Other'),
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
    const orders = (Array.isArray(source.orders) ? source.orders : [])
      .filter(order => validProjectIds.has(order.projectId))
      .map(order => ({
        id: order.id || uid('order'),
        projectId: order.projectId,
        name: String(order.name || 'Untitled order'),
        notes: String(order.notes || ''),
        createdAt: order.createdAt || new Date().toISOString(),
        items: (Array.isArray(order.items) ? order.items : []).map(item => ({
          id: item.id || uid('item'),
          partId: oldToNew.get(item.partId) || item.partId,
          category: String(item.category || 'Other'),
          quantityNeeded: Math.max(1, Number(item.quantityNeeded) || 1),
          packed: Boolean(item.packed)
        })).filter(item => validPartIds.has(item.partId))
      }));

    const stockPallets = (Array.isArray(source.stockPallets) ? source.stockPallets : (Array.isArray(source.storePallets) ? source.storePallets : []))
      .map(pallet => ({
        id: pallet.id || uid('stock_pallet'),
        deliveryNumber: String(pallet.deliveryNumber || pallet.delivery || '').trim(),
        palletNumber: String(pallet.palletNumber || pallet.number || '').trim(),
        notes: String(pallet.notes || ''),
        createdAt: pallet.createdAt || new Date().toISOString(),
        items: (Array.isArray(pallet.items) ? pallet.items : []).map(item => ({
          id: item.id || uid('stock_item'),
          partId: oldToNew.get(item.partId) || item.partId,
          quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
        })).filter(item => validPartIds.has(item.partId))
      }))
      .filter(pallet => pallet.deliveryNumber && pallet.palletNumber);

    return {
      version: 6,
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

  function t(key, params = {}) {
    return I18N.t(state.language, key, params);
  }

  function categoryLabel(category) {
    return t(`category.${category}`);
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
    categoryProgress: $('#categoryProgress'), activityList: $('#activityList'),
    projectCards: $('#projectCards'), newProjectBtn: $('#newProjectBtn'),
    inventorySearch: $('#inventorySearch'), inventoryProjectFilter: $('#inventoryProjectFilter'), inventoryStockFilter: $('#inventoryStockFilter'), inventorySort: $('#inventorySort'),
    addPartBtn: $('#addPartBtn'), inventoryTableBody: $('#inventoryTableBody'), inventoryEmpty: $('#inventoryEmpty'), inventoryCards: $('#inventoryCards'),
    orderSelect: $('#orderSelect'), newOrderBtn: $('#newOrderBtn'), deleteOrderBtn: $('#deleteOrderBtn'), orderSummary: $('#orderSummary'), orderBoards: $('#orderBoards'),
    newStockPalletBtn: $('#newStockPalletBtn'), stockSummary: $('#stockSummary'), stockSearch: $('#stockSearch'), stockSearchInfo: $('#stockSearchInfo'), stockPalletGrid: $('#stockPalletGrid'),
    languageSelect: $('#languageSelect'), exportBtn: $('#exportBtn'), importInput: $('#importInput'), resetBtn: $('#resetBtn'),
    projectDialog: $('#projectDialog'), projectForm: $('#projectForm'), projectDialogTitle: $('#projectDialogTitle'), projectPhotoInput: $('#projectPhotoInput'),
    projectPhotoPreview: $('#projectPhotoPreview'), removeProjectPhotoBtn: $('#removeProjectPhotoBtn'),
    projectPartsDialog: $('#projectPartsDialog'), projectPartsForm: $('#projectPartsForm'), projectPartsTitle: $('#projectPartsTitle'), projectPartsSearch: $('#projectPartsSearch'), projectPartsList: $('#projectPartsList'),
    partDialog: $('#partDialog'), partForm: $('#partForm'), partDialogTitle: $('#partDialogTitle'), partProjectCheckboxes: $('#partProjectCheckboxes'), partDuplicateWarning: $('#partDuplicateWarning'),
    orderDialog: $('#orderDialog'), orderForm: $('#orderForm'), orderItemDialog: $('#orderItemDialog'), orderItemForm: $('#orderItemForm'), availabilityHint: $('#availabilityHint'),
    stockPalletDialog: $('#stockPalletDialog'), stockPalletForm: $('#stockPalletForm'), stockPalletDialogTitle: $('#stockPalletDialogTitle'),
    stockItemDialog: $('#stockItemDialog'), stockItemForm: $('#stockItemForm'), stockPartSearch: $('#stockPartSearch'), stockPartOptions: $('#stockPartOptions'), stockPartMatchHint: $('#stockPartMatchHint'), stockUnknownPart: $('#stockUnknownPart'), createStockMasterPartBtn: $('#createStockMasterPartBtn'),
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
    state.activity.unshift({ id: uid('activity'), textKey, detail, createdAt: new Date().toISOString() });
    state.activity = state.activity.slice(0, 40);
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
    applyTranslations();
    renderProjectSelectors();
    renderDashboard();
    renderProjects();
    renderInventory();
    renderOrders();
    renderStock();
    renderAlertBar();
    renderInventoryNotice();
    saveState();
  }

  function renderProjectSelectors() {
    const projectOptions = state.projects.length
      ? state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')
      : `<option value="">${esc(t('projects.none'))}</option>`;

    const previousFilter = els.inventoryProjectFilter.value || 'all';
    els.inventoryProjectFilter.innerHTML = `<option value="all">${esc(t('inventory.allParts'))}</option><option value="unassigned">${esc(t('inventory.notInProject'))}</option>${projectOptions}`;
    els.inventoryProjectFilter.value = [...els.inventoryProjectFilter.options].some(option => option.value === previousFilter) ? previousFilter : 'all';

    els.addPartBtn.disabled = false;
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

  function dismissNotice(key, signature = '') {
    if (key === 'inventory-info') state.dismissedNotices.inventoryInfo = true;
    if (key === 'stock-alert') state.dismissedNotices.stockAlertSignature = signature;
    renderAlertBar();
    renderInventoryNotice();
    saveState();
  }

  function renderDashboard() {
    const lowParts = state.parts.filter(part => part.quantity > 0 && part.quantity <= 4);
    const outParts = state.parts.filter(part => part.quantity <= 0);

    els.statProjects.textContent = state.projects.length;
    els.statParts.textContent = state.parts.length;
    els.statLow.textContent = lowParts.length;
    els.statOut.textContent = outParts.length;
    els.dashboardProjectName.textContent = getActiveProject()?.name || t('dashboard.createFirstProject');

    const order = getSelectedOrder();
    els.categoryProgress.innerHTML = CATEGORIES.map(category => {
      const items = order?.items.filter(item => item.category === category) || [];
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
    const query = els.inventorySearch.value.trim().toLowerCase();
    const projectFilter = els.inventoryProjectFilter.value || 'all';
    const stockFilter = els.inventoryStockFilter.value || 'all';
    const sort = els.inventorySort.value || 'name';

    const filtered = state.parts.filter(part => {
      const searchable = [part.code, part.name, dimensionLabel(part), part.length, part.width, part.height, part.category, assemblyLabel(part), ...getProjectNames(part)].join(' ').toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesProject = projectFilter === 'all'
        || (projectFilter === 'unassigned' && !(part.projectIds || []).length)
        || partInProject(part, projectFilter);
      const matchesStock = stockFilter === 'all'
        || (stockFilter === 'low' && part.quantity > 0 && part.quantity <= 4)
        || (stockFilter === 'out' && part.quantity <= 0)
        || (stockFilter === 'healthy' && part.quantity >= 5)
        || (stockFilter === 'overflowing' && part.overflowing);
      return matchesQuery && matchesProject && matchesStock;
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
    const parts = getFilteredInventory();
    els.inventoryTableBody.innerHTML = parts.map(part => {
      const status = stockStatus(part.quantity);
      const storedQuantity = storedQuantityForPart(part.id);
      return `<tr>
        <td><span class="part-code part-code-badge">${esc(part.code)}</span></td>
        <td><strong class="part-name table-part-name">${esc(part.name)}</strong>${part.notes ? `<br><small class="muted">${esc(part.notes)}</small>` : ''}</td>
        <td>${esc(dimensionLabel(part))}</td>
        <td><span class="assembly-badge">${esc(assemblyLabel(part))}</span></td>
        <td>${esc(categoryLabel(part.category))}</td>
        <td><div class="project-chip-row">${projectChips(part, 2)}</div></td>
        <td><div class="stock-control"><button type="button" data-action="minus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.reduceAria'))}">−</button><strong>${part.quantity}</strong><button type="button" data-action="plus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.increaseAria'))}">+</button></div></td>
        <td><strong>${storedQuantity}</strong></td>
        <td><div class="status-stack"><span class="status ${status.key}">${esc(status.label)}</span>${part.overflowing ? `<span class="status overflowing">${esc(t('status.overflowing'))}</span>` : ''}</div></td>
        <td><div class="row-actions"><button type="button" class="${part.overflowing ? 'overflow-active' : ''}" data-action="overflow" data-id="${esc(part.id)}">${esc(t(part.overflowing ? 'inventory.spaceAvailable' : 'inventory.markOverflowing'))}</button><button type="button" data-action="edit" data-id="${esc(part.id)}">${esc(t('common.edit'))}</button><button type="button" data-action="delete" data-id="${esc(part.id)}">${esc(t('common.delete'))}</button></div></td>
      </tr>`;
    }).join('');
    els.inventoryEmpty.classList.toggle('hidden', parts.length > 0);

    els.inventoryCards.innerHTML = parts.length ? parts.map(part => {
      const status = stockStatus(part.quantity);
      const storedQuantity = storedQuantityForPart(part.id);
      return `<article class="inventory-card">
        <div class="inventory-card-head"><div class="part-identity-stack">${partIdentityMarkup(part)}</div><div class="status-stack"><span class="status ${status.key}">${esc(status.label)}</span>${part.overflowing ? `<span class="status overflowing">${esc(t('status.overflowing'))}</span>` : ''}</div></div>
        <div class="inventory-card-meta"><span class="meta-chip">${esc(categoryLabel(part.category))}</span><span class="meta-chip">${esc(t('inventory.sizeLabel', { size: dimensionLabel(part) }))}</span><span class="meta-chip">${esc(t('inventory.assemblyLabel', { assembly: assemblyLabel(part) }))}</span><span class="meta-chip store-chip">${esc(t('inventory.atStoreLabel', { count: storedQuantity }))}</span>${part.notes ? `<span class="meta-chip">${esc(part.notes)}</span>` : ''}</div>
        <div class="project-chip-row card-projects">${projectChips(part, 4)}</div>
        <div class="shared-stock-label">${esc(t('inventory.sharedQuantity'))}</div>
        <div class="inventory-card-bottom"><div class="stock-control large"><button type="button" data-action="minus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.reduceAria'))}">−</button><strong>${part.quantity}</strong><button type="button" data-action="plus" data-id="${esc(part.id)}" aria-label="${esc(t('inventory.increaseAria'))}">+</button></div><div class="row-actions"><button type="button" class="${part.overflowing ? 'overflow-active' : ''}" data-action="overflow" data-id="${esc(part.id)}">${esc(t(part.overflowing ? 'inventory.spaceAvailable' : 'status.overflowing'))}</button><button type="button" data-action="edit" data-id="${esc(part.id)}">${esc(t('common.edit'))}</button><button type="button" data-action="delete" data-id="${esc(part.id)}">${esc(t('common.delete'))}</button></div></div>
      </article>`;
    }).join('') : `<div class="empty-state"><strong>${esc(t('inventory.noneMatch'))}</strong><span>${esc(t('inventory.noneMatchHint'))}</span></div>`;
  }

  function renderOrders() {
    const orders = getActiveOrders();
    els.orderSelect.innerHTML = orders.length ? orders.map(order => `<option value="${esc(order.id)}">${esc(order.name)}</option>`).join('') : `<option value="">${esc(t('orders.none'))}</option>`;
    els.orderSelect.disabled = !orders.length;
    els.deleteOrderBtn.disabled = !orders.length;
    const order = getSelectedOrder();
    if (order) els.orderSelect.value = order.id;

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

    const total = order.items.length;
    const packed = order.items.filter(item => item.packed).length;
    const shortages = order.items.filter(item => {
      if (item.packed) return false;
      const part = state.parts.find(candidate => candidate.id === item.partId);
      return !part || part.quantity < item.quantityNeeded;
    }).length;
    els.orderSummary.innerHTML = `<div class="summary-chip"><span>${esc(t('orders.requiredLines'))}</span><strong>${total}</strong></div><div class="summary-chip"><span>${esc(t('orders.packedLines'))}</span><strong>${packed}</strong></div><div class="summary-chip"><span>${esc(t('orders.shortages'))}</span><strong>${shortages}</strong></div>`;

    els.orderBoards.innerHTML = CATEGORIES.map(category => {
      const items = order.items.filter(item => item.category === category);
      const itemHtml = items.length ? items.map(item => {
        const part = state.parts.find(candidate => candidate.id === item.partId);
        const available = part?.quantity ?? 0;
        const insufficient = !item.packed && available < item.quantityNeeded;
        const codeName = part ? `${part.code} — ${part.name}` : t('inventory.deletedPart');
        const size = part ? dimensionLabel(part) : '';
        const metadata = part ? [size !== '—' ? size : '', assemblyLabel(part) !== '—' ? t('orders.partMeta', { assembly: assemblyLabel(part) }) : ''].filter(Boolean).join(' · ') : '';
        const stockText = item.packed ? t('orders.packedStock') : t('orders.sharedStock', { count: available, metadata: metadata ? ` · ${metadata}` : '' });
        return `<div class="check-item ${item.packed ? 'packed' : ''}">
          <input type="checkbox" data-action="toggle-pack" data-item-id="${esc(item.id)}" ${item.packed ? 'checked' : ''} ${!part ? 'disabled' : ''} />
          <div class="part-label"><div class="part-identity-inline">${partIdentityMarkup(part)}</div><span>${esc(stockText)}</span></div>
          <label class="needed-editor ${insufficient ? 'short' : ''}">
            <span>${esc(t('orders.needed'))}</span>
            <input type="number" min="1" step="1" inputmode="numeric" value="${item.quantityNeeded}" data-action="edit-needed" data-item-id="${esc(item.id)}" aria-label="${esc(t('orders.neededAria', { name: codeName }))}" ${!part ? 'disabled' : ''} />
          </label>
          <button class="remove-item" data-action="remove-order-item" data-item-id="${esc(item.id)}" aria-label="${esc(t('orders.removeAria'))}">×</button>
        </div>`;
      }).join('') : `<div class="column-empty">${esc(t('orders.noneInSection'))}</div>`;
      return `<article class="order-column"><div class="order-column-head"><h3>${esc(categoryLabel(category))}</h3><button data-action="add-order-item" data-category="${category}">${esc(t('orders.addPart'))}</button></div><div class="checklist">${itemHtml}</div></article>`;
    }).join('');
  }

  function renderStock() {
    const query = els.stockSearch.value.trim().toLowerCase();
    const pallets = [...state.stockPallets]
      .filter(pallet => {
        const partText = pallet.items.map(item => {
          const part = state.parts.find(candidate => candidate.id === item.partId);
          return part ? [part.code, part.name, part.category, dimensionLabel(part), assemblyLabel(part)].join(' ') : '';
        }).join(' ');
        return !query || [pallet.deliveryNumber, pallet.palletNumber, pallet.notes, partText].join(' ').toLowerCase().includes(query);
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const storedUnits = state.stockPallets.reduce((sum, pallet) => sum + pallet.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
    const distinctParts = new Set(state.stockPallets.flatMap(pallet => pallet.items.map(item => item.partId))).size;
    els.stockSummary.innerHTML = `<div class="summary-chip"><span>${esc(t('stock.storedPallets'))}</span><strong>${state.stockPallets.length}</strong></div><div class="summary-chip"><span>${esc(t('stock.differentParts'))}</span><strong>${distinctParts}</strong></div><div class="summary-chip"><span>${esc(t('stock.unitsAtStore'))}</span><strong>${storedUnits}</strong></div>`;
    els.stockSearchInfo.textContent = query ? t(pallets.length === 1 ? 'stock.matchingPallet' : 'stock.matchingPallets', { count: pallets.length }) : '';

    els.stockPalletGrid.innerHTML = pallets.length ? pallets.map(pallet => {
      const units = pallet.items.reduce((sum, item) => sum + item.quantity, 0);
      const preview = pallet.items.slice(0, 3).map(item => {
        const part = state.parts.find(candidate => candidate.id === item.partId);
        return `<div class="stock-card-part"><div>${partIdentityMarkup(part)}</div><strong>×${item.quantity}</strong></div>`;
      }).join('');
      const overflowCount = pallet.items.filter(item => state.parts.find(part => part.id === item.partId)?.overflowing).length;
      return `<article class="stock-pallet-card">
        <div class="stock-pallet-card-head"><div><span class="delivery-label">${esc(t('common.delivery'))} ${esc(pallet.deliveryNumber)}</span><h3>${esc(t('common.pallet'))} ${esc(pallet.palletNumber)}</h3></div><span class="pallet-unit-count">${units}</span></div>
        <div class="stock-pallet-meta"><span>${esc(t('common.partLines', { count: pallet.items.length }))}</span><span>${esc(t('common.units', { count: units }))}</span>${overflowCount ? `<span class="overflow-text">${esc(t('stock.overflowingCount', { count: overflowCount }))}</span>` : ''}</div>
        <div class="stock-card-parts">${preview || `<span class="muted">${esc(t('stock.noPartsYet'))}</span>`}${pallet.items.length > 3 ? `<small>${esc(t('common.more', { count: pallet.items.length - 3 }))}</small>` : ''}</div>
        ${pallet.notes ? `<p class="stock-pallet-note">${esc(pallet.notes)}</p>` : ''}
        <button class="secondary stock-pallet-open" data-pallet-id="${esc(pallet.id)}" type="button">${esc(t('stock.openPallet'))}</button>
      </article>`;
    }).join('') : `<div class="empty-state panel stock-empty"><strong>${esc(t(query ? 'stock.noSearchResults' : 'stock.none'))}</strong><span>${esc(t(query ? 'stock.noSearchResultsHint' : 'stock.noneHint'))}</span></div>`;
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

  function resolveStockPartSearch(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;
    const matches = state.parts.filter(part => [part.code, part.name, `${part.code} — ${part.name}`].some(candidate => candidate.toLowerCase() === normalized));
    return matches.length === 1 ? matches[0] : null;
  }

  function updateStockPartMatch() {
    const pallet = getStockPallet($('[name="palletId"]', els.stockItemForm).value);
    const raw = els.stockPartSearch.value.trim();
    const part = resolveStockPartSearch(raw);
    const alreadyAdded = part && pallet?.items.some(item => item.partId === part.id);
    const submitButton = $('button[type="submit"]', els.stockItemForm);
    $('[name="partId"]', els.stockItemForm).value = part && !alreadyAdded ? part.id : '';
    els.stockPartMatchHint.className = 'availability-hint';
    els.stockUnknownPart.classList.add('hidden');

    if (!raw) {
      els.stockPartMatchHint.textContent = t('stock.chooseMaster');
      submitButton.disabled = true;
      return;
    }
    if (alreadyAdded) {
      els.stockPartMatchHint.textContent = t('stock.alreadyOnPallet');
      els.stockPartMatchHint.classList.add('warning');
      submitButton.disabled = true;
      return;
    }
    if (part) {
      els.stockPartMatchHint.textContent = t('stock.matchDetails', { received: part.quantity, stored: storedQuantityForPart(part.id), overflowing: part.overflowing ? t('stock.markedOverflowingSuffix') : '' });
      if (part.overflowing) els.stockPartMatchHint.classList.add('warning');
      submitButton.disabled = false;
      return;
    }
    els.stockPartMatchHint.textContent = t('stock.noExactMatch');
    els.stockPartMatchHint.classList.add('warning');
    els.stockUnknownPart.classList.remove('hidden');
    submitButton.disabled = true;
  }

  function openStockItemDialog(palletId, preferredPartId = '') {
    const pallet = getStockPallet(palletId);
    if (!pallet) return;
    els.stockItemForm.reset();
    $('[name="palletId"]', els.stockItemForm).value = palletId;
    $('[name="quantity"]', els.stockItemForm).value = 1;
    const addedIds = new Set(pallet.items.map(item => item.partId));
    const availableParts = state.parts.filter(part => !addedIds.has(part.id)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    els.stockPartOptions.innerHTML = availableParts.map(part => `<option value="${esc(part.code)} — ${esc(part.name)}" label="${esc(t('stock.optionDetails', { received: part.quantity, stored: storedQuantityForPart(part.id) }))}"></option>`).join('');
    const preferred = state.parts.find(part => part.id === preferredPartId);
    els.stockPartSearch.value = preferred ? `${preferred.code} — ${preferred.name}` : '';
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
        <div class="stock-detail-part"><div class="part-identity-stack">${partIdentityMarkup(part)}</div><span>${part ? esc(t('stock.partDetail', { category: categoryLabel(part.category), size: dimensionLabel(part), received: part.quantity, stored: storedQuantityForPart(part.id) })) : esc(t('stock.masterUnavailable'))}</span>${part?.overflowing ? `<span class="status overflowing">${esc(t('status.overflowing'))}</span>` : ''}</div>
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
    renderPartProjectCheckboxes(source.projectIds || (state.activeProjectId ? [state.activeProjectId] : []));
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
    const query = els.projectPartsSearch.value.trim().toLowerCase();
    const parts = state.parts.filter(part => !query || [part.code, part.name, dimensionLabel(part), part.category].join(' ').toLowerCase().includes(query));
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
    const includedPartIds = new Set(order.items.map(item => item.partId));
    const matchingParts = state.parts
      .filter(part => partInProject(part, state.activeProjectId) && (part.category === category || part.category === 'Other'))
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
    state.orders.filter(order => order.projectId === projectId).forEach(order => {
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
    orders.forEach(order => order.items.filter(item => item.packed).forEach(item => {
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
    if (!window.confirm(t('message.orderDeletedConfirm', { name: order.name }))) return;
    restorePackedStockForOrders([order]);
    state.orders = state.orders.filter(candidate => candidate.id !== orderId);
    addActivity('activity.orderDeleted', order.name);
    state.selectedOrderId = null;
    renderAll();
    showToast(t('message.orderDeleted'));
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

  function togglePartOverflowing(partId) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    part.overflowing = !part.overflowing;
    addActivity(part.overflowing ? 'activity.overflowing' : 'activity.spaceRestored', `${part.code} — ${part.name}`);
    renderAll();
    if (openStockPalletId) renderStockPalletDetail();
    showToast(t(part.overflowing ? 'message.overflowing' : 'message.spaceAvailable'));
  }

  function updateStockPalletItemQuantity(itemId, requestedQuantity) {
    const pallet = getStockPallet(openStockPalletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const numericQuantity = Number(requestedQuantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      showToast(t('message.storedMinimum'));
      renderStockPalletDetail();
      return;
    }
    const nextQuantity = Math.floor(numericQuantity);
    if (nextQuantity === item.quantity) return;
    const previousQuantity = item.quantity;
    item.quantity = nextQuantity;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    addActivity('activity.stockPalletQuantityChanged', `${part?.code || t('common.part')}: ${previousQuantity} → ${nextQuantity} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    renderAll();
    renderStockPalletDetail();
    showToast(t('message.storedUpdated'));
  }

  function removeStockPalletItem(itemId) {
    const pallet = getStockPallet(openStockPalletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!window.confirm(t('message.removeStoredConfirm', { part: part?.code || t('common.part'), delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))) return;
    pallet.items = pallet.items.filter(candidate => candidate.id !== itemId);
    addActivity('activity.stockPalletPartRemoved', `${part?.code || t('common.part')} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    renderAll();
    renderStockPalletDetail();
    showToast(t('message.storedPartRemoved'));
  }

  function deleteStockPallet(palletId) {
    const pallet = getStockPallet(palletId);
    if (!pallet) return;
    if (!window.confirm(t('message.deletePalletConfirm', { delivery: pallet.deliveryNumber, pallet: pallet.palletNumber }))) return;
    state.stockPallets = state.stockPallets.filter(candidate => candidate.id !== palletId);
    addActivity('activity.stockPalletDeleted', `${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    openStockPalletId = null;
    closeDialog(els.stockPalletDetailDialog);
    renderAll();
    showToast(t('message.palletDeleted'));
  }

  function togglePacked(itemId, shouldPack) {
    const order = getSelectedOrder();
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
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (item.packed && part) part.quantity += item.quantityNeeded;
    order.items = order.items.filter(candidate => candidate.id !== itemId);
    addActivity('activity.checklistRemoved', part ? `${part.code} · ${order.name}` : order.name);
    renderAll();
  }

  els.menuBtn.addEventListener('click', () => els.sidebar.classList.toggle('open'));
  document.addEventListener('click', event => {
    if (window.innerWidth <= 820 && els.sidebar.classList.contains('open') && !els.sidebar.contains(event.target) && event.target !== els.menuBtn) els.sidebar.classList.remove('open');
    const dismissButton = event.target.closest('[data-dismiss-notice]');
    if (dismissButton) dismissNotice(dismissButton.dataset.dismissNotice, dismissButton.dataset.signature || '');
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
    if (dialog === els.stockPalletDetailDialog) openStockPalletId = null;
    closeDialog(dialog);
    if (returnToPallet) openStockPalletDetail(openStockPalletId);
  }));
  $$('[data-stock-filter]').forEach(button => button.addEventListener('click', () => {
    els.inventorySearch.value = '';
    els.inventoryProjectFilter.value = 'all';
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
      category: String(data.get('category') || 'Other'),
      assemblyPosition: position,
      assemblyTotal: total,
      overflowing: data.get('overflowing') === 'on',
      notes: String(data.get('notes') || '').trim()
    };
    if (!payload.code || !payload.name) return;

    let removedItems = 0;
    let savedPart = null;
    if (id) {
      const part = state.parts.find(candidate => candidate.id === id);
      if (!part) return;
      removedItems = setPartProjects(part, nextProjectIds);
      Object.assign(part, payload);
      savedPart = part;
      addActivity('activity.masterUpdated', `${payload.code} — ${payload.name}`);
    } else {
      savedPart = { id: uid('part'), ...payload, projectIds: [...new Set(nextProjectIds)] };
      state.parts.push(savedPart);
      addActivity('activity.masterAdded', `${payload.code} × ${payload.quantity}`);
    }
    const returnPalletId = stockPartReturnPalletId;
    stockPartReturnPalletId = null;
    closeDialog(els.partDialog);
    renderAll();
    if (!id && returnPalletId && getStockPallet(returnPalletId)) {
      openStockItemDialog(returnPalletId, savedPart.id);
      showToast(t('message.masterCreatedReturn'));
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
    const order = { id: uid('order'), projectId: state.activeProjectId, name: String(data.get('name') || '').trim(), notes: String(data.get('notes') || '').trim(), createdAt: new Date().toISOString(), items: [] };
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
    const data = new FormData(els.orderItemForm);
    const partId = String(data.get('partId') || '');
    const quantityNeeded = Math.max(1, Number(data.get('quantityNeeded')) || 1);
    const category = String(data.get('category') || 'Other');
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part || !partInProject(part, state.activeProjectId)) return showToast(t('message.chooseProjectPart'));
    if (order.items.some(item => item.partId === partId)) {
      closeDialog(els.orderItemDialog);
      renderAll();
      return showToast(t('message.checklistDuplicate'));
    }
    order.items.push({ id: uid('item'), partId, category, quantityNeeded, packed: false });
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
    openStockPalletId = pallet.id;
    closeDialog(els.stockPalletDialog);
    renderAll();
    openStockPalletDetail(pallet.id);
    showToast(t(id ? 'message.palletUpdated' : 'message.palletCreated'));
  });

  els.stockPartSearch.addEventListener('input', updateStockPartMatch);
  els.stockItemForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.stockItemForm);
    const pallet = getStockPallet(String(data.get('palletId') || ''));
    const part = state.parts.find(candidate => candidate.id === String(data.get('partId') || ''));
    const quantity = Math.max(1, Math.floor(Number(data.get('quantity')) || 1));
    if (!pallet || !part) return showToast(t('message.chooseOrCreatePart'));
    if (pallet.items.some(item => item.partId === part.id)) return showToast(t('message.palletPartDuplicate'));
    pallet.items.push({ id: uid('stock_item'), partId: part.id, quantity });
    addActivity('activity.partAddedStockPallet', `${part.code} × ${quantity} · ${pallet.deliveryNumber} / ${pallet.palletNumber}`);
    openStockPalletId = pallet.id;
    closeDialog(els.stockItemDialog);
    renderAll();
    openStockPalletDetail(pallet.id);
    showToast(t(part.overflowing ? 'message.partAddedOverflowing' : 'message.partAddedPallet'));
  });

  els.createStockMasterPartBtn.addEventListener('click', () => {
    const palletId = $('[name="palletId"]', els.stockItemForm).value;
    const raw = els.stockPartSearch.value.trim();
    if (!palletId || !raw) return;
    const separator = raw.indexOf(' — ');
    const code = (separator >= 0 ? raw.slice(0, separator) : raw).trim().toUpperCase();
    const name = separator >= 0 ? raw.slice(separator + 3).trim() : '';
    closeDialog(els.stockItemDialog);
    openPartDialog(null, { code, name, quantity: 0, returnPalletId: palletId });
  });

  els.stockSearch.addEventListener('input', renderStock);
  els.stockPalletGrid.addEventListener('click', event => {
    const button = event.target.closest('.stock-pallet-open');
    if (button) openStockPalletDetail(button.dataset.palletId);
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

  [els.inventorySearch, els.inventoryProjectFilter, els.inventoryStockFilter, els.inventorySort].forEach(control => control.addEventListener(control === els.inventorySearch ? 'input' : 'change', renderInventory));

  function handleInventoryAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'minus') adjustPartQuantity(button.dataset.id, -1);
    if (button.dataset.action === 'plus') adjustPartQuantity(button.dataset.id, 1);
    if (button.dataset.action === 'overflow') togglePartOverflowing(button.dataset.id);
    if (button.dataset.action === 'edit') openPartDialog(state.parts.find(part => part.id === button.dataset.id));
    if (button.dataset.action === 'delete') deletePart(button.dataset.id);
  }
  els.inventoryTableBody.addEventListener('click', handleInventoryAction);
  els.inventoryCards.addEventListener('click', handleInventoryAction);

  els.orderSelect.addEventListener('change', () => { state.selectedOrderId = els.orderSelect.value || null; renderAll(); });
  els.deleteOrderBtn.addEventListener('click', () => { const order = getSelectedOrder(); if (order) deleteOrder(order.id); });
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
    renderAll();
    showToast(t('message.resetDone'));
  });

  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:') && !location.hostname.includes('livecodes')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker unavailable:', error)));
  }

  renderAll();
  switchView(currentView);
})();
