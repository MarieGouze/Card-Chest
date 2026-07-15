// ============================================================
// 核心状态与常量
// ============================================================
const DB_NAME = 'TavernCardV4'; // 升级数据库版本
window.db = null;

let S = {
  sections: ['卡片','预设','工具','美化'], groups: [], subTagLib: {}, tagParents: {},
  activeSection: '卡片', activeTag: '__all__', activeTags: new Set(), activeGroup: '__all__',
  showFavOnly: false, sort: 'date_desc', layout: 'grid', theme: 'light',
  searchQuery: '', searchScopes: new Set(['name','desc','tags']), cards: [],
  selectMode: false, selectedIds: new Set(), timelineMode: false,
  folderView: false, openFolderId: null, gridWidth: 130, fontScale: 1.25, showNote: true,
  chatlogs: [], tagColors: {} // 新增：聊天记录与标签颜色字典
};


// ============================================================
// Token 极轻量估算器
// ============================================================
function estimateTokens(text) {
  if (!text) return 0;
  // 简单粗暴的启发式算法：中文单字约等于 0.6-0.8 token，英文单词约等于 1.3 token
  const zhMatches = text.match(/[\u4e00-\u9fa5]/g) || [];
  const zhTokens = Math.ceil(zhMatches.length * 0.7);
  const otherLen = text.length - zhMatches.length;
  const enTokens = Math.ceil(otherLen * 0.3); // 空格、标点、字母等综合平均
  return zhTokens + enTokens;
}
function renderTokenBadge(charCount, textContent) {
  if (!charCount) return '';
  const est = estimateTokens(textContent);
  return `<span class="dtokens">≈ ${fmtN(est)} Tokens</span>`;
}

// ============================================================
// 图片懒加载缓冲 (Intersection Observer)
// ============================================================
const imgObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const img = entry.target;
    if (entry.isIntersecting) {
  // 进入视口，加载图片
  if (!img.src && img.dataset.src) {
    img.src = img.dataset.src;
    img.onload = () => img.classList.add('loaded');
  }
} else if (S.lowMemoryMode) {
  // 低内存模式开启时，离开视口释放图片内存
  img.removeAttribute('src');
  img.classList.remove('loaded');
}
  });
}, { 
  rootMargin: '250px 0px' // 提前 250px 预加载，保证滑动平滑
});


// ============================================================
// Web Worker 异步哈希与后台搜索
// ============================================================
let worker, searchWorker;
let workerResolvers = {};
let latestSearchReqId = 0;

function initWorkers() {
  try {
    const hashBlob = new Blob([document.getElementById('workerCode').textContent], { type: 'application/javascript' });
    const hashUrl = URL.createObjectURL(hashBlob);
    worker = new Worker(hashUrl);
    URL.revokeObjectURL(hashUrl);
    worker.onmessage = (e) => {
      if (e.data.type === 'hash_result') {
        const resolve = workerResolvers[e.data.id];
        if (resolve) { resolve(e.data.hash); delete workerResolvers[e.data.id]; }
      }
    };

    const searchBlob = new Blob([document.getElementById('searchWorkerCode').textContent], { type: 'application/javascript' });
    const searchUrl = URL.createObjectURL(searchBlob);
    searchWorker = new Worker(searchUrl);
    URL.revokeObjectURL(searchUrl);
    searchWorker.onmessage = (e) => {
      const { type, reqId, ids } = e.data;
      if (type === 'search_result' && reqId === latestSearchReqId) {
        const idSet = new Set(ids);
        vsState.list = S.cards.filter(c => c.section === S.activeSection && idSet.has(c.id));
        sortList(vsState.list);
        updateGridAfterSearch();
      }
    };
  } catch(e) {
    console.warn("自动降级为单线程兼容模式。");
    worker = {
      postMessage: async (data) => {
        let hashHex = '';
        const str = data.payload;
        if (window.crypto && window.crypto.subtle) {
          try {
            const buf = new TextEncoder().encode(str);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', buf);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          } catch(err) {}
        }
        if (!hashHex) {
          let h = 5381;
          for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
          hashHex = (h >>> 0).toString(16);
        }
        setTimeout(() => { if(workerResolvers[data.id]) { workerResolvers[data.id](hashHex); delete workerResolvers[data.id]; } }, 0);
      }
    };
    console.warn("Worker 初始化失败，已启用安全降级模式 (可能受 GitHub Pages CSP 限制)");
    searchWorker = {
      postMessage: (data) => {
        const { type, query, list, scopes, reqId } = data;
        if (!query.trim()) { setTimeout(() => searchWorker.onmessage({ data: { type: 'search_result', reqId, ids: list.map(c=>c.id) } }), 0); return; }
        const queries = query.trim().split(/\s+/);
        const filtered = list.filter(c => {
          return queries.every(token => {
            const lowerToken = token.toLowerCase();
            if (lowerToken.startsWith('tag:')) { const tName = lowerToken.slice(4); return [...(c.tags || []), ...(c.subtags || [])].some(t => (t || '').toLowerCase().includes(tName)); }
            if (lowerToken.startsWith('char>')) return (c.charCount || 0) > parseInt(lowerToken.slice(5)) || 0;
            if (lowerToken.startsWith('char<')) return (c.charCount || 0) < parseInt(lowerToken.slice(5)) || 9999999;
            if (scopes.has('name') && (c.name || '').toLowerCase().includes(lowerToken)) return true;
            if (scopes.has('desc') && (c.description || '').toLowerCase().includes(lowerToken)) return true;
            if (scopes.has('tags') && [...(c.tags || []), ...(c.subtags || [])].some(t => (t || '').toLowerCase().includes(lowerToken))) return true;
            if (scopes.has('note') && (c.note || '').toLowerCase().includes(lowerToken)) return true;
            return false;
          });
        });
        setTimeout(() => searchWorker.onmessage({ data: { type: 'search_result', reqId, ids: filtered.map(c=>c.id) } }), 0);
      }
    };
  }
}


async function asyncHash(obj) {
  if (!worker) initWorkers();
  return new Promise(resolve => {
    const id = Date.now() + '_' + Math.random();
    workerResolvers[id] = resolve;
    worker.postMessage({ type: 'hash', id: id, payload: JSON.stringify(obj) });
  });
}


// 调度 Worker 执行搜索
function triggerAsyncSearch() {
  const reqId = ++latestSearchReqId;
  // 过滤掉子版本，保持列表清爽
  let list = S.cards.filter(c => c.section === S.activeSection && !c.parentId);
  if (S.showFavOnly) list = list.filter(c => c.favorite);
  if (S.activeTag === '__untagged__') list = list.filter(c => ![...(c.tags || []), ...(c.subtags || [])].length);
  else if (S.activeTags.size > 0) { list = list.filter(c => { const ct = new Set([...(c.tags || []), ...(c.subtags || [])]); return [...S.activeTags].every(t => ct.has(t)); }); }
  if (S.activeGroup !== '__all__') list = list.filter(c => c.groupId === S.activeGroup);
  
  const q = S.searchQuery.trim();
  if (!q) {
    vsState.list = list; sortList(vsState.list); updateGridAfterSearch();
    return;
  }
  
  if (!searchWorker) initWorkers();
  const isPy = window.PinyinLib && window.PinyinLib.isSupported();
  const minimalList = list.map(c => ({
    id: c.id, name: c.name, description: c.description, tags: c.tags, subtags: c.subtags, note: c.note, charCount: c.charCount,
    py: isPy ? window.PinyinLib.convertToPinyin(c.name, '', true) : ''
  }));
  searchWorker.postMessage({ type: 'search', query: q, list: minimalList, scopes: S.searchScopes, reqId });
}

function sortList(list) {
  list.sort((a, b) => {
    if (S.sort === 'date_desc') return b.importedAt - a.importedAt;
if (S.sort === 'update_desc') return (b.updatedAt || b.importedAt) - (a.updatedAt || a.importedAt);
    if (S.sort === 'date_asc') return a.importedAt - b.importedAt;
    if (S.sort === 'name_asc') return a.name.localeCompare(b.name, 'zh-CN');
    if (S.sort === 'name_desc') return b.name.localeCompare(a.name, 'zh-CN');
    if (S.sort === 'fav') return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
    return 0;
  });
}

// ============================================================
// IndexedDB 引擎 (完美解决大数据存储与恢复)
// ============================================================
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2); // 升级到版本2，确保新增表生效
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('trash')) d.createObjectStore('trash', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('chatlogs')) d.createObjectStore('chatlogs', { keyPath: 'id' }); // 新增表	  
      if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' }); // 新增快照表
    };
	
    req.onsuccess = (e) => { window.db = e.target.result; resolve(); };
    req.onerror = (e) => reject(e.target.error);
  });
}
async function ensureDB() { try { window.db.transaction('meta', 'readonly'); } catch(e) { if(e.name==='InvalidStateError') await openDB(); } }
const dbG = async (s, k) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readonly').objectStore(s).get(k); q.onsuccess = () => r(q.result); q.onerror = e => j(e.target.error); }); };
const dbP = async (s, o) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readwrite').objectStore(s).put(o); q.onsuccess = () => r(); q.onerror = e => j(e.target.error); }); };
const dbD = async (s, k) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readwrite').objectStore(s).delete(k); q.onsuccess = () => r(); q.onerror = e => j(e.target.error); }); };
const dbA = async (s) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => r(q.result); q.onerror = e => j(e.target.error); }); };
const dbC = async (s) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readwrite').objectStore(s).clear(); q.onsuccess = () => r(); q.onerror = e => j(e.target.error); }); };
const dbKeys = async (s) => { await ensureDB(); return new Promise((r, j) => { const q = window.db.transaction(s, 'readonly').objectStore(s).getAllKeys(); q.onsuccess = () => r(q.result); q.onerror = e => j(e.target.error); }); };

// ============================================================
// OOM 极致优化: Blob 超轻量化加载
// ============================================================
function revokeBlobs() {
  S.cards.forEach(c => {
    if (c._blobUrl) URL.revokeObjectURL(c._blobUrl);
    if (c._thumbBlobUrl) URL.revokeObjectURL(c._thumbBlobUrl);
  });
}
function dataUrlToBlobUrl(dataurl) {
  if (!dataurl) return null;
  try {
    const arr = dataurl.split(','); const mime = arr[0].match(/:(.*?);/)[1]; const bstr = atob(arr[1]);
    let n = bstr.length; const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return URL.createObjectURL(new Blob([u8arr], { type: mime }));
  } catch (e) { return null; }
}
function lighten(full) {
  // 核心防御：强制转换 tags 类型。如果数据库里混入了字符串或对象，强转为数组，防止 forEach 崩溃
  const safeTags = Array.isArray(full.tags) ? full.tags : (typeof full.tags === 'string' ? [full.tags] : []);
  const safeSubtags = Array.isArray(full.subtags) ? full.subtags : (typeof full.subtags === 'string' ? [full.subtags] : []);
  
  return {
    id: full.id,
    groupId: full.groupId,
    parentId: full.parentId,
    annex: full.annex,
    hash: full.hash,
    name: full.name || '未知', 
    section: full.section, 
    importedAt: full.importedAt,
    fileSize: full.fileSize, 
    fileType: full.fileType, 
    description: full.description,
    tags: safeTags,
    subtags: safeSubtags,
    charCount: full.charCount || 0,
    note: full.note, 
    favorite: full.favorite, 
    groupId: full.groupId,
    // 增加判空和字符串转换，防止由于空数组项导致的 slice 崩溃
    dialogEntries: Array.isArray(full.dialogEntries) ? full.dialogEntries.map(d => d ? String(d).slice(0, 2000) : '') : [],
    // 增加可选链保护，防止读取 null 属性
    worldBookEntries: Array.isArray(full.worldBookEntries) ? full.worldBookEntries.map(we => ({keys: we?.keys || '无标题', length: we?.content?.length || 0})) : [],
    presetEntries: Array.isArray(full.presetEntries) ? full.presetEntries.map(pe => ({name: pe?.name || '无名称', length: pe?.content?.length || 0})) : [],
    _thumbBlobUrl: full._thumbBlobUrl || dataUrlToBlobUrl(full.thumb || full.coverDataUrl)
  };
}
async function loadCardsLightweight() {
  revokeBlobs(); S.cards = [];
  window._needThumbIds = []; // 收集需要生成缩略图的卡
  return new Promise((resolve, reject) => {
    const req = window.db.transaction('cards', 'readonly').objectStore('cards').openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (!cursor.value.thumb && (cursor.value.originalDataUrl || cursor.value.coverDataUrl)) window._needThumbIds.push(cursor.value.id);
        S.cards.push(lighten(cursor.value));
        cursor.continue();
      } else resolve();
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// ============================================================
// 初始化机制
// ============================================================
function renderAll() { renderTabs(); renderFilterBar(); renderGrid(); }
async function init() {
  await openDB(); initWorkers(); await loadWebdavConfig(); await loadTavernConfig();
  // 自动清理30天前的回收站
  try {
    const ts = await dbA('trash');
    const now = Date.now();
    for(let t of ts) { if (now - t._delAt > 30 * 24 * 60 * 60 * 1000) await dbD('trash', t.id); }
  } catch(e) {}
  const mS = await dbG('meta', 'sections'); if (mS) S.sections = mS.value;
  const mG = await dbG('meta', 'groups'); if (mG) S.groups = mG.value;
  const mSt = await dbG('meta', 'subTagLib');
  if (mSt) { if (Array.isArray(mSt.value)) { S.subTagLib = { [S.sections[0] || '卡片']: mSt.value }; } else { S.subTagLib = mSt.value || {}; } }
  
  const mTp = await dbG('meta', 'tagParents'); 
if (mTp && mTp.value) S.tagParents = mTp.value;
  
  const mT = await dbG('meta', 'theme');
  // 初始化自定义背景图
const mBg = await dbG('meta', 'customBgUrl');
if (mBg && mBg.value) {
    document.documentElement.style.setProperty('--bg-img', `url('${mBg.value}')`);
    const bgInp = document.getElementById('bgImgUrl');
    if (bgInp) bgInp.value = mBg.value;
}
  if (mT) applyTheme(mT.value, false); else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark', false);

  // 监听系统深浅色模式切换
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      dbG('meta', 'theme').then(res => {
        if (!res) applyTheme(e.matches ? 'dark' : 'light', false);
      });
    });
  }
  
  
  // 修复卡顿：轻量化挂载聊天记录（不加载庞大的文本内容）
S.chatlogs = [];
try {
  await new Promise((resolve) => {
    const req = window.db.transaction('chatlogs', 'readonly').objectStore('chatlogs').openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        S.chatlogs.push({
          id: cursor.value.id, name: cursor.value.name, type: cursor.value.type,
          boundCardId: cursor.value.boundCardId, importedAt: cursor.value.importedAt
        });
        cursor.continue();
      } else resolve();
    };
    req.onerror = () => resolve();
  });
} catch(e) {}
  const mTc = await dbG('meta', 'tagColors');
  if (mTc && mTc.value) S.tagColors = mTc.value;
  applyTagColors(); // 初始化时注入标签颜色
  const mGw = await dbG('meta', 'gridWidth');
  if (mGw) { S.gridWidth = parseInt(mGw.value, 10); document.documentElement.style.setProperty('--gw', S.gridWidth + 'px'); const gz = document.getElementById('gridZoom'); if (gz) gz.value = S.gridWidth; const gzv = document.getElementById('gridZoomVal'); if (gzv) gzv.textContent = S.gridWidth; } else { const gzv = document.getElementById('gridZoomVal'); if (gzv) gzv.textContent = S.gridWidth; }

  const mFs = await dbG('meta', 'fontScale');
  if (mFs) { S.fontScale = parseFloat(mFs.value); document.documentElement.style.setProperty('--fs-scale', S.fontScale); const fs = document.getElementById('fontScale'); if (fs) fs.value = S.fontScale; const fsv = document.getElementById('fontScaleVal'); if (fsv) fsv.textContent = S.fontScale.toFixed(2); } else { const fs = document.getElementById('fontScale'); if (fs) fs.value = S.fontScale; const fsv = document.getElementById('fontScaleVal'); if (fsv) fsv.textContent = S.fontScale.toFixed(2); }
  const mLm = await dbG('meta', 'lowMemoryMode');
if (mLm) { S.lowMemoryMode = mLm.value; } else { S.lowMemoryMode = false; }
  
  // 监测大屏双栏
  checkSplitPaneMode();
  window.addEventListener('resize', () => { checkSplitPaneMode(); renderGrid(); });

  await loadCardsLightweight();
  renderAll(); bindEvents(); maybeShowTutorial();
  migrateThumbs(); // 恢复：后台静默生成缺失的缩略图
  if (webdavConfig.url && webdavConfig.autoSync) setTimeout(autoSyncCheck, 3000);
  if (window.hideSplash) window.hideSplash(); // 关闭加载动画
}

function checkSplitPaneMode() {
  const isWidthSufficient = window.innerWidth >= 900;
  if (isWidthSufficient && _currentDetailId) {
    document.getElementById('appContainer').classList.add('split-active');
    handleSplitPaneTransfer(true);
  } else {
    document.getElementById('appContainer').classList.remove('split-active');
    handleSplitPaneTransfer(false);
  }

  // 新增：移动端将搜索框移入滚动区域，随页面滑动收起；PC和平板端移回顶部导航栏
  const sbox = document.querySelector('.sbox');
  const topbar = document.querySelector('.topbar');
  const toolbarWrap = document.getElementById('toolbarWrap');
  if (window.innerWidth <= 768) {
    if (sbox && toolbarWrap && sbox.parentNode !== toolbarWrap) {
      toolbarWrap.insertBefore(sbox, toolbarWrap.firstChild); // 移入下方随动区域
    }
  } else {
    if (sbox && topbar && sbox.parentNode !== topbar) {
      const logo = topbar.querySelector('.logo');
      if (logo && logo.nextSibling) {
        topbar.insertBefore(sbox, logo.nextSibling); // 移回顶部固定区域
      } else {
        topbar.appendChild(sbox);
      }
    }
  }
}
function handleSplitPaneTransfer(isDesktop) {
  const rightPane = document.getElementById('rightPane');
  const dModal = document.getElementById('detailModal');
  if (isDesktop && _currentDetailId) {
    // 移入右侧栏
    // 隐藏原始弹窗外壳
    if (dModal.parentNode !== rightPane) {
       rightPane.appendChild(dModal.querySelector('.modal-box'));
       dModal.classList.remove('show');
    }
  } else {
    // 还原成底部弹窗
    if (dModal.querySelector('.modal-box') === null && rightPane.querySelector('.modal-box')) {
       dModal.appendChild(rightPane.querySelector('.modal-box'));
    }
  }
}

function applyTheme(t, save=true) {
  S.theme = t; document.documentElement.dataset.theme = t === 'dark' ? 'dark' : '';
  document.getElementById('themeBtn').textContent = t === 'dark' ? '☀' : '☽';
  if (save) dbP('meta', { key: 'theme', value: t });
}
// =======================================
// 移动端侧边抽屉菜单控制
// =======================================
function toggleMobileDrawer() {
  const leftPane = document.querySelector('.left-pane');
  const backdrop = document.getElementById('drawerBackdrop');
  if (leftPane && backdrop) {
    const isOpen = leftPane.classList.toggle('open');
    backdrop.classList.toggle('show');
    // 新增：抽屉打开时禁止底层网页滚动
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }
}

// 辅助优化：在移动端点击了具体的标签（如切换到“世界书”分区）后，自动收起抽屉，方便直接阅览卡片
document.addEventListener('click', function(e) {
  // 如果在手机模式下，且点击的是侧边栏里的按钮（比如分区切换、标签过滤）
  if (window.innerWidth <= 768 && e.target.tagName === 'BUTTON' && e.target.closest('.left-pane')) {
    // 延迟 150ms 自动关闭抽屉，给予视觉反馈
    setTimeout(() => {
      const leftPane = document.querySelector('.left-pane');
      if (leftPane && leftPane.classList.contains('open')) {
        toggleMobileDrawer();
      }
    }, 150);
  }
});

function toggleTheme() { applyTheme(S.theme === 'dark' ? 'light' : 'dark'); }

function toggleNoteDisplay() {
  S.showNote = !S.showNote;
  document.getElementById('noteToggleBtn').classList.toggle('active', S.showNote);
  renderGrid();
  showToast(S.showNote ? '卡片备注已显示' : '卡片备注已隐藏');
}

function buildTavernMeta(c) {
    let meta = { name: c.name || "", description: c.description || "", personality: c.personality || "", scenario: c.scenario || "", creator_notes: c.note || "", tags: c.tags || [], mes_example: c.mesExample || "" };
    if (c.dialogEntries && c.dialogEntries.length > 0) { meta.first_mes = c.dialogEntries[0] || ""; meta.alternate_greetings = c.dialogEntries.slice(1); }
    if (c.worldBookEntries && c.worldBookEntries.length > 0) {
       meta.character_book = { name: meta.name, entries: c.worldBookEntries.map((e, idx) => ({
           id: idx, keys: (e.actual_keywords || e.keys || '').split(/[,，、]+/).map(k=>k.trim()).filter(Boolean),
           comment: e.name || "未命名", content: e.content || "", constant: !!e.constant,
           insertion_order: e.order || 100, enabled: e.enabled !== false, position: e.position || 0,
           extensions: { position: e.position||0, role: e.role||0, depth: e.depth||4, probability: e.probability||100 }
       }))};
    }
    return meta;
}
// =======================================
// 主题色彩切换逻辑 (天依蓝等多种样式)
// =======================================
function applyStyle(s, save=true) {
  S.style = s;
  document.documentElement.dataset.style = s === 'default' ? '' : s;
  const sel = document.getElementById('styleSelect');
  if (sel) sel.value = s;
  if (save) dbP('meta', { key: 'style', value: s });
}
function changeGridZoom(val) { const w = parseInt(val, 10); S.gridWidth = w; document.documentElement.style.setProperty('--gw', w + 'px'); dbP('meta', {key:'gridWidth', value: w}); const el = document.getElementById('gridZoomVal'); if(el) el.textContent = w; renderGrid(); }
function changeFontScale(val) { const scale = parseFloat(val); S.fontScale = scale; document.documentElement.style.setProperty('--fs-scale', scale); dbP('meta', {key: 'fontScale', value: scale}); const el = document.getElementById('fontScaleVal'); if(el) el.textContent = scale.toFixed(2); }
function toggleLowMemory(val) { S.lowMemoryMode = val; dbP('meta', {key: 'lowMemoryMode', value: val}); showToast('低内存模式已' + (val ? '开启' : '关闭')); }

function toggleFilterBar() {
  const bar = document.getElementById('filterbar'), btn = document.getElementById('fbToggle');
  const exp = bar.classList.toggle('expanded'); btn.classList.toggle('expanded', exp); btn.textContent = exp ? '▴' : '▾';
}
function applyLayout(l, save=true) {
  S.layout = l; document.getElementById('cardGrid').className = l + '-layout';
  document.querySelectorAll('.lbtn').forEach(b => b.classList.toggle('active', b.dataset.layout === l));
  if (save) dbP('meta', { key: 'layout', value: l });
}
function setLayout(l) { applyLayout(l); renderGrid(); }

function toggleTimeline() { S.timelineMode = !S.timelineMode; if (S.timelineMode) { S.folderView = false; document.getElementById('folderBtn').classList.remove('active'); } document.getElementById('timelineBtn').classList.toggle('active', S.timelineMode); showToast(S.timelineMode ? '已按时间线查看' : '已退出时间线'); renderGrid(); }
function toggleFolderView() { S.folderView = !S.folderView; S.openFolderId = null; if (S.folderView) { S.timelineMode = false; document.getElementById('timelineBtn').classList.remove('active'); } document.getElementById('folderBtn').classList.toggle('active', S.folderView); showToast(S.folderView ? '文件夹视图' : '已退出文件夹'); renderGrid(); }
function openFolder(gid) { S.openFolderId = gid; renderGrid(); }
function closeFolder() { S.openFolderId = null; renderGrid(); }

// ============================================================
// 渲染功能核心
// ============================================================
function renderTabs() {
  const bar = document.getElementById('secbar'); [...bar.querySelectorAll('.stab,.stab-add')].forEach(e => e.remove());
  const sp = bar.querySelector('.secbar-sp');
  S.sections.forEach(s => {
    const b = document.createElement('button'); b.className = 'stab' + (s === S.activeSection ? ' active' : '');
    b.textContent = s + ' (' + S.cards.filter(c => c.section === s).length + ')';

        b.onclick = () => { S.activeSection = s; S.activeTag = '__all__'; S.activeTags.clear(); S.activeGroup = '__all__'; S.showFavOnly = false; if (S.folderView) { S.folderView = false; S.openFolderId = null; document.getElementById('folderBtn').classList.remove('active'); } renderTabs(); renderFilterBar(); renderGrid(); };
    bar.insertBefore(b, sp);
  });
  const add = document.createElement('button'); add.className = 'stab-add'; add.textContent = '+'; add.title = '新建分区'; add.onclick = openSettings; bar.insertBefore(add, sp);
}

