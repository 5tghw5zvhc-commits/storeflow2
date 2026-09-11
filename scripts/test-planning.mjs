import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const data = { projects: [{id:'p1',name:'Room A',remainingOrders:3,planningOrderId:'o1'},{id:'p2',name:'Room B',remainingOrders:2,planningOrderId:'o2'}], parts:[{id:'a',code:'SHARED',name:'Shared board',category:'Desk',quantity:3,projectIds:['p1','p2'],assemblyPosition:1,assemblyTotal:1},{id:'b',code:'SHARED',name:'Shared board',category:'Desk',quantity:0,projectIds:['p2'],assemblyPosition:1,assemblyTotal:2}], orders:[{id:'o1',projectId:'p1',name:'A',items:[{id:'i1',partId:'a',quantityNeeded:2,packed:true}]},{id:'o2',projectId:'p2',name:'B',items:[{id:'i2',partId:'a',quantityNeeded:4,packed:false},{id:'i3',partId:'b',quantityNeeded:1,packed:false}]}], stockPallets:[{id:'s1',deliveryNumber:'D',palletNumber:'1',items:[{id:'s1a',partId:'a',quantity:4},{id:'s1u',pendingName:'Shared board',matchStatus:'ambiguous',candidatePartIds:['a','b'],quantity:100}]}],activeProjectId:'p1',selectedOrderId:'o1'};
const saved = new Map([['storeflow-state-v1',JSON.stringify(data)]]);
let rejectStateWrites = false;
function boot(){
 const nodes=new Map();
 const node=(key)=>{if(!nodes.has(key))nodes.set(key,{value:'',options:[],innerHTML:'',textContent:'',dataset:{},style:{},listeners:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},addEventListener(e,fn){this.listeners[e]=fn},setAttribute(){},removeAttribute(){},hasAttribute(){return false},querySelector:s=>node(key+' '+s),querySelectorAll:()=>[],contains:()=>false,closest(){return this}});return nodes.get(key)};
 const document={querySelector:node,querySelectorAll:()=>[],addEventListener(){},documentElement:node('html'),body:node('body')};
 const c={FormData:class { constructor(form){this.data=form.formData||{}} get(key){return this.data[key]??null} getAll(key){return [this.data[key]].filter(v=>v!=null)} },console,document,navigator:{},location:{protocol:'file:',hostname:''},Intl,Date,Math,JSON,Map,Set,structuredClone,setTimeout:()=>0,clearTimeout(){},localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>{if(rejectStateWrites && k==='storeflow-state-v1') throw new Error('Simulated full storage');saved.set(k,v)},removeItem:k=>saved.delete(k)},innerWidth:390,confirm:()=>true,addEventListener(){}};
 c.window=c;c.globalThis=c;vm.createContext(c);vm.runInContext(fs.readFileSync('src/i18n.js','utf8'),c);
 let app=fs.readFileSync('src/app.js','utf8');app=app.replace('  renderAll();\n  switchView(currentView);\n})();','  globalThis.testApi = { getState: () => state, calculateManufacturingPlan, renderAll, renderPlanning, migrateState, sendOrder, undoLatestChange, saveState };\n  renderAll();\n  switchView(currentView);\n})();');vm.runInContext(app,c);
 return {api:c.testApi,nodes};
}
let {api,nodes}=boot();
let plan=api.calculateManufacturingPlan(api.getState());
assert.equal(plan.rows[0].required,14);assert.equal(plan.rows[0].packed,2);assert.equal(plan.rows[0].shortage,5);assert.equal(plan.rows[1].shortage,2);assert.equal(plan.unresolved,100);assert.equal(plan.issues.length,0);
assert.match(nodes.get('#planningResults').innerHTML,/Shared board/);
// Column order and actual order-edit handlers must refresh the planning markup.
assert.match(nodes.get('#planningResults').innerHTML, /<th scope="col">Part \/ pack<\/th><th scope="col">To manufacture<\/th>/);
assert.match(nodes.get('#planningResults').innerHTML, /<td><strong>5<\/strong><\/td><td>2<\/td><td>3<\/td><td>4<\/td><td>14<\/td>/);
api.getState().activeProjectId='p2';api.getState().selectedOrderId='o2';api.renderAll();
const quantityInput={dataset:{itemId:'i2'},value:'7',closest(selector){return selector.includes('edit-needed')?this:null}};
nodes.get('#orderBoards').listeners.change({target:quantityInput});
assert.equal(api.calculateManufacturingPlan(api.getState()).rows[0].required,20);
assert.match(nodes.get('#planningResults').innerHTML, /<td><strong>11<\/strong><\/td><td>2<\/td><td>3<\/td><td>4<\/td><td>20<\/td>/);
({api,nodes}=boot());assert.equal(api.calculateManufacturingPlan(api.getState()).rows[0].required,20);
api.undoLatestChange();assert.equal(api.calculateManufacturingPlan(api.getState()).rows[0].required,14);
const removeButton={dataset:{action:'remove-order-item',itemId:'i3'},closest(){return this}};
nodes.get('#orderBoards').listeners.click({target:removeButton});
assert.equal(api.calculateManufacturingPlan(api.getState()).rows.length,1);
assert.match(nodes.get('#planningWarnings').innerHTML,/absent from the template/);
api.undoLatestChange();assert.equal(api.calculateManufacturingPlan(api.getState()).rows.length,2);
api.getState().activeProjectId='p1';api.getState().selectedOrderId='o1';api.renderAll();
quantityInput.dataset.itemId='i1';quantityInput.value='3';
nodes.get('#orderBoards').listeners.change({target:quantityInput});
assert.match(nodes.get('#planningResults').innerHTML, /<td><strong>8<\/strong><\/td><td>3<\/td><td>2<\/td><td>4<\/td><td>17<\/td>/);
api.undoLatestChange();assert.equal(api.calculateManufacturingPlan(api.getState()).rows[0].shortage,5);
// Actual change handler, then persisted reload and undo.
const input={dataset:{planProject:'p1',planField:'remainingOrders'},value:'4',closest(){return this}};
nodes.get('#planningProjects').listeners.change({target:input});assert.equal(api.getState().projects[0].remainingOrders,4);
({api,nodes}=boot());assert.equal(api.getState().projects[0].remainingOrders,4);api.undoLatestChange();assert.equal(api.getState().projects[0].remainingOrders,3);
api.sendOrder();assert.equal(api.getState().projects[0].remainingOrders,2);assert.equal(api.getState().parts[0].quantity,3);assert.notEqual(api.getState().projects[0].planningOrderId,'o1');assert.equal(api.calculateManufacturingPlan(api.getState()).rows[0].shortage,5);
api.undoLatestChange();assert.equal(api.getState().projects[0].remainingOrders,3);assert.equal(api.getState().projects[0].planningOrderId,'o1');
for(const language of ['en','uk','ru','pl']){api.getState().language=language;api.renderPlanning();assert.ok(!nodes.get('#planningResults').innerHTML.includes('planning.'));}
const missing=structuredClone(api.getState());missing.projects[0].planningOrderId='gone';assert.ok(api.calculateManufacturingPlan(missing).issues.some(i=>i.key==='planning.noTemplate'));
missing.projects[0].planningOrderId='o1';missing.orders[1].items.pop();assert.ok(api.calculateManufacturingPlan(missing).issues.some(i=>i.key==='planning.omitted'));
const zero=structuredClone(api.getState());zero.projects.forEach(p=>p.remainingOrders=0);assert.equal(api.calculateManufacturingPlan(zero).rows.length,0);
const sent=structuredClone(api.getState());sent.orders[0].sentAt='2026-08-05';assert.equal(api.calculateManufacturingPlan(sent).rows[0].packed,0);
console.log('Planning tests passed: shared stock, pack identity, unresolved stock, rendering, persistence, undo, Send Order, missing templates, zero demand and four languages.');

