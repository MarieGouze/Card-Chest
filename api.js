// ============================================================
// 【核心功能】酒馆 TAVERN API 破壁互联 (终极修复版)
// ============================================================

let tavernProxy = '';
async function loadTavernConfig() {
  const r = await dbG('meta', 'tavernProxyUrl'); if (r) tavernProxy = r.value;
  if(document.getElementById('tavernProxyUrl')) document.getElementById('tavernProxyUrl').value = tavernProxy;
}
function saveTavernConfig() {
  const val = document.getElementById('tavernProxyUrl').value.trim();
  tavernProxy = val.endsWith('/') ? val.slice(0, -1) : val;
  dbP('meta', {key: 'tavernProxyUrl', value: tavernProxy});
  showToast('Tavern 云端 API 已连接');
}

// 一键推送至酒馆 (单卡推送)
async function pushCardToTavern(id) {
  if(!tavernProxy) return alert("请先在设置中配置 Tavern API Proxy!");

  const c = await dbG('cards', id);
  if(!c) return;
  if(!c.originalDataUrl) return showToast('此项目无图像源文件，暂不支持推送！');

  if (!confirm(`准备将 [${c.name}] 推送至酒馆，确认执行？\n\n(系统会自动检测同名卡片并无损覆盖，保留聊天记录)`)) return;

  showBusy('正在向酒馆发送', 'Cloud API Pushing...', 0.3);

  try {
    // 1. 获取酒馆现有角色列表，用于排重
    let listResp = await fetch(tavernProxy + '/api/characters/all', { method: 'POST', body: JSON.stringify({}) }).catch(()=>fetch(tavernProxy + '/api/characters/all'));
    let list = await listResp.json();
    if (!Array.isArray(list)) list = list.default || Object.values(list);
    const existChar = list.find(card => card.name === c.name);

    // 2. 解析本地 PNG
    const blob = await fetch(c.originalDataUrl).then(r=>r.blob());
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

    // 核心打包：生成新图片
    const finalBlob = buildUpdatedPngBlob(c.originalDataUrl, meta);
    
    // ✨ 修复重复问题：过滤特殊字符用真名。如果同名存在先删图保聊天记录，如果不存在直接用角色本名。
    let safeName = c.name.replace(/[\\/:*?"<>|]/g, '');
    let targetAvatar = existChar ? existChar.avatar : `${safeName}.png`;
    
    if (existChar) {
        let isOverwrite = confirm(`酒馆中已存在同名角色 [${c.name}]。\n\n▶ 点击【确定】覆盖旧版（同步更新世界书等设定）。\n▶ 点击【取消】保留两者（将作为独立的 IF 线新角色推送）。`);
        
        if (isOverwrite) {
            document.getElementById('busySub').textContent = `正在清理旧版本...`;
            await fetch(tavernProxy + '/api/characters/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar_url: existChar.avatar })
            }).catch(e => console.warn(e));
        } else {
            // 选择取消时：保留两者，生成全新的头像文件名，避免任何冲突
            targetAvatar = `${safeName}_IF_${Date.now()}.png`;
        }
    }

    document.getElementById('busySub').textContent = `正在写入新版本...`;
    const fd = new FormData();
    fd.append("avatar", finalBlob, targetAvatar);
    fd.append("file_type", "png");
    fd.append("preserved_name", targetAvatar);

    const importResp = await fetchWithRetry(tavernProxy + '/api/characters/import', { method: 'POST', body: fd });
    if (!importResp.ok) throw new Error(await importResp.text());

    showToast(`📝无损推送成功！[${c.name}]的世界书已同步且无重复。`);

  } catch(e) {
    alert("网络通讯或覆盖失败\n错误原因：" + e.message);
  } finally {
    hideBusy();
  }
}

// ============================================================
// 重写：酒馆智能拉取选单 (Tavern Pull UI)
// ============================================================
let _tavernPullList = []; 

async function pullFromTavern() {
  if(!tavernProxy) return alert("请先配置 Tavern API Proxy!");
  showBusy('请求酒馆数据', '正在获取远端角色列表...', 0.2);
  
  try {
    let resp = await fetch(tavernProxy + '/api/characters/all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({shallow: true}) }).catch(()=>fetch(tavernProxy + '/api/characters/all'));
    if(!resp.ok) throw new Error(`服务端返回 ${resp.status}`);
    
    let list = await resp.json();
    if (!Array.isArray(list)) list = list.default || Object.values(list);
    
    _tavernPullList = [];
    document.getElementById('busySub').textContent = `正在与本地哈希进行指纹比对...`;
    
    for(let i=0; i<list.length; i++) {
        const ci = list[i];
        document.getElementById('busyBar').style.width = ((i/list.length)*100)+'%';
        const hashCandidate = await asyncHash(ci.name + ci.description);
        const exist = S.cards.find(x => x.name === ci.name || x.hash === hashCandidate);
        _tavernPullList.push({
            rawData: ci, name: ci.name, avatar: ci.avatar, isNew: !exist, localId: exist ? exist.id : null
        });
    }
    
    hideBusy(); renderTavernPullUI(); openModal('tavernPullModal');
  } catch(e) { hideBusy(); alert("拉取异常：" + e.message); }
}

let _tpAvatarObs = null;
function renderTavernPullUI() {
    const listEl = document.getElementById('tpList');
    if(!_tavernPullList.length) { listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink3);font-size:12px;">酒馆里目前没有卡片</div>'; return; }
    
    listEl.innerHTML = _tavernPullList.map((c, idx) => `
        <label style="display:flex; align-items:center; padding:10px; border-bottom:1px solid var(--bd2); cursor:pointer; transition:background .2s;">
            <input type="checkbox" class="tp-checkbox" data-idx="${idx}" ${c.isNew ? 'checked' : ''} style="margin-right:12px; width:16px; height:16px;">
            <div style="width:40px; height:40px; border-radius:50%; background:var(--p3); margin-right:12px; overflow:hidden; border:1px solid var(--bd);">
                <img data-avatar="${esc(c.avatar||'')}" class="tp-avatar" style="width:100%; height:100%; object-fit:cover;" onerror="this.style.display='none'">
            </div>
            <div style="flex:1;">
                <div style="font-size:13px; font-weight:bold; color:var(--ink);">${esc(c.name)}</div>
                <div style="font-size:10px; margin-top:2px; ${c.isNew ? 'color:var(--gold);' : 'color:var(--ink3);'}">${c.isNew ? '✨ 本地未收录 (新卡)' : '✓ 本地已存在'}</div>
            </div>
        </label>
    `).join('');

    if(_tpAvatarObs) _tpAvatarObs.disconnect();
    _tpAvatarObs = new IntersectionObserver((ents) => {
        ents.forEach(en => {
            if(en.isIntersecting){
                const img = en.target;
                const av = img.dataset.avatar;
                if(av){
                    img.removeAttribute('data-avatar');
                    fetch(tavernProxy + '/characters/' + encodeURIComponent(av))
                        .then(r => r.blob())
                        .then(b => { img.src = URL.createObjectURL(b); })
                        .catch(() => { img.style.display = 'none'; });
                }
                _tpAvatarObs.unobserve(img);
            }
        });
    }, { root: listEl, rootMargin: '200px' });
    
    listEl.querySelectorAll('.tp-avatar').forEach(img => _tpAvatarObs.observe(img));
}

// ✨ 新增：Tavern 拉取列表的无感搜索过滤
function filterTavernPullList(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#tpList label').forEach(lbl => {
        // 动态隐藏不匹配的项
        lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}
// ✨ 优化：快捷勾选按钮只对搜索过滤后【当前可见】的卡片生效，避免误操作
function tpCheckSmart() { document.querySelectorAll('#tpList label').forEach(lbl => { if (lbl.style.display !== 'none') { const cb = lbl.querySelector('.tp-checkbox'); cb.checked = _tavernPullList[cb.dataset.idx].isNew; } }); }
function tpCheckAll() { document.querySelectorAll('#tpList label').forEach(lbl => { if (lbl.style.display !== 'none') lbl.querySelector('.tp-checkbox').checked = true; }); }
function tpCheckNone() { document.querySelectorAll('#tpList label').forEach(lbl => { if (lbl.style.display !== 'none') lbl.querySelector('.tp-checkbox').checked = false; }); }

async function executeTavernPull() {
    const selectedIdxs = Array.from(document.querySelectorAll('.tp-checkbox:checked')).map(cb => parseInt(cb.dataset.idx));
    if(!selectedIdxs.length) return showToast('未勾选任何卡片');
    
    closeModal('tavernPullModal'); showBusy('正在拉取', '准备就绪...', 0);
    let pullOk = 0;
    for(let i=0; i<selectedIdxs.length; i++) {
        const target = _tavernPullList[selectedIdxs[i]]; const ci = target.rawData;
        document.getElementById('busySub').textContent = `正在拉取 (${i+1}/${selectedIdxs.length}): ${ci.name}`;
        document.getElementById('busyBar').style.width = ((i/selectedIdxs.length)*100)+'%';
        try {
             const avatarResp = await fetch(tavernProxy + '/characters/' + ci.avatar);
             if(!avatarResp.ok) throw new Error();
             const avatarBlob = await avatarResp.blob(); const buffer = await avatarBlob.arrayBuffer();
             
             let meta = getMetaFromBuffer(buffer);

             const reader = new FileReader();
             const base64Str = await new Promise(res => { reader.onload = ()=>res(reader.result); reader.readAsDataURL(new Blob([buffer])); });
             
             const charData = ci.data || ci; const finalDesc = meta.description || charData.description || ci.description || "";
             const finalMeta = (meta && Object.keys(meta).length > 0) ? meta : (ci.data || ci || {});
             const dlgs = [];
             if(finalMeta.mes_example) dlgs.push(finalMeta.mes_example);
             if(finalMeta.first_mes) dlgs.push(finalMeta.first_mes);
             if(finalMeta.alternate_greetings && Array.isArray(finalMeta.alternate_greetings)) finalMeta.alternate_greetings.forEach(g => dlgs.push(g));
             
             let wbEntries = [];
             if(finalMeta.character_book && finalMeta.character_book.entries) {
               wbEntries = finalMeta.character_book.entries.map(e => ({
                 name: (e.comment && e.comment.trim()) || '（无标题）', keys: Array.isArray(e.keys) ? e.keys.join(', ') : (e.keys || ''),
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


               wbEntries = Object.values(finalMeta.world_info).map(e => ({ keys: (e.keys || e.key || []).join?.(', ') || '', content: e.content || e.value || '' }));
             }

             let pres = []; const promptArr = finalMeta.prompts || (finalMeta.prompt_order && finalMeta.prompts);
             if(Array.isArray(promptArr)) promptArr.forEach(p => { if(p && (p.name || p.identifier)) pres.push({name: '▸ ' + (p.name || p.identifier), content: String(p.content || p.text || p.value || p.prompt || p.message || '')}) });
             const rx = finalMeta.regex_scripts || finalMeta.scripts;
             if(Array.isArray(rx)) rx.forEach(s => { if(s && (s.scriptName || s.name)) pres.push({name: '⟢ ' + (s.scriptName || s.name), content: s.replaceString || s.replace || s.findRegex || s.content || ''}) });

             // 智能防覆盖：如果本次批量拉取中已经导入过同名卡，强制分配新ID，不覆盖
             const isDuplicateInBatch = window._batchImportedNames && window._batchImportedNames.has(ci.name);
             const newCard = {
                id: (target.localId && !isDuplicateInBatch) ? target.localId : ('c_' + uuid()), hash: await asyncHash(ci.name + finalDesc),
                name: meta.name || ci.name, description: finalDesc,
                personality: meta.personality || charData.personality || ci.personality || "",
                first_mes: meta.first_mes || charData.first_mes || ci.first_mes || "",
                mesExample: meta.mes_example || charData.mes_example || ci.mes_example || "",
                note: meta.creator_notes || charData.creator_notes || charData.note || ci.creator_notes || "",
                originalDataUrl: base64Str, thumb: await genThumb(base64Str, 400),
                fileType: 'image/png', fileSize: avatarBlob.size, importedAt: Date.now(),
                section: S.sections[0], tags: meta.tags || ci.tags || charData.tags || [],
                charCount: finalDesc.length, groupId: '', dialogEntries: dlgs, worldBookEntries: wbEntries, presetEntries: pres
             };
             
             if (target.localId && !isDuplicateInBatch) {
                 let isOverwrite = confirm(`本地卡库中已存在同名卡片 [${newCard.name}]。\n\n▶ 点击【确定】覆盖本地旧版。\n▶ 点击【取消】保留两者（将作为独立的新版本/IF线存入卡库）。`);
                 if (isOverwrite) {
                     await dbD('cards', target.localId);
                     newCard.id = target.localId; // 覆盖模式：保持原有底层 ID 不变
                 } else {
                     newCard.name = newCard.name + ' (IF分支)'; // 保留两者模式：加个后缀方便你区分
                 }
             }
             await dbP('cards', newCard); pullOk++;
                          if (!window._batchImportedNames) window._batchImportedNames = new Set();
             window._batchImportedNames.add(ci.name);
        } catch(ex) {}
    }
    
    hideBusy(); await loadCardsLightweight(); renderAll();
    showToast(`拉取完毕！成功处理 ${pullOk} 张卡片。`);
}

// ============================================================
// 导入与解析引擎 (EXIF, JSON, 差异对比)
// ============================================================
const CHUNK_TEXT = 1952807028;
let pendFiles = [];
function openImport() {
  pendFiles = [];
  document.getElementById('progBox').style.display = 'none';
  document.getElementById('dupList').innerHTML = '';
  document.getElementById('fileInput').value = '';
  if (typeof refreshPending === 'function') refreshPending();
  
  const sel = document.getElementById('importSection');
  if (sel && sel.options.length === 0) {
    S.sections.forEach(s => { 
      const o = document.createElement('option'); 
      o.value = s; 
      o.textContent = s; 
      sel.appendChild(o); 
    });
  }
  if (sel) sel.value = S.activeSection;
  openModal('importModal');
}
function triggerFile() { document.getElementById('fileInput').click(); }
document.getElementById('fileInput').addEventListener('change', e => { if (e.target.files.length) handleFilesDrop(Array.from(e.target.files)); });
document.getElementById('dropZone').addEventListener('dragover', e => { e.preventDefault(); e.currentTarget.classList.add('drag'); globalDropNode.classList.add('drag'); });
document.getElementById('dropZone').addEventListener('dragleave', e => { e.currentTarget.classList.remove('drag'); globalDropNode.classList.remove('drag'); });
document.getElementById('dropZone').addEventListener('drop', e => { e.preventDefault(); e.currentTarget.classList.remove('drag'); globalDropNode.classList.remove('drag'); if (e.dataTransfer.files.length) handleFilesDrop(Array.from(e.dataTransfer.files)); });

const globalDropNode = document.getElementById('globalDrop');
document.addEventListener('dragover', e => { e.preventDefault(); if (S.layout!=='list' || e.dataTransfer.types.includes('Files')) globalDropNode.classList.add('drag'); });
globalDropNode.addEventListener('dragleave', e => { globalDropNode.classList.remove('drag'); });
globalDropNode.addEventListener('drop', e => { e.preventDefault(); globalDropNode.classList.remove('drag'); if (e.dataTransfer.files.length) handleFilesDrop(Array.from(e.dataTransfer.files)); });

function handleFilesDrop(files) {
  openModal('importModal');
  if(!document.getElementById('importSection').options.length) {
    S.sections.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; document.getElementById('importSection').appendChild(o); });
  }
  const t = document.getElementById('importSection').value || S.activeSection; 
  document.getElementById('importSection').value = t;

  pendFiles.push(...files); refreshPending();
}

function refreshPending() {
  document.getElementById('dropZone').style.display = pendFiles.length ? 'none' : 'block';
  document.getElementById('pendBox').style.display = pendFiles.length ? 'block' : 'none';
  document.getElementById('pendCount').textContent = pendFiles.length;
  document.getElementById('pendList').innerHTML = pendFiles.slice(0,10).map(f=>`<div>📄 ${esc(f.name)} (${fmtSZ(f.size)})</div>`).join('') + (pendFiles.length>10?`<div>...及另外 ${pendFiles.length-10} 个</div>`:'');
  document.getElementById('progBox').style.display = 'none'; document.getElementById('dupList').innerHTML = '';
}
function clearPending() { pendFiles=[]; refreshPending(); }

async function startImport() {
  if (!pendFiles.length) return;
  const targetSec = document.getElementById('importSection').value;
  const pb = document.getElementById('progBox'), bar = document.getElementById('progBar'), cnt = document.getElementById('progCount'), ld = document.getElementById('impLog');
  pb.style.display = 'block'; document.getElementById('pendBox').style.display = 'none'; document.getElementById('dupList').innerHTML = '';
  let ok = 0, fail = 0;
  
  for (let i=0; i<pendFiles.length; i++) {
    const file = pendFiles[i];
    bar.style.width = ((i/pendFiles.length)*100)+'%';
    cnt.textContent = `${i+1} / ${pendFiles.length}`;
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let meta = null, base64 = null, textData = null;

      // [修复] 补全 ArrayBuffer 读取
      const buffer = await file.arrayBuffer(); 

      // 辅助函数：前端轻量静默压缩图像 (根据用户设置)
      const silentCompress = async (base64Src) => {
        const strategy = await dbG('meta', 'imgStrategy');
        const maxW = strategy ? parseInt(strategy.value) : 1200;
        if (maxW >= 99999) return base64Src; // 不压缩
        return new Promise(res => {
          const img = new Image();
          img.onload = () => {
            if (img.width <= maxW) return res(base64Src);
            const cvs = document.createElement('canvas'); const ctx = cvs.getContext('2d');
            const scale = maxW / img.width; cvs.width = maxW; cvs.height = img.height * scale;
            ctx.drawImage(img, 0, 0, cvs.width, cvs.height); res(cvs.toDataURL('image/jpeg', 0.86));
          };
          img.onerror = () => res(base64Src); img.src = base64Src;
        });
      };
          
      if (ext === 'png') {
            const charaStr = extractExifMetadata(buffer, 'chara');
            if(charaStr) {
               try {
                   // 尝试标准的 Base64 解析
               const decoded = atob(charaStr); 
               textData = new TextDecoder('utf-8').decode(Uint8Array.from(decoded, c=>c.charCodeAt(0)));
               meta = parseTavernJson(textData);
           } catch (e) {
               // 兼容免 Base64 加密，直接写入原始 JSON 的改版卡片
               meta = parseTavernJson(charaStr);
               textData = charaStr;
           }
        }
        base64 = await bufToBase64(buffer, 'image/png');
        if (base64 && base64.length > 1.5 * 1024 * 1024) base64 = await silentCompress(base64);
      } else if (ext === 'webp') {
        base64 = await bufToBase64(buffer, 'image/webp');
        if (base64 && base64.length > 1.5 * 1024 * 1024) base64 = await silentCompress(base64);
      } else if (ext === 'json') {
        textData = new TextDecoder().decode(buffer);
        meta = JSON.parse(textData);
      } else if (ext === 'txt') { // 补回 TXT 纯文本解析
        textData = new TextDecoder().decode(buffer);
        meta = { name: file.name.replace(/\.[^/.]+$/, ''), description: textData, tags: [] };
      } else if (ext === 'docx') { // ✨ 补回 DOCX 极简解析
        try {
          textData = await parseDocx(buffer);
          meta = { name: file.name.replace(/\.[^/.]+$/, ''), description: textData, tags: [] };
          file.type = 'DOCX';
        } catch(e) {
          meta = { name: file.name.replace(/\.[^/.]+$/, ''), description: '[DOCX 解析失败: ' + e.message + ']', tags: [] };
        }
      }
      if (!meta) meta = { name: file.name.replace(/\.[^/.]+$/, ''), description: '', tags: [] };
      
      // 基于文本或图像哈希排重
      const textForHash = (meta.name||'') + (meta.description||'') + (meta.mes_example||'');
      const hash = textData ? await asyncHash(textForHash) : (await asyncHash(base64.slice(0, 50000)));
      
      let cCount = (meta.name ? meta.name.length : 0) + 
             (meta.description ? meta.description.length : 0) + 
             (meta.personality ? meta.personality.length : 0) + 
             (meta.mes_example ? meta.mes_example.length : 0);
      
      const thumb = base64 ? await genThumb(base64, 400) : null;
      
      // --- 修复：重新引入深层数据提取逻辑 ---
      const dlgs = [];
      if(meta.mes_example) dlgs.push(meta.mes_example);
      if(meta.first_mes) dlgs.push(meta.first_mes);
      if(meta.alternate_greetings && Array.isArray(meta.alternate_greetings)) {
          meta.alternate_greetings.forEach(g => dlgs.push(g));
      }

      let wbEntries = [];
            if(meta.character_book && meta.character_book.entries) {
        const entriesArr = Array.isArray(meta.character_book.entries) ? meta.character_book.entries : Object.values(meta.character_book.entries);
        wbEntries = entriesArr.map(e => ({
          name: (e.comment && e.comment.trim()) || '（无标题）', keys: Array.isArray(e.keys) ? e.keys.join(', ') : (Array.isArray(e.key) ? e.key.join(', ') : (e.keys || e.key || '')),
          content: e.content || '',
          // 完美留存原生世界书的高级开关状态状态
          position: e.position !== undefined ? e.position : 0,
          role: e.role !== undefined ? e.role : 0,
          depth: e.depth !== undefined ? e.depth : 4,
          order: e.order !== undefined ? e.order : (e.insertion_order !== undefined ? e.insertion_order : 100),
          probability: e.probability !== undefined ? e.probability : 100,
          constant: e.constant !== undefined ? e.constant : (e.constant_enabled !== undefined ? e.constant_enabled : false),
          enabled: e.enabled !== undefined ? e.enabled : true,
          selective: e.selective !== undefined ? e.selective : true
        }));
      } else if (meta.world_info && typeof meta.world_info === 'object') {
        wbEntries = Object.values(meta.world_info).map(e => ({
          keys: (e.keys || e.key || []).join?.(', ') || '',
          content: e.content || e.value || ''
        }));
      }

      let pres = [];
      const promptArr = meta.prompts || (meta.prompt_order && meta.prompts);
      if(Array.isArray(promptArr)) {
          promptArr.forEach(p => { if(p && (p.name || p.identifier)) pres.push({name: '▸ ' + (p.name || p.identifier), content: String(p.content || p.text || p.value || p.prompt || p.message || '')}) });
      }
      const rx = meta.regex_scripts || meta.scripts;
      if(Array.isArray(rx)) {
          rx.forEach(s => { if(s && (s.scriptName || s.name)) pres.push({name: '⟢ ' + (s.scriptName || s.name), content: s.replaceString || s.replace || s.findRegex || s.content || ''}) });
      }
      // --- 提取结束 ---

      const card = {
        id: 'c_' + uuid(), hash,
        name: meta.name || file.name,
        description: (meta.description || '') + 
               (meta.personality ? '\n\n【性格】\n' + meta.personality : '') + 
               (meta.scenario ? '\n\n【场景】\n' + meta.scenario : ''),
        note: '', fileType: file.type || ext,
        fileSize: file.size, importedAt: Date.now(), section: targetSec, favorite: false, groupId: '',
        tags: meta.tags || (!meta.name?['无数据']:''), subtags: [], charCount: cCount,
        originalDataUrl: base64, thumb: thumb, mesExample: meta.mes_example || '',
        // 挂载提取的数据数组
        dialogEntries: dlgs,
        worldBookEntries: wbEntries,
        presetEntries: pres
      };

      const dup = S.cards.find(c => c.hash === hash || (c.name === card.name && cCount === c.charCount));
      const hasNameDup = S.cards.find(c => c.name === card.name && c.id !== (dup?dup.id:''));
      
      if (dup) {
        logImp(`重复跳过: ${file.name}`, true); fail++;
      } else if (hasNameDup) {
        // 差异对比 Diff UI
        logImp(`同名差异: ${file.name}`, true);
        const dupEl = document.createElement('div'); dupEl.className = 'dup-item';
        const d1 = renderTokenBadge(hasNameDup.charCount, JSON.stringify(hasNameDup));
        const d2 = renderTokenBadge(card.charCount, JSON.stringify(card));
        dupEl.innerHTML = `
          <div>重名冲突：<b style="color:var(--gold)">${esc(card.name)}</b></div>
          <div class="diff-box">
             <div class="diff-side"><h5>旧档案</h5>Char: ${fmtN(hasNameDup.charCount)}<br>${d1}</div>
             <div class="diff-side"><h5>新导入</h5>Char: <span class="${card.charCount>hasNameDup.charCount?'d-high':''}">${fmtN(card.charCount)}</span><br>${d2}</div>
          </div>
          <div class="dup-acts">
            <button class="dbtn" onclick="acceptDup('${card.id}', this,'add')">保留两者</button>
            <button class="dbtn ow" onclick="acceptDup('${card.id}', this,'replace','${hasNameDup.id}')">覆盖旧卡</button>
          </div>
        `;
        document.getElementById('dupList').appendChild(dupEl);
        window['_tmp_'+card.id] = card; 
        fail++;
      } else {
        await dbP('cards', card); ok++; logImp(`成功: ${file.name}`);
      }
        } catch(err) { fail++; logImp(`报错: ${file.name} - ${err.message}`, true); }
    await new Promise(r => setTimeout(r, 5)); // <-- 新增：释放UI线程，防止假死1分钟
  }

  
  bar.style.width = '100%'; cnt.textContent = '完成'; pendFiles = []; 
  await loadCardsLightweight(); renderAll();
  if(!document.getElementById('dupList').children.length) { setTimeout(()=>closeModal('importModal'), 800); showToast(`导入完毕：成功 ${ok} 失败/重复 ${fail}`); }
}

async function acceptDup(cid, btn, act, oldId) {
  const c = window['_tmp_'+cid]; if(!c) return;
  if(act==='replace') { await dbD('cards', oldId); c.id = oldId; }
  await dbP('cards', c); delete window['_tmp_'+cid];
  btn.parentElement.parentElement.style.opacity = '0.3'; btn.parentElement.parentElement.style.pointerEvents = 'none'; btn.textContent = '已处理';
  loadCardsLightweight().then(()=>renderGrid());
}

function parseTavernJson(str) { 
  try { 
    let parsed = JSON.parse(str); 
    // 核心修复：处理新型酒馆卡片数据包裹在 .data 属性下导致全白的问题
    if (parsed && parsed.data) {
      return { ...parsed, ...parsed.data };
    }
    return parsed;
  } catch(e) { 
  console.warn("JSON解析失败:", e);
  return null; 
}  
}

// 【新增】统一提取卡片元数据的公共印章函数
function getMetaFromBuffer(buffer) {
  let meta = {};
  const charaStr = extractExifMetadata(buffer, 'chara');
  if(charaStr) {
      try {
          const decoded = atob(charaStr); 
          const textData = new TextDecoder('utf-8').decode(Uint8Array.from(decoded, c=>c.charCodeAt(0)));
          meta = parseTavernJson(textData) || {};
      } catch (e) { meta = parseTavernJson(charaStr) || {}; }
  }
  return meta;
}

function extractExifMetadata(buffer, key) {
  const vArr = new DataView(buffer); let pos = 8;
  const targetType = 'tEXt'; // 脱离错误的常量依赖，直接匹配标准头
  
  while(pos < buffer.byteLength - 12) {
    const len = vArr.getUint32(pos); 
    // 强制转换为文本匹配，修复不同浏览器内核的十六进制读取大小端差异
    const typeStr = String.fromCharCode(vArr.getUint8(pos+4), vArr.getUint8(pos+5), vArr.getUint8(pos+6), vArr.getUint8(pos+7));
    
    if(typeStr === targetType) {
      let kwd = ''; let k = pos + 8;
      while(vArr.getUint8(k)!==0 && k < pos+8+len) { kwd += String.fromCharCode(vArr.getUint8(k)); k++; }
      if(kwd.toLowerCase() === key.toLowerCase()) {
        k++; // 跳过分隔符
        const dataBytes = new Uint8Array(buffer, k, pos + 8 + len - k);
        // 使用 TextDecoder 解决读取过长导致系统栈溢出并支持宽字符
        return new TextDecoder('latin1').decode(dataBytes);
      }
    }
    pos += len + 12;
  }
  return null;
}
const readFileBuf = f => new Promise(res => { const fd = new FileReader(); fd.onload = e => res(e.target.result); fd.readAsArrayBuffer(f); });
function bufToBase64(buf, mime) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(new Blob([buf], { type: mime }));
  });
}
const genThumb = (src, w) => new Promise(res => { const img = new Image(); img.onload = () => { const cvs = document.createElement('canvas'); const ctx = cvs.getContext('2d'); const s = w / img.width; cvs.width = w; cvs.height = img.height * s; ctx.drawImage(img, 0, 0, cvs.width, cvs.height); res(cvs.toDataURL('image/jpeg', 0.8)); }; img.onerror = () => res(src); img.src = src; });
function logImp(msg, isErr) { 
  const d = document.getElementById('impLog'); 
  // 优化：限制日志最大条数，防止 DOM 节点过多导致浏览器卡死
  if (d.childElementCount > 100) d.removeChild(d.firstChild);
  const p = document.createElement('div'); 
  p.textContent = msg; 
  if(isErr) p.style.color='var(--red)'; 
  d.appendChild(p); 
  d.scrollTop = d.scrollHeight; 
}