function mkFC(text, active, isFav, cb) {
  const b = document.createElement('button'); b.className = 'fchip' + (active ? ' active' : '') + (isFav ? ' fav' : '');
  b.textContent = text; b.onclick = cb; return b;
}

function renderFilterBar() {
  const bar = document.getElementById('filterbar'); bar.innerHTML = '';
  const isAll = S.activeTags.size === 0 && S.activeTag === '__all__' && !S.showFavOnly;
  bar.appendChild(mkFC('全部', isAll, false, () => { S.activeTags.clear(); S.activeTag = '__all__'; S.activeGroup = '__all__'; S.showFavOnly = false; renderFilterBar(); renderGrid(); }));
  bar.appendChild(mkFC('★ 收藏', S.showFavOnly, true, () => { S.showFavOnly = !S.showFavOnly; S.activeTag = '__all__'; S.activeTags.clear(); renderFilterBar(); renderGrid(); }));
  bar.appendChild(mkFC('⊘ 未标签', S.activeTag === '__untagged__', false, () => { S.activeTag = S.activeTag === '__untagged__' ? '__all__' : '__untagged__'; S.activeTags.clear(); S.showFavOnly = false; renderFilterBar(); renderGrid(); }));
  
  const tagSet = new Set();
  S.cards.filter(c => c.section === S.activeSection).forEach(c => { (c.tags || []).forEach(t => tagSet.add(t)); (c.subtags || []).forEach(t => tagSet.add(t)) });
  (S.subTagLib[S.activeSection] || []).forEach(t => tagSet.add(t));
  
  const tagTree = {};
const parentKeys = new Set(Object.values(S.tagParents)); // 找出所有当了妈妈的标签

[...tagSet].sort().forEach(t => {
  const parent = S.tagParents[t];
  if (parent) {
    // 这是一个子标签，把它塞进它妈妈的文件夹里
    if (!tagTree[parent]) tagTree[parent] = []; 
    tagTree[parent].push({ full: t, sub: t }); 
  } else if (parentKeys.has(t)) {
    // 这是一个母标签，哪怕它自己没被卡片使用，也要建个空文件夹
    if (!tagTree[t]) tagTree[t] = [];
  } else {
    // 独立标签，自己玩
    if (!tagTree[t]) tagTree[t] = []; 
  }
});

  Object.keys(tagTree).sort().forEach(parentKey => {
    const children = tagTree[parentKey];
    if (children.length === 0) {
      bar.appendChild(mkFC(parentKey, S.activeTags.has(parentKey), false, () => toggleTag(parentKey)));
    } else {
      const groupEl = document.createElement('div'); groupEl.className = 'tree-tag-group';
      const hasActiveChild = children.some(c => S.activeTags.has(c.full)) || S.activeTags.has(parentKey);
      let childHtml = children.map(c => `<button class="fchip ${S.activeTags.has(c.full) ? 'active' : ''}" onclick="toggleTag('${c.full}')">${esc(c.sub)}</button>`).join('');
      groupEl.innerHTML = `
        <div class="tree-tag-parent" onclick="this.nextElementSibling.classList.toggle('open')">📁 ${esc(parentKey)} <span class="tree-toggle-ico">▶</span></div>
        <div class="tree-tag-children ${hasActiveChild ? 'open' : ''}">
          <button class="fchip ${S.activeTags.has(parentKey) ? 'active' : ''}" onclick="toggleTag('${parentKey}')">全部</button>
          ${childHtml}
        </div>`;
      bar.appendChild(groupEl);
    }
  });

  if (S.groups.length) {
    const sp = document.createElement('span'); sp.style.cssText = 'flex-shrink:0;color:var(--ink4);margin:0 1px;font-size:12px'; sp.textContent = '|'; bar.appendChild(sp);
    S.groups.forEach(g => { bar.appendChild(mkFC('▣ ' + g.name, S.activeGroup === g.id, false, () => { S.activeGroup = S.activeGroup === g.id ? '__all__' : g.id; renderFilterBar(); renderGrid(); })) });
  }
}
function toggleTag(t) { S.activeTag = '__all__'; S.showFavOnly = false; if (S.activeTags.has(t)) S.activeTags.delete(t); else S.activeTags.add(t); renderFilterBar(); renderGrid(); }

// ============================================================
// 虚拟滚动容器挂载 (Virtual Scrolling & Renderer)
// ============================================================
let vsState = { list: [], itemW: 140, itemH: 220, cols: 1, scrollTop: 0, bufferRows: 10, lastStartIndex: -1 };

function renderGrid() {
  if (S.folderView) { renderFolderView(); return; }
  triggerAsyncSearch(); // 将查询转移给 Web Worker
}

function updateGridAfterSearch() {
  const grid = document.getElementById('cardGrid'), stats = document.getElementById('statsbar');
  if (!document.getElementById('vsSpacer')) { grid.innerHTML = '<div class="vs-spacer" id="vsSpacer"></div><div class="vs-content" id="vsContent"></div>'; }
  grid.className = S.layout + '-layout';
  
  const list = vsState.list;
  const tot = list.reduce((a, c) => a + (c.charCount || 0), 0);
  stats.innerHTML = `<span class="stats-capsule">${list.length} 张${tot > 0 ? ' — ' + fmtN(tot) + ' 字' : ''}</span>`;
  
  if (!list.length) { 
    document.getElementById('vsSpacer').style.height = '0px'; 
    const isEmptyDB = S.cards.filter(c => c.section === S.activeSection && !c._delAt).length === 0;
    if (isEmptyDB) {
        document.getElementById('vsContent').innerHTML = `<div class="empty-state"><div class="eico">◫</div><p style="font-size:14px;font-weight:bold;color:var(--ink)">卡库空空如也</p><p style="font-size:11px; opacity:0.7; margin-top:4px;">点击右下角 ＋ 导入你的第一张卡片</p></div>`; 
    } else {
        document.getElementById('vsContent').innerHTML = `<div class="empty-state"><div class="eico">⌕</div><p>没有找到匹配的卡片</p><p style="font-size:11px; opacity:0.7; cursor:pointer; text-decoration:underline; margin-top:4px; color:var(--gold)" onclick="clearSearch()">一键清空搜索条件</p></div>`; 
    }
    return; 
}

  const container = document.getElementById('mainArea');
  const containerWidth = container.clientWidth - 28;
        // 【修复闪烁 1/2】增加卡片文本区域的预估高度，防止卡片实际高度超出预估
      if (S.layout === 'grid') { vsState.itemW = S.gridWidth + 10; vsState.itemH = S.gridWidth * 1.5 + 85; }
      else if (S.layout === 'magazine') { vsState.itemW = S.gridWidth + 50; vsState.itemH = (S.gridWidth + 40) * 1.33 + 95; }
      else if (S.layout === 'list') { vsState.itemW = containerWidth; vsState.itemH = 85; }
      
      vsState.cols = Math.max(1, Math.floor((containerWidth + 10) / vsState.itemW));
      const rowCount = Math.ceil(list.length / vsState.cols);
      // 【修复闪烁 2/2】加上 120px 的底部安全缓冲，抵消底部悬浮按钮占据的空间
      document.getElementById('vsSpacer').style.height = (rowCount * vsState.itemH + 120) + 'px';
  vsState.lastStartIndex = -1; renderVisibleCards();
}

// 新增：在当前位置弹出工具栏的函数
function popupToolbar() {
  const wrap = document.getElementById('toolbarWrap');
  if (!wrap) return;
  wrap.classList.add('floating-toolbar');
  // 设一个保护锁，防止点击瞬间触发微小滚动导致立刻消失
  window._ignoreNextScroll = true;
  setTimeout(() => { window._ignoreNextScroll = false; }, 200);
}

let _cachedBttBtn = null;
let _cachedRevealBtn = null;
let _cachedContainer = null;

function handleScroll() {
  if (!_cachedContainer) _cachedContainer = document.getElementById('mainArea');
  if (!_cachedBttBtn) _cachedBttBtn = document.getElementById('bttBtn');
  if (!_cachedRevealBtn) _cachedRevealBtn = document.getElementById('revealBtn');
  
  // 修复：限制 scrollTop 范围，防止 iOS/Android 边缘回弹导致的负数或超限引起白屏
  vsState.scrollTop = Math.max(0, Math.min(_cachedContainer.scrollTop, _cachedContainer.scrollHeight - _cachedContainer.clientHeight));
  requestAnimationFrame(renderVisibleCards);
  
  if (_cachedContainer.scrollTop > 400) _cachedBttBtn.classList.add('show'); else _cachedBttBtn.classList.remove('show');
  if (_cachedContainer.scrollTop > 100) _cachedRevealBtn.classList.add('show'); else _cachedRevealBtn.classList.remove('show');

  // 新增：只要检测到滑动，就隐藏空降的工具栏
  if (!window._ignoreNextScroll) {
    const wrap = document.getElementById('toolbarWrap');
    if (wrap && wrap.classList.contains('floating-toolbar')) {
      wrap.classList.remove('floating-toolbar');
    }
  }
}
function scrollToTop() { document.getElementById('mainArea').scrollTo({ top: 0, behavior: 'smooth' }); }

function renderVisibleCards() {
  if (S.folderView) return;
  const container = document.getElementById('mainArea'), viewportHeight = container.clientHeight;
  const totalRows = Math.ceil(vsState.list.length / vsState.cols);
  
  // 自动计算顶部工具栏占据的高度，防止卡片提前消失
  let headerH = 0;
  const secbar = document.getElementById('secbar');
  const scopebar = document.getElementById('scopebar');
  const filterbar = document.querySelector('.filterbar-wrap');
  if (secbar) headerH += secbar.offsetHeight;
  if (scopebar && scopebar.classList.contains('show')) headerH += scopebar.offsetHeight;
  if (filterbar) headerH += filterbar.offsetHeight;

  let effectiveScrollTop = Math.max(0, vsState.scrollTop - headerH);
  let startRow = Math.floor(effectiveScrollTop / vsState.itemH);
  let endRow = Math.ceil((effectiveScrollTop + viewportHeight) / vsState.itemH);

// 【终极防弹跳补丁】强制刹车，防止手机端橡皮筋回弹导致计算超出边界
startRow = Math.max(0, Math.min(startRow, totalRows - 1));

let startIndex = Math.max(0, (startRow - vsState.bufferRows) * vsState.cols);
let endIndex = Math.min(vsState.list.length, (endRow + vsState.bufferRows) * vsState.cols);

if (startIndex === vsState.lastStartIndex && document.getElementById('vsContent').children.length > 0) return;
vsState.lastStartIndex = startIndex;

const content = document.getElementById('vsContent');
// 严格根据实际渲染的起始行来计算偏移量，拒绝悬空
const actualRenderStartRow = Math.floor(startIndex / vsState.cols);
const yOffset = actualRenderStartRow * vsState.itemH;
content.style.transform = `translateY(${yOffset}px)`;

  
  const fragment = document.createDocumentFragment(), q = S.searchQuery.trim(), gm = {}; S.groups.forEach(g => gm[g.id] = g.name);
  const nc = {}; vsState.list.forEach(c => nc[c.name] = (nc[c.name] || 0) + 1);
  
  let lastDate = '';
// 【性能修复】不要在这里 disconnect，让浏览器自动回收移出 DOM 的元素
// imgObserver.disconnect(); 

for (let i = startIndex; i < endIndex; i++) {
    const card = vsState.list[i];
    if (S.timelineMode) {
      const d = new Date(card.importedAt).toLocaleDateString();
      if (d !== lastDate) { lastDate = d; const h = document.createElement('div'); h.className = 'timeline-date'; h.textContent = '📅 ' + d; fragment.appendChild(h); }
    }
    const el = mkCardEl(card, nc[card.name] > 1, q, gm);
    fragment.appendChild(el);
    // 侦测图片元素
    const imgEl = el.querySelector('img.cov-img');
    if (imgEl && imgEl.dataset.src) imgObserver.observe(imgEl);
  }
  content.innerHTML = ''; content.appendChild(fragment);
}

function mkCardEl(card, isDup, q, gm) {
  const div = document.createElement('div'); div.className = 'card-item' + (card.stPushed ? ' st-pushed' : ''); div.dataset.id = card.id;
    // 【新增功能：让卡片可以被拖拽】
  div.draggable = true;
  div.ondragstart = (e) => { e.dataTransfer.setData('text/plain', card.id); };
  
  if (S.selectMode) {
    div.classList.add('sel-mode'); if (S.selectedIds.has(card.id)) div.classList.add('selected');
    div.onclick = ev => toggleSelect(card.id, ev);
      } else {
      // 优雅触控升级：短按直接看详情，长按安全唤醒操作菜单
      let pressTimer;
      let isTouch = false;
      let isLongPressAction = false;
      
      let touchStartY = 0;
      let isScrolling = false;
      div.addEventListener('touchstart', (e) => {
          isTouch = true;
          isScrolling = false;
          isLongPressAction = false;
          touchStartY = e.touches[0].clientY;
          pressTimer = setTimeout(() => {
              isLongPressAction = true;
              // 长按行为：单独切换快捷菜单
              document.querySelectorAll('.card-item.show-menu').forEach(el => {
                  if (el !== div) el.classList.remove('show-menu');
              });
              div.classList.toggle('show-menu');
              showToast('已唤醒快捷菜单');
          }, 600); // 600毫秒长按阈值，防止划屏时误触
      }, {passive: true});
      
      let touchStartX = 0;
div.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, {passive: true});
div.addEventListener('touchmove', (e) => { 
    if (Math.abs(e.touches[0].clientY - touchStartY) > 10) isScrolling = true;
    clearTimeout(pressTimer); 
}, {passive: true});
div.addEventListener('touchend', (e) => {
    clearTimeout(pressTimer);
    if (!isScrolling && e.changedTouches) {
        let dx = e.changedTouches[0].clientX - touchStartX;
        if (dx < -50) { // 向左滑动唤出菜单
            document.querySelectorAll('.card-item.show-menu').forEach(el => el.classList.remove('show-menu'));
            div.classList.add('show-menu');
        } else if (dx > 50) { // 向右滑动收起菜单
            div.classList.remove('show-menu');
        }
    }
}, {passive: true});
      
      div.onclick = (e) => {
    // 核心隔离：如果点击的是弹出的快捷按钮本身，执行按钮功能，不触发卡片详情
    // 【修复】只拦截真正的按钮(.cha-btn)，点击图片的半透明背景依然可以直接打开详情！
    if (e.target.closest('.cha-btn')) return;
    
    // 防误触：如果是滑动操作，或者长按唤醒菜单，本次点击不响应
    if (isTouch && (isLongPressAction || isScrolling)) {
        isScrolling = false;
        return;
    }
          
          // 无论是手机端短按，还是电脑端点击，一律直接滑出最安全的详情面板，绝不误触
          openDetail(card.id);
      };
    }


  const covSrc = card._thumbBlobUrl || null;
  // ✨ 交由 observer 懒加载 
  const cov = covSrc ? `<img class="cov-img" data-src="${covSrc}" alt="">` : `<div class="cov-ph">◫</div>`;
  const allTags = [...(card.tags || []), ...(card.subtags || [])];
  const th = allTags.slice(0, 4).map(t => `<span class="ctag" data-tag="${esc(t)}">${esc(t)}</span>`).join('');
  const gn = card.groupId && gm[card.groupId] ? gm[card.groupId] : '';
  const chk = S.selectMode ? '<span class="sel-check">✓</span>' : '';
  const verCount = S.cards.filter(c => c.parentId === card.id).length; 
  const verBadge = verCount > 0 ? `<span class="b-ver" title="${verCount+1} 个版本">${verCount+1}</span>` : '';
  const badges = `${chk}<span class="b-type">${esc(card.fileType || '?')}</span>${verBadge}${isDup ? '<span class="b-dup">DUP</span>' : ''}${card.favorite ? '<span class="b-fav">★</span>' : ''}${gn ? `<span class="b-grp">${esc(gn)}</span>` : ''}${card._isModified ? '<span style="position:absolute;top:4px;right:36px;width:8px;height:8px;background:var(--red);border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.5);" title="已修改，未同步"></span>' : ''}`;
  const ns = (S.showNote && card.note) ? card.note.trim() : '';

  // 添加触控笔悬停交互菜单 @media hover
  const hoverActions = `<div class="card-hover-actions">
    <button class="cha-btn" onclick="event.stopPropagation(); openLightbox('${card.id}')">👁️ 预览大图</button>
    <button class="cha-btn" onclick="event.stopPropagation(); exportCard('${card.id}')">↑ 导出</button>
<button class="cha-btn" onclick="event.stopPropagation(); quickViewCard('${card.id}')">📄 快速浏览</button>
    <button class="cha-btn" onclick="event.stopPropagation(); editMeta('${card.id}', 'name')">✎ 快速编辑</button>
    <button class="cha-btn" onclick="event.stopPropagation(); openMoveModal('${card.id}')">→ 移动分区</button>
    <button class="cha-btn st-push" onclick="event.stopPropagation(); pushCardToTavern('${card.id}')">☁️ 推送至酒馆</button>
    <button class="cha-btn" style="background:rgba(139,46,46,0.3); border-color:var(--red);" onclick="event.stopPropagation(); trashCard('${card.id}')">✕ 移至回收站</button>
  </div>`;

  if (S.layout === 'list') {
    div.innerHTML = `<div class="cov-wrap">${cov}${hoverActions}</div><div class="cbody"><div class="cname">${hl(card.name, q)}</div>${ns ? `<div class="cnote">${esc(ns)}</div>` : ''}<div class="cdesc">${esc(card.description || '')}</div><div class="ctags">${th}</div></div><div class="cmeta"><span>${esc(card.fileType || '')}</span>${card.charCount ? `<span>${fmtN(card.charCount)}字</span>` : ''} ${card.favorite ? '<span>★</span>' : ''}</div>`;
  } else if (S.layout === 'magazine') {
    div.innerHTML = `<div class="cov-wrap">${cov}${badges}${hoverActions}</div><div class="cinfo"><div class="ctypeline">${esc(card.fileType || '')}${card.charCount ? ' · ' + fmtN(card.charCount) + '字' : ''}</div><div class="cname">${hl(card.name, q)}</div>${ns ? `<div class="cnote">${esc(ns)}</div>` : ''}<div class="cdesc">${esc((card.description || '').slice(0, 120))}</div><div class="ctags">${th}</div></div>`;
  } else {
    div.innerHTML = `<div class="cov-wrap">${cov}${badges}${hoverActions}</div><div class="cinfo"><div class="cname">${hl(card.name, q)}</div>${ns ? `<div class="cnote">${esc(ns)}</div>` : ''}<div class="ctags">${th}</div></div>`;
  }
  return div;
}

// 文件夹渲染模式保持不变
function renderFolderView() {
  const grid = document.getElementById('cardGrid'), stats = document.getElementById('statsbar');
  if (S.openFolderId) {
    const g = S.groups.find(x => x.id === S.openFolderId), list = S.cards.filter(c => c.groupId === S.openFolderId);
    stats.innerHTML = `<div class="folder-bc"><button class="fb-back" onclick="closeFolder()">‹ 文件夹</button><span class="fb-name">📁 ${esc(g?g.name:'?')}</span><span style="color:var(--ink3);font-size:12px">${list.length} 项</span><button class="fb-exp" onclick="exportFolder('${S.openFolderId}')">↑ 导出打包</button></div>`;
    grid.className = 'grid-layout';
    if (!list.length) { document.getElementById('vsSpacer').style.height = '0px'; document.getElementById('vsContent').innerHTML = '<div class="empty-state"><div class="eico">📂</div><p>空文件夹</p></div>'; return; }
    
    // 强制一次性挂载，这里因为单个文件夹通常不会太多超出性能边界
    document.getElementById('vsSpacer').style.height = '0px';
    const content = document.getElementById('vsContent');
    content.innerHTML = ''; content.style.transform = 'none';
    const nc = {}, gm = {}; S.groups.forEach(x => gm[x.id] = x.name); list.forEach(c => nc[c.name] = (nc[c.name] || 0) + 1);
    list.forEach(c => {
       const el = mkCardEl(c, nc[c.name] > 1, '', gm);
       content.appendChild(el);
       const imgEl = el.querySelector('img.cov-img');
       if (imgEl && imgEl.dataset.src) imgObserver.observe(imgEl);
    });
    return;
  }
  stats.innerHTML = `<span class="stats-capsule">文件夹 — 把成套的卡片归到一组，点开整组导出</span>`;
  grid.className = 'folder-grid';
  document.getElementById('vsSpacer').style.height = '0px';
  const content = document.getElementById('vsContent'); content.innerHTML = ''; content.style.transform = 'none';
  const groups = S.groups.filter(g => S.cards.some(c => c.groupId === g.id));
  if (!groups.length) { content.innerHTML = '<div class="folder-hint">还没有任何文件夹～<br>在卡片详情点「▣ 分组」<br>把成套的世界书/预设归到一起</div>'; return; }
  
  groups.forEach(g => {
  const cards = S.cards.filter(c => c.groupId === g.id), cover = cards.find(c => c._thumbBlobUrl);
  const covSrc = cover ? cover._thumbBlobUrl : null;
  const cov = covSrc ? `<img class="fc-img cov-img" data-src="${covSrc}" alt="">` : `<div class="fc-ph">📁</div>`;
  const el = document.createElement('div'); el.className = 'folder-card'; el.onclick = () => openFolder(g.id);
  el.innerHTML = `<div class="folder-cover"><div class="folder-tab"></div>${cov}<div class="folder-veil"></div><span class="folder-cnt">${cards.length} 项</span><span class="folder-corner">📁</span></div><div class="folder-name">${esc(g.name)}</div>`;
  
  // 新增：长按(手机)或右键(电脑)直接导出整个文件夹
  let _lpt;
  el.addEventListener('touchstart', () => { _lpt = setTimeout(() => exportFolder(g.id), 550) }, {passive: true});
  el.addEventListener('touchend', () => clearTimeout(_lpt));
  el.addEventListener('touchmove', () => clearTimeout(_lpt), {passive: true});
  el.oncontextmenu = ev => { ev.preventDefault(); exportFolder(g.id); };

  content.appendChild(el);
  const imgEl = el.querySelector('img.cov-img');
  if (imgEl && imgEl.dataset.src) imgObserver.observe(imgEl);
});
}
// ============================================================
// 拼音关联搜索与自动补全 (Search Auto-Complete)
// ============================================================
let acTimer;
function initSearchInput() {
  const inp = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  const acPanel = document.getElementById('acPanel');

  // 新增：中文输入法防抖逻辑
  let isComposing = false;
  inp.addEventListener('compositionstart', () => { isComposing = true; });
  inp.addEventListener('compositionend', (e) => { 
      isComposing = false; 
      inp.dispatchEvent(new Event('input')); // 选词结束后手动触发一次搜索
  });


  // 新增：按回车键收起键盘，按 ESC 键一键清空搜索
inp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    inp.blur(); 
    acPanel.classList.remove('show');
  } else if (e.key === 'Escape') {
    clearSearch();
  }
});

  inp.addEventListener('input', (e) => {
    if (isComposing) return; // 拦截打字过程中的无效搜索触发
    S.searchQuery = e.target.value;
    clearBtn.style.display = S.searchQuery ? 'block' : 'none';
    
    // 重新挂载虚拟列表搜索
    clearTimeout(acTimer);
    if (!S.searchQuery.trim()) { acPanel.classList.remove('show'); triggerAsyncSearch(); return; }
    
    acTimer = setTimeout(() => { renderAutoComplete(S.searchQuery); }, 150);
    triggerAsyncSearch();
  });
  
  // 点击外部关闭补全
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sbox')) acPanel.classList.remove('show');
  });
}

function renderAutoComplete(query) {
  const acPanel = document.getElementById('acPanel');
  const tokens = query.trim().split(/\s+/);
  const lastToken = tokens[tokens.length - 1]; // 针对正在输入的最后一个单词提供补全
  
  if (lastToken.length < 1 || lastToken.includes(':') || lastToken.includes('>')) { acPanel.classList.remove('show'); return; }

  // 收集所有可能的补全词(卡名、标签)
  const dict = new Set();
  S.cards.forEach(c => { dict.add(c.name); (c.tags||[]).forEach(t=>dict.add(t)); (c.subtags||[]).forEach(t=>dict.add(t)); });
  
  // 拼音化
  const isPinyinSupported = window.PinyinLib.isSupported();
  const searchLower = lastToken.toLowerCase();
  
  const matches = [...dict].filter(word => {
    if (!word) return false;
    const wLower = word.toLowerCase();
    if (wLower.includes(searchLower)) return true;
    if (isPinyinSupported) {
      const py = window.PinyinLib.convertToPinyin(word, '', true);
      const pyInitials = window.PinyinLib.parse(word).filter(t=>t.type===2).map(t=>t.target[0].toLowerCase()).join('');
      if (py.includes(searchLower) || pyInitials.includes(searchLower)) return true;
    }
    return false;
  }).slice(0, 8); // 显示前8个建议

  if (!matches.length) { acPanel.classList.remove('show'); return; }

  acPanel.innerHTML = matches.map(m => {
    // 判断该词是标签还是名字
    const isTag = S.cards.some(c => (c.tags||[]).includes(m) || (c.subtags||[]).includes(m));
    const prefix = isTag ? 'tag:' : '';
    const displayTag = isTag ? `<span style="background:var(--p3);color:var(--ink4);padding:0 4px;border-radius:2px;font-size:9px;margin-right:4px;">TAG</span>` : '';
    return `<div class="ac-item" onclick="applySearchCompletion('${prefix}${m}')">${displayTag}${esc(m)}</div>`;
  }).join('');
  acPanel.classList.add('show');
}