// Every dependent ledger refreshes the existing table without navigating to Planning.
saved.clear();saved.set('storeflow-state-v1',JSON.stringify(data));({api,nodes}=boot());
const sharedShortage = () => {
 const html=nodes.get('#planningResults').innerHTML;
 const row=html.match(/<tr[^>]*><td>[\s\S]*?Shared board[\s\S]*?<small>1\/1 ·[\s\S]*?<td><strong>(\d+)<\/strong><\/td>/);
 assert.ok(row, 'Shared part row must be present');return Number(row[1]);
};
assert.equal(sharedShortage(),5);
const inventoryPlus={dataset:{action:'plus',id:'a'},closest(){return this}};
nodes.get('#inventoryCards').listeners.click({target:inventoryPlus});assert.equal(sharedShortage(),4);
const stockQuantity={dataset:{palletId:'s1',itemId:'s1a'},value:'6',closest(){return this}};
nodes.get('#stockPalletGrid').listeners.change({target:stockQuantity});assert.equal(sharedShortage(),2);
const submit=(id,fields)=>{const form=nodes.get(id);form.formData=fields;form.listeners.submit({preventDefault(){}})};
submit('#stockPalletForm',{deliveryNumber:'NEW',palletNumber:'2'});
const newPallet=api.getState().stockPallets.find(p=>p.deliveryNumber==='NEW');assert.ok(newPallet);
nodes.get('#stockPartSearch').value='SHARED';
submit('#stockItemForm',{palletId:newPallet.id,partId:'a',packCode:'11',quantity:'2'});assert.equal(sharedShortage(),0);
// A new order can replace the old template without copying a stale parts list.
submit('#orderForm',{name:'Replacement'});
const replacementId=api.getState().selectedOrderId;
submit('#orderItemForm',{partId:'a',quantityNeeded:'5',category:'Desk'});
const templateSelect={dataset:{planProject:'p1',planField:'planningOrderId'},value:replacementId,closest(){return this}};
nodes.get('#planningProjects').listeners.change({target:templateSelect});
assert.equal(sharedShortage(),11); // 3*5 + 2*4 - 4 inventory - 8 on pallets
const replacementItem=api.getState().orders.find(o=>o.id===replacementId).items[0];
const neededInput={dataset:{itemId:replacementItem.id},value:'6',closest(selector){return selector.includes('edit-needed')?this:null}};
nodes.get('#orderBoards').listeners.change({target:neededInput});assert.equal(sharedShortage(),14);
// Even a save without renderAll refreshes the derived table.
api.getState().parts.find(p=>p.id==='a').quantity+=2;api.saveState();assert.equal(sharedShortage(),12);
({api,nodes}=boot());assert.equal(sharedShortage(),12);
console.log('Live dependency tests passed: Inventory, pallet quantity, new pallet and contents, replacement template, per-order quantities, save-only refresh and reload.');