// ============================================================
// 打包导出功能 (JSZip 动态引入)
// ============================================================


async function exportCard(id) {
  const c = await dbG('cards', id); if (!c) return;
  if (!c.originalDataUrl) {
    const b = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
    dlB(b, c.name + '.json'); return;
  }
  const res = await fetch(c.originalDataUrl);
  const blob = await res.blob();
  dlB(blob, c.name + (c.fileType.includes('png') ? '.png' : '.webp'));
}

async function exportFolder(gid) {
  const g = S.groups.find(x => x.id === gid); if (!g) return;
  const list = S.cards.filter(c => c.groupId === gid); if (!list.length) return showToast('文件夹为空');
  showBusy('正在原生打包文件夹', g.name, 0.5);
  try {
    const files = [];
    for (let c of list) {
      const full = await dbG('cards', c.id);
      if (full.originalDataUrl) {
        const ext = full.fileType.includes('webp') ? '.webp' : '.png';
        files.push({ name: `${full.name || '未命名'}${ext}`, data: full.originalDataUrl.split(',')[1] });
      } else {
        files.push({ name: `${full.name || '未命名'}.json`, data: JSON.stringify(full, null, 2) });
      }
    }
    const zipBlob = await buildZip(files);
    dlB(zipBlob, `[归档]${g.name}.zip`);
  } catch(e) { showToast('打包失败', 'error'); }
  hideBusy();
}