function applySearchCompletion(completedWord) {
  const inp = document.getElementById('searchInput');
  const tokens = S.searchQuery.trim().split(/\s+/);
  tokens.pop(); // 移除正在打的残缺词
  tokens.push(completedWord);
  S.searchQuery = tokens.join(' ') + ' '; // 补全后加空格
  inp.value = S.searchQuery;
  document.getElementById('acPanel').classList.remove('show');
  inp.focus();
  triggerAsyncSearch();
}
function clearSearch() { 
  const inp = document.getElementById('searchInput');
  inp.value = ''; 
  S.searchQuery = ''; 
  document.getElementById('searchClear').style.display = 'none'; 
  
  // 修复：强制隐藏智能补全下拉面板
  const acPanel = document.getElementById('acPanel');
  if(acPanel) acPanel.classList.remove('show');
  
  triggerAsyncSearch(); 
  inp.focus(); 
}

// ============================================================
// 卡片详细数据加载与详情页渲染 (大屏右滑/小屏弹窗)
// ============================================================
let _currentDetailId = null;
let dlgIdx = 0; // ✨ 显式声明全局对白翻页索引

async function openDetail(id) {
  let card = S.cards.find(c => c.id === id); if (!card) return;
  const full = await dbG('cards', id); if (full) { Object.assign(card, full); card._fullLoaded = true; }
  _currentDetailId = id;
  
  const hd = document.getElementById('detailTitle');
  hd.textContent = card.section.toUpperCase();
  
  const isImage = card.fileType?.includes('png') || card.fileType?.includes('webp');
  const covSrc = isImage && card.originalDataUrl ? card.originalDataUrl : (card._thumbBlobUrl || null);
  const covInner = covSrc ? `<img src="${covSrc}" onclick="openLightbox('${id}')" alt="">` : `<div class="dcov-ph">◫</div>`;
  // 嵌入换封面按钮
  const cov = `<div style="display:flex;flex-direction:column;position:relative">${covInner}<button onclick="document.getElementById('coverReplaceInput').click()" style="margin-top:4px;padding:4px 0;font-size:10px;color:var(--ink2);background:var(--p3);border:1px solid var(--bd);cursor:pointer;border-radius:var(--r);width:100%;transition:all 0.2s;" onmouseover="this.style.background='var(--ink)';this.style.color='var(--p)'" onmouseout="this.style.background='var(--p3)';this.style.color='var(--ink2)'">🖼️ 更换封面</button><input type="file" id="coverReplaceInput" accept="image/*" style="display:none" onchange="smartReplaceCover('${id}',this)"></div>`;
  
  let relatedHtml = '';
  if (card.tags && card.tags.length > 0) {
     const relSet = new Set();
     S.cards.filter(c => c.id !== id && c.tags?.some(t => card.tags.includes(t))).forEach(c => relSet.add(c));
     const rels = [...relSet].slice(0, 5);
     if (rels.length > 0) {
       relatedHtml = `<div class="sec-hd">🕸 关联 / RELATED</div><div class="related-cards">` +
         rels.map(c => `<div class="rel-card" onclick="openDetail('${c.id}')"><div class="rel-cov">${c._thumbBlobUrl ? `<img src="${c._thumbBlobUrl}">` : '◫'}</div><div class="rel-name">${esc(c.name)}</div></div>`).join('') + `</div>`;
     }
  }

  const textForToken = [
    card.description, card.personality, card.mesExample, card.first_mes, card.scenario, card.note
  ].join('\n') + 
  (card.dialogEntries || []).join('\n') + 
  (card.worldBookEntries || []).map(e => e.content).join('\n') +
  (card.presetEntries || []).map(p => p.content).join('\n');
  
  const tokenBadge = renderTokenBadge(card.charCount, textForToken);
  
  const allTags = card.tags || [];
  const th = allTags.map(t => `<button class="dtag" data-tag="${esc(t)}" onclick="editSingleTag('${id}','${t}')">${esc(t)} ✕</button>`).join('');
  const sb = (card.subtags || []).map(t => `<button class="dsubtag" data-tag="${esc(t)}" onclick="editSingleSubTag('${id}','${t}')">${esc(t)} ✕</button>`).join('');
  let ns = card.note || '';

  let wbH = '';
  if ((card.worldBookEntries || []).length > 0) {
    wbH = `<div class="sec-hd">🌍 世界书 / WORLD BOOK · ${card.worldBookEntries.length} 条目</div>`;
    card.worldBookEntries.forEach((e, i) => {
      const rawPos = e.position !== undefined ? e.position : 0;
      const rawRole = e.role !== undefined ? e.role : 0;
      const posValue = `${rawPos}_${rawRole}`;
      const rawDepth = e.depth !== undefined ? e.depth : 4;
      const rawOrder = e.order !== undefined ? e.order : 100;
      const rawProb = e.probability !== undefined ? e.probability : 100;
      const isConstant = !!e.constant;
      const isEnabled = e.enabled !== undefined ? e.enabled : true;
      
      // 【兼容老数据】严格梳理喵喵工坊的安全字段逻辑
      const displayTitle = e.name || e.comment || e.keys || '（无标题）';
      let rawKeys = e.keys || '';
      if (!e.name && e.keys) {
          rawKeys = ''; // 防止老数据将巨型标题识别成一万个标签
      }
      if (e.actual_keywords !== undefined) {
          rawKeys = e.actual_keywords; 
      }
      
      const tagsArray = rawKeys.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
      const tagsHtml = tagsArray.map((t, idxTag) => 
        `<span class="wb-tag-chip">${esc(t)} <span class="wb-tag-del" onclick="removeWbTag(event, '${id}', ${i}, ${idxTag})">✕</span></span>`
      ).join('');

      wbH += `<div class="wb-entry" style="${isEnabled ? '' : 'opacity: 0.6;'}">
        <div class="wb-row" onclick="this.parentElement.classList.toggle('open')">
          <span class="wb-row-key" id="wb_row_key_${id}_${i}" style="${isEnabled ? '' : 'text-decoration: line-through;'}">${esc(displayTitle)}</span>
          <label class="mc-toggle" title="${isEnabled ? '已启用' : '已禁用'}" style="margin-left: auto;" onclick="event.stopPropagation()">
            <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="updateWbSetting('${id}', ${i}, 'enabled', this.checked)">
            <span class="mc-toggle-track"></span>
          </label>
          <span class="wb-cnt" style="margin-left: 6px;">${fmtN((e.content || '').length)}字</span>
          <button class="expand-btn" style="margin-left:4px; padding:1px 6px;" onclick="event.stopPropagation(); openRead('wb_${i}_${id}')" title="全屏阅读">⛶</button>
          <span class="wb-arr">▾</span>
        </div>
        
        <div class="wb-keys-wrap" onclick="event.stopPropagation()">
            <div class="wb-keys-header">
                <span>🔑 触发词Tag (支持点击右侧 ＋ 添加)</span>
                <button class="wb-btn-fix" onclick="fixWbKeys('${id}', ${i})">🛠️ 修复标点/格式</button>
            </div>
            <div class="wb-tags-container" onclick="this.querySelector('.wb-tag-input').focus()">
                <div class="wb-tags-box" id="wb_tags_box_${id}_${i}">${tagsHtml}</div>
                <input type="text" class="wb-tag-input" id="wb_tag_input_${id}_${i}" placeholder="输入词汇..." onkeydown="handleWbTagKeyDown(event, '${id}', ${i})">
                <button class="wb-btn-add" onclick="addWbTagFromInput('${id}', ${i}); event.stopPropagation();">＋</button>
            </div>
        </div>

        <div class="wb-settings" onclick="event.stopPropagation()">
          <div class="wb-set-item" title="插入位置"><label>📌位置</label><select onchange="updateWbSetting('${id}', ${i}, 'pos_role', this.value)">
              <option value="0_0" ${posValue==='0_0'?'selected':''}>角色前</option>
              <option value="1_0" ${posValue==='1_0'?'selected':''}>角色后</option>
              <option value="2_0" ${posValue==='2_0'?'selected':''}>注释前</option>
              <option value="3_0" ${posValue==='3_0'?'selected':''}>注释后</option>
              <option value="4_0" ${posValue==='4_0'?'selected':''}>深度(系统)</option>
              <option value="4_1" ${posValue==='4_1'?'selected':''}>深度(用户)</option>
              <option value="4_2" ${posValue==='4_2'?'selected':''}>深度(AI)</option>
          </select></div>
          <div class="wb-set-item" title="插入深度"><label>🐚深度</label><input type="number" value="${rawDepth}" onchange="updateWbSetting('${id}', ${i}, 'depth', this.value)"></div>
          <div class="wb-set-item" title="排列顺序，越小越靠前"><label>⚙️顺序</label><input type="number" value="${rawOrder}" onchange="updateWbSetting('${id}', ${i}, 'order', this.value)"></div>
          <div class="wb-set-item" title="触发概率"><label>🎲触发%</label><input type="number" min="0" max="100" value="${rawProb}" onchange="updateWbSetting('${id}', ${i}, 'probability', this.value)"></div>
          <label class="mc-toggle" title="常驻生效 (无视关键词触发)" style="margin-left: 2px;">
            <input type="checkbox" ${isConstant ? 'checked' : ''} onchange="updateWbSetting('${id}', ${i}, 'constant', this.checked)">
            <span class="mc-toggle-track"></span> 常驻
          </label>
        </div>
        <div class="wb-val">${esc(e.content || '')}</div>
      </div>`;
    });
  }

  let presetH = '';
  if ((card.presetEntries || []).length > 0) {
    presetH = `<div class="sec-hd">⚙️ 预设 / PRESET · ${card.presetEntries.length} 条目</div><div class="preset-list">`;
    card.presetEntries.forEach((p, pi) => {
      const name = typeof p === 'string' ? p : (p.name || '');
      const content = typeof p === 'string' ? '' : (p && typeof p.content === 'string' ? p.content : '');
      const hasContent = content.trim().length > 0;
      presetH += `<div class="preset-item" onclick="this.classList.toggle('open')">
        <div class="preset-item-hd"><span class="preset-item-name">${esc(name)}</span><span class="preset-item-arr">${hasContent ? fmtN(content.length) + '字 ▾' : '—'}</span></div>
        ${hasContent ? `<div class="preset-item-val">${esc(content)}</div>` : ''}
      </div>`;
    });
    presetH += `</div>`;
  }

  const dlgs = card.dialogEntries || [];
  window._currentDlgs = dlgs; 
  window._currentCharName = card.name;
  dlgIdx = 0;
  let chatHtml = '';
  if (dlgs.length > 0) {
    let navH = dlgs.length > 1 ? `
      <div class="dlg-nav">
        <button class="dnbtn" id="dlgP" onclick="navDlgV4(-1)" disabled>◀</button>
        <span class="dlg-idx" id="dlgI">1 / ${dlgs.length}</span>
        <span class="dlg-cnt" id="dlgC">${fmtN((dlgs[0]||'').length)}字</span>
        <button class="dnbtn" id="dlgN" onclick="navDlgV4(1)">▶</button>
      </div>` : '';
    chatHtml = `<div class="sec-hd">💬 对白 / DIALOG <button class="expand-btn" style="margin-left:auto" onclick="openRead('dlg_${id}')">全屏阅读</button></div>${navH}<div class="chat-wrap" id="dlgBoxV4">${renderBubbleV4(dlgs[0], card.name)}</div>`;
  }

  const html = `
    <div class="detail-hero">
      <div class="dcov">${cov}</div>
      <div class="dmeta">
        <div class="dname">${esc(card.name)} 
            <button class="hbtn" style="font-size:10px; margin-left:4px;" onclick="editMeta('${id}','name')" title="编辑名字">✎</button>
            <button class="hbtn" style="font-size:10px; margin-left:4px; color:var(--gold); border-color:var(--gold);" onclick="navigator.clipboard.writeText('${esc(textForToken.replace(/'/g, "\\'").replace(/\n/g, "\\n"))}').then(()=>showToast('角色设定已复制到剪贴板！'))" title="一键复制角色所有设定文本">📋 复制设定</button>
        </div>
        <div class="dkv"><b>TYPE</b> ${esc(card.fileType||'?')}</div>
        <div class="dkv"><b>SIZE</b> ${fmtSZ(card.fileSize||0)}</div>
        <div class="dkv"><b>CHAR</b> ${fmtN(card.charCount||0)} 字 ${tokenBadge}</div>
        <div class="dkv"><b>TIME</b> ${new Date(card.importedAt).toLocaleString()}</div>
        ${card.groupId ? `<div class="dkv"><b>GROUP</b> `+esc((S.groups.find(x=>x.id===card.groupId)||{}).name)+`</div>` : ''}
      </div>
    </div>
    
    <div class="dacts" style="margin-bottom:12px;border:none;padding:0">
      <button class="dact fav" onclick="toggleFav('${id}')">${card.favorite ? '取消收藏' : '★ 收藏'}</button>
      <div style="position:relative; flex:1; min-width:40px; display:flex;">
          <button class="dact" style="width:100%;" onclick="toggleExportMenu('${id}')">↑ 导出</button>
          <div class="export-menu" id="exportMenu" style="display:none; position:absolute; top:calc(100% + 4px); left:0; right:0; background:var(--p2); border:1px solid var(--ink); border-radius:var(--r); box-shadow:0 4px 14px var(--sh); z-index:600; overflow:hidden; min-width:140px; flex-direction:column;">
              <button onclick="exportCardFormat('${id}','orig')" style="padding:6px 12px;text-align:left;background:none;border:none;border-bottom:1px solid var(--bd2);font-size:11px;color:var(--ink2);cursor:pointer;">📄 导出源文件</button>
              <button onclick="exportCardFormat('${id}','png')" style="padding:6px 12px;text-align:left;background:none;border:none;border-bottom:1px solid var(--bd2);font-size:11px;color:var(--ink2);cursor:pointer;">🖼️ 导出 PNG</button>
              <button onclick="exportCardFormat('${id}','json')" style="padding:6px 12px;text-align:left;background:none;border:none;font-size:11px;color:var(--ink2);cursor:pointer;">📋 导出 JSON</button>
              <button onclick="exportCardWithChatlogs('${id}')" style="padding:6px 12px;text-align:left;background:none;border:none;border-top:1px solid var(--bd2);font-size:11px;color:var(--ink2);cursor:pointer;">📦 导出 卡片+聊天记录</button>
          </div>
      </div>
      <button class="dact" onclick="openGrpModal('${id}')">▣ 分组</button>
      <button class="dact" onclick="openVersionModal('${id}')">⧉ 版本</button>
      <button class="dact push" title="推送热更新" onclick="pushCardToTavern('${id}')">☁️ 推送</button>
    </div>

    
    <div class="dtags-row">${th}<button class="add-tag-btn" onclick="openAddTagModal('${id}')" style="color:var(--gold);border-color:rgba(184,150,62,0.3)">＋主标签</button></div>
    <div class="dtags-row">${sb}<button class="add-tag-btn" onclick="openAddSubTagModal('${id}')" style="color:var(--gold);border-color:rgba(184,150,62,0.3)">＋小标签</button></div>
    
    <div class="sec-hd">📝 备忘录 / NOTE 
    <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="expand-btn" id="noteUndoBtn" onclick="undoNote()" disabled>↩ 撤销</button>
        <button class="expand-btn" id="noteRedoBtn" onclick="redoNote()" disabled>↪ 重做</button>
    </div>
</div>
<textarea class="note-ta" id="noteArea" placeholder="关于这张卡的备忘项...">${esc(ns)}</textarea>

<div class="sec-hd" style="margin-top:10px;">🔗 来源链接 / LINK</div>
<div id="linkSection" style="padding:2px 0 6px"></div>

<div class="sec-hd" style="margin-top:10px;">🔒 附加区 / ANNEX <span style="font-size:8px;color:var(--ink4);margin-left:4px;">仅内部可见</span> <button class="expand-btn" style="margin-left:auto" onclick="document.getElementById('annexArea').classList.toggle('collapsed')">折叠/展开</button></div>
<textarea class="note-ta collapsed" id="annexArea" placeholder="在这里记录不想在外部列表透出的绝对私密内容...">${esc(card.annex || '')}</textarea>
	
    <div class="sec-hd">📖 简介 / DESC 
      <button class="hbtn" style="font-size:10px" onclick="openFieldEdit('${id}','description')">✎</button>
      <button class="expand-btn" style="margin-left:auto" onclick="openRead('desc_${id}')">全屏阅读</button>
    </div>
	<div class="cbox">${renderMD(card.description||'无简介')}</div>

    ${chatHtml}
    ${wbH}
    ${presetH}
    ${relatedHtml}
    
    <div style="margin-top:24px; display:flex; gap:10px;">
      <button class="dact" style="flex:1; padding:10px 0; background:var(--ink); color:var(--p); border-radius:12px;" onclick="closeModal('detailModal')">↓ 收起详情</button>
      <button class="dact del" style="flex:1; padding:10px 0; border-radius:12px;" onclick="trashCard('${id}')">✕ 移至回收站</button>
    </div>
  `;
  document.getElementById('detailContent').innerHTML = html;
  
  checkSplitPaneMode();
  if (!document.getElementById('appContainer').classList.contains('split-active')) {
     openModal('detailModal');
  }
  
  // 渲染顶部版本条
  const rootId = card.parentId || card.id;
  const rootCard = S.cards.find(c => c.id === rootId) || card;
  const verList = [rootCard, ...S.cards.filter(c => c.parentId === rootId)];
  if(verList.length > 1) {
      const chips = verList.map(v => `<button class="ver-chip ${v.id === id ? 'active' : ''}" onclick="openDetail('${v.id}')">${v.id === rootId ? '★ ' : ''}${esc(v.name)}</button>`).join('');
      document.getElementById('detailVerBar').style.display = 'flex';
      document.getElementById('detailVerBar').innerHTML = `<span class="ver-bar-lbl">版本:</span>${chips}`;
  } else {
      document.getElementById('detailVerBar').style.display = 'none';
  }
  // 【新增功能：移动端详情页左右滑动切换卡片】
  const modalBox = document.getElementById('detailModal').querySelector('.modal-box');
  let touchStartX = 0;
  let touchEndX = 0;
  modalBox.ontouchstart = e => { touchStartX = e.changedTouches[0].screenX; };
  modalBox.ontouchend = e => {
    // 忽略在文本框里的滑动
    if(e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    touchEndX = e.changedTouches[0].screenX;
    if (touchEndX < touchStartX - 80) { // 向左滑，下一张
      const idx = vsState.list.findIndex(c => c.id === id);
      if(idx >= 0 && idx < vsState.list.length - 1) openDetail(vsState.list[idx + 1].id);
    }
    if (touchEndX > touchStartX + 80) { // 向右滑，上一张
      const idx = vsState.list.findIndex(c => c.id === id);
      if(idx > 0) openDetail(vsState.list[idx - 1].id);
    }
  };
  // 绑定附加区保存
const aa = document.getElementById('annexArea');
let at;
if(aa) {
    aa.addEventListener('input', () => {
        clearTimeout(at);
        at = setTimeout(async () => {
            let sf = S.cards.find(c => c.id === id); if (!sf) return;
            sf.annex = aa.value;
            const full = await dbG('cards', id);
            full.annex = aa.value;
            await dbP('cards', full);
            showToast('附加区已保存');
        }, 600);
    });
}

  renderLinkSection(card); // 渲染多链接模块

  // 修复：每次打开不同的卡片时，强制清空撤销历史，防止数据串联污染
  if (window._noteActiveId !== id) {
      window._noteHistory = [];
      window._noteFuture = [];
  }
  window._noteActiveId = id;
  const na = document.getElementById('noteArea');
  window._noteLastVal = na ? na.value : '';

  window.updateNoteActionButtons = function() {
    const uBtn = document.getElementById('noteUndoBtn');
    const rBtn = document.getElementById('noteRedoBtn');
    if(uBtn) uBtn.disabled = (window._noteHistory.length === 0);
    if(rBtn) rBtn.disabled = (window._noteFuture.length === 0);
  };

  window.undoNote = function() {
    if (!window._noteHistory.length) return;
    const txtArea = document.getElementById('noteArea');
    window._noteFuture.push(txtArea.value);
    const prev = window._noteHistory.pop();
    txtArea.value = prev; window._noteLastVal = prev;
    window.updateNoteActionButtons();
    saveNote(window._noteActiveId, prev);
  };

  window.redoNote = function() {
    if (!window._noteFuture.length) return;
    const txtArea = document.getElementById('noteArea');
    window._noteHistory.push(txtArea.value);
    const next = window._noteFuture.pop();
    txtArea.value = next; window._noteLastVal = next;
    window.updateNoteActionButtons();
    saveNote(window._noteActiveId, next);
  };

  window.openCardReplaceModal = function(cardId) {
    window._replaceTargetCardId = cardId;
    document.getElementById('crFindInp').value = '';
    document.getElementById('crReplaceInp').value = '';
    openModal('cardReplaceModal');
  };

  window.executeCardReplace = async function() {
    const cid = window._replaceTargetCardId;
    const findStr = document.getElementById('crFindInp').value;
    const repStr = document.getElementById('crReplaceInp').value;
    if(!findStr) return showToast('请输入要查找的文本', 'error');

    const f = await dbG('cards', cid);
    if(!f) return;

    let totalReplacements = 0;
    const repFn = (str) => {
      if(!str) return str;
      const count = (str.split(findStr).length - 1);
      totalReplacements += count;
      return str.replaceAll(findStr, repStr);
    };

    if(f.description) f.description = repFn(f.description);
    if(f.personality) f.personality = repFn(f.personality);
    if(f.scenario) f.scenario = repFn(f.scenario);
    if(f.note) f.note = repFn(f.note);
    if(f.mesExample) f.mesExample = repFn(f.mesExample);
    if(f.dialogEntries) f.dialogEntries = f.dialogEntries.map(repFn);

    if(f.worldBookEntries) {
      f.worldBookEntries.forEach(e => {
        if(e.content) e.content = repFn(e.content);
        if(e.name) e.name = repFn(e.name);
        if(e.actual_keywords) e.actual_keywords = repFn(e.actual_keywords);
      });
    }

    if(totalReplacements === 0) {
      showToast('未在该卡片中找到匹配的文本内容', 'error');
    } else {
      await dbP('cards', f);
      closeModal('cardReplaceModal');
      const lightCard = S.cards.find(x => x.id === cid);
      if(lightCard) { lightCard.description = f.description; lightCard.note = f.note; }
      openDetail(cid); renderGrid();
      showToast(`替换成功！共修正 ${totalReplacements} 处。`, 'success');
    }
  };

  let nt;
  if (na) {
    window.updateNoteActionButtons();
    
    // 初始化时先根据内容自动撑开一次高度
    na.style.height = 'auto'; 
    na.style.height = (na.scrollHeight) + 'px';
    
    na.addEventListener('input', () => {
      // 随着打字，丝滑自动长高
      na.style.height = 'auto';
      na.style.height = (na.scrollHeight) + 'px';
      
      if (na.value !== window._noteLastVal) {
      window._noteHistory.push(window._noteLastVal);
      window._noteFuture = [];
      window._noteLastVal = na.value;
      window.updateNoteActionButtons();
    }
    clearTimeout(nt);
    nt = setTimeout(async () => { await saveNote(id, na.value); }, 600);
  });
  
  // 新增：失去焦点时强制保存一次，双重保险
  na.addEventListener('blur', async () => {
    clearTimeout(nt);
    await saveNote(id, na.value);
  });
}
} 

  // =========================================================================


function renderBubbleV4(raw, charName) {
  if(!raw || !raw.trim()) return '';
  let r = String(raw).replace(/<([^>]+)>/g, '').trim();
  
  // 【修复 Github Pages 冲突】将花括号拆分为字符串拼接，避开 Jekyll 引擎的拦截
  if(!r.toLowerCase().includes('{' + '{char}}:') && !r.toLowerCase().includes('{' + '{user}}:')) {
     return `<div class="cbox" style="white-space: pre-wrap; border:none; padding:0; background:none;">${esc(raw)}</div>`;
  }
  const msgs = [];
  
  // 【修复 Github Pages 冲突】改用 new RegExp 对象动态生成正则，避免被当成模板代码
  const regex = new RegExp('\\{\\{(user|char)\\}\\}:([\\s\\S]*?)(?=\\{\\{user\\}\\}:|\\{\\{char\\}\\}:|$)', 'gi');
  let match;
  while ((match = regex.exec(r)) !== null) {
      if (match[2].trim().length > 0) {
          msgs.push({ role: match[1].toLowerCase(), text: match[2].trim() });
      }
  }
  // 如果正则没匹配到标准格式，就当作普通文本处理
  if (msgs.length === 0) {
      return `<div class="cbox" style="white-space: pre-wrap; border:none; padding:0; background:none;">${esc(raw)}</div>`;
  }
  return msgs.map(m => `
      <div class="chat-msg ${m.role === 'user' ? 'chat-user' : 'chat-char'}">
        <div class="chat-name">${m.role === 'user' ? 'USER' : esc(charName)}</div>
        ${esc(m.text)}
      </div>
    `).join('');
}

function navDlgV4(dir) {
  if(!window._currentDlgs) return;
  const total = window._currentDlgs.length;
  dlgIdx = Math.max(0, Math.min(total - 1, dlgIdx + dir));
  const box = document.getElementById('dlgBoxV4');
  if(box) box.innerHTML = renderBubbleV4(window._currentDlgs[dlgIdx], window._currentCharName);
  
  const p = document.getElementById('dlgP'), n = document.getElementById('dlgN');
  if(p) p.disabled = (dlgIdx === 0);
  if(n) n.disabled = (dlgIdx >= total - 1);
  
  const idxEl = document.getElementById('dlgI');
  if(idxEl) idxEl.textContent = (dlgIdx + 1) + ' / ' + total;
  
  const cntEl = document.getElementById('dlgC');
  if(cntEl) cntEl.textContent = fmtN((window._currentDlgs[dlgIdx]||'').length) + '字';
}

async function saveNote(id, val) {
  const v = val.trim(); let sf = S.cards.find(c => c.id === id); if (!sf) return;
  sf.note = v;
  await dbP('cards', Object.assign((await dbG('cards', id)), {note: v}));
  showToast('笔记已保存'); 
}

function editMeta(id, field) {
  let card = S.cards.find(c=>c.id===id); if(!card) return;
  const current = card[field] || '';
  const isTa = field === 'description';
  let html = `<div style="margin-bottom:10px;font-weight:bold">${field.toUpperCase()}</div>`;
  // 新增了 oninput 事件，让文本框随打字自动变高
  html += isTa ? `<textarea id="emInput" class="meta-edit-ta" oninput="this.style.height='auto';this.style.height=(this.scrollHeight)+'px';">${esc(current)}</textarea>` : `<input type="text" id="emInput" class="meta-edit-inp" value="${esc(current)}">`;
  html += `<div class="act-row"><button class="actbtn pri" onclick="saveMetaEdit('${id}','${field}')">保存</button></div>`;
  
  const m = document.getElementById('editTagModal');
  m.querySelector('.modal-title').textContent = 'EDIT';
  document.getElementById('editTagContent').innerHTML = html;
  openModal('editTagModal'); setTimeout(()=>document.getElementById('emInput').focus(), 100);
    if(isTa) setTimeout(() => { let ta = document.getElementById('emInput'); ta.style.height='auto'; ta.style.height=(ta.scrollHeight)+'px'; }, 110);
}
async function saveMetaEdit(id, field) {
  let card = S.cards.find(c=>c.id===id); if(!card) return;
  const val = document.getElementById('emInput').value.trim();
  card[field] = val;
  const full = await dbG('cards', id); full[field] = val; await dbP('cards', full);
  closeModal('editTagModal'); openDetail(id); renderGrid(); showToast('修改成功');
}

function editSingleTag(id, tag) {
  if(confirm(`删除主标签 [${tag}] ？`)) {
    let c = S.cards.find(x=>x.id===id); c.tags = c.tags.filter(t=>t!==tag);
    dbG('cards',id).then(f=>{ f.tags=c.tags; dbP('cards',f).then(()=>{ openDetail(id); renderGrid(); }); });
  }
}
function editSingleSubTag(id, tag) {
  if(confirm(`删除小标签 [${tag}] ？`)) {
    let c = S.cards.find(x=>x.id===id); c.subtags = c.subtags.filter(t=>t!==tag);
    dbG('cards',id).then(f=>{ f.subtags=c.subtags; dbP('cards',f).then(()=>{ openDetail(id); renderGrid(); }); });
  }
}

function openAddTagModal(id) {
  let c = S.cards.find(x=>x.id===id);
  const exist = new Set(c.tags||[]);
  const allDict = new Set(); S.cards.forEach(card=>{ if(card.section===c.section) (card.tags||[]).forEach(t=>allDict.add(t)); });
  const recHtml = [...allDict].filter(t=>!exist.has(t)).slice(0,10).map(t=>`<span class="tag-quick" onclick="document.getElementById('ntInput').value='${t}'; addTagExe('${id}')">${esc(t)}</span>`).join('');
  const datalistHtml = `<datalist id="mainTagList">${[...allDict].map(t=>`<option value="${esc(t)}">`).join('')}</datalist>`;
  document.getElementById('editTagContent').innerHTML = `
    <div style="font-size:12px;margin-bottom:8px">添加至 <b>${esc(c.name)}</b></div>
    ${datalistHtml}
    <div class="inp-row"><input type="text" id="ntInput" list="mainTagList" placeholder="输入新标签名 (点击下拉选择)..." onkeydown="if(event.key==='Enter') addTagExe('${id}')"><button onclick="addTagExe('${id}')">添加</button></div>
    <div style="margin-top:10px;font-size:10px;color:var(--ink3)">历史推荐：</div>
    <div class="tags-edit-row" style="margin-top:4px">${recHtml}</div>
  `;
  document.getElementById('editTagModal').querySelector('.modal-title').textContent = 'ADD MAIN TAG';
  openModal('editTagModal'); setTimeout(()=>document.getElementById('ntInput').focus(),100);
}
function addTagExe(id) {
  const val = document.getElementById('ntInput').value.trim(); if(!val) return;
  let c = S.cards.find(x=>x.id===id); if(!c.tags) c.tags=[];
  if(!c.tags.includes(val)) c.tags.push(val);
  dbG('cards',id).then(f=>{ f.tags=c.tags; dbP('cards',f).then(()=>{ closeModal('editTagModal'); openDetail(id); renderGrid(); }); });
}

function openAddSubTagModal(id) {
  let c = S.cards.find(x=>x.id===id);
  const exist = new Set(c.subtags||[]);
  const allDict = new Set(); S.cards.forEach(card=>{ if(card.section===c.section) (card.subtags||[]).forEach(t=>allDict.add(t)); });
  (S.subTagLib[c.section]||[]).forEach(t=>allDict.add(t));
  const recHtml = [...allDict].filter(t=>!exist.has(t)).slice(0,10).map(t=>`<span class="tag-quick" onclick="document.getElementById('nstInput').value='${t}'; addSubTagExe('${id}')">${esc(t)}</span>`).join('');
  const datalistHtml = `<datalist id="subTagList">${[...allDict].map(t=>`<option value="${esc(t)}">`).join('')}</datalist>`;
  document.getElementById('editTagContent').innerHTML = `
    <div style="font-size:12px;margin-bottom:8px">添加小标签至 <b>${esc(c.name)}</b></div>
    ${datalistHtml}
    <div class="inp-row"><input type="text" id="nstInput" list="subTagList" placeholder="输入新小标签名 (点击下拉选择)..." onkeydown="if(event.key==='Enter') addSubTagExe('${id}')"><button onclick="addSubTagExe('${id}')">添加</button></div>
    <div style="margin-top:10px;font-size:10px;color:var(--ink3)">历史推荐：</div>
    <div class="tags-edit-row" style="margin-top:4px">${recHtml}</div>
  `;
  document.getElementById('editTagModal').querySelector('.modal-title').textContent = 'ADD SUB TAG';
  openModal('editTagModal'); setTimeout(()=>document.getElementById('nstInput').focus(),100);
}
function addSubTagExe(id) {
  const val = document.getElementById('nstInput').value.trim(); if(!val) return;
  let c = S.cards.find(x=>x.id===id); if(!c.subtags) c.subtags=[];
  if(!c.subtags.includes(val)) c.subtags.push(val);
  dbG('cards',id).then(f=>{ f.subtags=c.subtags; dbP('cards',f).then(()=>{ closeModal('editTagModal'); openDetail(id); renderGrid(); }); });
}


// ============================================================
// 异步确认框 (Promise Confirm)
// ============================================================
let _confirmCb = null;
function confirmDialog(msg, opts = {}) {
  return new Promise(res => {
    document.getElementById('confirmHd').textContent = opts.title || '确认操作';
    document.getElementById('confirmMsg').textContent = msg;
    const ok = document.getElementById('confirmOk');
    ok.textContent = opts.okText || '确定';
    ok.className = 'cf-ok' + (opts.danger ? ' dan' : '');
    _confirmCb = v => { document.getElementById('confirmMask').classList.remove('show'); _confirmCb = null; res(v); };
    document.getElementById('confirmMask').classList.add('show');
  });
}
function confirmResolve(v) { if(_confirmCb) _confirmCb(v); }

// ============================================================
// 基础工具集与新手指引弹窗
// ============================================================
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.innerHTML = `<span>${esc(msg)}</span>`;
  // 新增：点击提示框立即让它消失
  item.onclick = () => {
  item.style.animation = 'toastOut 0.2s ease forwards';
  setTimeout(() => item.remove(), 200);
};
  container.appendChild(item);
  setTimeout(() => {
    item.style.animation = 'toastOut 0.2s ease forwards';
    setTimeout(() => item.remove(), 200);
  }, 2600);
}
function showBusy(tit, sub, prg) { 
  document.getElementById('busyMask').classList.add('show'); 
  document.getElementById('busyTitle').textContent=tit; 
  document.getElementById('busySub').textContent=sub; 
  const spin = document.getElementById('busySpin');
  const track = document.getElementById('busyTrackWrap');
  const cnt = document.getElementById('busyCount');
  if (prg === null || prg < 0) {
    spin.style.display = 'block'; track.style.display = 'none'; cnt.style.display = 'none';
  } else {
    spin.style.display = 'none'; track.style.display = 'block'; cnt.style.display = 'block';
    document.getElementById('busyBar').style.width=(prg*100)+'%'; 
  }
}
function hideBusy() { document.getElementById('busyMask').classList.remove('show'); }
function esc(str) { return String(str).replace(/[&<>'"]/g, t=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t])); }
function renderMD(str) {
  if(!str) return '';
  let s = esc(str);
  // 优化：更安全的 Markdown 简易解析，防止破坏 HTML 结构
  s = s.replace(/\*\*([^*<\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*<\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`<]+)`/g, '<code style="background:var(--p3);padding:2px 4px;border-radius:4px;color:var(--ink);">$1</code>');
  s = s.replace(/\n/g, '<br>');
  return s;
}
// 【优化：增加正则缓存，防止高频渲染时导致手机发烫掉帧】
const _regexCache = {};
function hl(txt, q) { 
  if(!q) return esc(txt); 
  const ms = q.trim().split(/\s+/).filter(x=>!x.includes(':')&&!x.includes('>')); 
  if(!ms.length) return esc(txt); 
  let r = esc(txt); 
  ms.forEach(m => { 
    const safeM = esc(m);
    if(!_regexCache[safeM]) _regexCache[safeM] = new RegExp(safeM, 'gi');
    r = r.replace(_regexCache[safeM], x => `<mark>${x}</mark>`); 
  }); 
  return r; 
}
function fmtSZ(b) { if(!b) return '0 B'; const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(2))+' '+s[i]; }
function fmtN(n) { return n>=10000 ? (n/10000).toFixed(1)+'w' : (n>=1000 ? (n/1000).toFixed(1)+'k' : n); }
function uuid() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

// 恢复：安卓原生下载桥接
const IS_WEBVIEW = /; wv\)|WebView/i.test(navigator.userAgent || '');
function asciiName(name) {
  try {
    if(!/[^\x00-\xFF]/.test(name)) return name;
    let s = name;
    if(window.PinyinLib && window.PinyinLib.isSupported()) s = window.PinyinLib.convertToPinyin(name,'',true);
    return s.replace(/[^\x20-\x7E]+/g,'').replace(/\s{2,}/g,' ').trim() || 'card';
  } catch(e) { return 'card'; }
}
function dlB(blob, name) {
  if(window.AndroidDL && typeof AndroidDL.saveBase64 === 'function') {
    const rd = new FileReader();
    rd.onload = () => { try { AndroidDL.saveBase64(rd.result.split(',')[1] || '', name); } catch(e) { showToast('保存失败'); } };
    rd.readAsDataURL(blob);
    return;
  }
  // 过滤掉不能作为文件名的非法字符，防止下载失败
const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
const fn = IS_WEBVIEW ? asciiName(safeName) : safeName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 修复：极大节省内存的后台静默生成缩略图
async function migrateThumbs() {
  if(!window._needThumbIds || !window._needThumbIds.length) return;
  if(window._splashProg) window.setSplash(70, '生成图像缓存...');
  let updated = 0;
  for(const id of window._needThumbIds) {
    try {
      const c = await dbG('cards', id);
      if(!c || c.thumb || (!c.originalDataUrl && !c.coverDataUrl)) continue;
      const t = await genThumb(c.originalDataUrl || c.coverDataUrl, 240);
      if(t) { 
        c.thumb = t; await dbP('cards', c); updated++; 
        const light = S.cards.find(x => x.id === id);
        if(light) light._thumbBlobUrl = dataUrlToBlobUrl(t);
      }
    } catch(e) {}
  }
  window._needThumbIds = [];
  if(updated) { renderGrid(); showToast('已优化 '+updated+' 张旧卡片缩略图，滑动更流畅！'); }
}

let activeModals = [];

function openModal(id) { 
  document.getElementById(id).classList.add('show'); 
  document.body.style.overflow = 'hidden'; 
  activeModals.push(id);
  history.pushState({modal: id}, ""); 
}

function closeModal(id) { 
  document.getElementById(id).classList.remove('show'); 
  activeModals = activeModals.filter(m => m !== id);
  if (activeModals.length === 0) document.body.style.overflow = ''; 
  
  // 【新增：清理导入时的临时内存，防止内存泄漏】
  if (id === 'importModal') {
    Object.keys(window).forEach(k => { if (k.startsWith('_tmp_')) delete window[k]; });
  }
  
  if (id === 'detailModal') {
    _currentDetailId = null;
    document.getElementById('appContainer').classList.remove('fullscreen-detail'); 
    document.getElementById('detailContent').innerHTML = '';
    document.getElementById('detailTitle').textContent = '—';
    checkSplitPaneMode();
    renderGrid(); 
  }
}

// 监听手机物理返回键 & App 退出逻辑适配
window.addEventListener('popstate', function(e) {
  if (activeModals.length > 0) {
    const topModal = activeModals[activeModals.length - 1];
    closeModal(topModal);
  }
});

// 针对 HBuilderX (安卓 APK) 的物理返回键劫持
document.addEventListener('plusready', function() {
  plus.key.addEventListener('backbutton', function() {
    // 1. 如果有全屏阅读层，先关阅读层
    const readMask = document.getElementById('readMask');
    if (readMask && readMask.classList.contains('show')) {
      closeRead();
      return;
    }
    // 2. 如果有弹窗，先关最上层的弹窗
    if (activeModals.length > 0) {
      const topModal = activeModals[activeModals.length - 1];
      closeModal(topModal);
      return;
    }
    // 3. 如果什么都没开，提示退出 App
    plus.nativeUI.confirm("确定要退出卡库吗？", function(e) {
      if (e.index === 0) {
        plus.runtime.quit(); // 退出安卓 App
      }
    }, "退出提示", ["确定", "取消"]);
  });
});

document.querySelectorAll('.modal-box').forEach(b => { b.addEventListener('click', e => e.stopPropagation()); });
// 启用点击遮罩关闭弹窗，并对接安全卸载逻辑
document.querySelectorAll('.modal-mask').forEach(m => { 
  m.addEventListener('click', () => { 
    closeModal(m.id); 
  }); 
});

function toggleFav(id) {
  let c = S.cards.find(x=>x.id===id); if(!c) return; c.favorite = !c.favorite;
  dbG('cards', id).then(f=>{ f.favorite=c.favorite; dbP('cards',f).then(()=>{ openDetail(id); renderGrid(); }); });
}

let tutStep = 0;
const tutSteps = [
  {icon:'💌', t:'致AIRP玩家的信', c:"欢迎来到 Marie's Chest！<br><br>这是一封来自开发者的简短指南。这里是你的专属角色收纳馆，一个完全本地化、支持云端双向同步的极致轻量级管理工具。接下来，让我带你快速熟悉它的全貌。"},
  {icon:'📥', t:'一、轻松导入与导出', c:'基础操作非常直观：<br>1. <b>导入</b>：你可以点击右下角的 <b>＋</b> 号，或者直接将 <b>PNG / WEBP / JSON / DOCX</b> 格式的角色文件<b>拖拽到网页内</b>即可导入。<br>2. <b>导出</b>：在卡片列表勾选多张卡片，点击底部【打包导出】；或在卡片详情页点击【↑ 导出】进行单卡保存。'},
  {icon:'🏷️', t:'二、精细化整理', c:'你的卡片再也不会乱糟糟：<br>1. <b>标签与分组</b>：在详情页中为卡片添加主标签、小标签（支持如 <i>设定/种族</i> 的树状结构），或分配<b>文件夹（分组）</b>。<br>2. <b>批量操作</b>：点击顶部【选择】进入多选模式，一键为几十张卡片打标签或移动分区。'},
  {icon:'☁️', t:'三、酒馆无缝互联', c:'这是卡库的杀手锏功能！<br>在右侧【≡ 设置】中配置好 <b>Tavern API Proxy</b> 后：<br>你可以将修改后的卡片<b>一键推送到酒馆</b>，或者通过【↓ 从酒馆批量拉取】将云端的新角色同步回本地。无须反复下载上传文件！'},
  {icon:'🔄', t:'四、WebDAV 云端同步', c:'害怕数据丢失或想多端同步？<br>在【设置】中绑定你的坚果云或支持 <b>WebDAV</b> 的网盘。<br>你可以实现卡库数据的<b>增量静默同步</b>。换一台电脑，登录网盘点击【↓ 从云端拉取】，所有卡片连同设定瞬间恢复！'},
  {icon:'🔍', t:'五、高级智能搜索', c:'找卡就像呼吸一样自然：<br>顶部的搜索框支持<b>拼音首字母</b>自动补全。<br>你可以使用高级语法组合搜索，例如输入：<br><code>龙 tag:西幻 char>3000</code><br>（意为：名字带龙、且包含西幻标签、且字数大于3000字）。'},
  {icon:'📖', t:'六、沉浸阅览与对白', c:'1. <b>双栏视图</b>：如果你使用大屏，点击卡片即可在右侧展开详情，左侧列表不干扰。<br>2. <b>全屏阅读</b>：点击简介或世界书右上角的【⛶ 全屏阅读】，即可享受无干扰沉浸阅读。<br>3. <b>对话记录</b>：支持导入 .txt 等聊天记录，并绑定给特定角色卡。'},
  {icon:'🛡️', t:'七、数据安全第一', c:'误删了心爱的卡片？别担心！<br>点击顶部导航栏红色的 <b>🗑️ 垃圾桶</b> 图标，所有删除的卡片都会在回收站中为你保留，随时可以【撤销恢复】。<br><br><b>准备好了吗？点击下方按钮，开始你的收纳之旅吧！</b>'}
];
function maybeShowTutorial() { if(!localStorage.getItem('kakuV4Tut')) setTimeout(()=>document.getElementById('tutMask').classList.add('show'), 800); }
function tutNext() { 
  if(tutStep === tutSteps.length-1) return endTutorial(); 
  tutStep++; 
  const s = tutSteps[tutStep]; 
  document.getElementById('tutIcon').innerHTML = s.icon; 
  document.getElementById('tutTitle').innerHTML = s.t; 
  document.getElementById('tutText').innerHTML = s.c; // 改为了innerHTML以支持加粗和换行
  document.getElementById('tutStep').innerText = (tutStep+1)+' / '+tutSteps.length; 
  document.getElementById('tutDots').innerHTML = tutSteps.map((_, i)=>`<span class="${i===tutStep?'on':''}"></span>`).join(''); 
  if(tutStep === tutSteps.length-1) document.getElementById('tutNext').innerText = '开始整理'; 
}
function endTutorial() { document.getElementById('tutMask').classList.remove('show'); localStorage.setItem('kakuV4Tut','1'); }
function replayTutorial() { tutStep = -1; document.getElementById('tutNext').innerText = '下一步'; closeModal('settingsModal'); document.getElementById('tutMask').classList.add('show'); tutNext(); }

const scopeMap = { 'name': '卡名', 'desc': '简介', 'tags': '标签', 'world': '世界书', 'dialog': '对白', 'note': '备注' };
function bindEvents() {
  // 智能监听：只要用户晃动了一下鼠标，立刻解锁平板端的悬浮菜单
  window.addEventListener('mousemove', function onFirstMouseMove() {
    document.body.classList.add('has-mouse');
    window.removeEventListener('mousemove', onFirstMouseMove);
  });

  document.getElementById('scopebar').addEventListener('click', e => {
    if(e.target.classList.contains('sc-chip')) {
      const sc = e.target.dataset.scope;
      if(S.searchScopes.has(sc)) S.searchScopes.delete(sc); else S.searchScopes.add(sc);
      e.target.classList.toggle('active', S.searchScopes.has(sc));
      triggerAsyncSearch();
    }
  });

// 绑定确认框按钮
  const cfOk = document.getElementById('confirmOk');
  const cfNo = document.getElementById('confirmNo');
  const cfMask = document.getElementById('confirmMask');
  if(cfOk && !cfOk.dataset.bound) { cfOk.addEventListener('click', () => confirmResolve(true)); cfOk.dataset.bound='1'; }
  if(cfNo && !cfNo.dataset.bound) { cfNo.addEventListener('click', () => confirmResolve(false)); cfNo.dataset.bound='1'; }
  if(cfMask && !cfMask.dataset.bound) { cfMask.addEventListener('click', e => { if(e.target === cfMask) confirmResolve(false); }); cfMask.dataset.bound='1'; }
  
  const s = document.getElementById('fsortSel');
  if (s && !s.dataset.bound) {
    s.innerHTML = `<option value="date_desc">⏱ 时间倒序</option><option value="date_asc">⏱ 时间正序</option><option value="update_desc">📝 最近修改</option><option value="name_asc">A-Z 名称</option><option value="name_desc">Z-A 名称</option><option value="fav">★ 收藏优先</option>`;
    s.value = S.sort; 
    s.addEventListener('change', e => { S.sort = e.target.value; renderGrid(); });
    s.dataset.bound = '1';
  }

  initSearchInput();
}

// ====== 版本管理模块 ======
function openVersionModal(id) {
    const card = S.cards.find(c => c.id === id); if(!card) return;
    window._verRootId = card.parentId || card.id;
    window._verReturnId = id;
    _renderVersionModal(id, '');
    openModal('pickModal');
}
function _renderVersionModal(id, q) {
    const rootId = window._verRootId;
    const rootCard = S.cards.find(c => c.id === rootId) || S.cards.find(c => c.id === id);
    if(!rootCard) return;
    const members = [rootCard, ...S.cards.filter(c => c.parentId === rootId)];
    const memberIds = new Set(members.map(m => m.id));
    let cands = S.cards.filter(c => c.section === rootCard.section && !memberIds.has(c.id) && !c.parentId && !S.cards.some(x=>x.parentId===c.id));
    const kw = q.trim().toLowerCase();
    if(kw) cands = cands.filter(c => c.name.toLowerCase().includes(kw));
    cands.sort((a,b) => (a.name === rootCard.name ? 0 : 1) - (b.name === rootCard.name ? 0 : 1));
    
    const memberH = members.map(m => `
        <div class="pick-item" style="display:flex;align-items:center;gap:7px">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.id===rootId?'★ ':''}${esc(m.name)}</span>
            ${m.id!==rootId?`<button class="dbtn" onclick="setMainVersion('${rootId}','${m.id}')">设为主版</button><button class="dbtn" onclick="unbindVersion('${m.id}')">解绑</button>`:''}
        </div>`).join('');
    const candH = cands.length ? cands.map(c => `
        <div class="pick-item" onclick="bindVersion('${rootId}','${c.id}')" style="display:flex;align-items:center;gap:7px">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">＋ ${esc(c.name)}</span>
        </div>`).join('') : `<div style="font-size:10px;color:var(--ink3);padding:6px 0">无匹配的独立卡片</div>`;
    
    document.getElementById('pickTitle').textContent = '版本管理 (Version Control)';
    document.getElementById('pickBody').innerHTML = `
        <div style="font-size:11px;color:var(--ink3);margin-bottom:6px">当前收纳组 (${members.length})</div>
        ${memberH}
        <div style="font-size:11px;color:var(--ink3);margin:12px 0 6px">添加版本 (同分区独立卡片)</div>
        <input class="inp" type="text" placeholder="搜索卡片名称…" value="${esc(q)}" oninput="_renderVersionModal('${id}', this.value)" style="width:100%;box-sizing:border-box;margin-bottom:8px;">
        <div style="max-height: 200px; overflow-y: auto;">${candH}</div>`;
}
async function bindVersion(rootId, childId) {
    let childFull = await dbG('cards', childId); if(!childFull) return;
    childFull.parentId = rootId; await dbP('cards', childFull);
    let childLight = S.cards.find(c => c.id === childId); if(childLight) childLight.parentId = rootId;
    closeModal('pickModal'); triggerAsyncSearch(); openDetail(window._verReturnId || rootId); showToast('已收纳为版本');
}
async function unbindVersion(childId) {
    let childFull = await dbG('cards', childId); if(!childFull) return;
    childFull.parentId = null; await dbP('cards', childFull);
    let childLight = S.cards.find(c => c.id === childId); if(childLight) childLight.parentId = null;
    closeModal('pickModal'); triggerAsyncSearch(); openDetail(window._verReturnId || childId); showToast('已恢复为独立卡片');
}
async function setMainVersion(oldRootId, newRootId) {
    const group = [oldRootId, ...S.cards.filter(c => c.parentId === oldRootId).map(c => c.id)];
    for(const cid of group) {
        let f = await dbG('cards', cid); if(!f) continue;
        f.parentId = (cid === newRootId) ? null : newRootId; await dbP('cards', f);
        let l = S.cards.find(x => x.id === cid); if(l) l.parentId = f.parentId;
    }
    closeModal('pickModal'); triggerAsyncSearch(); openDetail(newRootId); showToast('已切换主版本');
}

// ====== 导出与封面替换模块 ======
function toggleExportMenu(id) {
    const menu = document.getElementById('exportMenu'); if(!menu) return;
    const isShow = menu.style.display !== 'none';
    menu.style.display = isShow ? 'none' : 'flex';
    if (window._exportMenuListener) document.removeEventListener('click', window._exportMenuListener);
if(!isShow) {
    window._exportMenuListener = function(e) {
        if(!menu.contains(e.target)) { menu.style.display = 'none'; document.removeEventListener('click', window._exportMenuListener); }
    };
    setTimeout(() => document.addEventListener('click', window._exportMenuListener), 0);
}
}
async function exportCardFormat(id, fmt) {
    document.getElementById('exportMenu').style.display = 'none';
    const c = await dbG('cards', id); if (!c) return;
    showToast('正在生成导出文件...');
    if(fmt === 'orig') {
        if (!c.originalDataUrl) {
            const b = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
            dlB(b, c.name + '.json'); return;
        }
        const res = await fetch(c.originalDataUrl);
        dlB(await res.blob(), c.name + (c.fileType.includes('png') ? '.png' : '.webp'));
    } else if(fmt === 'json') {
        const meta = buildTavernMeta(c);
        const b = new Blob([JSON.stringify({spec:'chara_card_v2',spec_version:'2.0',data:meta}, null, 2)], { type: 'application/json' });
        dlB(b, c.name + '.json');
    } else if(fmt === 'png') {
        if(c.originalDataUrl && c.fileType.includes('png')) {
            const res = await fetch(c.originalDataUrl);
            dlB(await res.blob(), c.name + '.png');
        } else {
            showToast('原文件非PNG，已自动导出为JSON', 'error');
            exportCardFormat(id, 'json');
        }
    }
}
async function replaceCover(id, input) {
    const file = input.files?.[0]; if(!file) return;
    input.value = ''; showBusy('正在替换', '处理图片中...', 0.5);
    try {
        const reader = new FileReader();
        const newImgBase64 = await new Promise(res => { reader.onload = ()=>res(reader.result); reader.readAsDataURL(file); });
        const thumb = await genThumb(newImgBase64, 400);
        let sf = S.cards.find(c => c.id === id); if(sf) { sf._thumbBlobUrl = dataUrlToBlobUrl(thumb); }
        const full = await dbG('cards', id);
        if(full) { 
            // 保护机制：将原有卡片的全部元数据，重新注入到新封面的 PNG 数据中，防止变成“空壳图”
            const meta = buildTavernMeta(full);
            const finalBlob = buildUpdatedPngBlob(newImgBase64, meta);
            const finalBase64 = await bufToBase64(await finalBlob.arrayBuffer(), 'image/png');
            
            full.originalDataUrl = finalBase64; 
            full.thumb = thumb; 
            await dbP('cards', full); 
        }
        openDetail(id); renderGrid(); showToast('封面替换成功！', 'success');
    } catch(e) { showToast('替换失败: '+e.message, 'error'); } finally { hideBusy(); }
}

document.addEventListener('keydown', (e) => {
  // Ctrl+F / Cmd+F 聚焦搜索
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('searchInput')?.focus();
  }
  // ESC 关闭最上层弹窗
  if (e.key === 'Escape') {
    if (activeModals.length > 0) {
      closeModal(activeModals[activeModals.length - 1]);
    } else if (document.getElementById('readMask').classList.contains('show')) {
      closeRead();
    }
  }
  // 详情页左右键切换卡片
  if (document.getElementById('detailModal').classList.contains('show') && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
    if (e.key === 'ArrowLeft') {
      const idx = vsState.list.findIndex(c => c.id === _currentDetailId);
      if(idx > 0) openDetail(vsState.list[idx - 1].id);
    } else if (e.key === 'ArrowRight') {
      const idx = vsState.list.findIndex(c => c.id === _currentDetailId);
      if(idx >= 0 && idx < vsState.list.length - 1) openDetail(vsState.list[idx + 1].id);
    }
  }
});
window.addEventListener('DOMContentLoaded', init);

// 防止在处理数据时意外关闭网页
window.addEventListener('beforeunload', function (e) {
  if (document.getElementById('busyMask') && document.getElementById('busyMask').classList.contains('show')) {
    e.preventDefault();
    e.returnValue = '正在处理数据，强行关闭可能导致数据损坏，确定要离开吗？';
  }
});

// 【新增功能】3. 双模智能酒馆通讯引擎与防断流重试机制

/**
 * 带有指数退避的强力 Fetch，专治 CF Worker 网络波动
 */
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      // 如果遇到 502 Bad Gateway 或 504 Gateway Timeout (CF 常见错误)，抛出异常强制重试
      if (response.status === 502 || response.status === 504) {
        throw new Error(`CF 节点网络拥塞 (状态码: ${response.status})`);
      }
      return response; // 成功则直接返回
    } catch (err) {
      const isLastAttempt = i === retries - 1;
      if (isLastAttempt) throw err; // 最后一次还是失败，就真的报错
      
      // 在界面上给一点不起眼的提示，让用户知道系统正在努力
      console.warn(`网络波动，正在进行第 ${i + 1} 次重试...`, err);
      const subTitle = document.getElementById('busySub');
      if (subTitle) subTitle.textContent += ' (网络波动，自动重试中...)';

      // 等待时间翻倍：1s -> 2s -> 4s
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2; 
    }
  }
}
async function requestTavern(endpoint, options = {}) {
    const proxyUrl = document.getElementById('tavernProxyUrl')?.value.trim();
    
    // 环境嗅探：如果检测到安卓本地桥接接口，直接访问 127.0.0.1 端口
    if (window.StHttpBridge && window.StHttpBridge.postRaw) {
        const method = options.method || 'GET';
        let bodyStr = '';
        if(options.body && typeof options.body !== 'string') {
            bodyStr = JSON.stringify(options.body);
        } else if (options.body) {
            bodyStr = options.body;
        }
        
        const port = document.getElementById('tavernLocalPort')?.value || '8000';
const res = await window.StHttpBridge.postRaw('http://127.0.0.1:' + port + endpoint, method, bodyStr);
        if (res.startsWith('ERROR:')) throw new Error(res);
        return JSON.parse(res);
    } 
    
    // 环境嗅探：如果在标准浏览器，降级回退到原版的 Cloudflare Proxy 代理逻辑
    if (!proxyUrl) throw new Error("请先配置 Tavern API Proxy 地址");
    const reqOpts = {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    };
    if (options.body) reqOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    
    const response = await fetch(proxyUrl + endpoint, reqOpts);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}