// Stocktake reset: independent durable undo survives history expiry and reload.
saved.clear();saved.set('storeflow-state-v1',JSON.stringify(data));({api,nodes}=boot());
const palletBefore=JSON.stringify(api.getState().stockPallets), ordersBefore=JSON.stringify(api.getState().orders);
nodes.get('#zeroInventoryBtn').listeners.click();
assert.ok(api.getState().parts.every(p=>p.quantity===0));
assert.equal(JSON.stringify(api.getState().stockPallets),palletBefore);assert.equal(JSON.stringify(api.getState().orders),ordersBefore);
assert.equal(sharedShortage(),8);
const resetId=api.getState().stocktakeResets[0].id;
for(let i=0;i<25;i++) nodes.get('#inventoryCards').listeners.click({target:inventoryPlus});
assert.equal(JSON.parse(saved.get('storeflow-undo-v1')).length,20);
({api,nodes}=boot());assert.match(nodes.get('#stocktakeRestores').innerHTML,new RegExp(resetId));
const restoreButton={dataset:{restoreStocktake:resetId},closest(){return this}};
nodes.get('#stocktakeRestores').listeners.click({target:restoreButton});assert.equal(api.getState().parts[0].quantity,28);
nodes.get('#stocktakeRestores').listeners.click({target:restoreButton});assert.equal(api.getState().parts[0].quantity,28);
api.undoLatestChange();assert.equal(api.getState().parts[0].quantity,25);assert.equal(api.getState().stocktakeResets[0].restoredAt,'');
nodes.get('#zeroInventoryBtn').listeners.click();assert.equal(api.getState().stocktakeResets.length,2);
api.undoLatestChange();assert.equal(api.getState().parts[0].quantity,25);assert.equal(api.getState().stocktakeResets.length,1);
const exported=JSON.stringify(api.getState());assert.equal(api.migrateState(JSON.parse(exported)).stocktakeResets[0].id,resetId);
rejectStateWrites=true;nodes.get('#zeroInventoryBtn').listeners.click();rejectStateWrites=false;
assert.equal(JSON.stringify(api.getState()),exported);assert.equal(saved.get('storeflow-state-v1'),exported);
console.log('Stocktake tests passed: zero all Inventory, untouched pallets/orders, planning refresh, restore after 25 changes/reload, repeat-restore protection, multiple resets, undo restore, backup migration and storage-failure rollback.');

// Unload is a transfer; Delete is a discard. Exercise the actual card actions.
saved.clear();saved.set('storeflow-state-v1',JSON.stringify(data));({api,nodes}=boot());
const unloadButton={dataset:{stockAction:'unload',palletId:'s1'},closest(){return this}};
const unload=()=>nodes.get('#stockPalletGrid').listeners.click({target:unloadButton});
const initial=JSON.stringify(api.getState());unload();assert.equal(JSON.stringify(api.getState()),initial); // unresolved line blocks entire pallet
api.getState().stockPallets[0].items.pop();
api.getState().stockPallets[0].items.push({id:'second',partId:'b',packCode:'12',quantity:2});api.renderAll();
assert.match(nodes.get('#stockPalletGrid').innerHTML,/data-stock-action="unload"/);
const beforeShort=api.calculateManufacturingPlan(api.getState()).rows.reduce((sum,r)=>sum+r.shortage,0);
const beforeUnload=JSON.stringify(api.getState());rejectStateWrites=true;unload();rejectStateWrites=false;assert.equal(JSON.stringify(api.getState()),beforeUnload);
unload();assert.equal(api.getState().parts[0].quantity,7);assert.equal(api.getState().parts[1].quantity,2);assert.equal(api.getState().stockPallets.length,0);
assert.equal(api.calculateManufacturingPlan(api.getState()).rows.reduce((sum,r)=>sum+r.shortage,0),beforeShort);
unload();assert.equal(api.getState().parts[0].quantity,7); // cannot unload twice
({api,nodes}=boot());api.undoLatestChange();assert.equal(api.getState().parts[0].quantity,3);assert.equal(api.getState().parts[1].quantity,0);assert.equal(api.getState().stockPallets[0].items.length,2);
const deleteButton={dataset:{stockAction:'delete',palletId:'s1'},closest(){return this}};
nodes.get('#stockPalletGrid').listeners.click({target:deleteButton});assert.equal(api.getState().parts[0].quantity,3);assert.equal(api.getState().stockPallets.length,0);
console.log('Unload tests passed: multi-part receipt, unresolved blocking, atomic save rollback, conservation of available stock, duplicate prevention, reload/Undo and separate discard behavior.');
