(() => {
  'use strict';

  const STORAGE_KEY = 'storeflow-state-v1';
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
      version: 5,
      activeProjectId: null,
      selectedOrderId: null,
      projects: [],
      parts: [],
      orders: [],
      stockPallets: [],
      dismissedNotices: {},
      activity: [
        { id: uid('activity'), text: 'StoreFlow workspace ready', detail: 'Create a project or add your first master part to begin.', createdAt: now }
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
      dimensions.length ? `L ${dimensions.length}` : '',
      dimensions.width ? `W ${dimensions.width}` : '',
      dimensions.height ? `H ${dimensions.height}` : ''
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
      version: 5,
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
    exportBtn: $('#exportBtn'), importInput: $('#importInput'), resetBtn: $('#resetBtn'),
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
    dashboard: ['Dashboard', 'OVERVIEW'], projects: ['Projects', 'WORKSPACES'], inventory: ['Inventory', 'MASTER STOCK'],
    orders: ['Assembly orders', 'PALLET BUILDING'], stock: ['Stock', 'AT THE STORE'], settings: ['Data & settings', 'WORKSPACE']
  };

  function saveState() {
    storageSet(STORAGE_KEY, JSON.stringify(state));
    renderStorageNotice();
  }

  function renderStorageNotice() {
    els.storageNotice?.classList.toggle('hidden', storageAvailable);
  }

  function addActivity(text, detail = '') {
    state.activity.unshift({ id: uid('activity'), text, detail, createdAt: new Date().toISOString() });
    state.activity = state.activity.slice(0, 40);
  }

  function formatDate(iso) {
    try {
      return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch (error) {
      return '';
    }
  }

  function getActiveProject() {
    return state.projects.find(project => project.id === state.activeProjectId) || null;
  }

  function getProjectName(id) {
    return state.projects.find(project => project.id === id)?.name || 'Unknown project';
  }

  function partInProject(part, projectId) {
    return Boolean(projectId && Array.isArray(part.projectIds) && part.projectIds.includes(projectId));
  }

  function getProjectParts(projectId) {
    return state.parts.filter(part => partInProject(part, projectId));
  }

  function getProjectNames(part) {
    return (part.projectIds || []).map(getProjectName).filter(name => name !== 'Unknown project');
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
    if (quantity <= 0) return { key: 'out', label: 'Out of stock' };
    if (quantity <= 4) return { key: 'low', label: 'Low stock' };
    return { key: 'healthy', label: 'In stock' };
  }

  function getStockPallet(id) {
    return state.stockPallets.find(pallet => pallet.id === id) || null;
  }

  function storedQuantityForPart(partId) {
    return state.stockPallets.reduce((total, pallet) => total + pallet.items.filter(item => item.partId === partId).reduce((sum, item) => sum + item.quantity, 0), 0);
  }

  function partIdentityMarkup(part) {
    if (!part) return '<strong class="part-name">Deleted master part</strong>';
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
    const [title, eyebrow] = viewMeta[view] || viewMeta.dashboard;
    els.pageTitle.textContent = title;
    els.pageEyebrow.textContent = eyebrow;
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
      : '<option value="">No projects yet</option>';

    const previousFilter = els.inventoryProjectFilter.value || 'all';
    els.inventoryProjectFilter.innerHTML = `<option value="all">All master parts</option><option value="unassigned">Not in a project</option>${projectOptions}`;
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
    if (out) messages.push(`${out} out of stock`);
    if (low) messages.push(`${low} low stock`);
    els.alertBar.innerHTML = `<span>⚠ Master inventory: ${messages.join(' and ')}. Tap a stock card below to review the complete list.</span><button type="button" class="notice-close" data-dismiss-notice="stock-alert" data-signature="${signature}" aria-label="Close master inventory warning">×</button>`;
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
    els.dashboardProjectName.textContent = getActiveProject()?.name || 'Create your first project';

    const order = getSelectedOrder();
    els.categoryProgress.innerHTML = CATEGORIES.map(category => {
      const items = order?.items.filter(item => item.category === category) || [];
      const packed = items.filter(item => item.packed).length;
      const percentage = items.length ? Math.round((packed / items.length) * 100) : 0;
      return `<div class="category-card"><div class="top"><strong>${category}</strong><span>${packed}/${items.length}</span></div><div class="progress-track"><div class="progress-fill" style="width:${percentage}%"></div></div></div>`;
    }).join('');

    els.activityList.innerHTML = state.activity.length
      ? state.activity.slice(0, 8).map(activity => `<div class="activity-item"><div><strong>${esc(activity.text)}</strong><span>${esc(activity.detail)}</span></div><span>${formatDate(activity.createdAt)}</span></div>`).join('')
      : '<div class="empty-state"><strong>No activity yet.</strong><span>Your changes will appear here.</span></div>';
  }

  function renderProjects() {
    if (!state.projects.length) {
      els.projectCards.innerHTML = '<div class="empty-state panel"><strong>No projects yet.</strong><span>Create a project, then include parts from the master inventory.</span></div>';
      return;
    }

    els.projectCards.innerHTML = state.projects.map(project => {
      const linkedParts = getProjectParts(project.id);
      const totalQty = linkedParts.reduce((sum, part) => sum + part.quantity, 0);
      const orderCount = state.orders.filter(order => order.projectId === project.id).length;
      const isActive = project.id === state.activeProjectId;
      const photo = project.photo
        ? `<button type="button" class="project-card-photo project-photo-expand" data-id="${esc(project.id)}" aria-label="Expand photo for ${esc(project.name)}"><img src="${esc(project.photo)}" alt="${esc(project.name)}" /><span class="photo-expand-hint">Tap to expand</span></button>`
        : '<div class="project-card-photo"><div class="project-photo-placeholder"><span>SF</span><small>Add project photo</small></div></div>';
      return `<article class="project-card ${isActive ? 'active' : ''}">
        ${photo}
        <div class="project-card-body">
          <div class="project-card-head"><div><p class="eyebrow">PROJECT</p><h3>${esc(project.name)}</h3></div><button class="icon-button project-delete" data-id="${esc(project.id)}" aria-label="Delete project">×</button></div>
          <p class="muted">${esc(project.location || 'No location set')}${project.reference ? ` · ${esc(project.reference)}` : ''}</p>
          <div class="project-meta"><span class="meta-chip">${linkedParts.length} linked parts</span><span class="meta-chip">${totalQty} shared units</span><span class="meta-chip">${orderCount} orders</span></div>
          <div class="project-actions project-actions-wrap">
            <button class="${isActive ? 'secondary' : 'primary'} project-open" data-id="${esc(project.id)}">Open project</button>
            <button class="secondary project-manage-parts" data-id="${esc(project.id)}">Manage parts</button>
            <button class="secondary project-edit" data-id="${esc(project.id)}">Edit project</button>
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
    if (!names.length) return '<span class="meta-chip muted-chip">Unassigned</span>';
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
        <td>${esc(part.category)}</td>
        <td><div class="project-chip-row">${projectChips(part, 2)}</div></td>
        <td><div class="stock-control"><button type="button" data-action="minus" data-id="${esc(part.id)}" aria-label="Reduce shared quantity">−</button><strong>${part.quantity}</strong><button type="button" data-action="plus" data-id="${esc(part.id)}" aria-label="Increase shared quantity">+</button></div></td>
        <td><strong>${storedQuantity}</strong></td>
        <td><div class="status-stack"><span class="status ${status.key}">${status.label}</span>${part.overflowing ? '<span class="status overflowing">Overflowing</span>' : ''}</div></td>
        <td><div class="row-actions"><button type="button" class="${part.overflowing ? 'overflow-active' : ''}" data-action="overflow" data-id="${esc(part.id)}">${part.overflowing ? 'Space available' : 'Mark overflowing'}</button><button type="button" data-action="edit" data-id="${esc(part.id)}">Edit</button><button type="button" data-action="delete" data-id="${esc(part.id)}">Delete</button></div></td>
      </tr>`;
    }).join('');
    els.inventoryEmpty.classList.toggle('hidden', parts.length > 0);

    els.inventoryCards.innerHTML = parts.length ? parts.map(part => {
      const status = stockStatus(part.quantity);
      const storedQuantity = storedQuantityForPart(part.id);
      return `<article class="inventory-card">
        <div class="inventory-card-head"><div class="part-identity-stack">${partIdentityMarkup(part)}</div><div class="status-stack"><span class="status ${status.key}">${status.label}</span>${part.overflowing ? '<span class="status overflowing">Overflowing</span>' : ''}</div></div>
        <div class="inventory-card-meta"><span class="meta-chip">${esc(part.category)}</span><span class="meta-chip">Size: ${esc(dimensionLabel(part))}</span><span class="meta-chip">Assembly: ${esc(assemblyLabel(part))}</span><span class="meta-chip store-chip">${storedQuantity} at store</span>${part.notes ? `<span class="meta-chip">${esc(part.notes)}</span>` : ''}</div>
        <div class="project-chip-row card-projects">${projectChips(part, 4)}</div>
        <div class="shared-stock-label">Shared quantity across every linked project</div>
        <div class="inventory-card-bottom"><div class="stock-control large"><button type="button" data-action="minus" data-id="${esc(part.id)}" aria-label="Reduce shared quantity">−</button><strong>${part.quantity}</strong><button type="button" data-action="plus" data-id="${esc(part.id)}" aria-label="Increase shared quantity">+</button></div><div class="row-actions"><button type="button" class="${part.overflowing ? 'overflow-active' : ''}" data-action="overflow" data-id="${esc(part.id)}">${part.overflowing ? 'Space available' : 'Overflowing'}</button><button type="button" data-action="edit" data-id="${esc(part.id)}">Edit</button><button type="button" data-action="delete" data-id="${esc(part.id)}">Delete</button></div></div>
      </article>`;
    }).join('') : '<div class="empty-state"><strong>No parts match these filters.</strong><span>Add a master part or change the filters.</span></div>';
  }

  function renderOrders() {
    const orders = getActiveOrders();
    els.orderSelect.innerHTML = orders.length ? orders.map(order => `<option value="${esc(order.id)}">${esc(order.name)}</option>`).join('') : '<option value="">No orders yet</option>';
    els.orderSelect.disabled = !orders.length;
    els.deleteOrderBtn.disabled = !orders.length;
    const order = getSelectedOrder();
    if (order) els.orderSelect.value = order.id;

    if (!state.activeProjectId) {
      els.orderSummary.innerHTML = '';
      els.orderBoards.innerHTML = '<div class="empty-state panel"><strong>Create a project first.</strong><span>Projects determine which shared parts are available to an assembly order.</span></div>';
      return;
    }
    if (!order) {
      els.orderSummary.innerHTML = '';
      els.orderBoards.innerHTML = '<div class="empty-state panel"><strong>No assembly order for this project.</strong><span>Create an order, then add project parts under Desk, Bed, Wardrobe and Kitchen.</span></div>';
      return;
    }

    const total = order.items.length;
    const packed = order.items.filter(item => item.packed).length;
    const shortages = order.items.filter(item => {
      if (item.packed) return false;
      const part = state.parts.find(candidate => candidate.id === item.partId);
      return !part || part.quantity < item.quantityNeeded;
    }).length;
    els.orderSummary.innerHTML = `<div class="summary-chip"><span>Required lines</span><strong>${total}</strong></div><div class="summary-chip"><span>Packed lines</span><strong>${packed}</strong></div><div class="summary-chip"><span>Shortages</span><strong>${shortages}</strong></div>`;

    els.orderBoards.innerHTML = CATEGORIES.map(category => {
      const items = order.items.filter(item => item.category === category);
      const itemHtml = items.length ? items.map(item => {
        const part = state.parts.find(candidate => candidate.id === item.partId);
        const available = part?.quantity ?? 0;
        const insufficient = !item.packed && available < item.quantityNeeded;
        const codeName = part ? `${part.code} — ${part.name}` : 'Deleted master part';
        const size = part ? dimensionLabel(part) : '';
        const metadata = part ? [size !== '—' ? size : '', assemblyLabel(part) !== '—' ? `Part ${assemblyLabel(part)}` : ''].filter(Boolean).join(' · ') : '';
        const stockText = item.packed ? 'Packed on pallet; shared stock deducted' : `${available} in shared stock${metadata ? ` · ${metadata}` : ''}`;
        return `<div class="check-item ${item.packed ? 'packed' : ''}">
          <input type="checkbox" data-action="toggle-pack" data-item-id="${esc(item.id)}" ${item.packed ? 'checked' : ''} ${!part ? 'disabled' : ''} />
          <div class="part-label"><div class="part-identity-inline">${partIdentityMarkup(part)}</div><span>${esc(stockText)}</span></div>
          <label class="needed-editor ${insufficient ? 'short' : ''}">
            <span>Needed</span>
            <input type="number" min="1" step="1" inputmode="numeric" value="${item.quantityNeeded}" data-action="edit-needed" data-item-id="${esc(item.id)}" aria-label="Needed quantity for ${esc(codeName)}" ${!part ? 'disabled' : ''} />
          </label>
          <button class="remove-item" data-action="remove-order-item" data-item-id="${esc(item.id)}" aria-label="Remove item">×</button>
        </div>`;
      }).join('') : '<div class="column-empty">No parts added to this section.</div>';
      return `<article class="order-column"><div class="order-column-head"><h3>${category}</h3><button data-action="add-order-item" data-category="${category}">+ Add part</button></div><div class="checklist">${itemHtml}</div></article>`;
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
    els.stockSummary.innerHTML = `<div class="summary-chip"><span>Stored pallets</span><strong>${state.stockPallets.length}</strong></div><div class="summary-chip"><span>Different parts</span><strong>${distinctParts}</strong></div><div class="summary-chip"><span>Units at store</span><strong>${storedUnits}</strong></div>`;
    els.stockSearchInfo.textContent = query ? `${pallets.length} matching pallet${pallets.length === 1 ? '' : 's'}` : '';

    els.stockPalletGrid.innerHTML = pallets.length ? pallets.map(pallet => {
      const units = pallet.items.reduce((sum, item) => sum + item.quantity, 0);
      const preview = pallet.items.slice(0, 3).map(item => {
        const part = state.parts.find(candidate => candidate.id === item.partId);
        return `<div class="stock-card-part"><div>${partIdentityMarkup(part)}</div><strong>×${item.quantity}</strong></div>`;
      }).join('');
      const overflowCount = pallet.items.filter(item => state.parts.find(part => part.id === item.partId)?.overflowing).length;
      return `<article class="stock-pallet-card">
        <div class="stock-pallet-card-head"><div><span class="delivery-label">Delivery ${esc(pallet.deliveryNumber)}</span><h3>Pallet ${esc(pallet.palletNumber)}</h3></div><span class="pallet-unit-count">${units}</span></div>
        <div class="stock-pallet-meta"><span>${pallet.items.length} part lines</span><span>${units} units</span>${overflowCount ? `<span class="overflow-text">${overflowCount} overflowing</span>` : ''}</div>
        <div class="stock-card-parts">${preview || '<span class="muted">No parts added yet.</span>'}${pallet.items.length > 3 ? `<small>+${pallet.items.length - 3} more</small>` : ''}</div>
        ${pallet.notes ? `<p class="stock-pallet-note">${esc(pallet.notes)}</p>` : ''}
        <button class="secondary stock-pallet-open" data-pallet-id="${esc(pallet.id)}" type="button">Open pallet</button>
      </article>`;
    }).join('') : `<div class="empty-state panel stock-empty"><strong>${query ? 'No pallets contain that part.' : 'No stored pallets yet.'}</strong><span>${query ? 'Try another code or part name.' : 'Create a pallet using its delivery and pallet numbers.'}</span></div>`;
  }

  function openStockPalletDialog(pallet = null) {
    els.stockPalletForm.reset();
    $('[name="id"]', els.stockPalletForm).value = pallet?.id || '';
    $('[name="deliveryNumber"]', els.stockPalletForm).value = pallet?.deliveryNumber || '';
    $('[name="palletNumber"]', els.stockPalletForm).value = pallet?.palletNumber || '';
    $('[name="notes"]', els.stockPalletForm).value = pallet?.notes || '';
    els.stockPalletDialogTitle.textContent = pallet ? 'Edit stored pallet' : 'Create a stored pallet';
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
      els.stockPartMatchHint.textContent = 'Choose a master part. Stored quantities are tracked separately from received stock.';
      submitButton.disabled = true;
      return;
    }
    if (alreadyAdded) {
      els.stockPartMatchHint.textContent = 'This part is already on the pallet. Edit its quantity in the pallet list.';
      els.stockPartMatchHint.classList.add('warning');
      submitButton.disabled = true;
      return;
    }
    if (part) {
      els.stockPartMatchHint.textContent = `${part.quantity} received · ${storedQuantityForPart(part.id)} already at store${part.overflowing ? ' · marked overflowing' : ''}.`;
      if (part.overflowing) els.stockPartMatchHint.classList.add('warning');
      submitButton.disabled = false;
      return;
    }
    els.stockPartMatchHint.textContent = 'No exact Master Inventory match. Create this master part before adding it to the pallet.';
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
    els.stockPartOptions.innerHTML = availableParts.map(part => `<option value="${esc(part.code)} — ${esc(part.name)}" label="${part.quantity} received · ${storedQuantityForPart(part.id)} at store"></option>`).join('');
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
    els.stockPalletDetailTitle.textContent = `Delivery ${pallet.deliveryNumber} · Pallet ${pallet.palletNumber}`;
    els.stockPalletDetailMeta.innerHTML = `<span class="meta-chip">${pallet.items.length} part lines</span><span class="meta-chip">${units} stored units</span><span class="meta-chip">Created ${esc(formatDate(pallet.createdAt))}</span>${pallet.notes ? `<span class="meta-chip detail-note">${esc(pallet.notes)}</span>` : ''}`;
    els.stockPalletItems.innerHTML = pallet.items.length ? pallet.items.map(item => {
      const part = state.parts.find(candidate => candidate.id === item.partId);
      return `<div class="stock-detail-item">
        <div class="stock-detail-part"><div class="part-identity-stack">${partIdentityMarkup(part)}</div><span>${part ? `${esc(part.category)} · ${esc(dimensionLabel(part))} · ${part.quantity} received · ${storedQuantityForPart(part.id)} total at store` : 'Master part unavailable'}</span>${part?.overflowing ? '<span class="status overflowing">Overflowing</span>' : ''}</div>
        <label class="stored-quantity-editor"><span>On pallet</span><input type="number" min="1" step="1" inputmode="numeric" value="${item.quantity}" data-action="stock-edit-quantity" data-item-id="${esc(item.id)}" /></label>
        <button class="remove-item" data-action="stock-remove-item" data-item-id="${esc(item.id)}" aria-label="Remove part from stored pallet" type="button">×</button>
      </div>`;
    }).join('') : '<div class="empty-state"><strong>No parts on this pallet.</strong><span>Add the first stored part below.</span></div>';
  }

  function openStockPalletDetail(palletId) {
    renderStockPalletDetail(palletId);
    openDialog(els.stockPalletDetailDialog);
  }

  function renderPartProjectCheckboxes(selectedIds = []) {
    const selected = new Set(selectedIds);
    els.partProjectCheckboxes.innerHTML = state.projects.length
      ? state.projects.map(project => `<label class="check-row"><input type="checkbox" name="projectIds" value="${esc(project.id)}" ${selected.has(project.id) ? 'checked' : ''} /><span><strong>${esc(project.name)}</strong><small>${esc(project.location || 'No location')}</small></span></label>`).join('')
      : '<div class="checkbox-empty">No projects yet. You can save the part now and assign it later.</div>';
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
      ? `Duplicate master part: ${duplicate.code} with ${position && total ? `Part number ${position} / Total parts ${total}` : 'no Part number / Total parts'} already exists. Change the code or numbering, or edit the existing part.`
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
    els.partDialogTitle.textContent = part ? 'Edit master part' : 'Add a master part';
    updatePartDuplicateWarning();
    openDialog(els.partDialog);
  }

  function updateProjectPhotoPreview() {
    els.projectPhotoPreview.innerHTML = projectPhotoDraft
      ? `<img src="${esc(projectPhotoDraft)}" alt="Project preview" />`
      : '<span>No photo selected</span>';
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
    els.projectDialogTitle.textContent = project ? 'Edit project' : 'Create a new project';
    updateProjectPhotoPreview();
    openDialog(els.projectDialog);
  }

  function openExpandedProjectPhoto(project) {
    if (!project?.photo) return;
    els.photoDialogTitle.textContent = project.name;
    els.expandedProjectPhoto.src = project.photo;
    els.expandedProjectPhoto.alt = `${project.name} project photo`;
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
        return `<label class="check-row"><input type="checkbox" value="${esc(part.id)}" ${projectPartsDraft.has(part.id) ? 'checked' : ''} /><span><span class="part-identity-inline">${partIdentityMarkup(part)}</span><small>${esc(part.category)} · ${part.quantity} received · ${storedQuantityForPart(part.id)} at store${size !== '—' ? ` · ${esc(size)}` : ''}${assemblyLabel(part) !== '—' ? ` · ${esc(assemblyLabel(part))}` : ''}</small></span></label>`;
      }).join('')
      : `<div class="checkbox-empty">${state.parts.length ? 'No master parts match this search.' : 'No master parts yet. Add them in Inventory first.'}</div>`;
    if (!projectId) closeDialog(els.projectPartsDialog);
  }

  function openProjectPartsDialog(projectId) {
    const project = state.projects.find(candidate => candidate.id === projectId);
    if (!project) return;
    $('[name="projectId"]', els.projectPartsForm).value = projectId;
    projectPartsDraft = new Set(state.parts.filter(part => partInProject(part, projectId)).map(part => part.id));
    els.projectPartsSearch.value = '';
    els.projectPartsTitle.textContent = `Parts in ${project.name}`;
    renderProjectPartsList();
    openDialog(els.projectPartsDialog);
  }

  function openOrderItemDialog(category) {
    const order = getSelectedOrder();
    if (!order) return showToast('Create an order first.');
    const includedPartIds = new Set(order.items.map(item => item.partId));
    const matchingParts = state.parts
      .filter(part => partInProject(part, state.activeProjectId) && (part.category === category || part.category === 'Other'))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const availableParts = matchingParts.filter(part => !includedPartIds.has(part.id));
    const select = $('[name="partId"]', els.orderItemForm);
    select.innerHTML = availableParts.length
      ? availableParts.map(part => `<option value="${esc(part.id)}">${esc(part.code)} — ${esc(part.name)} (${part.quantity} shared)</option>`).join('')
      : `<option value="">${matchingParts.length ? 'All matching parts are already on this checklist' : 'No matching project parts'}</option>`;
    select.disabled = !availableParts.length;
    $('[name="category"]', els.orderItemForm).value = category;
    $('[name="quantityNeeded"]', els.orderItemForm).value = 1;
    $('button[type="submit"]', els.orderItemForm).disabled = !availableParts.length;
    if (!availableParts.length) {
      els.availabilityHint.className = 'availability-hint';
      els.availabilityHint.textContent = matchingParts.length
        ? 'Every matching part is already on this checklist. Change its needed amount directly on the checklist.'
        : 'Include a matching master part in this project first.';
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
      els.availabilityHint.textContent = 'Include a matching master part in this project first.';
      els.availabilityHint.classList.add('danger');
      return;
    }
    if (part.quantity <= 0) {
      els.availabilityHint.textContent = `Out of shared stock. You need ${needed}, but none are available.`;
      els.availabilityHint.classList.add('danger');
    } else if (part.quantity < needed) {
      els.availabilityHint.textContent = `Shortage: you need ${needed}, but only ${part.quantity} shared units are available.`;
      els.availabilityHint.classList.add('danger');
    } else if (part.quantity <= 4 || part.quantity - needed <= 4) {
      els.availabilityHint.textContent = `${part.quantity} shared units available. Packing this leaves ${part.quantity - needed}, which is low stock.`;
      els.availabilityHint.classList.add('warning');
    } else {
      els.availabilityHint.textContent = `${part.quantity} shared units available. Packing this leaves ${part.quantity - needed}.`;
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
    if (!window.confirm(`Delete “${project.name}”? Its orders will be deleted and packed quantities restored. Master parts will remain in Inventory.`)) return;
    const projectOrders = state.orders.filter(order => order.projectId === projectId);
    restorePackedStockForOrders(projectOrders);
    state.orders = state.orders.filter(order => order.projectId !== projectId);
    state.parts.forEach(part => { part.projectIds = (part.projectIds || []).filter(id => id !== projectId); });
    state.projects = state.projects.filter(item => item.id !== projectId);
    addActivity('Project deleted', `${project.name}; master parts kept`);
    ensureValidSelections();
    renderAll();
    showToast('Project deleted. Shared master parts were kept.');
  }

  function deleteOrder(orderId) {
    const order = state.orders.find(candidate => candidate.id === orderId);
    if (!order) return;
    if (!window.confirm(`Delete “${order.name}”? Packed quantities will be restored to shared inventory.`)) return;
    restorePackedStockForOrders([order]);
    state.orders = state.orders.filter(candidate => candidate.id !== orderId);
    addActivity('Assembly order deleted', order.name);
    state.selectedOrderId = null;
    renderAll();
    showToast('Order deleted and packed stock restored.');
  }

  function deletePart(partId) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    const referenced = state.orders.some(order => order.items.some(item => item.partId === partId));
    const storedReferences = state.stockPallets.reduce((count, pallet) => count + pallet.items.filter(item => item.partId === partId).length, 0);
    const message = referenced || storedReferences
      ? `Delete master part ${part.code} — ${part.name}? It will be removed from every linked project and assembly checklist${storedReferences ? `, plus ${storedReferences} stored pallet line(s)` : ''}. Packed quantities will not be restored because the master record is being deleted.`
      : `Delete master part ${part.code} — ${part.name} from every project?`;
    if (!window.confirm(message)) return;
    state.orders.forEach(order => { order.items = order.items.filter(item => item.partId !== partId); });
    state.stockPallets.forEach(pallet => { pallet.items = pallet.items.filter(item => item.partId !== partId); });
    state.parts = state.parts.filter(candidate => candidate.id !== partId);
    addActivity('Master part deleted', `${part.code} — ${part.name}`);
    renderAll();
    showToast('Master part deleted everywhere.');
  }

  function adjustPartQuantity(partId, delta) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    const next = Math.max(0, part.quantity + delta);
    if (next === part.quantity) return;
    part.quantity = next;
    addActivity('Shared stock quantity changed', `${part.code} is now ${part.quantity} in every linked project`);
    renderAll();
  }

  function togglePartOverflowing(partId) {
    const part = state.parts.find(candidate => candidate.id === partId);
    if (!part) return;
    part.overflowing = !part.overflowing;
    addActivity(part.overflowing ? 'Part marked overflowing' : 'Storage space restored', `${part.code} — ${part.name}`);
    renderAll();
    if (openStockPalletId) renderStockPalletDetail();
    showToast(part.overflowing ? 'Part marked as overflowing.' : 'Part marked as having available space.');
  }

  function updateStockPalletItemQuantity(itemId, requestedQuantity) {
    const pallet = getStockPallet(openStockPalletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const numericQuantity = Number(requestedQuantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      showToast('Stored quantity must be at least 1.');
      renderStockPalletDetail();
      return;
    }
    const nextQuantity = Math.floor(numericQuantity);
    if (nextQuantity === item.quantity) return;
    const previousQuantity = item.quantity;
    item.quantity = nextQuantity;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    addActivity('Stored pallet quantity changed', `${part?.code || 'Part'}: ${previousQuantity} → ${nextQuantity} on Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber}`);
    renderAll();
    renderStockPalletDetail();
    showToast('Stored quantity updated.');
  }

  function removeStockPalletItem(itemId) {
    const pallet = getStockPallet(openStockPalletId);
    const item = pallet?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!window.confirm(`Remove ${part?.code || 'this part'} from Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber}?`)) return;
    pallet.items = pallet.items.filter(candidate => candidate.id !== itemId);
    addActivity('Part removed from stored pallet', `${part?.code || 'Part'} from Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber}`);
    renderAll();
    renderStockPalletDetail();
    showToast('Part removed from stored pallet.');
  }

  function deleteStockPallet(palletId) {
    const pallet = getStockPallet(palletId);
    if (!pallet) return;
    if (!window.confirm(`Delete Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber} and all of its stored-part quantities?`)) return;
    state.stockPallets = state.stockPallets.filter(candidate => candidate.id !== palletId);
    addActivity('Stored pallet deleted', `Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber}`);
    openStockPalletId = null;
    closeDialog(els.stockPalletDetailDialog);
    renderAll();
    showToast('Stored pallet deleted.');
  }

  function togglePacked(itemId, shouldPack) {
    const order = getSelectedOrder();
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!part) {
      showToast('This master part no longer exists.');
      renderOrders();
      return;
    }
    if (shouldPack && !item.packed) {
      if (part.quantity < item.quantityNeeded) {
        showToast(`Not enough ${part.code}. Need ${item.quantityNeeded}; only ${part.quantity} shared units available.`);
        renderOrders();
        return;
      }
      part.quantity -= item.quantityNeeded;
      item.packed = true;
      addActivity('Part packed on pallet', `${part.code} × ${item.quantityNeeded}; shared stock updated`);
    } else if (!shouldPack && item.packed) {
      part.quantity += item.quantityNeeded;
      item.packed = false;
      addActivity('Part removed from pallet', `${part.code} × ${item.quantityNeeded} restored to shared stock`);
    }
    renderAll();
  }

  function updateOrderItemQuantity(itemId, requestedQuantity) {
    const order = getSelectedOrder();
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (!part) {
      showToast('This master part no longer exists.');
      renderOrders();
      return;
    }

    const numericQuantity = Number(requestedQuantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity < 1) {
      showToast('Needed quantity must be at least 1.');
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
      showToast(`Not enough ${part.code}. Increasing this line needs ${difference} more; only ${part.quantity} shared units are available.`);
      renderOrders();
      return;
    }
    if (item.packed) part.quantity -= difference;
    item.quantityNeeded = nextQuantity;
    addActivity('Checklist amount changed', `${part.code}: ${previousQuantity} → ${nextQuantity}${item.packed ? '; packed stock adjusted' : ''}`);
    renderAll();
    showToast(item.packed ? 'Needed amount and shared stock updated.' : 'Needed amount updated.');
  }

  function removeOrderItem(itemId) {
    const order = getSelectedOrder();
    const item = order?.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const part = state.parts.find(candidate => candidate.id === item.partId);
    if (item.packed && part) part.quantity += item.quantityNeeded;
    order.items = order.items.filter(candidate => candidate.id !== itemId);
    addActivity('Checklist item removed', part ? `${part.code} from ${order.name}` : order.name);
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
    if (!state.activeProjectId) return showToast('Create a project first.');
    els.orderForm.reset();
    openDialog(els.orderDialog);
  });

  els.projectPhotoInput.addEventListener('change', async () => {
    const file = els.projectPhotoInput.files?.[0];
    if (!file) return;
    projectPhotoBusy = true;
    els.projectPhotoPreview.innerHTML = '<span>Preparing photo…</span>';
    try {
      projectPhotoDraft = await compressImage(file);
      updateProjectPhotoPreview();
      showToast('Project photo ready.');
    } catch (error) {
      console.error(error);
      projectPhotoDraft = '';
      updateProjectPhotoPreview();
      showToast('Could not use that photo. Try a JPG or PNG.');
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
    if (projectPhotoBusy) return showToast('The photo is still being prepared.');
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
      addActivity('Project updated', project.name);
    } else {
      const project = { id: uid('project'), ...payload, createdAt: new Date().toISOString() };
      state.projects.push(project);
      state.activeProjectId = project.id;
      state.selectedOrderId = null;
      addActivity('Project created', project.name);
    }
    closeDialog(els.projectDialog);
    renderAll();
    showToast(id ? 'Project updated.' : 'Project created.');
  });

  els.partForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.partForm);
    const id = String(data.get('id') || '');
    const code = String(data.get('code') || '').trim().toUpperCase();
    const position = positiveIntegerOrBlank(data.get('assemblyPosition'));
    const total = positiveIntegerOrBlank(data.get('assemblyTotal'));
    if ((position && !total) || (!position && total)) return showToast('Enter both assembly numbers, for example 2 / 5.');
    if (position && total && position > total) return showToast('The part number cannot be higher than the total number of parts.');
    const duplicate = findDuplicateMasterPart(id, code, position, total);
    if (duplicate) {
      updatePartDuplicateWarning();
      return showToast(`Duplicate not saved: ${code} with ${position && total ? `${position}/${total}` : 'no part numbering'} already exists.`);
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
      addActivity('Master part updated', `${payload.code} — ${payload.name}`);
    } else {
      savedPart = { id: uid('part'), ...payload, projectIds: [...new Set(nextProjectIds)] };
      state.parts.push(savedPart);
      addActivity('Master part added', `${payload.code} × ${payload.quantity}`);
    }
    const returnPalletId = stockPartReturnPalletId;
    stockPartReturnPalletId = null;
    closeDialog(els.partDialog);
    renderAll();
    if (!id && returnPalletId && getStockPallet(returnPalletId)) {
      openStockItemDialog(returnPalletId, savedPart.id);
      showToast('Master part created. Now add its stored quantity to the pallet.');
      return;
    }
    showToast(removedItems ? `Part updated. ${removedItems} checklist item(s) were removed from unlinked projects.` : (id ? 'Master part updated everywhere.' : 'Master part added.'));
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
    addActivity('Project parts updated', `${project.name}: ${projectPartsDraft.size} linked master parts`);
    closeDialog(els.projectPartsDialog);
    renderAll();
    showToast(removedItems ? `Project parts saved. ${removedItems} old checklist item(s) were removed.` : 'Project parts saved.');
  });

  els.orderForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.orderForm);
    const order = { id: uid('order'), projectId: state.activeProjectId, name: String(data.get('name') || '').trim(), notes: String(data.get('notes') || '').trim(), createdAt: new Date().toISOString(), items: [] };
    if (!order.name) return;
    state.orders.push(order);
    state.selectedOrderId = order.id;
    addActivity('Assembly order created', order.name);
    closeDialog(els.orderDialog);
    renderAll();
    showToast('Assembly order created.');
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
    if (!part || !partInProject(part, state.activeProjectId)) return showToast('Choose a part included in this project.');
    if (order.items.some(item => item.partId === partId)) {
      closeDialog(els.orderItemDialog);
      renderAll();
      return showToast('That part is already on this checklist. Edit its needed amount directly on the checklist.');
    }
    order.items.push({ id: uid('item'), partId, category, quantityNeeded, packed: false });
    addActivity('Part added to assembly order', `${part.code} × ${quantityNeeded} for ${order.name}`);
    closeDialog(els.orderItemDialog);
    renderAll();
    if (part.quantity < quantityNeeded) showToast('Part added, but shared stock is insufficient.');
    else if (part.quantity <= 4 || part.quantity - quantityNeeded <= 4) showToast('Part added. Shared stock is at or near the low threshold.');
    else showToast('Part added to checklist.');
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
    if (duplicate) return showToast('That delivery and pallet number combination already exists.');

    let pallet;
    if (id) {
      pallet = getStockPallet(id);
      if (!pallet) return;
      Object.assign(pallet, { deliveryNumber, palletNumber, notes });
      addActivity('Stored pallet updated', `Delivery ${deliveryNumber}, Pallet ${palletNumber}`);
    } else {
      pallet = { id: uid('stock_pallet'), deliveryNumber, palletNumber, notes, createdAt: new Date().toISOString(), items: [] };
      state.stockPallets.push(pallet);
      addActivity('Stored pallet created', `Delivery ${deliveryNumber}, Pallet ${palletNumber}`);
    }
    openStockPalletId = pallet.id;
    closeDialog(els.stockPalletDialog);
    renderAll();
    openStockPalletDetail(pallet.id);
    showToast(id ? 'Stored pallet details updated.' : 'Stored pallet created. Add its parts next.');
  });

  els.stockPartSearch.addEventListener('input', updateStockPartMatch);
  els.stockItemForm.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(els.stockItemForm);
    const pallet = getStockPallet(String(data.get('palletId') || ''));
    const part = state.parts.find(candidate => candidate.id === String(data.get('partId') || ''));
    const quantity = Math.max(1, Math.floor(Number(data.get('quantity')) || 1));
    if (!pallet || !part) return showToast('Choose an existing master part or create it first.');
    if (pallet.items.some(item => item.partId === part.id)) return showToast('This part is already on the pallet. Edit its quantity in the pallet list.');
    pallet.items.push({ id: uid('stock_item'), partId: part.id, quantity });
    addActivity('Part added to stored pallet', `${part.code} × ${quantity}; Delivery ${pallet.deliveryNumber}, Pallet ${pallet.palletNumber}`);
    openStockPalletId = pallet.id;
    closeDialog(els.stockItemDialog);
    renderAll();
    openStockPalletDetail(pallet.id);
    showToast(part.overflowing ? 'Part added. It is currently marked as overflowing.' : 'Part added to stored pallet.');
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
      showToast(`${getProjectName(projectId)} opened.`);
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
    showToast('Backup exported.');
  });

  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    if (!file) return;
    try {
      const imported = migrateState(JSON.parse(await file.text()));
      if (!window.confirm('Import this backup and replace all current local data?')) return;
      state = imported;
      addActivity('Backup imported', file.name);
      ensureValidSelections();
      renderAll();
      showToast('Backup imported successfully.');
    } catch (error) {
      console.error(error);
      showToast('Could not import this file. Please use a valid StoreFlow backup.');
    } finally {
      els.importInput.value = '';
    }
  });

  els.resetBtn.addEventListener('click', () => {
    if (!window.confirm('Erase all StoreFlow data on this device and return to a blank workspace?')) return;
    state = createInitialState();
    renderAll();
    showToast('Local data reset.');
  });

  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:') && !location.hostname.includes('livecodes')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker unavailable:', error)));
  }

  renderAll();
  switchView(currentView);
})();