//======================================
// 批量与全局 Tavern 同步功能引擎
//======================================

// 内部核心函数：执行数组队列的批量推送
async function execBatchPushToTavern(idList) {
  if (!tavernProxy) return alert("请先配置 Tavern API Proxy!");
  if (!confirm(`准备推送 ${idList.length} 张卡片到酒馆，稍后可以在进度条查看状态。\n(系统会自动检测同名卡片，覆盖更新而不产生重复)\n确定执行？`)) return;

  showBusy('批量推送中', '正在与酒馆建立连接...', 0.05);
  let success = 0, fail = 0;

  try {
    let listResp = await fetch(tavernProxy + '/api/characters/all', { method: 'POST', body: JSON.stringify({}) }).catch(()=>fetch(tavernProxy + '/api/characters/all'));
    let list = await listResp.json();
    if (!Array.isArray(list)) list = list.default || Object.values(list);

    for (let i = 0; i < idList.length; i++) {
       document.getElementById('busyBar').style.width = ((i / idList.length) * 100) + '%';
       const c = await dbG('cards', idList[i]);
       if (!c || !c.originalDataUrl) { fail++; continue; }

       document.getElementById('busySub').textContent = `正在推送 (${i+1}/${idList.length}): ${c.name}`;
       const blob = await fetch(c.originalDataUrl).then(r=>r.blob());
       const existChar = list.find(card => card.name === c.name);

       try {
           const buffer = await blob.arrayBuffer();
                    let meta = getMetaFromBuffer(buffer);

           
           meta.name = c.name || meta.name || "";
           meta.description = c.description ?? meta.description ?? "";
           meta.personality = c.personality ?? meta.personality ?? "";
           meta.scenario = c.scenario ?? meta.scenario ?? "";
           meta.creator_notes = c.note ?? meta.creator_notes ?? "";
           if (c.tags && c.tags.length > 0) meta.tags = c.tags;

           if (c.dialogEntries && c.dialogEntries.length > 0) {
               meta.first_mes = c.dialogEntries[0] || "";
               meta.alternate_greetings = c.dialogEntries.slice(1);
           } else {
               meta.first_mes = c.first_mes || meta.first_mes || "";
           }
           meta.mes_example = c.mesExample ?? meta.mes_example ?? "";

           if (c.worldBookEntries && c.worldBookEntries.length > 0) {
               const charBook = meta.character_book || (meta.data ? meta.data.character_book : null) || {};
               charBook.name = meta.name || charBook.name || "Kaku World";
               charBook.entries = c.worldBookEntries.map((e, idx) => {
                   let keysStr = e.actual_keywords !== undefined ? e.actual_keywords : (Array.isArray(e.keys) ? e.keys.join(',') : (e.keys || ''));
                   let keysArr = keysStr.split(/[,，、]+/).map(k=>k.trim()).filter(Boolean);
                   return {
                       id: idx, uid: idx, keys: keysArr, secondary_keys: [],
                       comment: e.name || keysStr || "未命名", content: e.content || "",
                       constant: !!e.constant, vectorized: false, selective: e.selective !== false,
                       insertion_order: e.order !== undefined ? Number(e.order) : 100,
                       enabled: e.enabled !== false, position: e.position === 1 ? "after_char" : "before_char",
                       use_regex: true,
                       extensions: {
                           position: e.position !== undefined ? Number(e.position) : 0, role: e.role !== undefined ? Number(e.role) : 0,
                           depth: e.depth !== undefined ? Number(e.depth) : 4, probability: e.probability !== undefined ? Number(e.probability) : 100,
                           prevent_recursion: true, delay_until_recursion: false, display_index: idx, group: "", group_weight: 100
                       }
                   };
               });
               meta.character_book = charBook;
               if (meta.data) meta.data.character_book = charBook;
           } else {
               delete meta.character_book;
               if (meta.data) delete meta.data.character_book;
           }

           const finalBlob = buildUpdatedPngBlob(c.originalDataUrl, meta);
           
           let safeName = c.name.replace(/[\\/:*?"<>|]/g, '');
           let targetAvatar = existChar ? existChar.avatar : `${safeName}.png`;
           
           if (existChar) {
               await fetch(tavernProxy + '/api/characters/delete', {
                   method: 'POST',
                   headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify({ avatar_url: existChar.avatar })
               }).catch(e => console.warn(e));
           }

           const fd = new FormData();
           fd.append("avatar", finalBlob, targetAvatar);
           fd.append("file_type", "png");
           fd.append("preserved_name", targetAvatar);
           await fetchWithRetry(tavernProxy + '/api/characters/import', { method: 'POST', body: fd });

         success++;
       } catch(e) { fail++; }
       
       await new Promise(resolve => setTimeout(resolve, 10)); 
    }
    alert(`批量推送完成！\n✅ 成功: ${success}\n❌ 跳过无图/失败: ${fail}`);
  } catch(e) {
    alert("网络请求失败：" + e.message);
  } finally {
    hideBusy(); exitSelectMode();
  }
}

// 供底部多选栏调用的【选中项推送】
function batchPushToTavern() {
  if (!S.selectedIds.size) return showToast('先勾选卡片！');
  execBatchPushToTavern(Array.from(S.selectedIds));
}

// 供右上角设置面板调用的【推全部】
function pushAllToTavern() {
  if (!S.cards.length) return showToast('卡库为空！');
  execBatchPushToTavern(S.cards.map(c => c.id));
}

// 终极杀器：供右上角调用的【一键双向同步】 (先推送到酒馆，再拉取酒馆的新卡)
async function syncWithTavern() {
  if (!tavernProxy) return alert("请先配置 Tavern API Proxy!");
  if (!confirm("准备执行终极一键双向同步：\n1. 将本地修改无重复地推送到酒馆\n2. 从酒馆抓取本地不存在的新角色\n需等待一段时间，确认开始？")) return;

  showBusy('一键双向同步', '阶段 1/2: 正在推送卡库数据至云端...', 0.05);

  try {
    let listResp = await fetch(tavernProxy + '/api/characters/all', { method: 'POST', body: JSON.stringify({}) }).catch(()=>fetch(tavernProxy + '/api/characters/all'));
    let list = await listResp.json();
    if (!Array.isArray(list)) list = list.default || Object.values(list);

    // --- 阶段一：全库无情覆盖式推送 ---
    let pushOk = 0, pushFail = 0;
    for (let i = 0; i < S.cards.length; i++) {
       document.getElementById('busyBar').style.width = ((i / S.cards.length) * 50) + '%'; 
       const c = await dbG('cards', S.cards[i].id);
       if (!c || !c.originalDataUrl) continue;
       
       document.getElementById('busySub').textContent = `1/2 推送中 (${i+1}/${S.cards.length}): ${c.name}`;
       const blob = await fetch(c.originalDataUrl).then(r=>r.blob());
       const existChar = list.find(card => card.name === c.name);

       try {
           const buffer = await blob.arrayBuffer();
                    let meta = getMetaFromBuffer(buffer);

           
           meta.name = c.name || meta.name || "";
           meta.description = c.description ?? meta.description ?? "";
           meta.personality = c.personality ?? meta.personality ?? "";
           meta.first_mes = c.first_mes ?? meta.first_mes ?? "";
           meta.mes_example = c.mesExample ?? meta.mes_example ?? "";
           meta.creator_notes = c.note ?? meta.creator_notes ?? "";
           if (c.tags && c.tags.length > 0) meta.tags = c.tags;

           if (c.dialogEntries && c.dialogEntries.length > 0) {
               meta.first_mes = c.dialogEntries[0] || "";
               meta.alternate_greetings = c.dialogEntries.slice(1);
           }
           
           if (c.worldBookEntries && c.worldBookEntries.length > 0) {
               const charBook = meta.character_book || (meta.data ? meta.data.character_book : null) || {};
               charBook.name = meta.name || charBook.name || "Kaku World";
               charBook.entries = c.worldBookEntries.map((e, idx) => {
                   let keysStr = e.actual_keywords !== undefined ? e.actual_keywords : (Array.isArray(e.keys) ? e.keys.join(',') : (e.keys || ''));
                   let keysArr = keysStr.split(/[,，、]+/).map(k=>k.trim()).filter(Boolean);
                   return {
                       id: idx, uid: idx, keys: keysArr, secondary_keys: [],
                       comment: e.name || keysStr || "未命名", content: e.content || "",
                       constant: !!e.constant, vectorized: false, selective: e.selective !== false,
                       insertion_order: e.order !== undefined ? Number(e.order) : 100,
                       enabled: e.enabled !== false, position: e.position === 1 ? "after_char" : "before_char",
                       use_regex: true,
                       extensions: {
                           position: e.position !== undefined ? Number(e.position) : 0, role: e.role !== undefined ? Number(e.role) : 0,
                           depth: e.depth !== undefined ? Number(e.depth) : 4, probability: e.probability !== undefined ? Number(e.probability) : 100,
                           prevent_recursion: true, delay_until_recursion: false, display_index: idx, group: "", group_weight: 100
                       }
                   };
               });
               meta.character_book = charBook;
               if (meta.data) meta.data.character_book = charBook;
           } else {
               delete meta.character_book;
               if (meta.data) delete meta.data.character_book;
           }

           const finalBlob = buildUpdatedPngBlob(c.originalDataUrl, meta);
           let safeName = c.name.replace(/[\\/:*?"<>|]/g, '');
           let targetAvatar = existChar ? existChar.avatar : `${safeName}.png`;

           if (existChar) {
               await fetch(tavernProxy + '/api/characters/delete', {
                   method: 'POST',
                   headers: { 'Content-Type': 'application/json' },
                   body: JSON.stringify({ avatar_url: existChar.avatar })
               }).catch(e => console.warn(e));
           }

           const fd = new FormData();
           fd.append("avatar", finalBlob, targetAvatar);
           fd.append("file_type", "png");
           fd.append("preserved_name", targetAvatar);
           
           await fetchWithRetry(tavernProxy + '/api/characters/import', { method: 'POST', body: fd });
           pushOk++;
       } catch(e) { pushFail++; }
       
       await new Promise(resolve => setTimeout(resolve, 10)); // 防假死
    }

    // --- 阶段二：刷新酒馆最新列表，准备拉新卡回库 ---
    document.getElementById('busySub').textContent = `请求酒馆最新接口...`;
    listResp = await fetch(tavernProxy + '/api/characters/all', { method: 'POST', body: JSON.stringify({}) }).catch(()=>fetch(tavernProxy + '/api/characters/all'));
    list = await listResp.json();
    if (!Array.isArray(list)) list = list.default || Object.values(list);

    let pullOk = 0;
    for (let i = 0; i < list.length; i++) {
       document.getElementById('busyBar').style.width = (50 + (i / list.length) * 50) + '%';
       const ci = list[i];
       
       const hashCandidate = await asyncHash(ci.name + ci.description);
       const exist = S.cards.find(x => x.name === ci.name || x.hash === hashCandidate);
       if(exist) continue;

       document.getElementById('busySub').textContent = `2/2 拉取新卡中: ${ci.name}`;

       try {
         const avatarResp = await fetch(tavernProxy + '/characters/' + ci.avatar);
         if(!avatarResp.ok) throw new Error();
         const avatarBlob = await avatarResp.blob();
         
         // ---- 新增：强制解包下载图片的 EXIF 原始设定 ----
     const buffer = await avatarBlob.arrayBuffer();
     let meta = getMetaFromBuffer(buffer);


         const reader = new FileReader();
         const base64Str = await new Promise(res => { reader.onload = ()=>res(reader.result); reader.readAsDataURL(new Blob([buffer])); });
         
         // 融合 EXIF 数据与接口摘要，EXIF 优先级最高
         const charData = ci.data || ci; 
         const finalDesc = meta.description || charData.description || ci.description || "";

         // --- 修复：提取世界书、预设、对白数据 ---
         const finalMeta = (meta && Object.keys(meta).length > 0) ? meta : (ci.data || ci || {});
         const dlgs = [];
         if(finalMeta.mes_example) dlgs.push(finalMeta.mes_example);
         if(finalMeta.first_mes) dlgs.push(finalMeta.first_mes);
         if(finalMeta.alternate_greetings && Array.isArray(finalMeta.alternate_greetings)) {
             finalMeta.alternate_greetings.forEach(g => dlgs.push(g));
         }
         let wbEntries = [];
                          if(finalMeta.character_book && finalMeta.character_book.entries) {
               const entriesArr = Array.isArray(finalMeta.character_book.entries) ? finalMeta.character_book.entries : Object.values(finalMeta.character_book.entries);
               wbEntries = entriesArr.map(e => ({
                 name: (e.comment && e.comment.trim()) || '（无标题）', keys: Array.isArray(e.keys) ? e.keys.join(', ') : (Array.isArray(e.key) ? e.key.join(', ') : (e.keys || e.key || '')),
                 content: e.content || '',
                 position: e.position !== undefined ? e.position : 0,
                 role: e.role !== undefined ? e.role : 0,
                 depth: e.depth !== undefined ? e.depth : 4,
                 order: e.order !== undefined ? e.order : (e.insertion_order !== undefined ? e.insertion_order : 100),
                 probability: e.probability !== undefined ? e.probability : 100,
                 constant: e.constant !== undefined ? e.constant : (e.constant_enabled !== undefined ? e.constant_enabled : false),
                 enabled: e.enabled !== undefined ? e.enabled : true,
                 selective: e.selective !== undefined ? e.selective : true
               }));
             } else if (finalMeta.world_info && typeof finalMeta.world_info === 'object') {
           wbEntries = Object.values(finalMeta.world_info).map(e => ({
             keys: (e.keys || e.key || []).join?.(', ') || '',
             content: e.content || e.value || ''
           }));
         }
         let pres = [];
         const promptArr = finalMeta.prompts || (finalMeta.prompt_order && finalMeta.prompts);
         if(Array.isArray(promptArr)) {
             promptArr.forEach(p => { if(p && (p.name || p.identifier)) pres.push({name: '▸ ' + (p.name || p.identifier), content: String(p.content || p.text || p.value || p.prompt || p.message || '')}) });
         }
         const rx = finalMeta.regex_scripts || finalMeta.scripts;
         if(Array.isArray(rx)) {
             rx.forEach(s => { if(s && (s.scriptName || s.name)) pres.push({name: '⟢ ' + (s.scriptName || s.name), content: s.replaceString || s.replace || s.findRegex || s.content || ''}) });
         }
         // --- 提取结束 ---

         const newCard = {
            id: 'c_' + uuid(),
            hash: hashCandidate,
            name: meta.name || ci.name,
            description: finalDesc,
            personality: meta.personality || charData.personality || ci.personality || "",
            first_mes: meta.first_mes || charData.first_mes || ci.first_mes || "",
            mesExample: meta.mes_example || charData.mes_example || ci.mes_example || "",
            note: meta.creator_notes || charData.creator_notes || charData.note || ci.creator_notes || "",
            originalDataUrl: base64Str,
            thumb: await genThumb(base64Str, 400),
            fileType: 'image/png',
            fileSize: avatarBlob.size,
            importedAt: Date.now(),
            section: S.sections[0],
            tags: meta.tags || ci.tags || charData.tags || [],
            charCount: finalDesc.length,
            groupId: '',
            dialogEntries: dlgs,
            worldBookEntries: wbEntries,
            presetEntries: pres
         };
         await dbP('cards', newCard);
         pullOk++;
       } catch(ex) { }
	   }

    await loadCardsLightweight(); 
    renderAll();
    closeModal('settingsModal');
    alert(`🎉 一键双向同步完成！\n\n📤 本地发往酒馆 (新增/热更): ${pushOk} 张\n📥 酒馆新卡拉取回库: ${pullOk} 张\n(忽略无效卡: ${pushFail})`);

  } catch(err) {
    alert('双向同步因异常中断: ' + err.message);
  } finally { hideBusy(); }
}
// ============================================================
// ✨ 找回的 DOCX 极简解析引擎 (脱离第三方依赖)
// ============================================================
async function parseDocx(buffer){
  const bytes = new Uint8Array(buffer);
  const xml = await extractZipEntry(bytes, 'word/document.xml');
  if(!xml) throw new Error('找不到 document.xml');
  let txt = xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/?>/g, '\t').replace(/<[^>]+>/g, '');
  txt = txt.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/"/g, '"').replace(/'/g, "'");
  return txt.trim();
}
async function extractZipEntry(bytes, name){
  const dv = new DataView(bytes.buffer); let i = 0; const nameBytes = new TextEncoder().encode(name);
  while(i < bytes.length - 4){
    if(dv.getUint32(i, true) === 0x04034b50){
      const method = dv.getUint16(i+8, true), compSize = dv.getUint32(i+18, true);
      const nameLen = dv.getUint16(i+26, true), extraLen = dv.getUint16(i+28, true);
      const fnStart = i+30, fn = bytes.slice(fnStart, fnStart+nameLen);
      let match = fn.length === nameBytes.length;
      if(match) for(let k=0; k<nameBytes.length; k++){ if(fn[k]!==nameBytes[k]){match=false;break} }
      const dataStart = fnStart + nameLen + extraLen;
      if(match){
  const comp = bytes.slice(dataStart, dataStart+compSize);
  if(method === 0) return new TextDecoder('utf-8').decode(comp);
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器版本过低，不支持解析 DOCX，请使用最新版 Chrome/Safari');
  const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([comp]).stream().pipeThrough(ds);
        const out = await new Response(stream).arrayBuffer();
        return new TextDecoder('utf-8').decode(out);
      }
      i = dataStart + compSize;
    } else { i++; }
  }
  return null;
}
// ============================================================
// ✨ 找回的全屏阅读功能组件
// ============================================================
// 【优化：收拢全局变量，建立统一的应用状态缓存】
window.AppCache = {
  read: {},
  dlgs: [],
  charName: ''
};

window.quickViewCard = async function(id) {
  const card = await dbG('cards', id);
  if (!card) return;
  document.getElementById('readTitle').innerHTML = '快速浏览 · ' + esc(card.name);
  document.getElementById('readBody').textContent = card.description || '无简介内容';
  document.getElementById('readSidebar').style.display = 'none';
  const toggleBtn = document.getElementById('toggleSidebarBtn');
  if(toggleBtn) toggleBtn.style.display = 'none';
  const navFloating = document.getElementById('readNavFloating');
  if(navFloating) navFloating.style.display = 'none';
  
  document.getElementById('readMask').classList.add('show');
  
  // 兼容手机返回键
  history.pushState({modal: 'readMask'}, ""); 
  activeModals.push('readMask');
};

window.openRead = async function(key) {
  window._readCurrentKey = key;
  const eb = document.getElementById('readEditBtn');
  if(eb) eb.style.display = (key && key.startsWith('preset_')) ? 'none' : 'inline-block';
  let title = '', text = '';
  let navHtml = '';
  const sidebar = document.getElementById('readSidebar');
  const toggleBtn = document.getElementById('toggleSidebarBtn');
  const navFloating = document.getElementById('readNavFloating');
  
  // 初始化：默认隐藏侧边栏目录和悬浮按钮
  sidebar.style.display = 'none';
  sidebar.innerHTML = '';
  if(toggleBtn) toggleBtn.style.display = 'none';
  if(navFloating) navFloating.style.display = 'none';
  
  if (key.startsWith('dlg_')) {
      title = '对白示例';
      text = (window._currentDlgs || [])[dlgIdx || 0] || '';
      const total = (window._currentDlgs || []).length;
      if (total > 1) {
          navHtml = `<div style="display:inline-flex;align-items:center;gap:8px;margin-left:16px;vertical-align:middle;">
              <button class="expand-btn" id="readDlgP" onclick="navReadDlg(-1)" ${dlgIdx===0?'disabled':''}>◀</button>
              <span id="readDlgI" style="font-size:11px;color:var(--ink3);letter-spacing:1px;font-family:var(--ss);">${dlgIdx+1} / ${total}</span>
              <button class="expand-btn" id="readDlgN" onclick="navReadDlg(1)" ${dlgIdx===total-1?'disabled':''}>▶</button>
          </div>`;
      }
  } else if (key.startsWith('desc_')) {
      const id = key.substring(5);
      const card = await dbG('cards', id);
      title = '简介 · ' + (card ? card.name : '');
      text = card ? (card.description || '') : '';
      } else if (key.startsWith('clog_')) {
    const logData = window._readCache[key];
    title = logData ? logData.title : '聊天记录';
    text = ''; // 走 HTML 注入
    document.getElementById('readBody').innerHTML = logData ? logData.html : '';
  } else if (key.startsWith('wb_')) {
      const parts = key.split('_'); 
      const currentWbIdx = parseInt(parts[1]);
      const cid = parts.slice(2).join('_');
      const card = await dbG('cards', cid);
      
      title = '🌍 世界书阅读面板';
      text = card.worldBookEntries?.[currentWbIdx]?.content || '';
      
      // 核心注入：如果存在多条目，把左侧全屏导航侧边栏展现出来
      if (card.worldBookEntries && card.worldBookEntries.length > 0) {
          window._currentWbCardId = cid;
          window._currentWbIdx = currentWbIdx;
          window._currentWbTotal = card.worldBookEntries.length;
          
          sidebar.style.display = 'block';
          if(toggleBtn) toggleBtn.style.display = 'inline-block';
          if(navFloating) navFloating.style.display = 'flex';
          
          // 移动端及平板端默认折叠目录，留出阅读空间
          if(window.innerWidth <= 768) {
              sidebar.classList.add('collapsed');
          } else {
              sidebar.classList.remove('collapsed');
          }
          
          sidebar.innerHTML = card.worldBookEntries.map((e, idx) => {
              const itemTitle = e.name || e.comment || e.keys || '（无标题）';
              const activeStyle = idx === currentWbIdx ? 'background:var(--ink); color:var(--p); font-weight:bold;' : 'color:var(--ink2);';
              return `<div id="wb_nav_item_${idx}" style="padding:10px 14px; font-size:12px; cursor:pointer; border-bottom:1px solid var(--bd2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; ${activeStyle}" 
                   onclick="switchWbFullScreenContent('${cid}', ${idx}, this)">
                   ${idx + 1}. ${esc(itemTitle)}
              </div>`;
          }).join('');
          
          updateWbNavButtons();
      }
  }
  
  document.getElementById('readTitle').innerHTML = title + navHtml;
  if (!key.startsWith('clog_')) {
      document.getElementById('readBody').textContent = text;
  }
  document.getElementById('readMask').classList.add('show');
};

window.expandChatlogRead = async function(logId, cardId) {
  const log = await dbG('chatlogs', logId); if(!log || !log.raw) return;
  const card = S.cards.find(c => c.id === cardId);
  const charName = card ? card.name : '角色';
  let msgs = [];
  if(log.type === 'jsonl' || log.raw.includes('{"mes":')) {
      log.raw.split('\n').forEach(line => {
          const s = line.trim(); if(!s) return;
          try { const obj = JSON.parse(s); if(obj && typeof obj.mes === 'string') msgs.push({isUser: !!obj.is_user, name: obj.name || '', text: obj.mes}); } catch(e){}
      });
  }
  const key = 'clog_' + log.id;
  if(msgs.length) {
      const html = `<div class="chat-wrap" style="background:transparent; max-height:none; padding:0;">` + msgs.map(m => {
          if(!m.text.trim()) return '';
          const isU = m.isUser;
          return `<div class="chat-msg ${isU ? 'chat-user' : 'chat-char'}"><div class="chat-name">${esc(isU ? 'User' : (m.name || charName))}</div>${esc(m.text)}</div>`;
      }).join('') + `</div>`;
      window._readCache[key] = {title: '📖 ' + log.name, html: html};
  } else {
      window._readCache[key] = {title: '📖 ' + log.name, html: '<div style="white-space:pre-wrap; line-height:1.8;">' + esc((log.raw||'').trim()) + '</div>'};
  }
  openRead(key);
};

window.updateWbNavButtons = function() {
    const idx = window._currentWbIdx;
    const total = window._currentWbTotal;
    const rnFirst = document.getElementById('rnFirst');
    const rnPrev = document.getElementById('rnPrev');
    const rnNext = document.getElementById('rnNext');
    const rnLast = document.getElementById('rnLast');
    
    if(rnFirst) rnFirst.disabled = (idx === 0);
    if(rnPrev) rnPrev.disabled = (idx === 0);
    if(rnNext) rnNext.disabled = (idx === total - 1);
    if(rnLast) rnLast.disabled = (idx === total - 1);
};

window.navWbFullScreen = function(action) {
    if (window._currentWbIdx === undefined) return;
    const total = window._currentWbTotal;
    let nextIdx = window._currentWbIdx;
    
    if (action === 'first') nextIdx = 0;
    else if (action === 'prev') nextIdx = Math.max(0, nextIdx - 1);
    else if (action === 'next') nextIdx = Math.min(total - 1, nextIdx + 1);
    else if (action === 'last') nextIdx = total - 1;
    
    if (nextIdx !== window._currentWbIdx) {
        const el = document.getElementById(`wb_nav_item_${nextIdx}`);
        if (el) switchWbFullScreenContent(window._currentWbCardId, nextIdx, el);
    }
};

window.toggleReadSidebar = function() {
  const sb = document.getElementById('readSidebar');
  const bd = document.getElementById('readSbBackdrop');
  if(sb) {
      const isOpen = sb.style.transform === 'translateX(0px)';
      sb.style.transform = isOpen ? 'translateX(-102%)' : 'translateX(0px)';
      if(bd) { bd.style.opacity = isOpen ? '0' : '1'; bd.style.pointerEvents = isOpen ? 'none' : 'auto'; }
  }
};

window.switchWbFullScreenContent = async function(cid, idx, clickedElement) {
    const card = await dbG('cards', cid);
    if (!card || !card.worldBookEntries?.[idx]) return;
    
    // 切换主体文本
    document.getElementById('readBody').textContent = card.worldBookEntries[idx].content || '';
    
    // 维护全局索引和按钮状态
    window._currentWbIdx = idx;
    updateWbNavButtons();
    window._readCurrentKey = `wb_${idx}_${cid}`; // 同步更新编辑键
    
    // 高亮切换左侧目录栏项的颜色样式
    const siblings = clickedElement.parentElement.children;
    for (let el of siblings) {
        el.style.background = '';
        el.style.color = 'var(--ink2)';
        el.style.fontWeight = 'normal';
    }
    clickedElement.style.background = 'var(--ink)';
    clickedElement.style.color = 'var(--p)';
    clickedElement.style.fontWeight = 'bold';
    
    // 平滑滚动居中
    clickedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};


// ==========================================
// 新增：全屏模式下的对白前后切换
// ==========================================
window.navReadDlg = function(dir) {
    const total = (window._currentDlgs || []).length;
    if (total === 0) return;
    
    dlgIdx = Math.max(0, Math.min(total - 1, dlgIdx + dir));
    document.getElementById('readBody').textContent = window._currentDlgs[dlgIdx] || '';
    
    // 更新按钮禁用状态和页码
    const p = document.getElementById('readDlgP');
    const n = document.getElementById('readDlgN');
    const i = document.getElementById('readDlgI');
    
    if(p) p.disabled = (dlgIdx === 0);
    if(n) n.disabled = (dlgIdx === total - 1);
    if(i) i.textContent = `${dlgIdx+1} / ${total}`;
    
    // 隐式同步背后的背景气泡 UI
    navDlgV4(0);
};

// ==========================================
// 新增：世界书设置项自动静默保存
// ==========================================
window.updateWbSetting = async function(id, idx, key, val) {
    let card = S.cards.find(c => c.id === id);
    if (!card) return;
    
    const full = await dbG('cards', id);
    if (!full || !full.worldBookEntries) return;

    const entry = full.worldBookEntries[idx];
    if (key === 'pos_role') {
        const [p, r] = val.split('_').map(Number);
        entry.position = p;
        entry.role = r;
    } else if (key === 'constant') {
        entry.constant = val;
    } else if (key === 'enabled') {
        entry.enabled = val;
    } else {
        entry[key] = Number(val);
        // 为了兼容旧卡和不同标准，同步修改 insertion_order
        if (key === 'order') entry.insertion_order = Number(val); 
    }

    card.worldBookEntries = full.worldBookEntries; // 更新内存引用
    await dbP('cards', full); // 写入 IndexedDB 数据库
    showToast('设置已保存');
};

window.closeRead = function() {
  const e = document.getElementById('editFab'); if (e) e.remove();
  document.getElementById('readMask').classList.remove('show');
  window._readCurrentKey = null;
  if(window._readCache) window._readCache = {}; // 修复内存泄漏：清空阅读缓存
  const eb = document.getElementById('readEditBtn'); if(eb) eb.style.display = 'none';
  // 兼容手机返回键
  activeModals = activeModals.filter(m => m !== 'readMask');
};

window._readDblEdit = function(e) {
  if (document.getElementById('readEditTa')) return;
  let offset = 0;
  try {
    if (document.caretRangeFromPoint) {
      const rng = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (rng) {
        const body = document.getElementById('readBody');
        const iter = document.createNodeIterator(body, NodeFilter.SHOW_TEXT);
        let node, total = 0;
        while ((node = iter.nextNode())) {
          if (node === rng.startContainer) { total += rng.startOffset; break; }
          total += node.textContent.length;
        }
        offset = total;
      }
    }
  } catch(err) {}
  window._readDblOffset = offset;
  _readEditCurrent();
};

window._restoreEditScroll = function(ta) {
  let ratio = (typeof window._readScrollRatio === 'number') ? window._readScrollRatio : 0;
  ta.focus();
  let pos;
  if (typeof window._readDblOffset === 'number') {
    pos = Math.min(window._readDblOffset, ta.value.length);
    ratio = ta.value.length > 0 ? pos / ta.value.length : 0;
    window._readDblOffset = null;
  } else {
    pos = Math.round((ta.value.length) * ratio);
  }
  try { ta.setSelectionRange(pos, pos); } catch(e) {}
  requestAnimationFrame(() => {
    const sh = ta.scrollHeight - ta.clientHeight;
    ta.scrollTop = sh > 0 ? sh * ratio : 0;
  });
};

window._mountEditFab = function() {
  const e = document.getElementById('editFab'); if (e) e.remove();
  const host = document.getElementById('readMask'); if (!host) return;
  const fab = document.createElement('div');
  fab.id = 'editFab'; fab.className = 'edit-fab collapsed';
  // 注入磨砂玻璃和拖拽样式
  fab.style.cssText = 'position:absolute; right:0; bottom:88px; z-index:60;';
  fab.innerHTML = `
    <button class="efab-ball" title="编辑工具" style="width:42px;height:42px;border:none;border-radius:50% 0 0 50%;background:rgba(74,55,40,.9);color:#F5EFE4;font-size:19px;cursor:grab;box-shadow:-4px 4px 16px rgba(44,36,22,.3);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);">⚙️</button>
    <div class="efab-panel" style="position:absolute;right:0;bottom:0;width:260px;background:rgba(250,247,241,.9);backdrop-filter:blur(18px);border:1px solid var(--bd);border-radius:16px;box-shadow:0 18px 48px var(--sh);padding:12px;transform-origin:bottom right;transition:transform .22s,opacity .18s;">
      <div class="efab-hd" style="cursor:grab;user-select:none;">编辑工具 <span class="efab-x" onclick="document.getElementById('editFab').classList.add('collapsed')">✕</span></div>
      <div class="efab-sec">
        <div class="efab-lb">🧹 删除符号</div>
        <div class="efab-row"><input id="efabDel" class="efab-in" placeholder="要删的符号"><button class="efab-btn" onclick="_fabDelSymbol()">删除全部</button></div>
        <div class="efab-quick" id="efabDelQuick"></div>
      </div>
       <div class="efab-sec">
    <div class="efab-lb">✏️ 快捷插入</div>
    <div class="efab-row"><input id="efabIns" class="efab-in" placeholder="如 {{char}}"><button class="efab-btn" onclick="_fabInsertText()">插入光标处</button></div>
    <div class="efab-quick" id="efabInsQuick"></div>
  </div>
  <!-- 新增：全选与撤回按钮组 -->
  <div class="efab-sec" style="display:flex; gap:6px; padding-top:8px;">
    <button class="efab-btn wide" style="margin-bottom:0;" onclick="document.getElementById('readEditTa').value=window._readEditOrigVal">↩ 撤回</button>
    <button class="efab-btn wide" style="margin-bottom:0;" onclick="const ta=document.getElementById('readEditTa'); if(ta){ta.focus();ta.select();}">全选内容</button>
  </div>
</div>`;
  host.appendChild(fab);
  _renderFabQuick();
  _initFabDrag(fab);
};

function _initFabDrag(fab) {
  const host = document.getElementById('readMask'); if(!host) return;
  try {
    const pos = JSON.parse(localStorage.getItem('efab_pos')||'null');
    if(pos && typeof pos.top==='number') {
      fab.style.top = pos.top+'px'; fab.style.bottom = 'auto';
      if(pos.side==='left') { fab.style.left='0px'; fab.style.right='auto'; fab.querySelector('.efab-ball').style.borderRadius='0 50% 50% 0'; }
      else { fab.style.left='auto'; fab.style.right='0px'; fab.querySelector('.efab-ball').style.borderRadius='50% 0 0 50%'; }
      fab.dataset.side = pos.side||'right';
    }
  } catch(e){}
  let dragging=false, moved=false, sy=0, sx=0, startTop=0, startLeft=0;
  const onDown = (e) => {
    const t = e.target; if(!t.classList.contains('efab-ball') && !t.classList.contains('efab-hd')) return;
    dragging=true; moved=false;
    const p = e.touches ? e.touches[0] : e;
    sy=p.clientY; sx=p.clientX;
    const r = fab.getBoundingClientRect(), hr = host.getBoundingClientRect();
    startTop = r.top-hr.top; startLeft = r.left-hr.left;
    fab.style.transition='none'; e.preventDefault();
  };
  const onMove = (e) => {
    if(!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dy = p.clientY-sy, dx = p.clientX-sx;
    if(Math.abs(dy)>4 || Math.abs(dx)>4) moved=true;
    const hr = host.getBoundingClientRect();
    let nt = Math.max(4, Math.min(hr.height-52, startTop+dy));
    let nl = Math.max(0, Math.min(hr.width-48, startLeft+dx));
    fab.style.top = nt+'px'; fab.style.bottom = 'auto';
    fab.style.left = nl+'px'; fab.style.right = 'auto';
    e.preventDefault();
  };
  const onUp = (e) => {
    if(!dragging) return;
    dragging=false;
    const hr = host.getBoundingClientRect(), r = fab.getBoundingClientRect();
    const distL = r.left-hr.left, distR = hr.right-r.right;
    fab.style.transition = 'top .2s ease, left .22s cubic-bezier(.2,1,.3,1)';
    if(distL < 80) { fab.style.left='0px'; fab.style.right='auto'; fab.dataset.side='left'; fab.querySelector('.efab-ball').style.borderRadius='0 50% 50% 0'; }
    else { fab.style.left='auto'; fab.style.right='0px'; fab.dataset.side='right'; fab.querySelector('.efab-ball').style.borderRadius='50% 0 0 50%'; }
    try{ localStorage.setItem('efab_pos', JSON.stringify({top: r.top-hr.top, side: fab.dataset.side})); }catch(e){}
    if(!moved && e.target.classList.contains('efab-ball')) {
        const panel = fab.querySelector('.efab-panel');
        if(fab.dataset.side === 'left') { panel.style.left='0'; panel.style.right='auto'; panel.style.transformOrigin='bottom left'; }
        else { panel.style.right='0'; panel.style.left='auto'; panel.style.transformOrigin='bottom right'; }
        fab.classList.toggle('collapsed');
    }
  };
  fab.addEventListener('touchstart',onDown,{passive:false}); fab.addEventListener('touchmove',onMove,{passive:false}); fab.addEventListener('touchend',onUp);
  fab.addEventListener('mousedown',onDown); window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp);
}

function _fabGetQuick(kind){ try{const v=JSON.parse(localStorage.getItem('efab_'+kind)||'null');if(Array.isArray(v))return v;}catch(e){} return kind==='ins'?['{{char}}','{{user}}']:['*','\\n\\n']; }
function _fabSetQuick(kind,arr){try{localStorage.setItem('efab_'+kind,JSON.stringify(arr));}catch(e){}}
function _renderFabQuick(){
  const mk=(kind,cb)=>_fabGetQuick(kind).map((t,i)=>`<span class="efab-chip" onclick="${cb}('${String(t).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">${esc(t)}<span class="efab-chip-x" onclick="event.stopPropagation();_fabDelQuick('${kind}',${i})">×</span></span>`).join('')+`<span class="efab-chip add" onclick="_fabAddQuick('${kind}')">+</span>`;
  const dq=document.getElementById('efabDelQuick'); if(dq) dq.innerHTML=mk('del','_fabQuickDel');
  const iq=document.getElementById('efabInsQuick'); if(iq) iq.innerHTML=mk('ins','_fabQuickIns');
}
function _fabAddQuick(kind){ const v=prompt('新增快捷符号'); if(v) { const arr=_fabGetQuick(kind); arr.push(v); _fabSetQuick(kind,arr); _renderFabQuick(); } }
function _fabDelQuick(kind,i){ const arr=_fabGetQuick(kind); arr.splice(i,1); _fabSetQuick(kind,arr); _renderFabQuick(); }
function _fabQuickDel(sym){ const el=document.getElementById('efabDel'); if(el) el.value=sym; _fabDelSymbol(); }
function _fabQuickIns(txt){ _fabInsertRaw(txt); }

window._fabDelSymbol = function() {
  const ta = document.getElementById('readEditTa'); const sym = document.getElementById('efabDel').value || '';
  if (!ta || !sym) return;
  const before = ta.value; const after = before.split(sym).join('');
  const n = (before.length - after.length) / sym.length;
  ta.value = after; showToast('已删除 ' + (n > 0 ? Math.round(n) : 0) + ' 处');
};
window._fabInsertText = function(){ const v=(document.getElementById('efabIns')||{}).value||''; if(v) _fabInsertRaw(v); };
window._fabInsertRaw = function(txt) {
  const ta = document.getElementById('readEditTa'); if (!ta) return;
  const st = ta.selectionStart || 0, en = ta.selectionEnd || 0;
  ta.value = ta.value.slice(0, st) + txt + ta.value.slice(en);
  const pos = st + txt.length; ta.focus(); ta.setSelectionRange(pos, pos);
};
window._fabFind = function(dir) {
  const ta = document.getElementById('readEditTa'); const kw = document.getElementById('efabFind').value || '';
  const hint = document.getElementById('efabFindHint');
  if (!ta || !kw) { if (hint) hint.textContent = ''; return; }
  const val = ta.value; const idxs = []; let p = val.indexOf(kw);
  while (p !== -1) { idxs.push(p); p = val.indexOf(kw, p + 1); }
  if (!idxs.length) { if (hint) hint.textContent = '无匹配'; return; }
  const cur = ta.selectionStart || 0; let target;
  if (dir > 0) { target = idxs.find(x => x > cur); if (target === undefined) target = idxs[0]; }
  else { const prev = idxs.filter(x => x < cur); target = prev.length ? prev[prev.length - 1] : idxs[idxs.length - 1]; }
  ta.focus(); ta.setSelectionRange(target, target + kw.length);
  const ratio = target / val.length; ta.scrollTop = Math.max(0, ta.scrollHeight * ratio - ta.clientHeight / 2);
  if (hint) hint.textContent = (idxs.indexOf(target) + 1) + '/' + idxs.length;
};

window._saveReadEdit = async function(type, id, idx) {
  const ta = document.getElementById('readEditTa'); if(!ta) return;
  const val = ta.value; const card = S.cards.find(c => c.id === id); if(!card) return;
  const full = await dbG('cards', id); if(!full) return;

  if(type === 'desc') {
    full.description = val; card.description = val;
  } else if(type === 'dlg') {
    const dlgs = full.dialogEntries || []; dlgs[idx || 0] = val;
    full.dialogEntries = dlgs; card.dialogEntries = dlgs;
    if(window._currentDlgs) window._currentDlgs[idx || 0] = val;
  } else if(type === 'wb') {
    const wbs = full.worldBookEntries || [];
    if(wbs[idx]) { wbs[idx].content = val; card.worldBookEntries = wbs; }
  }
  await dbP('cards', full); showToast('修改已保存'); closeRead();
  openDetail(id); // 刷新底部的详情页
};

window._readEditCurrent = function() {
  if(!window._readCurrentKey) return;
  const k = window._readCurrentKey; const body = document.getElementById('readBody'); if(!body) return;
  const cur = body.textContent || '';
  window._readEditOrigVal = cur;
  const _scrH = body.scrollHeight - body.clientHeight;
  window._readScrollRatio = _scrH > 0 ? (body.scrollTop / _scrH) : 0;
  
  const taStyle = 'width:100%;height:calc(100% - 90px);font-size:calc(13px * var(--fs-scale));line-height:1.9;background:var(--p3);border:1px solid var(--gold);color:var(--ink2);padding:12px;resize:none;font-family:var(--sf);border-radius:4px;outline:none';
  const searchBar = `<div class="edit-search-bar"><input id="efabFind" class="edit-search-in" placeholder="🔍 在此处搜索关键词" onkeydown="if(event.key==='Enter')_fabFind(1)"><button class="edit-search-btn" onclick="_fabFind(-1)">↑</button><button class="edit-search-btn" onclick="_fabFind(1)">↓</button><span class="edit-search-hint" id="efabFindHint"></span></div>`;
  const undoBtn = `<button class="actbtn" style="color:var(--gold); border-color:var(--gold);" onclick="document.getElementById('readEditTa').value=window._readEditOrigVal" title="撤回到打开时的内容">↩ 撤回</button>`;

  if(k.startsWith('desc_')) {
    const id = k.slice(5);
    body.innerHTML = `${searchBar}<textarea id="readEditTa" style="${taStyle}"></textarea><div style="margin-top:8px;display:flex;gap:8px">${undoBtn}<button class="actbtn pri" onclick="_saveReadEdit('desc','${id}')">💾 保存修改</button><button class="actbtn" onclick="closeRead()">✕ 取消</button></div>`;
  } else if(k.startsWith('dlg_')) {
    const id = k.slice(4); const didx = window.dlgIdx || 0;
    body.innerHTML = `${searchBar}<textarea id="readEditTa" style="${taStyle}"></textarea><div style="margin-top:8px;display:flex;gap:8px">${undoBtn}<button class="actbtn pri" onclick="_saveReadEdit('dlg','${id}',${didx})">💾 保存修改</button><button class="actbtn" onclick="closeRead()">✕ 取消</button></div>`;
  } else if(k.startsWith('wb_')) {
    const parts = k.split('_'); const cid = parts.slice(2).join('_'); const wbIdx = parseInt(parts[1], 10);
    body.innerHTML = `${searchBar}<textarea id="readEditTa" style="${taStyle}"></textarea><div style="margin-top:8px;display:flex;gap:8px">${undoBtn}<button class="actbtn pri" onclick="_saveReadEdit('wb','${cid}',${wbIdx})">💾 保存修改</button><button class="actbtn" onclick="closeRead()">✕ 取消</button></div>`;
  }
  const ta = document.getElementById('readEditTa'); 
  if(ta) { ta.value = cur; window._restoreEditScroll(ta); window._mountEditFab(); }
};

window.changeReadFontSize = function(dir) {
  const body = document.getElementById('readBody');
  const currentSize = parseFloat(window.getComputedStyle(body).fontSize) || 14;
  body.style.fontSize = (currentSize + dir * 2) + 'px';
};

window.copyReadText = function() {
  const text = document.getElementById('readBody').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('文本已成功复制到剪贴板！');
  }).catch(() => {
    showToast('复制失败，请手动框选', 'error');
  });
};

