// ═══════════════════════════════════════════════════════════════
// PageDotCom — Editor Core  v3
// ═══════════════════════════════════════════════════════════════
'use strict';

// ── Tauri bridge ──────────────────────────────────────────────
const Tauri = {
  invoke(cmd,args){ return window.__TAURI__.core.invoke(cmd,args); },
  async save(defaultName,content,ext){
    const path=await window.__TAURI__.dialog.save({defaultPath:defaultName,filters:[{name:ext.toUpperCase(),extensions:[ext]}]});
    if(!path)throw new Error('Cancelled');
    await Tauri.invoke('write_file',{path,content}); return path;
  },
  async openText(ext){
    const path=await window.__TAURI__.dialog.open({filters:[{name:ext.toUpperCase(),extensions:ext.split(',').map(e=>e.trim())}],multiple:false});
    if(!path)throw new Error('Cancelled');
    return Tauri.invoke('read_file',{path});
  },
  async openImage(){
    const path=await window.__TAURI__.dialog.open({filters:[{name:'Images',extensions:['png','jpg','jpeg','gif','webp','svg']}],multiple:false});
    if(!path)throw new Error('Cancelled');
    return Tauri.invoke('read_file_b64',{path});
  },
};

// ── Warn modal (replaces browser confirm) ─────────────────────
const WarnModal={
  _resolve:null,
  show(msg){
    return new Promise(resolve=>{
      this._resolve=resolve;
      const skip=localStorage.getItem('pdc_skip_open_warn')==='1';
      if(skip){resolve(true);return;}
      document.getElementById('warn-msg').textContent=msg;
      document.getElementById('warn-dont-ask').checked=false;
      document.getElementById('warn-overlay').classList.remove('hidden');
    });
  },
  confirm(){
    if(document.getElementById('warn-dont-ask').checked)
      localStorage.setItem('pdc_skip_open_warn','1');
    document.getElementById('warn-overlay').classList.add('hidden');
    this._resolve&&this._resolve(true);
  },
  cancel(){
    document.getElementById('warn-overlay').classList.add('hidden');
    this._resolve&&this._resolve(false);
  },
};

// ── State ─────────────────────────────────────────────────────
const State={
  project:{name:'Untitled Project',pages:[],currentPageId:null},
  selectedTool:null,selectedElId:null,nextId:1,dirty:false,advancedOpen:false,
  get currentPage(){return this.project.pages.find(p=>p.id===this.project.currentPageId)||null;},
  get elements(){return this.currentPage?this.currentPage.elements:[];},
  getEl(id){for(const p of this.project.pages)for(const e of p.elements)if(e.id===id)return e;return null;},
  newId(){return 'el-'+(this.nextId++);},
};

// ── History (Undo / Redo) ────────────────────────────────────
const History={
  _undo:{},   // per-page undo stacks: {pageId: [...snapshots]}
  _redo:{},   // per-page redo stacks (cleared on new save)
  MAX:50,
  save(){
    const pg=State.currentPage;if(!pg)return;
    if(!this._undo[pg.id])this._undo[pg.id]=[];
    const snap=JSON.stringify(pg);
    const s=this._undo[pg.id];
    if(s.length&&s[s.length-1]===snap)return;// no change
    s.push(snap);
    if(s.length>this.MAX)s.shift();
    // Any new action clears the redo stack for this page
    this._redo[pg.id]=[];
    this._refreshBtns();
  },
  undo(){
    const pg=State.currentPage;if(!pg)return;
    const su=this._undo[pg.id];
    if(!su||!su.length)return;
    // Push current state onto redo before reverting
    if(!this._redo[pg.id])this._redo[pg.id]=[];
    this._redo[pg.id].push(JSON.stringify(pg));
    const snap=JSON.parse(su.pop());
    this._apply(snap);
  },
  redo(){
    const pg=State.currentPage;if(!pg)return;
    const sr=this._redo[pg.id];
    if(!sr||!sr.length)return;
    // Push current state onto undo before re-applying
    if(!this._undo[pg.id])this._undo[pg.id]=[];
    this._undo[pg.id].push(JSON.stringify(pg));
    const snap=JSON.parse(sr.pop());
    this._apply(snap);
  },
  _apply(snap){
    const idx=State.project.pages.findIndex(p=>p.id===snap.id);
    if(idx===-1)return;
    State.project.pages[idx]=snap;
    State.project.currentPageId=snap.id;
    if(State.selectedElId&&!snap.elements.find(e=>e.id===State.selectedElId)){
      State.selectedElId=null;Props.renderNone();
    }
    Canvas.renderAll();App.syncBgUI();App.syncCursorUI();
    State.dirty=true;this._refreshBtns();
  },
  clear(){this._undo={};this._redo={};this._refreshBtns();},
  _refreshBtns(){
    const pg=State.currentPage;
    const btnU=document.getElementById('undo-btn');
    const btnR=document.getElementById('redo-btn');
    const hasU=!!(pg&&this._undo[pg.id]&&this._undo[pg.id].length);
    const hasR=!!(pg&&this._redo[pg.id]&&this._redo[pg.id].length);
    if(btnU){btnU.disabled=!hasU;btnU.style.opacity=hasU?'1':'.45';}
    if(btnR){btnR.disabled=!hasR;btnR.style.opacity=hasR?'1':'.45';}
  },
  // Legacy alias kept for any callers that use _refreshBtn
  _refreshBtn(){this._refreshBtns();},
};

// ── Clipboard (Copy/Paste) ────────────────────────────────────
const Clipboard={
  _data:null,
  copy(){
    const el=State.getEl(State.selectedElId);if(!el)return;
    this._data=JSON.parse(JSON.stringify(el));
  },
  paste(){
    if(!this._data)return;
    History.save();
    const clone=JSON.parse(JSON.stringify(this._data));
    clone.id=State.newId();clone.x+=24;clone.y+=24;
    State.elements.push(clone);Canvas.renderEl(clone);Canvas.select(clone.id);
    Canvas.updateHeight();State.dirty=true;
  },
};

// ── BgLayers — per-page layered background with split-line dividers ──
const BgLayers={
  _sel:0,
  _stopFns:[],   // cancelable dynamic-bg stop functions (keyed to editor canvas)
  getLayers(pg){
    if(!pg.bgLayers){pg.bgLayers=[Object.assign({},pg.background||{type:'solid',color:'#0d1117'})];pg.bgDividers=[];}
    if(!pg.bgDividers)pg.bgDividers=[];
    return pg.bgLayers;
  },
  getDividers(pg){if(!pg.bgDividers)pg.bgDividers=[];return pg.bgDividers;},
  sortedDividers(pg){return this.getDividers(pg).slice().sort((a,b)=>((a.yLeft+a.yRight)/2)-((b.yLeft+b.yRight)/2));},
  addLayer(){
    const pg=State.currentPage;if(!pg)return;History.save();
    const layers=this.getLayers(pg);
    layers.push({type:'solid',color:'#1a1a2e'});
    this.getDividers(pg).push({yLeft:50,yRight:50});
    this._sel=layers.length-1;this._refresh(pg);State.dirty=true;
  },
  removeLayer(i){
    const pg=State.currentPage;if(!pg)return;
    const layers=this.getLayers(pg);if(layers.length<=1)return;
    History.save();layers.splice(i,1);
    const divs=this.getDividers(pg);if(divs.length>0)divs.splice(Math.max(0,i-1),1);
    this._sel=Math.min(this._sel,layers.length-1);this._refresh(pg);State.dirty=true;
  },
  addDivider(){
    const pg=State.currentPage;if(!pg)return;
    const layers=this.getLayers(pg);if(layers.length<2)return;
    History.save();
    this.getDividers(pg).push({yLeft:50,yRight:50});
    layers.push({type:'solid',color:'#0d3a8f'});
    this.ensureLayerCount(pg);// add extra layer if intersection created
    this._sel=layers.length-1;this._refresh(pg);State.dirty=true;
  },
  removeDivider(i){
    const pg=State.currentPage;if(!pg)return;History.save();
    const sorted=this.sortedDividers(pg);
    const divs=this.getDividers(pg);
    const origIdx=divs.indexOf(sorted[i]);
    if(origIdx>=0)divs.splice(origIdx,1);
    const layers=this.getLayers(pg);if(layers.length>1)layers.splice(i+1,1);
    this._sel=Math.min(this._sel,layers.length-1);this._refresh(pg);State.dirty=true;
  },
  selectLayer(i){
    this._sel=i;const pg=State.currentPage;if(!pg)return;
    this.renderList(pg);this.renderOpts(pg);
  },
  setLayerProp(key,val){
    const pg=State.currentPage;if(!pg)return;
    const layer=this.getLayers(pg)[this._sel];if(!layer)return;
    layer[key]=val;this.applyToCanvas(pg);State.dirty=true;
  },
  setLayerType(val){
    this.setLayerProp('type',val);
    const pg=State.currentPage;if(!pg)return;this.renderOpts(pg);
  },
  async chooseLayerImage(){
    const pg=State.currentPage;if(!pg)return;
    try{
      const d=await Tauri.openImage();
      const layer=this.getLayers(pg)[this._sel];if(!layer)return;
      layer.image=d;layer.type='image';
      this.renderOpts(pg);this.applyToCanvas(pg);State.dirty=true;
    }catch(err){if(!String(err).includes('Cancelled'))alert('Could not load image: '+err);}
  },
  _refresh(pg){
    this.renderList(pg);this.renderOpts(pg);this.applyToCanvas(pg);
  },
  syncUI(){
    const pg=State.currentPage;if(!pg)return;
    this.getLayers(pg);this._sel=0;this._refresh(pg);
  },
  renderList(pg){
    const layers=this.getLayers(pg);
    const divs=this.sortedDividers(pg);
    const intersect=this.findIntersectingPair(divs);
    const list=document.getElementById('bg-layers-list');if(!list)return;
    const icons={solid:'■',gradient:'▓',split:'◫',image:'🖼',dynamic:'⚡'};
    const zoneNames=intersect&&layers.length===4
      ?['Zone TOP','Zone LEFT','Zone RIGHT','Zone BOTTOM']
      :layers.map((_,i)=>`Zone ${i+1}`);
    const intersectBadge=intersect?`<div style="margin-bottom:6px;padding:4px 8px;background:rgba(31,111,235,.12);border:1px solid rgba(31,111,235,.35);border-radius:4px;font-size:10px;color:#58a6ff;">⊗ Lines intersect — 4 zones active</div>`:'';
    const layersHtml=layers.map((l,i)=>
      `<div onclick="BgLayers.selectLayer(${i})" style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:4px;cursor:pointer;margin-bottom:3px;background:${i===this._sel?'rgba(31,111,235,.18)':'rgba(255,255,255,.04)'};border:1px solid ${i===this._sel?'rgba(31,111,235,.5)':'transparent'};">
        <span style="font-size:11px;opacity:.7;">${icons[l.type||'solid']||'■'}</span>
        <span style="flex:1;font-size:11px;color:var(--text);">${zoneNames[i]||('Zone '+(i+1))} — ${l.type||'solid'}</span>
        ${layers.length>1?`<button class="prop-btn" onclick="BgLayers.removeLayer(${i});event.stopPropagation();" style="padding:1px 5px;font-size:9px;background:rgba(218,54,51,.15);color:#da3633;">✕</button>`:''}
      </div>`
    ).join('');

    // ── Divider line type controls ────────────────────────────
    let dividersHtml='';
    if(divs.length>0){
      const tb=(di,type,label,active)=>
        `<button onclick="BgLayers.setDividerType(${di},'${type}');event.stopPropagation();"
          style="flex:1;padding:3px 2px;font-size:10px;border-radius:3px;border:1px solid ${active?'#1f6feb':'rgba(255,255,255,.15)'};background:${active?'rgba(31,111,235,.2)':'rgba(255,255,255,.04)'};color:${active?'#58a6ff':'var(--muted)'};cursor:pointer;">${label}</button>`;
      dividersHtml=`<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
        <div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin-bottom:5px;text-transform:uppercase;">Divider Lines</div>`+
        divs.map((div,di)=>{
          const cur=this._dividerTypeOf(div);
          const midY=((div.yLeft+div.yRight)/2).toFixed(0);
          const isCentered=Math.abs((div.yLeft+div.yRight)/2-50)<1.5;
          return `<div style="margin-bottom:5px;padding:5px 7px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:4px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:10px;color:var(--text);">Line ${di+1} <span style="color:var(--muted);font-size:9px;">@ ${midY}%</span></span>
              <button onclick="BgLayers.centerDivider(${di});event.stopPropagation();"
                title="Move to vertical centre (50%)"
                style="font-size:9px;padding:1px 5px;border-radius:3px;border:1px solid ${isCentered?'#2ea043':'rgba(255,255,255,.15)'};background:${isCentered?'rgba(46,160,67,.15)':'rgba(255,255,255,.04)'};color:${isCentered?'#3fb950':'var(--muted)'};cursor:pointer;">⊙ Centre</button>
            </div>
            <div style="display:flex;gap:3px;">
              ${tb(di,'horizontal','─ Horizontal',cur==='horizontal')}
              ${tb(di,'oblique','╱ Oblique',cur==='oblique')}
              ${tb(di,'curved','⌒ Curved',cur==='curved')}
            </div>
          </div>`;
        }).join('')+
      `</div>`;
    }

    // Show/hide "Add Split Line" button
    const addLineBtn=document.getElementById('bg-add-line-btn');
    if(addLineBtn) addLineBtn.style.display=layers.length>=2?'':'none';

    // ── Scroll behaviour toggle ──
    const scrollMode=pg.bgScrollMode||'fixed';
    const scrollHtml=`<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
      <div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;text-transform:uppercase;">Background Scroll</div>
      <div class="link-mode-row">
        <button class="link-mode-btn${scrollMode==='fixed'?' active':''}" onclick="BgLayers.setScrollMode('fixed')" title="Background stays fixed while page content scrolls">⊠ Fixed (Artistic)</button>
        <button class="link-mode-btn${scrollMode==='scroll'?' active':''}" onclick="BgLayers.setScrollMode('scroll')" title="Background scrolls with content — good for distinct sections">↕ Scrolls with Page</button>
      </div>
      <p style="font-size:9px;color:var(--muted);margin:4px 0 0;">${scrollMode==='fixed'?'Content scrolls over a fixed background. Best for animations & split effects.':'Background moves with the page. Best for colour-blocked sections.'}</p>
    </div>`;
    list.innerHTML=intersectBadge+layersHtml+dividersHtml+scrollHtml;
  },
  setScrollMode(mode){
    const pg=State.currentPage;if(!pg)return;
    pg.bgScrollMode=mode;
    this.renderList(pg);
    State.dirty=true;
  },
  renderOpts(pg){
    const layer=this.getLayers(pg)[this._sel];
    const opts=document.getElementById('bg-layer-opts');if(!opts||!layer)return;
    const t=layer.type||'solid';
    const typeOpts=['solid','gradient','image','dynamic'].map(v=>
      `<option value="${v}"${v===t?' selected':''}>${{solid:'Solid Color',gradient:'Gradient',image:'Image / Photo',dynamic:'Dynamic Effect'}[v]}</option>`
    ).join('');
    let body=`<div class="prop-group"><label class="prop-label">Zone ${this._sel+1} type</label>
      <select class="prop-select" onchange="BgLayers.setLayerType(this.value)">${typeOpts}</select></div>`;
    if(t==='solid'){
      const c=(layer.color||'#0d1117').startsWith('#')?layer.color:'#0d1117';
      body+=`<div class="prop-group prop-color-row"><label class="prop-label">Color</label><input type="color" value="${c}" oninput="BgLayers.setLayerProp('color',this.value)"/></div>`;
    }else if(t==='gradient'){
      const ca=(layer.colorA||'#0d1117').startsWith('#')?layer.colorA:'#0d1117';
      const cb=(layer.colorB||'#1f6feb').startsWith('#')?layer.colorB:'#1f6feb';
      const dir=layer.dir||'to right';
      body+=`<div class="prop-group"><label class="prop-label">Gradient</label>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
          <input type="color" value="${ca}" oninput="BgLayers.setLayerProp('colorA',this.value)"/>
          <span style="font-size:10px;color:var(--muted);">→</span>
          <input type="color" value="${cb}" oninput="BgLayers.setLayerProp('colorB',this.value)"/>
        </div>
        <select class="prop-select" onchange="BgLayers.setLayerProp('dir',this.value)">
          <option value="to right"${dir==='to right'?' selected':''}>→ Left to Right</option>
          <option value="to bottom"${dir==='to bottom'?' selected':''}>↓ Top to Bottom</option>
          <option value="135deg"${dir==='135deg'?' selected':''}>↘ Diagonal</option>
          <option value="radial"${dir==='radial'?' selected':''}>◎ Radial</option>
        </select></div>`;
    }else if(t==='image'){
      const ix=layer.imageX!=null?layer.imageX:50;
      const iy=layer.imageY!=null?layer.imageY:50;
      const sz=layer.imageSize||'cover';
      body+=`<div class="prop-group"><label class="prop-label">Image</label>
        <button class="prop-btn" onclick="BgLayers.chooseLayerImage()" style="width:100%;margin-bottom:4px;">🖼 ${layer.image?'Change Photo':'Choose Photo'}</button>
        ${layer.image?`<button class="prop-btn" onclick="BgLayers.setLayerProp('image','');BgLayers.renderOpts(State.currentPage);" style="background:rgba(218,54,51,.15);color:#da3633;width:100%;margin-bottom:6px;">✕ Remove</button>`:''}
        <select class="prop-select" style="margin-bottom:8px;" onchange="BgLayers.setLayerProp('imageSize',this.value)">
          <option value="cover"${sz==='cover'?' selected':''}>Cover (fill)</option>
          <option value="contain"${sz==='contain'?' selected':''}>Contain</option>
          <option value="100% 100%"${sz==='100% 100%'?' selected':''}>Stretch</option>
          <option value="auto"${sz==='auto'?' selected':''}>Original size</option>
        </select>
        <label class="prop-label" style="margin-bottom:2px;">Position X — <span id="blix-${this._sel}">${ix}%</span></label>
        <input type="range" min="0" max="100" value="${ix}" style="width:100%;margin-bottom:6px;"
          oninput="BgLayers.setLayerProp('imageX',parseInt(this.value));document.getElementById('blix-${this._sel}').textContent=this.value+'%'"/>
        <label class="prop-label" style="margin-bottom:2px;">Position Y — <span id="bliy-${this._sel}">${iy}%</span></label>
        <input type="range" min="0" max="100" value="${iy}" style="width:100%;margin-bottom:6px;"
          oninput="BgLayers.setLayerProp('imageY',parseInt(this.value));document.getElementById('bliy-${this._sel}').textContent=this.value+'%'"/>
        <button class="prop-btn" onclick="BgLayers.setLayerProp('imageX',50);BgLayers.setLayerProp('imageY',50);BgLayers.renderOpts(State.currentPage);" style="width:100%;">⊙ Auto-center</button>
        <label class="prop-label" style="margin-top:6px;margin-bottom:2px;">Zoom — <span id="bliz-${this._sel}">${(layer.imageZoom||1).toFixed(2)}×</span></label>
        <input type="range" min="1" max="4" step="0.01" value="${layer.imageZoom||1}" style="width:100%;margin-bottom:4px;"
          oninput="BgLayers.setLayerProp('imageZoom',parseFloat(this.value));document.getElementById('bliz-${this._sel}').textContent=parseFloat(this.value).toFixed(2)+'×'"/>
      </div>`;
    }else if(t==='dynamic'){
      const ei=layer.effectIndex||0;
      const ca=(layer.colorA||'#00ff41').startsWith('#')?layer.colorA:'#00ff41';
      const cb=(layer.colorB||'#00c8ff').startsWith('#')?layer.colorB:'#00c8ff';
      const cc=(layer.colorC||'#4080ff').startsWith('#')?layer.colorC:'#4080ff';
      const efNames=['Particle Network','Starfield Warp','Flowing Topology','Falling Geometry','Oscilloscope Waves','Neural Network','Metaballs','DNA Helix','Perlin Flow Field','Grid Pulse','Circuit Board','Aurora Borealis'];
      const efOpts=efNames.map((e,j)=>`<option value="${j}"${j===ei?' selected':''}>${e}</option>`).join('');
      body+=`<div class="prop-group"><label class="prop-label">Effect</label>
        <select class="prop-select" onchange="BgLayers.setLayerProp('effectIndex',parseInt(this.value));BgLayers.applyToCanvas(State.currentPage)">${efOpts}</select>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <input type="color" value="${ca}" oninput="BgLayers.setLayerProp('colorA',this.value)"/>
          <input type="color" value="${cb}" oninput="BgLayers.setLayerProp('colorB',this.value)"/>
          <input type="color" value="${cc}" oninput="BgLayers.setLayerProp('colorC',this.value)"/>
        </div></div>`;
    }
    body+=`<p class="props-hint" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;font-size:9px;"><strong style="color:#1f6feb;">● Blue handles</strong> (left/right edges) — drag up/down to move or incline the separator. <strong style="color:#2ea043;">● Green handle</strong> (centre) — drag to curve the separator. Click <strong style="color:#da3633;">✕</strong> to delete a separator.</p>`;
    opts.innerHTML=body;
  },
  // Returns intersection point {x,y} in percent, or null if parallel/outside canvas
  computeIntersection(d0,d1){
    const denom=(d0.yRight-d0.yLeft)-(d1.yRight-d1.yLeft);
    if(Math.abs(denom)<0.001)return null;// parallel
    const x=100*(d1.yLeft-d0.yLeft)/denom;
    if(x<=0.5||x>=99.5)return null;// outside canvas edges
    const y=d0.yLeft+(d0.yRight-d0.yLeft)*x/100;
    if(y<0||y>100)return null;
    return{x,y};
  },
  // Returns {pair:[d0,d1], P:{x,y}} for the first intersecting pair, or null
  findIntersectingPair(divs){
    for(let i=0;i<divs.length;i++)
      for(let j=i+1;j<divs.length;j++){
        const P=this.computeIntersection(divs[i],divs[j]);
        if(P)return{pair:[divs[i],divs[j]],P};
      }
    return null;
  },
  // 4-zone clip for intersecting dividers: TOP=0, LEFT=1, RIGHT=2, BOTTOM=3
  layerClipIntersect(i,d0,d1,P){
    const upper=d0.yLeft<=d1.yLeft?d0:d1;
    const lower=d0.yLeft<=d1.yLeft?d1:d0;
    const yUL=upper.yLeft.toFixed(2),yUR=upper.yRight.toFixed(2);
    const yLL=lower.yLeft.toFixed(2),yLR=lower.yRight.toFixed(2);
    const Px=P.x.toFixed(2),Py=P.y.toFixed(2);
    switch(i){
      case 0:return`polygon(0% 0%,100% 0%,100% ${yLR}%,${Px}% ${Py}%,0% ${yUL}%)`;// TOP
      case 1:return`polygon(0% ${yUL}%,${Px}% ${Py}%,0% ${yLL}%)`;// LEFT
      case 2:return`polygon(${Px}% ${Py}%,100% ${yLR}%,100% ${yUR}%)`;// RIGHT
      case 3:return`polygon(0% ${yLL}%,${Px}% ${Py}%,100% ${yUR}%,100% 100%,0% 100%)`;// BOTTOM
      default:return null;
    }
  },
  // Ensure layers count matches geometry: N+1 normally, N+2 when 2 dividers intersect
  ensureLayerCount(pg){
    const layers=this.getLayers(pg);
    const divs=this.sortedDividers(pg);
    const intersect=this.findIntersectingPair(divs);
    const needed=divs.length+(intersect?2:1);
    while(layers.length<needed)layers.push({type:'solid',color:['#1a1a2e','#0d3a8f','#2d1b69','#16213e'][layers.length%4]});
    // Don't shrink — user may have configured the extra layers
  },
  // Sample a quadratic bezier through yLeft→ctrl→yRight as N+1 polygon points (left→right)
  _bezierPts(d,N){
    N=N||20;
    const mid=(d.yLeft+d.yRight)/2;
    const ctrl=mid+(d.curve||0);
    const pts=[];
    for(let k=0;k<=N;k++){
      const t=k/N;
      const x=100*t;
      const y=(1-t)*(1-t)*d.yLeft+2*(1-t)*t*ctrl+t*t*d.yRight;
      pts.push(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
    }
    return pts;
  },
  layerClip(i,n,sortedDivs){
    if(n===1||!sortedDivs.length)return null;
    // Intersection case: 2 dividers crossing → 4 zones (straight lines only)
    if(sortedDivs.length===2&&n===4){
      const P=this.computeIntersection(sortedDivs[0],sortedDivs[1]);
      if(P)return this.layerClipIntersect(i,sortedDivs[0],sortedDivs[1],P);
    }
    const d=sortedDivs;
    // Top zone: top edge + curve of d[0] reversed (right→left)
    if(i===0){
      const pts=this._bezierPts(d[0]).reverse();
      return `polygon(0% 0%,100% 0%,${pts.join(',')})`;
    }
    // Bottom zone: curve of d[n-2] (left→right) + bottom corners
    if(i===n-1){
      const pts=this._bezierPts(d[n-2]);
      return `polygon(${pts.join(',')},100% 100%,0% 100%)`;
    }
    // Middle zone: curve of d[i-1] (left→right), then curve of d[i] reversed (right→left)
    const topPts=this._bezierPts(d[i-1]);
    const botPts=this._bezierPts(d[i]).reverse();
    return `polygon(${topPts.join(',')},${botPts.join(',')})`;
  },
  layerBgCSS(layer){
    const t=layer.type||'solid';
    if(t==='solid')  return `background:${layer.color||'#0d1117'};`;
    if(t==='gradient'){
      if(layer.dir==='radial')return `background:radial-gradient(circle at center,${layer.colorA||'#0d1117'},${layer.colorB||'#1f6feb'});`;
      return `background:linear-gradient(${layer.dir||'to right'},${layer.colorA||'#0d1117'},${layer.colorB||'#1f6feb'});`;
    }
    if(t==='split'){const a=layer.splitAngle||135;return `background:linear-gradient(${a}deg,${layer.colorA||'#0d1117'} 50%,${layer.colorB||'#1f6feb'} 50%);`;}
    if(t==='image'&&layer.image){
      const ix=layer.imageX!=null?layer.imageX:50;
      const iy=layer.imageY!=null?layer.imageY:50;
      const zoom=layer.imageZoom||1;
      const size=zoom>1?`${zoom*100}%`:(layer.imageSize||'cover');
      return `background:url('${layer.image}') ${ix}% ${iy}%/${size} no-repeat;`;
    }
    return 'background:#0d1117;';
  },
  applyToCanvas(pg){
    if(!pg)pg=State.currentPage;if(!pg)return;
    this.ensureLayerCount(pg);// sync layer count before rendering
    const layers=this.getLayers(pg);
    const divs=this.sortedDividers(pg);
    const n=layers.length;
    const bgC=document.getElementById('bg-layers-canvas');if(!bgC)return;
    // Stop any running dynamic animations before clearing
    this._stopFns.forEach(fn=>{try{fn();}catch(e){}});
    this._stopFns=[];
    bgC.innerHTML='';
    layers.forEach((layer,i)=>{
      const clip=this.layerClip(i,n,divs);
      const clipStyle=clip?`clip-path:${clip};`:'';
      if(layer.type==='dynamic'){
        // Use a real <canvas> element with generateCancelable — avoids the
        // iframe re-initialisation race that made the editor always show effect #0.
        const cvs=document.createElement('canvas');
        cvs.style.cssText=`position:absolute;inset:0;width:100%;height:100%;z-index:${i};${clipStyle}pointer-events:none;`;
        bgC.appendChild(cvs);
        try{
          const fnStr=BgEffects.generateCancelable(
            layer.effectIndex||0,
            layer.colorA||'#00ff41',layer.colorB||'#00c8ff',layer.colorC||'#4080ff'
          );
          // eslint-disable-next-line no-new-func
          const stopFn=(new Function('return '+fnStr)())(cvs);
          if(typeof stopFn==='function')this._stopFns.push(stopFn);
        }catch(err){console.error('Dynamic bg error:',err);}
      }else{
        const div=document.createElement('div');
        div.style.cssText=`position:absolute;inset:0;z-index:${i};${this.layerBgCSS(layer)}${clipStyle}`;
        bgC.appendChild(div);
      }
    });
    requestAnimationFrame(()=>this.renderDividerSVG(pg));
  },
  renderDividerSVG(pg){
    if(!pg)pg=State.currentPage;
    const divs=this.sortedDividers(pg);
    const svgEl=document.getElementById('bg-dividers-svg');if(!svgEl)return;
    // bg-divider-handles sits at z-index:10 above the elements layer so handles receive events
    const hSvg=document.getElementById('bg-divider-handles');
    const ec=document.getElementById('editor-canvas');
    const W=ec.offsetWidth||1200;const H=ec.offsetHeight||800;
    svgEl.innerHTML='';
    if(hSvg)hSvg.innerHTML='';
    const intersect=this.findIntersectingPair(divs);
    divs.forEach((div,i)=>{
      const y1=div.yLeft/100*H;
      const y2=div.yRight/100*H;
      const mid=(div.yLeft+div.yRight)/2;
      const ctrl=mid+(div.curve||0);
      const yc=ctrl/100*H;
      // ── Visual path in background SVG ──────────────────────
      const path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d',`M 0 ${y1} Q ${(W/2).toFixed(1)} ${yc.toFixed(1)} ${W} ${y2}`);
      path.setAttribute('fill','none');
      path.setAttribute('stroke','rgba(255,255,255,.8)');
      path.setAttribute('stroke-width','2');
      path.setAttribute('stroke-dasharray','10 5');
      path.style.pointerEvents='none';
      svgEl.appendChild(path);
      // Guide lines from edge handles to curve handle (visual only)
      const mkGuide=(x1g,y1g,x2g,y2g)=>{
        const l=document.createElementNS('http://www.w3.org/2000/svg','line');
        l.setAttribute('x1',x1g);l.setAttribute('y1',y1g);l.setAttribute('x2',x2g);l.setAttribute('y2',y2g);
        l.setAttribute('stroke','rgba(46,160,67,.4)');l.setAttribute('stroke-width','1');l.setAttribute('stroke-dasharray','4 3');
        l.style.pointerEvents='none';svgEl.appendChild(l);
      };
      mkGuide(14,y1,W/2,yc);mkGuide(W-14,y2,W/2,yc);
      if(!hSvg)return;
      // ── Interactive handles in the HIGH-Z SVG ──────────────
      const mkHandle=(cx,cy,fill,title,side)=>{
        const g=document.createElementNS('http://www.w3.org/2000/svg','g');
        const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
        c.setAttribute('cx',cx);c.setAttribute('cy',cy);c.setAttribute('r',10);
        c.setAttribute('fill',fill);c.setAttribute('stroke','#fff');c.setAttribute('stroke-width','2');
        c.style.cssText='cursor:ns-resize;';
        const tt=document.createElementNS('http://www.w3.org/2000/svg','title');
        tt.textContent=title;c.appendChild(tt);
        g.appendChild(c);
        g.style.pointerEvents='all';
        g.addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();this.startDrag(e,i,side);});
        hSvg.appendChild(g);
      };
      mkHandle(14,y1,'#1f6feb','Drag to move left end of line',  'yLeft');
      mkHandle(W-14,y2,'#1f6feb','Drag to move right end of line','yRight');
      mkHandle(W/2,yc,'#2ea043','Drag to curve the line','curve');
      // Label
      const lt=document.createElementNS('http://www.w3.org/2000/svg','text');
      lt.setAttribute('x',28);lt.setAttribute('y',y1-14);lt.setAttribute('fill','rgba(255,255,255,.8)');lt.setAttribute('font-size','10');lt.setAttribute('font-family','sans-serif');lt.setAttribute('font-weight','600');
      lt.textContent=`Line ${i+1} — drag blue handles`;lt.style.pointerEvents='none';hSvg.appendChild(lt);
      // Delete button
      const delG=document.createElementNS('http://www.w3.org/2000/svg','g');
      const delC=document.createElementNS('http://www.w3.org/2000/svg','circle');
      delC.setAttribute('cx',W-30);delC.setAttribute('cy',y2-22);delC.setAttribute('r',9);
      delC.setAttribute('fill','rgba(218,54,51,.8)');delC.setAttribute('stroke','#fff');delC.setAttribute('stroke-width','1.5');
      const delT=document.createElementNS('http://www.w3.org/2000/svg','text');
      delT.setAttribute('x',W-30);delT.setAttribute('y',y2-18);delT.setAttribute('fill','#fff');delT.setAttribute('font-size','10');delT.setAttribute('font-family','sans-serif');delT.setAttribute('text-anchor','middle');delT.textContent='✕';
      delG.style.cssText='cursor:pointer;pointer-events:all;';
      delG.appendChild(delC);delG.appendChild(delT);
      delG.addEventListener('click',e=>{e.stopPropagation();this.removeDivider(i);});
      hSvg.appendChild(delG);
    });
    // Intersection marker
    if(intersect){
      const Px=intersect.P.x/100*W;const Py=intersect.P.y/100*H;
      const ring=document.createElementNS('http://www.w3.org/2000/svg','circle');
      ring.setAttribute('cx',Px);ring.setAttribute('cy',Py);ring.setAttribute('r',14);
      ring.setAttribute('fill','rgba(31,111,235,.22)');ring.setAttribute('stroke','#58a6ff');ring.setAttribute('stroke-width','2');
      ring.setAttribute('stroke-dasharray','4 3');ring.style.pointerEvents='none';svgEl.appendChild(ring);
      const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx',Px);dot.setAttribute('cy',Py);dot.setAttribute('r',4);
      dot.setAttribute('fill','#58a6ff');dot.style.pointerEvents='none';svgEl.appendChild(dot);
    }
  },
  startDrag(e,idx,side){
    e.preventDefault();e.stopPropagation();
    const pg=State.currentPage;if(!pg)return;
    const ec=document.getElementById('editor-canvas');
    const divs=this.getDividers(pg);
    const sorted=this.sortedDividers(pg);
    const origDiv=sorted[idx];const origIdx=divs.indexOf(origDiv);
    if(side==='curve'){
      // Dragging the green handle: sets the bezier control-point Y directly
      const onMove=ev=>{
        const rect=ec.getBoundingClientRect();
        const ctrlPct=Math.round(((ev.clientY-rect.top)/ec.offsetHeight)*1000)/10;
        const mid=(divs[origIdx].yLeft+divs[origIdx].yRight)/2;
        divs[origIdx].curve=Math.max(-80,Math.min(80,parseFloat((ctrlPct-mid).toFixed(1))));
        this.applyToCanvas(pg);State.dirty=true;
      };
      const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);this.ensureLayerCount(pg);this._refresh(pg);History.save();};
      document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
      return;
    }
    const onMove=ev=>{
      const rect=ec.getBoundingClientRect();
      const pct=Math.max(2,Math.min(98,Math.round(((ev.clientY-rect.top)/ec.offsetHeight)*1000)/10));
      if(origIdx>=0)divs[origIdx][side]=pct;
      this.applyToCanvas(pg);State.dirty=true;
    };
    const onUp=()=>{
      document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);
      this.ensureLayerCount(pg);this._refresh(pg);History.save();
    };
    document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
  },
  // ── Divider-type presets ──────────────────────────────────────
  // divIdx is an index into sortedDividers(pg).
  setDividerType(divIdx,type){
    const pg=State.currentPage;if(!pg)return;History.save();
    const sorted=this.sortedDividers(pg);
    const divs=this.getDividers(pg);
    const orig=sorted[divIdx];if(!orig)return;
    const origIdx=divs.indexOf(orig);if(origIdx<0)return;
    const baseY=(divs[origIdx].yLeft+divs[origIdx].yRight)/2;
    if(type==='horizontal'){
      divs[origIdx].yLeft=baseY;divs[origIdx].yRight=baseY;divs[origIdx].curve=0;
    }else if(type==='oblique'){
      divs[origIdx].yLeft=Math.max(5,baseY-18);divs[origIdx].yRight=Math.min(95,baseY+18);divs[origIdx].curve=0;
    }else if(type==='curved'){
      divs[origIdx].yLeft=baseY;divs[origIdx].yRight=baseY;
      divs[origIdx].curve=divs[origIdx].curve&&Math.abs(divs[origIdx].curve)>2?divs[origIdx].curve:22;
    }
    this._refresh(pg);State.dirty=true;
  },
  centerDivider(divIdx){
    const pg=State.currentPage;if(!pg)return;History.save();
    const sorted=this.sortedDividers(pg);
    const divs=this.getDividers(pg);
    const orig=sorted[divIdx];if(!orig)return;
    const origIdx=divs.indexOf(orig);if(origIdx<0)return;
    const cur=divs[origIdx];
    const delta=cur.yRight-cur.yLeft;// preserve slope
    cur.yLeft=50-delta/2;cur.yRight=50+delta/2;
    this._refresh(pg);State.dirty=true;
  },
  _dividerTypeOf(div){
    const horiz=Math.abs(div.yLeft-div.yRight)<1;
    const curved=Math.abs(div.curve||0)>2;
    if(curved)return'curved';
    if(horiz)return'horizontal';
    return'oblique';
  },
  exportHTML(page,bglId,display){
    const layers=this.getLayers(page);
    const sortedDivs=(page.bgDividers||[]).slice().sort((a,b)=>((a.yLeft+a.yRight)/2)-((b.yLeft+b.yRight)/2));
    const n=layers.length;
    const idStr=bglId?` id="${bglId}"`:'';
    // bgScrollMode: 'fixed' (parallax/artistic, stays put while content scrolls)
    //              'scroll' (bg moves with content, good for distinct sections)
    const scrollMode=page.bgScrollMode||'fixed';
    const outerPos=scrollMode==='scroll'?'position:absolute;inset:0;width:100%;min-height:100%;':'position:fixed;inset:0;';
    const displayStyle=display!=null?`display:${display};`:'';
    let html=`<div${idStr} style="${outerPos}z-index:0;pointer-events:none;overflow:hidden;${displayStyle}">\n`;
    let dynScript='';
    layers.forEach((layer,i)=>{
      const clip=this.layerClip(i,n,sortedDivs);
      const clipStyle=clip?`clip-path:${clip};`:'';
      if(layer.type==='dynamic'){
        const cid=`bgl-c-${bglId||'p'}-${i}`;
        html+=`  <canvas id="${cid}" style="position:absolute;inset:0;width:100%;height:100%;${clipStyle}"></canvas>\n`;
        dynScript+=`(${BgEffects.generateCancelable(layer.effectIndex||0,layer.colorA||'#00ff41',layer.colorB||'#00c8ff',layer.colorC||'#4080ff')})(document.getElementById('${cid}'));\n`;
      }else{
        html+=`  <div style="position:absolute;inset:0;${this.layerBgCSS(layer)}${clipStyle}"></div>\n`;
      }
    });
    html+=`</div>\n`;
    // Wrap canvas scripts in DOMContentLoaded so DOM is fully available.
    // Also trigger an immediate resize event so closures get correct W,H.
    if(dynScript)html+=`<script>\n(function(){function _run(){\n${dynScript}window.dispatchEvent(new Event('resize'));\n}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',_run);}else{_run();}})();\n<\/script>\n`;
    return html;
  },
};

// ── Snap ──────────────────────────────────────────────────────
const Snap={
  enabled:true,
  gridEnabled:false,
  THRESHOLD:8,
  GRID:20,
  getLines(excludeId){
    const hLines=[],vLines=[];
    for(const el of State.elements){
      if(el.id===excludeId)continue;
      const div=document.querySelector(`[data-id="${el.id}"]`);if(!div)continue;
      const w=div.offsetWidth,h=div.offsetHeight;
      vLines.push(el.x,el.x+w,el.x+w/2);
      hLines.push(el.y,el.y+h,el.y+h/2);
    }
    return{hLines,vLines};
  },
  snap1(val,lines){
    let best=null,bestD=this.THRESHOLD+1;
    for(const l of lines){const d=Math.abs(val-l);if(d<bestD){bestD=d;best=l;}}
    return best!==null?{val:best,guide:best}:{val,guide:null};
  },
  snapPos(x,y,w,h,excludeId){
    if(!this.enabled)return{x,y,guideH:null,guideV:null};
    const{hLines,vLines}=this.getLines(excludeId);
    let bestX=x,bestGV=null,bestDX=this.THRESHOLD+1;
    const tryV=(src,off)=>{const r=this.snap1(src,vLines);if(r.guide!==null){const d=Math.abs(src-r.val);if(d<bestDX){bestDX=d;bestX=r.val-off;bestGV=r.guide;}}};
    tryV(x,0);tryV(x+w,w);tryV(x+w/2,w/2);
    let bestY=y,bestGH=null,bestDY=this.THRESHOLD+1;
    const tryH=(src,off)=>{const r=this.snap1(src,hLines);if(r.guide!==null){const d=Math.abs(src-r.val);if(d<bestDY){bestDY=d;bestY=r.val-off;bestGH=r.guide;}}};
    tryH(y,0);tryH(y+h,h);tryH(y+h/2,h/2);
    if(this.gridEnabled){if(bestGV===null)bestX=Math.round(x/this.GRID)*this.GRID;if(bestGH===null)bestY=Math.round(y/this.GRID)*this.GRID;}
    return{x:Math.max(0,bestX),y:Math.max(0,bestY),guideH:bestGH,guideV:bestGV};
  },
  showGuides(h,v){
    const gh=document.getElementById('snap-guide-h'),gv=document.getElementById('snap-guide-v');
    h!==null?(gh.style.top=h+'px',gh.classList.remove('hidden')):gh.classList.add('hidden');
    v!==null?(gv.style.left=v+'px',gv.classList.remove('hidden')):gv.classList.add('hidden');
  },
  hideGuides(){
    document.getElementById('snap-guide-h').classList.add('hidden');
    document.getElementById('snap-guide-v').classList.add('hidden');
  },
};

// ── Fonts ─────────────────────────────────────────────────────
const FONTS=[
  {label:'System Default',  val:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'},
  {label:'Arial',           val:'Arial,Helvetica,sans-serif'},
  {label:'Georgia',         val:'Georgia,Times New Roman,serif'},
  {label:'Courier New',     val:'Courier New,Courier,monospace'},
  {label:'Trebuchet MS',    val:'Trebuchet MS,Helvetica,sans-serif'},
  {label:'Verdana',         val:'Verdana,Geneva,sans-serif'},
  {label:'Inter',           val:'Inter,sans-serif'},
  {label:'Playfair Display',val:'Playfair Display,Georgia,serif'},
  {label:'Montserrat',      val:'Montserrat,sans-serif'},
  {label:'Oswald',          val:'Oswald,sans-serif'},
  {label:'Dancing Script',  val:'Dancing Script,cursive'},
  {label:'Merriweather',    val:'Merriweather,serif'},
  {label:'Raleway',         val:'Raleway,sans-serif'},
  {label:'Lora',            val:'Lora,serif'},
  {label:'Space Grotesk',   val:'Space Grotesk,sans-serif'},
  {label:'DM Serif Display',val:'DM Serif Display,serif'},
  {label:'IBM Plex Mono',   val:'IBM Plex Mono,Courier New,monospace'},
  {label:'Bebas Neue',      val:'Bebas Neue,Impact,sans-serif'},
  {label:'Abril Fatface',   val:'Abril Fatface,Impact,serif'},
  {label:'Permanent Marker',val:'Permanent Marker,cursive'},
];

// ── 20 Design Theme Palettes ─────────────────────────────────────
// Each theme: page bg color, accent colors, panel bg, text, heading font, body font
const THEMES=[
  {id:'midnight',     label:'🌑 Midnight',
   pageBg:'#080b18',  acc1:'#4f8ef7', acc2:'#a78bfa',  acc3:'#34d399',
   panelBg:'rgba(255,255,255,0.04)', panelBorder:'rgba(100,130,255,0.2)',
   text:'#c9d1d9', heading:'#e6edf3',
   hFont:'Inter,sans-serif', bFont:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'},

  {id:'newspaper',    label:'📰 Newspaper',
   pageBg:'#f5f0e8',  acc1:'#1a1a1a', acc2:'#8b0000',  acc3:'#556b2f',
   panelBg:'rgba(0,0,0,0.06)', panelBorder:'rgba(0,0,0,0.25)',
   text:'#2a2a2a', heading:'#0a0a0a',
   hFont:'Playfair Display,Georgia,serif', bFont:'Georgia,Times New Roman,serif'},

  {id:'neon',         label:'🌈 Neon',
   pageBg:'#050508',  acc1:'#ff006e', acc2:'#00f5d4',  acc3:'#f0ff00',
   panelBg:'rgba(255,0,110,0.08)', panelBorder:'rgba(255,0,110,0.4)',
   text:'#e0e0e0', heading:'#ffffff',
   hFont:'Oswald,sans-serif', bFont:'Inter,sans-serif'},

  {id:'colorroom',    label:'🎨 Color Room',
   pageBg:'#1e0a3c',  acc1:'#ff6b35', acc2:'#ffd700',  acc3:'#00e5cc',
   panelBg:'rgba(255,255,255,0.07)', panelBorder:'rgba(255,107,53,0.4)',
   text:'#f0e8ff', heading:'#ffffff',
   hFont:'Abril Fatface,Impact,serif', bFont:'Raleway,sans-serif'},

  {id:'techno',       label:'⚡ Techno',
   pageBg:'#020b14',  acc1:'#00d4ff', acc2:'#ff3d71',  acc3:'#39ff14',
   panelBg:'rgba(0,212,255,0.06)', panelBorder:'rgba(0,212,255,0.3)',
   text:'#8ecfdc', heading:'#00d4ff',
   hFont:'IBM Plex Mono,Courier New,monospace', bFont:'IBM Plex Mono,Courier New,monospace'},

  {id:'firework',     label:'🎆 Firework',
   pageBg:'#06020e',  acc1:'#ffd700', acc2:'#ff4500',  acc3:'#ff69b4',
   panelBg:'rgba(255,215,0,0.07)', panelBorder:'rgba(255,215,0,0.35)',
   text:'#f5deb3', heading:'#ffd700',
   hFont:'Bebas Neue,Impact,sans-serif', bFont:'Trebuchet MS,Helvetica,sans-serif'},

  {id:'forest',       label:'🌲 Forest',
   pageBg:'#0a1f0a',  acc1:'#4ade80', acc2:'#86efac',  acc3:'#fbbf24',
   panelBg:'rgba(74,222,128,0.07)', panelBorder:'rgba(74,222,128,0.25)',
   text:'#bbf7d0', heading:'#ffffff',
   hFont:'Merriweather,serif', bFont:'Lora,serif'},

  {id:'sunset',       label:'🌇 Sunset',
   pageBg:'#1a0610',  acc1:'#fb923c', acc2:'#f472b6',  acc3:'#fcd34d',
   panelBg:'rgba(251,146,60,0.08)', panelBorder:'rgba(251,146,60,0.3)',
   text:'#fde8d8', heading:'#ffffff',
   hFont:'DM Serif Display,serif', bFont:'Lora,serif'},

  {id:'arctic',       label:'❄️ Arctic',
   pageBg:'#e8f4f8',  acc1:'#0ea5e9', acc2:'#7dd3fc',  acc3:'#0c4a6e',
   panelBg:'rgba(14,165,233,0.1)', panelBorder:'rgba(14,165,233,0.3)',
   text:'#0c4a6e', heading:'#042f4a',
   hFont:'Raleway,sans-serif', bFont:'Verdana,Geneva,sans-serif'},

  {id:'retro',        label:'📺 Retro',
   pageBg:'#f4e9d8',  acc1:'#c47b2b', acc2:'#8b4513',  acc3:'#556b2f',
   panelBg:'rgba(196,123,43,0.1)', panelBorder:'rgba(139,69,19,0.35)',
   text:'#3d2b1a', heading:'#1a0f00',
   hFont:'Oswald,sans-serif', bFont:'Georgia,Times New Roman,serif'},

  {id:'pastel',       label:'🌸 Pastel',
   pageBg:'#fef6fb',  acc1:'#f9a8d4', acc2:'#c4b5fd',  acc3:'#6ee7b7',
   panelBg:'rgba(249,168,212,0.15)', panelBorder:'rgba(249,168,212,0.4)',
   text:'#6b4c6e', heading:'#3b1f3d',
   hFont:'Dancing Script,cursive', bFont:'Lora,serif'},

  {id:'volcanic',     label:'🌋 Volcanic',
   pageBg:'#0e0000',  acc1:'#ff4500', acc2:'#ff8c00',  acc3:'#dc143c',
   panelBg:'rgba(255,69,0,0.1)', panelBorder:'rgba(255,69,0,0.4)',
   text:'#ffcba4', heading:'#ff6030',
   hFont:'Bebas Neue,Impact,sans-serif', bFont:'Trebuchet MS,Helvetica,sans-serif'},

  {id:'ocean',        label:'🌊 Ocean',
   pageBg:'#020d1a',  acc1:'#0891b2', acc2:'#22d3ee',  acc3:'#6ee7b7',
   panelBg:'rgba(8,145,178,0.1)', panelBorder:'rgba(34,211,238,0.3)',
   text:'#cffafe', heading:'#ffffff',
   hFont:'Montserrat,sans-serif', bFont:'Space Grotesk,sans-serif'},

  {id:'gallery',      label:'🖼 Gallery',
   pageBg:'#f9f9f9',  acc1:'#111111', acc2:'#555555',  acc3:'#e63946',
   panelBg:'rgba(0,0,0,0.04)', panelBorder:'rgba(0,0,0,0.15)',
   text:'#333333', heading:'#111111',
   hFont:'DM Serif Display,serif', bFont:'Space Grotesk,sans-serif'},

  {id:'sakura',       label:'🌸 Sakura',
   pageBg:'#fff0f5',  acc1:'#e75480', acc2:'#c8a2c8',  acc3:'#7cb9a8',
   panelBg:'rgba(231,84,128,0.08)', panelBorder:'rgba(231,84,128,0.25)',
   text:'#5d2448', heading:'#2d0a1e',
   hFont:'Abril Fatface,Impact,serif', bFont:'Lora,serif'},

  {id:'vapor',        label:'🌫 Vaporwave',
   pageBg:'#0d0020',  acc1:'#ff71ce', acc2:'#01cdfe',  acc3:'#b967ff',
   panelBg:'rgba(255,113,206,0.08)', panelBorder:'rgba(1,205,254,0.35)',
   text:'#e8d0f0', heading:'#ffffff',
   hFont:'Permanent Marker,cursive', bFont:'Raleway,sans-serif'},

  {id:'autumn',       label:'🍂 Autumn',
   pageBg:'#1a0c02',  acc1:'#d4621a', acc2:'#f5a623',  acc3:'#8b0000',
   panelBg:'rgba(212,98,26,0.1)', panelBorder:'rgba(212,98,26,0.35)',
   text:'#f5deb3', heading:'#ffd580',
   hFont:'Merriweather,serif', bFont:'Georgia,Times New Roman,serif'},

  {id:'industrial',   label:'🏭 Industrial',
   pageBg:'#151515',  acc1:'#b0b0b0', acc2:'#e05c20',  acc3:'#4a4a4a',
   panelBg:'rgba(176,176,176,0.07)', panelBorder:'rgba(176,176,176,0.2)',
   text:'#cccccc', heading:'#f0f0f0',
   hFont:'Bebas Neue,Impact,sans-serif', bFont:'IBM Plex Mono,Courier New,monospace'},

  {id:'meadow',       label:'🌻 Meadow',
   pageBg:'#f7f9e0',  acc1:'#2d6a4f', acc2:'#ffd166',  acc3:'#ef476f',
   panelBg:'rgba(45,106,79,0.09)', panelBorder:'rgba(45,106,79,0.3)',
   text:'#1b4332', heading:'#081c15',
   hFont:'Abril Fatface,Impact,serif', bFont:'Verdana,Geneva,sans-serif'},

  {id:'brutalist',    label:'🪨 Brutalist',
   pageBg:'#f0ede8',  acc1:'#ff3333', acc2:'#000000',  acc3:'#3333ff',
   panelBg:'rgba(0,0,0,0.05)', panelBorder:'rgba(0,0,0,0.8)',
   text:'#111111', heading:'#000000',
   hFont:'Oswald,sans-serif', bFont:'Arial,Helvetica,sans-serif'},
];

// Apply a theme to the current page as a quick-start
function applyTheme(themeId){
  const t=THEMES.find(x=>x.id===themeId);if(!t)return;
  const pg=State.currentPage;if(!pg)return;
  // Set page background
  pg.bgLayers=[{type:'solid',color:t.pageBg}];
  pg.bgDividers=[];
  // Update all existing elements to use theme fonts/colors where safe
  for(const el of State.elements){
    const p=el.props||{};
    if(el.type==='panel'){
      p.bgColor=t.panelBg; p.bgMode='solid';
      p.borderColor=t.panelBorder;
      p.titleColor=t.heading; p.bodyColor=t.text;
      p.titleFont=p.fontFamily=t.hFont;
    }else if(el.type==='heading'){
      p.color=t.heading; p.fontFamily=t.hFont;
    }else if(el.type==='text'){
      p.color=t.text; p.fontFamily=t.bFont;
    }else if(el.type==='button'){
      p.bgColor=t.acc1; p.bgGradB=t.acc2; p.textColor=t.pageBg.startsWith('#f')||t.pageBg.startsWith('#e')?'#111111':'#ffffff';
    }
  }
  Canvas.renderAll();BgLayers.applyToCanvas(pg);History.save();State.dirty=true;
}



// ── Panel shapes ──────────────────────────────────────────────
const PANEL_SHAPES=[
  {id:'normal',    label:'Normal',   icon:'▭', css:(r)=>`border-radius:${r}px;clip-path:none;`},
  {id:'pill',      label:'Pill',     icon:'⬭', css:()=>`border-radius:999px;clip-path:none;`},
  {id:'circle',    label:'Circle',   icon:'●', css:()=>`border-radius:50%;clip-path:none;`},
  {id:'diamond',   label:'Diamond',  icon:'◆', css:()=>`border-radius:0;clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);`},
  {id:'hexagon',   label:'Hex',      icon:'⬡', css:()=>`border-radius:0;clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%);`},
  {id:'skew',      label:'Skew',     icon:'▱', css:()=>`border-radius:0;clip-path:polygon(8% 0%,100% 0%,92% 100%,0% 100%);`},
  {id:'banner',    label:'Banner',   icon:'🏴', css:()=>`border-radius:0;clip-path:polygon(0 0,100% 0,93% 50%,100% 100%,0 100%,7% 50%);`},
  {id:'notch',     label:'Notch',    icon:'⬔', css:()=>`border-radius:0;clip-path:polygon(0 0,100% 0,100% 85%,85% 100%,0 100%);`},
  {id:'chevron',   label:'Chevron',  icon:'⌃', css:()=>`border-radius:0;clip-path:polygon(0 0,100% 0,100% 70%,50% 100%,0 70%);`},
];
function panelShapeCSS(shape,radius){
  const s=PANEL_SHAPES.find(s=>s.id===shape)||PANEL_SHAPES[0];
  return s.css(radius||6);
}

// ── Image canvas shapes ───────────────────────────────────────
const IMAGE_SHAPES=[
  {id:'none',     label:'Rectangle',icon:'▭',clip:null},
  {id:'circle',   label:'Circle',   icon:'●',clip:null,circle:true},// enforces square, uses border-radius:50%
  {id:'hexagon',  label:'Hexagon',  icon:'⬡',clip:'polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)'},
  {id:'diamond',  label:'Diamond',  icon:'◆',clip:'polygon(50% 0%,100% 50%,50% 100%,0% 50%)'},
  {id:'triangle', label:'Triangle', icon:'▲',clip:'polygon(50% 0%,100% 100%,0% 100%)'},
  {id:'star',     label:'Star',     icon:'★',clip:'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'},
  {id:'pill',     label:'Pill',     icon:'⬭',clip:null,pill:true},
  {id:'arch',     label:'Arch',     icon:'∩',clip:'ellipse(50% 60% at 50% 40%)'},
];
// Shapes that must have equal width and height to look correct
const IMAGE_SQUARE_SHAPES=new Set(['circle','hexagon','diamond','star']);
function imageShapeStyle(shape,borderRadius){
  const s=IMAGE_SHAPES.find(s=>s.id===shape);
  if(!s||s.id==='none') return `border-radius:${borderRadius||0}px;`;
  if(s.circle) return `border-radius:50%;overflow:hidden;`;// true circle only if element is square
  if(s.pill)   return `border-radius:999px;overflow:hidden;`;
  if(s.clip)   return `clip-path:${s.clip};border-radius:0;overflow:hidden;`;
  return `border-radius:${borderRadius||0}px;`;
}

// ── Defaults ──────────────────────────────────────────────────
function mkTableCells(cols,rows){const cells=[];for(let i=0;i<cols*rows;i++)cells.push({title:`Cell ${i+1}`,body:'Content here.'});return cells;}
const DEFAULTS={
  panel:    (x,y)=>({type:'panel',    x,y,w:320,h:'auto',props:{title:'Panel Title',body:'Write your content here.',bgColor:'rgba(255,255,255,0.04)',bgMode:'solid',bgGradB:'#000000',bgGradDir:'to right',borderColor:'rgba(255,255,255,0.12)',borderWidth:1,borderRadius:6,titleColor:'#e6edf3',bodyColor:'#8b949e',titleSize:16,bodySize:13,padding:16,shadow:false,shadowColor:'rgba(0,0,0,0.55)',gradientB:'',hoverScale:true,shape:'normal',textAlign:'left',justify:false,titleBold:true,titleItalic:false,titleUnderline:false,bodyBold:false,bodyItalic:false,bodyUnderline:false,fontFamily:FONTS[0].val,titleFont:FONTS[0].val,scrollIn:false,scrollInType:'scale',scrollInDelay:0}}),
  table:    (x,y)=>({type:'table',    x,y,w:640,h:'auto',props:{cols:3,rows:2,gap:10,cellBg:'rgba(255,255,255,0.04)',cellBgMode:'solid',cellBgGradB:'#000000',cellBgGradDir:'to right',cellBorder:'rgba(255,255,255,0.12)',borderRadius:6,titleColor:'#e6edf3',bodyColor:'#8b949e',titleSize:13,bodySize:11,padding:12,hoverScale:true,cells:mkTableCells(3,2),editingCell:0,fontFamily:FONTS[0].val}}),
  heading:  (x,y)=>({type:'heading',  x,y,w:500,h:'auto',props:{text:'Section Heading',level:'h2',color:'#e6edf3',fontSize:32,fontWeight:'800',italic:false,underline:false,align:'left',letterSpacing:0,fontFamily:FONTS[0].val}}),
  text:     (x,y)=>({type:'text',     x,y,w:400,h:'auto',props:{text:'This is a text block.',color:'#8b949e',fontSize:14,align:'left',lineHeight:1.65,bold:false,italic:false,underline:false,fontFamily:FONTS[0].val}}),
  image:    (x,y)=>({type:'image',    x,y,w:360,h:240,   props:{src:'',alt:'Image',objectFit:'cover',borderRadius:0,border:false,borderColor:'rgba(255,255,255,.15)',borderWidth:2,imageShape:'none',shadow:false,scrollIn:false,scrollInType:'scale',scrollInDelay:0}}),
  divider:  (x,y)=>({type:'divider',  x,y,w:600,h:20,    props:{color:'rgba(255,255,255,0.15)',thickness:1,style:'solid',marginV:8}}),
  button:   (x,y)=>({type:'button',   x,y,w:'auto',h:'auto',props:{label:'Click Me',linkMode:'url',href:'',pageTarget:'',sectionTarget:'',target:'_self',bgColor:'#1f6feb',bgMode:'solid',bgGradB:'#0d3a8f',bgGradDir:'to right',bgImage:'',textColor:'#ffffff',borderRadius:5,fontSize:14,paddingH:24,paddingV:10,bold:true,italic:false,underline:false,shadow:false,fontFamily:FONTS[0].val}}),
  navbar:   (x,y)=>({type:'navbar',   x,y,w:1440,h:'auto',props:{brand:'My Site',navLinks:[],bgColor:'rgba(0,0,0,0.7)',bgMode:'solid',bgGradB:'#1a1a2e',bgGradDir:'to right',textColor:'#e6edf3',sticky:false,fullWidth:true,fontFamily:FONTS[0].val}}),
  contact:  (x,y)=>({type:'contact',  x,y,w:460,h:'auto',props:{title:'Get in Touch',email:'you@example.com',bgColor:'rgba(255,255,255,0.04)',bgMode:'solid',bgGradB:'#0d1117',bgGradDir:'to right',borderColor:'rgba(255,255,255,0.1)',borderRadius:6,btnColor:'#238636',btnTextColor:'#ffffff',inputBg:'rgba(0,0,0,0.35)',textColor:'#e6edf3',btnLabel:'Send Message'}}),
  section:  (x,y)=>({type:'section',  x,y,w:800,h:30,    props:{name:'section-name'}}),
  spacer:   (x,y)=>({type:'spacer',   x,y,w:600,h:60,    props:{height:60}}),
  shape:    (x,y)=>({type:'shape',    x,y,w:200,h:200,   props:{form:'rectangle',bgColor:'rgba(255,255,255,0.08)',bgMode:'solid',bgGradB:'#4080ff',bgGradDir:'to right',borderColor:'rgba(255,255,255,0.2)',borderWidth:1,borderRadius:0,opacity:1,shadow:false,scrollIn:false,scrollInType:'scale',scrollInDelay:0}}),
  codeblock:(x,y)=>({type:'codeblock',x,y,w:500,h:'auto',props:{code:'// Your code here\nconsole.log("Hello!");',bgColor:'#0d1117',bgMode:'solid',bgGradB:'#1a1a2e',bgGradDir:'to right',textColor:'#e6edf3',fontSize:12,borderRadius:6,fontFamily:FONTS[3].val}}),
  folderpanel:(x,y)=>({type:'folderpanel',x,y,w:1200,h:500,props:{
    slides:[
      {title:'Chapter One',   body:'Your story begins here.',  bgImage:'',bgColor:'#1a1a2e'},
      {title:'Chapter Two',   body:'The journey continues.',   bgImage:'',bgColor:'#0d1b2a'},
      {title:'Chapter Three', body:'A new perspective opens.', bgImage:'',bgColor:'#16213e'},
    ],
    titleColor:'#ffffff',bodyColor:'rgba(255,255,255,0.75)',
    titleSize:36,bodySize:16,textAlign:'center',
    overlayColor:'rgba(0,0,0,0.35)',
    borderRadius:12,
    startWidth:100,
    editingSlide:0,
  }}),
  hscroll:(x,y)=>({type:'hscroll',x,y,w:1100,h:320,props:{
    items:[
      {title:'Card One',  body:'Description for card one.',  src:'https://picsum.photos/seed/hs1/400/300'},
      {title:'Card Two',  body:'Description for card two.',  src:'https://picsum.photos/seed/hs2/400/300'},
      {title:'Card Three',body:'Description for card three.',src:'https://picsum.photos/seed/hs3/400/300'},
      {title:'Card Four', body:'Description for card four.', src:'https://picsum.photos/seed/hs4/400/300'},
    ],
    itemW:260,gap:16,
    cardBg:'rgba(255,255,255,0.05)',borderColor:'rgba(255,255,255,0.1)',
    borderRadius:10,titleColor:'#e6edf3',bodyColor:'#8b949e',
    titleSize:15,bodySize:12,padding:14,
    showArrows:true,arrowColor:'#1f6feb',
    autoScroll:false,scrollSpeed:3,
    fontFamily:FONTS[0].val,
    scrollIn:false,scrollInType:'fade',scrollInDelay:0,
  }}),
  collage:(x,y)=>({type:'collage',x,y,w:900,h:500,props:{
    images:[
      {src:'https://picsum.photos/seed/col1/600/400',alt:'Photo 1'},
      {src:'https://picsum.photos/seed/col2/400/600',alt:'Photo 2'},
      {src:'https://picsum.photos/seed/col3/500/400',alt:'Photo 3'},
      {src:'https://picsum.photos/seed/col4/400/500',alt:'Photo 4'},
      {src:'https://picsum.photos/seed/col5/600/300',alt:'Photo 5'},
    ],
    cols:3,gap:8,borderRadius:6,
    hoverEffect:'zoom',objectFit:'cover',
    scrollIn:false,scrollInType:'splash',scrollInDelay:0,
  }}),
  line:(x,y)=>({type:'line',x,y,w:400,h:20,props:{
    orientation:'horizontal', // horizontal | vertical
    color:'rgba(255,255,255,0.25)',
    thickness:2,
    style:'solid', // solid|dashed|dotted|double
    gradient:false,
    gradientB:'rgba(255,255,255,0.1)',
    gradientDir:'to right',
    glowColor:'',
    scrollIn:false,scrollInType:'fade',scrollInDelay:0,
  }}),
};

// ── Text style helpers ────────────────────────────────────────
// Shared page name → safe filename (no spaces, no illegal chars)
function sanitizePageName(name){
  return (name||'page')
    .replace(/[\\/:*?"<>|]/g,'_')  // strip OS-illegal chars
    .replace(/\s+/g,'-')            // spaces → hyphens
    .trim() || 'page';
}

function textStyle(bold,italic,underline,fontFamily){
  const fw = bold ? 'font-weight:700;' : 'font-weight:400;';
  const fi = italic ? 'font-style:italic;' : '';
  const fd = underline ? 'text-decoration:underline;' : '';
  const ff = fontFamily ? `font-family:${fontFamily};` : '';
  return fw+fi+fd+ff;
}
// Compute background CSS from bgMode/bgColor/bgGradB/bgGradDir/bgImage
// ── Procedural Textures ──────────────────────────────────────────
// Each texture returns a CSS-ready value (data URI or css function)
// usable directly in background: or background-image:
const Textures={
  _cache:{},
  DEFS:[
    {id:'marble',    label:'🪨 Marble',     url:}
    {id:'gravel',    label:'🪨 Stone',      url:'https://images.unsplash.com/photo-1558618047-3c1f19fa6e7a?w=512&h=512&fit=crop'},
    {id:'water',     label:'💧 Water',      url:'},
    {id:'earth',     label:'🌍 Soil',       url:'},
    {id:'wood',     label:'🪵 Wood',      url:'},
    {id:'metal',    label:'🔩 Metal',     url:''},
    {id:'noise',     label:'🌫 Noise',       fn:'_noise'},
    {id:'grid',      label:'⊞ Grid',        fn:'_grid'},
    {id:'dots',      label:'⬤ Dots',        fn:'_dots'},
  ],
  get(id,color1,color2){
    const key=id+'|'+(color1||'')+'|'+(color2||'');
    if(this._cache[key])return this._cache[key];
    const def=this.DEFS.find(d=>d.id===id);
    if(!def)return`background:#222;`;
    let css;
    if(def.url){
      css=`background-image:url('${def.url}');background-repeat:repeat;background-size:300px 300px;`;
    }else{
      const uri=this[def.fn](color1||'#888888',color2||'#333333');
      css=`background-image:url('${uri}');background-repeat:repeat;background-size:128px 128px;`;
    }
    this._cache[key]=css;
    return css;
  },
  _canvas(fn){
    const c=document.createElement('canvas');c.width=128;c.height=128;
    const ctx=c.getContext('2d');fn(ctx,c);
    return c.toDataURL('image/png');
  },
  _hex2rgb(h){h=h.replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];},
  _lerp(a,b,t){return a+(b-a)*t;},
  _lerpCol(c1,c2,t){const a=this._hex2rgb(c1.startsWith('#')?c1:'#888888');const b=this._hex2rgb(c2.startsWith('#')?c2:'#333333');return`rgb(${(this._lerp(a[0],b[0],t))|0},${(this._lerp(a[1],b[1],t))|0},${(this._lerp(a[2],b[2],t))|0})`;},
  // Smooth noise helper (value noise)
  _snoise(x,y,seed){
    const h=(x*374761393+y*668265263+(seed||0)*1234567)&0x7fffffff;
    return(h^(h>>16)^((h>>8)&0xff))/2147483647;
  },
  _marble(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#d0c8b0');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#6b5e4a');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      let v=Math.sin(x/8+Math.sin(y/12+Math.sin(x/6)*2)*3+Math.cos(y/9)*2);
      let v2=Math.sin(y/10+Math.sin(x/14)*3+Math.cos(x/8+y/8)*2);
      let t=(Math.sin((v+v2)*Math.PI)*0.5+0.5);
      t=Math.pow(t,0.7);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _gravel(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#9e9e9e');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#3d3d3d');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const v=this._snoise(x>>3,y>>3,7)+(this._snoise(x>>1,y>>1,13)-0.5)*0.4;
      const sharp=v>0.55?1:v<0.35?0:Math.pow((v-0.35)/0.2,1.5);
      const grain=(this._snoise(x,y,3)-0.5)*0.18;
      const t=Math.min(1,Math.max(0,sharp+grain));
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _water(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#1a6b9a');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#0a3050');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const v=Math.sin(x/6+Math.cos(y/8)*2)*0.5+
               Math.cos(y/5+Math.sin(x/9)*1.5)*0.3+
               Math.sin((x+y)/12)*0.2;
      const t=(v*0.5+0.5);
      const shimmer=t>0.75?Math.pow((t-0.75)*4,2)*0.4:0;
      const tt=Math.min(1,t+shimmer);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],tt)|0;
      d[i+1]=this._lerp(r1[1],r2[1],tt)|0;
      d[i+2]=this._lerp(r1[2],r2[2],tt)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _earth(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#8b6340');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#3d2210');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const n1=this._snoise(x>>2,y>>2,1);
      const n2=this._snoise(x>>1,y>>1,5)*0.5;
      const n3=this._snoise(x,y,9)*0.25;
      const v=n1+n2+n3;
      const t=Math.min(1,Math.max(0,v*0.8+0.1));
      const crack=(n2<0.18&&n1<0.35)?0.4:0;
      const tt=Math.max(0,t-crack);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],tt)|0;
      d[i+1]=this._lerp(r1[1],r2[1],tt)|0;
      d[i+2]=this._lerp(r1[2],r2[2],tt)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _wood(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#b8813a');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#5c3010');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const grain=(this._snoise(x,y>>2,11)-0.5)*0.08;
      const ring=Math.sin(Math.sqrt(Math.pow(x-64,2)+Math.pow(y-64,2))/4+grain*20);
      const t=(ring*0.5+0.5);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _fabric(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#3a5f8a');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#1a2f4a');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const warp=Math.sin(x*0.8+(y%4)*0.3)*0.5+0.5;
      const weft=Math.cos(y*0.8+(x%4)*0.3)*0.5+0.5;
      const t=(warp*0.6+weft*0.4);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _concrete(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#a0a0a0');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#505050');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const base=this._snoise(x>>3,y>>3,3)*0.5+this._snoise(x>>1,y>>1,7)*0.3+this._snoise(x,y,11)*0.2;
      const t=Math.min(1,Math.max(0,base));
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _noise(c1,c2){return this._canvas((ctx)=>{
    const img=ctx.createImageData(128,128);const d=img.data;
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#888888');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#111111');
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const t=this._snoise(x,y,17);
      const i=(y*128+x)*4;
      d[i]  =this._lerp(r1[0],r2[0],t)|0;
      d[i+1]=this._lerp(r1[1],r2[1],t)|0;
      d[i+2]=this._lerp(r1[2],r2[2],t)|0;
      d[i+3]=255;
    }
    ctx.putImageData(img,0,0);
  });},
  _grid(c1,c2){return this._canvas((ctx,cv)=>{
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#1a1a1a');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#383838');
    ctx.fillStyle=`rgb(${r1[0]},${r1[1]},${r1[2]})`;ctx.fillRect(0,0,128,128);
    ctx.strokeStyle=`rgb(${r2[0]},${r2[1]},${r2[2]})`;ctx.lineWidth=1;
    for(let i=0;i<=128;i+=16){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i,128);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(128,i);ctx.stroke();}
  });},
  _dots(c1,c2){return this._canvas((ctx)=>{
    const r1=this._hex2rgb(c1.startsWith('#')?c1:'#1a1a1a');
    const r2=this._hex2rgb(c2.startsWith('#')?c2:'#505050');
    ctx.fillStyle=`rgb(${r1[0]},${r1[1]},${r1[2]})`;ctx.fillRect(0,0,128,128);
    ctx.fillStyle=`rgb(${r2[0]},${r2[1]},${r2[2]})`;
    for(let y=8;y<128;y+=16)for(let x=8;x<128;x+=16){ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}
  });},
};


function computeBg(p,colorKey,modeKey,gradBKey,gradDirKey,imgKey){
  colorKey=colorKey||'bgColor'; modeKey=modeKey||'bgMode';
  gradBKey=gradBKey||'bgGradB'; gradDirKey=gradDirKey||'bgGradDir'; imgKey=imgKey||'bgImage';
  const mode=p[modeKey]||'solid';
  const colorA=p[colorKey]||'#000000';
  const colorB=p[gradBKey]||'#000000';
  const dir=p[gradDirKey]||'to right';
  if(mode==='gradient'){
    if(dir==='radial') return `background:radial-gradient(circle at center,${colorA},${colorB});`;
    return `background:linear-gradient(${dir},${colorA},${colorB});`;
  }
  if(mode==='image'&&p[imgKey]) return `background:url('${p[imgKey]}') center/cover no-repeat;`;
  if(mode==='texture'&&p.bgTexture) return Textures.get(p.bgTexture,p.bgTexColor1||colorA,p.bgTexColor2||colorB);
  return `background:${colorA};`;
}
function elShadowFilter(el){
  const p=el.props||{};
  if(!p.shadow) return '';
  const color=p.shadowColor||'rgba(0,0,0,0.55)';
  const isShaped=(el.type==='panel'&&p.shape&&p.shape!=='normal')||
                 (el.type==='shape'&&p.form!=='rectangle')||
                 (el.type==='image');
  return isShaped
    ? `filter:drop-shadow(0 8px 24px ${color});`
    : `box-shadow:0 8px 28px ${color};`;
}


// ── Canvas ────────────────────────────────────────────────────
const Canvas={
  layer:null,
  init(){
    this.layer=document.getElementById('elements-layer');
    document.getElementById('editor-canvas').addEventListener('contextmenu',e=>{
      e.preventDefault();
      const el=e.target.closest('.el');
      if(el)CtxMenu.show(e.clientX,e.clientY,el.dataset.id);
    });
    document.addEventListener('click',()=>CtxMenu.hide());
    document.addEventListener('keydown',e=>{
      const inInput=document.activeElement&&(document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA');
      // Ctrl+Enter: generate from AI prompt textarea, or accept ghosts
      if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){
        if(document.activeElement&&document.activeElement.id==='ai-prompt-input'){
          e.preventDefault();AiGen.generate(document.activeElement.value);return;
        }
        if(AiGen._pending.length){e.preventDefault();AiGen.acceptAll();return;}
      }
      if((e.key==='Delete'||e.key==='Backspace')&&State.selectedElId&&!inInput){
        History.save();Canvas.deleteSelected();
      }
      if(e.key==='Escape'){
        if(AiGen._pending.length){AiGen.rejectAll();return;}
        State.selectedTool=null;Props.deselectTool();Canvas.deselect();
      }
      // Enter alone (no input focused) accepts all ghosts
      if(e.key==='Enter'&&AiGen._pending.length&&!inInput){e.preventDefault();AiGen.acceptAll();return;}
      if((e.ctrlKey||e.metaKey)&&!inInput){
        if(e.key==='z'||e.key==='Z'){e.preventDefault();History.undo();}
        if(e.key==='y'||e.key==='Y'){e.preventDefault();History.redo();}
        if(e.key==='c'||e.key==='C'){e.preventDefault();Clipboard.copy();}
        if(e.key==='v'||e.key==='V'){e.preventDefault();Clipboard.paste();}
      }
    });
    // Tooltip system
    const tip=document.getElementById('tool-tooltip');
    document.querySelectorAll('.tool-btn[data-tip]').forEach(btn=>{
      btn.addEventListener('mouseenter',e=>{
        tip.innerHTML=`<strong>${btn.dataset.tipTitle||''}</strong>${btn.dataset.tip||''}`;
        tip.classList.add('visible');
        this._positionTip(e,tip);
      });
      btn.addEventListener('mousemove',e=>this._positionTip(e,tip));
      btn.addEventListener('mouseleave',()=>tip.classList.remove('visible'));
    });
  },
  _positionTip(e,tip){
    const x=e.clientX+18,y=e.clientY-10;
    tip.style.left=Math.min(x,window.innerWidth-240)+'px';
    tip.style.top=Math.max(4,y)+'px';
  },

  renderAll(){
    this.layer.innerHTML='';
    for(const el of State.elements)this.renderEl(el);
    this.applyBackground();
    this.updateHeight();
  },
  updateHeight(){
    const ec=document.getElementById('editor-canvas');
    let maxB=600;
    for(const el of State.elements){
      const div=document.querySelector(`[data-id="${el.id}"]`);
      const h=div?div.offsetHeight:(el.h==='auto'?100:el.h);
      maxB=Math.max(maxB,el.y+h);
    }
    ec.style.minHeight=(maxB+250)+'px';
  },

  renderEl(el){
    const div=document.createElement('div');
    div.className='el';div.dataset.id=el.id;div.dataset.type=el.type;
    div.style.left=el.x+'px';div.style.top=el.y+'px';
    if(el.w!=='auto')div.style.width=el.w+'px';
    if(el.h!=='auto')div.style.height=el.h+'px';
    const sf=elShadowFilter(el);
    if(sf){const m=sf.match(/^(filter|box-shadow):(.+);$/);if(m)div.style[m[1]==='filter'?'filter':'boxShadow']=m[2].trim();}
    div.innerHTML=this.renderInner(el);
    if(el.id===State.selectedElId)div.classList.add('selected');
    div.addEventListener('mousedown',e=>{
      if(e.button!==0)return;e.stopPropagation();
      if(State.selectedTool)return;
      this.select(el.id);Drag.start(e,el);
    });
    this.layer.appendChild(div);
    if(el.id===State.selectedElId)this.addResizeHandles(div,el);
  },

  renderInner(el){
    const p=el.props;
    const ff=p.fontFamily?`font-family:${p.fontFamily};`:'';
    switch(el.type){
      case 'panel':{
        const shapeCSS=panelShapeCSS(p.shape,p.borderRadius);
        const isShaped=p.shape&&p.shape!=='normal';
        const overflowCSS=isShaped?'overflow:hidden;':'';
        // For shaped panels: always center — force regardless of stored textAlign
        // Also compute extra padding so text stays well inside the clipped shape
        let effectiveAlign=p.textAlign||'left';
        let extraPad=0;
        if(isShaped){
          // Use whatever alignment user chose; auto-center is set on shape selection, not forced here
          const shapePads={circle:22,pill:18,diamond:28,hexagon:20,skew:14,banner:16,notch:12,chevron:10};
          extraPad=shapePads[p.shape]||14;
        }
        const totalPad=`${p.padding+extraPad}px ${p.padding+extraPad}px`;
        const paddingCSS=isShaped?`padding:${totalPad};`:`padding:${p.padding}px;`;
        const alignItems=effectiveAlign==='right'?'flex-end':effectiveAlign==='center'?'center':'flex-start';
        const layoutCSS=isShaped?`display:flex;flex-direction:column;align-items:${alignItems};justify-content:center;box-sizing:border-box;`:'';
        const alignCSS=`text-align:${effectiveAlign};`;
        const justifyCSS=(p.justify&&!isShaped)?'text-align:justify;':'';
        // For shaped panels: fill the .el container so the shape covers full element bounds
        const fillCSS=isShaped?'width:100%;height:100%;':''; 
        // Shaped panels: wrap in border-color shell to simulate border over clip-path
        const bw=isShaped?(p.borderWidth||0):0;
        if(isShaped&&bw>0){
          return `<div class="el-panel" style="width:100%;height:100%;background:${p.borderColor};${shapeCSS}overflow:hidden;">
            <div style="position:absolute;inset:${bw}px;${computeBg(p)}${shapeCSS}${paddingCSS}overflow:hidden;${layoutCSS}">
              <div class="el-panel-title" style="color:${p.titleColor};font-size:${p.titleSize}px;${textStyle(p.titleBold!==false,p.titleItalic,p.titleUnderline,p.titleFont||p.fontFamily||'')}${alignCSS}width:100%;">${escHtml(p.title)}</div>
              <div class="el-panel-body" style="color:${p.bodyColor};font-size:${p.bodySize}px;${textStyle(p.bodyBold,p.bodyItalic,p.bodyUnderline,p.fontFamily||'')}${justifyCSS||alignCSS}width:100%;">${escHtml(p.body)}</div>
            </div></div>`;
        }
        return `<div class="el-panel" style="${fillCSS}${computeBg(p)}border:${p.borderWidth}px solid ${p.borderColor};${paddingCSS}${shapeCSS}${overflowCSS}${layoutCSS}${ff}">
          <div class="el-panel-title" style="color:${p.titleColor};font-size:${p.titleSize}px;${textStyle(p.titleBold!==false,p.titleItalic,p.titleUnderline,p.titleFont||p.fontFamily||'')}${alignCSS}width:100%;">${escHtml(p.title)}</div>
          <div class="el-panel-body"  style="color:${p.bodyColor};font-size:${p.bodySize}px;${textStyle(p.bodyBold,p.bodyItalic,p.bodyUnderline,p.fontFamily||'')}${justifyCSS||alignCSS}width:100%;">${escHtml(p.body)}</div></div>`;
      }
      case 'table':{
        const cells=p.cells||[];
        const gridStyle=`display:grid;grid-template-columns:repeat(${p.cols},1fr);gap:${p.gap}px;width:100%;`;
        const baseCellBgCSS=p.cellBgMode==='gradient'
          ? (p.cellBgGradDir==='radial'
              ? `radial-gradient(circle at center,${p.cellBg||'#1a1a2e'},${p.cellBgGradB||'#000'})`
              : `linear-gradient(${p.cellBgGradDir||'to right'},${p.cellBg||'#1a1a2e'},${p.cellBgGradB||'#000'})`)
          : (p.cellBg||'rgba(255,255,255,0.04)');
        const cm=p.contourMode||'all';
        const cellsHtml=cells.map((c,i)=>{
          const bg=c.bgOverride||baseCellBgCSS;
          const showBorder=cm==='all'||(cm==='first'&&i===0)||(cm==='outer'&&(i<p.cols||i%p.cols===0||i%p.cols===p.cols-1||i>=cells.length-p.cols));
          const borderCSS=cm==='none'?'border:none;':showBorder?`border:1px solid ${p.cellBorder};`:'border:1px solid transparent;';
          // Optional matrix/rain animation chars
          const matrixOverlay=p.matrixBg?`<div class="tbl-matrix-bg" style="position:absolute;inset:0;overflow:hidden;border-radius:inherit;opacity:0.13;pointer-events:none;font-size:9px;font-family:monospace;color:#0f0;line-height:1.1;word-break:break-all;">${Array.from({length:80},()=>String.fromCharCode(0x30A0+Math.random()*96)).join('')}</div>`:'';
          // Optional gridlines overlay
          const gridOverlay=p.showGrid?`<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.06) 1px,transparent 1px);background-size:20px 20px;border-radius:inherit;pointer-events:none;"></div>`:'';
          return `<div class="el-table-cell${i===p.editingCell?' editing-cell':''}" style="position:relative;background:${bg};${borderCSS}border-radius:${p.borderRadius}px;padding:${p.padding}px;overflow:hidden;${ff}">
            ${matrixOverlay}${gridOverlay}
            <div style="position:relative;z-index:1;">
              <div class="el-table-cell-title" style="color:${p.titleColor};font-size:${p.titleSize}px;">${escHtml(c.title)}</div>
              <div class="el-table-cell-body"  style="color:${p.bodyColor};font-size:${p.bodySize}px;">${escHtml(c.body)}</div>
            </div>
          </div>`;
        }).join('');
        return `<div class="el-table-grid" style="${gridStyle}">${cellsHtml}</div>`;
      }
      case 'heading':{
        const tag=p.level||'h2';
        return `<${tag} class="el-heading" style="color:${p.color};font-size:${p.fontSize}px;text-align:${p.align};letter-spacing:${p.letterSpacing}px;${textStyle(p.fontWeight>='700'||p.fontWeight==='bold',p.italic,p.underline,p.fontFamily)}">${escHtml(p.text)}</${tag}>`;
      }
      case 'text':
        return `<p class="el-text" style="color:${p.color};font-size:${p.fontSize}px;text-align:${p.align};line-height:${p.lineHeight};${textStyle(p.bold,p.italic,p.underline,p.fontFamily)}">${escHtml(p.text)}</p>`;
      case 'image':{
        const imgShape=p.imageShape||'none';
        const shapeStyle=imageShapeStyle(imgShape,p.borderRadius);
        const borderCSS=p.border?`border:${p.borderWidth||2}px solid ${p.borderColor};box-sizing:border-box;`:'';
        const shadowCSS=p.shadow?'filter:drop-shadow(0 8px 24px rgba(0,0,0,.5));':'';
        const needsSquare=IMAGE_SQUARE_SHAPES.has(imgShape);
        const innerStyle=needsSquare
          ?`width:100%;height:100%;aspect-ratio:1;${shapeStyle}${borderCSS}${shadowCSS}overflow:hidden;display:flex;align-items:center;justify-content:center;`
          :`width:100%;height:100%;${shapeStyle}${borderCSS}${shadowCSS}overflow:hidden;`;
        const imgPosX=p.imgPosX!=null?p.imgPosX:50;
        const imgPosY=p.imgPosY!=null?p.imgPosY:50;
        const imgZoom=p.imgZoom!=null&&p.imgZoom>1?p.imgZoom:1;
        const zoomStyle=imgZoom>1?`transform:scale(${imgZoom});transform-origin:${imgPosX}% ${imgPosY}%;`:'';
        const hzClass=p.hoverZoom?' el-hover-zoom':'';
        return p.src
          ?`<div class="el-image${hzClass}" style="${innerStyle}"><img src="${p.src}" alt="${escHtml(p.alt)}" style="width:100%;height:100%;object-fit:${p.objectFit};object-position:${imgPosX}% ${imgPosY}%;display:block;${zoomStyle}"/></div>`
          :`<div class="el-image-placeholder"><span style="font-size:28px">🖼</span><span>Click "Choose Image"<br/>in Properties</span></div>`;
      }
      case 'divider':
        return `<div class="el-divider" style="padding:${p.marginV}px 0;width:100%;"><hr style="border-top:${p.thickness}px ${p.style} ${p.color};"/></div>`;
      case 'button':
        return `<div class="el-button-wrap" style="${p.shadow?'filter:drop-shadow(0 6px 18px rgba(0,0,0,.4));':''}"><button class="el-button" style="${computeBg(p)}color:${p.textColor};border-radius:${p.borderRadius}px;font-size:${p.fontSize}px;padding:${p.paddingV}px ${p.paddingH}px;${textStyle(p.bold,p.italic,p.underline,p.fontFamily)}">${escHtml(p.label)}</button></div>`;
      case 'navbar':{
        const nlinks=(p.navLinks||[{label:'Home',target:''}]);
        return `<div class="el-navbar" style="${computeBg(p)}${ff}">
          <span class="nav-brand" style="color:${p.textColor};">${escHtml(p.brand)}</span>
          <div class="nav-links">${nlinks.map(l=>{
            const isPage=l.pageTarget&&l.pageTarget.trim();
            const hasSection=l.target&&l.target.trim();
            const connected=isPage||hasSection;
            return `<a class="nav-link" style="color:${p.textColor};opacity:${connected?.9:.4};${!connected?'text-decoration:line-through;':''}" title="${isPage?'→ Page: '+l.pageTarget:hasSection?'#'+l.target:'⚠ No link set'}">${escHtml(l.label)}${isPage?'<span style="font-size:8px;opacity:.6;margin-left:2px;">↗</span>':''}</a>`;
          }).join('')}</div></div>`;
      }
      case 'contact':
        return `<div class="el-contact" style="${computeBg(p)}border:1px solid ${p.borderColor};border-radius:${p.borderRadius}px;color:${p.textColor||'#e6edf3'};">
          ${p.title?`<h3 style="color:${p.textColor||'#e6edf3'};">${escHtml(p.title)}</h3>`:''}
          <input type="text" placeholder="Your Name" readonly style="color:${p.textColor||'#e6edf3'};background:${p.inputBg||'rgba(0,0,0,.3)'}"/>
          <input type="email" placeholder="Your Email" readonly style="color:${p.textColor||'#e6edf3'};background:${p.inputBg||'rgba(0,0,0,.3)'}"/>
          <input type="text" placeholder="Subject" readonly style="color:${p.textColor||'#e6edf3'};background:${p.inputBg||'rgba(0,0,0,.3)'}"/>
          <textarea placeholder="Message..." readonly style="color:${p.textColor||'#e6edf3'};background:${p.inputBg||'rgba(0,0,0,.3)'}"></textarea>
          <button style="background:${p.btnColor||'#238636'};color:${p.btnTextColor||'#fff'};">${escHtml(p.btnLabel)}</button></div>`;
      case 'section':
        return `<div class="el-section-anchor">§ Section: <strong>${escHtml(p.name)}</strong></div>`;
      case 'spacer':
        return `<div class="el-spacer" style="height:${p.height}px;"></div>`;
      case 'shape':{
        let clipPath='none',borderRadius=p.borderRadius+'px';
        switch(p.form){
          case 'circle':borderRadius='50%';break;
          case 'triangle':clipPath='polygon(50% 0%,100% 100%,0% 100%)';borderRadius='0';break;
          case 'parallelogram':clipPath='polygon(15% 0%,100% 0%,85% 100%,0% 100%)';borderRadius='0';break;
          case 'hexagon':clipPath='polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)';borderRadius='0';break;
        }
        return `<div class="el-shape" style="width:100%;height:100%;${computeBg(p)}border-radius:${borderRadius};opacity:${p.opacity};clip-path:${clipPath};"></div>`;
      }
      case 'codeblock':
        return `<pre class="el-codeblock" style="${computeBg(p)}color:${p.textColor};font-size:${p.fontSize}px;border-radius:${p.borderRadius}px;${ff}">${escHtml(p.code)}</pre>`;
      case 'folderpanel':{
        // Editor preview: show ALL slides as clickable stacked tabs
        const slides=p.slides||[];
        const si=Math.min(p.editingSlide||0,slides.length-1);
        const s=slides[si]||{title:'Slide',body:'',bgColor:'#1a1a2e',bgImage:''};
        const bgStr=s.bgImage?`url('${s.bgImage}') center/cover no-repeat`:(s.bgColor||'#1a1a2e');
        const align=p.textAlign||'center';
        // Build clickable tab bar
        const tabs=slides.map((_sl,i)=>`<button onclick="event.stopPropagation();Props.selectFolderSlide(${i})" style="padding:4px 10px;border-radius:4px;border:1px solid ${i===si?'rgba(255,255,255,0.5)':'rgba(255,255,255,0.15)'};background:${i===si?'rgba(255,255,255,0.18)':'rgba(0,0,0,0.35)'};color:${i===si?'#fff':'rgba(255,255,255,0.55)'};font-size:10px;cursor:pointer;white-space:nowrap;">Slide ${i+1}</button>`).join('');
        return `<div class="el-folderpanel" style="width:100%;height:100%;background:${bgStr};border-radius:${p.borderRadius||0}px;display:flex;flex-direction:column;align-items:${align==='right'?'flex-end':align==='left'?'flex-start':'center'};justify-content:center;padding:32px;box-sizing:border-box;overflow:hidden;position:relative;">
          <div style="position:absolute;inset:0;background:${p.overlayColor||'rgba(0,0,0,0.45)'};border-radius:inherit;"></div>
          <div style="position:relative;z-index:1;text-align:${align};width:100%;">
            <div style="color:${p.titleColor||'#fff'};font-size:${p.titleSize||36}px;font-weight:700;margin-bottom:10px;white-space:pre-wrap;">${escHtml(s.title)}</div>
            <div style="color:${p.bodyColor||'rgba(255,255,255,0.75)'};font-size:${p.bodySize||16}px;white-space:pre-wrap;">${escHtml(s.body)}</div>
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;z-index:3;display:flex;flex-wrap:wrap;gap:4px;padding:10px 14px;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);">
            ${tabs}
            <span style="margin-left:auto;font-size:10px;color:rgba(255,255,255,0.35);align-self:center;">📂 ${slides.length} slides — click tab to edit</span>
          </div>
        </div>`;
      }
      case 'hscroll':{
        const items=p.items||[];
        const iW=p.itemW||260;
        const cards=items.map(it=>`
          <div style="flex:0 0 ${iW}px;background:${p.cardBg||'rgba(255,255,255,0.05)'};border:1px solid ${p.borderColor||'rgba(255,255,255,0.1)'};border-radius:${p.borderRadius||10}px;overflow:hidden;box-sizing:border-box;">
            ${it.src?`<img src="${it.src}" style="width:100%;height:140px;object-fit:cover;display:block;" loading="lazy"/>`:``}
            <div style="padding:${p.padding||14}px;">
              <div style="color:${p.titleColor||'#e6edf3'};font-size:${p.titleSize||15}px;font-weight:600;margin-bottom:5px;">${escHtml(it.title||'')}</div>
              <div style="color:${p.bodyColor||'#8b949e'};font-size:${p.bodySize||12}px;line-height:1.5;">${escHtml(it.body||'')}</div>
            </div>
          </div>`).join('');
        return `<div style="width:100%;height:100%;position:relative;overflow:hidden;">
          <div style="display:flex;gap:${p.gap||16}px;overflow-x:auto;padding:8px 4px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent;height:100%;box-sizing:border-box;">${cards}</div>
          ${p.showArrows?`<div style="position:absolute;bottom:4px;right:4px;font-size:10px;color:rgba(255,255,255,0.4);">↔ H-Scroll · ${items.length} cards</div>`:''}
        </div>`;
      }
      case 'collage':{
        const imgs=p.images||[];
        const cols=Math.min(6,p.cols||3);
        const grd=imgs.slice(0,12).map(img=>`
          <div style="border-radius:${p.borderRadius||6}px;overflow:hidden;${p.hoverEffect==='zoom'?'transition:transform .3s;':''}">
            <img src="${img.src||''}" alt="${escHtml(img.alt||'')}" style="width:100%;height:100%;object-fit:${p.objectFit||'cover'};display:block;" loading="lazy"/>
          </div>`).join('');
        return `<div style="width:100%;height:100%;display:grid;grid-template-columns:repeat(${cols},1fr);gap:${p.gap||8}px;overflow:hidden;">${grd}</div>`;
      }
      case 'line':{
        const vert=p.orientation==='vertical';
        const t=p.thickness||2;
        const bg=p.gradient
          ? `linear-gradient(${p.gradientDir||'to right'},${p.color||'rgba(255,255,255,0.25)'},${p.gradientB||'rgba(100,100,100,0.15)'})`
          : (p.color||'rgba(255,255,255,0.25)');
        const glow=p.glowColor?`box-shadow:0 0 8px 2px ${p.glowColor};`:'';
        if(vert) return `<div style="width:${t}px;height:100%;margin:0 auto;background:${bg};${glow}${p.style==='dashed'?'background:repeating-linear-gradient(to bottom,'+p.color+' 0px,'+p.color+' 8px,transparent 8px,transparent 16px);':''}border-radius:2px;"></div>`;
        const dashStyle=p.style==='dashed'?`background:repeating-linear-gradient(to right,${p.color||'rgba(255,255,255,0.25)'} 0px,${p.color||'rgba(255,255,255,0.25)'} 8px,transparent 8px,transparent 16px);`
          :p.style==='dotted'?`background:repeating-linear-gradient(to right,${p.color||'rgba(255,255,255,0.25)'} 0px,${p.color||'rgba(255,255,255,0.25)'} 3px,transparent 3px,transparent 8px);`:'';
        return `<div style="width:100%;height:100%;display:flex;align-items:center;"><div style="width:100%;height:${t}px;background:${dashStyle||bg};${glow}border-radius:${t>4?t/2:0}px;"></div></div>`;
      }
      default:return `<div style="padding:8px;color:#aaa;">[${el.type}]</div>`;
    }
  },

  handleClick(e){
    if(!State.selectedTool){
      if(e.target===document.getElementById('editor-canvas')||e.target===document.getElementById('elements-layer'))this.deselect();
      return;
    }
    const rect=document.getElementById('editor-canvas').getBoundingClientRect();
    const x=Math.round(e.clientX-rect.left-10);
    const y=Math.round(e.clientY-rect.top-10);
    this.placeElement(State.selectedTool,x,y);
  },
  placeElement(type,x,y){
    const def=DEFAULTS[type];if(!def)return;
    History.save();
    const el={id:State.newId(),...def(Math.max(0,x),Math.max(0,y))};
    State.elements.push(el);this.renderEl(el);this.select(el.id);
    this.updateHeight();State.dirty=true;
    // Ghost symmetry preview — defer slightly so DOM is laid out first
    setTimeout(()=>this._maybeShowSymmetryGhost(el),60);
    // Trigger prevision suggestions (delayed)
    setTimeout(()=>Prevision.analyze(el),300);
  },
  _maybeShowSymmetryGhost(el){
    const PAGE_W=1440;
    const elW=typeof el.w==='number'?el.w:300;
    const rawH=typeof el.h==='number'?el.h:0;
    // Use actual rendered height if available, otherwise estimate
    const domEl=document.querySelector(`[data-id="${el.id}"]`);
    const elH=domEl?domEl.offsetHeight:Math.max(rawH,120);
    const SYMM_TYPES=['panel','image','shape','heading','text','codeblock','table'];
    if(!SYMM_TYPES.includes(el.type))return;
    if(elW>=900)return;
    const elCenterX=el.x+elW/2;
    const isOffCenter=Math.abs(elCenterX-(PAGE_W/2))>50;
    if(!isOffCenter)return;
    const mirrorX=PAGE_W-el.x-elW;
    if(mirrorX<0||mirrorX+elW>PAGE_W+50)return;
    const alreadyMirrored=State.elements.some(e=>e!==el&&Math.abs(e.x-mirrorX)<elW*0.5&&Math.abs(e.y-el.y)<80);
    if(alreadyMirrored)return;
    document.getElementById('sym-ghost')?.remove();
    // Inject keyframe style once
    if(!document.getElementById('sym-ghost-style')){
      const st=document.createElement('style');st.id='sym-ghost-style';
      st.textContent=`@keyframes sym-pulse{0%,100%{box-shadow:0 0 0 0 rgba(163,113,247,.5),inset 0 0 20px rgba(163,113,247,.08)}50%{box-shadow:0 0 0 12px rgba(163,113,247,0),inset 0 0 40px rgba(163,113,247,.18)}}`;
      document.head.appendChild(st);
    }
    const canvas=document.getElementById('editor-canvas');if(!canvas)return;
    const ghost=document.createElement('div');
    ghost.id='sym-ghost';
    ghost.style.cssText=`position:absolute;left:${mirrorX}px;top:${el.y}px;width:${elW}px;height:${Math.max(elH,80)}px;border:2.5px dashed rgba(163,113,247,.9);background:rgba(163,113,247,.1);border-radius:10px;pointer-events:auto;cursor:pointer;z-index:9500;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;animation:sym-pulse 1.4s ease-in-out infinite;transition:opacity .4s;`;
    ghost.innerHTML=`<div style="font-size:30px;line-height:1;user-select:none;">⟺</div><div style="color:rgba(163,113,247,.95);font-size:11px;font-weight:700;text-align:center;padding:0 8px;line-height:1.5;user-select:none;">Mirror here?<br/><span style="font-weight:400;opacity:.7;font-size:9px;">Click to place symmetrically</span></div>`;
    const place=()=>{clearTimeout(tid);ghost.style.opacity='0';setTimeout(()=>ghost.remove(),400);Prevision._mirrorEl(el);};
    ghost.addEventListener('click',e=>{e.stopPropagation();place();});
    canvas.appendChild(ghost);
    // Auto-dismiss after 9s
    const tid=setTimeout(()=>{ghost.style.opacity='0';setTimeout(()=>ghost.remove(),400);},9000);
  },
  select(id){
    State.selectedElId=id;
    State.advancedOpen=false;
    document.querySelectorAll('.el').forEach(d=>{
      d.classList.toggle('selected',d.dataset.id===id);
      d.querySelectorAll('.resize-handle').forEach(h=>h.remove());
    });
    const div=document.querySelector(`[data-id="${id}"]`);
    if(div){const el=State.getEl(id);if(el)this.addResizeHandles(div,el);}
    Props.render(id);
  },
  deselect(){
    State.selectedElId=null;
    document.querySelectorAll('.el').forEach(d=>{d.classList.remove('selected');d.querySelectorAll('.resize-handle').forEach(h=>h.remove());});
    Props.renderNone();
  },
  addResizeHandles(div,el){
    for(const h of ['nw','n','ne','e','se','s','sw','w']){
      const hEl=document.createElement('div');
      hEl.className=`resize-handle rh-${h}`;
      hEl.addEventListener('mousedown',e=>{e.stopPropagation();Resize.start(e,el,h);});
      div.appendChild(hEl);
    }
  },
  updateElDOM(el){
    const div=document.querySelector(`[data-id="${el.id}"]`);if(!div)return;
    div.style.left=el.x+'px';div.style.top=el.y+'px';
    if(el.w!=='auto')div.style.width=el.w+'px';
    if(el.h!=='auto')div.style.height=el.h+'px';
    div.style.filter='';div.style.boxShadow='';
    const sf=elShadowFilter(el);
    if(sf){const m=sf.match(/^(filter|box-shadow):(.+);$/);if(m)div.style[m[1]==='filter'?'filter':'boxShadow']=m[2].trim();}
    const handles=[...div.querySelectorAll('.resize-handle')];
    div.innerHTML=this.renderInner(el);
    for(const h of handles)div.appendChild(h);
    this.updateHeight();
  },
  deleteSelected(){
    if(!State.selectedElId)return;
    State.currentPage.elements=State.currentPage.elements.filter(e=>e.id!==State.selectedElId);
    document.querySelector(`[data-id="${State.selectedElId}"]`)?.remove();
    State.selectedElId=null;Props.renderNone();this.updateHeight();State.dirty=true;
  },
  applyBackground(){
    BgLayers.applyToCanvas(State.currentPage);
  },
};

// ── Drag ──────────────────────────────────────────────────────
const Drag={
  active:false,el:null,startX:0,startY:0,origX:0,origY:0,
  start(e,el){
    this.active=true;this.el=el;this.startX=e.clientX;this.startY=e.clientY;this.origX=el.x;this.origY=el.y;
    const div=document.querySelector(`[data-id="${el.id}"]`);
    this.elW=div?div.offsetWidth:(el.w==='auto'?200:el.w);
    this.elH=div?div.offsetHeight:(el.h==='auto'?100:el.h);
    const onMove=ev=>this.move(ev);
    const onUp=()=>{this.active=false;Snap.hideGuides();Canvas.updateHeight();History.save();document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);State.dirty=true;};
    document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
  },
  move(e){
    if(!this.active)return;
    const snapped=Snap.snapPos(this.origX+(e.clientX-this.startX),this.origY+(e.clientY-this.startY),this.elW,this.elH,this.el.id);
    this.el.x=snapped.x;this.el.y=snapped.y;
    const div=document.querySelector(`[data-id="${this.el.id}"]`);
    if(div){div.style.left=this.el.x+'px';div.style.top=this.el.y+'px';}
    Snap.showGuides(snapped.guideH,snapped.guideV);
  },
};

// ── Resize ────────────────────────────────────────────────────
const Resize={
  start(e,el,handle){
    e.preventDefault();
    const sX=e.clientX,sY=e.clientY;
    const origW=el.w==='auto'?document.querySelector(`[data-id="${el.id}"]`).offsetWidth:el.w;
    const origH=el.h==='auto'?document.querySelector(`[data-id="${el.id}"]`).offsetHeight:el.h;
    const origX=el.x,origY=el.y;
    const onMove=ev=>{
      const dx=ev.clientX-sX,dy=ev.clientY-sY;
      if(handle.includes('e'))el.w=Math.max(60,origW+dx);
      if(handle.includes('s'))el.h=Math.max(20,origH+dy);
      if(handle.includes('w')){el.w=Math.max(60,origW-dx);el.x=origX+dx;}
      if(handle.includes('n')){el.h=Math.max(20,origH-dy);el.y=origY+dy;}
      const div=document.querySelector(`[data-id="${el.id}"]`);
      if(div){div.style.width=el.w+'px';div.style.height=el.h+'px';div.style.left=el.x+'px';div.style.top=el.y+'px';}
    };
    const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);Canvas.updateHeight();History.save();State.dirty=true;};
    document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
  },
};

// ── Properties ────────────────────────────────────────────────
const Props={
  render(id){
    const el=State.getEl(id);if(!el)return this.renderNone();
    document.getElementById('props-none').classList.add('hidden');
    const panel=document.getElementById('props-panel');
    panel.classList.remove('hidden');panel.innerHTML=this.buildForm(el);
    if(State.advancedOpen){
      const tog=panel.querySelector('.prop-advanced-toggle');
      if(tog){tog.nextElementSibling.classList.remove('hidden');const a=tog.querySelector('.adv-arrow');if(a)a.textContent='▼';}
    }
  },
  renderNone(){
    document.getElementById('props-none').classList.remove('hidden');
    document.getElementById('props-panel').classList.add('hidden');
  },
  deselectTool(){document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));},

  buildForm(el){
    const p=el.props;
    const typeLabel=el.type.charAt(0).toUpperCase()+el.type.slice(1);
    let primary='',advanced='';

    switch(el.type){
      case 'panel':
        primary+=prop('text','Title',p.title,'title');
        primary+=prop('textarea','Body Text',p.body,'body');
        primary+=propBgPicker(p,false);
        primary+=propColor('Border Color',p.borderColor,'borderColor');
        primary+=propCheck('Drop Shadow',p.shadow,'shadow');
        if(p.shadow) primary+=prop('text','Shadow Color (e.g. rgba(0,0,0,.5))',p.shadowColor||'rgba(0,0,0,0.55)','shadowColor');
        primary+=prop('number','Border Width',p.borderWidth,'borderWidth','1','0','20');
        primary+=propCheck('Hover Scale Effect',p.hoverScale,'hoverScale');
        primary+=this.panelShapePicker(p.shape);
        primary+=`<div class="prop-group"><label class="prop-label">Text Alignment</label>
          <div class="link-mode-row">
            <button class="link-mode-btn${(!p.textAlign||p.textAlign==='left')?' active':''}" onclick="Props.setPropDirect('textAlign','left')">← Left</button>
            <button class="link-mode-btn${p.textAlign==='center'?' active':''}" onclick="Props.setPropDirect('textAlign','center')">Center</button>
            <button class="link-mode-btn${p.textAlign==='right'?' active':''}" onclick="Props.setPropDirect('textAlign','right')">Right →</button>
          </div></div>`;
        primary+=propCheck('Justify text (equal line lengths)',p.justify||false,'justify');
        advanced+=propFontSelect('Title Font',p.titleFont||p.fontFamily,'titleFont');
        advanced+=`<div class="prop-group"><label class="prop-label">Title Style</label><div class="link-mode-row">
          <button class="link-mode-btn${p.titleBold!==false?' active':''}" onclick="Props.setPropDirect('titleBold',!(State.getEl(State.selectedElId).props.titleBold!==false))"><b>B</b></button>
          <button class="link-mode-btn${p.titleItalic?' active':''}" onclick="Props.setPropDirect('titleItalic',!State.getEl(State.selectedElId).props.titleItalic)"><i>I</i></button>
          <button class="link-mode-btn${p.titleUnderline?' active':''}" onclick="Props.setPropDirect('titleUnderline',!State.getEl(State.selectedElId).props.titleUnderline)"><u>U</u></button>
        </div></div>`;
        advanced+=propFontSelect('Body Font',p.fontFamily,'fontFamily');
        advanced+=`<div class="prop-group"><label class="prop-label">Body Style</label><div class="link-mode-row">
          <button class="link-mode-btn${p.bodyBold?' active':''}" onclick="Props.setPropDirect('bodyBold',!State.getEl(State.selectedElId).props.bodyBold)"><b>B</b></button>
          <button class="link-mode-btn${p.bodyItalic?' active':''}" onclick="Props.setPropDirect('bodyItalic',!State.getEl(State.selectedElId).props.bodyItalic)"><i>I</i></button>
          <button class="link-mode-btn${p.bodyUnderline?' active':''}" onclick="Props.setPropDirect('bodyUnderline',!State.getEl(State.selectedElId).props.bodyUnderline)"><u>U</u></button>
        </div></div>`;
        advanced+=prop('number','Title Size',p.titleSize,'titleSize','1','8','72');
        advanced+=propColor('Title Color',p.titleColor,'titleColor');
        advanced+=prop('number','Body Size',p.bodySize,'bodySize','1','8','36');
        advanced+=propColor('Body Color',p.bodyColor,'bodyColor');
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','50');
        advanced+=prop('number','Padding',p.padding,'padding','1','0','60');
        advanced+=this.scrollInUI(p);
        break;

      case 'table':{
        // Per-cell editing
        primary+=this.tableCellSelector(el);
        const editIdx=p.editingCell||0;
        const editCell=p.cells[editIdx]||{};
        primary+=prop('text','Cell Title',editCell.title||'','__cell_title');
        primary+=prop('textarea','Cell Body',editCell.body||'','__cell_body');
        // Per-cell color override
        primary+=`<div class="prop-group"><label class="prop-label">Cell ${editIdx+1} Color Override</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="color" value="${editCell.bgOverride||'#1a1a2e'}" oninput="Props.setCellBgOverride(this.value)" title="Cell background"/>
            ${editCell.bgOverride?`<button class="prop-btn" onclick="Props.clearCellBgOverride()" style="background:rgba(218,54,51,.15);color:#da3633;font-size:10px;">✕ Clear</button>`:'<span style="font-size:10px;color:var(--muted);">Uses global bg</span>'}
          </div></div>`;
        // Border options
        primary+=`<div class="prop-group"><label class="prop-label">Contour Pattern</label>
          <div class="link-mode-row" style="flex-wrap:wrap;">
            <button class="link-mode-btn${!p.contourMode||p.contourMode==='all'?' active':''}" onclick="Props.setPropDirect('contourMode','all')">All Cells</button>
            <button class="link-mode-btn${p.contourMode==='first'?' active':''}" onclick="Props.setPropDirect('contourMode','first')">First Only</button>
            <button class="link-mode-btn${p.contourMode==='none'?' active':''}" onclick="Props.setPropDirect('contourMode','none')">No Border</button>
            <button class="link-mode-btn${p.contourMode==='outer'?' active':''}" onclick="Props.setPropDirect('contourMode','outer')">Outer Only</button>
          </div></div>`;
        primary+=`<div class="prop-sep"></div>`;
        primary+=prop('number','Columns',p.cols,'__table_cols','1','1','6');
        primary+=prop('number','Rows',p.rows,'__table_rows','1','1','8');
        primary+=prop('number','Gap (px)',p.gap,'gap','1','0','40');
        primary+=propCheck('Hover Scale Effect',p.hoverScale,'hoverScale');
        primary+=propCheck('Show Grid Lines',p.showGrid||false,'showGrid');
        primary+=propCheck('Matrix / Rain Background',p.matrixBg||false,'matrixBg');
        advanced+=propFontSelect('Font',p.fontFamily,'fontFamily');
        advanced+=this.tableBgPicker(p);
        advanced+=propColor('Cell Border',p.cellBorder,'cellBorder');
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','30');
        advanced+=prop('number','Padding',p.padding,'padding','1','0','40');
        advanced+=prop('number','Title Size',p.titleSize,'titleSize','1','8','36');
        advanced+=propColor('Title Color',p.titleColor,'titleColor');
        advanced+=prop('number','Body Size',p.bodySize,'bodySize','1','8','24');
        advanced+=propColor('Body Color',p.bodyColor,'bodyColor');
        advanced+=this.scrollInUI(p);
        break;
      }

      case 'heading':
        primary+=prop('text','Text',p.text,'text');
        primary+=propSelect('Level',p.level,'level',['h1','h2','h3','h4']);
        primary+=propSelect('Align',p.align,'align',['left','center','right']);
        primary+=propColor('Color',p.color,'color');
        primary+=propFontSelect('Font',p.fontFamily,'fontFamily');
        advanced+=prop('number','Font Size',p.fontSize,'fontSize','1','8','120');
        advanced+=propSelect('Weight',p.fontWeight,'fontWeight',['400','600','700','800','900']);
        advanced+=`<div class="prop-group"><label class="prop-label">Style</label><div class="link-mode-row">
          <button class="link-mode-btn${p.italic?' active':''}" onclick="Props.setPropDirect('italic',!State.getEl(State.selectedElId).props.italic)"><i>I</i></button>
          <button class="link-mode-btn${p.underline?' active':''}" onclick="Props.setPropDirect('underline',!State.getEl(State.selectedElId).props.underline)"><u>U</u></button>
        </div></div>`;
        advanced+=prop('number','Letter Spacing',p.letterSpacing,'letterSpacing','0.5','-5','20');
        break;

      case 'text':
        primary+=prop('textarea','Text',p.text,'text');
        primary+=propSelect('Align',p.align,'align',['left','center','right','justify']);
        primary+=propColor('Color',p.color,'color');
        primary+=propFontSelect('Font',p.fontFamily,'fontFamily');
        primary+=`<div class="prop-group"><label class="prop-label">Style</label><div class="link-mode-row">
          <button class="link-mode-btn${p.bold?' active':''}" onclick="Props.setPropDirect('bold',!State.getEl(State.selectedElId).props.bold)"><b>B</b></button>
          <button class="link-mode-btn${p.italic?' active':''}" onclick="Props.setPropDirect('italic',!State.getEl(State.selectedElId).props.italic)"><i>I</i></button>
          <button class="link-mode-btn${p.underline?' active':''}" onclick="Props.setPropDirect('underline',!State.getEl(State.selectedElId).props.underline)"><u>U</u></button>
        </div></div>`;
        advanced+=prop('number','Font Size',p.fontSize,'fontSize','1','8','72');
        advanced+=prop('number','Line Height',p.lineHeight,'lineHeight','0.1','1','3');
        break;

      case 'image':
        primary+=`<div class="prop-group"><button class="prop-btn" onclick="Props.chooseImage()">🖼 Choose Image</button></div>`;
        primary+=prop('text','Alt Text',p.alt,'alt');
        primary+=`<div class="prop-group"><label class="prop-label">Object Fit <span style="font-weight:400;font-size:10px;color:var(--muted);">— how image fills its frame</span></label>
          <select class="prop-select" onchange="Props.setProp(event,'objectFit')">
            <option value="cover"${p.objectFit==='cover'?' selected':''}>Cover – fills frame, crops excess</option>
            <option value="contain"${p.objectFit==='contain'?' selected':''}>Contain – fits inside, may show gaps</option>
            <option value="fill"${p.objectFit==='fill'?' selected':''}>Fill – stretches to fill (may distort)</option>
            <option value="none"${p.objectFit==='none'?' selected':''}>None – original size, no scaling</option>
          </select></div>`;
        {
          const px=p.imgPosX!=null?p.imgPosX:50;
          const py=p.imgPosY!=null?p.imgPosY:50;
          const pz=p.imgZoom!=null?p.imgZoom:1;
          primary+=`<div class="prop-group"><label class="prop-label">Pan &amp; Zoom within frame</label>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;">
              <label style="font-size:10px;color:var(--muted);min-width:14px;">◁▷</label>
              <input type="range" min="0" max="100" value="${px}" style="flex:1;"
                oninput="Props.setProp(event,'imgPosX');this.nextElementSibling.textContent=this.value+'%'"/>
              <span style="font-size:10px;color:var(--muted);min-width:30px;">${px}%</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;">
              <label style="font-size:10px;color:var(--muted);min-width:14px;">△▽</label>
              <input type="range" min="0" max="100" value="${py}" style="flex:1;"
                oninput="Props.setProp(event,'imgPosY');this.nextElementSibling.textContent=this.value+'%'"/>
              <span style="font-size:10px;color:var(--muted);min-width:30px;">${py}%</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <label style="font-size:10px;color:var(--muted);min-width:14px;">⊕</label>
              <input type="range" min="1" max="5" step="0.05" value="${pz}" style="flex:1;"
                oninput="Props.setProp(event,'imgZoom');this.nextElementSibling.textContent=parseFloat(this.value).toFixed(2)+'×'"/>
              <span style="font-size:10px;color:var(--muted);min-width:36px;">${parseFloat(pz).toFixed(2)}×</span>
            </div>
          </div>`;
          primary+=propCheck('🔍 Zoom in on hover (approach effect)',p.hoverZoom||false,'hoverZoom');
        }
        primary+=this.imageShapePicker(p.imageShape||'none');
        advanced+=prop('number','Border Radius (px)',p.borderRadius,'borderRadius','1','0','200');
        advanced+=propCheck('Show Border',p.border,'border');
        if(p.border){
          advanced+=propColor('Border Color',p.borderColor,'borderColor');
          advanced+=prop('number','Border Width (px)',p.borderWidth||2,'borderWidth','1','1','20');
        }
        advanced+=propCheck('Drop Shadow',p.shadow||false,'shadow');
        advanced+=this.scrollInUI(p);
        break;

      case 'divider':
        primary+=propColor('Color',p.color,'color');
        primary+=propSelect('Style',p.style,'style',['solid','dashed','dotted','double']);
        advanced+=prop('number','Thickness',p.thickness,'thickness','1','1','20');
        advanced+=prop('number','Vertical Margin',p.marginV,'marginV','1','0','60');
        break;

      case 'button':
        primary+=prop('text','Label',p.label,'label');
        primary+=this.buttonLinkUI(p);
        primary+=propBgPicker(p,true);
        primary+=propColor('Text Color',p.textColor,'textColor');
        advanced+=propFontSelect('Font',p.fontFamily,'fontFamily');
        advanced+=propSelect('Open in',p.target,'target',['_self','_blank']);
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','50');
        advanced+=prop('number','Font Size',p.fontSize,'fontSize','1','8','36');
        advanced+=prop('number','Pad H',p.paddingH,'paddingH','1','0','80');
        advanced+=prop('number','Pad V',p.paddingV,'paddingV','1','0','40');
        advanced+=propCheck('Drop Shadow',p.shadow||false,'shadow');
        advanced+=`<div class="prop-group"><label class="prop-label">Style</label><div class="link-mode-row">
          <button class="link-mode-btn${p.bold?' active':''}" onclick="Props.setPropDirect('bold',!State.getEl(State.selectedElId).props.bold)"><b>B</b></button>
          <button class="link-mode-btn${p.italic?' active':''}" onclick="Props.setPropDirect('italic',!State.getEl(State.selectedElId).props.italic)"><i>I</i></button>
          <button class="link-mode-btn${p.underline?' active':''}" onclick="Props.setPropDirect('underline',!State.getEl(State.selectedElId).props.underline)"><u>U</u></button>
        </div></div>`;
        break;

      case 'navbar':
        primary+=prop('text','Brand Name',p.brand,'brand');
        primary+=propBgPicker(p,false);
        primary+=propColor('Text Color',p.textColor,'textColor');
        // Structured nav links editor — each link can target a section OR a page
        {
          const nlinks=p.navLinks||[];
          const sections=State.currentPage?.elements.filter(e=>e.type==='section').map(e=>e.props.name)||[];
          const pages=State.project.pages.filter(pg=>pg.id!==State.currentPage?.id);
          let linksHtml=`<div class="prop-group"><label class="prop-label">Nav Links <span style="font-weight:400;font-size:9px;color:var(--muted);">— each links to a section OR another page</span></label>
            <p class="props-hint" style="margin-bottom:6px;">⚠ Links with no destination appear greyed-out. Always connect each link to a section or page.</p>`;
          nlinks.forEach((lk,i)=>{
            const secOpts=`<option value="">— section —</option>`+sections.map(s=>`<option value="${escHtml(s)}"${lk.target===s?' selected':''}>#${escHtml(s)}</option>`).join('');
            const pageOpts=`<option value="">— page —</option>`+pages.map(pg=>`<option value="${escHtml(pg.name)}"${lk.pageTarget===pg.name?' selected':''}>↗ ${escHtml(pg.name)}</option>`).join('');
            const linked=lk.target||lk.pageTarget;
            linksHtml+=`<div style="border:1px solid ${linked?'rgba(63,185,80,.2)':'rgba(218,54,51,.3)'};border-radius:5px;padding:6px 8px;margin-bottom:5px;background:${linked?'rgba(63,185,80,.04)':'rgba(218,54,51,.05)'};">
              <input class="prop-input" style="width:100%;margin-bottom:4px;" value="${escHtml(lk.label)}" placeholder="Link label" oninput="Props.setNavLink(${i},'label',this.value)"/>
              <div style="display:flex;gap:4px;">
                <select class="prop-select" style="flex:1;font-size:10px;" onchange="Props.setNavLinkSection(${i},this.value)" title="Scroll to section on this page">${secOpts}</select>
                <select class="prop-select" style="flex:1;font-size:10px;" onchange="Props.setNavLinkPage(${i},this.value)" title="Navigate to another page">${pageOpts}</select>
                <button class="prop-btn" style="width:24px;padding:0;flex-shrink:0;background:rgba(218,54,51,.15);color:#da3633;" onclick="Props.removeNavLink(${i})">✕</button>
              </div>
            </div>`;
          });
          linksHtml+=`<button class="prop-btn" onclick="Props.addNavLink()" style="margin-top:2px;width:100%;">+ Add Link</button></div>`;
          primary+=linksHtml;
        }
        advanced+=propCheck('Full viewport width',p.fullWidth!==false,'fullWidth');
        advanced+=propCheck('Sticky (stays at top)',p.sticky,'sticky');
        advanced+=propFontSelect('Font',p.fontFamily,'fontFamily');
        break;

      case 'contact':
        primary+=prop('text','Title',p.title,'title');
        primary+=prop('text','Recipient Email',p.email,'email');
        primary+=propColor('Text / Label Color',p.textColor||'#e6edf3','textColor');
        primary+=propColor('Input Background',p.inputBg||'rgba(0,0,0,0.35)','inputBg');
        primary+=propColor('Button Color',p.btnColor,'btnColor');
        primary+=propColor('Button Text Color',p.btnTextColor||'#ffffff','btnTextColor');
        primary+=prop('text','Button Label',p.btnLabel,'btnLabel');
        advanced+=propBgPicker(p,false);
        advanced+=propColor('Border',p.borderColor,'borderColor');
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','50');
        break;

      case 'section':
        primary+=prop('text','Section ID',p.name,'name');
        primary+=`<p class="props-hint" style="background:rgba(109,63,207,.08);border-left:3px solid #6d3fcf;padding:7px 10px;border-radius:0 5px 5px 0;margin-top:4px;">
          ⚠️ <strong>Invisible element.</strong> It marks a scroll target on your page.<br/>
          Use <code>#${escHtml(p.name)}</code> as a button href or navbar link to scroll here.</p>`;
        break;

      case 'spacer':
        primary+=prop('number','Height (px)',p.height,'height','4','0','2000');
        primary+=`<p class="props-hint" style="background:rgba(109,63,207,.08);border-left:3px solid #6d3fcf;padding:7px 10px;border-radius:0 5px 5px 0;margin-top:4px;">⚠️ <strong>Invisible element.</strong> Adds blank vertical space between other elements.</p>`;
        break;

      case 'shape':
        primary+=propSelect('Shape',p.form,'form',['rectangle','circle','triangle','parallelogram','hexagon']);
        primary+=propBgPicker(p,false);
        primary+=propColor('Border Color',p.borderColor,'borderColor');
        primary+=propCheck('Drop Shadow',p.shadow||false,'shadow');
        advanced+=prop('number','Border Width',p.borderWidth,'borderWidth','1','0','20');
        advanced+=prop('number','Corner Radius',p.borderRadius,'borderRadius','1','0','200');
        advanced+=prop('number','Opacity',p.opacity,'opacity','0.05','0','1');
        advanced+=this.scrollInUI(p);
        break;

      case 'codeblock':
        primary+=prop('textarea','Code',p.code,'code');
        primary+=propBgPicker(p,false);
        primary+=propColor('Text Color',p.textColor,'textColor');
        advanced+=propFontSelect('Font',p.fontFamily,'fontFamily');
        advanced+=prop('number','Font Size',p.fontSize,'fontSize','1','8','24');
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','20');
        break;

      case 'folderpanel':{
        const slides=p.slides||[];
        const si=Math.min(p.editingSlide||0,slides.length-1);
        const cs=slides[si]||{};
        // Slide selector
        let slideSelector='<div class="prop-group"><label class="prop-label">Slides <span style="font-size:10px;font-weight:400;color:var(--muted);">(click to edit)</span></label><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
        slides.forEach((_,i)=>{slideSelector+=`<button class="link-mode-btn${i===si?' active':''}" onclick="Props.selectFolderSlide(${i})">Slide ${i+1}</button>`;});
        slideSelector+=`</div>
          <div style="display:flex;gap:4px;">
            <button class="prop-btn" onclick="Props.addFolderSlide()" style="flex:1;">+ Add Slide</button>
            ${slides.length>1?`<button class="prop-btn" onclick="Props.removeFolderSlide(${si})" style="flex:1;background:rgba(218,54,51,.15);color:#da3633;">✕ Remove</button>`:''}
          </div></div>`;
        primary+=slideSelector;
        primary+=prop('text','Slide Title',cs.title||'','__fp_title');
        primary+=prop('textarea','Slide Body',cs.body||'','__fp_body');
        primary+=`<div class="prop-group"><label class="prop-label">Slide Background</label>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
            <input type="color" value="${(cs.bgColor||'#1a1a2e').startsWith('#')?cs.bgColor||'#1a1a2e':'#1a1a2e'}" oninput="Props.setFolderSlideProp('bgColor',this.value)" title="Slide color"/>
            <button class="prop-btn" onclick="Props.chooseFolderSlideImage()">🖼 Photo</button>
            ${cs.bgImage?'<span style="font-size:10px;color:var(--muted);">✓ Photo set</span>':''}
            ${cs.bgImage?`<button class="prop-btn" onclick="Props.setFolderSlideProp('bgImage','')" style="background:rgba(218,54,51,.15);color:#da3633;">✕</button>`:''}
          </div></div>`;
        advanced+=propColor('Text Color (all slides)',p.titleColor,'titleColor');
        advanced+=propColor('Body Color (all slides)',p.bodyColor,'bodyColor');
        advanced+=prop('number','Title Size',p.titleSize,'titleSize','1','12','80');
        advanced+=prop('number','Body Size',p.bodySize,'bodySize','1','8','36');
        advanced+=propSelect('Text Align',p.textAlign||'center','textAlign',['left','center','right']);
        advanced+=propColor('Overlay Color (rgba)',p.overlayColor||'rgba(0,0,0,0.35)','overlayColor');
        advanced+=prop('number','Panel Height (px)',el.h||500,'__h','10','200','2000');
        advanced+=prop('number','Start Width % (100=full, 60=pop-in)',p.startWidth!=null?p.startWidth:100,'startWidth','1','20','100');
        advanced+=prop('number','Border Radius',p.borderRadius,'borderRadius','1','0','40');
        break;
      }

      case 'hscroll':{
        // Per-item editor
        const items=p.items||[];
        const ei=Math.min(p._editingItem||0,items.length-1);
        const ci=items[ei]||{};
        let itemNav='<div class="prop-group"><label class="prop-label">Cards <span style="font-size:10px;font-weight:400;color:var(--muted);">(click to edit)</span></label><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px;">';
        items.forEach((_,i)=>{itemNav+=`<button class="link-mode-btn${i===ei?' active':''}" onclick="Props.setHScrollItem(${i})">Card ${i+1}</button>`;});
        itemNav+=`</div><div style="display:flex;gap:4px;">
          <button class="prop-btn" onclick="Props.addHScrollItem()" style="flex:1;">+ Add Card</button>
          ${items.length>1?`<button class="prop-btn" onclick="Props.removeHScrollItem(${ei})" style="flex:1;background:rgba(218,54,51,.15);color:#da3633;">✕ Remove</button>`:''}
        </div></div>`;
        primary+=itemNav;
        primary+=prop('text','Card Title',ci.title||'','__hs_title');
        primary+=prop('textarea','Card Body',ci.body||'','__hs_body');
        primary+=`<div class="prop-group"><label class="prop-label">Card Image URL</label>
          <input class="prop-input" type="text" value="${ci.src||''}" placeholder="https://… or leave empty" oninput="Props.setHScrollItemSrc(this.value)"/>
        </div>`;
        advanced+=propColor('Card Background',p.cardBg,'cardBg');
        advanced+=propColor('Border Color',p.borderColor,'borderColor');
        advanced+=propColor('Title Color',p.titleColor,'titleColor');
        advanced+=propColor('Body Color',p.bodyColor,'bodyColor');
        advanced+=prop('number','Card Width (px)',p.itemW||260,'itemW','10','100','800');
        advanced+=prop('number','Gap (px)',p.gap||16,'gap','2','0','60');
        advanced+=prop('number','Title Size',p.titleSize||15,'titleSize','1','8','40');
        advanced+=prop('number','Body Size',p.bodySize||12,'bodySize','1','8','30');
        advanced+=prop('number','Padding',p.padding||14,'padding','1','0','60');
        advanced+=prop('number','Border Radius',p.borderRadius||10,'borderRadius','1','0','40');
        advanced+=propCheck('Show Arrow Hint',p.showArrows!==false,'showArrows');
        advanced+=this.scrollInUI(p);
        break;
      }

      case 'collage':{
        const imgs=p.images||[];
        const ci2=Math.min(p._editImg||0,imgs.length-1);
        const curImg=imgs[ci2]||{};
        let imgNav='<div class="prop-group"><label class="prop-label">Photos <span style="font-size:10px;font-weight:400;color:var(--muted);">(click to edit)</span></label><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px;">';
        imgs.forEach((_,i)=>{imgNav+=`<button class="link-mode-btn${i===ci2?' active':''}" onclick="Props.setCollageImg(${i})">Img ${i+1}</button>`;});
        imgNav+=`</div><div style="display:flex;gap:4px;">
          <button class="prop-btn" onclick="Props.addCollageImg()" style="flex:1;">+ Add Photo</button>
          ${imgs.length>1?`<button class="prop-btn" onclick="Props.removeCollageImg(${ci2})" style="flex:1;background:rgba(218,54,51,.15);color:#da3633;">✕ Remove</button>`:''}
        </div></div>`;
        primary+=imgNav;
        primary+=`<div class="prop-group"><label class="prop-label">Image URL</label>
          <input class="prop-input" type="text" value="${curImg.src||''}" placeholder="https://… (Unsplash, Picsum, etc.)" oninput="Props.setCollageImgSrc(this.value)"/>
        </div>`;
        primary+=prop('text','Alt Text',curImg.alt||'','__coll_alt');
        advanced+=prop('number','Columns',p.cols||3,'cols','1','1','6');
        advanced+=prop('number','Gap (px)',p.gap||8,'gap','1','0','40');
        advanced+=prop('number','Border Radius',p.borderRadius||6,'borderRadius','1','0','40');
        advanced+=propSelect('Hover Effect',p.hoverEffect||'zoom','hoverEffect',['zoom','none','darken']);
        advanced+=propSelect('Object Fit',p.objectFit||'cover','objectFit',['cover','contain','fill']);
        advanced+=this.scrollInUI(p);
        break;
      }

      case 'line':
        primary+=`<div class="prop-group"><label class="prop-label">Orientation</label>
          <div class="link-mode-row">
            <button class="link-mode-btn${p.orientation!=='vertical'?' active':''}" onclick="Props.setPropDirect('orientation','horizontal')">— Horizontal</button>
            <button class="link-mode-btn${p.orientation==='vertical'?' active':''}" onclick="Props.setPropDirect('orientation','vertical')">| Vertical</button>
          </div></div>`;
        primary+=propColor('Line Color',p.color||'rgba(255,255,255,0.25)','color');
        primary+=propSelect('Style',p.style||'solid','style',['solid','dashed','dotted','double']);
        primary+=prop('number','Thickness (px)',p.thickness||2,'thickness','1','1','20');
        primary+=propCheck('Gradient Fade',p.gradient||false,'gradient');
        if(p.gradient){
          primary+=propColor('Gradient End Color',p.gradientB||'rgba(255,255,255,0)','gradientB');
          primary+=propSelect('Gradient Direction',p.gradientDir||'to right','gradientDir',['to right','to left','to bottom','to top']);
        }
        advanced+=propColor('Glow Color (leave empty for none)',p.glowColor||'','glowColor');
        advanced+=this.scrollInUI(p);
        break;
    }

    const posSize=`
      <div class="prop-row">
        <div class="prop-group"><label class="prop-label">X</label><input class="prop-input" type="number" value="${el.x}" oninput="Props.setProp(event,'__x')"/></div>
        <div class="prop-group"><label class="prop-label">Y</label><input class="prop-input" type="number" value="${el.y}" oninput="Props.setProp(event,'__y')"/></div>
      </div>
      <div class="prop-row">
        <div class="prop-group"><label class="prop-label">W</label><input class="prop-input" type="number" value="${el.w==='auto'?'':el.w}" placeholder="auto" oninput="Props.setProp(event,'__w')"/></div>
        <div class="prop-group"><label class="prop-label">H</label><input class="prop-input" type="number" value="${el.h==='auto'?'':el.h}" placeholder="auto" oninput="Props.setProp(event,'__h')"/></div>
      </div>`;

    const advBlock=`<div class="prop-advanced-toggle" onclick="Props.toggleAdvanced(this)"><span class="adv-arrow">▶</span> Advanced</div>
      <div class="prop-advanced-body hidden">${advanced}<div class="prop-sep"></div><div class="prop-section-label">Position &amp; Size</div>${posSize}</div>`;

    return `<div class="prop-type-badge">${typeLabel}</div>${primary}${advBlock}
      <div class="prop-sep"></div>
      <button class="prop-btn prop-btn-danger" onclick="Canvas.deleteSelected()">🗑 Delete</button>`;
  },

  // ── Panel shape picker ──
  panelShapePicker(current){
    const btns=PANEL_SHAPES.map(s=>`
      <div class="shape-opt${s.id===(current||'normal')?' active':''}" onclick="Props.setProp({target:{type:'text',value:'${s.id}'}},'shape')" title="${s.label}">
        <span class="shape-preview">${s.icon}</span>${s.label}
      </div>`).join('');
    return `<div class="prop-group"><label class="prop-label">Panel Shape</label><div class="shape-grid">${btns}</div></div>`;
  },

  // ── Image shape picker ──
  imageShapePicker(current){
    const btns=IMAGE_SHAPES.map(s=>`
      <div class="shape-opt${s.id===(current||'none')?' active':''}" onclick="Props.setProp({target:{type:'text',value:'${s.id}'}},'imageShape')" title="${s.label}">
        <span class="shape-preview">${s.icon}</span>${s.label}
      </div>`).join('');
    return `<div class="prop-group"><label class="prop-label">Canvas Shape</label><div class="shape-grid">${btns}</div></div>`;
  },

  // ── Button link mode UI ──
  buttonLinkUI(p){
    const mode=p.linkMode||'url';
    const pages=State.project.pages.filter(pg=>pg.id!==State.currentPage?.id);
    const sections=State.elements.filter(e=>e.type==='section').map(e=>e.props.name);

    const tabs=`<div class="link-mode-row">
      <button class="link-mode-btn${mode==='url'?' active':''}"     onclick="Props.setLinkMode('url')">URL</button>
      <button class="link-mode-btn${mode==='page'?' active':''}"    onclick="Props.setLinkMode('page')">Page</button>
      <button class="link-mode-btn${mode==='section'?' active':''}" onclick="Props.setLinkMode('section')">Section</button>
    </div>`;

    let body='';
    if(mode==='url'){
      const urlVal=(p.href||'').replace(/^#+/,'');// strip any stray # before displaying
      body=`<div class="prop-group"><label class="prop-label">Web Address</label>
        <input class="prop-input" type="text" value="${escHtml(urlVal)}" placeholder="https://example.com or mailto:you@x.com"
          oninput="Props.setUrl(this.value)"/>
        <p class="props-hint" style="margin-top:3px;color:var(--muted);font-size:10px;">External links open in a new tab. Use <code>mailto:</code> for email.</p>
      </div>`;
    } else if(mode==='page'){
      if(pages.length===0){
        body=`<p class="props-hint" style="color:#c94a28;">Add more pages to your project first.</p>`;
      } else {
        const opts=pages.map(pg=>`<option value="${escHtml(pg.name)}"${p.pageTarget===pg.name?' selected':''}>${escHtml(pg.name)}</option>`).join('');
        body=`<div class="prop-group"><label class="prop-label">Go to Page</label><select class="prop-select" onchange="Props.setProp(event,'pageTarget')">${opts}</select></div>`;
      }
    } else {
      if(sections.length===0){
        body=`<p class="props-hint" style="color:#c94a28;">Add a Section anchor element to the page first, then link to it here.</p>`;
      } else {
        const opts=sections.map(n=>`<option value="${escHtml(n)}"${p.sectionTarget===n?' selected':''}>${escHtml(n)}</option>`).join('');
        body=`<div class="prop-group"><label class="prop-label">Scroll to Section</label><select class="prop-select" onchange="Props.setProp(event,'sectionTarget')">${opts}</select></div>`;
      }
    }
    return `<div class="prop-group"><label class="prop-label">Link Destination</label>${tabs}${body}</div>`;
  },

  setUrl(raw){
    const el=State.getEl(State.selectedElId);if(!el)return;
    let val=raw.trim();
    // Strip any leading # that precedes a protocol — e.g. #https://... → https://...
    if(val.startsWith('#')) val=val.replace(/^#+/,'');
    el.props.href=val;
    Canvas.updateElDOM(el);State.dirty=true;
    Props.render(el.id);
  },

  setLinkMode(mode){
    const el=State.getEl(State.selectedElId);if(!el)return;
    el.props.linkMode=mode;
    // Auto-populate target with first available option so button works immediately
    if(mode==='page'){
      const otherPages=State.project.pages.filter(pg=>pg.id!==State.currentPage?.id);
      if(otherPages.length>0&&!el.props.pageTarget) el.props.pageTarget=otherPages[0].name;
    } else if(mode==='section'){
      const sections=State.elements.filter(e=>e.type==='section').map(e=>e.props.name);
      if(sections.length>0&&!el.props.sectionTarget) el.props.sectionTarget=sections[0];
    }
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },

  // ── Table cell selector ──
  tableCellSelector(el){
    const p=el.props;const current=p.editingCell||0;
    let btns='';
    for(let i=0;i<(p.cols*p.rows);i++)
      btns+=`<button class="cell-btn${i===current?' active':''}" onclick="Props.selectCell(${i})">${i+1}</button>`;
    return `<div class="prop-group"><label class="prop-label">Editing Cell</label><div class="cell-selector">${btns}</div></div>`;
  },

  selectCell(index){
    const el=State.getEl(State.selectedElId);if(!el||el.type!=='table')return;
    el.props.editingCell=index;Canvas.updateElDOM(el);Props.render(el.id);
  },

  setCellBgOverride(color){
    const el=State.getEl(State.selectedElId);if(!el||el.type!=='table')return;
    const ci=el.props.editingCell||0;
    if(el.props.cells[ci]){el.props.cells[ci].bgOverride=color;Canvas.updateElDOM(el);State.dirty=true;Props.render(el.id);}
  },
  clearCellBgOverride(){
    const el=State.getEl(State.selectedElId);if(!el||el.type!=='table')return;
    const ci=el.props.editingCell||0;
    if(el.props.cells[ci]){delete el.props.cells[ci].bgOverride;Canvas.updateElDOM(el);State.dirty=true;Props.render(el.id);}
  },

  toggleAdvanced(toggleEl){
    const body=toggleEl.nextElementSibling;
    const arrow=toggleEl.querySelector('.adv-arrow');
    const isHidden=body.classList.toggle('hidden');
    arrow.textContent=isHidden?'▶':'▼';
    State.advancedOpen=!isHidden;
  },

  setNavLink(i,field,val){
    const el=State.getEl(State.selectedElId); if(!el) return;
    if(!el.props.navLinks) el.props.navLinks=[];
    el.props.navLinks[i][field]=val;
    Canvas.updateElDOM(el); State.dirty=true;
  },
  setNavLinkSection(i,val){
    const el=State.getEl(State.selectedElId); if(!el) return;
    if(!el.props.navLinks) el.props.navLinks=[];
    el.props.navLinks[i].target=val;
    if(val) el.props.navLinks[i].pageTarget=''; // clear page if section set
    Canvas.updateElDOM(el); State.dirty=true; Props.render(el.id);
  },
  setNavLinkPage(i,val){
    const el=State.getEl(State.selectedElId); if(!el) return;
    if(!el.props.navLinks) el.props.navLinks=[];
    el.props.navLinks[i].pageTarget=val;
    if(val) el.props.navLinks[i].target=''; // clear section if page set
    Canvas.updateElDOM(el); State.dirty=true; Props.render(el.id);
  },
  addNavLink(){
    const el=State.getEl(State.selectedElId); if(!el) return;
    if(!el.props.navLinks) el.props.navLinks=[];
    el.props.navLinks.push({label:'New Link',target:''});
    Canvas.updateElDOM(el); State.dirty=true; Props.render(el.id);
  },
  removeNavLink(i){
    const el=State.getEl(State.selectedElId); if(!el) return;
    el.props.navLinks.splice(i,1);
    Canvas.updateElDOM(el); State.dirty=true; Props.render(el.id);
  },
  setPropDirect(key,val){
    const el=State.getEl(State.selectedElId);if(!el)return;
    el.props[key]=val;
    Canvas.updateElDOM(el);State.dirty=true;
    Props.render(el.id); // re-render props to update button active states
  },
  setProp(event,key){
    const el=State.getEl(State.selectedElId);if(!el)return;
    const val=event.target.type==='checkbox'?event.target.checked
             :event.target.type==='number'?(parseFloat(event.target.value)||0)
             :event.target.value;
    if     (key==='__x')el.x=parseInt(val)||0;
    else if(key==='__y')el.y=parseInt(val)||0;
    else if(key==='__w')el.w=val===''?'auto':parseInt(val)||'auto';
    else if(key==='__h')el.h=val===''?'auto':parseInt(val)||'auto';
    else if(key==='__cell_title'){const ci=el.props.editingCell||0;if(el.props.cells[ci])el.props.cells[ci].title=val;}
    else if(key==='__cell_body') {const ci=el.props.editingCell||0;if(el.props.cells[ci])el.props.cells[ci].body=val;}
    else if(key==='__fp_title'){const si=el.props.editingSlide||0;if(el.props.slides[si])el.props.slides[si].title=val;}
    else if(key==='__fp_body') {const si=el.props.editingSlide||0;if(el.props.slides[si])el.props.slides[si].body=val;}
    else if(key==='__table_cols'){
      const nc=Math.max(1,Math.min(6,parseInt(val)||1));el.props.cols=nc;
      const needed=nc*el.props.rows;
      while(el.props.cells.length<needed)el.props.cells.push({title:`Cell ${el.props.cells.length+1}`,body:'Content here.'});
      el.props.cells.length=needed;
    }
    else if(key==='__table_rows'){
      const nr=Math.max(1,Math.min(8,parseInt(val)||1));el.props.rows=nr;
      const needed=el.props.cols*nr;
      while(el.props.cells.length<needed)el.props.cells.push({title:`Cell ${el.props.cells.length+1}`,body:'Content here.'});
      el.props.cells.length=needed;
    }
    else el.props[key]=val;
    if(el.type==='spacer'&&key==='height')el.h=parseInt(val)||60;
    if(key==='imageShape'&&IMAGE_SQUARE_SHAPES.has(val)){
      // force square so circle/diamond/etc. look correct
      const side=el.w!=='auto'?el.w:(el.h!=='auto'?el.h:240);
      el.w=side; el.h=side;
    }
    if(key==='shape' && el.type==='panel'){
      // Set textAlign BEFORE updateElDOM so it renders correctly immediately
      el.props.textAlign=val!=='normal'?'center':'left';
      // For compact shapes (diamond, circle, hexagon), force a square-ish fixed size
      if(['diamond','circle','hexagon'].includes(val)){
        const side=Math.max(el.w==='auto'?320:el.w, 200);
        el.w=side; el.h=side;
      } else if(val==='normal'){
        el.h='auto';
      }
    }
    Canvas.updateElDOM(el);State.dirty=true;
    if(key==='shape'){
      Props.render(el.id);
    } else if(key==='__table_cols'||key==='__table_rows') Props.render(el.id);
  },

  async chooseImage(){
    const el=State.getEl(State.selectedElId);if(!el)return;
    try{const dataUri=await Tauri.openImage();el.props.src=dataUri;Canvas.updateElDOM(el);}
    catch(err){if(!String(err).includes('Cancelled'))alert('Could not load image: '+err);}
  },

  async chooseBgImage(){
    const el=State.getEl(State.selectedElId);if(!el)return;
    try{const d=await Tauri.openImage();el.props.bgImage=d;el.props.bgMode='image';Canvas.updateElDOM(el);Props.render(el.id);}
    catch(err){if(!String(err).includes('Cancelled'))alert('Could not load image: '+err);}
  },

  // ── Scroll-in appearance effect UI ──
  scrollInUI(p){
    const on=p.scrollIn||false;
    const type=p.scrollInType||'scale';
    const delay=p.scrollInDelay||0;
    const speed=p.scrollInSpeed!=null?p.scrollInSpeed:0.75;
    const types={
      'scale':'↔ Scale up','fade':'◌ Fade in','slide-up':'↑ Slide up',
      'slide-left':'← Slide left','slide-right':'→ Slide right',
      'blur':'⊙ Blur in','splash':'💥 Splash bounce','vibrate':'〰 Vibrate',
      'shrink-bounce':'⬇ Shrink bounce','flip-x':'↻ Flip horizontal',
      'flip-y':'↑↓ Flip vertical','rotate-in':'↺ Rotate in',
    };
    const typeOpts=Object.entries(types).map(([v,l])=>`<option value="${v}"${v===type?' selected':''}>${l}</option>`).join('');
    return `<div class="prop-group"><label class="prop-label" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;">✨ Scroll-in Effect</label>
      <label class="prop-check-row"><input type="checkbox" ${on?'checked':''} onchange="Props.setPropDirect('scrollIn',this.checked)"/> Enable on scroll</label>
      ${on?`<select class="prop-select" style="margin-top:4px;" onchange="Props.setProp(event,'scrollInType')">${typeOpts}</select>
      <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
        <label style="font-size:10px;color:var(--muted);">Speed (s)</label>
        <input class="prop-input" type="number" value="${speed}" min="0.1" max="5" step="0.05" style="width:60px;" oninput="Props.setProp(event,'scrollInSpeed')"/>
        <label style="font-size:10px;color:var(--muted);">Delay (s)</label>
        <input class="prop-input" type="number" value="${delay}" min="0" max="5" step="0.1" style="width:60px;" oninput="Props.setProp(event,'scrollInDelay')"/>
      </div>`:''}
    </div>`;
  },

  // ── Folder Panel methods ──
  selectFolderSlide(i){
    const el=State.getEl(State.selectedElId);if(!el)return;
    el.props.editingSlide=i;Canvas.updateElDOM(el);Props.render(el.id);
  },
  addFolderSlide(){
    const el=State.getEl(State.selectedElId);if(!el)return;
    const colors=['#1a1a2e','#16213e','#0d1b2a','#1b1b2f','#162447'];
    const i=el.props.slides.length;
    el.props.slides.push({title:'New Slide',body:'',bgImage:'',bgColor:colors[i%colors.length]});
    el.props.editingSlide=i;Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  removeFolderSlide(i){
    const el=State.getEl(State.selectedElId);if(!el||el.props.slides.length<=1)return;
    el.props.slides.splice(i,1);
    el.props.editingSlide=Math.min(i,el.props.slides.length-1);
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  setFolderSlideProp(key,val){
    const el=State.getEl(State.selectedElId);if(!el)return;
    const si=el.props.editingSlide||0;
    if(!el.props.slides[si])return;
    el.props.slides[si][key]=val;Canvas.updateElDOM(el);State.dirty=true;
    if(key==='bgImage')Props.render(el.id);// re-render to show/hide clear button
  },
  async chooseFolderSlideImage(){
    const el=State.getEl(State.selectedElId);if(!el)return;
    try{const d=await Tauri.openImage();this.setFolderSlideProp('bgImage',d);}
    catch(err){if(!String(err).includes('Cancelled'))alert('Could not load image: '+err);}
  },

  // ── hscroll helpers ──────────────────────────────────────────
  setHScrollItem(i){
    const el=State.getEl(State.selectedElId);if(!el)return;
    el.props._editingItem=i;Canvas.updateElDOM(el);Props.render(el.id);
  },
  addHScrollItem(){
    const el=State.getEl(State.selectedElId);if(!el)return;History.save();
    const n=el.props.items.length;
    el.props.items.push({title:`Card ${n+1}`,body:'Description here.',src:`https://picsum.photos/seed/hs${n+1}/400/300`});
    el.props._editingItem=el.props.items.length-1;
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  removeHScrollItem(i){
    const el=State.getEl(State.selectedElId);if(!el)return;
    if(el.props.items.length<=1)return;History.save();
    el.props.items.splice(i,1);el.props._editingItem=Math.max(0,i-1);
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  setHScrollItemSrc(src){
    const el=State.getEl(State.selectedElId);if(!el)return;
    const i=el.props._editingItem||0;
    if(!el.props.items[i])return;
    el.props.items[i].src=src;Canvas.updateElDOM(el);State.dirty=true;
  },

  // ── collage helpers ──────────────────────────────────────────
  setCollageImg(i){
    const el=State.getEl(State.selectedElId);if(!el)return;
    el.props._editImg=i;Canvas.updateElDOM(el);Props.render(el.id);
  },
  addCollageImg(){
    const el=State.getEl(State.selectedElId);if(!el)return;History.save();
    const n=el.props.images.length;
    el.props.images.push({src:`https://picsum.photos/seed/col${n+1}/600/400`,alt:`Photo ${n+1}`});
    el.props._editImg=el.props.images.length-1;
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  removeCollageImg(i){
    const el=State.getEl(State.selectedElId);if(!el)return;
    if(el.props.images.length<=1)return;History.save();
    el.props.images.splice(i,1);el.props._editImg=Math.max(0,i-1);
    Canvas.updateElDOM(el);Props.render(el.id);State.dirty=true;
  },
  setCollageImgSrc(src){
    const el=State.getEl(State.selectedElId);if(!el)return;
    const i=el.props._editImg||0;
    if(!el.props.images[i])return;
    el.props.images[i].src=src;Canvas.updateElDOM(el);State.dirty=true;
  },

  tableBgPicker(p){
    const mode=p.cellBgMode||'solid';
    const tabs=`<div class="link-mode-row">
      <button class="link-mode-btn${mode==='solid'?' active':''}" onclick="Props.setPropDirect('cellBgMode','solid')">Solid</button>
      <button class="link-mode-btn${mode==='gradient'?' active':''}" onclick="Props.setPropDirect('cellBgMode','gradient')">Gradient</button>
    </div>`;
    let body='';
    if(mode==='solid'){
      const safe=p.cellBg&&p.cellBg.startsWith('#')?p.cellBg:'#000000';
      body=`<div style="margin-top:4px;display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">Color</label><input type="color" value="${safe}" oninput="Props.setProp(event,'cellBg')"/></div>`;
    } else {
      const safeA=p.cellBg&&p.cellBg.startsWith('#')?p.cellBg:'#1a1a2e';
      const safeB=(p.cellBgGradB||'#000000').startsWith('#')?(p.cellBgGradB||'#000000'):'#000000';
      const dir=p.cellBgGradDir||'to right';
      body=`<div style="margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">From</label><input type="color" value="${safeA}" oninput="Props.setProp(event,'cellBg')"/></div>
        <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">To</label><input type="color" value="${safeB}" oninput="Props.setProp(event,'cellBgGradB')"/></div>
      </div>
      <select class="prop-select" style="margin-top:4px;" onchange="Props.setProp(event,'cellBgGradDir')">
        <option value="to right"${dir==='to right'?' selected':''}>→ Left to Right</option>
        <option value="to bottom"${dir==='to bottom'?' selected':''}>↓ Top to Bottom</option>
        <option value="135deg"${dir==='135deg'?' selected':''}>↘ Diagonal</option>
        <option value="radial"${dir==='radial'?' selected':''}>◎ Center Outward</option>
      </select>`;
    }
    return `<div class="prop-group"><label class="prop-label">Cell Background</label>${tabs}${body}</div>`;
  },
};

// ── Context menu ──────────────────────────────────────────────
const CtxMenu={
  targetId:null,
  show(x,y,id){this.targetId=id;const m=document.getElementById('ctx-menu');m.classList.remove('hidden');m.style.left=x+'px';m.style.top=y+'px';},
  hide(){document.getElementById('ctx-menu').classList.add('hidden');},
  delete(){
    const id=this.targetId;if(!id)return;
    State.currentPage.elements=State.currentPage.elements.filter(e=>e.id!==id);
    document.querySelector(`[data-id="${id}"]`)?.remove();
    if(State.selectedElId===id){State.selectedElId=null;Props.renderNone();}
    Canvas.updateHeight();State.dirty=true;
  },
  duplicate(){
    const src=State.getEl(this.targetId);if(!src)return;
    const clone=JSON.parse(JSON.stringify(src));clone.id=State.newId();clone.x+=20;clone.y+=20;
    State.elements.push(clone);Canvas.renderEl(clone);Canvas.select(clone.id);Canvas.updateHeight();State.dirty=true;
  },
  moveUp(){const arr=State.elements,i=arr.findIndex(e=>e.id===this.targetId);if(i>0){[arr[i-1],arr[i]]=[arr[i],arr[i-1]];Canvas.renderAll();}},
  moveDown(){const arr=State.elements,i=arr.findIndex(e=>e.id===this.targetId);if(i<arr.length-1){[arr[i],arr[i+1]]=[arr[i+1],arr[i]];Canvas.renderAll();}},
};

// ── Exporter ──────────────────────────────────────────────────
const Exporter={
  buildPage(page,projectJson,isPreview=false){
    const bg=page.background||{type:'solid',color:'#ad8d7b'};
    // Compute body background CSS
    function pageBgCSS(bg){
      if(bg.type==='solid')   return `background:${bg.color||'#0d1117'};`;
      if(bg.type==='gradient')return `background:linear-gradient(${bg.dir||'to bottom'},${bg.colorA||'#03050f'},${bg.colorB||'#0d1f3c'});`;
      if(bg.type==='split'){const a=bg.splitAngle||135;return `background:linear-gradient(${a}deg,${bg.colorA||'#0d1117'} 50%,${bg.colorB||'#1f6feb'} 50%);background-attachment:fixed;`;}
      if(bg.type==='image'&&bg.image)return `background:url('${bg.image}') center/${bg.imageSize||'cover'} no-repeat fixed;`;
      if(bg.type==='dynamic') return `background:#03050f;`;
      return `background:${bg.color||'#ad8d7b'};`;
    }
    const bgStyle=pageBgCSS(bg);
    // Generate layered background HTML (replaces old bgStyle on body)
    const bgLayersHTML=BgLayers.exportHTML(page);
    const canvasTag   =bg.type==='dynamic'?`\n  <canvas id="bgCanvas" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;"></canvas>`:'';
    const canvasScript=bg.type==='dynamic'?BgEffects.generateScript(bg.effectIndex||0,bg.colorA||'#00ff41',bg.colorB||'#00c8ff',bg.colorC||'#4080ff'):'';
    let elHtml='';for(const el of page.elements)elHtml+=this.exportEl(el);
    const hasContact=page.elements.some(e=>e.type==='contact');
    const hasHover=page.elements.some(e=>e.props&&e.props.hoverScale);
    const hasHoverZoom=page.elements.some(e=>e.props&&e.props.hoverZoom);
    const hasScrollIn=page.elements.some(e=>e.props&&e.props.scrollIn);
    const cursorType=page.cursorType||'default';
    const cursorColor=page.cursorColor||'#00ff41';
    let maxY=0;
    for(const el of page.elements){const estH=el.h==='auto'?200:el.h;maxY=Math.max(maxY,el.y+estH);}
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${escHtml(page.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display:wght@400;700&family=Montserrat:wght@400;600;700&family=Oswald:wght@400;600&family=Dancing+Script:wght@600&family=Merriweather:ital,wght@0,400;0,700&family=Raleway:wght@400;600;700&family=Lora:ital,wght@0,400;0,600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{background:transparent;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-x:hidden;${cursorType!=='default'&&cursorType!=='crosshair'?'cursor:none;':cursorType==='crosshair'?'cursor:crosshair;':''}}
.wc-page{position:relative;z-index:1;width:100%;max-width:1440px;margin:0 auto;min-height:${Math.max(maxY+100,600)}px;}
input,textarea{color:#e6edf3;}input::placeholder,textarea::placeholder{color:#555;}
${hasHover?this.hoverCSS():''}
${hasHoverZoom?this.hoverZoomCSS():''}
${hasScrollIn?this.scrollInCSS():''}
${cursorType==='dot'||cursorType==='ring'?this.cursorCSS(cursorType,cursorColor):''}
</style>
</head>
<body>
${bgLayersHTML}
<div class="wc-page">
${elHtml}
</div>
${hasContact?this.contactScript():''}
${hasScrollIn?this.scrollInScript():''}
${cursorType==='dot'||cursorType==='ring'?this.cursorScript(cursorType,cursorColor):''}
${projectJson?'<!--PAGEDOTCOM_PROJECT:'+projectJson.replace(/-->/g,'-- >')+'-->':''}
<script>
document.addEventListener('click',function(e){
  var a=e.target.closest('a');if(!a)return;
  var href=a.getAttribute('href')||'';
  if(!href||href==='#'){e.preventDefault();return;}
  if(href.startsWith('#')){e.preventDefault();var t=document.getElementById(href.slice(1));if(t)t.scrollIntoView({behavior:'smooth'});return;}
  ${isPreview?"if(!href.startsWith('http')&&href.endsWith('.html')){e.preventDefault();window.parent.postMessage({type:'previewNav',page:href.replace(/\\.html$/,'')},'*');return;}":''}
});
<\/script>
</body>
</html>`;
  },

  // Build entire project as a single self-contained HTML file
  buildSite(projectJson){
    return this._buildSiteImpl(projectJson, -1);  // -1 = use page 0 as entry
  },
  buildSiteForPage(pageIdx){
    return this._buildSiteImpl(null, pageIdx);
  },
  _buildSiteImpl(projectJson, entryPageIdx){
    Exporter._svgSeq=0;// reset unique SVG gradient id counter
    const pages=State.project.pages;
    if(!pages||!pages.length)return '';
    const entryIdx=entryPageIdx>=0&&entryPageIdx<pages.length?entryPageIdx:0;
    const pageIndex={};
    pages.forEach(function(pg,i){pageIndex[pg.name]=i;});
    let pagesDivs='';
    let bgLayersDivs='';  // per-page bg layer containers
    let pagesCSS='';
    let hasContact=false,hasHover=false,hasHoverZoom=false,hasScrollIn=false;
    for(let pi=0;pi<pages.length;pi++){
      const pg=pages[pi];
      const isEntry=(pi===entryIdx);
      let elHtml='';for(const el of pg.elements)elHtml+=this.exportEl(el);
      let maxY=0;for(const el of pg.elements){const estH=el.h==='auto'?200:el.h;maxY=Math.max(maxY,el.y+estH);}
      if(pg.elements.some(e=>e.type==='contact'))hasContact=true;
      if(pg.elements.some(e=>e.props&&e.props.hoverScale))hasHover=true;
      if(pg.elements.some(e=>e.props&&e.props.hoverZoom))hasHoverZoom=true;
      if(pg.elements.some(e=>e.props&&e.props.scrollIn))hasScrollIn=true;
      // Page CSS — transparent bg (bg layers handle the background)
      pagesCSS+='#wcp-'+pi+'{display:'+(isEntry?'block':'none')+';min-height:100vh;background:transparent;position:relative;z-index:1;}\n';
      pagesCSS+='.wcp-'+pi+'-wrap{position:relative;z-index:1;width:100%;max-width:1440px;margin:0 auto;min-height:'+Math.max(maxY+100,600)+'px;}\n';
      pagesDivs+='<div id="wcp-'+pi+'">\n<div class="wcp-'+pi+'-wrap">'+elHtml+'</div></div>\n';
      // Generate bg layers — display value baked in from the start (no post-hoc patching)
      const bglHtml=BgLayers.exportHTML(pg,'bgl-'+pi,isEntry?'block':'none');
      bgLayersDivs+=bglHtml;
    }
    const pageIndexJson=JSON.stringify(pageIndex);
    const hoverCSS=hasHover?this.hoverCSS():'';
    const hoverZoomCSS=hasHoverZoom?this.hoverZoomCSS():'';
    const contactScript=hasContact?this.contactScript():'';
    const pj=projectJson?'<!--PAGEDOTCOM_PROJECT:'+projectJson+'-->':'';
    // Navigation script — also shows/hides bgl-N containers alongside wcp-N
    const navScript=
      '(function(){\n'+
      '  var PI='+pageIndexJson+';\n'+
      '  var PAGE_COUNT='+pages.length+';\n'+
      '\n'+
      '  function pdcShow(idx){\n'+
      // Hide ALL page wcp-N and bgl-N containers by exact id (NOT by prefix, which would hit canvas children)
      '    for(var i=0;i<PAGE_COUNT;i++){\n'+
      '      var _pg=document.getElementById(\'wcp-\'+i);\n'+
      '      if(_pg) _pg.style.display=\'none\';\n'+
      '      var _bg=document.getElementById(\'bgl-\'+i);\n'+
      '      if(_bg) _bg.style.display=\'none\';\n'+
      '    }\n'+
      '    var pg=document.getElementById(\'wcp-\'+idx);\n'+
      '    if(pg) pg.style.display=\'block\';\n'+
      '    var bgl=document.getElementById(\'bgl-\'+idx);\n'+
      '    if(bgl) bgl.style.display=\'block\';\n'+
      // Dispatch a resize event so animation closures update their W,H via their own resize() fn
      // This is correct because all animation IIFEs register window.addEventListener(\'resize\',resize)
      '    window.dispatchEvent(new Event(\'resize\'));\n'+
      '    window.scrollTo(0,0);\n'+
      '  }\n'+
      '\n'+
      '  window.showPage=function(name){ var i=PI[name]; if(i!==undefined) pdcShow(i); };\n'+
      '\n'+
      '  var btns=document.querySelectorAll(\'[data-nav-page]\');\n'+
      '  for(var bi=0;bi<btns.length;bi++){\n'+
      '    (function(btn){\n'+
      '      var target=btn.getAttribute(\'data-nav-page\');\n'+
      '      if(!target)return;\n'+
      '      btn.addEventListener(\'click\',function(e){\n'+
      '        e.preventDefault();\n'+
      '        var idx=PI[target];\n'+
      '        if(idx!==undefined) pdcShow(idx);\n'+
      '      });\n'+
      '    })(btns[bi]);\n'+
      '  }\n'+
      '\n'+
      '  var urlBtns=document.querySelectorAll(\'[data-open-url]\');\n'+
      '  for(var ui=0;ui<urlBtns.length;ui++){\n'+
      '    (function(btn){\n'+
      '      var url=btn.getAttribute(\'data-open-url\');\n'+
      '      btn.addEventListener(\'click\',function(){\n'+
      '        if(!url)return;\n'+
      '        if(url.startsWith(\'mailto:\')){ window.location.href=url; return; }\n'+
      '        window.open(url,\'_blank\',\'noopener,noreferrer\');\n'+
      '      });\n'+
      '    })(urlBtns[ui]);\n'+
      '  }\n'+
      '\n'+
      '  document.addEventListener(\'click\',function(e){\n'+
      '    var a=e.target.closest(\'a\');\n'+
      '    if(!a)return;\n'+
      '    var href=a.getAttribute(\'href\')||\'\';if(!href||href===\'#\')return;\n'+
      '    if(href.charAt(0)===\'#\'){\n'+
      '      var id=href.slice(1);\n'+
      '      var t=document.getElementById(id);\n'+
      '      if(t){e.preventDefault();t.scrollIntoView({behavior:\'smooth\',block:\'start\'});}\n'+
      '    }\n'+
      '  });\n'+
      '})();\n';
    const safePj = projectJson
      ? '<!--PAGEDOTCOM_PROJECT:' + projectJson.replace(/-->/g,'-- >') + '-->'
      : '';
    // Derive a fallback body bg from first page's first solid layer (prevents white flash)
    const firstPageBg=(()=>{
      const fl=BgLayers.getLayers(pages[0]);
      for(const l of fl){
        if(l.type==='solid'&&l.color) return l.color;
        if(l.type==='gradient'&&l.colorA) return l.colorA;
      }
      return '#0d1117';
    })();
    const googleFonts=`<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display:wght@400;700;900&family=Montserrat:wght@400;600;700&family=Oswald:wght@400;600&family=Dancing+Script:wght@600&family=Merriweather:ital,wght@0,400;0,700&family=Raleway:wght@400;600;700&family=Lora:ital,wght@0,400;0,600&family=Space+Grotesk:wght@400;500;600&family=DM+Serif+Display&family=IBM+Plex+Mono:wght@400;600&family=Bebas+Neue&family=Abril+Fatface&family=Permanent+Marker&display=swap" rel="stylesheet"/>`;
    return (
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n'+
      '<meta charset="UTF-8"/>\n'+
      '<meta name="viewport" content="width=device-width,initial-scale=1.0"/>\n'+
      '<title>'+escHtml(State.project.name||'Site')+'</title>\n'+
      googleFonts+'\n'+
      '<style>\n'+
      '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}\n'+
      'html,body{background:'+firstPageBg+';}\n'+
      'html{scroll-behavior:smooth;}\n'+
      'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;overflow-x:hidden;}\n'+
      'a{text-decoration:none;}\n'+
      'input,textarea{color:#e6edf3;}input::placeholder,textarea::placeholder{color:#555;}\n'+
      pagesCSS+hoverCSS+hoverZoomCSS+(hasScrollIn?this.scrollInCSS():'')+'\n'+
      '</style>\n</head>\n<body>\n'+
      bgLayersDivs+'\n'+
      pagesDivs+'\n'+
      contactScript+'\n'+
      (hasScrollIn?this.scrollInScript():'')+'\n'+
      safePj+'\n'+
      '<script>\n'+navScript+'<\/script>\n'+
      '</body>\n</html>'
    );
  },

    hoverZoomCSS(){return`.wc-img-zoom{cursor:pointer;}.wc-img-zoom img{transition:transform 0.45s cubic-bezier(.22,1,.36,1)!important;}.wc-img-zoom:hover img{transform:scale(1.18)!important;transform-origin:50% 50%!important;}`;},

  hoverCSS(){return`
.wc-panel{transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s;}
.wc-panel:hover{transform:scale(1.05);box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:10;position:relative;}
.wc-table-cell{transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s;}
.wc-table-cell:hover{transform:scale(1.06);box-shadow:0 8px 24px rgba(0,0,0,.4);}`;},

  scrollInCSS(){return`
[data-scroll-in]{transition-timing-function:cubic-bezier(.22,1,.36,1);transition-duration:.75s;transition-property:transform,opacity,filter;}
[data-scroll-in="scale"]{transform:scale(0.01);opacity:0;}
[data-scroll-in="fade"]{opacity:0;}
[data-scroll-in="slide-up"]{transform:translateY(60px);opacity:0;}
[data-scroll-in="slide-left"]{transform:translateX(-80px);opacity:0;}
[data-scroll-in="slide-right"]{transform:translateX(80px);opacity:0;}
[data-scroll-in="blur"]{filter:blur(18px);opacity:0;}
[data-scroll-in="splash"]{transform:scale(0.01);opacity:0;transition-timing-function:cubic-bezier(.34,1.7,.64,1);}
[data-scroll-in="vibrate"]{transform:translateX(-40px);opacity:0;transition-timing-function:cubic-bezier(.36,.07,.19,.97);}
[data-scroll-in="shrink-bounce"]{transform:scale(1.4);opacity:0;transition-timing-function:cubic-bezier(.22,1,.36,1);}
[data-scroll-in="flip-x"]{transform:perspective(600px) rotateY(90deg);opacity:0;}
[data-scroll-in="flip-y"]{transform:perspective(600px) rotateX(90deg);opacity:0;}
[data-scroll-in="rotate-in"]{transform:rotate(-15deg) scale(0.7);opacity:0;}
[data-scroll-in].wc-visible{transform:none!important;opacity:1!important;filter:none!important;}
@keyframes wc-vibrate{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
[data-scroll-in="vibrate"].wc-visible{animation:wc-vibrate .5s ease both;}`;},

  scrollInScript(){return`<script>
(function(){
  var els=document.querySelectorAll('[data-scroll-in]');
  if(!els.length||!window.IntersectionObserver)return;
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(en){
      if(en.isIntersecting){
        var el=en.target;
        var speed=el.dataset.scrollSpeed;
        if(speed) el.style.transitionDuration=speed+'s';
        var delay=parseFloat(el.dataset.scrollDelay||0)*1000;
        setTimeout(function(){el.classList.add('wc-visible');},delay);
        io.unobserve(el);
      }
    });
  },{threshold:0.12});
  els.forEach(function(el){io.observe(el);});
})();
<\/script>`; },

  cursorCSS(type,color){
    if(type==='dot')return`#wc-cursor{position:fixed;width:12px;height:12px;background:${color};border-radius:50%;pointer-events:none;z-index:99999;transform:translate(-50%,-50%);box-shadow:0 0 10px ${color},0 0 20px ${color}66;}`;
    if(type==='ring')return`#wc-cursor{position:fixed;width:28px;height:28px;border:2px solid ${color};border-radius:50%;pointer-events:none;z-index:99999;transform:translate(-50%,-50%);opacity:.7;transition:width .15s,height .15s;}
#wc-cursor-dot{position:fixed;width:4px;height:4px;background:${color};border-radius:50%;pointer-events:none;z-index:99999;transform:translate(-50%,-50%);}`;
    return'';
  },
  cursorScript(type,color){
    if(type==='dot')return`<div id="wc-cursor"></div><script>document.addEventListener('mousemove',e=>{const c=document.getElementById('wc-cursor');c.style.left=e.clientX+'px';c.style.top=e.clientY+'px';});<\/script>`;
    if(type==='ring')return`<div id="wc-cursor"></div><div id="wc-cursor-dot"></div>
<script>let rx=0,ry=0,mx=0,my=0;document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;const d=document.getElementById('wc-cursor-dot');d.style.left=mx+'px';d.style.top=my+'px';});
(function loop(){rx+=(mx-rx)*.18;ry+=(my-ry)*.18;const c=document.getElementById('wc-cursor');c.style.left=rx+'px';c.style.top=ry+'px';requestAnimationFrame(loop);})();<\/script>`;
    return'';
  },

  exportEl(el){
    const p=el.props;
    const ff=p.fontFamily?`font-family:${p.fontFamily};`:'';
    const pos=`position:absolute;left:${el.x}px;top:${el.y}px;${el.w!=='auto'?`width:${el.w}px;`:''}${el.h!=='auto'?`height:${el.h}px;`:''}`;
    // Scroll-in attributes — applied to the outermost wrapper div via scrollWrap()
    const siType=p.scrollIn&&p.scrollInType?p.scrollInType:'';
    const siDelay=p.scrollIn&&p.scrollInDelay?p.scrollInDelay:0;
    const siSpeed=p.scrollIn&&p.scrollInSpeed!=null?p.scrollInSpeed:null;
    const scrollAttr=siType?` data-scroll-in="${siType}"${siDelay?' data-scroll-delay="'+siDelay+'"':''}${siSpeed&&siSpeed!==0.75?' data-scroll-speed="'+siSpeed+'"':''}`:'';
    switch(el.type){
      case 'panel':{
        const shapeCSS=panelShapeCSS(p.shape,p.borderRadius);
        const isShaped=p.shape&&p.shape!=='normal';
        const ovf=isShaped?'overflow:hidden;':'';
        let effectiveAlign=p.textAlign||'left';
        let extraPad=0;
        if(isShaped){
          const shapePads={circle:22,pill:18,diamond:28,hexagon:20,skew:14,banner:16,notch:12,chevron:10};
          extraPad=shapePads[p.shape]||14;
        }
        const totalPad=`${p.padding+extraPad}px ${p.padding+extraPad}px`;
        const paddingCSS=isShaped?`padding:${totalPad};`:`padding:${p.padding}px;`;
        const alignItems=effectiveAlign==='right'?'flex-end':effectiveAlign==='center'?'center':'flex-start';
        const layoutCSS=isShaped?`display:flex;flex-direction:column;align-items:${alignItems};justify-content:center;box-sizing:border-box;`:'';
        const alignCSS=`text-align:${effectiveAlign};`;
        const justifyCSS=(p.justify&&!isShaped)?'text-align:justify;':'';
        const bw=isShaped?(p.borderWidth||0):0;
        if(isShaped&&bw>0){
          const exShadowCSS=elShadowFilter(el);
          return `<div class="${p.hoverScale?'wc-panel':''}"${scrollAttr} style="${pos}${exShadowCSS}background:${p.borderColor};${shapeCSS}overflow:hidden;${ff}"><div style="position:absolute;inset:0;background:${p.borderColor};${shapeCSS}overflow:hidden;">
  <div style="position:absolute;inset:${bw}px;${computeBg(p)}${shapeCSS}${paddingCSS}overflow:hidden;${layoutCSS}">
    <div style="font-size:${p.titleSize}px;${textStyle(p.titleBold!==false,p.titleItalic,p.titleUnderline,p.titleFont||p.fontFamily||'')}color:${p.titleColor};margin-bottom:8px;${alignCSS}width:100%;">${escHtml(p.title)}</div>
    <div style="font-size:${p.bodySize}px;${textStyle(p.bodyBold,p.bodyItalic,p.bodyUnderline,p.fontFamily||'')}color:${p.bodyColor};line-height:1.65;${justifyCSS||alignCSS}width:100%;">${nl2br(escHtml(p.body))}</div>
  </div></div></div>\n`;
        }
        const exShadowCSS2=elShadowFilter(el);
        return `<div class="${p.hoverScale?'wc-panel':''}"${scrollAttr} style="${pos}${exShadowCSS2}${computeBg(p)}border:${p.borderWidth}px solid ${p.borderColor};${paddingCSS}${shapeCSS}${ovf}${layoutCSS}${ff}">
  <div style="font-size:${p.titleSize}px;${textStyle(p.titleBold!==false,p.titleItalic,p.titleUnderline,p.titleFont||p.fontFamily||'')}color:${p.titleColor};margin-bottom:8px;${alignCSS}width:100%;">${escHtml(p.title)}</div>
  <div style="font-size:${p.bodySize}px;${textStyle(p.bodyBold,p.bodyItalic,p.bodyUnderline,p.fontFamily||'')}color:${p.bodyColor};line-height:1.65;${justifyCSS||alignCSS}width:100%;">${nl2br(escHtml(p.body))}</div>
</div>\n`;
      }
      case 'table':{
        const cells=p.cells||[];
        const hCls=p.hoverScale?'wc-table-cell':'';
        const baseCellBgCSS=p.cellBgMode==='gradient'
          ? (p.cellBgGradDir==='radial'
              ? `radial-gradient(circle at center,${p.cellBg||'#1a1a2e'},${p.cellBgGradB||'#000'})`
              : `linear-gradient(${p.cellBgGradDir||'to right'},${p.cellBg||'#1a1a2e'},${p.cellBgGradB||'#000'})`)
          : (p.cellBg||'rgba(255,255,255,0.04)');
        const cellsHtml=cells.map(c=>{
          const bg=c.bgOverride||baseCellBgCSS;
          return `
    <div class="${hCls}" style="background:${bg};border:1px solid ${p.cellBorder};border-radius:${p.borderRadius}px;padding:${p.padding}px;${ff}">
      <div style="font-size:${p.titleSize}px;font-weight:700;color:${p.titleColor};margin-bottom:5px;">${escHtml(c.title)}</div>
      <div style="font-size:${p.bodySize}px;color:${p.bodyColor};line-height:1.55;">${nl2br(escHtml(c.body))}</div>
    </div>`;}).join('');
        return `<div style="${pos}display:grid;grid-template-columns:repeat(${p.cols},1fr);gap:${p.gap}px;">\n${cellsHtml}\n</div>\n`;
      }
      case 'heading':{const tag=p.level||'h2';return`<${tag} style="${pos}font-size:${p.fontSize}px;color:${p.color};text-align:${p.align};letter-spacing:${p.letterSpacing}px;${textStyle(p.fontWeight>='700'||p.fontWeight==='bold',p.italic,p.underline,p.fontFamily)}">${escHtml(p.text)}</${tag}>\n`;}
      case 'text':return`<p style="${pos}font-size:${p.fontSize}px;color:${p.color};text-align:${p.align};line-height:${p.lineHeight};${textStyle(p.bold,p.italic,p.underline,p.fontFamily)}">${nl2br(escHtml(p.text))}</p>\n`;
      case 'image':{
        if(!p.src)return '';
        const imgShape=p.imageShape||'none';
        const expShapeStyle=imageShapeStyle(imgShape,p.borderRadius);
        const expBorder=p.border?`border:${p.borderWidth||2}px solid ${p.borderColor};box-sizing:border-box;`:'';
        const expShadow=elShadowFilter(el);
        const needsSquare=IMAGE_SQUARE_SHAPES.has(imgShape);
        const imgPosX=p.imgPosX!=null?p.imgPosX:50;
        const imgPosY=p.imgPosY!=null?p.imgPosY:50;
        const imgZoom=p.imgZoom!=null&&p.imgZoom>1?p.imgZoom:1;
        const hzClass=p.hoverZoom?' wc-img-zoom':'';
        const isSvgData=p.src.startsWith('data:image/svg+xml');
        const isDataUri=p.src.startsWith('data:');
        const side=needsSquare?(el.w!=='auto'?el.w:(el.h!=='auto'?el.h:240)):null;
        const wStyle=side?`width:${side}px;height:${side}px;`:'';
        const zoomStyle=imgZoom>1?`transform:scale(${imgZoom});transform-origin:${imgPosX}% ${imgPosY}%;`:'';
        const imgStyle=`width:100%;height:100%;object-fit:${p.objectFit||'cover'};object-position:${imgPosX}% ${imgPosY}%;display:block;${zoomStyle}transition:transform 0.45s ease;`;

        if(isSvgData){
          // Decode the SVG data URI and embed as inline <svg>.
          // Works in all contexts: file://, blob:, srcdoc, WebView.
          // IMPORTANT: replace id="g" with a unique id to prevent gradient conflicts
          // when multiple SVGs are inlined on the same page.
          const uid='svg'+((Exporter._svgSeq=(Exporter._svgSeq||0)+1));
          let svgContent='';
          try{
            const raw=p.src.slice(p.src.indexOf(',')+1);
            svgContent=raw.includes('%3C')||raw.includes('%3c')
              ?decodeURIComponent(raw)
              :(raw.startsWith('PHN')||raw.startsWith('PD9'))?atob(raw):decodeURIComponent(raw);
            // Make gradient id unique to this SVG instance
            svgContent=svgContent.replace(/\bid="g"/g,`id="${uid}"`).replace(/\burl\(#g\)/g,`url(#${uid})`);
            // Inject style so the SVG fills its container regardless of width/height attrs
            svgContent=svgContent.replace('<svg ','<svg style="width:100%;height:100%;display:block;position:absolute;inset:0;" ');
          }catch(e){svgContent='';}
          const wrapStyle=`${pos}${wStyle}${expShapeStyle}${expBorder}${expShadow}overflow:hidden;position:absolute;`;
          return `<div${scrollAttr} class="${hzClass.trim()}" style="${wrapStyle}" role="img" aria-label="${escHtml(p.alt)}">${svgContent}</div>\n`;
        }
        if(isDataUri){
          // Non-SVG data URI (e.g. base64 PNG): use background-image CSS
          const bgStyle=`background-image:url('${p.src}');background-size:cover;background-position:${imgPosX}% ${imgPosY}%;background-repeat:no-repeat;`;
          return `<div${scrollAttr} class="${hzClass.trim()}" style="${pos}${wStyle}${expShapeStyle}${expBorder}${expShadow}${bgStyle}" role="img" aria-label="${escHtml(p.alt)}"></div>\n`;
        }
        // External URL: standard <img> tag
        return `<div${scrollAttr} class="${hzClass.trim()}" style="${pos}${wStyle}${expShapeStyle}${expBorder}${expShadow}overflow:hidden;"><img src="${p.src}" alt="${escHtml(p.alt)}" style="${imgStyle}" loading="lazy"/></div>\n`;
      }
      case 'divider':{
        // If divider is near-full-width (>=900px), break it out to viewport width
        const divW=el.w==='auto'?1000:el.w;
        const divStyle=divW>=900
          ? `position:relative;left:50%;transform:translateX(-50%);width:100vw;padding:${p.marginV}px 0;`
          : `${pos}padding:${p.marginV}px 0;`;
        return`<div style="${divStyle}"><hr style="border:none;border-top:${p.thickness}px ${p.style} ${p.color};"/></div>\n`;
      }
      case 'button':{
        const mode=p.linkMode||'url';
        const commonStyle=`display:inline-block;padding:${p.paddingV}px ${p.paddingH}px;${computeBg(p)}color:${p.textColor};border-radius:${p.borderRadius}px;font-size:${p.fontSize}px;cursor:pointer;${textStyle(p.bold,p.italic,p.underline,p.fontFamily)}`;
        if(mode==='url'){
          // Use data-open-url + type=button — avoids target=_blank popup-block from file:// and WebViews
          const rawUrl=(p.href||'').trim();
          const safeUrl=escHtml(rawUrl);
          const isMail=rawUrl.startsWith('mailto:');
          // If no protocol, assume https
          const resolvedUrl=rawUrl&&!rawUrl.startsWith('http')&&!rawUrl.startsWith('mailto:')?'https://'+rawUrl:rawUrl;
          return`<div style="${pos}"><button type="button" data-open-url="${escHtml(resolvedUrl)}" style="${commonStyle}border:none;outline:none;">${escHtml(p.label)}</button></div>\n`;
        } else if(mode==='page'){
          return`<div style="${pos}"><button type="button" data-nav-page="${escHtml(p.pageTarget||'')}" style="${commonStyle}border:none;outline:none;">${escHtml(p.label)}</button></div>\n`;
        } else if(mode==='section'){
          const sHref=p.sectionTarget?('#'+p.sectionTarget):'#';
          return`<div style="${pos}"><a href="${escHtml(sHref)}" style="${commonStyle}text-decoration:none;">${escHtml(p.label)}</a></div>\n`;
        }
        return`<div style="${pos}"><a href="#" style="${commonStyle}text-decoration:none;">${escHtml(p.label)}</a></div>\n`;
      }
      case 'navbar':{
        const nlinks=(p.navLinks||[]);
        const isFullW=p.fullWidth!==false;
        const navStyle=p.sticky
          ? `position:fixed;top:0;left:0;right:0;z-index:1000;${computeBg(p)}padding:12px 20px;display:flex;align-items:center;gap:20px;${ff}`
          : isFullW
            ? `position:relative;left:50%;transform:translateX(-50%);width:100vw;${computeBg(p)}padding:12px 20px;display:flex;align-items:center;gap:20px;${ff}`
            : `${pos}${computeBg(p)}padding:12px 20px;display:flex;align-items:center;gap:20px;${ff}`;
        const linkEls=nlinks.map(l=>{
          const lStyle=`color:${p.textColor||'#e6edf3'};opacity:.85;text-decoration:none;font-size:13px;font-weight:500;cursor:pointer;`;
          if(l.pageTarget&&l.pageTarget.trim()){
            // page navigation — use data-nav-page so the single-file JS picks it up
            return`<a data-nav-page="${escHtml(l.pageTarget.trim())}" href="javascript:void(0)" style="${lStyle}">${escHtml(l.label)}</a>`;
          } else if(l.target&&l.target.trim()){
            return`<a href="#${escHtml(l.target.trim())}" style="${lStyle}">${escHtml(l.label)}</a>`;
          }
          return`<a href="javascript:void(0)" style="${lStyle};opacity:.35;text-decoration:line-through;" title="No link set">${escHtml(l.label)}</a>`;
        }).join('');
        return`<nav style="${navStyle}">
  <span style="font-weight:800;font-size:16px;color:${p.textColor||'#e6edf3'};">${escHtml(p.brand)}</span>
  <div style="display:flex;gap:20px;flex:1;margin-left:8px;">${linkEls}</div>
</nav>\n`;
      }
      case 'contact':{
        const tc=p.textColor||'#e6edf3';
        const inBg=p.inputBg||'rgba(0,0,0,.3)';
        const btnTc=p.btnTextColor||'#ffffff';
        return`<div id="wc-contact-${el.id}" style="${pos}${computeBg(p)}border:1px solid ${p.borderColor};border-radius:${p.borderRadius}px;padding:20px;color:${tc};">
  ${p.title?`<h3 style="font-size:18px;font-weight:700;margin-bottom:14px;color:${tc};">${escHtml(p.title)}</h3>`:''}
  <input type="text" name="name" placeholder="Your Name" style="width:100%;background:${inBg};border:1px solid rgba(255,255,255,.15);color:${tc};padding:8px;border-radius:4px;margin-bottom:8px;outline:none;"/>
  <input type="email" name="email" placeholder="Your Email" style="width:100%;background:${inBg};border:1px solid rgba(255,255,255,.15);color:${tc};padding:8px;border-radius:4px;margin-bottom:8px;outline:none;"/>
  <input type="text" name="subject" placeholder="Subject" style="width:100%;background:${inBg};border:1px solid rgba(255,255,255,.15);color:${tc};padding:8px;border-radius:4px;margin-bottom:8px;outline:none;"/>
  <textarea name="message" placeholder="Message..." style="width:100%;min-height:80px;background:${inBg};border:1px solid rgba(255,255,255,.15);color:${tc};padding:8px;border-radius:4px;margin-bottom:8px;resize:vertical;outline:none;"></textarea>
  <button onclick="wcSendMail('wc-contact-${el.id}','${escHtml(p.email)}')" style="background:${p.btnColor};color:${btnTc};border:none;padding:9px 20px;border-radius:4px;cursor:pointer;font-weight:600;">${escHtml(p.btnLabel)}</button>
</div>\n`;
      }
      case 'section':return`<div id="${escHtml(p.name)}" style="${pos}width:${el.w}px;"></div>\n`;
      case 'spacer':return`<div style="${pos}height:${p.height}px;"></div>\n`;
      case 'shape':{
        let clipPath='none',borderRadius=p.borderRadius+'px';
        switch(p.form){
          case 'circle':borderRadius='50%';break;
          case 'triangle':clipPath='polygon(50% 0%,100% 100%,0% 100%)';borderRadius='0';break;
          case 'parallelogram':clipPath='polygon(15% 0%,100% 0%,85% 100%,0% 100%)';borderRadius='0';break;
          case 'hexagon':clipPath='polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)';borderRadius='0';break;
        }
        const shapeShadowCSS=elShadowFilter(el);
        const bw=p.borderWidth||0;
        const shapeIsClipped=clipPath!=='none';
        if(bw>0&&shapeIsClipped){
          return`<div${scrollAttr} style="${pos}${shapeShadowCSS}background:${p.borderColor};border-radius:${borderRadius};clip-path:${clipPath};opacity:${p.opacity};"><div style="position:absolute;inset:${bw}px;${computeBg(p)}border-radius:${borderRadius};clip-path:${clipPath};"></div></div>\n`;
        }
        return`<div${scrollAttr} style="${pos}${shapeShadowCSS}${computeBg(p)}border:${bw}px solid ${p.borderColor};border-radius:${borderRadius};opacity:${p.opacity};clip-path:${clipPath};"></div>\n`;
      }
      case 'codeblock':return`<pre style="${pos}${computeBg(p)}color:${p.textColor};font-size:${p.fontSize}px;border-radius:${p.borderRadius}px;padding:14px;font-family:${p.fontFamily||'monospace'};white-space:pre-wrap;word-break:break-all;">${escHtml(p.code)}</pre>\n`;
      case 'folderpanel':{
        const slides=p.slides||[];
        if(!slides.length)return'';
        const br=p.borderRadius||12;
        const align=p.textAlign||'center';
        const alignItems=align==='right'?'flex-end':align==='left'?'flex-start':'center';
        const w=el.w!=='auto'?el.w:1200;
        const h=Math.max(el.h||500,300);
        const containerH=slides.length*h;
        const uid='fp-'+el.id;
        const sw=Math.max(20,Math.min(100,p.startWidth!=null?p.startWidth:100));
        const slidesHtml=slides.map((s,i)=>{
          const bgStr=s.bgImage?`url('${s.bgImage}') center/cover no-repeat`:(s.bgColor||'#1a1a2e');
          return `<div class="${uid}-slide" data-idx="${i}" style="position:sticky;top:0;height:${h}px;background:${bgStr};border-radius:${br}px;overflow:hidden;display:flex;flex-direction:column;align-items:${alignItems};justify-content:center;padding:10% 8%;box-sizing:border-box;z-index:${i+1};transition:transform .6s cubic-bezier(.22,1,.36,1),opacity .4s,width .5s cubic-bezier(.22,1,.36,1);width:${sw<100?sw+'%':'100%'};margin:0 auto;">
  <div style="position:absolute;inset:0;background:${p.overlayColor||'rgba(0,0,0,0.35)'};"></div>
  <div style="position:relative;z-index:1;text-align:${align};">
    <div style="color:${p.titleColor||'#fff'};font-size:${p.titleSize||36}px;font-weight:700;margin-bottom:12px;line-height:1.15;">${escHtml(s.title)}</div>
    <div style="color:${p.bodyColor||'rgba(255,255,255,0.75)'};font-size:${p.bodySize||16}px;line-height:1.6;">${nl2br(escHtml(s.body))}</div>
  </div>
</div>`;
        }).join('\n');
        const fpScript=`<script>
(function(){
  var wrap=document.getElementById('${uid}');
  if(!wrap)return;
  var slides=wrap.querySelectorAll('.${uid}-slide');
  var sw=${sw};
  function upd(){
    var wr=wrap.getBoundingClientRect();
    for(var i=0;i<slides.length;i++){
      var sl=slides[i];
      var progress=Math.min(1,Math.max(0,-wr.top/${h}-i+1));
      if(i<slides.length-1){
        var out=Math.min(1,Math.max(0,-wr.top/${h}-i));
        sl.style.transform='scale('+(1-out*0.05)+')';
        sl.style.opacity=1-out*0.6;
      }
      if(sw<100){
        var inProg=Math.min(1,Math.max(0,(-wr.top/${h}-i+1)));
        var pct=sw+(100-sw)*inProg;
        sl.style.width=pct+'%';
      }
    }
  }
  window.addEventListener('scroll',upd,{passive:true});
  upd();
})();
<\/script>`;
        return `<div id="${uid}" style="${pos}height:${containerH}px;width:${w}px;overflow:clip;">\n${slidesHtml}\n</div>\n${fpScript}\n`;
      }

      case 'hscroll':{
        const items=p.items||[];
        const iW=p.itemW||260;
        const gap=p.gap||16;
        const uid='hs-'+el.id;
        const cardsHtml=items.map(it=>`
  <div style="flex:0 0 ${iW}px;background:${p.cardBg||'rgba(255,255,255,0.05)'};border:1px solid ${p.borderColor||'rgba(255,255,255,0.1)'};border-radius:${p.borderRadius||10}px;overflow:hidden;box-sizing:border-box;transition:transform .25s;">
    ${it.src?`<img src="${it.src}" alt="${escHtml(it.alt||it.title||'')}" style="width:100%;height:160px;object-fit:cover;display:block;" loading="lazy"/>`:``}
    <div style="padding:${p.padding||14}px;">
      <div style="color:${p.titleColor||'#e6edf3'};font-size:${p.titleSize||15}px;font-weight:600;margin-bottom:6px;line-height:1.3;">${escHtml(it.title||'')}</div>
      <div style="color:${p.bodyColor||'#8b949e'};font-size:${p.bodySize||12}px;line-height:1.6;">${nl2br(escHtml(it.body||''))}</div>
    </div>
  </div>`).join('');
        const scrollAttrHscroll=siType?` data-scroll-in="${siType}"${siDelay?' data-scroll-delay="'+siDelay+'"':''}`:'';;
        const hoverCSS=`#${uid}-track>div:hover{transform:translateY(-4px);}`;
        const hsAutoScript=p.autoScroll?`<script>
(function(){var t=document.getElementById('${uid}-track');if(!t)return;var sp=${Math.max(0.5,p.scrollSpeed||3)};var dir=1;function step(){t.scrollLeft+=dir*0.8;if(t.scrollLeft>=(t.scrollWidth-t.clientWidth)){dir=-1;}if(t.scrollLeft<=0){dir=1;} requestAnimationFrame(step);}step();})();
<\/script>`:'';
        return `<style>#${uid}-track::-webkit-scrollbar{height:4px;}#${uid}-track::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:2px;}${hoverCSS}</style>
<div style="${pos}"${scrollAttrHscroll}>
  <div id="${uid}-track" style="display:flex;gap:${gap}px;overflow-x:auto;padding:4px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.2) transparent;height:100%;box-sizing:border-box;">${cardsHtml}
  </div>
</div>${hsAutoScript}\n`;
      }

      case 'collage':{
        const imgs=p.images||[];
        const cols=Math.min(6,p.cols||3);
        const gap=p.gap||8;
        const uid='col-'+el.id;
        const hoverZoom=p.hoverEffect==='zoom'?`#${uid}>div:hover img{transform:scale(1.12);}#${uid}>div img{transition:transform .4s;}`:
                        p.hoverEffect==='darken'?`#${uid}>div:hover::after{content:'';position:absolute;inset:0;background:rgba(0,0,0,.35);border-radius:inherit;}`:'';;
        const imgsHtml=imgs.map(img=>`
  <div style="border-radius:${p.borderRadius||6}px;overflow:hidden;position:relative;">
    <img src="${img.src||''}" alt="${escHtml(img.alt||'')}" style="width:100%;height:100%;object-fit:${p.objectFit||'cover'};display:block;" loading="lazy"/>
  </div>`).join('');
        const scrollAttrColl=siType?` data-scroll-in="${siType}"${siDelay?' data-scroll-delay="'+siDelay+'"':''}`:'';;
        return `<style>${hoverZoom}</style>
<div id="${uid}" style="${pos}display:grid;grid-template-columns:repeat(${cols},1fr);gap:${gap}px;"${scrollAttrColl}>${imgsHtml}
</div>\n`;
      }

      case 'line':{
        const vert=p.orientation==='vertical';
        const t=p.thickness||2;
        const bg=p.gradient
          ? `linear-gradient(${p.gradientDir||'to right'},${p.color||'rgba(255,255,255,0.25)'},${p.gradientB||'rgba(100,100,100,0.15)'})`
          : (p.color||'rgba(255,255,255,0.25)');
        const glow=p.glowColor?`box-shadow:0 0 8px 2px ${p.glowColor};`:'';
        const scrollAttrLine=siType?` data-scroll-in="${siType}"${siDelay?' data-scroll-delay="'+siDelay+'"':''}`:'';;
        if(vert){
          return `<div style="${pos}width:${t}px;height:${el.h==='auto'?'100px':(el.h||100)}px;background:${bg};${glow}border-radius:2px;"${scrollAttrLine}></div>\n`;
        }
        const dashStyle=p.style==='dashed'?`background:repeating-linear-gradient(to right,${p.color||'rgba(255,255,255,0.25)'} 0px,${p.color||'rgba(255,255,255,0.25)'} 8px,transparent 8px,transparent 16px);`
          :p.style==='dotted'?`background:repeating-linear-gradient(to right,${p.color||'rgba(255,255,255,0.25)'} 0px,${p.color||'rgba(255,255,255,0.25)'} 3px,transparent 3px,transparent 8px);`:'';
        return `<div style="${pos}height:${t}px;background:${dashStyle||bg};${glow}border-radius:${t>4?t/2:0}px;"${scrollAttrLine}></div>\n`;
      }

      default:return'';
    }
  },

  contactScript(){return`<script>
function wcSendMail(formId,to){
  const f=document.getElementById(formId);
  const name=f.querySelector('[name=name]').value,email=f.querySelector('[name=email]').value,
        subject=f.querySelector('[name=subject]').value,message=f.querySelector('[name=message]').value;
  const body=encodeURIComponent((name?'From: '+name+(email?' <'+email+'>':'')+'\\n\\n':'')+message);
  window.location.href='mailto:'+to+'?subject='+encodeURIComponent(subject||'(No subject)')+'&body='+body;
}
<\/script>`;}
};

// ── Pages ─────────────────────────────────────────────────────
const Pages={
  render(){
    const list=document.getElementById('pages-list');list.innerHTML='';
    for(const page of State.project.pages){
      const div=document.createElement('div');
      div.className='page-item'+(page.id===State.project.currentPageId?' active':'');
      div.innerHTML=`<span>${escHtml(page.name)}</span><button class="page-item-del" onclick="Pages.delete('${page.id}');event.stopPropagation();">✕</button>`;
      div.addEventListener('click',()=>this.switchTo(page.id));
      div.addEventListener('dblclick',()=>this.rename(page.id));
      list.appendChild(div);
    }
  },
  switchTo(id){State.project.currentPageId=id;State.selectedElId=null;Canvas.renderAll();this.render();Props.renderNone();App.syncBgUI();App.syncCursorUI();},
  delete(id){
    if(State.project.pages.length<=1)return alert('Cannot delete the last page.');
    if(!confirm('Delete this page?'))return;
    State.project.pages=State.project.pages.filter(p=>p.id!==id);
    if(State.project.currentPageId===id)this.switchTo(State.project.pages[0].id);
    else this.render();State.dirty=true;
  },
  rename(id){const page=State.project.pages.find(p=>p.id===id);if(!page)return;const name=prompt('Page name:',page.name);if(name&&name.trim()){page.name=name.trim();this.render();State.dirty=true;}},
  add(){
    const name=prompt('New page name:','Page '+(State.project.pages.length+1));
    if(!name||!name.trim())return;
    const page={id:'page-'+Date.now(),name:name.trim(),background:{type:'solid',color:'#ad8d7b'},cursorType:'default',cursorColor:'#00ff41',elements:[]};
    State.project.pages.push(page);this.switchTo(page.id);State.dirty=true;
  },
};

// ── AiGen — Ollama / OpenAI ghost-element generation ─────────
const AiGen={
  _pending:[],        // ghost element objects waiting to be accepted
  _model:'qwen2.5-coder:7b',
  _apiKey:'',
  _ollamaBase:'http://localhost:11434',

  // ── Persistence ─────────────────────────────────────────────
  loadSettings(){
    try{
      this._model=localStorage.getItem('pdc_ai_model')||'qwen2.5-coder:7b';
      this._apiKey=localStorage.getItem('pdc_ai_key')||'';
    }catch(e){}
  },
  saveSettings(){
    try{
      localStorage.setItem('pdc_ai_model',this._model);
      localStorage.setItem('pdc_ai_key',this._apiKey);
    }catch(e){}
  },

  // ── Ollama detection ─────────────────────────────────────────
  // ── Ollama detection — routed via Tauri Rust (bypasses WebView2 localhost block) ──
  async checkOllama(){
    try{
      return await window.__TAURI__.core.invoke('ollama_check',{baseUrl:this._ollamaBase});
    }catch(e){return false;}
  },
  async getOllamaModels(){
    try{
      return await window.__TAURI__.core.invoke('ollama_models',{baseUrl:this._ollamaBase});
    }catch(e){return[];}
  },

  // ── Page context for the prompt ──────────────────────────────
  _buildContext(){
    const pg=State.currentPage;
    if(!pg)return{bgColor:'#0d1117',colors:[],fonts:[],elements:[],pageName:'Page'};
    const colors=new Set();
    const fonts=new Set();
    let bgColor='#0d1117';
    // Background layers
    if(pg.bgLayers&&pg.bgLayers[0]){
      const l=pg.bgLayers[0];
      if(l.color&&l.color.startsWith('#')){bgColor=l.color;colors.add(l.color);}
      if(l.colorA&&l.colorA.startsWith('#'))colors.add(l.colorA);
      if(l.colorB&&l.colorB.startsWith('#'))colors.add(l.colorB);
    }
    if(pg.background&&pg.background.color&&pg.background.color.startsWith('#'))bgColor=pg.background.color;
    // Elements
    const elSummary=[];
    for(const el of(pg.elements||[])){
      const p=el.props||{};
      const ff=(p.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim();
      if(ff&&ff!=='-apple-system'&&ff!=='BlinkMacSystemFont')fonts.add(ff);
      [p.color,p.titleColor,p.bodyColor,p.textColor].forEach(c=>{if(c&&c.startsWith('#'))colors.add(c);});
      if(p.bgColor&&p.bgColor.startsWith('#'))colors.add(p.bgColor);
      const label=(p.text||p.title||p.label||p.brand||'').slice(0,40);
      elSummary.push(el.type+(label?': "'+label+'"':''));
    }
    return{
      bgColor,
      colors:[...colors].filter(c=>c.startsWith('#')).slice(0,8),
      fonts:[...fonts].filter(Boolean).slice(0,4),
      elements:elSummary,
      pageName:pg.name||'Page',
    };
  },

  // ── Prompt engineering ───────────────────────────────────────
  _buildPrompt(userRequest){
    const ctx=this._buildContext();
    const bgNote=`Page background: ${ctx.bgColor}. All elements must contrast well against it.`;
    const colorNote=ctx.colors.length?`Colors already in use: ${ctx.colors.join(', ')}. Stay consistent or harmonious.`:'';
    const fontNote=ctx.fonts.length?`Fonts in use: ${ctx.fonts.join(', ')}. Be consistent.`:'';
    const existingNote=ctx.elements.length?`Existing elements on page: ${ctx.elements.join(' | ')}`:'Page is currently empty.';

    return `You are the JSON element generator for PageDotCom, a visual web page builder.
You output ONLY a raw JSON array. No markdown, no prose, no code fences — just the array.

PAGE CONTEXT:
${bgNote}
${colorNote}
${fontNote}
${existingNote}

ELEMENT SCHEMAS (use exactly these — omit x, y, id):

{"type":"heading","w":800,"h":"auto","props":{"text":"Your Title","level":"h2","color":"#e6edf3","fontSize":38,"fontWeight":"700","italic":false,"underline":false,"align":"left","letterSpacing":0,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"}}

{"type":"text","w":700,"h":"auto","props":{"text":"Body paragraph text.","color":"#8b949e","fontSize":14,"align":"left","lineHeight":1.7,"bold":false,"italic":false,"underline":false,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"}}

{"type":"panel","w":340,"h":"auto","props":{"title":"Card Title","body":"Supporting description text here.","bgColor":"rgba(255,255,255,0.05)","bgMode":"solid","bgGradB":"#000000","bgGradDir":"to right","borderColor":"rgba(255,255,255,0.1)","borderWidth":1,"borderRadius":8,"titleColor":"#e6edf3","bodyColor":"#8b949e","titleSize":16,"bodySize":13,"padding":20,"shadow":false,"shadowColor":"rgba(0,0,0,0.55)","gradientB":"","hoverScale":true,"shape":"normal","textAlign":"left","justify":false,"titleBold":true,"titleItalic":false,"titleUnderline":false,"bodyBold":false,"bodyItalic":false,"bodyUnderline":false,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif","titleFont":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif","scrollIn":false,"scrollInType":"scale","scrollInDelay":0}}

{"type":"button","w":"auto","h":"auto","props":{"label":"Get Started","linkMode":"url","href":"","pageTarget":"","sectionTarget":"","target":"_self","bgColor":"#1f6feb","bgMode":"solid","bgGradB":"#0d3a8f","bgGradDir":"to right","bgImage":"","textColor":"#ffffff","borderRadius":6,"fontSize":15,"paddingH":28,"paddingV":12,"bold":true,"italic":false,"underline":false,"shadow":false,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"}}

{"type":"navbar","w":1440,"h":"auto","props":{"brand":"My Site","navLinks":[],"bgColor":"rgba(0,0,0,0.7)","bgMode":"solid","bgGradB":"#1a1a2e","bgGradDir":"to right","textColor":"#e6edf3","sticky":true,"fullWidth":true,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"}}

{"type":"divider","w":900,"h":20,"props":{"color":"rgba(255,255,255,0.1)","thickness":1,"style":"solid","marginV":10}}

{"type":"table","w":1000,"h":"auto","props":{"cols":3,"rows":1,"gap":14,"cellBg":"rgba(255,255,255,0.04)","cellBgMode":"solid","cellBgGradB":"#000000","cellBgGradDir":"to right","cellBorder":"rgba(255,255,255,0.1)","borderRadius":8,"titleColor":"#e6edf3","bodyColor":"#8b949e","titleSize":14,"bodySize":12,"padding":18,"hoverScale":true,"cells":[{"title":"Feature A","body":"Description of this feature."},{"title":"Feature B","body":"Description of this feature."},{"title":"Feature C","body":"Description of this feature."}],"editingCell":0,"fontFamily":"-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"}}

{"type":"spacer","w":600,"h":60,"props":{"height":60}}

{"type":"contact","w":480,"h":"auto","props":{"title":"Get in Touch","email":"you@example.com","bgColor":"rgba(255,255,255,0.04)","bgMode":"solid","bgGradB":"#0d1117","bgGradDir":"to right","borderColor":"rgba(255,255,255,0.1)","borderRadius":8,"btnColor":"#238636","btnLabel":"Send Message"}}

{"type":"shape","w":200,"h":200,"props":{"form":"rectangle","bgColor":"rgba(255,255,255,0.06)","bgMode":"solid","bgGradB":"#4080ff","bgGradDir":"to right","borderColor":"rgba(255,255,255,0.15)","borderWidth":0,"borderRadius":12,"opacity":1,"shadow":false,"scrollIn":false,"scrollInType":"scale","scrollInDelay":0}}

RULES:
1. Return ONLY a JSON array: [{...}, {...}]
2. No x, y, or id fields — they are assigned automatically
3. Keep colors consistent with the existing page palette; adjust if page is empty
4. Generate 2–8 elements that together make a coherent section
5. For multiple cards side by side use a "table" element, not separate panels
6. Make all text content realistic and directly relevant to the user's request
7. For hero sections: typically navbar (if none exists), spacer, heading, text, button
8. Vary font sizes and weights to create visual hierarchy

USER REQUEST: ${userRequest}

JSON array:`;
  },

  // ── API calls — both routed through Rust to avoid WebView2 restrictions ─────
  async _callOllama(prompt){
    const result=await window.__TAURI__.core.invoke('ollama_generate',{
      baseUrl:this._ollamaBase,
      model:this._model,
      prompt,
    });
    return result||'';
  },
  async _callOpenAI(prompt){
    const result=await window.__TAURI__.core.invoke('openai_generate',{
      apiKey:this._apiKey,
      prompt,
    });
    return result||'';
  },

  // ── Parse JSON from raw model output ─────────────────────────
  _parseResponse(raw){
    let s=raw.trim()
      .replace(/^```(?:json)?[\r\n]*/,'')
      .replace(/[\r\n]*```$/,'')
      .trim();
    const a=s.indexOf('['),b=s.lastIndexOf(']');
    if(a===-1||b===-1)throw new Error('No JSON array in model response');
    s=s.slice(a,b+1);
    const arr=JSON.parse(s);
    if(!Array.isArray(arr))throw new Error('Parsed value is not an array');
    return arr;
  },

  // ── Ghost rendering ──────────────────────────────────────────
  _placeGhosts(rawElements){
    this.rejectAll();// clear any previous ghosts
    const pg=State.currentPage;if(!pg)return;
    // Start below all existing elements
    let maxY=80;
    for(const el of(pg.elements||[])){
      const div=document.querySelector(`[data-id="${el.id}"]`);
      const h=div?div.offsetHeight:(el.h==='auto'?100:Number(el.h)||100);
      maxY=Math.max(maxY,el.y+h+24);
    }
    let cursor=maxY;
    for(const raw of rawElements){
      if(!raw||!raw.type||!DEFAULTS[raw.type])continue;
      // Build from DEFAULTS so ALL props are present, then overlay AI props
      const base=DEFAULTS[raw.type](170,cursor);
      const ghost={
        ...base,
        id:State.newId(),
        x:170,
        y:cursor,
        w:raw.w!==undefined?raw.w:base.w,
        h:raw.h!==undefined?raw.h:base.h,
        props:{...base.props,...(raw.props||{})},
        _ghost:true,
      };
      this._pending.push(ghost);
      const estH=typeof ghost.h==='number'?ghost.h:120;
      cursor+=estH+22;
    }
    if(!this._pending.length)throw new Error('No valid element types in response');
    this._renderGhosts();
  },

  _renderGhosts(){
    document.querySelectorAll('.el-ghost').forEach(n=>n.remove());
    if(!this._pending.length){this._setBar(0);return;}
    const layer=document.getElementById('elements-layer');
    for(const el of this._pending){
      const div=document.createElement('div');
      div.className='el el-ghost';
      div.dataset.id=el.id;
      div.dataset.type=el.type;
      div.style.cssText=`left:${el.x}px;top:${el.y}px;${el.w!=='auto'?'width:'+el.w+'px;':''}${el.h!=='auto'&&el.h?'height:'+el.h+'px;':''}`;
      div.innerHTML=Canvas.renderInner(el);
      div.addEventListener('click',e=>{e.stopPropagation();this.acceptOne(el.id);});
      layer.appendChild(div);
    }
    this._setBar(this._pending.length);
    Canvas.updateHeight();
  },

  _setBar(n){
    const bar=document.getElementById('ghost-bar');
    const cnt=document.getElementById('ghost-count');
    const pl=document.getElementById('ghost-plural');
    if(!bar)return;
    if(n===0){bar.classList.add('hidden');return;}
    if(cnt)cnt.textContent=n;
    if(pl)pl.textContent=n===1?'':'s';
    bar.classList.remove('hidden');
  },

  acceptAll(){
    if(!this._pending.length)return;
    History.save();
    for(const el of this._pending){
      const clean={...el};delete clean._ghost;
      State.elements.push(clean);
    }
    this._pending=[];
    document.querySelectorAll('.el-ghost').forEach(n=>n.remove());
    this._setBar(0);
    Canvas.renderAll();
    State.dirty=true;
  },

  rejectAll(){
    this._pending=[];
    document.querySelectorAll('.el-ghost').forEach(n=>n.remove());
    this._setBar(0);
  },

  acceptOne(id){
    const idx=this._pending.findIndex(e=>e.id===id);
    if(idx===-1)return;
    History.save();
    const el={...this._pending[idx]};delete el._ghost;
    State.elements.push(el);
    this._pending.splice(idx,1);
    document.querySelector(`.el-ghost[data-id="${id}"]`)?.remove();
    Canvas.renderEl(el);
    Canvas.updateHeight();
    State.dirty=true;
    this._setBar(this._pending.length);
  },

  // ── Main generate entry point ────────────────────────────────
  async generate(userPrompt){
    userPrompt=(userPrompt||'').trim();
    if(!userPrompt)return;
    const btn=document.getElementById('ai-gen-btn');
    const statusEl=document.getElementById('ai-gen-status');
    const setStatus=(msg,color)=>{
      if(statusEl){statusEl.textContent=msg;statusEl.style.color=color||'var(--muted)';}
    };
    if(btn){btn.disabled=true;btn.textContent='⏳ Thinking…';}
    setStatus('Contacting AI…');
    try{
      const fullPrompt=this._buildPrompt(userPrompt);
      let raw='';
      const ollamaOk=await this.checkOllama();
      if(ollamaOk){
        setStatus('Generating with Ollama ('+this._model+')…');
        raw=await this._callOllama(fullPrompt);
      }else if(this._apiKey){
        setStatus('Ollama offline — using OpenAI key…');
        raw=await this._callOpenAI(fullPrompt);
      }else{
        setStatus('⚠ Ollama not found. Install it or add an API key via ⚙ Setup.','#da3633');
        if(btn){btn.disabled=false;btn.textContent='✦ Generate  Ctrl+Enter';}
        return;
      }
      const elements=this._parseResponse(raw);
      this._placeGhosts(elements);
      setStatus(`✦ ${this._pending.length} suggestion${this._pending.length===1?'':'s'} ready — press Enter to accept all, or click individually`,'#3fb950');
    }catch(err){
      setStatus('⚠ '+( err.message||'Generation failed'),'#da3633');
      console.error('AiGen error:',err);
    }
    if(btn){btn.disabled=false;btn.textContent='✦ Generate  Ctrl+Enter';}
  },

  // ── Settings modal ───────────────────────────────────────────
  async openSettings(){
    document.getElementById('ai-settings-overlay').classList.remove('hidden');
    document.getElementById('ai-settings-model').value=this._model;
    document.getElementById('ai-settings-key').value=this._apiKey;
    const statusEl=document.getElementById('ai-ollama-status');
    const modelListEl=document.getElementById('ai-model-list');
    if(statusEl)statusEl.textContent='Checking Ollama…';
    const ok=await this.checkOllama();
    if(statusEl){
      statusEl.textContent=ok?'✓ Ollama is running on localhost:11434':'✗ Ollama not detected — install from ollama.com';
      statusEl.style.color=ok?'#3fb950':'#da3633';
    }
    if(ok){
      const models=await this.getOllamaModels();
      if(modelListEl&&models.length)
        modelListEl.innerHTML='Installed models: <strong style="color:var(--text);">'+models.join('&nbsp;&nbsp;·&nbsp;&nbsp;')+'</strong>';
      else if(modelListEl)
        modelListEl.innerHTML='No models installed yet. Run: <code>ollama pull qwen2.5-coder:7b</code>';
    }else if(modelListEl){
      modelListEl.innerHTML='Get Ollama free at <strong>ollama.com</strong>, then run: <code>ollama pull qwen2.5-coder:7b</code>';
    }
  },
  saveSettingsFromModal(){
    this._model=document.getElementById('ai-settings-model').value.trim()||'qwen2.5-coder:7b';
    this._apiKey=document.getElementById('ai-settings-key').value.trim();
    this.saveSettings();
    document.getElementById('ai-settings-overlay').classList.add('hidden');
    document.getElementById('ai-gen-status').textContent='Settings saved.';
  },
};

// ── Prevision — Smart Design Suggestions ─────────────────────
const Prevision={
  _toast:null,
  _timer:null,

  analyze(newEl){
    const els=State.elements;
    const suggestions=[];
    const PAGE_W=1440;
    const elW=typeof newEl.w==='number'?newEl.w:300;
    const elCenterX=newEl.x+elW/2;
    const pageCenterX=PAGE_W/2;

    // 1. Symmetry — suggest for ANY panel/image/shape/text placed off-center
    const SYMM_TYPES=['panel','image','shape','heading','text','codeblock'];
    if(SYMM_TYPES.includes(newEl.type)){
      const mirrorX=PAGE_W-newEl.x-elW;
      // Only suggest if there's not already something near the mirror position
      const alreadyMirrored=els.some(e=>e!==newEl&&Math.abs(e.x-mirrorX)<elW*0.6&&Math.abs(e.y-newEl.y)<80);
      // Only suggest if element is meaningfully off-center (not a full-width element)
      const isOffCenter=Math.abs(elCenterX-pageCenterX)>80 && elW<1000;
      if(isOffCenter && !alreadyMirrored){
        suggestions.push({icon:'⟺',label:`Mirror symmetrically on ${elCenterX<pageCenterX?'right':'left'} side`,action:()=>this._mirrorEl(newEl)});
      }
    }

    // 2. Gap detection — large empty vertical space between groups of elements
    const ys=els.filter(e=>e.y>0).map(e=>e.y).sort((a,b)=>a-b);
    for(let i=0;i<ys.length-1;i++){
      const gap=ys[i+1]-ys[i];
      if(gap>350&&ys[i]>100){
        suggestions.push({icon:'▭',label:`Large gap detected — add a panel or H-Scroll card strip to fill it`,action:()=>Canvas.placeElement('hscroll',170,ys[i]+60)});
        break;
      }
    }

    // 3. Heterogeneity — if 3+ same-type elements dominate
    const typeCounts={};
    for(const e of els) typeCounts[e.type]=(typeCounts[e.type]||0)+1;
    const dominant=Object.entries(typeCounts).filter(([t])=>t!=='spacer'&&t!=='divider'&&t!=='section').sort((a,b)=>b[1]-a[1])[0];
    if(dominant&&dominant[1]>=3){
      suggestions.push({icon:'✦',label:`${dominant[1]} ${dominant[0]}s — add variety: try a collage, folder panel, or shape`,action:()=>Canvas.placeElement('collage',170,newEl.y+300)});
    }

    // 4. Animation nudge
    if(newEl.props&&newEl.props.scrollIn===false&&['panel','image','heading','table','hscroll','collage'].includes(newEl.type)){
      suggestions.push({icon:'🎬',label:'Add a scroll-in animation to this element',action:()=>{const e=State.getEl(newEl.id);if(e){e.props.scrollIn=true;e.props.scrollInType='fade';Canvas.updateElDOM(e);State.dirty=true;Props.render(e.id);Prevision.dismiss();}}});
    }

    // 5. Gradient suggestion for solid panels
    if(newEl.type==='panel'&&newEl.props.bgMode==='solid'){
      suggestions.push({icon:'◐',label:'Upgrade to gradient background for more depth',action:()=>{const e=State.getEl(newEl.id);if(e){e.props.bgMode='gradient';Canvas.updateElDOM(e);State.dirty=true;Props.render(e.id);Prevision.dismiss();}}});
    }

    // 6. Line after heading
    if(newEl.type==='heading'){
      suggestions.push({icon:'—',label:'Add a decorative accent line beneath this heading',action:()=>Canvas.placeElement('line',newEl.x,newEl.y+(typeof newEl.h==='number'?newEl.h:50)+8)});
    }

    // 7. Table/grid after standalone text+heading combo
    if(newEl.type==='text'){
      const nearbyHeadings=els.filter(e=>e.type==='heading'&&Math.abs(e.y-newEl.y)<200);
      if(nearbyHeadings.length>=1&&!els.some(e=>e.type==='table'&&Math.abs(e.y-newEl.y)<400)){
        suggestions.push({icon:'⊞',label:'Add a feature table below this text section',action:()=>Canvas.placeElement('table',170,newEl.y+180)});
      }
    }

    if(suggestions.length>0) this._show(suggestions);
  },

  _mirrorEl(el){
    const clone=JSON.parse(JSON.stringify(el));
    clone.id=State.newId();
    const w=typeof el.w==='number'?el.w:300;
    clone.x=1440-el.x-w;
    State.elements.push(clone);
    Canvas.renderEl(clone);
    Canvas.updateHeight();
    State.dirty=true;
    this.dismiss();
  },

  _show(suggestions){
    this.dismiss();
    const bar=document.getElementById('prevision-bar');
    if(!bar)return;
    bar.innerHTML=`<span style="font-size:10px;font-weight:700;color:#a371f7;margin-right:8px;white-space:nowrap;">✦ Suggestions</span>`
      +suggestions.slice(0,4).map((s,i)=>`<button onclick="Prevision._act(${i})" style="flex-shrink:0;padding:4px 10px;border-radius:5px;border:1px solid rgba(163,113,247,.3);background:rgba(163,113,247,.08);color:#c9d1d9;font-size:10px;cursor:pointer;white-space:nowrap;" onmouseover="this.style.background='rgba(163,113,247,.2)'" onmouseout="this.style.background='rgba(163,113,247,.08)'">${s.icon} ${s.label}</button>`).join('')
      +`<button onclick="Prevision.dismiss()" style="margin-left:auto;flex-shrink:0;padding:4px 8px;border-radius:5px;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.4);font-size:10px;cursor:pointer;">✕</button>`;
    this._current=suggestions;
    bar.classList.remove('hidden');
    this._timer=setTimeout(()=>this.dismiss(),12000);
  },

  _act(i){
    if(this._current&&this._current[i]) this._current[i].action();
    this.dismiss();
  },

  dismiss(){
    const bar=document.getElementById('prevision-bar');
    if(bar)bar.classList.add('hidden');
    if(this._timer){clearTimeout(this._timer);this._timer=null;}
    this._current=null;
  },
};

// ── Templates — startup project picker ───────────────────────
const Templates={
  // Placeholder photo CDNs
  P(seed,w,h){return`https://picsum.photos/seed/${seed}/${w}/${h}`;},
  F(n){return`https://i.pravatar.cc/400?img=${n}`;},

  showPicker(){
    document.getElementById('tmpl-overlay').classList.remove('hidden');
  },
  closePicker(){
    document.getElementById('tmpl-overlay').classList.add('hidden');
  },
  startBlank(){
    this.closePicker();
    State.project={name:'Untitled Project',pages:[{id:'page-1',name:'Home',background:{type:'solid',color:'#0d1117'},cursorType:'default',cursorColor:'#00ff41',elements:[]}],currentPageId:'page-1'};
    State.selectedElId=null;State.selectedTool=null;State.nextId=1;State.dirty=false;
    document.getElementById('project-name-display').textContent=State.project.name;
    document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));
    History.clear();Pages.render();Canvas.renderAll();Props.renderNone();App.syncBgUI();App.syncCursorUI();
  },
  load(name){
    this.closePicker();
    const tmpl=this._templates[name];
    if(!tmpl){App.newProject(true);return;}
    // Deep-clone and assign ids
    State.nextId=1;
    const project=JSON.parse(JSON.stringify(tmpl));
    // Re-assign all element ids to avoid collisions
    for(const page of project.pages){
      page.id='page-'+Math.random().toString(36).slice(2);
      for(const el of page.elements){
        el.id=State.newId();
      }
    }
    project.currentPageId=project.pages[0].id;
    State.project=project;
    State.dirty=false;
    document.getElementById('project-name-display').textContent=project.name;
    History.clear();
    Pages.render();Canvas.renderAll();Props.renderNone();App.syncBgUI();App.syncCursorUI();
  },

  // ── Template definitions ─────────────────────────────────────
  get _templates(){
    // ── SVG image generator: vivid solid-to-solid CSS gradients ──
    const _s=(w,h,c1,c2,c3,lbl,angle)=>{
      const a=angle||'135';
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>`+
        `<linearGradient id="g" x1="0%" y1="0%" x2="${Math.round(Math.cos(a*Math.PI/180)*100)}%" y2="${Math.round(Math.sin(a*Math.PI/180)*100)}%">`+
        `<stop offset="0%" stop-color="${c1}"/>`+
        `<stop offset="55%" stop-color="${c2||c1}"/>`+
        `<stop offset="100%" stop-color="${c3||c2||c1}"/>`+
        `</linearGradient></defs>`+
        `<rect width="${w}" height="${h}" fill="url(#g)"/>`+
        (lbl?`<text x="${w>>1}" y="${h>>1}" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,0.32)" font-size="${Math.min(20,Math.max(10,w/22))|0}" font-family="sans-serif">${lbl}</text>`:'')
        +`</svg>`;
      return 'data:image/svg+xml,'+encodeURIComponent(svg);
    };

    // Named image slots
    const P={
      // Hero banners — wide
      h_blue:    _s(1440,640,'#0f1b3d','#1d3a9a','#2563eb','',90),
      h_green:   _s(1440,640,'#052e16','#15803d','#16a34a','',90),
      h_amber:   _s(1440,640,'#431407','#c2410c','#ea580c','',90),
      h_purple:  _s(1440,640,'#1e0533','#6d28d9','#9333ea','',90),
      h_coral:   _s(1440,640,'#450a0a','#e11d48','#f97316','',90),
      h_teal:    _s(1440,640,'#042f2e','#0f766e','#14b8a6','',90),
      h_dark:    _s(1440,640,'#09090b','#18181b','#27272a','',135),
      h_neon:    _s(1440,640,'#050508','#3b0764','#1e1b4b','',135),
      h_news:    _s(1440,640,'#f5f0e8','#e8dcc8','#d4c4a0','',90),
      h_fire:    _s(1440,640,'#0a0000','#300010','#1a0005','',135),
      // Portraits / people — real Unsplash photos
      p1: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&h=500&fit=crop&crop=face',
      p2: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=500&fit=crop&crop=face',
      p3: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&h=500&fit=crop&crop=face',
      p4: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&h=500&fit=crop&crop=face',
      p5: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400&h=500&fit=crop&crop=face',
      p6: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400&h=500&fit=crop&crop=face',
      // Project / work cards — real Unsplash photos
      w1: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=640&h=420&fit=crop',
      w2: 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=640&h=420&fit=crop',
      w3: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=640&h=420&fit=crop',
      w4: 'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=640&h=420&fit=crop',
      // Collage tiles
      c0: _s(500,380,'#1e1b4b','#312e81','#4338ca',''),
      c1: _s(500,380,'#1e3a5f','#1e40af','#3b82f6',''),
      c2: _s(500,380,'#042f2e','#0f766e','#14b8a6',''),
      c3: _s(500,380,'#2e1065','#7c3aed','#a855f7',''),
      c4: _s(500,380,'#450a0a','#991b1b','#ef4444',''),
      c5: _s(500,380,'#052e16','#166534','#22c55e',''),
      c6: _s(500,380,'#1c1917','#44403c','#a8a29e',''),
      c7: _s(500,380,'#1e1b4b','#3730a3','#6366f1',''),
      c8: _s(500,380,'#18181b','#3f3f46','#71717a',''),
      // HScroll cards — real Unsplash photos
      h0: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=380&h=200&fit=crop',
      h1: 'https://images.unsplash.com/photo-1511884642898-4c92249e20b6?w=380&h=200&fit=crop',
      h2: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=380&h=200&fit=crop',
      h3: 'https://images.unsplash.com/photo-1476611317561-60117649dd94?w=380&h=200&fit=crop',
      h4: 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=380&h=200&fit=crop',
      h5: 'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=380&h=200&fit=crop',
      h6: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=380&h=200&fit=crop',
      h7: 'https://images.unsplash.com/photo-1486325212027-8081e485255e?w=380&h=200&fit=crop',
    };

    // ── Helpers ──────────────────────────────────────────────────
    const DYN=(idx,ca,cb,cc)=>({type:'dynamic',effectIndex:idx,colorA:ca,colorB:cb,colorC:cc});
    const SOL=(c)=>({type:'solid',color:c});
    const GRAD=(ca,cb,dir)=>({type:'gradient',colorA:ca,colorB:cb,dir:dir||'to bottom'});
    const PL=(l,pt)=>({label:l,target:'',pageTarget:pt});
    const SL=(l,t)=>({label:l,target:t,pageTarget:''});
    const NB=(brand,links,bg,tc,hFont)=>({type:'navbar',x:0,y:0,w:1440,h:'auto',props:{
      brand,navLinks:links,bgColor:bg||'rgba(0,0,0,0.85)',bgMode:'solid',
      bgGradB:'#000000',bgGradDir:'to right',textColor:tc||'#ffffff',
      sticky:true,fullWidth:true,fontFamily:hFont||FONTS[0].val}});
    const BTN=(label,mode,dest,x,y,bg,tc,gradB,gradDir,radius,shadow)=>{
      const p={label,linkMode:mode,href:'',pageTarget:'',sectionTarget:'',target:'_self',
        bgColor:bg,bgMode:gradB?'gradient':'solid',bgGradB:gradB||bg,bgGradDir:gradDir||'to right',bgImage:'',
        textColor:tc,borderRadius:radius||8,fontSize:14,paddingH:26,paddingV:12,
        bold:true,italic:false,underline:false,shadow:shadow!==false,fontFamily:FONTS[0].val};
      if(mode==='page') p.pageTarget=dest;
      else if(mode==='section') p.sectionTarget=dest;
      else if(mode==='url') p.href=dest||'';
      return{type:'button',x,y,w:'auto',h:'auto',props:p};
    };
    const H=(text,level,color,x,y,size,weight,hFont,scrollIn,siType,siDelay)=>({
      type:'heading',x,y,w:1300,h:'auto',props:{text,level:level||'h2',color,
        fontSize:size||32,fontWeight:weight||'700',italic:false,underline:false,
        align:'left',letterSpacing:size>55?-2:size>38?-1:0,
        fontFamily:hFont||FONTS[0].val,
        scrollIn:!!scrollIn,scrollInType:siType||'fade',scrollInDelay:siDelay||0}});
    const TX=(text,color,x,y,w,size,align,bFont)=>({type:'text',x,y,w,h:'auto',props:{
      text,color,fontSize:size||14,align:align||'left',lineHeight:1.8,
      bold:false,italic:false,underline:false,fontFamily:bFont||FONTS[0].val}});
    const SP=(y,h)=>({type:'spacer',x:0,y,w:100,h,props:{height:h}});
    const SEC=(name,y)=>({type:'section',x:0,y,w:1440,h:1,props:{name}});
    const LN=(x,y,w,c1,c2,style,thick)=>({type:'line',x,y,w,h:4,props:{
      orientation:'horizontal',color:c1,thickness:thick||2,style:style||'solid',
      gradient:!!(c2&&c2!==c1),gradientB:c2||c1,gradientDir:'to right',
      glowColor:'',scrollIn:false,scrollInType:'fade',scrollInDelay:0}});

    // PNL — no dead params, texture-ready
    const PNL=(title,body,x,y,w,h,bgColor,bgMode,bgGradB,bgGradDir,bc,bw,radius,titleColor,bodyColor,titleSize,bodySize,padding,hoverScale,scrollIn,siType,siDelay,extra)=>{
      const base={title,body,bgColor,bgMode:bgMode||'solid',bgGradB:bgGradB||bgColor,bgGradDir:bgGradDir||'to bottom',
        borderColor:bc||'rgba(255,255,255,0.1)',borderWidth:typeof bw==='number'?bw:1,
        borderRadius:typeof radius==='number'?radius:10,
        titleColor:titleColor||'#e6edf3',bodyColor:bodyColor||'#8b949e',
        titleSize:titleSize||15,bodySize:bodySize||13,padding:padding||20,
        shadow:false,hoverScale:hoverScale!==false,shape:'normal',textAlign:'left',
        titleBold:true,titleItalic:false,titleUnderline:false,
        bodyBold:false,bodyItalic:false,bodyUnderline:false,
        fontFamily:FONTS[0].val,titleFont:FONTS[0].val,
        scrollIn:!!scrollIn,scrollInType:siType||'scale',scrollInDelay:siDelay||0};
      return{type:'panel',x,y,w,h:h||'auto',props:Object.assign(base,extra||{})};
    };
    const PNLT=(title,body,x,y,w,h,texture,c1,c2,bc,bw,radius,titleColor,bodyColor,titleSize,bodySize,padding,scrollIn,siType,siDelay,extra)=>{
      return PNL(title,body,x,y,w,h,c1,'texture',c2,c1,bc,bw,radius,titleColor,bodyColor,titleSize,bodySize,padding,true,scrollIn,siType,siDelay,
        Object.assign({bgTexture:texture,bgTexColor1:c1,bgTexColor2:c2},extra||{}));
    };
    const CON=(x,y,w,email,btnBg,btnTc,bgColor,bgGradB,bc,radius,inputBg,textColor,btnLabel,bFont)=>({
      type:'contact',x,y,w,h:'auto',props:{title:'',email,
        textColor:textColor||'#e6edf3',inputBg:inputBg||'rgba(0,0,0,0.45)',
        bgColor,bgMode:'solid',bgGradB:bgGradB||bgColor,bgGradDir:'to right',
        borderColor:bc,borderRadius:radius||10,
        btnColor:btnBg,btnTextColor:btnTc,btnLabel:btnLabel||'Send Message →',
        fontFamily:bFont||FONTS[0].val}});
    const TBL=(x,y,w,cols,rows,cells,cellBg,cellBorder,titleColor,bodyColor,titleSize,bodySize,radius,gap,scrollIn,siType,tFont,bFont)=>({
      type:'table',x,y,w,h:'auto',props:{cols,rows,gap:gap||14,cellBg,
        cellBgMode:'solid',cellBgGradB:cellBg,cellBgGradDir:'to right',
        cellBorder,contourMode:'all',borderRadius:radius||8,
        titleColor,bodyColor,titleSize:titleSize||14,bodySize:bodySize||12,
        padding:18,hoverScale:true,showGrid:false,matrixBg:false,
        cells,editingCell:0,fontFamily:bFont||tFont||FONTS[0].val,
        scrollIn:!!scrollIn,scrollInType:siType||'slide-up',scrollInDelay:0}});
    const IMG=(src,alt,x,y,w,h,radius,border,bc,bw,shape,shadow,hoverZoom,scrollIn,siType,siDelay)=>({
      type:'image',x,y,w,h,props:{src,alt,objectFit:'cover',borderRadius:radius||0,
        border:!!border,borderColor:bc||'transparent',borderWidth:bw||0,
        imageShape:shape||'none',shadow:!!shadow,hoverZoom:!!hoverZoom,
        imgPosX:50,imgPosY:50,imgZoom:1,
        scrollIn:!!scrollIn,scrollInType:siType||'fade',scrollInDelay:siDelay||0}});
    const SHP=(form,x,y,w,h,bg,bgMode,bgGradB,bgGradDir,bc,bw,radius,opacity,shadow,scrollIn,siType)=>({
      type:'shape',x,y,w,h,props:{form,bgColor:bg,bgMode:bgMode||'solid',bgGradB:bgGradB||bg,
        bgGradDir:bgGradDir||'to right',borderColor:bc||'transparent',borderWidth:bw||0,
        borderRadius:radius||0,opacity:opacity||1,shadow:!!shadow,
        scrollIn:!!scrollIn,scrollInType:siType||'scale',scrollInDelay:0}});
    const HSCR=(x,y,w,h,items,itemW,cardBg,bc,titleColor,bodyColor,arrowColor,autoScroll,scrollSpeed,scrollIn,siType,tFont,bFont)=>({
      type:'hscroll',x,y,w,h,props:{items,itemW,gap:16,cardBg,borderColor:bc,
        borderRadius:10,titleColor,bodyColor,titleSize:14,bodySize:12,padding:18,
        showArrows:true,arrowColor,autoScroll:!!autoScroll,scrollSpeed:scrollSpeed||2,
        fontFamily:bFont||tFont||FONTS[0].val,
        scrollIn:!!scrollIn,scrollInType:siType||'fade',scrollInDelay:0}});

    // Short helpers
    const DIV=(yl,yr,curve)=>({yLeft:yl,yRight:yr,curve:curve||0});

return {

// ══════════════════════════════════════════════════════════════════
// PORTFOLIO — theme: Midnight (indigo/violet, Inter+Playfair)
// ══════════════════════════════════════════════════════════════════
portfolio:{name:'Portfolio Site',pages:[
{id:'pf1',name:'Home',bgScrollMode:'fixed',
 bgLayers:[DYN(0,'#4f8ef7','#080b18','#a78bfa')],bgDividers:[DIV(88,78,24)],
 cursorType:'ring',cursorColor:'#a78bfa',elements:[
  NB('Alex Morgan',[PL('Work','Work'),PL('About','About'),PL('Contact','Contact')],'rgba(8,11,24,0.9)','#c9d1d9','Inter,sans-serif'),
  SP(0,80),
  H('Creative Designer\n& Developer','h1','#ffffff',80,110,62,'900','Playfair Display,Georgia,serif',true,'splash'),
  LN(80,364,560,'#4f8ef7','#a78bfa','solid',3),
  TX('Crafting interfaces that feel inevitable. Freelance projects, design systems, full-stack development.','rgba(180,195,230,0.9)',80,392,560,16,'left','Inter,sans-serif'),
  BTN('See My Work →','page','Work',80,472,'#4f8ef7','#ffffff','#1d3a9a','to right',10,true),
  BTN('Get in Touch','page','Contact',316,472,'rgba(30,40,100,0.5)','#a78bfa','rgba(15,20,60,0.5)','to right',10,false),
  IMG(P.p1,'Alex Morgan',860,80,320,340,160,true,'#4f8ef7',3,'circle',true,true,true,'splash',0.2),
  SP(570,40),
  TBL(80,626,1280,4,1,[
    {title:'5+',body:'Years experience'},{title:'60+',body:'Projects shipped'},
    {title:'18',body:'Active clients'},{title:'4.9 ★',body:'Average rating'},
  ],'rgba(79,142,247,0.12)','rgba(79,142,247,0.35)','#a78bfa','rgba(160,180,240,0.85)',36,12,8,16,true,'slide-up','Playfair Display,Georgia,serif','Inter,sans-serif'),
  SP(810,40),
  BTN('See All Work →','page','Work',570,860,'#4f8ef7','#ffffff','#1d3a9a','to right',10,true),
]},

{id:'pf2',name:'Work',bgScrollMode:'fixed',
 bgLayers:[DYN(11,'#34d399','#030a08','#4f8ef7')],bgDividers:[DIV(92,80,18)],
 cursorType:'ring',cursorColor:'#34d399',elements:[
  NB('Alex Morgan',[PL('Home','Home'),PL('About','About'),PL('Contact','Contact')],'rgba(3,10,8,0.92)','#c9d1d9','Inter,sans-serif'),
  SP(0,80),
  H('Selected Work','h1','#ffffff',80,110,56,'900','Playfair Display,Georgia,serif',true,'fade'),
  LN(80,176,700,'#34d399','#4f8ef7','solid',3),
  TX('Recent projects spanning fintech analytics, brand identity, and mobile UX.','rgba(160,220,185,0.9)',80,204,700,15,'left','Inter,sans-serif'),
  SP(250,20),
  IMG(P.w1,'Analytics Dashboard',80,284,620,400,12,true,'rgba(52,211,153,0.45)',2,'none',true,true,true,'scale',0),
  H('Analytics Dashboard','h3','#86efac',758,284,26,'700','Inter,sans-serif',true,'slide-left',null,60),
  LN(758,326,460,'#34d399','#4f8ef7','solid',2),
  TX('Real-time fintech platform. React + D3 + WebSocket. 40k daily active users. 3× faster load.','rgba(160,220,185,0.82)',758,352,460,13,'left','Inter,sans-serif'),
  BTN('View Case Study →','url','',758,440,'rgba(52,211,153,0.15)','#86efac','rgba(20,100,60,0.15)','to right',8,false),
  SP(726,20),
  IMG(P.w2,'Brand Identity',80,776,620,360,12,true,'rgba(52,211,153,0.45)',2,'none',true,true,true,'scale',0),
  H('Brand Identity System','h3','#86efac',758,776,26,'700','Inter,sans-serif',true,'slide-left',null,60),
  LN(758,816,460,'#34d399','#4f8ef7','solid',2),
  TX('Full visual identity for a SaaS startup — logo, typography, colour palette, motion library.','rgba(160,220,185,0.82)',758,842,460,13,'left','Inter,sans-serif'),
  BTN('View Case Study →','url','',758,930,'rgba(52,211,153,0.15)','#86efac','rgba(20,100,60,0.15)','to right',8,false),
  SP(1170,40),
  BTN('Contact Me →','page','Contact',560,1220,'#34d399','#030a08','#0d7a4a','to right',8,true),
]},

{id:'pf3',name:'About',bgScrollMode:'fixed',
 bgLayers:[DYN(9,'#4f8ef7','#04040f','#a78bfa')],bgDividers:[DIV(50,65,30)],
 cursorType:'ring',cursorColor:'#a78bfa',elements:[
  NB('Alex Morgan',[PL('Home','Home'),PL('Work','Work'),PL('Contact','Contact')],'rgba(4,4,15,0.92)','#c9d1d9','Inter,sans-serif'),
  SP(0,80),
  IMG(P.p1,'Alex',860,90,300,320,150,true,'rgba(167,139,250,0.6)',3,'circle',true,false,true,'splash',0),
  H('About Me','h1','#ffffff',80,110,56,'900','Playfair Display,Georgia,serif',true,'fade'),
  LN(80,176,500,'#a78bfa','#4f8ef7','solid',3),
  TX("Five years at the intersection of design and engineering. I care about speed, clarity, and craft.",'rgba(190,185,230,0.9)',80,202,660,15,'left','Inter,sans-serif'),
  TX("When I'm not at the keyboard: hiking, 3D printing, and the perfect espresso.",'rgba(160,155,200,0.8)',80,300,620,14,'left','Inter,sans-serif'),
  SP(380,20),
  H('My Process','h2','#e6edf3',80,420,38,'800','Playfair Display,Georgia,serif',true,'slide-up'),
  TBL(80,470,1260,4,1,[
    {title:'1 · Discover',body:'Research, interviews, KPI definition.'},
    {title:'2 · Define',body:'Problem framing, user journeys, success metrics.'},
    {title:'3 · Design',body:'Wireframes → prototypes → high-fidelity.'},
    {title:'4 · Deliver',body:'Engineering review, QA, handoff, iteration.'},
  ],'rgba(167,139,250,0.12)','rgba(167,139,250,0.35)','#a78bfa','rgba(190,185,230,0.88)',13,12,8,14,true,'slide-up','Playfair Display,Georgia,serif','Inter,sans-serif'),
  SP(680,40),
  BTN('See My Work →','page','Work',80,730,'#a78bfa','#04040f','#4c1d95','to right',8,true),
  BTN('Get in Touch →','page','Contact',298,730,'rgba(30,15,80,0.5)','#a78bfa','rgba(20,5,60,0.5)','to right',8,false),
]},

{id:'pf4',name:'Contact',bgScrollMode:'fixed',
 bgLayers:[DYN(5,'#4f8ef7','#03050f','#34d399')],bgDividers:[DIV(55,45,20)],
 cursorType:'ring',cursorColor:'#4f8ef7',elements:[
  NB('Alex Morgan',[PL('Home','Home'),PL('Work','Work'),PL('About','About')],'rgba(3,5,15,0.92)','#c9d1d9','Inter,sans-serif'),
  SP(0,100),
  H("Let's Work Together",'h1','#ffffff',80,130,56,'900','Playfair Display,Georgia,serif',true,'splash'),
  LN(80,200,600,'#4f8ef7','#34d399','solid',3),
  TX('Available for freelance, contract, and full-time. I reply within 24 hours on weekdays.','rgba(170,190,230,0.9)',80,226,600,15,'left','Inter,sans-serif'),
  SP(290,20),
  CON(80,320,600,'alex@portfolio.example','#4f8ef7','#ffffff','rgba(20,40,120,0.3)','rgba(5,15,60,0.3)','rgba(79,142,247,0.4)',10,'rgba(5,10,50,0.7)','#e6edf3','Send Message →','Inter,sans-serif'),
  PNL('📍 Location','Milan, Italy · Remote worldwide',750,320,360,130,'rgba(79,142,247,0.12)','gradient','rgba(79,142,247,0.32)','to bottom right','rgba(79,142,247,0.4)',1,10,'#a78bfa','rgba(170,190,230,0.87)',14,12,18,false),
  PNL('⏱ Response','Under 24 hrs on weekdays',750,450,360,120,'rgba(52,211,153,0.12)','gradient','rgba(52,211,153,0.32)','to bottom right','rgba(52,211,153,0.4)',1,10,'#34d399','rgba(160,210,185,0.87)',14,12,18,false),
  PNL('💼 Availability','From May 2026 · Part-time & full-time',750,570,360,120,'rgba(167,139,250,0.12)','gradient','rgba(167,139,250,0.32)','to bottom right','rgba(167,139,250,0.4)',1,10,'#a78bfa','rgba(190,180,240,0.87)',14,12,18,false),
]},
]},

// ══════════════════════════════════════════════════════════════════
// BUSINESS — theme: Volcanic (deep crimson/amber, Bebas+Trebuchet)
// ══════════════════════════════════════════════════════════════════
business:{name:'Business Site',pages:[
{id:'bz1',name:'Home',bgScrollMode:'fixed',
 bgLayers:[DYN(3,'#ff4500','#0e0000','#ff8c00')],bgDividers:[DIV(80,70,22)],
 cursorType:'default',cursorColor:'#ff4500',elements:[
  NB('NovaCorp',[PL('Services','Services'),PL('Team','Team'),PL('Contact','Contact')],'rgba(14,0,0,0.9)','#ffcba4','Bebas Neue,Impact,sans-serif'),
  IMG(P.h_amber,'Office',0,0,1440,620,0,false,'transparent',0,'none',false,false),
  SHP('rectangle',0,0,780,620,'#0e0000','gradient','rgba(14,0,0,0.05)','to right','transparent',0,0,1,false),
  H('Strategy.\nDesign.\nGrowth.','h1','#ffffff',80,130,68,'900','Bebas Neue,Impact,sans-serif',true,'fade'),
  TX('From idea to market in 90 days. Digital strategy, product design, engineering — end to end.','rgba(255,200,160,0.9)',80,374,600,17,'left','Trebuchet MS,Helvetica,sans-serif'),
  BTN('Our Services →','page','Services',80,456,'#ff4500','#0e0000','#c73200','to right',6,true),
  BTN('Meet the Team','page','Team',316,456,'rgba(50,10,0,0.7)','#ffcba4','rgba(30,5,0,0.7)','to right',6,false),
  SP(650,40),
  TBL(80,720,1280,3,1,[
    {title:'🎯 Results-first',body:'Every engagement starts with measurable goals and ends with a clear ROI report.'},
    {title:'🚀 2-week delivery',body:'First results within 2 weeks of kickoff. We move fast without breaking things.'},
    {title:'🤝 85% retention',body:'85% of clients continue after project 1. We build relationships, not handoffs.'},
  ],'rgba(255,69,0,0.1)','rgba(255,69,0,0.35)','#ff8c00','rgba(255,200,160,0.88)',14,12,10,16,true,'slide-up','Bebas Neue,Impact,sans-serif','Trebuchet MS,Helvetica,sans-serif'),
  SP(1020,40),
  BTN('Explore Services →','page','Services',570,1070,'#ff4500','#0e0000','#c73200','to right',6,true),
]},

{id:'bz2',name:'Services',bgScrollMode:'scroll',
 bgLayers:[DYN(6,'#ff6b35','#08010a','#ff8c00')],bgDividers:[DIV(60,50,25)],
 cursorType:'default',cursorColor:'#ff4500',elements:[
  NB('NovaCorp',[PL('Home','Home'),PL('Team','Team'),PL('Contact','Contact')],'rgba(8,1,10,0.92)','#ffcba4','Bebas Neue,Impact,sans-serif'),
  SP(0,80),
  H('Our Services','h1','#ff8c00',80,110,56,'900','Bebas Neue,Impact,sans-serif',true,'fade'),
  LN(80,176,500,'#ff4500','#ff8c00','solid',4),
  TX('Three core service pillars — strategy, design, and engineering — each delivered by dedicated specialists.','rgba(255,200,160,0.9)',80,202,700,15,'left','Trebuchet MS,Helvetica,sans-serif'),
  SP(256,20),
  PNL('🎯 Strategy','Market research · competitive analysis · positioning · go-to-market · OKR alignment.',80,296,380,250,'rgba(255,69,0,0.1)','gradient','rgba(180,40,10,0.38)','to bottom','rgba(255,69,0,0.45)',1,12,'#ff8c00','rgba(255,200,160,0.92)',16,13,22,true,true,'scale',0),
  PNL('🎨 Design','Brand identity · UI/UX · design systems · motion graphics · Figma to production-grade code.',514,296,380,250,'rgba(255,140,0,0.1)','gradient','rgba(160,80,0,0.38)','to bottom','rgba(255,140,0,0.45)',1,12,'#ffcba4','rgba(255,220,180,0.92)',16,13,22,true,true,'scale',0.08),
  PNL('⚙ Engineering','Full-stack · API integrations · cloud infra · performance. We ship production code, not demos.',948,296,380,250,'rgba(255,100,50,0.1)','gradient','rgba(140,50,10,0.38)','to bottom','rgba(255,100,50,0.45)',1,12,'#ffa080','rgba(255,200,165,0.92)',16,13,22,true,true,'scale',0.16),
  SP(564,40),
  TBL(80,640,1280,3,1,[
    {title:'Starter · €3,500',body:'2-week sprint · MVP or landing page'},
    {title:'Growth · €7,900/mo',body:'Retainer · strategy + design + dev',bgOverride:'rgba(255,69,0,0.22)'},
    {title:'Enterprise · Custom',body:'Dedicated team · SLA · 24/7 support'},
  ],'rgba(255,69,0,0.09)','rgba(255,69,0,0.3)','#ff8c00','rgba(255,200,160,0.88)',22,12,10,16,true,'slide-up','Bebas Neue,Impact,sans-serif','Trebuchet MS,Helvetica,sans-serif'),
  SP(870,40),
  BTN('Get a Quote →','page','Contact',570,920,'#ff4500','#0e0000','#c73200','to right',6,true),
]},

{id:'bz3',name:'Team',bgScrollMode:'fixed',
 bgLayers:[DYN(1,'#ff6b35','#060008','#ff8c00')],bgDividers:[DIV(70,60,18)],
 cursorType:'default',cursorColor:'#ff4500',elements:[
  NB('NovaCorp',[PL('Home','Home'),PL('Services','Services'),PL('Contact','Contact')],'rgba(6,0,8,0.92)','#ffcba4','Bebas Neue,Impact,sans-serif'),
  SP(0,80),
  H('Meet the Team','h1','#ff8c00',80,110,56,'900','Bebas Neue,Impact,sans-serif',true,'fade'),
  LN(80,176,500,'#ff4500','#ff8c00','solid',4),
  IMG(P.p5,'Maria Chen',80,244,200,200,100,true,'#ff4500',3,'circle',true,true,true,'splash',0),
  H('Maria Chen','h3','#ffcba4',80,460,15,'700','Trebuchet MS,Helvetica,sans-serif'),
  TX('CEO · ex-McKinsey','rgba(220,170,130,0.82)',80,484,200,11,'left'),
  IMG(P.p6,'Jake Rivera',340,244,200,200,100,true,'#ff4500',3,'circle',true,true,true,'splash',0.08),
  H('Jake Rivera','h3','#ffcba4',340,460,15,'700','Trebuchet MS,Helvetica,sans-serif'),
  TX('CTO · ex-Stripe','rgba(220,170,130,0.82)',340,484,200,11,'left'),
  IMG(P.p3,'Sofia Park',600,244,200,200,100,true,'#ff4500',3,'circle',true,true,true,'splash',0.16),
  H('Sofia Park','h3','#ffcba4',600,460,15,'700','Trebuchet MS,Helvetica,sans-serif'),
  TX('Creative Dir · ex-Figma','rgba(220,170,130,0.82)',600,484,200,11,'left'),
  IMG(P.p4,'Tom Adeyemi',860,244,200,200,100,true,'#ff4500',3,'circle',true,true,true,'splash',0.24),
  H('Tom Adeyemi','h3','#ffcba4',860,460,15,'700','Trebuchet MS,Helvetica,sans-serif'),
  TX('Growth · ex-HubSpot','rgba(220,170,130,0.82)',860,484,200,11,'left'),
  SP(540,50),
  HSCR(80,610,1280,240,[
    {title:'"Game-changing results"',body:'NovaCorp redesigned our product in 6 weeks. Revenue up 34%. — Head of Product, Finova',src:P.h0},
    {title:'"Best agency we\'ve had"',body:'From strategy to code, they handled everything. No hand-holding. — CEO, Stackly',src:P.h1},
    {title:'"Working with them again"',body:'Sharp, fast, invested in your success. Best vendor bar none. — CMO, Perma',src:P.h2},
    {title:'"ROI in month 1"',body:'Positive return within the first month. — CFO, Veritas',src:P.h3},
  ],300,'rgba(40,5,0,0.72)','rgba(255,69,0,0.4)','#ff8c00','rgba(255,200,160,0.9)','#ff4500',true,2,true,'fade','Bebas Neue,Impact,sans-serif','Trebuchet MS,Helvetica,sans-serif'),
  SP(880,40),
  BTN('Work With Us →','page','Contact',560,930,'#ff4500','#0e0000','#c73200','to right',6,true),
]},

{id:'bz4',name:'Contact',bgScrollMode:'fixed',
 bgLayers:[DYN(10,'#ff6b35','#08010a','#ff8c00')],bgDividers:[DIV(55,65,20)],
 cursorType:'default',cursorColor:'#ff4500',elements:[
  NB('NovaCorp',[PL('Home','Home'),PL('Services','Services'),PL('Team','Team')],'rgba(8,1,10,0.92)','#ffcba4','Bebas Neue,Impact,sans-serif'),
  SP(0,100),
  H('Get in Touch','h1','#ff8c00',80,130,56,'900','Bebas Neue,Impact,sans-serif',true,'splash'),
  LN(80,200,500,'#ff4500','#ff8c00','solid',4),
  TX('Tell us about your project. We respond within 24 hours on business days.','rgba(255,200,160,0.9)',80,226,600,15,'left','Trebuchet MS,Helvetica,sans-serif'),
  SP(270,20),
  CON(80,310,620,'hello@novacorp.example','#ff4500','#0e0000','rgba(60,8,0,0.35)','rgba(30,4,0,0.35)','rgba(255,69,0,0.4)',10,'rgba(30,5,0,0.7)','#ffcba4','Send Enquiry →','Trebuchet MS,Helvetica,sans-serif'),
  PNL('📞 Direct','hello@novacorp.example\n+39 02 1234 5678\nMon–Fri 9:00–18:00 CET',780,310,380,165,'rgba(255,69,0,0.1)','gradient','rgba(160,40,10,0.35)','to bottom','rgba(255,69,0,0.38)',1,10,'#ffcba4','rgba(255,200,160,0.87)',14,12,18,false),
  PNL('📍 Office','Via Montenapoleone 12\nMilan, Italy 20121\nRemote teams worldwide',780,470,380,165,'rgba(255,69,0,0.1)','gradient','rgba(160,40,10,0.35)','to bottom','rgba(255,69,0,0.38)',1,10,'#ffcba4','rgba(255,200,160,0.87)',14,12,18,false),
]},
]},

// ══════════════════════════════════════════════════════════════════
// PHOTOGRAPHY — theme: Gallery (white + black + red, DM Serif)
// ══════════════════════════════════════════════════════════════════
photography:{name:'Photography Portfolio',pages:[
{id:'ph1',name:'Gallery',bgScrollMode:'fixed',
 bgLayers:[{type:'solid',color:'#0a0a0a'}],bgDividers:[],
 cursorType:'ring',cursorColor:'#ffffff',elements:[
  NB('LENS',[SL('Gallery','gallery-sec'),PL('About','About'),PL('Book a Session','Book a Session')],'rgba(0,0,0,0)','#ffffff','DM Serif Display,serif'),
  IMG(P.h_dark,'Hero',0,0,1440,720,0,false,'transparent',0,'none',false,false),
  SHP('rectangle',0,0,780,720,'#0a0a0a','gradient','rgba(10,10,10,0.04)','to right','transparent',0,0,1,false),
  H('Capturing\nMoments\nThat Last','h1','#ffffff',100,220,60,'900','DM Serif Display,serif'),
  TX('Editorial · Landscape · Portrait · Architecture','rgba(255,255,255,0.72)',100,434,520,17,'left','Space Grotesk,sans-serif'),
  BTN('View Gallery ↓','section','gallery-sec',100,510,'rgba(40,40,40,0.6)','#ffffff','rgba(20,20,20,0.6)','to right',4,false),
  BTN('Book a Session →','page','Book a Session',326,510,'#e63946','#ffffff','#a01020','to right',4,true),
  SP(748,30),
  SEC('gallery-sec',790),
  H('Portfolio','h2','#ffffff',100,820,42,'900','DM Serif Display,serif',true,'fade'),
  LN(100,874,500,'#e63946','#888888','solid',2),
  {type:'collage',x:100,y:910,w:1280,h:560,props:{images:[
    {src:P.c0,alt:'L'},{src:P.c1,alt:'A'},{src:P.c2,alt:'N'},
    {src:P.c3,alt:'P'},{src:P.c4,alt:'F'},{src:P.c5,alt:'Ab'},
    {src:P.c6,alt:'T'},{src:P.c7,alt:'U'},{src:P.c8,alt:'S'},
  ],cols:3,gap:8,borderRadius:2,hoverEffect:'zoom',objectFit:'cover',scrollIn:true,scrollInType:'splash',scrollInDelay:0}},
  SP(1508,50),
  BTN('Book a Session →','page','Book a Session',576,1558,'#e63946','#ffffff','#a01020','to right',4,true),
]},

{id:'ph2',name:'About',bgScrollMode:'fixed',
 bgLayers:[DYN(4,'#888888','#121212','#e0e0e0')],bgDividers:[DIV(55,45,20)],
 cursorType:'ring',cursorColor:'#ffffff',elements:[
  NB('LENS',[PL('Gallery','Gallery'),PL('Book a Session','Book a Session')],'rgba(0,0,0,0.78)','#ffffff','DM Serif Display,serif'),
  SP(0,80),
  IMG(P.p1,'Marco',880,90,420,520,6,false,'transparent',0,'none',true,false,true,'fade',0),
  H("Hi, I'm Marco.",'h1','#ffffff',80,110,58,'900','DM Serif Display,serif',true,'fade'),
  LN(80,178,420,'#e63946','#888888','solid',2),
  TX("Photographer based in Milan, working worldwide. Specialising in editorial portraiture and architectural photography.",'rgba(255,255,255,0.84)',80,204,660,15,'left','Space Grotesk,sans-serif'),
  TX("Published in Vogue Italia, Architectural Digest, and independent galleries across Europe.",'rgba(255,255,255,0.62)',80,296,640,14,'left','Space Grotesk,sans-serif'),
  HSCR(80,380,660,100,[
    {title:'Vogue Italia',body:'Editorial fashion and portrait commissions',src:P.h0},
    {title:'Arch. Digest',body:'Interior and architectural photography',src:P.h1},
    {title:'Nike',body:'Athlete and product campaigns',src:P.h2},
    {title:'Hermès',body:'Luxury lifestyle and campaign shoots',src:P.h3},
  ],155,'rgba(30,30,30,0.8)','rgba(255,255,255,0.25)','rgba(255,255,255,0.9)','rgba(200,200,200,0.7)','rgba(255,255,255,0.7)',true,1.5,false),
  SP(524,40),
  BTN('Book a Session →','page','Book a Session',80,580,'#e63946','#ffffff','#a01020','to right',4,true),
]},

{id:'ph3',name:'Book a Session',bgScrollMode:'scroll',
 bgLayers:[DYN(7,'#cccccc','#121212','#666666')],bgDividers:[DIV(62,48,26)],
 cursorType:'ring',cursorColor:'#ffffff',elements:[
  NB('LENS',[PL('Gallery','Gallery'),PL('About','About')],'rgba(0,0,0,0.78)','#ffffff','DM Serif Display,serif'),
  SP(0,100),
  H('Book a Session','h1','#ffffff',80,130,56,'900','DM Serif Display,serif',true,'splash'),
  LN(80,200,500,'#e63946','#888888','solid',2),
  TX("Fill in the form below. I reply within 48 hours with availability and a custom quote.",'rgba(255,255,255,0.72)',80,224,660,15,'left','Space Grotesk,sans-serif'),
  TBL(80,290,820,3,1,[
    {title:'Portrait · €850',body:'Half-day · Studio or on-location'},
    {title:'Editorial · €2,200',body:'Full day · Post-prod. included'},
    {title:'Architecture · €1,500+',body:'Drone available'},
  ],'rgba(60,60,60,0.72)','rgba(200,200,200,0.3)','#ffffff','rgba(255,255,255,0.68)',16,12,6,14,true,'slide-up','DM Serif Display,serif','Space Grotesk,sans-serif'),
  SP(454,30),
  CON(80,508,600,'marco@lens.example','#e63946','#ffffff','rgba(30,30,30,0.5)','rgba(15,15,15,0.5)','rgba(200,200,200,0.3)',8,'rgba(255,255,255,0.07)','#ffffff','Send Enquiry →','Space Grotesk,sans-serif'),
  PNL('✓ Response in 48h','Personally respond to every enquiry.',760,508,380,130,'rgba(50,50,50,0.5)','gradient','rgba(30,30,30,0.7)','to bottom','rgba(200,200,200,0.28)',1,6,'rgba(255,255,255,0.9)','rgba(200,200,200,0.72)',13,12,16,false),
  PNL('✓ Custom Quote','Pricing depends on scope, location, and usage rights.',760,638,380,130,'rgba(50,50,50,0.5)','gradient','rgba(30,30,30,0.7)','to bottom','rgba(200,200,200,0.28)',1,6,'rgba(255,255,255,0.9)','rgba(200,200,200,0.72)',13,12,16,false),
]},
]},

// ══════════════════════════════════════════════════════════════════
// ANNOUNCEMENT — theme: Newspaper (cream/sepia, Playfair Display)
// ══════════════════════════════════════════════════════════════════
announcement:{name:'Announcement Page',pages:[{
 id:'an1',name:'Announcement',bgScrollMode:'scroll',
 bgLayers:[{type:'solid',color:'#f5f0e8'}],bgDividers:[],
 cursorType:'dot',cursorColor:'#8b0000',elements:[
  SHP('rectangle',0,0,1440,6,'#1a1a1a','solid','#1a1a1a','to right','transparent',0,0,1,false),
  SHP('rectangle',0,6,1440,6,'#8b0000','solid','#8b0000','to right','transparent',0,0,1,false),
  SP(18,80),
  H('THE OFFICIAL RECORD','h4','#8b0000',80,104,11,'700','Playfair Display,Georgia,serif'),
  H("Important Announcement\nRegarding Our Services",'h1','#1a1a1a',80,134,52,'900','Playfair Display,Georgia,serif',true,'fade'),
  LN(80,268,1280,'#1a1a1a','#8b0000','solid',2),
  TX('Effective 1 January 2026, the following changes apply to all active subscriptions and service agreements. Please read carefully.','#3d2a1a',240,290,960,15,'center','Georgia,Times New Roman,serif'),
  LN(80,348,1280,'#aaaaaa','#aaaaaa','solid',1),
  TBL(80,380,1280,3,1,[
    {title:'Pricing Update',body:'Standard plan increases by 8% from 1 Jan in line with operating cost adjustments.'},
    {title:'New Features',body:'All tiers gain access to the new analytics dashboard at no extra cost.'},
    {title:'Support Hours',body:'24/7 support now available for Professional and Enterprise plans.'},
  ],'rgba(0,0,0,0.05)','rgba(0,0,0,0.25)','#1a1a1a','#3d2a1a',14,13,4,16,false,null,'Playfair Display,Georgia,serif','Georgia,Times New Roman,serif'),
  SP(650,40),
  LN(80,700,1280,'#aaaaaa','#aaaaaa','solid',1),
  TX('Questions? Contact our support team. Existing contracts remain valid until their renewal date.','#6b4c35',240,712,960,13,'center','Georgia,Times New Roman,serif'),
  BTN('Contact Support','url','mailto:support@example.com',580,770,'#1a1a1a','#f5f0e8','#3d2a1a','to right',2,false),
  TX('© 2026 Company Name — All rights reserved','rgba(0,0,0,0.38)',240,846,960,10,'center','Playfair Display,Georgia,serif'),
]}]},

// ══════════════════════════════════════════════════════════════════
// PRESENTATION — theme: Neon (black + magenta/cyan, Oswald)
// ══════════════════════════════════════════════════════════════════
presentation:{name:'Pitch Deck',pages:[
{id:'pr1',name:'Presentation',bgScrollMode:'fixed',
 bgLayers:[DYN(5,'#ff006e','#050508','#00f5d4')],bgDividers:[DIV(58,48,22)],
 cursorType:'ring',cursorColor:'#ff006e',elements:[
  NB('Pitch Deck',[SL('Slides','slides-sec'),SL('Metrics','metrics-sec'),PL('Q&A →','Q&A'),PL('Contact →','Contact')],'rgba(5,5,8,0.92)','#e0e0e0','Oswald,sans-serif'),
  SEC('slides-sec',40),
  {type:'folderpanel',x:0,y:40,w:1440,h:600,props:{slides:[
    {title:'The Big Idea',body:'Every breakthrough starts with one question.\nScroll to explore how we got here.',bgImage:P.h_neon,bgColor:'#150030'},
    {title:'The Problem',body:'Millions of people struggle with this every day.\nExisting solutions fail in three critical ways.',bgImage:P.h_blue,bgColor:'#001530'},
    {title:'Our Solution',body:'We built a system that changes everything.\nSimple, powerful, designed for real people.',bgImage:P.h_teal,bgColor:'#003015'},
    {title:'The Results',body:'Pilot: 40% faster · 60% cheaper · 3 enterprise clients · Zero churn.',bgImage:P.h_green,bgColor:'#152000'},
    {title:"What's Next",body:"Join us in building the future.\nLet's make it happen together.",bgImage:P.h_fire,bgColor:'#200000'},
  ],titleColor:'#ffffff',bodyColor:'rgba(255,255,255,0.88)',titleSize:54,bodySize:20,textAlign:'center',overlayColor:'rgba(0,0,0,0.44)',borderRadius:0,startWidth:100,editingSlide:0}},
  SP(3060,50),
  SEC('metrics-sec',3120),
  H('Key Metrics','h2','#ff006e',80,3148,42,'900','Oswald,sans-serif',true,'fade'),
  LN(80,3202,700,'#ff006e','#00f5d4','solid',3),
  TBL(80,3242,1280,4,1,[
    {title:'40%',body:'Efficiency gain in pilot'},{title:'3×',body:'Faster than legacy'},
    {title:'€0',body:'Setup for early adopters'},{title:'99%',body:'Uptime SLA guaranteed'},
  ],'rgba(255,0,110,0.1)','rgba(255,0,110,0.4)','#ff006e','rgba(220,200,225,0.9)',40,12,6,16,true,'slide-up','Oswald,sans-serif','Inter,sans-serif'),
  SP(3462,40),
  HSCR(80,3512,1280,240,[
    {title:'"Game-changing"',body:'"Rolled out in a day. Team up to speed in an hour." — CTO, Finova',src:P.h0},
    {title:'"Engineers love it"',body:'"We evaluated 6 tools. This was the only one our engineers wanted." — VP Eng',src:P.h1},
    {title:'"ROI in month 1"',body:'"Positive ROI within the first month." — CEO, Perma',src:P.h2},
    {title:'"Zero churn"',body:'"100% of our early-access users stayed past month 3." — Head of Product',src:P.h3},
  ],300,'rgba(20,5,28,0.72)','rgba(255,0,110,0.4)','#ff006e','rgba(220,200,225,0.9)','#ff006e',false,3,true,'fade','Oswald,sans-serif','Inter,sans-serif'),
  SP(3782,40),
  BTN('Q&A →','page','Q&A',536,3832,'#ff006e','#050508','#c00050','to right',4,true),
  BTN('Get Early Access','page','Contact',724,3832,'rgba(0,245,212,0.1)','#00f5d4','rgba(0,150,120,0.1)','to right',4,false),
]},

{id:'pr2',name:'Q&A',bgScrollMode:'fixed',
 bgLayers:[DYN(7,'#00f5d4','#040810','#ff006e')],bgDividers:[DIV(48,62,28)],
 cursorType:'ring',cursorColor:'#00f5d4',elements:[
  NB('Pitch Deck',[PL('← Slides','Presentation'),PL('Contact →','Contact')],'rgba(4,8,16,0.92)','#e0e0e0','Oswald,sans-serif'),
  SP(0,80),
  H('Q & A','h1','#00f5d4',80,110,62,'900','Oswald,sans-serif',true,'splash'),
  LN(80,188,700,'#ff006e','#00f5d4','solid',3),
  TBL(80,240,1280,2,3,[
    {title:'What makes you different?',body:'AI-native architecture + zero-config deployment. No competitor combines both.'},
    {title:'Go-to-market strategy?',body:'PLG for SMBs, direct enterprise sales. €2M ARR target in 18 months.'},
    {title:'Competitors?',body:'Tableau (10× more expensive), Looker (5× slower setup). We win on both.'},
    {title:'Business model?',body:'SaaS: €49/mo Standard · €199/mo Pro · Custom Enterprise.'},
    {title:'The team?',body:'3 engineers (ex-Google/Stripe) · 1 designer (ex-Figma) · 1 GTM (ex-HubSpot).'},
    {title:'What do you need?',body:'€1.2M seed to reach 500 paying customers and 3 enterprise contracts.'},
  ],'rgba(0,245,212,0.09)','rgba(0,245,212,0.3)','#00f5d4','rgba(200,245,240,0.9)',14,13,8,14,true,'slide-up','Oswald,sans-serif','Inter,sans-serif'),
  SP(750,40),
  BTN('Get Early Access →','page','Contact',560,810,'#ff006e','#050508','#c00050','to right',4,true),
]},

{id:'pr3',name:'Contact',bgScrollMode:'fixed',
 bgLayers:[DYN(10,'#ff006e','#040810','#00f5d4')],bgDividers:[DIV(55,45,18)],
 cursorType:'ring',cursorColor:'#ff006e',elements:[
  NB('Pitch Deck',[PL('← Slides','Presentation'),PL('Q&A','Q&A')],'rgba(4,8,16,0.92)','#e0e0e0','Oswald,sans-serif'),
  SP(0,100),
  H('Get Early Access','h1','#ff006e',80,130,56,'900','Oswald,sans-serif',true,'splash'),
  LN(80,206,600,'#ff006e','#00f5d4','solid',3),
  TX('Join our early adopter programme. Lock in founder pricing and get dedicated onboarding.','rgba(210,200,230,0.9)',80,230,660,15,'left','Inter,sans-serif'),
  SP(280,20),
  CON(80,320,620,'founders@startup.example','#ff006e','#ffffff','rgba(50,5,30,0.35)','rgba(25,2,15,0.35)','rgba(255,0,110,0.45)',8,'rgba(5,3,20,0.7)','#e8d0f0','Apply for Early Access →','Inter,sans-serif'),
  TBL(780,320,460,1,3,[
    {title:'✓ Free setup & migration',body:'We handle everything from day one.'},
    {title:'✓ Founder pricing locked',body:'Price never increases while you are with us.'},
    {title:'✓ Direct Slack channel',body:'Talk to the engineering team directly.'},
  ],'rgba(255,0,110,0.1)','rgba(255,0,110,0.35)','#ff006e','rgba(210,200,230,0.87)',13,12,6,10,false),
]},
]},

// ══════════════════════════════════════════════════════════════════
// ELEMENTS SHOWCASE — 6 themes: Ocean, Techno, Autumn, Forest, Vapor, Brutalist
// ══════════════════════════════════════════════════════════════════
showcase:{name:'Elements Showcase',pages:[

// ── Page 1: Typography — Ocean theme ──
{id:'sc1',name:'Typography',bgScrollMode:'fixed',
 bgLayers:[DYN(0,'#0891b2','#020d1a','#22d3ee')],bgDividers:[DIV(62,52,24)],
 cursorType:'default',cursorColor:'#22d3ee',elements:[
  NB('⬡ Showcase',[SL('Typography','typo-sec'),PL('Panels →','Panels & Tables'),PL('Media →','Images & Media'),PL('Shapes →','Shapes & Lines'),PL('Scroll →','Scroll Effects'),PL('Buttons →','Buttons & Forms')],'rgba(2,13,26,0.92)','#cffafe','Montserrat,sans-serif'),
  SEC('typo-sec',40),
  SP(40,40),
  SHP('rectangle',0,50,6,240,'#0891b2','gradient','#22d3ee','to bottom','transparent',0,3,1,false),
  H('Typography\n& Text Elements','h1','#22d3ee',60,80,58,'900','Montserrat,sans-serif',true,'fade'),
  LN(60,218,820,'#0891b2','#22d3ee','solid',3),
  TX('Full typographic control: H1–H4 headings, body text, font families, letter spacing, and line height.','rgba(160,230,245,0.9)',60,246,840,14,'left','Space Grotesk,sans-serif'),
  H('Heading H1 — Display 58px','h1','#ffffff',60,310,58,'900','Montserrat,sans-serif',true,'splash'),
  H('Heading H2 — Section 38px','h2','rgba(200,245,255,0.95)',60,388,38,'800','Montserrat,sans-serif',true,'fade',null,80),
  H('Heading H3 — Subsection 26px','h3','rgba(150,220,240,0.9)',60,442,26,'700','Space Grotesk,sans-serif',true,'slide-up',null,120),
  H('Heading H4 — Label 16px','h4','rgba(100,195,220,0.85)',60,486,16,'600','Space Grotesk,sans-serif',true,'slide-up',null,160),
  LN(60,522,700,'rgba(8,145,178,0.45)','rgba(34,211,238,0.2)','dashed',1),
  TX('Regular body text at 14px · 1.8 line-height. Fully customisable font, size, color, and spacing.','rgba(140,215,235,0.9)',60,540,680,14,'left','Space Grotesk,sans-serif'),
  H('Playfair Display — Serif Editorial','h2','rgba(220,248,255,0.95)',890,310,22,'700','Playfair Display,Georgia,serif'),
  H('Oswald — Condensed Display','h2','rgba(220,248,255,0.95)',890,358,22,'700','Oswald,sans-serif'),
  H('IBM Plex Mono — Monospace','h2','rgba(220,248,255,0.95)',890,406,22,'700','IBM Plex Mono,Courier New,monospace'),
  H('Dancing Script — Handwriting','h2','rgba(220,248,255,0.95)',890,454,22,'600','Dancing Script,cursive'),
  {type:'codeblock',x:60,y:660,w:800,h:'auto',props:{code:'// Code Block — monospace display\nconst greet = (name) => `Hello, ${name}!`;\nconsole.log(greet("PageDotCom"));\n// Great for portfolios, docs, and tech sites.',bgColor:'#030d1a',bgMode:'solid',bgGradB:'#030d1a',bgGradDir:'to right',textColor:'#22d3ee',fontSize:12,borderRadius:6,fontFamily:'IBM Plex Mono,Courier New,monospace'}},
  LN(60,840,1360,'rgba(8,145,178,0.25)','rgba(34,211,238,0.12)','solid',1),
  SP(860,30),
  BTN('Next: Panels & Tables →','page','Panels & Tables',60,910,'#0891b2','#ffffff','#0c6487','to right',6,true),
]},

// ── Page 2: Panels & Tables — Techno theme ──
{id:'sc2',name:'Panels & Tables',bgScrollMode:'fixed',
 bgLayers:[DYN(1,'#00d4ff','#020b14','#ff3d71')],bgDividers:[DIV(50,62,20)],
 cursorType:'default',cursorColor:'#00d4ff',elements:[
  NB('⬡ Showcase',[PL('← Typo','Typography'),SL('Panels','panels-sec'),SL('Tables','tables-sec'),PL('Next: Media →','Images & Media')],'rgba(2,11,20,0.92)','#8ecfdc','IBM Plex Mono,Courier New,monospace'),
  SEC('panels-sec',40),
  SP(40,40),
  H('Panels','h1','#00d4ff',60,90,56,'900','IBM Plex Mono,Courier New,monospace',true,'fade'),
  LN(60,156,620,'#00d4ff','#ff3d71','solid',3),
  TX('Styled card elements with custom title, body, backgrounds, borders, shape clips, hover effects, scroll-in animations, and texture fills.','rgba(140,205,220,0.9)',60,182,1100,14,'left','IBM Plex Mono,Courier New,monospace'),
  PNL('Normal + Hover Scale','Scales 1.05× on hover. Solid or gradient background, configurable border and radius.',60,248,380,200,'rgba(0,212,255,0.08)','solid','rgba(20,60,100,0.08)','to right','rgba(0,212,255,0.35)',1,8,'#00d4ff','rgba(140,205,220,0.9)',15,12,20,true,true,'scale',0,{fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  PNL('Gradient Background','Mode "gradient" — vivid solid-to-solid stops. No transparent ends.',500,248,380,200,'#020b14','gradient','#093a70','to bottom right','rgba(0,212,255,0.42)',1,8,'#00d4ff','rgba(140,205,220,0.9)',15,12,20,true,true,'splash',0.1,{fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  PNLT('🪨 Marble Texture','Click "Texture" in the Background picker. Choose from marble, gravel, water, earth, wood, fabric, concrete, noise, grid, or dots.',940,248,400,230,'marble','#0d3a5f','#021a30','rgba(0,212,255,0.35)',1,8,'#00d4ff','rgba(140,205,220,0.9)',15,12,20,true,'scale',0.2),
  PNL('● Circle','Clips to circle.',60,510,190,190,'rgba(0,212,255,0.12)','solid','rgba(10,40,80,0.12)','to right','rgba(0,212,255,0.5)',2,95,'#00d4ff','rgba(140,205,220,0.9)',13,0,18,true,true,'rotate-in',0,{shape:'circle',textAlign:'center',bodySize:0,fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace',borderRadius:95}),
  PNL('⬭ Pill','',290,520,180,120,'rgba(0,212,255,0.12)','solid','rgba(10,40,80,0.12)','to right','rgba(0,212,255,0.5)',2,60,'#00d4ff','rgba(140,205,220,0.9)',13,0,14,true,true,'flip-x',0.08,{shape:'pill',textAlign:'center',bodySize:0,fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  PNL('◆ Diamond','',520,520,180,120,'rgba(255,61,113,0.12)','solid','rgba(80,10,30,0.12)','to right','rgba(255,61,113,0.5)',2,0,'#ff3d71','rgba(220,160,175,0.9)',13,0,14,true,true,'flip-y',0.16,{shape:'diamond',textAlign:'center',bodySize:0,fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  PNL('⬡ Hexagon','',750,520,180,120,'rgba(57,255,20,0.12)','solid','rgba(10,60,5,0.12)','to right','rgba(57,255,20,0.45)',2,0,'#39ff14','rgba(160,230,145,0.9)',13,0,14,true,true,'shrink-bounce',0.24,{shape:'hexagon',textAlign:'center',bodySize:0,fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  PNL('⌃ Chevron + Shadow','Shadow + animated entry.',980,520,300,120,'rgba(0,212,255,0.12)','gradient','#093a70','to right','rgba(0,212,255,0.45)',2,8,'#00d4ff','rgba(140,205,220,0.9)',13,11,14,true,true,'vibrate',0.32,{shape:'chevron',shadow:true,fontFamily:'IBM Plex Mono,Courier New,monospace',titleFont:'IBM Plex Mono,Courier New,monospace'}),
  SEC('tables-sec',700),
  SP(700,30),
  H('Tables / Grids','h1','#00d4ff',60,740,56,'900','IBM Plex Mono,Courier New,monospace',true,'fade'),
  LN(60,806,620,'#00d4ff','#ff3d71','solid',3),
  TBL(60,850,1360,4,2,[
    {title:'Hover Scale',body:'Cells grow on hover (1.06×)'},
    {title:'BG Override',body:'Per-cell background override',bgOverride:'rgba(57,255,20,0.25)'},
    {title:'Gradient Mode',body:'Cells use gradient background'},
    {title:'Scroll-In',body:'Animation on viewport entry',bgOverride:'rgba(255,61,113,0.22)'},
    {title:'Configurable Gap',body:'Spacing between cells'},
    {title:'Border Control',body:'all · first · outer · none'},
    {title:'Per-Cell Override',body:'Different bg per cell',bgOverride:'rgba(0,212,255,0.2)'},
    {title:'Full Width Grid',body:'Fills element width auto'},
  ],'rgba(0,212,255,0.07)','rgba(0,212,255,0.3)','#00d4ff','rgba(140,205,220,0.9)',13,11,6,12,true,'slide-up','IBM Plex Mono,Courier New,monospace','IBM Plex Mono,Courier New,monospace'),
  SP(1140,40),
  BTN('← Typography','page','Typography',60,1192,'rgba(5,20,40,0.5)','rgba(140,205,220,0.72)','rgba(3,10,25,0.5)','to right',6,false),
  BTN('Next: Images & Media →','page','Images & Media',250,1192,'#00d4ff','#020b14','#0c6090','to right',6,true),
]},

// ── Page 3: Images & Media — Autumn theme ──
{id:'sc3',name:'Images & Media',bgScrollMode:'fixed',
 bgLayers:[DYN(2,'#d4621a','#1a0c02','#f5a623')],bgDividers:[DIV(48,60,26)],
 cursorType:'dot',cursorColor:'#f5a623',elements:[
  NB('⬡ Showcase',[PL('← Panels','Panels & Tables'),SL('Images','images-sec'),SL('Collage','collage-sec'),SL('H-Scroll','hscroll-sec'),PL('Next →','Shapes & Lines')],'rgba(26,12,2,0.92)','#f5deb3','Merriweather,serif'),
  SEC('images-sec',40),
  SP(40,40),
  H('Images','h1','#f5a623',60,90,56,'900','Merriweather,serif',true,'flip-x'),
  LN(60,156,620,'#d4621a','#f5a623','solid',3),
  TX('Cover · Contain · Fill. Circle · Pill · Hexagon · Diamond clip shapes. Hover zoom (1.18×). Drop shadow. Configurable borders.','rgba(245,220,170,0.9)',60,182,1100,14,'left','Lora,serif'),
  IMG(P.w3,'Cover + Hover Zoom',60,258,440,320,8,true,'rgba(212,98,26,0.5)',2,'none',true,true,true,'scale',0),
  TX('Cover + Hover Zoom 1.18×','rgba(200,150,80,0.85)',60,592,400,12,'left'),
  IMG(P.p2,'Circle Clip',560,258,280,280,140,true,'rgba(212,98,26,0.7)',3,'circle',true,false,true,'splash',0.1),
  TX('Circle Clip','rgba(200,150,80,0.85)',560,552,260,12,'left'),
  IMG(P.p3,'Hexagon Clip',890,258,240,290,0,false,'transparent',0,'hexagon',true,false,true,'rotate-in',0.2),
  TX('Hexagon Clip','rgba(200,150,80,0.85)',890,562,220,12,'left'),
  IMG(P.p4,'Diamond Clip',1180,258,240,240,0,false,'transparent',0,'diamond',true,false,true,'flip-y',0.3),
  TX('Diamond Clip','rgba(200,150,80,0.85)',1180,512,220,12,'left'),
  SEC('collage-sec',630),
  SP(630,30),
  H('Photo Collage','h1','#f5a623',60,680,56,'900','Merriweather,serif',true,'scale'),
  LN(60,746,620,'#d4621a','#f5a623','solid',3),
  TX('Responsive grid. Control columns, gap, border radius, hover zoom/darken effect, object-fit.','rgba(245,220,170,0.9)',60,772,1000,14,'left','Lora,serif'),
  {type:'collage',x:60,y:822,w:1360,h:460,props:{images:[
    {src:P.c0,alt:'1'},{src:P.c1,alt:'2'},{src:P.c2,alt:'3'},
    {src:P.c3,alt:'4'},{src:P.c4,alt:'5'},{src:P.c5,alt:'6'},
    {src:P.c6,alt:'7'},{src:P.c7,alt:'8'},{src:P.c8,alt:'9'},
  ],cols:3,gap:10,borderRadius:4,hoverEffect:'zoom',objectFit:'cover',scrollIn:true,scrollInType:'splash',scrollInDelay:0}},
  SEC('hscroll-sec',1332),
  SP(1332,30),
  H('Horizontal Scroll','h1','#f5a623',60,1382,56,'900','Merriweather,serif',true,'fade'),
  LN(60,1448,720,'#d4621a','#f5a623','solid',3),
  TX('Draggable / trackpad-scrollable strip of image+text cards. Auto-scroll mode. Configurable width, gap, card style.','rgba(245,220,170,0.9)',60,1474,1000,14,'left','Lora,serif'),
  HSCR(60,1530,1360,310,[
    {title:'Card 1 — with Photo',body:'Each card has an image, title, and body. Drag to scroll or enable auto-scroll in props.',src:P.h0},
    {title:'Card 2 — Typography',body:'Title and body colors are independently configurable.',src:P.h1},
    {title:'Card 3 — Drag / Trackpad',body:'Horizontal drag or trackpad scroll. Arrows show on hover.',src:P.h2},
    {title:'Card 4 — Auto-Scroll',body:'Enable auto-scroll in props for a continuously moving carousel.',src:P.h3},
    {title:'Card 5 — Configurable',body:'Card width, gap, border radius, and padding are all adjustable.',src:P.h4},
    {title:'Card 6 — City Vibes',body:'Use any image URL or upload. Mix landscapes, portraits, and abstract art freely.',src:P.h5},
    {title:'Card 7 — Food & Lifestyle',body:'Great for menus, lookbooks, editorial layouts, and portfolio carousels.',src:P.h6},
    {title:'Card 8 — Architecture',body:'Scroll sections can be nested inside any page layout at any vertical position.',src:P.h7},
  ],260,'rgba(60,25,5,0.72)','rgba(212,98,26,0.4)','#f5a623','rgba(245,220,170,0.9)','#f5a623',false,3,true,'fade','Merriweather,serif','Lora,serif'),
  SP(1870,40),
  BTN('← Panels','page','Panels & Tables',60,1920,'rgba(50,20,5,0.5)','rgba(220,175,100,0.72)','rgba(35,12,3,0.5)','to right',6,false),
  BTN('Next: Shapes & Lines →','page','Shapes & Lines',258,1920,'#d4621a','#1a0c02','#9a3a0a','to right',6,true),
]},

// ── Page 4: Shapes & Lines — Vapor theme ──
{id:'sc4',name:'Shapes & Lines',bgScrollMode:'fixed',
 bgLayers:[DYN(3,'#ff71ce','#0d0020','#b967ff')],bgDividers:[DIV(42,58,30)],
 cursorType:'ring',cursorColor:'#b967ff',elements:[
  NB('⬡ Showcase',[PL('← Media','Images & Media'),SL('Shapes','shapes-sec'),SL('Lines','lines-sec'),SL('Zones','zones-sec'),PL('Next →','Scroll Effects')],'rgba(13,0,32,0.92)','#e8d0f0','Permanent Marker,cursive'),
  SEC('shapes-sec',40),
  SP(40,40),
  H('Shapes','h1','#ff71ce',60,90,56,'900','Permanent Marker,cursive',true,'shrink-bounce'),
  LN(60,156,620,'#b967ff','#ff71ce','solid',3),
  TX('Decorative filled elements: rectangle, circle, triangle, hexagon, parallelogram. Gradient fills, borders, shadows, opacity.','rgba(230,195,255,0.9)',60,182,1200,14,'left','Raleway,sans-serif'),
  SHP('circle',      60, 256,210,210,'#b967ff','gradient','#ff71ce','radial','rgba(255,113,206,0.7)',2,0,  1,true,true,'scale'),
  H('Circle','h4','rgba(230,195,255,0.9)',95,482,12,'600','Raleway,sans-serif'),
  SHP('triangle',   330, 256,210,210,'#7c20b8','solid','#7c20b8','to right','transparent',0,0, 0.87,true,true,'rotate-in'),
  H('Triangle','h4','rgba(230,195,255,0.9)',365,482,12,'600','Raleway,sans-serif'),
  SHP('hexagon',    600, 272,210,190,'#5b0080','gradient','#b967ff','to bottom','rgba(185,103,255,0.8)',2,0, 1,false,true,'flip-y'),
  H('Hexagon','h4','rgba(230,195,255,0.9)',635,478,12,'600','Raleway,sans-serif'),
  SHP('parallelogram',870,272,230,185,'#800060','gradient','#ff71ce','to right','transparent',0,0, 0.92,true,true,'vibrate'),
  H('Parallelogram','h4','rgba(230,195,255,0.9)',905,472,12,'600','Raleway,sans-serif'),
  SHP('rectangle', 1150,256,210,210,'rgba(1,205,254,0.15)','gradient','rgba(1,205,254,0.45)','to bottom','rgba(1,205,254,0.55)',2,14,1,false,true,'flip-x'),
  H('Rectangle','h4','rgba(230,195,255,0.9)',1185,482,12,'600','Raleway,sans-serif'),
  SEC('lines-sec',510),
  SP(510,40),
  H('Lines & Dividers','h1','#b967ff',60,568,56,'900','Permanent Marker,cursive',true,'fade'),
  LN(60,634,620,'#b967ff','#ff71ce','solid',3),
  TX('Horizontal or vertical — solid, dashed, dotted, gradient fade, glow. Separators, flow connectors, decorative accents.','rgba(230,195,255,0.9)',60,660,1200,14,'left','Raleway,sans-serif'),
  LN(60,720,740,'#b967ff','#ff71ce','solid',2),TX('Solid · gradient · 2px','rgba(175,140,210,0.87)',860,714,500,11,'left'),
  LN(60,756,740,'#b967ff','#01cdfe','dashed',3),TX('Dashed · 3px thick · color 1→2','rgba(175,140,210,0.87)',860,750,500,11,'left'),
  LN(60,792,740,'rgba(185,103,255,0.6)','rgba(255,113,206,0.4)','dotted',2),TX('Dotted · gradient','rgba(175,140,210,0.87)',860,786,500,11,'left'),
  LN(60,828,740,'#b967ff','#ff71ce','solid',5),TX('Thick · vivid gradient','rgba(175,140,210,0.87)',860,822,500,11,'left'),
  {type:'line',x:40,y:720,w:4,h:130,props:{orientation:'vertical',color:'#b967ff',thickness:3,style:'solid',gradient:true,gradientB:'#ff71ce',gradientDir:'to bottom',glowColor:'rgba(185,103,255,0.5)',scrollIn:false}},
  SEC('zones-sec',900),
  SP(900,30),
  H('Background Zones','h1','#ff71ce',60,948,56,'900','Permanent Marker,cursive',true,'fade'),
  LN(60,1014,620,'#b967ff','#ff71ce','solid',3),
  TX("The Bg Layers panel splits the page into independent vertical zones — solid, gradient, image, or animated canvas. Curved dividers between zones create a flowing, layered look. Toggle Fixed/Scroll mode per page.",'rgba(230,195,255,0.9)',60,1040,1100,14,'left','Raleway,sans-serif'),
  PNL('Vaporwave Zone','Gradient: #0d0020 → #3b0764. Each zone is fully independent.',60,1110,420,210,'#0d0020','gradient','#3b0764','to right','rgba(185,103,255,0.4)',1,10,'#b967ff','rgba(210,175,250,0.82)',14,12,18,false,false,null,null,{hoverScale:false,fontFamily:'Raleway,sans-serif',titleFont:'Raleway,sans-serif'}),
  PNL('Fixed Background Mode','Background stays fixed — content scrolls over it. Best for split effects and canvas animations.',540,1110,420,220,'#0d0020','gradient','#1a0040','to right','rgba(255,113,206,0.4)',1,10,'#ff71ce','rgba(220,190,240,0.82)',14,12,18,false,false,null,null,{hoverScale:false,fontFamily:'Raleway,sans-serif',titleFont:'Raleway,sans-serif'}),
  PNL('Scroll Mode','Background moves with content. Best for colour-blocked distinct sections on the same page.',1020,1110,360,220,'#0d0020','gradient','#200040','to right','rgba(1,205,254,0.4)',1,10,'#01cdfe','rgba(195,230,245,0.82)',14,12,18,false,false,null,null,{hoverScale:false,fontFamily:'Raleway,sans-serif',titleFont:'Raleway,sans-serif'}),
  SP(1340,40),
  BTN('← Media','page','Images & Media',60,1394,'rgba(20,5,50,0.5)','rgba(210,180,250,0.72)','rgba(10,2,35,0.5)','to right',6,false),
  BTN('Next: Scroll Effects →','page','Scroll Effects',258,1394,'#b967ff','#0d0020','#7c20b8','to right',6,true),
]},

// ── Page 5: Scroll Effects — Forest theme ──
{id:'sc5',name:'Scroll Effects',bgScrollMode:'fixed',
 bgLayers:[DYN(4,'#4ade80','#0a1f0a','#86efac')],bgDividers:[DIV(52,44,22)],
 cursorType:'ring',cursorColor:'#4ade80',elements:[
  NB('⬡ Showcase',[PL('← Shapes','Shapes & Lines'),SL('Animations','anim-sec'),SL('Folders','folders-sec'),PL('Next: Buttons →','Buttons & Forms')],'rgba(10,31,10,0.92)','#bbf7d0','Merriweather,serif'),
  SEC('anim-sec',40),
  SP(40,40),
  H('Scroll-In\nAnimations','h1','#4ade80',60,90,58,'900','Merriweather,serif',true,'fade'),
  LN(60,212,620,'#4ade80','#86efac','solid',3),
  TX('Every element triggers an animation on viewport entry. 12 types, adjustable delay (ms). Enable via element → Advanced tab.','rgba(187,247,208,0.9)',60,238,1100,14,'left','Lora,serif'),
  TBL(60,296,1360,4,3,[
    {title:'fade',body:'Opacity 0→1. Smooth, universal.'},
    {title:'slide-up',body:'Slides from below. Natural reading flow.'},
    {title:'slide-left',body:'Enters from right. Directional reveal.'},
    {title:'slide-right',body:'Enters from left.'},
    {title:'scale',body:'Grows from 80%. Smooth, engaging.'},
    {title:'splash',body:'Elastic bounce from 1%. Very dramatic.'},
    {title:'vibrate',body:'Slides in + horizontal shake on entry.'},
    {title:'shrink-bounce',body:'Starts at 140%, bounces down.'},
    {title:'flip-x',body:'3D flip, horizontal axis. Bold.'},
    {title:'flip-y',body:'3D flip, vertical axis.'},
    {title:'rotate-in',body:'Enters with 15° rotation.'},
    {title:'blur-in',body:'Fades and unblurs simultaneously.'},
  ],'rgba(74,222,128,0.1)','rgba(74,222,128,0.35)','#4ade80','rgba(187,247,208,0.9)',13,11,8,14,true,'slide-up','Merriweather,serif','Lora,serif'),
  SEC('folders-sec',770),
  SP(770,40),
  H('Folder Panels','h1','#4ade80',60,830,56,'900','Merriweather,serif',true,'flip-x'),
  LN(60,896,620,'#4ade80','#86efac','solid',3),
  TX("Full-width scroll-driven slide decks. Each slide stacks as the visitor scrolls — parallax-style storytelling.",'rgba(187,247,208,0.9)',60,922,1100,14,'left','Lora,serif'),
  {type:'folderpanel',x:60,y:980,w:1360,h:440,props:{slides:[
    {title:'Slide 1 — Scroll Storytelling',body:'Folder Panels create scroll-driven sequences.\nEach slide stacks as the user scrolls.',bgImage:P.h_blue,bgColor:'#002030'},
    {title:'Slide 2 — Per-Slide Control',body:'Every slide has its own background image,\noverlay opacity, title, and body text.',bgImage:P.h_green,bgColor:'#002010'},
    {title:'Slide 3 — Edit in the Editor',body:'Click the "Slide N" tab at the bottom of this element\nto switch the displayed slide while editing.',bgImage:P.h_purple,bgColor:'#100020'},
    {title:'Slide 4 — Export-Ready',body:'Exports as pure CSS scroll-driven HTML.\nNo JavaScript libraries required.',bgImage:P.h_amber,bgColor:'#200800'},
  ],titleColor:'#ffffff',bodyColor:'rgba(255,255,255,0.88)',titleSize:44,bodySize:19,textAlign:'center',overlayColor:'rgba(0,0,0,0.46)',borderRadius:10,startWidth:100,editingSlide:0}},
  SP(2770,40),
  BTN('← Shapes','page','Shapes & Lines',60,2824,'rgba(15,40,15,0.5)','rgba(180,245,200,0.72)','rgba(8,25,8,0.5)','to right',6,false),
  BTN('Next: Buttons & Forms →','page','Buttons & Forms',258,2824,'#4ade80','#0a1f0a','#16a34a','to right',6,true),
]},

// ── Page 6: Buttons & Forms — Brutalist theme ──
{id:'sc6',name:'Buttons & Forms',bgScrollMode:'scroll',
 bgLayers:[{type:'solid',color:'#f0ede8'}],bgDividers:[],
 cursorType:'default',cursorColor:'#ff3333',elements:[
  NB('⬡ Showcase',[PL('← Scroll','Scroll Effects'),SL('Buttons','btns-sec'),SL('Contact','contact-sec'),SL('Navbar','nav-sec'),PL('← Restart','Typography')],'rgba(0,0,0,0.92)','#ffffff','Oswald,sans-serif'),
  SEC('btns-sec',40),
  SP(40,40),
  SHP('rectangle',0,40,1440,6,'#000000','solid','#000000','to right','transparent',0,0,1,false),
  H('Buttons & Links','h1','#000000',60,90,56,'900','Oswald,sans-serif',true,'fade'),
  LN(60,156,620,'#ff3333','#000000','solid',4),
  TX('Buttons link to a URL, scroll to a section, or navigate to another page. Style with gradient, border radius, shadow, and font.','#333333',60,182,1100,14,'left','Arial,Helvetica,sans-serif'),
  BTN('Red Solid','url','',60,258,'#ff3333','#ffffff','#cc0000','to right',2,true),
  BTN('Black Solid','url','',240,258,'#000000','#ffffff','#333333','to right',2,false),
  BTN('Blue Outline','url','',420,258,'rgba(0,0,255,0.08)','#0000ff','rgba(0,0,100,0.08)','to right',2,false),
  BTN('Green Action','url','',600,258,'#1a7a1a','#ffffff','#0d5c0d','to right',2,true),
  BTN('Scroll to Buttons ↑','section','btns-sec',60,318,'rgba(0,0,0,0.07)','#000000','rgba(0,0,0,0.07)','to right',2,false),
  BTN('Open Typography ↗','page','Typography',268,318,'rgba(255,51,51,0.1)','#cc0000','rgba(180,10,10,0.1)','to right',2,false),
  SEC('nav-sec',378),
  SP(378,30),
  H('Navbar','h2','#000000',60,426,40,'900','Oswald,sans-serif',true,'fade'),
  LN(60,478,440,'#ff3333','#000000','solid',3),
  TX("Sticky at the top. Each link targets a section (#anchor scroll) or a page. Unconnected links show strikethrough in the editor.",'#333333',60,502,1100,14,'left','Arial,Helvetica,sans-serif'),
  PNL('Link modes','Section target → scrolls to #id on this page\nPage target → navigates to another page\n\n⚠ Empty targets scroll to top. Always connect links!',60,552,620,200,'rgba(0,0,0,0.05)','solid','rgba(0,0,0,0.05)','to right','rgba(0,0,0,0.8)',2,2,'#000000','#333333',14,12,18,false,false,null,null,{hoverScale:false,fontFamily:'Arial,Helvetica,sans-serif',titleFont:'Oswald,sans-serif'}),
  SEC('contact-sec',762),
  SP(762,30),
  H('Contact Form','h2','#000000',60,812,40,'900','Oswald,sans-serif',true,'fade'),
  LN(60,864,440,'#ff3333','#000000','solid',3),
  TX("Collects Name, Email, Subject, Message. On submit opens the visitor's mail client pre-filled. Colors fully configurable in props.",'#333333',60,888,1000,14,'left','Arial,Helvetica,sans-serif'),
  CON(60,940,600,'hello@showcase.example','#000000','#ffffff','rgba(0,0,0,0.06)','rgba(0,0,0,0.06)','rgba(0,0,0,0.5)',2,'rgba(255,255,255,0.9)','#111111','Send Message →','Arial,Helvetica,sans-serif'),
  PNLT('🪵 Wood Texture','Texture fills work on panels, shapes, buttons, and navbars. Choose "Texture" in the Background picker, then pick a type.',740,940,380,190,'wood','#7a4a1a','#3d1a06','rgba(0,0,0,0.7)',2,2,'#111111','#333333',14,12,18,false,null,null,{hoverScale:false,fontFamily:'Arial,Helvetica,sans-serif',titleFont:'Oswald,sans-serif'}),
  PNLT('🪨 Marble Texture','Each texture uses 2 configurable colors. The tileable pattern is generated procedurally on canvas — no external images needed.',740,1120,380,190,'marble','#c8c0b0','#6b5e50','rgba(0,0,0,0.5)',2,2,'#111111','#333333',14,12,18,false,null,null,{hoverScale:false,fontFamily:'Arial,Helvetica,sans-serif',titleFont:'Oswald,sans-serif'}),
  SP(1148,40),
  SHP('rectangle',0,1196,1440,6,'#000000','solid','#000000','to right','transparent',0,0,1,false),
  TX('⬡ Elements Showcase complete — 6 pages · all elements · every link connected','rgba(0,0,0,0.45)',60,1210,1360,12,'center','Arial,Helvetica,sans-serif'),
  SP(1260,40),
  BTN('← Scroll Effects','page','Scroll Effects',60,1310,'rgba(0,0,0,0.07)','#000000','rgba(0,0,0,0.07)','to right',2,false),
  BTN('Back to Typography →','page','Typography',256,1310,'#ff3333','#ffffff','#cc0000','to right',2,true),
]},
]},

};// end return
},// end get _templates



};// end Templates



// ── App root ──────────────────────────────────────────────────
const App={
  init(){
    document.querySelectorAll('.tool-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const type=btn.dataset.type;
        if(State.selectedTool===type){State.selectedTool=null;btn.classList.remove('active');}
        else{State.selectedTool=type;document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');Canvas.deselect();}
      });
    });
    Canvas.init();AiGen.loadSettings();Templates.showPicker();
  },

  newProject(silent){
    if(!silent&&State.dirty){
      if(!confirm('Start a new project? Any unsaved changes will be lost.'))return;
    }
    Templates.showPicker();
  },

  renameProject(){
    const name=prompt('Project name:',State.project.name);
    if(name&&name.trim()){State.project.name=name.trim();document.getElementById('project-name-display').textContent=State.project.name;State.dirty=true;}
  },

  async openProject(){
    if(State.dirty){
      const ok=await WarnModal.show('Opening a new file will discard any unsaved changes to the current project. Make sure you have exported/saved first.\n\nContinue and open a new file?');
      if(!ok)return;
    }
    try{
      const html=await Tauri.openText('html');
      const match=html.match(/<!--PAGEDOTCOM_PROJECT:([\s\S]*?)-->/);
      if(match){
        // Native PageDotCom project — full fidelity restore
        const data=JSON.parse(match[1]);
        State.project=data;
        State.project.currentPageId=data.currentPageId||data.pages[0]?.id;
        State.nextId=1;
        for(const page of data.pages)
          for(const el of page.elements){const n=parseInt(el.id.replace('el-',''));if(n>=State.nextId)State.nextId=n+1;}
        State.dirty=false;
        document.getElementById('project-name-display').textContent=State.project.name;
        Pages.render();Canvas.renderAll();Props.renderNone();this.syncBgUI();this.syncCursorUI();
      } else {
        // External HTML — parse and import
        this._importExternalHTML(html,'Imported Page');
      }
    }catch(e){if(!String(e).includes('Cancelled'))alert('Open failed: '+e);}
  },

  async importHTML(){
    if(State.dirty){
      const ok=await WarnModal.show('Importing will replace the current project. Any unsaved changes will be lost.\n\nContinue?');
      if(!ok)return;
    }
    try{
      const html=await Tauri.openText('html,htm');
      const match=html.match(/<!--PAGEDOTCOM_PROJECT:([\s\S]*?)-->/);
      if(match){
        // It IS a PageDotCom file — open natively
        const data=JSON.parse(match[1]);
        State.project=data;
        State.project.currentPageId=data.currentPageId||data.pages[0]?.id;
        State.nextId=1;
        for(const page of data.pages)
          for(const el of page.elements){const n=parseInt(el.id.replace('el-',''));if(n>=State.nextId)State.nextId=n+1;}
        State.dirty=false;
        document.getElementById('project-name-display').textContent=State.project.name;
        Pages.render();Canvas.renderAll();Props.renderNone();this.syncBgUI();this.syncCursorUI();
        return;
      }
      // Guess page title
      const titleMatch=html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const pageName=titleMatch?titleMatch[1].trim():'Imported Page';
      this._importExternalHTML(html,pageName);
    }catch(e){if(!String(e).includes('Cancelled'))alert('Import failed: '+e);}
  },

  // ── External HTML → fully-editable PageDotCom elements ─────────
  // All produced objects use the exact same props as DEFAULTS so they
  // appear in the canvas and are fully editable through the props panel.
  _importExternalHTML(html, pageName){
    const doc = (new DOMParser()).parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,meta,link,svg,canvas,iframe').forEach(n=>n.remove());

    const PAGE_W = 1100;
    const LEFT   = 170;
    const GAP    = 20;
    let cursor   = 60;
    const elements = [];

    // ── Colour helpers ──────────────────────────────────────────
    const rgbToHex = s => {
      if(!s) return null;
      if(s.startsWith('#')) return s.length===7?s:null;
      const m=s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if(!m) return null;
      return '#'+[m[1],m[2],m[3]].map(x=>parseInt(x).toString(16).padStart(2,'0')).join('');
    };
    // Return hex or null; tries inline style then nothing (no computed in DOMParser)
    const fgColor = el => {
      if(!el||!el.style) return null;
      return rgbToHex(el.style.color)||null;
    };
    const bgColor = el => {
      if(!el||!el.style) return null;
      return rgbToHex(el.style.background||el.style.backgroundColor)||null;
    };
    const fontSize = el => {
      if(!el||!el.style||!el.style.fontSize) return null;
      return Math.max(8, Math.min(120, parseInt(el.style.fontSize)||14));
    };
    const isBold = el => {
      if(!el||!el.style) return false;
      const w=el.style.fontWeight;
      return w==='bold'||parseInt(w)>=700;
    };
    const textAlign = el => {
      if(!el||!el.style) return 'left';
      return ['left','center','right','justify'].includes(el.style.textAlign)?el.style.textAlign:'left';
    };
    // Body background
    const rawBodyBg = doc.body.style.background||doc.body.style.backgroundColor||'';
    const bodyBgHex = rgbToHex(rawBodyBg)||'#0d1117';

    // ── Structural helpers ──────────────────────────────────────
    // Determine if a node is "card-like": has a heading + some body text/image
    const isCard = el => {
      if(el.nodeType!==1) return false;
      const hasHeading = !!el.querySelector('h1,h2,h3,h4,h5,h6');
      const hasPara    = !!el.querySelector('p,span');
      return hasHeading && (hasPara || el.textContent.trim().length > 30);
    };
    // Collect direct children that are all card-like (→ table of panels)
    const cardChildren = el => {
      const kids = [...el.children].filter(c=>isCard(c));
      return kids.length>=2 ? kids : [];
    };
    // Best foreground text inside an element
    const deepText = el => (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
    // First heading text inside el
    const headingText = el => {
      const h=el.querySelector('h1,h2,h3,h4,h5,h6');
      return h?deepText(h):'';
    };
    // Body text = all text minus heading text
    const bodyText = el => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('h1,h2,h3,h4,h5,h6,nav,button,img').forEach(n=>n.remove());
      return (clone.innerText||clone.textContent||'').replace(/\s+/g,' ').trim();
    };

    // ── Push helpers (produce complete, editor-friendly objects) ─
    const mkPanel = (title,body,opts={}) => ({
      title, body,
      bgColor:    opts.bgColor||'rgba(255,255,255,0.04)',
      bgMode:     'solid',
      bgGradB:    '#000000',
      bgGradDir:  'to right',
      borderColor:opts.borderColor||'rgba(255,255,255,0.12)',
      borderWidth:opts.borderWidth!=null?opts.borderWidth:1,
      borderRadius:opts.borderRadius!=null?opts.borderRadius:6,
      titleColor: opts.titleColor||'#e6edf3',
      bodyColor:  opts.bodyColor||'#8b949e',
      titleSize:  opts.titleSize||16,
      bodySize:   opts.bodySize||13,
      padding:    opts.padding||16,
      shadow:     false,
      shadowColor:'rgba(0,0,0,0.55)',
      gradientB:  '',
      hoverScale: false,
      shape:      'normal',
      textAlign:  opts.textAlign||'left',
      justify:    false,
      titleBold:  true,
      titleItalic:false,
      titleUnderline:false,
      bodyBold:   false,
      bodyItalic: false,
      bodyUnderline:false,
      fontFamily: FONTS[0].val,
      titleFont:  FONTS[0].val,
      scrollIn:   false,
      scrollInType:'scale',
      scrollInDelay:0,
    });

    const push = (type, props, h) => {
      const id = State.newId();
      const elW = (type==='navbar'||type==='divider') ? PAGE_W : PAGE_W;
      elements.push({id, type, x:LEFT, y:cursor, w:elW, h:h||'auto', props});
      cursor += (typeof h==='number'?h:80) + GAP;
    };

    // ── Seen set — avoid double-processing nested nodes ─────────
    const seen = new WeakSet();

    // ── Main walk ───────────────────────────────────────────────
    const walk = nodes => {
      for(const node of nodes){
        if(node.nodeType!==1) continue;
        if(seen.has(node)) continue;
        const tag = node.tagName.toUpperCase();
        const txt = deepText(node);

        // ── NAV / HEADER with links → Navbar ───────────────────
        if(tag==='NAV'||(tag==='HEADER'&&node.querySelector('a,nav'))){
          seen.add(node);
          const brand = doc.querySelector('title')?.textContent.trim()||pageName;
          const links = [...node.querySelectorAll('a')]
            .map(a=>a.textContent.trim()).filter(Boolean).slice(0,8)
            .map(label=>({label,target:''}));
          push('navbar',{
            brand, navLinks:links.length?links:[{label:'Home',target:''}],
            bgColor: bgColor(node)||'rgba(0,0,0,0.5)', bgMode:'solid',
            bgGradB:'#1a1a2e', bgGradDir:'to right',
            textColor:'#e6edf3', sticky:false, fullWidth:true, fontFamily:FONTS[0].val,
          }, 60);
          continue;
        }

        // ── FORM with email field → Contact ────────────────────
        if(tag==='FORM'||(tag==='SECTION'&&node.querySelector('form,input[type=email]'))){
          seen.add(node);
          const titleEl = node.querySelector('h1,h2,h3,h4');
          const titleTxt = titleEl?deepText(titleEl):'Get in Touch';
          const emailInput = node.querySelector('input[type=email],input[name*=mail]');
          push('contact',{
            title:titleTxt, email:'you@example.com',
            bgColor: bgColor(node)||'rgba(255,255,255,0.04)', bgMode:'solid',
            bgGradB:'#0d1117', bgGradDir:'to right',
            borderColor:'rgba(255,255,255,0.1)', borderRadius:6,
            btnColor:'#238636', btnLabel:'Send Message',
          }, 340);
          continue;
        }

        // ── HEADER/FOOTER that isn't a nav ──────────────────────
        if(tag==='HEADER'||tag==='FOOTER'){
          seen.add(node);
          const bg = bgColor(node);
          push('panel', mkPanel(
            tag==='HEADER'?'Header':'Footer',
            txt||'',
            {bgColor:bg||'rgba(0,0,0,0.3)',bodyColor:fgColor(node)||'#8b949e',borderWidth:0}
          ), Math.max(80, txt.length/2));
          continue;
        }

        // ── SECTION/ARTICLE/MAIN/DIV containers ─────────────────
        if(['SECTION','ARTICLE','MAIN','DIV','ASIDE'].includes(tag)){
          seen.add(node);

          // ➊ Group of sibling card children → Table element
          const cards = cardChildren(node);
          if(cards.length>=2 && cards.length<=6){
            cards.forEach(c=>seen.add(c));
            const cols = Math.min(6, cards.length);
            const cells = cards.map(c=>({
              title: headingText(c)||'',
              body:  bodyText(c)||deepText(c),
            }));
            // Pad to cols*1 rows
            push('table',{
              cols, rows:1, gap:16,
              cellBg: bgColor(cards[0])||'rgba(255,255,255,0.04)', cellBgMode:'solid',
              cellBgGradB:'#000000', cellBgGradDir:'to right',
              cellBorder:'rgba(255,255,255,0.12)', borderRadius:8,
              titleColor:'#e6edf3', bodyColor:'#8b949e',
              titleSize:14, bodySize:12, padding:16,
              hoverScale:true, cells, editingCell:0, fontFamily:FONTS[0].val,
            }, 180);
            continue;
          }

          // ➋ Single card-like container → Panel
          if(isCard(node)){
            const title = headingText(node);
            const body  = bodyText(node);
            const bg    = bgColor(node);
            const fg    = fgColor(node);
            push('panel', mkPanel(title, body, {
              bgColor: bg||'rgba(255,255,255,0.04)',
              bodyColor: fg||'#8b949e',
              textAlign: textAlign(node),
            }), Math.max(100, body.length/2));
            // Handle images inside the card separately
            node.querySelectorAll('img').forEach(img=>{
              if(seen.has(img))return;
              seen.add(img);
              const src=img.getAttribute('src')||'';
              if(!src)return;
              push('image',{
                src, alt:img.getAttribute('alt')||'',
                objectFit:'cover', borderRadius:6, border:false,
                borderColor:'rgba(255,255,255,.15)', borderWidth:2,
                imageShape:'none', shadow:false,
                scrollIn:false, scrollInType:'scale', scrollInDelay:0,
              }, 280);
            });
            continue;
          }

          // ➌ Has an image + text side-by-side → image then text
          const imgs = [...node.querySelectorAll('img')].filter(i=>!seen.has(i));
          if(imgs.length && txt.length>20){
            imgs.forEach(img=>{
              seen.add(img);
              const src=img.getAttribute('src')||'';
              if(!src)return;
              push('image',{
                src, alt:img.getAttribute('alt')||'',
                objectFit:'cover', borderRadius:6, border:false,
                borderColor:'rgba(255,255,255,.15)', borderWidth:2,
                imageShape:'none', shadow:false,
                scrollIn:false, scrollInType:'scale', scrollInDelay:0,
              }, 260);
            });
            const pureText=bodyText(node);
            if(pureText.length>10){
              push('text',{
                text:pureText, color:fgColor(node)||'#8b949e',
                fontSize:fontSize(node)||14, align:textAlign(node),
                lineHeight:1.65, bold:isBold(node), italic:false, underline:false,
                fontFamily:FONTS[0].val,
              }, Math.max(40, pureText.length/3));
            }
            continue;
          }

          // ➍ Otherwise recurse into children
          walk(node.childNodes);
          continue;
        }

        // ── HEADINGS ────────────────────────────────────────────
        if(/^H[1-6]$/.test(tag)){
          seen.add(node);
          const level = tag.toLowerCase();
          const sizeMap = {h1:52,h2:40,h3:30,h4:22,h5:18,h6:15};
          const wMap    = {h1:'900',h2:'800',h3:'700',h4:'700',h5:'600',h6:'600'};
          push('heading',{
            text:txt||'Heading', level,
            color:fgColor(node)||'#e6edf3',
            fontSize:fontSize(node)||sizeMap[level]||28,
            fontWeight:isBold(node)?'700':(wMap[level]||'700'),
            italic:false, underline:false,
            align:textAlign(node)||'left',
            letterSpacing:0, fontFamily:FONTS[0].val,
          }, sizeMap[level]||32);
          continue;
        }

        // ── PARAGRAPH / SPAN ────────────────────────────────────
        if(tag==='P'||tag==='SPAN'||tag==='LABEL'){
          seen.add(node);
          if(!txt) continue;
          push('text',{
            text:txt, color:fgColor(node)||'#8b949e',
            fontSize:fontSize(node)||14, align:textAlign(node),
            lineHeight:1.65, bold:isBold(node), italic:false, underline:false,
            fontFamily:FONTS[0].val,
          }, Math.max(32, txt.length/3));
          continue;
        }

        // ── STANDALONE IMAGES ───────────────────────────────────
        if(tag==='IMG'){
          seen.add(node);
          const src=node.getAttribute('src')||'';
          if(!src) continue;
          push('image',{
            src, alt:node.getAttribute('alt')||'',
            objectFit:'cover', borderRadius:0, border:false,
            borderColor:'rgba(255,255,255,.15)', borderWidth:2,
            imageShape:'none', shadow:false,
            scrollIn:false, scrollInType:'scale', scrollInDelay:0,
          }, 300);
          continue;
        }

        // ── BUTTON / LINK-AS-BUTTON ─────────────────────────────
        if(tag==='BUTTON'||(tag==='A'&&(node.className.includes('btn')||node.className.includes('button')))){
          seen.add(node);
          const label = txt||'Button';
          const href  = node.getAttribute('href')||'';
          push('button',{
            label, linkMode:'url', href, pageTarget:'', sectionTarget:'',
            target:'_blank',
            bgColor:bgColor(node)||'#1f6feb', bgMode:'solid',
            bgGradB:'#0d3a8f', bgGradDir:'to right', bgImage:'',
            textColor:fgColor(node)||'#ffffff',
            borderRadius:5, fontSize:fontSize(node)||14,
            paddingH:24, paddingV:10,
            bold:true, italic:false, underline:false, shadow:false,
            fontFamily:FONTS[0].val,
          }, 48);
          continue;
        }

        // ── STANDALONE ANCHOR (non-button) ──────────────────────
        if(tag==='A'){
          seen.add(node);
          if(!txt) continue;
          push('text',{
            text:txt, color:fgColor(node)||'#58a6ff',
            fontSize:14, align:'left', lineHeight:1.5,
            bold:false, italic:false, underline:true, fontFamily:FONTS[0].val,
          }, 32);
          continue;
        }

        // ── HORIZONTAL RULE ─────────────────────────────────────
        if(tag==='HR'){
          seen.add(node);
          push('divider',{
            color:fgColor(node)||'rgba(255,255,255,0.15)',
            thickness:1, style:'solid', marginV:8,
          }, 20);
          continue;
        }

        // ── CODE / PRE ──────────────────────────────────────────
        if(tag==='PRE'||tag==='CODE'){
          seen.add(node);
          const code=node.textContent||'';
          if(!code.trim()) continue;
          const lines=code.split('\n').length;
          push('codeblock',{
            code,
            bgColor:'#0d1117', bgMode:'solid', bgGradB:'#1a1a2e', bgGradDir:'to right',
            textColor:'#e6edf3', fontSize:12, borderRadius:6, fontFamily:FONTS[3].val,
          }, Math.min(400,Math.max(80,lines*18)));
          continue;
        }

        // ── TABLE ───────────────────────────────────────────────
        if(tag==='TABLE'){
          seen.add(node);
          const rows=[...node.querySelectorAll('tr')];
          if(!rows.length) continue;
          const maxCols=Math.max(...rows.map(r=>r.querySelectorAll('td,th').length));
          const cells=[];
          rows.forEach(r=>{
            [...r.querySelectorAll('td,th')].forEach(c=>{
              const cellHead=c.querySelector('strong,b,th');
              cells.push({title:cellHead?deepText(cellHead):'',body:c.textContent.trim()});
            });
          });
          const cols=Math.min(6,maxCols||2);
          const numRows=Math.min(8,rows.length||1);
          while(cells.length<cols*numRows)cells.push({title:'',body:''});
          push('table',{
            cols, rows:numRows, gap:10,
            cellBg:'rgba(255,255,255,0.04)', cellBgMode:'solid',
            cellBgGradB:'#000000', cellBgGradDir:'to right',
            cellBorder:'rgba(255,255,255,0.12)', borderRadius:6,
            titleColor:'#e6edf3', bodyColor:'#8b949e',
            titleSize:13, bodySize:11, padding:12,
            hoverScale:false, cells, editingCell:0, fontFamily:FONTS[0].val,
          }, numRows*60);
          continue;
        }

        // ── LISTS → text with bullets ───────────────────────────
        if(tag==='UL'||tag==='OL'){
          seen.add(node);
          const items=[...node.querySelectorAll('li')].map(li=>li.textContent.trim()).filter(Boolean);
          if(!items.length) continue;
          const bulleted=items.map((it,i)=>tag==='OL'?`${i+1}. ${it}`:`• ${it}`).join('\n');
          push('text',{
            text:bulleted, color:'#8b949e',
            fontSize:14, align:'left', lineHeight:1.9,
            bold:false, italic:false, underline:false, fontFamily:FONTS[0].val,
          }, items.length*28);
          continue;
        }

        // ── BLOCKQUOTE → styled panel ───────────────────────────
        if(tag==='BLOCKQUOTE'){
          seen.add(node);
          if(!txt) continue;
          push('panel', mkPanel('', '❝  '+txt, {
            bgColor:'rgba(31,111,235,0.08)',
            borderColor:'rgba(31,111,235,0.35)',
            borderWidth:2, borderRadius:6,
            titleColor:'#58a6ff', bodyColor:'#c9d1d9',
            bodySize:14,
          }), Math.max(80, txt.length/2));
          continue;
        }

        // ── Fallback: any node with meaningful text ─────────────
        if(!seen.has(node)&&txt.length>10){
          seen.add(node);
          // Check if it feels heading-like (short + maybe bold/large)
          const isHeadingLike = txt.length<80 && (isBold(node)||fontSize(node)>=18);
          if(isHeadingLike){
            push('heading',{
              text:txt, level:'h3',
              color:fgColor(node)||'#e6edf3',
              fontSize:fontSize(node)||24,
              fontWeight:isBold(node)?'700':'600',
              italic:false, underline:false, align:textAlign(node)||'left',
              letterSpacing:0, fontFamily:FONTS[0].val,
            }, 36);
          } else {
            push('text',{
              text:txt, color:fgColor(node)||'#8b949e',
              fontSize:fontSize(node)||13, align:textAlign(node)||'left',
              lineHeight:1.6, bold:isBold(node), italic:false, underline:false,
              fontFamily:FONTS[0].val,
            }, Math.max(32, Math.min(200, txt.length/3)));
          }
        }
      }
    };

    walk(doc.body.childNodes);

    if(!elements.length){
      alert('No importable content found in this HTML file.');
      return;
    }

    const page = {
      id: 'page-'+Date.now(),
      name: pageName||'Imported',
      background: {type:'solid', color:bodyBgHex},
      cursorType: 'default', cursorColor: '#00ff41',
      elements,
    };
    State.project = {name:pageName||'Imported Site', pages:[page], currentPageId:page.id};
    State.dirty = false;
    document.getElementById('project-name-display').textContent = State.project.name;
    History.clear();
    Pages.render(); Canvas.renderAll(); Props.renderNone(); this.syncBgUI(); this.syncCursorUI();
    alert(`Imported ${elements.length} element(s) from "${pageName}".\n\nAll elements are fully editable — click any to adjust in the Properties panel.\n\nLayout flows top-to-bottom; drag elements to reposition.`);
  },

  _safeName(name){
    return (name||'page').replace(/[\\/:*?"<>|]/g,'_').trim()||'page';
  },
  async exportHTML(){
    const pages=State.project.pages;
    if(!pages||!pages.length)return;
    try{
      const projectJson=JSON.stringify(State.project);
      const html=Exporter.buildSite(projectJson);
      await Tauri.save(sanitizePageName(State.project.name)+'.html',html,'html');
    }catch(e){if(!String(e).includes('Cancelled'))alert('Export failed: '+e);}
  },

  previewPage(){
    const page=State.currentPage;if(!page)return;
    document.getElementById('preview-page-name').textContent=page.name;
    document.getElementById('preview-modal').classList.remove('hidden');
    const idx=State.project.pages.indexOf(page);
    let html=Exporter.buildSiteForPage(idx);
    document.getElementById('preview-frame').src=URL.createObjectURL(new Blob([html],{type:'text/html'}));
  },
  previewNavigateTo(pageName){},  // navigation now handled inside iframe via showPage()
  closePreview(){
    const f=document.getElementById('preview-frame');
    if(f.src&&f.src.startsWith('blob:'))URL.revokeObjectURL(f.src);
    document.getElementById('preview-modal').classList.add('hidden');
    f.src='about:blank';
    this._previewProject=null;
  },

  addPage(){Pages.add();},

  setBgType(type){
    const page=State.currentPage;if(!page)return;
    if(!page.background)page.background={};
    page.background.type=type;
    document.getElementById('bg-solid-opts').classList.toggle('hidden',    type!=='solid');
    document.getElementById('bg-gradient-opts').classList.toggle('hidden', type!=='gradient');
    document.getElementById('bg-split-opts').classList.toggle('hidden',    type!=='split');
    document.getElementById('bg-image-opts').classList.toggle('hidden',    type!=='image');
    document.getElementById('bg-dynamic-opts').classList.toggle('hidden',  type!=='dynamic');
    Canvas.applyBackground();State.dirty=true;
  },
  setBgColor(color){const p=State.currentPage;if(!p)return;p.background.color=color;Canvas.applyBackground();State.dirty=true;},
  updateGradient(){
    const p=State.currentPage;if(!p)return;
    p.background.colorA=document.getElementById('bg-grad-a').value;
    p.background.colorB=document.getElementById('bg-grad-b').value;
    p.background.dir   =document.getElementById('bg-grad-dir').value;
    Canvas.applyBackground();State.dirty=true;
  },
  setDynamicBg(index){const p=State.currentPage;if(!p)return;p.background.effectIndex=parseInt(index);State.dirty=true;},
  updateSplit(){
    const p=State.currentPage;if(!p)return;
    p.background.colorA=document.getElementById('bg-split-a').value;
    p.background.colorB=document.getElementById('bg-split-b').value;
    p.background.splitAngle=parseInt(document.getElementById('bg-split-angle').value)||135;
    Canvas.applyBackground();State.dirty=true;
  },
  async chooseBgImage(){
    const p=State.currentPage;if(!p)return;
    try{
      const data=await Tauri.openImage();
      p.background.image=data;
      document.getElementById('bg-image-hint').style.display='block';
      Canvas.applyBackground();State.dirty=true;
    } catch(err){if(!String(err).includes('Cancelled'))alert('Could not load image: '+err);}
  },
  updateBgImageSize(val){
    const p=State.currentPage;if(!p)return;
    p.background.imageSize=val;Canvas.applyBackground();State.dirty=true;
  },
  updateDynColors(){
    const p=State.currentPage;if(!p)return;
    p.background.colorA=document.getElementById('bg-dyn-a').value;
    p.background.colorB=document.getElementById('bg-dyn-b').value;
    p.background.colorC=document.getElementById('bg-dyn-c').value;
    State.dirty=true;
  },
  setCursorType(type){
    const page=State.currentPage;if(!page)return;
    page.cursorType=type;
    document.getElementById('cursor-color-row').classList.toggle('hidden',type==='default'||type==='crosshair'||type==='none');
    State.dirty=true;
  },
  setCursorColor(color){const page=State.currentPage;if(!page)return;page.cursorColor=color;State.dirty=true;},
  syncBgUI(){BgLayers.syncUI();},
  syncCursorUI(){
    const page=State.currentPage;if(!page)return;
    const type=page.cursorType||'default';
    document.querySelectorAll('input[name=cursor-type]').forEach(r=>{r.checked=r.value===type;});
    document.getElementById('cursor-color').value=page.cursorColor||'#00ff41';
    document.getElementById('cursor-color-row').classList.toggle('hidden',type==='default'||type==='crosshair'||type==='none');
  },
};

// ── Helpers ───────────────────────────────────────────────────
function escHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function nl2br(s){return s.replace(/\n/g,'<br/>');}
function prop(type,label,val,key,step,min,max){
  const sa=step?`step="${step}"`:'',ma=min?`min="${min}"`:'',xa=max?`max="${max}"`:'' ;
  if(type==='textarea')return`<div class="prop-group"><label class="prop-label">${label}</label><textarea class="prop-textarea" oninput="Props.setProp(event,'${key}')">${escHtml(val)}</textarea></div>`;
  return`<div class="prop-group"><label class="prop-label">${label}</label><input class="prop-input" type="${type}" value="${escHtml(String(val))}" ${sa} ${ma} ${xa} oninput="Props.setProp(event,'${key}')"/></div>`;
}
function propColor(label,val,key){
  const safe=val&&val.startsWith('#')?val:'#000000';
  return`<div class="prop-group prop-color-row"><label class="prop-label">${label}</label><input type="color" value="${safe}" oninput="Props.setProp(event,'${key}')"/></div>`;
}
function propSelect(label,val,key,options){
  const opts=options.map(o=>`<option value="${o}"${o===String(val)?' selected':''}>${o}</option>`).join('');
  return`<div class="prop-group"><label class="prop-label">${label}</label><select class="prop-select" onchange="Props.setProp(event,'${key}')">${opts}</select></div>`;
}
function propCheck(label,val,key){
  return`<div class="prop-group"><label class="prop-check-row"><input type="checkbox" ${val?'checked':''} onchange="Props.setProp(event,'${key}')"/> ${label}</label></div>`;
}
function propFontSelect(label,val,key){
  const opts=FONTS.map(f=>`<option value="${f.val}"${f.val===val?' selected':''}>${f.label}</option>`).join('');
  return`<div class="prop-group"><label class="prop-label">${label}</label><select class="prop-select prop-font-select" onchange="Props.setProp(event,'${key}')">${opts}</select></div>`;
}
// Background picker: solid color + gradient (L→R, T→B, radial) + optional photo
function propBgPicker(p,hasPhoto){
  const mode=p.bgMode||'solid';
  const tabs=`<div class="link-mode-row" style="flex-wrap:wrap;gap:3px;">
    <button class="link-mode-btn${mode==='solid'?' active':''}" onclick="Props.setPropDirect('bgMode','solid')">Solid</button>
    <button class="link-mode-btn${mode==='gradient'?' active':''}" onclick="Props.setPropDirect('bgMode','gradient')">Gradient</button>
    <button class="link-mode-btn${mode==='texture'?' active':''}" onclick="Props.setPropDirect('bgMode','texture')">Texture</button>
    ${hasPhoto?`<button class="link-mode-btn${mode==='image'?' active':''}" onclick="Props.setPropDirect('bgMode','image')">Photo</button>`:''}
  </div>`;
  let body='';
  if(mode==='solid'){
    const safe=p.bgColor&&p.bgColor.startsWith('#')?p.bgColor:'#000000';
    body=`<div class="prop-color-row" style="margin-top:4px;"><label class="prop-label" style="font-size:10px;">Color</label><input type="color" value="${safe}" oninput="Props.setProp(event,'bgColor')"/></div>`;
  } else if(mode==='gradient'){
    const safeA=p.bgColor&&p.bgColor.startsWith('#')?p.bgColor:'#1f6feb';
    const safeB=(p.bgGradB||'#000000').startsWith('#')?(p.bgGradB||'#000000'):'#000000';
    const dir=p.bgGradDir||'to right';
    body=`<div style="margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">From</label><input type="color" value="${safeA}" oninput="Props.setProp(event,'bgColor')"/></div>
      <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">To</label><input type="color" value="${safeB}" oninput="Props.setProp(event,'bgGradB')"/></div>
    </div>
    <select class="prop-select" style="margin-top:4px;" onchange="Props.setProp(event,'bgGradDir')">
      <option value="to right"${dir==='to right'?' selected':''}>→ Left to Right</option>
      <option value="to bottom"${dir==='to bottom'?' selected':''}>↓ Top to Bottom</option>
      <option value="135deg"${dir==='135deg'?' selected':''}>↘ Diagonal</option>
      <option value="radial"${dir==='radial'?' selected':''}>◎ Center Outward</option>
    </select>`;
  } else if(mode==='texture'){
    const tx=p.bgTexture||'marble';
    const c1=p.bgTexColor1&&p.bgTexColor1.startsWith('#')?p.bgTexColor1:'#888888';
    const c2=p.bgTexColor2&&p.bgTexColor2.startsWith('#')?p.bgTexColor2:'#333333';
    const txOpts=Textures.DEFS.map(d=>`<option value="${d.id}"${d.id===tx?' selected':''}>${d.label}</option>`).join('');
    body=`<select class="prop-select" style="margin-top:4px;" onchange="Props.setPropDirect('bgTexture',this.value)">${txOpts}</select>
    <div style="margin-top:4px;display:flex;gap:6px;align-items:center;">
      <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">Color 1</label><input type="color" value="${c1}" oninput="Props.setPropDirect('bgTexColor1',this.value)"/></div>
      <div style="display:flex;align-items:center;gap:4px;"><label style="font-size:10px;color:var(--muted);">Color 2</label><input type="color" value="${c2}" oninput="Props.setPropDirect('bgTexColor2',this.value)"/></div>
    </div>`;
  } else if(mode==='image'){
    body=`<div style="margin-top:4px;"><button class="prop-btn" onclick="Props.chooseBgImage()">🖼 Choose Photo</button>${p.bgImage?'<span style="font-size:10px;color:var(--muted);margin-left:6px;">✓ Photo set</span>':''}</div>`;
  }
  return `<div class="prop-group"><label class="prop-label">Background</label>${tabs}${body}</div>`;
}

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('message',function(e){
  if(e.data&&e.data.type==='previewNav') App.previewNavigateTo(e.data.page);
});
window.addEventListener('DOMContentLoaded',()=>{
  App.init();
  // Inject viewport breakpoint guides into the canvas
  // Canvas=1440px. Phone=390px (center at 525–915). Tablet=768px (center at 336–1104).
  const canvas=document.getElementById('editor-canvas');
  function makeGuide(x, cls, label){
    const g=document.createElement('div');
    g.className='bp-guide '+cls;
    g.style.left=x+'px';
    const lbl=document.createElement('div');
    lbl.className='bp-guide-label';
    lbl.textContent=label;
    g.appendChild(lbl);
    canvas.appendChild(g);
  }
  // Phone shading (outside 390px center)
  function makeShade(x1,x2){
    const s=document.createElement('div');
    s.className='bp-shading';
    s.style.left=x1+'px'; s.style.width=(x2-x1)+'px';
    canvas.appendChild(s);
  }
  const phoneL=525, phoneR=915;   // (1440-390)/2 = 525
  const tabL=336,   tabR=1104;    // (1440-768)/2 = 336
  makeShade(0, tabL);
  makeShade(tabR, 1440);
  makeGuide(tabL,  'bp-guide-tablet', '768px tablet');
  makeGuide(tabR,  'bp-guide-tablet', '');
  makeGuide(phoneL,'bp-guide-phone',  '390px phone');
  makeGuide(phoneR,'bp-guide-phone',  '');
  // Center the canvas in viewport
  const wrap=document.getElementById('canvas-wrap');
  if(wrap) wrap.scrollLeft=(wrap.scrollWidth-wrap.clientWidth)/2;
});
