// ═══════════════════════════════════════════════════════════════
// PageDotCom — BgEffects  v2
// Generates self-contained <script> blocks for HTML export/preview
// ═══════════════════════════════════════════════════════════════
'use strict';

const BgEffects = {
  names: [
    'Particle Network','Starfield Warp','Flowing Topology',
    'Falling Geometry','Oscilloscope Waves','Neural Network',
    'Metaballs','DNA Helix','Perlin Flow Field','Grid Pulse',
    'Circuit Board','Aurora Borealis',
  ],

  // ── Public: called by Exporter to embed into exported HTML ──
  generateScript(index, cA, cB, cC) {
    const colors = `['${cA}','${cB}','${cC}']`;
    return `<script>
(function(){
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const RAW = ${colors};
  const COLORS = RAW.map(h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]);
  function rc() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
  function rgba(c, a) { return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; }
  let W, H;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  ${this._perlin()}
  ${this._effect(index)}
  start();
})();
<\/script>`;
  },

  // ── Cancelable version: returns a JS function string (canvas) => stopFn
  // Used in multi-page buildSite so each page's bg can be started/stopped cleanly.
  generateCancelable(index, cA, cB, cC) {
    const colors = `['${cA}','${cB}','${cC}']`;
    return `(function(canvas){
  const ctx = canvas.getContext('2d');
  const RAW = ${colors};
  const COLORS = RAW.map(h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)]);
  function rc() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
  function rgba(c, a) { return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; }
  let W, H, _alive = true;
  const _realRaf = window.requestAnimationFrame.bind(window);
  function requestAnimationFrame(fn){ return _realRaf(function(t){ if(_alive) fn(t); }); }
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  ${this._perlin()}
  ${this._effect(index)}
  start();
  return function(){ _alive=false; window.removeEventListener('resize',resize); };
})`;
  },

  // ── Shared Perlin noise ──────────────────────────────────────
  _perlin() {
    return `
const perm = new Uint8Array(512);
(function(){
  const p = Array.from({length:256}, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [p[i],p[j]]=[p[j],p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
})();
function fade(t) { return t*t*t*(t*(t*6-15)+10); }
function lerp(a,b,t) { return a+(b-a)*t; }
function grad(h,x,y) { const u=h<8?x:y, v=h<4?y:h===12||h===14?x:0; return((h&1)?-u:u)+((h&2)?-v:v); }
function noise(x,y) {
  const xi=Math.floor(x)&255, yi=Math.floor(y)&255;
  const xf=x-Math.floor(x), yf=y-Math.floor(y);
  const u=fade(xf), v=fade(yf);
  const aa=perm[perm[xi]+yi], ab=perm[perm[xi]+yi+1],
        ba=perm[perm[xi+1]+yi], bb=perm[perm[xi+1]+yi+1];
  return lerp(lerp(grad(aa,xf,yf),grad(ba,xf-1,yf),u),
              lerp(grad(ab,xf,yf-1),grad(bb,xf-1,yf-1),u), v);
}`;
  },

  // ── Effect code by index ─────────────────────────────────────
  _effect(i) {
    const fx = [
      // 0 — Particle Network
      `function start(){
  const pts = Array.from({length:110}, () => ({x:Math.random()*W, y:Math.random()*H, vx:(Math.random()-.5)*.45, vy:(Math.random()-.5)*.45, r:Math.random()*1.4+.5, col:rc()}));
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.18)'; ctx.fillRect(0,0,W,H);
    for (const p of pts) {
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0||p.x>W)p.vx*=-1; if(p.y<0||p.y>H)p.vy*=-1;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=rgba(p.col,.85); ctx.fill();
    }
    for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++){
      const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y, d=Math.sqrt(dx*dx+dy*dy);
      if(d<130){ ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y);
        ctx.strokeStyle=rgba(pts[i].col,(1-d/130)*.3); ctx.lineWidth=.6; ctx.stroke(); }
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 1 — Starfield Warp
      `function start(){
  const stars = Array.from({length:280}, ()=>({x:(Math.random()-.5)*W*3, y:(Math.random()-.5)*H*3, z:Math.random()*W, pz:0}));
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.28)'; ctx.fillRect(0,0,W,H);
    for(const s of stars){
      s.pz=s.z; s.z-=5;
      if(s.z<=0){s.x=(Math.random()-.5)*W*3;s.y=(Math.random()-.5)*H*3;s.z=W;s.pz=W;}
      const sx=s.x/s.z*W+W/2, sy=s.y/s.z*H+H/2;
      const px=s.x/s.pz*W+W/2, py=s.y/s.pz*H+H/2;
      const br=1-s.z/W, col=COLORS[Math.floor(br*(COLORS.length-1))];
      ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(sx,sy);
      ctx.strokeStyle=rgba(col,br*.9); ctx.lineWidth=Math.max(.1,br*2.5); ctx.stroke();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 2 — Flowing Topology
      `function start(){
  let t=0;
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.10)'; ctx.fillRect(0,0,W,H); t+=.004;
    for(let l=0;l<10;l++){
      ctx.beginPath(); let first=true;
      for(let x=0;x<W;x+=5){
        const y=H/2+noise(x*.003+t*.4,l*.38)*H*.42+Math.sin(x*.007+t+l*.8)*H*.055;
        first?(ctx.moveTo(x,y),first=false):ctx.lineTo(x,y);
      }
      ctx.strokeStyle=rgba(COLORS[l%COLORS.length],.07+l*.018);
      ctx.lineWidth=1.3; ctx.stroke();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 3 — Falling Geometry
      `function start(){
  const mk=()=>{const col=rc();return{x:Math.random()*W,y:Math.random()*H-H,vy:.3+Math.random()*.7,vr:.004+Math.random()*.014,rot:Math.random()*Math.PI*2,sz:10+Math.random()*30,sides:[3,4,6][Math.floor(Math.random()*3)],col,a:.1+Math.random()*.3};};
  const shapes=Array.from({length:40},mk);
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.14)'; ctx.fillRect(0,0,W,H);
    for(const s of shapes){
      s.y+=s.vy; s.rot+=s.vr;
      if(s.y>H+60) Object.assign(s,mk(),{y:-60,x:Math.random()*W});
      ctx.beginPath();
      for(let i=0;i<s.sides;i++){const a=s.rot+i*(Math.PI*2/s.sides); i===0?ctx.moveTo(s.x+Math.cos(a)*s.sz,s.y+Math.sin(a)*s.sz):ctx.lineTo(s.x+Math.cos(a)*s.sz,s.y+Math.sin(a)*s.sz);}
      ctx.closePath(); ctx.strokeStyle=rgba(s.col,s.a); ctx.lineWidth=1.2; ctx.stroke();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 4 — Oscilloscope Waves
      `function start(){
  let t=0;
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.13)'; ctx.fillRect(0,0,W,H); t+=.018;
    for(let w=0;w<6;w++){
      const col=COLORS[w%COLORS.length], amp=H*.055+w*(H*.03), yOff=H/2+(w-2.5)*(H*.07);
      ctx.beginPath();
      for(let x=0;x<=W;x+=2){const y=yOff+Math.sin(x*.011*(1+w*.4)+t+w)*amp+Math.sin(x*.025+t*1.4+w)*amp*.35; x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
      ctx.strokeStyle=rgba(col,.12+w*.04); ctx.lineWidth=1.4; ctx.stroke();
    }
    ctx.beginPath();
    for(let x=0;x<=W;x+=2){const y=H/2+Math.sin(x*.01+t)*H*.1; x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
    ctx.strokeStyle=rgba(COLORS[0],.6); ctx.lineWidth=1.8; ctx.stroke();
    requestAnimationFrame(loop);
  } loop();
}`,
      // 5 — Neural Network
      `function start(){
  const LAYERS=[3,5,5,3]; const nodes=[]; const lw=W*.55,lh=H*.6,cx=W/2,cy=H/2;
  for(let l=0;l<LAYERS.length;l++){const x=cx-lw/2+l*(lw/(LAYERS.length-1));for(let n=0;n<LAYERS[l];n++) nodes.push({x,y:cy-lh/2+(n+.5)*(lh/LAYERS[l]),l,pulse:0,phase:Math.random()*Math.PI*2,col:COLORS[l%COLORS.length]});}
  const edges=[];
  for(let i=0;i<nodes.length;i++) for(let j=0;j<nodes.length;j++) if(nodes[j].l===nodes[i].l+1) edges.push({a:i,b:j,t:0,on:false,timer:Math.random()*200,col:rc()});
  let T=0;
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.20)'; ctx.fillRect(0,0,W,H); T++;
    for(const e of edges){
      e.timer--; if(e.timer<=0){e.on=true;e.t=0;e.timer=60+Math.random()*160;}
      if(e.on){e.t+=.028;if(e.t>=1){e.on=false;nodes[e.b].pulse=1;}}
      const a=nodes[e.a],b=nodes[e.b];
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=rgba(a.col,.07);ctx.lineWidth=.8;ctx.stroke();
      if(e.on){const px=a.x+(b.x-a.x)*e.t,py=a.y+(b.y-a.y)*e.t;ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fillStyle=rgba(e.col,.95);ctx.fill();}
    }
    for(const nd of nodes){
      nd.pulse*=.92; const g=.3+nd.pulse*.7+Math.sin(nd.phase+T*.04)*.12;
      ctx.beginPath();ctx.arc(nd.x,nd.y,5+nd.pulse*4,0,Math.PI*2);ctx.fillStyle=rgba(nd.col,g);ctx.fill();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 6 — Metaballs
      `function start(){
  const balls=Array.from({length:6},()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.7,vy:(Math.random()-.5)*.7,r:70+Math.random()*90}));
  const SC=4; const off=document.createElement('canvas'); const octx=off.getContext('2d');
  function loop(){
    off.width=Math.floor(W/SC); off.height=Math.floor(H/SC);
    ctx.fillStyle='rgba(3,5,15,.30)'; ctx.fillRect(0,0,W,H);
    for(const b of balls){b.x+=b.vx;b.y+=b.vy;if(b.x<0||b.x>W)b.vx*=-1;if(b.y<0||b.y>H)b.vy*=-1;}
    const id=octx.createImageData(off.width,off.height);
    for(let y=0;y<off.height;y++) for(let x=0;x<off.width;x++){
      let v=0; for(const b of balls){const dx=x*SC-b.x,dy=y*SC-b.y;v+=b.r*b.r/(dx*dx+dy*dy+1);}
      const idx=(y*off.width+x)*4;
      if(v>1){const t=Math.min(1,(v-1)*2.5),col=COLORS[Math.floor(t*(COLORS.length-1))];
        id.data[idx]=col[0];id.data[idx+1]=col[1];id.data[idx+2]=col[2];id.data[idx+3]=Math.floor(t*200);}
    }
    octx.putImageData(id,0,0); ctx.drawImage(off,0,0,W,H);
    requestAnimationFrame(loop);
  } loop();
}`,
      // 7 — DNA Helix
      `function start(){
  let t=0;
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.13)'; ctx.fillRect(0,0,W,H); t+=.022;
    const cx=W/2,amp=W*.11,freq=.017,steps=Math.ceil(H/7);
    for(let s=0;s<2;s++){
      const ph=s*Math.PI; ctx.beginPath();
      for(let i=0;i<=steps;i++){const y=i*(H/steps),x=cx+Math.sin(y*freq+t+ph)*amp; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
      ctx.strokeStyle=rgba(COLORS[s],.55);ctx.lineWidth=2;ctx.stroke();
    }
    for(let i=0;i<=steps;i+=3){
      const y=i*(H/steps),x1=cx+Math.sin(y*freq+t)*amp,x2=cx+Math.sin(y*freq+t+Math.PI)*amp;
      const m=Math.abs(Math.sin(y*freq+t));
      ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.strokeStyle=rgba(COLORS[2%COLORS.length],.12+m*.22);ctx.lineWidth=1.1;ctx.stroke();
      ctx.beginPath();ctx.arc(x1,y,2.2,0,Math.PI*2);ctx.fillStyle=rgba(COLORS[0],.85);ctx.fill();
      ctx.beginPath();ctx.arc(x2,y,2.2,0,Math.PI*2);ctx.fillStyle=rgba(COLORS[1],.85);ctx.fill();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 8 — Perlin Flow Field
      `function start(){
  const pts=Array.from({length:650},()=>{const col=rc();return{x:Math.random()*W,y:Math.random()*H,life:0,max:160+Math.random()*200,spd:.9+Math.random()*.7,r:col[0],g:col[1],b:col[2],sz:.5+Math.random()*1.1};});
  let T=0; ctx.fillStyle='#03050f'; ctx.fillRect(0,0,W,H);
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.018)'; ctx.fillRect(0,0,W,H); T+=.0005;
    for(const p of pts){
      const px=p.x,py=p.y,angle=noise(p.x*.0032,p.y*.0032+T)*Math.PI*4;
      p.x+=Math.cos(angle)*p.spd; p.y+=Math.sin(angle)*p.spd; p.life++;
      const lr=p.life/p.max,a=lr<.1?lr*10*.5:lr>.85?(1-lr)/.15*.5:.5;
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(p.x,p.y);
      ctx.strokeStyle='rgba('+p.r+','+p.g+','+p.b+','+a+')';ctx.lineWidth=p.sz;ctx.stroke();
      if(p.life>=p.max||p.x<-5||p.x>W+5||p.y<-5||p.y>H+5){
        const col=rc();Object.assign(p,{x:Math.random()<.5?0:W,y:Math.random()*H,life:0,max:160+Math.random()*200,r:col[0],g:col[1],b:col[2]});
      }
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 9 — Grid Pulse
      `function start(){
  const CELL=50,gc=Math.ceil(W/CELL)+1,gr=Math.ceil(H/CELL)+1;
  const cells=Array.from({length:gc*gr},()=>({phase:Math.random()*Math.PI*2,spd:.008+Math.random()*.018,col:rc()}));
  let ripples=[],T=0;
  function spawnR(){ripples.push({cx:Math.floor(Math.random()*gc),cy:Math.floor(Math.random()*gr),r:0,maxR:Math.max(gc,gr)*.75,spd:.2+Math.random()*.15,col:rc(),str:.6+Math.random()*.35});}
  spawnR();let rInt=setInterval(spawnR,1800);
  function loop(){
    ctx.clearRect(0,0,W,H); T+=.012;
    ctx.strokeStyle='rgba(0,180,220,.04)';ctx.lineWidth=.5;
    for(let c=0;c<=gc;c++){ctx.beginPath();ctx.moveTo(c*CELL,0);ctx.lineTo(c*CELL,H);ctx.stroke();}
    for(let r=0;r<=gr;r++){ctx.beginPath();ctx.moveTo(0,r*CELL);ctx.lineTo(W,r*CELL);ctx.stroke();}
    for(let c=0;c<=gc;c++) for(let r=0;r<=gr;r++){
      const cell=cells[(c%gc+(r%gr)*gc)%cells.length];
      const base=(Math.sin(cell.phase+T*cell.spd*80)+1)*.5;
      let rA=0;
      for(const rp of ripples){const d=Math.sqrt((c-rp.cx)**2+(r-rp.cy)**2);rA+=Math.sin((d-rp.r)*1.8)*rp.str*Math.max(0,1-Math.abs(d-rp.r)/3.5)*Math.max(0,1-rp.r/rp.maxR);}
      const br=Math.max(0,Math.min(1,base*.2+rA*.8));if(br<.02)continue;
      ctx.beginPath();ctx.arc(c*CELL,r*CELL,.8+br*3,0,Math.PI*2);ctx.fillStyle=rgba(cell.col,br*.9);ctx.fill();
    }
    for(let i=ripples.length-1;i>=0;i--){ripples[i].r+=ripples[i].spd*2.5;if(ripples[i].r>ripples[i].maxR)ripples.splice(i,1);}
    for(const c of cells)c.phase+=c.spd*.04;
    requestAnimationFrame(loop);
  } loop();
}`,
      // 10 — Circuit Board
      `function start(){
  const GRID=38;
  function buildTraces(){
    const cols=Math.ceil(W/GRID)+1,rows=Math.ceil(H/GRID)+1,traces=[],used=new Set();
    const key=(x,y)=>x+','+y;
    for(let a=0;a<220;a++){
      let gx=Math.floor(Math.random()*cols),gy=Math.floor(Math.random()*rows);
      const pts=[{x:gx*GRID,y:gy*GRID}],col=rc();let dir=Math.floor(Math.random()*4);
      for(let s=0;s<2+Math.floor(Math.random()*6);s++){
        const len=2+Math.floor(Math.random()*5);
        if(Math.random()>.45)dir=(dir+(Math.random()>.5?1:3))%4;
        const dx=[1,0,-1,0][dir],dy=[0,1,0,-1][dir];let nx=gx,ny=gy;
        for(let step=0;step<len;step++){nx+=dx;ny+=dy;if(nx<0||nx>=cols||ny<0||ny>=rows)break;const k=key(nx,ny);if(used.has(k))break;used.add(k);pts.push({x:nx*GRID,y:ny*GRID});}
        gx=nx;gy=ny;
      }
      if(pts.length>=2)traces.push({pts,col,pulse:{t:Math.random(),speed:.0012+Math.random()*.0022,active:Math.random()>.35}});
    }
    return traces;
  }
  const traces=buildTraces();
  function pal(pts,t){const total=pts.length-1,sc=t*total,idx=Math.min(Math.floor(sc),total-1),frac=sc-idx,a=pts[idx],b=pts[idx+1];return{x:a.x+(b.x-a.x)*frac,y:a.y+(b.y-a.y)*frac};}
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.08)';ctx.fillRect(0,0,W,H);
    for(const tr of traces){
      ctx.beginPath();ctx.moveTo(tr.pts[0].x,tr.pts[0].y);for(let i=1;i<tr.pts.length;i++)ctx.lineTo(tr.pts[i].x,tr.pts[i].y);
      ctx.strokeStyle=rgba(tr.col,.10);ctx.lineWidth=1.2;ctx.lineJoin='round';ctx.stroke();
      if(!tr.pulse.active)continue;
      tr.pulse.t+=tr.pulse.speed;if(tr.pulse.t>1.08)tr.pulse.t=-0.08;
      const t2=Math.max(0,Math.min(1,tr.pulse.t)),pos=pal(tr.pts,t2);
      ctx.beginPath();ctx.arc(pos.x,pos.y,2.8,0,Math.PI*2);ctx.fillStyle=rgba(tr.col,.92);ctx.fill();
      ctx.beginPath();ctx.arc(pos.x,pos.y,7,0,Math.PI*2);ctx.fillStyle=rgba(tr.col,.15);ctx.fill();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
      // 11 — Aurora Borealis
      `function start(){
  let T=0;
  function loop(){
    ctx.fillStyle='rgba(3,5,15,.06)';ctx.fillRect(0,0,W,H); T+=.003;
    for(let band=0;band<5;band++){
      const yBase=H*.15+band*(H*.15);
      ctx.beginPath();ctx.moveTo(0,H);
      for(let x=0;x<=W;x+=4){
        const n=noise(x*.002+T+band*.5,T*.3+band*.3);
        const y=yBase+n*H*.22+Math.sin(x*.006+T*1.5+band)*H*.06;
        ctx.lineTo(x,y);
      }
      ctx.lineTo(W,H);ctx.closePath();
      const col=COLORS[band%COLORS.length];
      const grad=ctx.createLinearGradient(0,yBase-H*.2,0,yBase+H*.05);
      grad.addColorStop(0,rgba(col,0));grad.addColorStop(.5,rgba(col,.06+band*.01));grad.addColorStop(1,rgba(col,0));
      ctx.fillStyle=grad;ctx.fill();
    }
    requestAnimationFrame(loop);
  } loop();
}`,
    ];
    return fx[i] || fx[0];
  },
};