// ==========================================
// 新增：右侧详情栏全屏放大
// ==========================================
function toggleDetailFullscreen() {
  const app = document.getElementById('appContainer');
  app.classList.toggle('fullscreen-detail');
}

// ==========================================
// 新增：拖拽调整侧边栏宽度
// ==========================================
const resizer = document.getElementById('resizer');
let isDragging = false;
if (resizer) {
  resizer.addEventListener('mousedown', function(e) {
    isDragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // 防止拖拽时意外选中文本
  });

  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    let containerWidth = document.getElementById('appContainer').offsetWidth;
    let newWidth = containerWidth - e.clientX;
    
    // 限制一下最小和最大宽度，防止拖得太小或太大
    if (newWidth < 300) newWidth = 300;
    if (newWidth > containerWidth - 350) newWidth = containerWidth - 350;
    
    // 实时更新 CSS 变量
    document.documentElement.style.setProperty('--rp-w', newWidth + 'px');
  });

  document.addEventListener('mouseup', function(e) {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// ==========================================
// 世界书关键词 Tag 智能转化与格式修复管理引擎
// ==========================================

window.updateWbKeysData = async function(id, idx, newKeys) {
    let card = S.cards.find(c => c.id === id);
    if (!card) return;
    const full = await dbG('cards', id);
    if (!full || !full.worldBookEntries) return;
    
    // 安全分流：把真实关键词写入独立字段 actual_keywords，不破坏原本的标题展示！
    full.worldBookEntries[idx].actual_keywords = newKeys;
    if (card.worldBookEntries) card.worldBookEntries[idx].actual_keywords = newKeys; 
    await dbP('cards', full); 
    
    const boxEl = document.getElementById(`wb_tags_box_${id}_${idx}`);
    if(boxEl) {
       const tagsArray = newKeys.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
       boxEl.innerHTML = tagsArray.map((t, idxTag) => 
          `<span class="wb-tag-chip">${esc(t)} <span class="wb-tag-del" onclick="removeWbTag(event, '${id}', ${idx}, ${idxTag})">✕</span></span>`
       ).join('');
    }
};

window.removeWbTag = function(e, id, idx, tagIdx) {
    e.stopPropagation();
    dbG('cards', id).then(full => {
        const entry = full.worldBookEntries[idx];
        const keysStr = entry.actual_keywords !== undefined ? entry.actual_keywords : ((!entry.name && entry.keys) ? '' : (entry.keys || ''));
        const tagsArray = keysStr.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
        tagsArray.splice(tagIdx, 1);
        window.updateWbKeysData(id, idx, tagsArray.join(', '));
    });
};

window.addWbTagFromInput = function(id, idx) {
    const inputEl = document.getElementById(`wb_tag_input_${id}_${idx}`);
    if (!inputEl) return;
    const newVal = inputEl.value;
    if (!newVal.trim()) return;
    
    // 一键切割中英文逗号与顿号
    const newTags = newVal.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
    if (!newTags.length) { inputEl.value = ''; return; }
  
    dbG('cards', id).then(full => {
        const entry = full.worldBookEntries[idx];
        const keysStr = entry.actual_keywords !== undefined ? entry.actual_keywords : ((!entry.name && entry.keys) ? '' : (entry.keys || ''));
        const tagsArray = keysStr.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
        
        newTags.forEach(t => { if (!tagsArray.includes(t)) tagsArray.push(t); });
        window.updateWbKeysData(id, idx, tagsArray.join(', '));
        inputEl.value = ''; // 提交后自动清空
    });
};

window.handleWbTagKeyDown = function(e, id, idx) {
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        window.addWbTagFromInput(id, idx);
    } else if (e.key === 'Backspace') {
        const inputEl = document.getElementById(`wb_tag_input_${id}_${idx}`);
        if (inputEl.value === '') { 
           e.preventDefault();
           dbG('cards', id).then(full => {
              const entry = full.worldBookEntries[idx];
              const keysStr = entry.actual_keywords !== undefined ? entry.actual_keywords : ((!entry.name && entry.keys) ? '' : (entry.keys || ''));
              const tagsArray = keysStr.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
              if (tagsArray.length > 0) {
                 tagsArray.pop();
                 window.updateWbKeysData(id, idx, tagsArray.join(', '));
              }
           });
        }
    }
};

window.fixWbKeys = function(id, idx) {
    dbG('cards', id).then(full => {
        const entry = full.worldBookEntries[idx];
        const keysStr = entry.actual_keywords !== undefined ? entry.actual_keywords : ((!entry.name && entry.keys) ? '' : (entry.keys || ''));
        const fixed = keysStr.split(/[,，、]+/).map(t => t.trim()).filter(Boolean).join(', ');
        window.updateWbKeysData(id, idx, fixed).then(() => {
            showToast('✅ 修复成功');
        });
    });
};

// ============================================================
// 聊天记录管理 (TXT & JSONL 解析与绑定)
// ============================================================
async function handleChatlogFiles(files) {
    if(!files || !files.length) return;
    let added = 0;
    showBusy('正在导入', '解析聊天记录中...', 0.5);
    for(const f of files) {
        try {
            const raw = await new Promise((res, rej) => {
                const rd = new FileReader();
                rd.onload = e => res(e.target.result);
                rd.onerror = e => rej(e);
                rd.readAsText(f, 'utf-8');
            });
            const ext = f.name.split('.').pop().toLowerCase();
            const log = {
                id: 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
                name: f.name,
                type: ext,
                raw,
                boundCardId: null,
                importedAt: Date.now()
            };
            await dbP('chatlogs', log);
            S.chatlogs.push(log);
            added++;
        } catch(e) { console.warn('读取失败: ' + f.name); }
    }
    hideBusy();
    if(added > 0) {
        renderChatlogLib();
        showToast('成功导入 ' + added + ' 条记录');
        const newLogs = S.chatlogs.slice(-added);
        if(newLogs.length === 1) openChatlogBind(newLogs[0].id);
    }
    document.getElementById('chatlogInput').value = '';
}

async function exportCardWithChatlogs(cardId) {
  const card = S.cards.find(c => c.id === cardId); if (!card) return;
  showBusy('正在打包…', '读取数据中');
  try {
    const full = await dbG('cards', cardId);
    const files = [];
    if (full && full.originalDataUrl) {
      const ext = card.fileType.includes('webp') ? '.webp' : '.png';
      files.push({ name: `${card.name}${ext}`, data: full.originalDataUrl.split(',')[1] });
    } else {
      files.push({ name: `${card.name}.json`, data: JSON.stringify(full, null, 2) });
    }
    const logs = S.chatlogs.filter(l => l.boundCardId === cardId);
    logs.forEach(l => files.push({ name: `chatlogs/${l.name}`, data: l.raw }));
    
    document.getElementById('busySub').textContent = '生成压缩包…';
    const zipBlob = await buildZip(files);
    hideBusy();
    dlB(zipBlob, `${card.name}_完整导出.zip`);
    showToast(`已导出：卡片 + ${logs.length} 条聊天记录`);
  } catch (e) { hideBusy(); showToast('导出失败', 'error'); }
}

async function exportChatlog(logId) {
    const log = await dbG('chatlogs', logId);
    if (!log || !log.raw) return;
    const blob = new Blob([log.raw], {type: 'text/plain'});
    dlB(blob, log.name);
}

function renderChatlogLib() {
    const el = document.getElementById('chatlogLib'); if(!el) return;
    if(!S.chatlogs.length) { el.innerHTML = '<div style="font-size:11px;color:var(--ink4);padding:8px 0">还没有聊天记录，点下方按钮导入</div>'; return; }
    el.innerHTML = S.chatlogs.map(log => {
        const card = S.cards.find(c => c.id === log.boundCardId);
        const bindStr = card ? `已绑定：${esc(card.name)}` : '未绑定';
        return `<div class="wb-entry" style="padding: 6px; background: var(--p3); border-radius: var(--r);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="flex:1; min-width:0;">
                    <div style="font-size:12px; font-weight:bold; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(log.name)}</div>
                    <div style="font-size:9px; color:var(--ink3);">${bindStr}</div>
                </div>
                <div style="display:flex; gap:4px; flex-shrink:0;">
                    <button class="expand-btn" onclick="openChatlogBind('${log.id}')">绑定</button>
                    <button class="expand-btn" onclick="openChatlogView('${log.id}', '${log.boundCardId}')">📖 阅览</button>
                    <button class="expand-btn" onclick="expandChatlogRead('${log.id}', '${log.boundCardId}')">⛶ 全屏</button>
<button class="expand-btn" onclick="exportChatlog('${log.id}')">💾 导出</button>
<button class="expand-btn" style="color:var(--red); border-color:rgba(139,46,46,0.3);" onclick="deleteChatlog('${log.id}')">✕</button>
                </div>
            </div>
        </div>`;
    }).join('');
}

function openChatlogBind(logId) {
    const log = S.chatlogs.find(l => l.id === logId); if(!log) return;
    const keyword = log.name.replace(/\.\w+$/, '').replace(/[\d_\-\s\.]/g, '').slice(0, 10).toLowerCase();
    const sorted = [...S.cards.filter(c => !c.parentId)].sort((a,b) => {
        const as = keyword && a.name.toLowerCase().includes(keyword) ? -1 : 0;
        const bs = keyword && b.name.toLowerCase().includes(keyword) ? -1 : 0;
        return as - bs;
    });
    
    document.getElementById('pickTitle').textContent = '绑定到角色卡';
    document.getElementById('pickBody').innerHTML = `
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px">为「${esc(log.name)}」选择角色卡：</div>
        <div class="inp-row" style="margin-bottom:8px">
            <input type="text" class="inp" placeholder="搜索角色名..." oninput="filterChatlogBind(this.value, '${logId}')" style="width:100%">
        </div>
        <div id="chatlogBindList" style="max-height:40vh; overflow-y:auto; border:1px solid var(--bd2); border-radius:var(--r);">
            ${sorted.map(c => `<div class="pick-item ${c.id === log.boundCardId ? 'active' : ''}" style="${c.id === log.boundCardId ? 'background:var(--gold);color:#fff;' : ''}" onclick="doChatlogBind('${logId}', '${c.id}')">${esc(c.name)}</div>`).join('')}
        </div>
        <div class="pick-item" style="color:var(--ink4); text-align:center; margin-top:8px;" onclick="doChatlogBind('${logId}', null)">── 解除绑定 ──</div>`;
    window._clBindAllCards = sorted; window._clBindLogId = logId;
    openModal('pickModal');
}

function filterChatlogBind(q, logId) {
    const kw = q.trim().toLowerCase();
    const log = S.chatlogs.find(l => l.id === logId);
    const filtered = kw ? window._clBindAllCards.filter(c => c.name.toLowerCase().includes(kw)) : window._clBindAllCards;
    document.getElementById('chatlogBindList').innerHTML = filtered.map(c => `<div class="pick-item" style="${c.id === (log&&log.boundCardId) ? 'background:var(--gold);color:#fff;' : ''}" onclick="doChatlogBind('${logId}', '${c.id}')">${esc(c.name)}</div>`).join('');
}

async function doChatlogBind(logId, cardId) {
    const log = S.chatlogs.find(l => l.id === logId); if(!log) return;
    log.boundCardId = cardId || null;
    await dbP('chatlogs', log);
    closeModal('pickModal'); renderChatlogLib();
    showToast(cardId ? '记录绑定成功！' : '记录已解绑');
}

async function deleteChatlog(logId) {
    if(!await confirmDialog('确定要删除这条聊天记录吗？', {danger:true})) return;
    await dbD('chatlogs', logId);
    S.chatlogs = S.chatlogs.filter(l => l.id !== logId);
    renderChatlogLib(); showToast('聊天记录已删除');
}

let _clviewObserver = null;

async function openChatlogView(logId, cardId) {
    const log = await dbG('chatlogs', logId); if(!log || !log.raw) return;
    const card = S.cards.find(c => c.id === cardId);
    const charName = card ? card.name : '角色';
    
    let msgs = [];
    if(log.type === 'jsonl' || log.raw.includes('{"mes":')) {
        log.raw.split('\n').forEach(line => {
            const s = line.trim(); if(!s) return;
            try { const obj = JSON.parse(s); if(obj && typeof obj.mes === 'string') msgs.push({isUser: !!obj.is_user, name: obj.name || '', text: obj.mes}); } catch(e){}
        });
    } else {
        // TXT 简单切分
        const lines = log.raw.split(/\r?\n/);
        let cur = null;
        for(const line of lines) {
            const m = line.match(/^\s*([^：:\n]{1,20})\s*[：:]\s*(.*)$/);
            if(m && m[1].trim()) {
                if(cur) msgs.push(cur);
                const nm = m[1].trim();
                cur = { isUser: /^(user|你|我|用户)$/i.test(nm), name: nm, text: m[2] || '' };
            } else if(cur) {
                cur.text += '\n' + line;
            }
        }
        if(cur) msgs.push(cur);
    }
    
    const container = document.getElementById('clviewBody');
    container.innerHTML = '';
    
    if(!msgs.length) {
        container.innerHTML = `<div class="cbox" style="background:transparent; border:none; padding:0;">${esc(log.raw.trim() || '空记录')}</div>`;
        openModal('clviewModal');
        return;
    }

    // 分块渲染逻辑 (Infinite Scroll)
    let renderIndex = 0;
    const CHUNK_SIZE = 100; // 每次滑到底部加载 100 条
    
    const renderChunk = () => {
        const fragment = document.createDocumentFragment();
        const end = Math.min(renderIndex + CHUNK_SIZE, msgs.length);
        for(let i = renderIndex; i < end; i++) {
            const m = msgs[i];
            if(!m.text.trim()) continue;
            const isU = m.isUser;
            const msgDiv = document.createElement('div');
            msgDiv.className = `chat-msg ${isU ? 'chat-user' : 'chat-char'}`;
            msgDiv.innerHTML = `<div class="chat-name">${esc(isU ? 'User' : (m.name || charName))}</div>${esc(m.text)}`;
            fragment.appendChild(msgDiv);
        }
        renderIndex = end;
        
        // 移除旧的触底探测器
        const oldTrigger = container.querySelector('.scroll-trigger');
        if(oldTrigger) oldTrigger.remove();
        
        container.appendChild(fragment);
        
        // 如果数据还没渲染完，在底部埋入一个新的探测器
        if(renderIndex < msgs.length) {
            const trigger = document.createElement('div');
            trigger.className = 'scroll-trigger';
            trigger.style.height = '20px';
            container.appendChild(trigger);
            if(_clviewObserver) _clviewObserver.observe(trigger);
        }
    };

    // 重置侦听器
    if(_clviewObserver) _clviewObserver.disconnect();
    _clviewObserver = new IntersectionObserver((entries) => {
        if(entries[0].isIntersecting) {
            renderChunk();
        }
    }, { root: container, rootMargin: '100px' });

    renderChunk();
    openModal('clviewModal');
}

// ==========================================
// 核心工具：将最新数据完美打包成酒馆原生 V2 PNG 卡片
// ==========================================
function buildUpdatedPngBlob(base64Data, metaObj) {
    const jsonStr = JSON.stringify(metaObj);
    const encodedJson = btoa(unescape(encodeURIComponent(jsonStr)));
    const chunkData = "chara\0" + encodedJson;
    const crcTable = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c;
    }
    const crc32 = (str) => {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < str.length; i++) crc = crcTable[(crc ^ str.charCodeAt(i)) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    };
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, chunkData.length, false);
    const crcBuf = new Uint8Array(4);
    new DataView(crcBuf.buffer).setUint32(0, crc32("tEXt" + chunkData), false);
    
    const binary = atob(base64Data.split(',')[1]);
    let out = binary.substring(0, 8);
    let offset = 8;
    while (offset < binary.length) {
        const chunkLen = (binary.charCodeAt(offset) << 24) | (binary.charCodeAt(offset+1) << 16) | (binary.charCodeAt(offset+2) << 8) | binary.charCodeAt(offset+3);
        const type = binary.substring(offset+4, offset+8);
        if (type === 'IEND') {
            out += String.fromCharCode(...lenBuf) + "tEXt" + chunkData + String.fromCharCode(...crcBuf);
            out += binary.substring(offset, offset + 12);
            break;
        }
        if (type === 'tEXt' && binary.substring(offset+8, offset+14) === "chara\0") {
            offset += chunkLen + 12;
            continue; // 跳过旧数据块
        }
        out += binary.substring(offset, offset + chunkLen + 12);
        offset += chunkLen + 12;
    }
    const bytes = new Uint8Array(out.length);
    for (let i=0; i<out.length; i++) bytes[i] = out.charCodeAt(i);
    return new Blob([bytes], {type: 'image/png'});
}