let zipWorker;
let zipWorkerResolvers = {};

function initZipWorker() {
  if (zipWorker) return;
  const zipBlob = new Blob([document.getElementById('zipWorkerCode').textContent], { type: 'application/javascript' });
  const zipUrl = URL.createObjectURL(zipBlob);
  zipWorker = new Worker(zipUrl);
  URL.revokeObjectURL(zipUrl);
  zipWorker.onmessage = (e) => {
    if (e.data.type === 'zip_result') {
      const resolve = zipWorkerResolvers[e.data.id];
      if (resolve) { resolve(e.data.blob); delete zipWorkerResolvers[e.data.id]; }
    }
  };
}

// 【新增功能】1. 纯原生无依赖 ZIP 打包引擎 (已升级为 Web Worker 异步版)
const buildZip = async (files) => {
  initZipWorker();
  return new Promise(resolve => {
    const id = Date.now() + '_' + Math.random();
    zipWorkerResolvers[id] = resolve;
    
    // 传递给 Worker 时，标注哪些是 base64 文本需要解码
    const sanitizedFiles = files.map(f => {
        if (typeof f.data === 'string') {
            return { name: f.name, data: f.data, base64: true };
        }
        return f;
    });
    
    zipWorker.postMessage({ type: 'build_zip', id: id, files: sanitizedFiles });
  });
};