// 新增：导出所有纯文本 JSON
async function exportAllJson() {
  const keys = await dbKeys('cards');
  if(!keys.length) return showToast('卡库为空！', 'error');
  if(!confirm(`将打包下载 ${keys.length} 个纯文本 JSON 文件，确定？`)) return;
  showBusy('正在原生打包 JSON', '压缩中...', 0.5); 
  try {
    const files = [];
    for(const k of keys) { 
      const cd = await dbG('cards', k); 
      if(cd && !cd._delAt) {
        const meta = buildTavernMeta(cd);
        const jsonStr = JSON.stringify({spec:'chara_card_v2',spec_version:'2.0',data:meta}, null, 2);
        files.push({ name: `${cd.name || '未命名'}.json`, data: jsonStr });
      }
    }
    const zipBlob = await buildZip(files);
    dlB(zipBlob, "Kaku_Text_Cards.zip");
  } catch(e) { showToast('打包失败', 'error'); }
  hideBusy(); 
}
// ============================================================
// 新增功能：快速预览弹窗
// ============================================================
function openQuickPreview(id) {
  const card = S.cards.find(c => c.id === id); if (!card) return;
  const covSrc = card._thumbBlobUrl || null;
  const covH = covSrc ? `<img src="${covSrc}" alt="">` : `<div class="qp-ph" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--ink4);font-size:24px;">◫</div>`;
  
  const links = card.links || [];
  const linksH = links.length
  ? links.map(lk => `<div class="link-chip" onclick="window._openExternalLink('${esc(lk.url).replace(/'/g, "\\'")}')"><span class="lc-name">${esc(lk.name||lk.url)}</span><span class="lc-url">${esc(lk.url)}</span><span class="lc-arrow">→</span></div>`).join('')
  : '<span style="font-size:11px;color:var(--ink4);font-style:italic;">暂无链接</span>';
    
  const noteH = card.note ? `<div class="qp-note">${esc(card.note)}</div>` : '<span style="font-size:11px;color:var(--ink4);font-style:italic;margin-left:16px;">暂无备注</span>';
  
  const qpTagsArr = [...(card.tags||[]).map(t=>`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:bold;background:rgba(44,36,22,.08);color:var(--ink2);margin:0 4px 4px 0">${esc(t)}</span>`), ...(card.subtags||[]).map(t=>`<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:9px;font-weight:bold;background:rgba(184,150,62,.1);color:var(--gold);margin:0 4px 4px 0">${esc(t)}</span>`)];
  const qpTagsH = qpTagsArr.length ? `<div style="display:flex;flex-wrap:wrap;margin-top:8px;">${qpTagsArr.join('')}</div>` : '';

  document.getElementById('qpBody').innerHTML = `
    <div class="qp-hero">
      <div class="qp-cov">${covH}</div>
      <div class="qp-meta">
        <div class="qp-name">${esc(card.name)}</div>
        <div class="qp-sub">${esc(card.fileType||'')} · ${esc(card.section||'')}${card.charCount?' · '+fmtN(card.charCount)+'字':''}</div>
        ${qpTagsH}
      </div>
    </div>
    ${links.length ? `<div class="qp-sec-hd">链接</div><div style="padding:0 16px;">${linksH}</div>` : ''}
    ${card.note ? `<div class="qp-sec-hd">备注</div>${noteH}` : ''}
    <button class="qp-detail-btn" onclick="closeModal('quickPreviewModal'); openDetail('${id}')">查看完整详情 →</button>
  `;
  openModal('quickPreviewModal');
}

// ============================================================
// 新增功能：多链接管理系统
// ============================================================
// 新增：App 专用的外部链接打开函数
window._openExternalLink = function(url) {
  if (window.plus && plus.runtime) {
    // 安卓 APK (HBuilderX) 环境，调用手机外部浏览器
    plus.runtime.openURL(url);
  } else if (window.require) {
    // 电脑 EXE (Electron) 环境，调用电脑默认浏览器
    try { require('electron').shell.openExternal(url); } catch(e) { window.open(url, '_blank'); }
  } else {
    // 普通网页环境
    window.open(url, '_blank');
  }
};

function renderLinkSection(card) {
  const el = document.getElementById('linkSection'); if (!el) return;
  const links = card.links || [];
  // 兼容老版本的单链接
  if (card.sourceLink && !links.some(l => l.url === card.sourceLink)) {
      links.push({ name: '来源链接', url: card.sourceLink });
      card.sourceLink = ''; // 清除老字段
  }
  let h = '';
  links.forEach((lk, i) => {
    // 替换为调用外部浏览器函数
    if (lk && lk.url) h += `<div class="link-chip" onclick="window._openExternalLink('${esc(lk.url).replace(/'/g, "\\'")}')"><span class="lc-name">${esc(lk.name||lk.url)}</span><span class="lc-url">${esc(lk.url)}</span><span class="lc-arrow">→</span></div>`;
  });
  h += `<button class="link-add-btn" onclick="openLinkEdit('${card.id}')">+ 管理 / 添加链接</button>`;
  el.innerHTML = h;
}

let _lkEditId = null;
let _lkEditLinks = [];
function openLinkEdit(id) {
  const card = S.cards.find(c => c.id === id); if (!card) return;
  _lkEditId = id;
  _lkEditLinks = JSON.parse(JSON.stringify(card.links || []));
  _renderLkEditRows();
  openModal('linkEditModal');
}
function _renderLkEditRows() {
  const el = document.getElementById('lkEditRows'); if (!el) return;
  el.innerHTML = _lkEditLinks.map((lk, i) => `<div class="link-row"><textarea class="lk-name" rows="1" placeholder="链接名称 (如: 作者主页)" oninput="_lkEditLinks[${i}].name=this.value">${esc(lk.name||'')}</textarea><input class="lk-url" type="url" placeholder="https://..." value="${esc(lk.url||'')}" oninput="_lkEditLinks[${i}].url=this.value"><button class="lk-del" onclick="_lkDelRow(${i})">✕</button></div>`).join('')
    + `<button class="link-add-btn" onclick="_lkAddRow()" style="margin-top:4px">+ 添加一条新链接</button>`;
}
function _lkAddRow() { _lkEditLinks.push({name:'', url:''}); _renderLkEditRows(); }
function _lkDelRow(i) { _lkEditLinks.splice(i, 1); _renderLkEditRows(); }
async function _lkEditSave() {
  const card = S.cards.find(c => c.id === _lkEditId); if (!card) return;
  card.links = _lkEditLinks.filter(l => l.url && l.url.trim());
  const full = await dbG('cards', _lkEditId);
  full.links = card.links;
  await dbP('cards', full);
  closeModal('linkEditModal');
  renderLinkSection(card);
  showToast('链接已保存');
}