// 【新增功能】2. AndroidDL 流式分块备份引擎
const streamDownload = async (filename, contentStr) => {
    if(window.AndroidDL && AndroidDL.beginFile) {
        AndroidDL.beginFile(filename);
        const chunkSize = 1024 * 256; // 每次仅分块写入 256KB，杜绝爆内存
        for(let i=0; i<contentStr.length; i+=chunkSize) {
            AndroidDL.appendChunk(contentStr.substring(i, i+chunkSize));
            await new Promise(r => setTimeout(r, 0)); // 暂停微秒，强制让出主线程给UI渲染
        }
        AndroidDL.finishFile();
        showToast('流式备份完成，已保存到设备', 'success');
    } else {
        // 常规浏览器环境的降级方案
        const blob = new Blob([contentStr], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
};

// 导出系统完整全量包 (已修复)
async function exportAllData() {
  showBusy('正在打包完整备份...', '数据量大时请勿切换后台');
  try {
    const list = await dbA('cards');
    const exData = { version: 4, timestamp: Date.now(), data: list };
    const str = JSON.stringify(exData);
    
    // 抛弃旧的 Blob 下载，启用流式分块写入
    await streamDownload('CardChest_Backup_' + new Date().getTime() + '.json', str);
    
  } catch(e) {
    console.error(e);
    showToast('导出失败', 'error');
  }
  hideBusy();
}

// 导出所有原始文件
async function exportOriginals() {
  const keys = await dbKeys('cards');
  const originals = [];
  for(const k of keys) { 
    const cd = await dbG('cards', k); 
    if(cd && !cd._delAt && cd.originalDataUrl) originals.push(cd); 
  }
  if(!originals.length) return showToast('无原图可导！', 'error');
  if(!confirm(`将打包下载 ${originals.length} 个原始文件，确定？`)) return;
  showBusy('正在原生打包原始文件', '压缩中...', 0.5); 
  try {
    const files = [];
    for (let f of originals) {
      const ext = f.fileType.includes('webp') ? '.webp' : '.png';
      files.push({ name: `${f.name || '未命名'}${ext}`, data: f.originalDataUrl.split(',')[1] });
    }
    const zipBlob = await buildZip(files);
    dlB(zipBlob, "Kaku_Originals.zip");
  } catch(e) { showToast('打包失败', 'error'); }
  hideBusy(); 
}

// 仅导出未推送原文件
async function exportUnpushed() {
  const keys = await dbKeys('cards');
  const unpushed = [];
  for(const k of keys) { 
    const cd = await dbG('cards', k); 
    if(cd && !cd.stPushed && !cd._delAt && cd.originalDataUrl) unpushed.push(cd); 
  }
  if(!unpushed.length) return showToast('所有带图卡片均已推送，或无原图可导！', 'error');
  if(!confirm(`将打包下载 ${unpushed.length} 个未推送的原文件，确定？`)) return;
  showBusy('正在原生打包未推送项', '压缩中...', 0.5); 
  try {
    const files = [];
    for (let f of unpushed) {
      const ext = f.fileType.includes('webp') ? '.webp' : '.png';
      files.push({ name: `${f.name || '未命名'}${ext}`, data: f.originalDataUrl.split(',')[1] });
    }
    const zipBlob = await buildZip(files);
    dlB(zipBlob, "Kaku_Unpushed.zip");
  } catch(e) { showToast('打包失败', 'error'); }
  hideBusy(); 
}

function triggerRestore() {
  const i = document.getElementById('restoreInput'); i.onchange = async e => {
    if(!e.target.files.length) return;
    const file = e.target.files[0];
    if(!confirm('恢复备份将合并数据，确定？')) return;
    showBusy('正在恢复数据', '正在分块读取文件防溢出...', 0.1);
    
    try {
      const dec = new TextDecoder('utf-8');
      const CHUNK = 1 << 20; // 1MB 内存块
      let offset = 0, buf = '', scanPos = 0, headParsed = false;
      let inStr = false, esc = false, depth = 0, objStart = -1;
      let added = 0, seen = 0;
      let total = Math.max(1, Math.round(file.size / 3000));
      
      async function nextChunk() {
        if(offset >= file.size) return null;
        const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
        offset += CHUNK;
        return dec.decode(await slice.arrayBuffer(), {stream: offset < file.size});
      }
      
      async function processBuf() {
        while(scanPos < buf.length) {
          const ch = buf[scanPos];
          if(inStr) { if(esc) esc=false; else if(ch==='\\') esc=true; else if(ch==='"') inStr=false; }
          else {
            if(ch==='"') inStr=true;
            else if(ch==='{') { if(depth===0) objStart=scanPos; depth++; }
            else if(ch==='}') {
              depth--;
              if(depth===0 && objStart>=0) {
                const objStr = buf.slice(objStart, scanPos+1);
                try {
                  const c = JSON.parse(objStr); seen++;
                  if(c && c.id) { const ex = await dbG('cards', c.id); if(!ex) { await dbP('cards', c); added++; } }
                  document.getElementById('busySub').textContent = `正在写入: ${c.name || '未知'}`;
                  document.getElementById('busyBar').style.width = Math.min(100, (seen / total) * 100) + '%';
                } catch(e) {}
                buf = buf.slice(scanPos+1); scanPos=0; objStart=-1;
                // 强制让出主线程，洗掉内存碎片
                await new Promise(r => setTimeout(r, 0));
                continue;
              }
            }
          }
          scanPos++;
        }
      }
      
      while(true) {
        const text = await nextChunk(); if(text === null) break;
        buf += text;
        if(!headParsed) {
          const idx = buf.indexOf('"cards":'); if(idx === -1) continue;
          let headStr = buf.slice(0, idx).replace(/,\s*$/, '');
          try {
            const tmp = JSON.parse(headStr + '}');
            if(tmp.count) total = tmp.count;
            if(tmp.sections) { S.sections = [...new Set([...S.sections, ...tmp.sections])]; await dbP('meta', {key:'sections', value:S.sections}); }
            if(tmp.groups) { const ids = new Set(S.groups.map(g=>g.id)); tmp.groups.forEach(g => { if(!ids.has(g.id)) S.groups.push(g); }); await dbP('meta', {key:'groups', value:S.groups}); }
            if(tmp.subTagLib) { 
               for(const sec of Object.keys(tmp.subTagLib)) {
                  if(!S.subTagLib[sec]) S.subTagLib[sec] = [];
                  S.subTagLib[sec] = [...new Set([...S.subTagLib[sec], ...(tmp.subTagLib[sec] || [])])];
               }
               await dbP('meta', {key:'subTagLib', value:S.subTagLib});
            }
          } catch(e) {}
          buf = buf.slice(buf.indexOf('[', idx) + 1); scanPos = 0; headParsed = true;
        }
        if(headParsed) await processBuf();
      }
      if(headParsed) await processBuf();
      
      showBusy('整理中', '正在重载列表...', 0.9);
      await loadCardsLightweight();
      renderAll();
      closeModal('settingsModal');
      hideBusy();
      showToast(`恢复成功！新增 ${added} 张`);
    } catch(err) { hideBusy(); alert("恢复失败: " + err.message); }
  };
  i.click();
}

async function clearAllData() {
  if(!await confirmDialog('【危险】确认彻底清空所有卡片和设置吗？此操作无法撤销！建议先导出备份。', {danger:true, okText:'确认清空'})) return;
  showBusy('格式化中', '正在创建安全快照...', 0.8);
  await createSnapshot('清空数据前自动备份'); // 自动备份
  await dbC('cards'); await dbC('meta'); await dbC('trash');
  location.reload();
}

// ============================================================
// 批量操作 (选择、移动、修改标签)
// ============================================================
function toggleSelectMode() { S.selectMode = !S.selectMode; S.selectedIds.clear(); document.getElementById('selectModeBtn').classList.toggle('active', S.selectMode); document.getElementById('batchBar').classList.toggle('show', S.selectMode); renderGrid(); }
function exitSelectMode() { S.selectMode = false; S.selectedIds.clear(); document.getElementById('selectModeBtn').classList.remove('active'); document.getElementById('batchBar').classList.remove('show'); renderGrid(); }
function toggleSelect(id, ev) { if(ev) ev.stopPropagation(); if(S.selectedIds.has(id)) S.selectedIds.delete(id); else S.selectedIds.add(id); document.getElementById('bbCnt').textContent = '已选 ' + S.selectedIds.size; const el = document.querySelector(`[data-id="${id}"]`); if(el) el.classList.toggle('selected'); }
function batchSelectAll() {
  const currentViewIds = Array.from(document.getElementById('vsContent').querySelectorAll('.card-item')).map(el => el.dataset.id);
  let newlyAdded = 0;
  S.cards.filter(c => c.section === S.activeSection).forEach(c => { if(!S.selectedIds.has(c.id)) { S.selectedIds.add(c.id); newlyAdded++; } });
  document.getElementById('bbCnt').textContent = '已选 ' + S.selectedIds.size; renderGrid(); showToast('全选此区');
}

function openBatchTag(type) {
  if(!S.selectedIds.size) return showToast('请先选择');
  const isMain = type === 'main';
  const set = new Set();
  S.cards.forEach(c => (isMain ? (c.tags||[]) : (c.subtags||[])).forEach(t => set.add(t)));
  if(!isMain) (S.subTagLib[S.activeSection]||[]).forEach(t => set.add(t));
  
  const quick = [...set].sort().map(t => `<button class="tag-quick" onclick="doBatchTag('${type}','${esc(t)}')">${esc(t)}</button>`).join('');
  
  document.getElementById('pickTitle').textContent = isMain ? '批量加主标签' : '批量加小标签';
  document.getElementById('pickBody').innerHTML = `
    <div style="font-size:11px;color:var(--ink3);margin-bottom:10px">为选中的 ${S.selectedIds.size} 张卡片添加${isMain?'主':'小'}标签：</div>
    <div class="inp-row">
      <input type="text" class="inp" id="batchTagInp" placeholder="输入${isMain?'主':'小'}标签..." onkeydown="if(event.key==='Enter') doBatchTag('${type}', this.value)">
      <button onclick="doBatchTag('${type}', document.getElementById('batchTagInp').value)">添加</button>
    </div>
    ${quick ? `<div style="margin-top:9px;font-size:9px;color:var(--ink3);letter-spacing:.08em;text-transform:uppercase">QUICK ADD 快捷添加</div><div class="tags-edit-row" style="margin-top:5px">${quick}</div>` : ''}`;
  openModal('pickModal');
}

async function doBatchTag(type, val) {
  const tag = (val||'').trim(); if(!tag) return;
  const key = type === 'main' ? 'tags' : 'subtags';
  for(let id of S.selectedIds) { 
    let full = await dbG('cards', id);
    if(full && !(full[key]||[]).includes(tag)) {
       full[key] = [...(full[key]||[]), tag];
       await dbP('cards', full);
    }
  }
  if(type === 'sub') {
    const sec = S.cards.find(x => x.id === [...S.selectedIds][0])?.section || S.activeSection;
    if(!S.subTagLib[sec]) S.subTagLib[sec] = [];
    if(!S.subTagLib[sec].includes(tag)) { S.subTagLib[sec].push(tag); await dbP('meta', {key:'subTagLib', value:S.subTagLib}); }
  }
  closeModal('pickModal'); exitSelectMode();
  await loadCardsLightweight(); renderFilterBar(); renderGrid();
  showToast(`批量添加${type==='main'?'主':'小'}标签成功`);
}

function openBatchGroup() {
  if(!S.selectedIds.size) return showToast('请先选择');
  let h = S.groups.map(g=>`<div class="pick-item" onclick="execBatchGroup('${g.id}')">▣ ${esc(g.name)}</div>`).join('');
  h += `<div class="pick-item" onclick="execBatchGroup('')"><span style="color:var(--red)">⊘ 移除分组</span></div>`;
  document.getElementById('pickTitle').textContent = '设置分组'; document.getElementById('pickBody').innerHTML = h; openModal('pickModal');
}
async function execBatchGroup(gid) {
  for(let id of S.selectedIds) { let f = await dbG('cards', id); f.groupId = gid; await dbP('cards', f); }
  showToast('分组完毕'); closeModal('pickModal'); exitSelectMode(); loadCardsLightweight().then(()=>renderGrid());
}

function openBatchMove() {
  if(!S.selectedIds.size) return showToast('请先选择');
  let h = S.sections.filter(s=>s!==S.activeSection).map(s=>`<div class="pick-item" onclick="execBatchMove('${s}')">→ 转移到【${s}】</div>`).join('');
  document.getElementById('pickTitle').textContent = '转移分区'; document.getElementById('pickBody').innerHTML = h; openModal('pickModal');
}
async function execBatchMove(sec) {
  for(let id of S.selectedIds) { let f = await dbG('cards', id); f.section = sec; await dbP('cards', f); }
  showToast(`已移动 ${S.selectedIds.size} 项`); closeModal('pickModal'); exitSelectMode(); loadCardsLightweight().then(()=>renderTabs()||renderGrid());
}

async function batchFav() {
  if(!S.selectedIds.size) return showToast('请先选择');
  for(let id of S.selectedIds) { let f = await dbG('cards', id); f.favorite = true; await dbP('cards', f); }
  showToast('批量收藏成功'); exitSelectMode(); loadCardsLightweight().then(()=>renderGrid());
}

async function batchExport() {
  const ids = Array.from(S.selectedIds);
  if (ids.length === 0) return;
  showBusy('正在原生引擎打包中...', `共 ${ids.length} 张卡片`);
  try {
    const files = [];
    for (let id of ids) {
      const c = await dbG('cards', id);
      if (!c) continue;
      
      // 智能判断：如果有原图则导出原图，否则导出 JSON
      if (c.originalDataUrl) {
        const ext = c.fileType.includes('webp') ? '.webp' : '.png';
        files.push({ name: `${c.name || '未命名'}${ext}`, data: c.originalDataUrl.split(',')[1] });
      } else {
        files.push({ name: `${c.name || '未命名'}.json`, data: JSON.stringify(c, null, 2) });
      }
    }
    // 无需外调 CDN，直接使用轻浅配色的原生构建组件计算二进制
    const zipBlob = await buildZip(files);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CardChest_Batch_${Date.now()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch(e) {
    console.error(e);
    showToast('打包失败', 'error');
  }
  hideBusy();
  exitSelectModeAndRender();
}


async function batchDelete() {
  if(!S.selectedIds.size) return showToast('请先选择');
  if(!confirm(`确认将 ${S.selectedIds.size} 个项目移入回收站？`)) return;
  for (let id of S.selectedIds) {
    const f = await dbG('cards', id); if(!f) continue;
    f._delAt = Date.now(); await dbP('trash', f); await dbD('cards', id);
  }
  showToast('已删除'); exitSelectMode(); loadCardsLightweight().then(()=>renderGrid());
}

// 单个垃圾桶操作
async function trashCard(id) {
  if(!confirm('确定移至回收站？')) return;
  const f = await dbG('cards', id); f._delAt = Date.now();
  await dbP('trash', f); await dbD('cards', id);
  closeModal('detailModal'); showToast('已删除'); loadCardsLightweight().then(()=>renderGrid());
}

// ============================================================
// 回收站模块 (Trash)
// ============================================================
async function openTrashModal() {
  const ts = await dbA('trash');
  const d = document.getElementById('trashBody');
  if(!ts.length) { d.innerHTML = '<div style="text-align:center;color:var(--ink3);padding:20px 0;font-size:12px">回收站是空的</div>'; openModal('trashModal'); return; }
  
  let html = `<div class="act-row" style="margin-bottom:10px;"><button class="actbtn" onclick="restoreAllTrash()">恢复全部</button><button class="actbtn dan" onclick="emptyTrash()">清空垃圾篓</button></div>`;
  ts.sort((a,b)=>b._delAt - a._delAt).forEach(t => {
     html += `<div class="sec-item"><span>${esc(t.name)}</span> <div style="display:flex;gap:6px;"><button onclick="restoreTrash('${t.id}')" style="font-size:11px;background:var(--p3);border:1px solid var(--bd);padding:2px 6px;border-radius:4px;cursor:pointer;">撤销恢复</button><button onclick="purgeTrash('${t.id}')" style="font-size:11px;background:var(--p3);border:1px solid var(--red);color:var(--red);padding:2px 6px;border-radius:4px;cursor:pointer;">彻底删除</button></div></div>`;
  });
  d.innerHTML = html; openModal('trashModal');
}
async function restoreTrash(id) {
  const f = await dbG('trash', id); if(!f) return;
  delete f._delAt; await dbP('cards', f); await dbD('trash', id);
  openTrashModal(); loadCardsLightweight().then(()=>renderGrid()); showToast('已恢复');
}
async function restoreAllTrash() {
  const ts = await dbA('trash');
  for(let f of ts) { delete f._delAt; await dbP('cards', f); await dbD('trash', f.id); }
  openTrashModal(); loadCardsLightweight().then(()=>renderGrid()); showToast('回收站已恢复');
}
async function purgeTrash(id) {
  if(!await confirmDialog('彻底销毁这张卡片？执行后文件将永远消失！', {danger:true})) return;
  await dbD('trash', id);
  openTrashModal(); showToast('已彻底销毁');
}

async function emptyTrash() {
  if(!await confirmDialog('彻底清空回收站？无法找回！', {danger:true})) return;
  await dbC('trash'); openTrashModal(); showToast('回收站已净化');
}

// ============================================================
// 设置项面板与基础弹窗 (Settings, Context Menu, Lightbox)
// ============================================================
function openSettings() {
  document.getElementById('newGroupInput').value = '';
  document.getElementById('newSectionInput').value = '';
  document.getElementById('newSubTagInput').value = '';
  renderSetLists();
  const lmToggle = document.getElementById('lowMemToggle');
if(lmToggle) lmToggle.checked = !!S.lowMemoryMode;
  openModal('settingsModal');
}
function renderSetLists() {
  document.getElementById('groupList').innerHTML = S.groups.map(g=>`<div class="sec-item"><span>${esc(g.name)}</span><button class="sec-del" onclick="delGroup('${g.id}')">✕</button></div>`).join('');
  document.getElementById('sectionList').innerHTML = S.sections.map((s,i)=>`<div class="sec-item"><input class="sec-order" type="number" value="${i+1}" step="0.5" title="填写数字排序，例如1.5" onchange="reorderSection('${esc(s)}',parseFloat(this.value)||0)" onkeydown="if(event.key==='Enter')this.blur()"><span>${esc(s)}</span>${S.sections.length>1?`<button class="sec-del" onclick="delSection('${s}')">✕</button>`:''}</div>`).join('');
  document.getElementById('subTagLib').innerHTML = (S.subTagLib[S.activeSection]||[]).map(t=>`<div class="sec-item"><span style="color:var(--gold)">${esc(t)}</span><button class="sec-del" onclick="delSubTagLib('${t}')">✕</button></div>`).join('');
    renderMainTagLib(); // 恢复：渲染主标签库
  renderTagParentLib(); // 新增：渲染标签挂载UI
}

function renderTagParentLib() {
  const wrap = document.getElementById('tagParentLib');
  if(!wrap) return;
  // 收集所有分区所有子标签（subtags）
  const allSubs = new Set();
  Object.values(S.subTagLib).forEach(arr=>(arr||[]).forEach(t=>allSubs.add(t)));
  S.cards.forEach(c=>(c.subtags||[]).forEach(t=>allSubs.add(t)));
  // 收集所有分区所有主标签
  const allMains = new Set();
  S.cards.forEach(c=>(c.tags||[]).forEach(t=>allMains.add(t)));
  const mainArr = [...allMains].sort();
  
  if(!allSubs.size){
    wrap.innerHTML='<div style="color:var(--ink3);font-size:12px;padding:4px 0">暂无小标签，请先在小标签库中添加</div>';
    return;
  }
  
  wrap.innerHTML = [...allSubs].sort().map(sub => {
    const cur = S.tagParents[sub] || '';
    const opts = ['<option value="">── 不挂载 ──</option>', ...mainArr.map(m => `<option value="${esc(m)}"${cur===m?' selected':''}>${esc(m)}</option>`)].join('');
    return `<div class="sec-item" style="gap:6px">
      <span style="color:var(--gold);font-size:12px;font-weight:bold;min-width:60px">${esc(sub)}</span>
      <span style="color:var(--ink3);font-size:10px">→ 挂载到 →</span>
      <select class="inp" style="flex:1;font-size:12px;padding:4px 6px" onchange="setTagParent('${esc(sub)}',this.value)">${opts}</select>
    </div>`;
  }).join('');
}

window.setTagParent = async function(child, parent) {
  if(parent) { S.tagParents[child] = parent; } 
  else { delete S.tagParents[child]; }
  await dbP('meta', {key:'tagParents', value:S.tagParents});
  renderFilterBar();
  showToast(parent ? `已设：${child} 属于 ${parent}` : `已取消 ${child} 的挂载`);
};


// 恢复：主标签库管理功能
function ensureMainTagLibCard() {
  let list = document.getElementById('mainTagLib');
  if(list) return list;
  const subWrap = document.getElementById('subTagLib');
  if(!subWrap) return null;
  const subCard = subWrap.closest('.set-card');
  if(!subCard) return null;
  const card = document.createElement('div');
  card.className = 'set-card';
  card.innerHTML = '<h4>Main Tags — 主标签库</h4><div id="mainTagLib"></div><p style="margin-top:5px;font-size:10px;color:var(--ink3)">卡片自带或手动添加的主标签，删除会从所有卡片移除</p>';
  subCard.parentNode.insertBefore(card, subCard);
  return document.getElementById('mainTagLib');
}
function renderMainTagLib() {
  const list = ensureMainTagLibCard(); if(!list) return;
  const sec = S.activeSection;
  const used = new Set(); S.cards.filter(c=>c.section===sec).forEach(c=>(c.tags||[]).forEach(t=>used.add(t)));
  const all = [...used].sort();
  list.innerHTML = !all.length ? '<div style="color:var(--ink3);font-size:12px;padding:4px 0">暂无主标签（当前分区：'+sec+'）</div>' :
  all.map(t=>`<span class="tag-del" onclick="delMainTagLib('${esc(t)}')">${esc(t)} ×</span>`).join('');
}
async function delMainTagLib(tag) {
  const cnt = S.cards.filter(c=>(c.tags||[]).includes(tag)).length;
  if(cnt && !confirm(`主标签「${tag}」被 ${cnt} 张卡片使用，删除将从所有卡片移除，确定？`)) return;
  for(const c of S.cards) {
    if((c.tags||[]).includes(tag)) {
      let full = await dbG('cards', c.id);
      full.tags = full.tags.filter(t=>t!==tag);
      c.tags = full.tags;
      await dbP('cards', full);
    }
  }
  renderMainTagLib(); renderTabs(); renderFilterBar(); renderGrid(); showToast('已删除主标签：'+tag);
}

function addGroup() { const v = document.getElementById('newGroupInput').value.trim(); if(v && !S.groups.find(x=>x.name===v)) { S.groups.push({id:'g_'+Date.now(), name:v}); dbP('meta', {key:'groups', value:S.groups}); renderSetLists(); renderFilterBar(); } }
async function delGroup(id) { if(await confirmDialog('删除此分组？(卡片将变为未分组)', {danger:true})){ S.groups = S.groups.filter(x=>x.id!==id); S.cards.forEach(c=>{if(c.groupId===id) c.groupId='';}); dbP('meta', {key:'groups', value:S.groups}); renderSetLists(); renderFilterBar(); renderGrid(); } }
async function reorderSection(name, order) {
  const orders = S.sections.map((s, i) => ({ s, n: s === name ? order : i + 1 }));
  orders.sort((a, b) => a.n - b.n);
  S.sections = orders.map(x => x.s);
  await dbP('meta', { key: 'sections', value: S.sections });
  renderSetLists(); renderTabs(); showToast('分区已重新排序');
}
function addSection() { const v = document.getElementById('newSectionInput').value.trim(); if(v && !S.sections.includes(v)){ S.sections.push(v); dbP('meta', {key:'sections', value:S.sections}); renderSetLists(); renderTabs(); } }
async function delSection(v) { if(S.sections.length<=1) return showToast("保留至少一区", "error"); if(await confirmDialog(`将连带删除【${v}】区所有卡片，请谨慎验证！`, {danger:true})) { S.sections = S.sections.filter(x=>x!==v); dbP('meta', {key:'sections', value:S.sections}); const toDel = S.cards.filter(c=>c.section===v); toDel.forEach(c=>dbD('cards',c.id)); S.activeSection = S.sections[0]; dbP('meta', {key:'sections', value:S.sections}); renderSetLists(); renderTabs(); loadCardsLightweight().then(()=>renderGrid()); } }
function addSubTagLib() { const v = document.getElementById('newSubTagInput').value.trim(); if(v) { if(!S.subTagLib[S.activeSection]) S.subTagLib[S.activeSection]=[]; if(!S.subTagLib[S.activeSection].includes(v)){ S.subTagLib[S.activeSection].push(v); dbP('meta', {key:'subTagLib', value:S.subTagLib}); renderSetLists(); renderFilterBar(); } } }
async function delSubTagLib(tag) {
  const sec = S.activeSection;
  const used = S.cards.filter(c=>c.section===sec).some(c=>(c.subtags||[]).includes(tag));
  
  if(used && !await confirmDialog('小标签「'+tag+'」正在被卡片使用，删除将同时从所有卡片移除，确定？', {danger:true, okText:'删除'})) return;
  
  // 1. 从库中移除
  if(S.subTagLib[sec]) S.subTagLib[sec] = S.subTagLib[sec].filter(t=>t!==tag);
  await dbP('meta', {key:'subTagLib', value:S.subTagLib});
  
  // 2. 从所有卡片中移除
  if(used){
    for(const c of S.cards){
      if(c.section===sec && (c.subtags||[]).includes(tag)){
        let full = await dbG('cards', c.id);
        if (full) {
          full.subtags = full.subtags.filter(t=>t!==tag);
          c.subtags = full.subtags;
          await dbP('cards', full);
        }
      }
    }
  }
  
  // 3. 同步清理层级挂载关系 (关键优化)
  if(S.tagParents[tag]){
    delete S.tagParents[tag];
    await dbP('meta', {key:'tagParents', value:S.tagParents});
  }
  
  renderSetLists(); renderFilterBar(); renderGrid(); showToast('已删除小标签：'+tag);
}

function openMoveModal(id) { let c = S.cards.find(x=>x.id===id); let h = S.sections.filter(s=>s!==c.section).map(s=>`<div class="dact" onclick="execMove('${id}','${s}')" style="margin-bottom:8px">转移到【${s}】</div>`).join(''); document.getElementById('moveSectionList').innerHTML = h || '无其他分区可用'; openModal('moveModal'); }
function execMove(id, s) { dbG('cards', id).then(f=>{ f.section=s; dbP('cards',f).then(()=>{ closeModal('moveModal'); closeModal('detailModal'); loadCardsLightweight().then(()=>renderTabs()||renderGrid()); }); }); }
function openGrpModal(id) {
  let c = S.cards.find(x=>x.id===id);
  let h = S.groups.map(g=>`<div class="pick-item" onclick="execSingleGrp('${id}','${g.id}')">${c.groupId===g.id?'✅ ':''}▣ ${esc(g.name)}</div>`).join('');
  h += `<div class="pick-item" onclick="execSingleGrp('${id}','')"><span style="color:var(--red)">⊘ 移除分组</span></div>`;
  document.getElementById('grpModalList').innerHTML = h; openModal('grpModal');
}
function execSingleGrp(id, gid) { dbG('cards', id).then(f=>{ f.groupId=gid; dbP('cards',f).then(()=>{ closeModal('grpModal'); openDetail(id); renderGrid(); }); }); }

function openLightbox(id) {
  const c = S.cards.find(x=>x.id===id); if(!c) return;
  dbG('cards', id).then(f => {
    if(f && f.originalDataUrl) {
       const imgEl = document.getElementById('lightboxImg');
       imgEl.src = f.originalDataUrl;
       // 阻止点击图片本身时触发背景的关闭事件
       imgEl.onclick = (e) => e.stopPropagation();
       document.getElementById('lbDlBtn').dataset.name = f.name + '.png';
       document.getElementById('lightboxMask').classList.add('show');
    }
  });
}
function closeLightbox() { 
  document.getElementById('lightboxMask').classList.remove('show'); 
  const img = document.getElementById('lightboxImg');
  // 优化：如果是 blob 临时链接，关闭时释放内存
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = ''; 
}
function downloadLightboxImage(e) {
  e.stopPropagation();
  const lnk = document.createElement('a'); lnk.download = document.getElementById('lbDlBtn').dataset.name; lnk.href = document.getElementById('lightboxImg').src; lnk.click();
}

let ctxActiveId = null;
function showContextMenu(e, id) {
  e.preventDefault(); e.stopPropagation(); ctxActiveId = id;
  const m = document.getElementById('ctxMenu'); m.classList.add('show');
  m.style.left = Math.min(e.clientX, window.innerWidth - 130) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
}
document.addEventListener('click', () => { document.getElementById('ctxMenu').classList.remove('show'); });
document.getElementById('ctxPreview').onclick = () => openLightbox(ctxActiveId);
document.getElementById('ctxEdit').onclick = () => editMeta(ctxActiveId, 'name');
document.getElementById('ctxMove').onclick = () => openMoveModal(ctxActiveId);
document.getElementById('ctxPush').onclick = () => pushCardToTavern(ctxActiveId);
document.getElementById('ctxExport').onclick = () => exportCard(ctxActiveId);
document.getElementById('ctxDelete').onclick = () => trashCard(ctxActiveId);

// ============================================================
// WebDAV 增量云同步逻辑
// ============================================================
let webdavConfig = { url:'', user:'', pass:'', autoSync:false };
async function loadWebdavConfig() {
  const c = await dbG('meta', 'webdavConfig'); if(c) webdavConfig = c.value;
  document.getElementById('wdUrl').value = webdavConfig.url || '';
  document.getElementById('wdUser').value = webdavConfig.user || '';
  document.getElementById('wdPass').value = webdavConfig.pass || '';
  document.getElementById('wdAutoSync').checked = webdavConfig.autoSync || false;
  const l = await dbG('meta', 'webdavSyncTime'); if(l) document.getElementById('lastSyncTime').textContent = '上次同步: ' + new Date(l.value).toLocaleString();
}
function saveWebdavConfig() {
  let tempUrl = document.getElementById('wdUrl').value.trim();
if(tempUrl && !tempUrl.endsWith('/')) tempUrl += '/';
webdavConfig.url = tempUrl;
  webdavConfig.user = document.getElementById('wdUser').value;
  webdavConfig.pass = document.getElementById('wdPass').value;
  dbP('meta', {key: 'webdavConfig', value: webdavConfig}); showToast('云参数保存');
}
async function testWebdav() {
  if (!webdavConfig.url) return showToast('请先填写 WebDAV URL');
  showBusy('测试中', '正在连接 WebDAV...', 0.5);
  try {
    const res = await wdFetch('', { method: 'PROPFIND', headers: { 'Depth': '0' } });
    if (res.ok || res.status === 207) {
      showToast('连接成功！🎉');
    } else {
      showToast('连接失败，状态码: ' + res.status);
    }
  } catch(e) {
    showToast('网络或跨域错误: ' + e.message);
  } finally {
    hideBusy();
  }
}
function toggleAutoSync(val) { webdavConfig.autoSync = val; saveWebdavConfig(); }
async function wdFetch(path, opts={}) {
  const b64 = btoa(webdavConfig.user + ':' + webdavConfig.pass);
  return fetch(webdavConfig.url + path, {
    ...opts, headers: { 'Authorization': 'Basic ' + b64, ...(opts.headers||{}) }
  });
}
async function syncPush() {
  if(!webdavConfig.url) return alert('未配置WebDAV');
  showBusy('推送到云端', '正在读取云端索引...', -1); // 使用转圈动画
  const base = 'KakuSync/';
  try {
    await wdFetch(base, {method:'MKCOL'}).catch(() => {});
    let cloudHashes = {};
    try {
      const idxRes = await wdFetch(base + 'Index.json');
      if(idxRes.ok) {
        const cloudIdx = await idxRes.json();
        if(cloudIdx.inventory_hash) {
          cloudIdx.inventory_hash.split('|').forEach(str => {
            const [id, hash] = str.split(':');
            if(id && hash) cloudHashes[id] = hash;
          });
        }
      }
    } catch(e) {}

    let confirmedMap = {};
    const localInfo = {};
    const toUpload = [];

    document.getElementById('busySub').textContent = '比对本地数据...';
    for (let c of S.cards) {
        const safeName = (c.name || 'card').replace(/[\\/:*?"<>|]/g, '');
        const isImg = c.fileType && (c.fileType.includes('png') || c.fileType.includes('webp'));
        const ext = isImg ? (c.fileType.includes('webp') ? '.webp' : '.png') : '.json';
        const fileName = `${safeName}_${c.id}${ext}`;
        
        localInfo[c.id] = { name: c.name, file: fileName, hash: c.hash, kakuMeta: { section: c.section, groupId: c.groupId, favorite: c.favorite, importedAt: c.importedAt } };
        
        if(cloudHashes[c.id] && cloudHashes[c.id] === c.hash) {
            confirmedMap[c.id] = localInfo[c.id]; // 云端已是最新
        } else {
            toUpload.push(c.id); // 需要上传
        }
    }

    const writeIndex = async () => {
        const inv = Object.keys(confirmedMap).map(id => id + ':' + confirmedMap[id].hash).join('|');
        const metaDump = { sections: S.sections, groups: S.groups, subTagLib: S.subTagLib, tavernProxyUrl: tavernProxy };
        const dumpStr = JSON.stringify({ meta: metaDump, fileMap: confirmedMap, inventory_hash: inv });
        await wdFetch(base+'Index.json', { method:'PUT', body: dumpStr });
    };

    if(!toUpload.length) {
        await writeIndex();
        dbP('meta', {key: 'webdavSyncTime', value: Date.now()});
        hideBusy(); loadWebdavConfig();
        return showToast('云端已是最新，无需同步');
    }

    showBusy('推送到云端', '开始上传...', 0); // 恢复进度条
    let ok = 0;
    for(let i=0; i<toUpload.length; i++) {
        const id = toUpload[i];
        const fInfo = localInfo[id];
        document.getElementById('busySub').textContent = `正在上传 (${i+1}/${toUpload.length}): ${fInfo.name}`;
        document.getElementById('busyBar').style.width = ((i/toUpload.length)*100)+'%';
        
        try {
            const fullCard = await dbG('cards', id);
            if(fullCard.originalDataUrl && fInfo.file.endsWith('.png')) {
                let meta = buildTavernMeta(fullCard);
                const finalBlob = buildUpdatedPngBlob(fullCard.originalDataUrl, meta);
                await wdFetch(base + fInfo.file, { method:'PUT', body: finalBlob });
            } else if (fullCard.originalDataUrl && fInfo.file.endsWith('.webp')) {
                const binary = atob(fullCard.originalDataUrl.split(',')[1]);
                const bytes = new Uint8Array(binary.length);
                for (let j=0; j<binary.length; j++) bytes[j] = binary.charCodeAt(j);
                await wdFetch(base + fInfo.file, { method:'PUT', body: new Blob([bytes], {type: 'image/webp'}) });
            } else {
                await wdFetch(base + fInfo.file, { method:'PUT', body: JSON.stringify(fullCard) });
            }
            
            confirmedMap[id] = fInfo; // 只有成功才记录
            ok++;
            if (ok % 5 === 0) await writeIndex(); // 每5张保存一次断点
        } catch(e) { console.warn('上传失败跳过', id); }
        await new Promise(r => setTimeout(r, 10));
    }

    await writeIndex();
    dbP('meta', {key: 'webdavSyncTime', value: Date.now()});
    loadWebdavConfig();
    hideBusy();
    showToast(`同步完成！成功上传 ${ok} 张` + (ok < toUpload.length ? ' (部分失败，可再次点击续传)' : ''));
  } catch(e) { hideBusy(); alert("同步失败: "+e.message); }
}

// ============================================================
// 重写：WebDAV 可视化按需拉取
// ============================================================
let _wdPullList = []; 

async function syncPull() {
  if(!webdavConfig.url) return alert('未配置WebDAV');
  showBusy('请求云端数据', '正在读取远端云索引...', 0.3);

  try {
    const base = 'KakuSync/';
    const indexRes = await wdFetch(base + 'Index.json', { method: 'GET' });
    if (!indexRes.ok) throw new Error('找不到云端索引文件，您可能还未向云端推送过数据。');
    
    const indexData = await indexRes.json();

    // ===================================
    // 自动恢复非角色卡设置 (Worker地址等)
    // ===================================
    if(indexData.meta && indexData.meta.tavernProxyUrl) {
        tavernProxy = indexData.meta.tavernProxyUrl;
        dbP('meta', {key: 'tavernProxyUrl', value: tavernProxy});
        const tpInp = document.getElementById('tavernProxyUrl');
        if(tpInp) tpInp.value = tavernProxy;
        showToast('已自动恢复 API Worker 代理配置', 'success');
    }

    const cloudHashes = indexData.inventory_hash ? indexData.inventory_hash.split('|') : [];
    const fileMap = indexData.fileMap || {};
    
    _wdPullList = cloudHashes.filter(h => h.includes(':')).map(entry => {
        const [id, hash] = entry.split(':');
        const fInfo = fileMap[id] || { name: '未知卡片', file: id + '.json', kakuMeta: {} };
        // 核心修复：同时比对 ID、内容指纹(Hash)、卡片名称，只要有一个对上，本地就判定为已存在，智能勾选不再抓瞎
        const exist = S.cards.find(c => c.id === id || c.hash === hash || c.name === fInfo.name);
        return { id, hash, name: fInfo.name, file: fInfo.file, kakuMeta: fInfo.kakuMeta, isNew: !exist }; 
    });
	
    if(!_wdPullList.length) throw new Error("云端记录为空");

    const listEl = document.getElementById('wdList');
    listEl.innerHTML = _wdPullList.map((c, idx) => `
        <label style="display:flex; align-items:center; padding:10px; border-bottom:1px solid var(--bd2); cursor:pointer; background:var(--p2); transition:background .2s;">
            <input type="checkbox" class="wd-checkbox" data-idx="${idx}" ${c.isNew ? 'checked' : ''} style="margin-right:12px; width:16px; height:16px; flex-shrink:0;">
            <div style="width:40px; height:40px; border-radius:50%; background:var(--p3); margin-right:12px; overflow:hidden; border:1px solid var(--bd); display:flex; align-items:center; justify-content:center; font-size:18px; color:var(--ink4); flex-shrink:0;">
                📇
            </div>
            <div style="flex:1; min-width:0;">
                <div style="font-size:13px; font-weight:bold; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.name)}</div>
                <div style="font-size:10px; color:var(--ink3); font-family:monospace; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🖼️ ${esc(c.file)}</div>
                <div style="font-size:10px; margin-top:2px; ${c.isNew ? 'color:var(--gold);' : 'color:var(--ink3);'}">${c.isNew ? '✨ 本地缺失 (建议恢复)' : '✓ 本地已存在'}</div>
            </div>
        </label>
    `).join('');

    hideBusy(); openModal('webdavPullModal');

  } catch(e) { hideBusy(); alert("拉取异常：" + e.message); }
}

// ✨ 新增：WebDAV 拉取列表的无感搜索过滤
function filterWebdavPullList(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#wdList label').forEach(lbl => {
        lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}
// ✨ 优化：WebDAV 快捷勾选按钮也只对【当前可见】的项生效
function wdCheckSmart() { document.querySelectorAll('#wdList label').forEach(lbl => { if (lbl.style.display !== 'none') { const cb = lbl.querySelector('.wd-checkbox'); cb.checked = _wdPullList[cb.dataset.idx].isNew; } }); }
function wdCheckAll() { document.querySelectorAll('#wdList label').forEach(lbl => { if (lbl.style.display !== 'none') lbl.querySelector('.wd-checkbox').checked = true; }); }
function wdCheckNone() { document.querySelectorAll('#wdList label').forEach(lbl => { if (lbl.style.display !== 'none') lbl.querySelector('.wd-checkbox').checked = false; }); }

async function executeWebdavPull() {
    const selectedIdxs = Array.from(document.querySelectorAll('.wd-checkbox:checked')).map(cb => parseInt(cb.dataset.idx));
    if(!selectedIdxs.length) return showToast('未勾选任何文件');
    
    closeModal('webdavPullModal'); showBusy('正在恢复数据', '...', 0);
    const base = 'KakuSync/'; let pullOk = 0;
    
    for(let i=0; i<selectedIdxs.length; i++) {
        const target = _wdPullList[selectedIdxs[i]];
        document.getElementById('busySub').textContent = `正在下载 (${i+1}/${selectedIdxs.length}): ${target.file}`;
        document.getElementById('busyBar').style.width = ((i/selectedIdxs.length)*100)+'%';
        
        try {
             const res = await wdFetch(base + target.file, { method: 'GET' });
             if(res.ok) {
                 if(target.file.endsWith('.json')) {
                     // 兼容纯文本老档案
                     const cardData = await res.json();
                     await dbP('cards', cardData);
                     pullOk++;
                 } else {
                     // 核心：处理单体 PNG/WEBP 下载并逆向提取 EXIF 还原为卡库数据
                     const blob = await res.blob();
                     const buffer = await blob.arrayBuffer();

       let meta = getMetaFromBuffer(buffer);


                     const reader = new FileReader();
                     const base64Str = await new Promise(r => { reader.onload = ()=>r(reader.result); reader.readAsDataURL(new Blob([buffer])); });

                     const finalDesc = meta.description || "";
                     const dlgs = [];
                     if(meta.mes_example) dlgs.push(meta.mes_example);
                     if(meta.first_mes) dlgs.push(meta.first_mes);
                     if(meta.alternate_greetings && Array.isArray(meta.alternate_greetings)) meta.alternate_greetings.forEach(g => dlgs.push(g));

                     let wbEntries = [];
                     if(meta.character_book && meta.character_book.entries) {
                         const entriesArr = Array.isArray(meta.character_book.entries) ? meta.character_book.entries : Object.values(meta.character_book.entries);
                         wbEntries = entriesArr.map(e => ({
                           name: (e.comment && e.comment.trim()) || '（无标题）', keys: Array.isArray(e.keys) ? e.keys.join(', ') : (e.keys || ''), content: e.content || '',
                           position: e.position||0, role: e.role||0, depth: e.depth||4, order: e.order||e.insertion_order||100,
                           probability: e.probability||100, constant: e.constant||false, enabled: e.enabled!==false
                         }));
                     }
                     let pres = [];
                     if(Array.isArray(meta.prompts)) meta.prompts.forEach(p => { if(p.name) pres.push({name: '▸ '+p.name, content: String(p.content||'')}) });
                     if(Array.isArray(meta.regex_scripts)) meta.regex_scripts.forEach(s => { if(s.scriptName) pres.push({name: '⟢ '+s.scriptName, content: String(s.replaceString||'')}) });

                     // 结合卡库专属的元数据（如分组/收藏）
                     const km = target.kakuMeta || {};
                     const newCard = {
                         id: target.id, hash: target.hash,
                         name: meta.name || target.name, description: finalDesc,
                         personality: meta.personality || "", first_mes: meta.first_mes || "",
                         mesExample: meta.mes_example || "", note: meta.creator_notes || "",
                         originalDataUrl: base64Str, thumb: await genThumb(base64Str, 400),
                         fileType: target.file.endsWith('.webp') ? 'image/webp' : 'image/png', fileSize: blob.size,
                         importedAt: km.importedAt || Date.now(), section: km.section || S.sections[0],
                         favorite: km.favorite || false, groupId: km.groupId || '',
                         tags: meta.tags || [], charCount: finalDesc.length,
                         dialogEntries: dlgs, worldBookEntries: wbEntries, presetEntries: pres
                     };
                     await dbP('cards', newCard);
                     pullOk++;
                 }
             }
        } catch(ex) { console.warn("下载失败", target.id); }
    }
    
    hideBusy(); await loadCardsLightweight(); renderAll();
    showToast(`恢复完毕！成功下载 ${pullOk} 张角色卡。`);
}

function autoSyncCheck() {
  if(!webdavConfig.autoSync) return;
  // 静默检查本地变动，对比云端Index文件里的哈希值...略
}