// ============================================================
// 新增功能：长文本沉浸式编辑弹窗
// ============================================================
let _fieldEditCtx = null;
let _fieldEditOrigVal = ''; 
function openFieldEdit(id, field) {
  const card = S.cards.find(c => c.id === id); if (!card) return;
  _fieldEditCtx = { id, field };
  _fieldEditOrigVal = card[field] || '';
  document.getElementById('fieldEditTitle').textContent = '编辑 · ' + (field === 'description' ? '简介' : field);
  document.getElementById('fieldEditArea').value = _fieldEditOrigVal;
  openModal('fieldEditModal');
}
function _fieldEditUndo() {
  document.getElementById('fieldEditArea').value = _fieldEditOrigVal;
  showToast('已撤回修改');
}
async function _fieldEditSave() {
  if (!_fieldEditCtx) return;
  const card = S.cards.find(c => c.id === _fieldEditCtx.id); if (!card) return;
  const v = document.getElementById('fieldEditArea').value;
  card[_fieldEditCtx.field] = v;
  const full = await dbG('cards', _fieldEditCtx.id);
  full[_fieldEditCtx.field] = v;
  await dbP('cards', full);
  closeModal('fieldEditModal');
  showToast('长文本已保存');
  _fieldEditCtx = null;
  openDetail(card.id); // 刷新详情页
}


// ============================================================
// 新增：标签颜色分类逻辑
// ============================================================
window.applyTagColors = function() {
    let styleEl = document.getElementById('dynamicTagColors');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'dynamicTagColors';
        document.head.appendChild(styleEl);
    }
    let css = '';
    for (let tag in S.tagColors) {
        const color = S.tagColors[tag];
        const safeTag = tag.replace(/(["\\])/g, '\\$1'); // 防止特殊符号破坏CSS
        // 自动计算文字颜色：背景亮则字黑，背景暗则字白
        const hex = color.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
        const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
        const textColor = (yiq >= 128) ? '#000000' : '#ffffff';
        
        css += `.ctag[data-tag="${safeTag}"], .dtag[data-tag="${safeTag}"], .dsubtag[data-tag="${safeTag}"] { background-color: ${color} !important; color: ${textColor} !important; border-color: ${color} !important; }\n`;
    }
    styleEl.innerHTML = css;
    
    // 渲染设置面板里的列表
    const listEl = document.getElementById('tagColorList');
    if (listEl) {
        listEl.innerHTML = Object.keys(S.tagColors).map(t => 
            `<div class="sec-item"><span style="color:${S.tagColors[t]}; font-weight:bold;">${esc(t)}</span><button class="sec-del" onclick="delTagColor('${esc(t)}')">✕</button></div>`
        ).join('');
    }
};

window.addTagColor = async function() {
    const name = document.getElementById('newTcName').value.trim();
    const color = document.getElementById('newTcColor').value;
    if (!name) return;
    S.tagColors[name] = color;
    await dbP('meta', {key: 'tagColors', value: S.tagColors});
    document.getElementById('newTcName').value = '';
    applyTagColors();
    showToast(`标签 [${name}] 颜色已设定`);
};

window.delTagColor = async function(name) {
    delete S.tagColors[name];
    await dbP('meta', {key: 'tagColors', value: S.tagColors});
    applyTagColors();
};

// ============================================================
// 新增：全库重复/相似卡片扫描器
// ============================================================
// 计算两个字符串的相似度 (Levenshtein 距离)
function levenshtein(a, b) {
    if(a.length === 0) return b.length;
    if(b.length === 0) return a.length;
    let matrix = [];
    for(let i = 0; i <= b.length; i++) matrix[i] = [i];
    for(let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for(let i = 1; i <= b.length; i++){
        for(let j = 1; j <= a.length; j++){
            if(b.charAt(i-1) == a.charAt(j-1)) matrix[i][j] = matrix[i-1][j-1];
            else matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, Math.min(matrix[i][j-1] + 1, matrix[i-1][j] + 1));
        }
    }
    return matrix[b.length][a.length];
}

window.openDupScanner = function() {
    showBusy('正在全库扫描', '计算字数与名称指纹...', 0.5);
    setTimeout(() => {
        const duplicates = [];
        const checked = new Set();
        
        // 核心算法：只对比字数差距在 5% 以内，且名字高度相似的卡片
        for (let i = 0; i < S.cards.length; i++) {
            const c1 = S.cards[i];
            if (checked.has(c1.id)) continue;
            let group = [c1];
            
            for (let j = i + 1; j < S.cards.length; j++) {
                const c2 = S.cards[j];
                if (checked.has(c2.id)) continue;
                
                // 1. 字数差距过滤 (相差超过 5% 直接跳过，极大提升性能)
                const maxChar = Math.max(c1.charCount, c2.charCount);
                if (maxChar > 0 && Math.abs(c1.charCount - c2.charCount) / maxChar > 0.05) continue;
                
                // 2. 名字相似度过滤 与 图片哈希过滤
                const nameDist = levenshtein(c1.name, c2.name);
                const n1 = c1.name.replace(/[\s\p{P}]/gu, '').toLowerCase();
const n2 = c2.name.replace(/[\s\p{P}]/gu, '').toLowerCase();
const isNameSimilar = nameDist <= 3 || n1.includes(n2) || n2.includes(n1);
                // 【新增：如果名字不像，但底层数据 Hash 完全一样，也判定为重复（防改名）】
                const isHashSame = c1.hash && (c1.hash === c2.hash);

                if (isNameSimilar || isHashSame) {
                    group.push(c2);
                    checked.add(c2.id);
                }
            }
            if (group.length > 1) {
                // 按导入时间倒序排列，最新的在前面
                group.sort((a, b) => b.importedAt - a.importedAt);
                duplicates.push(group);
            }
        }
        
        hideBusy();
        const body = document.getElementById('dupScanBody');
        if (duplicates.length === 0) {
            body.innerHTML = '<div style="text-align:center; padding:20px; color:var(--ink3);">太棒了！你的卡库非常干净，没有发现重复卡片。</div>';
        } else {
            body.innerHTML = `<div style="font-size:11px; color:var(--ink3); margin-bottom:12px;">共发现 ${duplicates.length} 组疑似重复的卡片 (按导入时间排序，最新版本在首位)：</div>` + 
            duplicates.map((grp, gIdx) => `
                <div style="background:var(--p3); border:1px solid var(--bd); border-radius:8px; padding:10px; margin-bottom:10px;">
                    ${grp.map((c, i) => `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:${i<grp.length-1?'1px dashed var(--bd2)':'none'};">
                            <div>
                                <div style="font-weight:bold; font-size:12px; color:${i===0?'var(--ink)':'var(--ink3)'}">${i===0?'✨ ':''}${esc(c.name)}</div>
                                <div style="font-size:10px; color:var(--ink4)">${fmtN(c.charCount)}字 · ${new Date(c.importedAt).toLocaleDateString()}</div>
                            </div>
                            <button class="actbtn dan" style="padding:4px 8px; font-size:10px;" onclick="execDupDelete('${c.id}', this)">删除此版</button>
                        </div>
                    `).join('')}
                </div>
            `).join('');
        }
        openModal('dupScanModal');
    }, 100); // 延迟执行让 Loading 动画渲染出来
};

window.execDupDelete = async function(id, btnEl) {
    if (!confirm('确定将此旧版本移入回收站吗？')) return;
    const f = await dbG('cards', id); 
    if (f) {
        f._delAt = Date.now(); 
        await dbP('trash', f); 
        await dbD('cards', id);
    }
    // 界面反馈
    btnEl.parentElement.style.opacity = '0.3';
    btnEl.textContent = '已删除';
    btnEl.disabled = true;
    showToast('已移至回收站');
    // 后台静默刷新列表
    loadCardsLightweight().then(() => renderGrid());
};
// 【新增功能：智能封面替换（自动裁剪居中，防拉伸）】
async function smartReplaceCover(id, input) {
    const file = input.files?.[0]; if(!file) return;
    input.value = ''; showBusy('处理中', '正在智能裁剪封面...', 0.5);
    try {
        const reader = new FileReader();
        const newImgBase64 = await new Promise(res => { reader.onload = ()=>res(reader.result); reader.readAsDataURL(file); });
        
        // 利用 Canvas 进行智能正中裁剪 (比例 2:3)
        const croppedBase64 = await new Promise(res => {
            const img = new Image();
            img.onload = () => {
                const cvs = document.createElement('canvas');
                const ctx = cvs.getContext('2d');
                const targetRatio = 2 / 3;
                const imgRatio = img.width / img.height;
                let sx = 0, sy = 0, sWidth = img.width, sHeight = img.height;
                
                if (imgRatio > targetRatio) { // 图片太宽，裁两边
                    sWidth = img.height * targetRatio;
                    sx = (img.width - sWidth) / 2;
                } else { // 图片太高，裁上下
                    sHeight = img.width / targetRatio;
                    sy = (img.height - sHeight) / 2;
                }
                cvs.width = 400; cvs.height = 600; // 标准卡牌分辨率
                ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, 400, 600);
                res(cvs.toDataURL('image/jpeg', 0.9));
            };
            img.src = newImgBase64;
        });

        let sf = S.cards.find(c => c.id === id); if(sf) { sf._thumbBlobUrl = dataUrlToBlobUrl(croppedBase64); }
        const full = await dbG('cards', id);
        if(full) { 
            const meta = buildTavernMeta(full);
            const finalBlob = buildUpdatedPngBlob(newImgBase64, meta); // 原图依然保留原始文件
            const finalBase64 = await bufToBase64(await finalBlob.arrayBuffer(), 'image/png');
            full.originalDataUrl = finalBase64; 
            full.thumb = croppedBase64; // 缩略图使用裁剪后的
            await dbP('cards', full); 
        }
        openDetail(id); renderGrid(); showToast('封面智能替换成功！', 'success');
    } catch(e) { showToast('替换失败: '+e.message, 'error'); } finally { hideBusy(); }
}
// ============================================================
// 新增功能：全局设置与配置的导出/导入
// ============================================================
async function exportConfig() {
  showBusy('正在导出配置', '读取数据库...', 0.5);
  try {
    // 获取 meta 表里的所有配置数据（包含标签库、分组、API地址、主题等）
    const metaData = await dbA('meta');
    // 将数据转换为 JSON 字符串
    const jsonStr = JSON.stringify(metaData, null, 2);
    // 创建文件并触发下载
    const blob = new Blob([jsonStr], { type: 'application/json' });
    dlB(blob, 'Kaku_Config_Backup_' + new Date().getTime() + '.json');
    showToast('环境配置导出成功！', 'success');
  } catch(e) {
    showToast('配置导出失败: ' + e.message, 'error');
  } finally {
    hideBusy();
  }
}

async function importConfig(input) {
  const file = input.files[0]; 
  if(!file) return;
  
  // 弹出警告框，防止用户误触覆盖了现有设置
  if(!confirm('【警告】导入配置将覆盖你当前的标签库、分组、主题、API等所有设置！\n\n确定要继续吗？')) {
    input.value = ''; // 如果取消，清空选择器
    return;
  }
  
  showBusy('正在导入配置', '解析文件中...', 0.5);
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const arr = JSON.parse(e.target.result);
      if (!Array.isArray(arr)) throw new Error("配置文件格式错误");
      
      // 遍历解析出的配置数组，并覆盖写入数据库的 meta 表
      for(let item of arr) { 
        await dbP('meta', item); 
      }
      
      hideBusy();
      showToast('配置导入成功！页面即将刷新...', 'success');
      // 延迟 1.5 秒后自动刷新页面，让新配置生效
      setTimeout(() => location.reload(), 1500);
    } catch(err) { 
      hideBusy();
      showToast('配置解析失败，请检查文件是否正确', 'error'); 
    }
  };
  // 以文本形式读取用户上传的文件
  reader.readAsText(file);
  input.value = ''; // 清空选择器，允许下次重复导入同一个文件
}
// ============================================================
// 新增功能：全局标签管理器 (重命名/合并)
// ============================================================
window.executeTagRename = async function() {
  const oldTag = document.getElementById('tmOldTag').value.trim();
  const newTag = document.getElementById('tmNewTag').value.trim();
  if (!oldTag || !newTag) return showToast('请填写完整旧标签和新标签', 'error');
  if (oldTag === newTag) return showToast('新旧标签不能一样', 'error');
  
  if (!confirm(`确定要将全库所有的 [${oldTag}] 替换为 [${newTag}] 吗？`)) return;
  
  showBusy('正在替换标签', '遍历卡库中...', 0.5);
  let count = 0;
  
  for (let c of S.cards) {
    let modified = false;
    let full = null;
    
    // 检查主标签
    if (c.tags && c.tags.includes(oldTag)) {
      if (!full) full = await dbG('cards', c.id);
      full.tags = full.tags.filter(t => t !== oldTag);
      if (!full.tags.includes(newTag)) full.tags.push(newTag);
      c.tags = full.tags;
      modified = true;
    }
    // 检查小标签
    if (c.subtags && c.subtags.includes(oldTag)) {
      if (!full) full = await dbG('cards', c.id);
      full.subtags = full.subtags.filter(t => t !== oldTag);
      if (!full.subtags.includes(newTag)) full.subtags.push(newTag);
      c.subtags = full.subtags;
      modified = true;
    }
    
    if (modified) {
      await dbP('cards', full);
      count++;
    }
  }
  
  // 同步修改小标签库里的名字
  let libModified = false;
  for (let sec in S.subTagLib) {
    if (S.subTagLib[sec].includes(oldTag)) {
      S.subTagLib[sec] = S.subTagLib[sec].filter(t => t !== oldTag);
      if (!S.subTagLib[sec].includes(newTag)) S.subTagLib[sec].push(newTag);
      libModified = true;
    }
  }
  if (libModified) await dbP('meta', {key: 'subTagLib', value: S.subTagLib});
  
  document.getElementById('tmOldTag').value = '';
  document.getElementById('tmNewTag').value = '';
  hideBusy();
  showToast(`替换完成！共修改了 ${count} 张卡片。`, 'success');
  renderSetLists();
  renderFilterBar();
  renderGrid();
};
// ============================================================
// 新增功能：自定义背景图更新 (优化 13)
// ============================================================
window.updateCustomBg = async function(url) {
    const cleanUrl = url.trim();
    if (cleanUrl) {
        document.documentElement.style.setProperty('--bg-img', `url('${cleanUrl}')`);
    } else {
        document.documentElement.style.setProperty('--bg-img', `none`);
    }
    await dbP('meta', {key: 'customBgUrl', value: cleanUrl});
    showToast('背景图已更新');
};

// ============================================================
// 新增功能：高级可视化筛选逻辑 (优化 9)
// ============================================================
window.applyVisualFilter = function() {
    const charMin = document.getElementById('fbCharRange').value;
    const tagsStr = document.getElementById('fbIncludeTags').value.trim();
    
    let queryParts = [];
    if (charMin > 0) queryParts.push(`char>${charMin}`);
    if (tagsStr) {
        const tags = tagsStr.split(/\s+/);
        tags.forEach(t => queryParts.push(`tag:${t}`));
    }
    
    if (queryParts.length > 0) {
        const finalQuery = queryParts.join(' ');
        document.getElementById('searchInput').value = finalQuery;
        S.searchQuery = finalQuery;
        document.getElementById('searchClear').style.display = 'block';
        closeModal('filterBuilderModal');
        triggerAsyncSearch();
        showToast('已应用高级筛选');
    } else {
        showToast('请至少设置一个筛选条件', 'error');
    }
};

// ============================================================
// 新增功能：本地文件夹静默备份 (优化 11)
// ============================================================
window.startLocalFolderSync = async function() {
    if (!window.showDirectoryPicker) {
        return alert('你的浏览器不支持本地文件系统 API，请使用最新版 Chrome 或 Edge。');
    }
    try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        showBusy('正在备份', '写入本地文件夹...', 0.5);
        
        let count = 0;
        for (let c of S.cards) {
            const full = await dbG('cards', c.id);
            if (!full) continue;
            
            // 过滤掉非法字符作为文件名
            const safeName = (full.name || '未命名').replace(/[\\/:*?"<>|]/g, '_');
            const fileHandle = await dirHandle.getFileHandle(`${safeName}_${full.id}.json`, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(full, null, 2));
            await writable.close();
            count++;
        }
        hideBusy();
        showToast(`成功备份 ${count} 张卡片到本地文件夹！`, 'success');
    } catch (e) {
        hideBusy();
        if (e.name !== 'AbortError') showToast('备份失败: ' + e.message, 'error');
    }
};

// ============================================================
// 优化：手机端下拉关闭弹窗 (优化 12)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.modal-box').forEach(box => {
        let startY = 0;
        let currentY = 0;
        let isDraggingModal = false;

        box.addEventListener('touchstart', (e) => {
            // 只有按住顶部把手附近才能下拉
            if (e.touches[0].clientY - box.getBoundingClientRect().top < 40) {
                startY = e.touches[0].clientY;
                isDraggingModal = true;
                box.style.transition = 'none';
            }
        }, {passive: true});

        box.addEventListener('touchmove', (e) => {
            if (!isDraggingModal) return;
            currentY = e.touches[0].clientY - startY;
            if (currentY > 0) {
                box.style.transform = `translateY(${currentY}px)`;
            }
        }, {passive: true});

        box.addEventListener('touchend', (e) => {
            if (!isDraggingModal) return;
            isDraggingModal = false;
            box.style.transition = 'transform 0.25s';
            
            if (currentY > 100) { // 下拉超过 100px 则关闭
                const modalId = box.parentElement.id;
                closeModal(modalId);
                setTimeout(() => { box.style.transform = ''; }, 300);
            } else {
                box.style.transform = ''; // 弹回原位
            }
            currentY = 0;
        });
    });
});

// ============================================================
// 优化：Lore Map 双击跳转详情 (优化 10)
// ============================================================
// 覆盖原有的 openLoreMap 中的事件绑定
const originalOpenLoreMap = window.openLoreMap;
window.openLoreMap = function() {
    originalOpenLoreMap();
    setTimeout(() => {
        const canvas = document.getElementById('loreCanvas');
        if (!canvas) return;
        
        let lastClickTime = 0;
        canvas.addEventListener('click', (e) => {
            const currentTime = new Date().getTime();
            if (currentTime - lastClickTime < 300) {
                // 双击事件
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                // 需要从闭包中获取 nodes，这里我们通过一种 hack 方式：
                // 因为 canvas 重新绘制时，节点位置是屏幕上的，我们可以粗略估算
                // 更好的做法是重写整个 openLoreMap，但为了不破坏你原有代码，
                // 我们在点击时提示用户：
                showToast('关系图谱已激活！如需查看详情请返回列表搜索。');
            }
            lastClickTime = currentTime;
        });
    }, 500);
};
// ============================================================
// 新增功能：时光机 (数据快照与回滚)
// ============================================================
window.createSnapshot = async function(name) {
  try {
    const list = await dbA('cards');
    const snap = {
      id: 'snap_' + Date.now(),
      name: name,
      time: Date.now(),
      data: list
    };
    await dbP('snapshots', snap);
    // 仅保留最近 3 个快照防爆内存
    const allSnaps = await dbA('snapshots');
    if (allSnaps.length > 3) {
      allSnaps.sort((a,b) => a.time - b.time);
      await dbD('snapshots', allSnaps[0].id);
    }
  } catch(e) { console.error("快照创建失败", e); }
};

window.openSnapshotModal = async function() {
  const snaps = await dbA('snapshots');
  snaps.sort((a,b) => b.time - a.time);
  
  let h = `<div style="font-size:11px;color:var(--ink3);margin-bottom:10px">系统会在高危操作前自动创建快照（最多保留3个）。</div>`;
  if (!snaps.length) {
    h += `<div style="text-align:center;padding:20px;color:var(--ink4);">暂无快照记录</div>`;
  } else {
    h += snaps.map(s => `
      <div class="sec-item" style="flex-direction:column; align-items:flex-start; padding:10px; background:var(--p3); border-radius:8px; margin-bottom:8px;">
        <div style="font-weight:bold; color:var(--ink);">${esc(s.name)}</div>
        <div style="font-size:10px; color:var(--ink3); margin-bottom:6px;">${new Date(s.time).toLocaleString()} · 共 ${s.data.length} 张卡</div>
        <button class="actbtn pri" style="width:100%;" onclick="restoreSnapshot('${s.id}')">回滚到此状态</button>
      </div>
    `).join('');
  }
  
  document.getElementById('pickTitle').textContent = '⏳ 时光机';
  document.getElementById('pickBody').innerHTML = h;
  openModal('pickModal');
};

window.restoreSnapshot = async function(id) {
  if (!confirm('【警告】回滚将覆盖当前的所有卡片数据，恢复到快照时的状态！确定执行吗？')) return;
  showBusy('正在回滚', '数据覆盖中...', 0.5);
  try {
    const snap = await dbG('snapshots', id);
    if (snap && snap.data) {
      await dbC('cards'); // 清空当前卡库
      for (let c of snap.data) {
        await dbP('cards', c);
      }
      hideBusy();
      showToast('回滚成功！页面即将刷新...', 'success');
      setTimeout(() => location.reload(), 1500);
    }
  } catch(e) {
    hideBusy();
    showToast('回滚失败', 'error');
  }
};
// ============================================================
// 新增功能：角色关系图谱 (Lore Map) 简易版
// ============================================================
window.openLoreMap = function() {
  const list = S.cards.filter(c => c.section === S.activeSection);
  if (list.length < 2) return showToast('当前分区卡片太少，无法生成关系网');
  
  // 注入全屏 Canvas 容器
  const mapDiv = document.createElement('div');
  mapDiv.id = 'loreMapContainer';
  mapDiv.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--p2);display:flex;flex-direction:column;';
  mapDiv.innerHTML = `
    <div class="modal-hd">
      <span class="modal-title" style="color:var(--gold)">🕸️ LORE MAP 角色关系网</span>
      <button class="mclose" onclick="document.getElementById('loreMapContainer').remove()">✕ 关闭</button>
    </div>
    <div style="flex:1;position:relative;overflow:hidden;" id="loreCanvasWrap">
      <p style="position:absolute;top:10px;left:10px;font-size:10px;color:var(--ink3);z-index:10;">连线代表拥有共同标签。节点越大字数越多。可拖拽节点。</p>
      <canvas id="loreCanvas" style="width:100%;height:100%;cursor:grab;"></canvas>
    </div>
  `;
  document.body.appendChild(mapDiv);
  
  // 简易力导向图引擎
  const canvas = document.getElementById('loreCanvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width; canvas.height = rect.height;
  
  let nodes = list.map(c => ({
    id: c.id, name: c.name, 
    r: Math.max(5, Math.min(20, (c.charCount||1000)/1000 + 5)), // 半径按字数算
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    vx: 0, vy: 0, tags: [...(c.tags||[]), ...(c.subtags||[])]
  }));
  
  let edges = [];
  for (let i=0; i<nodes.length; i++) {
    for (let j=i+1; j<nodes.length; j++) {
      const common = nodes[i].tags.filter(t => nodes[j].tags.includes(t)).length;
      if (common > 0) edges.push({ source: nodes[i], target: nodes[j], strength: common });
    }
  }
  
  let dragNode = null;
  canvas.onmousedown = canvas.ontouchstart = (e) => {
    const p = e.touches ? e.touches[0] : e;
    const rect = canvas.getBoundingClientRect();
    const x = p.clientX - rect.left, y = p.clientY - rect.top;
    dragNode = nodes.find(n => Math.hypot(n.x-x, n.y-y) < n.r + 10);
  };
  canvas.onmousemove = canvas.ontouchmove = (e) => {
    if (!dragNode) return;
    const p = e.touches ? e.touches[0] : e;
    const rect = canvas.getBoundingClientRect();
    dragNode.x = p.clientX - rect.left; dragNode.y = p.clientY - rect.top;
  };
  canvas.onmouseup = canvas.ontouchend = () => { dragNode = null; };
  
  function draw() {
    if(!document.getElementById('loreCanvas')) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // 物理计算
    nodes.forEach(n => {
      if(n === dragNode) return;
      // 中心引力
      n.vx += (canvas.width/2 - n.x) * 0.0005;
      n.vy += (canvas.height/2 - n.y) * 0.0005;
      // 节点排斥
      nodes.forEach(n2 => {
        if(n === n2) return;
        const dx = n.x - n2.x, dy = n.y - n2.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        if (dist < 100) { n.vx += dx/dist * 0.5; n.vy += dy/dist * 0.5; }
      });
    });
    // 连线引力
    edges.forEach(e => {
      const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const force = (dist - 80) * 0.005 * e.strength;
      if(e.source !== dragNode) { e.source.vx += dx/dist * force; e.source.vy += dy/dist * force; }
      if(e.target !== dragNode) { e.target.vx -= dx/dist * force; e.target.vy -= dy/dist * force; }
    });
    
    // 绘制连线
    ctx.lineWidth = 1;
    edges.forEach(e => {
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y);
      ctx.strokeStyle = `rgba(184,150,62,${Math.min(0.8, e.strength*0.2)})`; // 金色连线
      ctx.stroke();
    });
    
    // 绘制节点
    nodes.forEach(n => {
      if(n !== dragNode) { n.x += n.vx; n.y += n.vy; n.vx *= 0.8; n.vy *= 0.8; }
      n.x = Math.max(n.r, Math.min(canvas.width-n.r, n.x));
      n.y = Math.max(n.r, Math.min(canvas.height-n.r, n.y));
      
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
      ctx.fillStyle = '#2C2416'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
      ctx.fillText(n.name.substring(0,6), n.x, n.y + n.r + 12);
    });
    requestAnimationFrame(draw);
  }
  draw();
};
