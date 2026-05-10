// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const COL = { SEVERITY:0, LOG_ID:1, TIMESTAMP:2, SRC_HOST:3, DST_HOST:4, USER:5, EVENT:6, PROCESS:7, LOG_SOURCE:8, HOST_OS:9, DETAILS:10, SUBMITTED:11, COMMENT:12 };

let cy = null;
let allRows = [];
let currentTab = 'auto';
let currentMode = 'select';
let editModeOn = false;
let scrubberVisible = false;
let playInterval = null;
let sortedTimestamps = [];
let savedMaps = [];
let activeMapId = null;
let freeEdgeSource = null;
let pendingEdgeTarget = null;
let selectedNodeType = 'host';
let clickPos = null;
let freeElements = []; // persisted freehand canvas state

const ANALYST_NAME = localStorage.getItem('ir_analyst_name') || 'Okänd';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function sevKey(raw='') {
  const s = raw.toLowerCase();
  if (s.includes('high'))   return 'high';
  if (s.includes('medium')) return 'medium';
  if (s.includes('low'))    return 'low';
  return 'info';
}
function sevColor(k) {
  return {high:'#ef4444',medium:'#f59e0b',low:'#3b82f6',info:'#475569'}[k]||'#475569';
}
function fmtTs(ts) {
  if (!ts||ts==='N/A') return '—';
  try { return new Date(ts).toLocaleString('sv-SE',{dateStyle:'short',timeStyle:'medium'}); } catch { return ts; }
}
function parseAnalyst(c='') {
  const m = c.match(/^\[(.+?)\]\s*(.*)/);
  return m ? { analyst:m[1], text:m[2] } : { analyst:'—', text:c };
}
function eventShort(e='') {
  const p = String(e).split('—');
  return p.length>1 ? p.slice(1).join('—').trim() : e;
}
function showToast(msg, ms=2000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>t.classList.remove('show'), ms);
}
function nodeTypeIcon(type) {
  return {host:'💻',server:'🖥',dc:'🏛',internet:'🌐',user:'👤',unknown:'❓'}[type]||'💻';
}

// ─────────────────────────────────────────────
// CYTOSCAPE INIT
// ─────────────────────────────────────────────
function initCy() {
  cy = cytoscape({
    container: document.getElementById('cy'),
    style: [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          'border-color': 'data(borderColor)',
          'border-width': 2,
          'label': 'data(label)',
          'color': '#e2e8f0',
          'font-family': 'JetBrains Mono, monospace',
          'font-size': 10,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 4,
          'width': 48,
          'height': 48,
          'shape': 'data(shape)',
          'text-wrap': 'wrap',
          'text-max-width': 80,
        }
      },
      {
        selector: 'node:selected',
        style: {
          'border-color': '#38bdf8',
          'border-width': 3,
          'box-shadow': '0 0 12px rgba(56,189,248,0.6)',
        }
      },
      {
        selector: 'node.dimmed',
        style: { 'opacity': 0.3 }
      },
      {
        selector: 'edge',
        style: {
          'line-color': 'data(color)',
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'width': 'data(width)',
          'label': 'data(label)',
          'color': '#94a3b8',
          'font-family': 'JetBrains Mono, monospace',
          'font-size': 9,
          'text-background-color': '#0f172a',
          'text-background-opacity': 0.85,
          'text-background-padding': 2,
          'line-style': 'data(lineStyle)',
          'opacity': 0.85,
        }
      },
      {
        selector: 'edge:selected',
        style: { 'line-color': '#38bdf8', 'target-arrow-color': '#38bdf8', 'opacity': 1 }
      },
      {
        selector: 'edge.dimmed',
        style: { 'opacity': 0.1 }
      },
      {
        selector: 'node.scrub-active',
        style: {
          'border-color': '#38bdf8',
          'border-width': 4,
          'box-shadow': '0 0 20px rgba(56,189,248,0.8)',
        }
      },
    ],
    layout: { name: 'preset' },
    wheelSensitivity: 0.3,
    minZoom: 0.1,
    maxZoom: 5,
  });

  cy.on('tap', 'node', e => onNodeClick(e.target));
  cy.on('tap', 'edge', e => onEdgeClick(e.target));
  cy.on('tap', e => { if (e.target === cy) { handleCanvasClick(e); } });
}

// ─────────────────────────────────────────────
// AUTO-GENERATE GRAPH FROM TIMELINE
// ─────────────────────────────────────────────
function buildAutoGraph(rows) {
  const nodes = {};   // id → { id, sev, events:[] }
  const edges = {};   // 'src|dst' → { src, dst, sev, events:[] }

  rows.forEach(row => {
    const src = row[COL.SRC_HOST];
    const dst = row[COL.DST_HOST];
    const sev = sevKey(row[COL.SEVERITY]);

    if (src && src !== 'N/A') {
      if (!nodes[src]) nodes[src] = { id: src, sev: 'info', events: [], type: 'host', isSource: true };
      nodes[src].events.push(row);
      const sevOrd = {high:3,medium:2,low:1,info:0};
      if (sevOrd[sev] > sevOrd[nodes[src].sev]) nodes[src].sev = sev;
    }

    // Only add dst if it's a different, non-N/A host (not an IP-like string — those are handled separately)
    if (dst && dst !== 'N/A' && dst !== src) {
      const isDomain = dst.includes('.');
      const nodeType = isDomain && !dst.match(/^[\d.]+$/) ? 'internet' : 'host';
      if (!nodes[dst]) nodes[dst] = { id: dst, sev: 'info', events: [], type: nodeType };
      nodes[dst].events.push(row);
      const sevOrd = {high:3,medium:2,low:1,info:0};
      if (sevOrd[sev] > sevOrd[nodes[dst].sev]) nodes[dst].sev = sev;

      // Create edge only if both src and dst are present — evidence-based
      if (src && src !== 'N/A') {
        const eKey = `${src}|${dst}`;
        if (!edges[eKey]) edges[eKey] = { src, dst, sev: 'info', events: [] };
        edges[eKey].events.push(row);
        if (sevOrd[sev] > sevOrd[edges[eKey].sev]) edges[eKey].sev = sev;
      }
    }
  });

  // Build Cytoscape elements
  const elements = [];
  Object.values(nodes).forEach(n => {
    const isInternet = n.type === 'internet';
    const icon = isInternet ? '🌐' : '💻';
    elements.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: `${icon}\n${n.id.length>16?n.id.slice(0,15)+'…':n.id}`,
        fullLabel: n.id,
        color: isInternet ? '#0f172a' : colorForSev(n.sev),
        borderColor: sevColor(n.sev),
        shape: isInternet ? 'diamond' : 'ellipse',
        sev: n.sev,
        type: n.type,
        events: n.events,
        evidenced: true,
        analyst: false,
      }
    });
  });

  Object.entries(edges).forEach(([key, e]) => {
    const sevOrd = {high:3,medium:2,low:1,info:0};
    elements.push({
      group: 'edges',
      data: {
        id: key,
        source: e.src,
        target: e.dst,
        color: sevColor(e.sev),
        width: Math.min(1 + e.events.length * 0.4, 5),
        label: `${e.events.length} händelse${e.events.length>1?'r':''}`,
        sev: e.sev,
        events: e.events,
        lineStyle: 'solid',
        evidenced: true,
      }
    });
  });

  return elements;
}

function colorForSev(sev) {
  return {high:'rgba(239,68,68,0.25)',medium:'rgba(245,158,11,0.25)',low:'rgba(59,130,246,0.25)',info:'rgba(71,85,105,0.25)'}[sev]||'rgba(71,85,105,0.25)';
}

// ─────────────────────────────────────────────
// LOAD TIMELINE DATA
// ─────────────────────────────────────────────
async function loadTimeline() {
  try {
    const res = await fetch('/api/timeline');
    const data = await res.json();
    allRows = data.rows || [];
    sortedTimestamps = allRows
      .map(r => r[COL.TIMESTAMP]).filter(t=>t&&t!=='N/A')
      .map(t=>new Date(t)).filter(d=>!isNaN(d)).sort((a,b)=>a-b);

    if (currentTab === 'auto') {
      loadAutoGraph();
    }
  } catch(e) {
    showToast('❌ Kunde inte ladda timeline-data');
  }
}

function loadAutoGraph() {
  const elements = buildAutoGraph(allRows);
  cy.elements().remove();
  cy.add(elements);
  doLayout('cose');
}

function reloadTimeline() {
  showToast('↺ Laddar om data...');
  loadTimeline();
}

// ─────────────────────────────────────────────
// LAYOUT
// ─────────────────────────────────────────────
function doLayout(name) {
  const opts = {
    cose: { name:'cose', idealEdgeLength:140, nodeOverlap:20, refresh:20, fit:true, padding:50, randomize:false, componentSpacing:100, nodeRepulsion:450000, edgeElasticity:100, nestingFactor:5, gravity:80, numIter:1000, initialTemp:200, coolingFactor:0.95, minTemp:1 },
    breadthfirst: { name:'breadthfirst', fit:true, padding:50, spacingFactor:1.5, directed:true },
    circle: { name:'circle', fit:true, padding:50 },
    grid: { name:'grid', fit:true, padding:50 },
  };
  cy.layout(opts[name]||opts.cose).run();
}

function autoLayout(name) { doLayout(name); }
function fitAll() { cy.fit(50); }

// ─────────────────────────────────────────────
// NODE / EDGE CLICK → DETAIL PANEL
// ─────────────────────────────────────────────
function onNodeClick(node) {
  if (currentMode === 'add-edge' && currentTab === 'free') {
    handleFreeEdgeClick(node); return;
  }
  if (currentMode === 'delete') { node.remove(); return; }
  showNodeDetail(node);
}

function onEdgeClick(edge) {
  if (currentMode === 'delete') { edge.remove(); return; }
  showEdgeDetail(edge);
}

function showNodeDetail(node) {
  const d = node.data();
  const panel = document.getElementById('detailPanel');
  const title = document.getElementById('detailTitle');
  const body  = document.getElementById('detailBody');
  panel.classList.remove('hidden');
  title.textContent = d.fullLabel || d.id;

  const events = d.events || [];
  const sevs = events.map(r=>sevKey(r[COL.SEVERITY]));
  const highest = ['high','medium','low','info'].find(s=>sevs.includes(s))||'info';
  const users = [...new Set(events.map(r=>r[COL.USER]).filter(u=>u&&u!=='N/A'))];
  const evtTypes = [...new Set(events.map(r=>eventShort(r[COL.EVENT])).filter(Boolean))];

  body.innerHTML = `
    <div class="detail-stat"><span class="detail-stat-label">Nod-ID</span><span class="detail-stat-value">${d.fullLabel||d.id}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Typ</span><span class="detail-stat-value">${nodeTypeIcon(d.type)} ${d.type||'host'}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Max allvarlighet</span><span class="detail-stat-value" style="color:${sevColor(highest)}"><span class="sev-dot ${highest}"></span>${highest.toUpperCase()}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Händelser</span><span class="detail-stat-value">${events.length}</span></div>
    ${users.length ? `<div class="detail-stat"><span class="detail-stat-label">Användare</span><span class="detail-stat-value">${users.slice(0,3).join(', ')}</span></div>` : ''}
    ${d.note ? `<div class="detail-stat"><span class="detail-stat-label">Anteckning</span><span class="detail-stat-value">${d.note}</span></div>` : ''}
    ${evtTypes.length ? `<div class="detail-stat"><span class="detail-stat-label">Händelsetyper</span><span class="detail-stat-value" style="font-size:0.68rem">${evtTypes.slice(0,4).join(', ')}</span></div>` : ''}
    <div class="detail-events-title">Bevisande händelser (${events.length})</div>
    ${events.slice().sort((a,b)=>new Date(a[COL.TIMESTAMP])-new Date(b[COL.TIMESTAMP])).map(r=>evidenceCard(r)).join('')}
  `;
}

function showEdgeDetail(edge) {
  const d = edge.data();
  const panel = document.getElementById('detailPanel');
  const title = document.getElementById('detailTitle');
  const body  = document.getElementById('detailBody');
  panel.classList.remove('hidden');
  title.textContent = `${d.source} → ${d.target}`;

  const events = d.events || [];
  body.innerHTML = `
    <div class="detail-stat"><span class="detail-stat-label">Källa</span><span class="detail-stat-value">${d.source}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Destination</span><span class="detail-stat-value">${d.target}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Allvarlighet</span><span class="detail-stat-value" style="color:${sevColor(d.sev)}"><span class="sev-dot ${d.sev}"></span>${(d.sev||'info').toUpperCase()}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Kopplingstyp</span><span class="detail-stat-value">${d.evidenced?'📊 Evidenserad':'✏️ Analytiker-tillagd'}</span></div>
    <div class="detail-stat"><span class="detail-stat-label">Händelser</span><span class="detail-stat-value">${events.length}</span></div>
    ${d.label ? `<div class="detail-stat"><span class="detail-stat-label">Etikett</span><span class="detail-stat-value">${d.label}</span></div>` : ''}
    <div class="detail-events-title">Bevis (${events.length})</div>
    ${events.map(r=>evidenceCard(r)).join('')}
  `;
}

function evidenceCard(r) {
  const sev = sevKey(r[COL.SEVERITY]);
  const { analyst, text } = parseAnalyst(r[COL.COMMENT]||'');
  return `<div class="evidence-card">
    <div class="evidence-card-ts"><span class="sev-dot ${sev}"></span>${fmtTs(r[COL.TIMESTAMP])}</div>
    <div class="evidence-card-event">${eventShort(r[COL.EVENT]||'')}</div>
    <div class="evidence-card-detail">${r[COL.DETAILS]||'—'}</div>
    ${analyst!=='—'?`<div class="evidence-card-detail" style="color:#fde68a;margin-top:3px;">[${analyst}] ${text}</div>`:''}
  </div>`;
}

function closeDetail() {
  document.getElementById('detailPanel').classList.add('hidden');
}

// ─────────────────────────────────────────────
// TIMELINE SCRUBBER
// ─────────────────────────────────────────────
function toggleScrubber() {
  scrubberVisible = !scrubberVisible;
  document.getElementById('scrubber').classList.toggle('hidden', !scrubberVisible);
  document.getElementById('btnScrubber').classList.toggle('active', scrubberVisible);
  if (!scrubberVisible && playInterval) { clearInterval(playInterval); playInterval = null; document.getElementById('playBtn').textContent='▶'; }
}

function onScrub(val) {
  if (!sortedTimestamps.length) return;
  const idx = Math.floor(val / 100 * (sortedTimestamps.length - 1));
  const cutoff = sortedTimestamps[idx];
  document.getElementById('scrubTs').textContent = fmtTs(cutoff.toISOString());

  // Dim nodes/edges that have no events before cutoff
  cy.nodes().forEach(n => {
    const events = n.data('events') || [];
    const hasEvent = events.some(r => new Date(r[COL.TIMESTAMP]) <= cutoff);
    n.toggleClass('dimmed', !hasEvent);
    n.toggleClass('scrub-active', events.some(r => {
      const t = new Date(r[COL.TIMESTAMP]);
      return t <= cutoff && t > (sortedTimestamps[Math.max(0,idx-1)]);
    }));
  });
  cy.edges().forEach(e => {
    const events = e.data('events') || [];
    const hasEvent = events.some(r => new Date(r[COL.TIMESTAMP]) <= cutoff);
    e.toggleClass('dimmed', !hasEvent);
  });
}

let playing = false;
function togglePlay() {
  playing = !playing;
  document.getElementById('playBtn').textContent = playing ? '⏸' : '▶';
  if (playing) {
    let val = parseInt(document.getElementById('scrubRange').value);
    playInterval = setInterval(() => {
      val = Math.min(val + 1, 100);
      document.getElementById('scrubRange').value = val;
      onScrub(val);
      if (val >= 100) { clearInterval(playInterval); playing = false; document.getElementById('playBtn').textContent = '▶'; }
    }, 120);
  } else {
    clearInterval(playInterval);
  }
}

// ─────────────────────────────────────────────
// EDIT MODE (auto tab)
// ─────────────────────────────────────────────
function toggleEditMode() {
  editModeOn = !editModeOn;
  document.getElementById('editBadge').classList.toggle('show', editModeOn);
  document.getElementById('btnEdit').classList.toggle('active', editModeOn);
  cy.userPanningEnabled(!editModeOn || true); // keep panning
  showToast(editModeOn ? '✏️ Redigeringsläge aktiverat' : '✓ Redigeringsläge avstängt');
}

function setMode(m) {
  currentMode = m;
  document.querySelectorAll('#autoTools .tool-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('btnSelect').classList.toggle('active', m==='select');
  document.body.className = m !== 'select' ? `mode-${m}` : '';
}

// ─────────────────────────────────────────────
// FREEHAND MODE
// ─────────────────────────────────────────────
let freeEdgeSrc = null;

function freeMode(m) {
  currentMode = m;
  freeEdgeSrc = null;
  document.querySelectorAll('#freeTools .tool-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('freeSelect').classList.toggle('active', m==='select');
  document.getElementById('freeAddNode').classList.toggle('active', m==='add-node');
  document.getElementById('freeAddEdge').classList.toggle('active', m==='add-edge');
  document.getElementById('freeDelete').classList.toggle('active', m==='delete');
  document.body.className = m !== 'select' ? `mode-${m}` : '';
  if (m==='add-edge') showToast('Klicka på en källnod, sedan en målnod');
}

function handleCanvasClick(e) {
  if (currentTab==='free' && currentMode==='add-node') {
    clickPos = e.position;
    document.getElementById('addNodeModal').classList.remove('hidden');
    document.getElementById('addNodeName').value = '';
    document.getElementById('addNodeNote').value = '';
    document.getElementById('addNodeName').focus();
  }
}

function handleFreeEdgeClick(node) {
  if (!freeEdgeSrc) {
    freeEdgeSrc = node;
    node.style('border-color', '#38bdf8');
    showToast(`Källa: ${node.data('fullLabel')||node.id()} — Klicka nu på målnoden`);
  } else {
    if (freeEdgeSrc.id() === node.id()) { freeEdgeSrc.style('border-color', node.data('borderColor')); freeEdgeSrc = null; return; }
    pendingEdgeTarget = node;
    freeEdgeSrc.style('border-color', freeEdgeSrc.data('borderColor'));
    document.getElementById('addEdgeModal').classList.remove('hidden');
    document.getElementById('addEdgeLabel').value = '';
    document.getElementById('addEdgeLabel').focus();
  }
}

function selectNodeType(btn) {
  document.querySelectorAll('#nodeTypeRow .node-type-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  selectedNodeType = btn.dataset.type;
}

function confirmAddNode() {
  const name = document.getElementById('addNodeName').value.trim();
  const note = document.getElementById('addNodeNote').value.trim();
  if (!name) return;
  const id = 'free_' + Date.now();
  const icon = nodeTypeIcon(selectedNodeType);
  cy.add({
    group: 'nodes',
    data: {
      id, label: `${icon}\n${name.length>16?name.slice(0,15)+'…':name}`,
      fullLabel: name, color: '#1e293b', borderColor: '#475569',
      shape: selectedNodeType==='internet'?'diamond':'ellipse',
      sev: 'info', type: selectedNodeType, events: [],
      evidenced: false, analyst: true, note,
    },
    position: clickPos || { x: 300, y: 300 }
  });
  closeAddNode();
  showToast(`✓ Nod tillagd: ${name}`);
}

function confirmAddEdge() {
  if (!freeEdgeSrc || !pendingEdgeTarget) return;
  const label = document.getElementById('addEdgeLabel').value.trim();
  const sev   = document.getElementById('addEdgeSev').value;
  cy.add({
    group: 'edges',
    data: {
      id: `manual_${Date.now()}`,
      source: freeEdgeSrc.id(),
      target: pendingEdgeTarget.id(),
      color: sevColor(sev), width: 2, sev,
      label: label || '',
      lineStyle: 'dashed', evidenced: false, events: [],
    }
  });
  freeEdgeSrc = null; pendingEdgeTarget = null;
  closeAddEdge();
  showToast('✓ Koppling skapad');
}

function deleteSelected() {
  const selected = cy.$(':selected');
  if (selected.length) { selected.remove(); showToast(`✕ Raderade ${selected.length} element`); }
}

function importFromAuto() {
  const autoEls = buildAutoGraph(allRows);
  cy.elements().remove();
  cy.add(autoEls);
  doLayout('cose');
  showToast('📥 Importerat från incident-vyn');
}

function clearFreeCanvas() {
  if (!confirm('Rensa hela canvas? Osparade ändringar försvinner.')) return;
  cy.elements().remove();
}

function closeAddNode() { document.getElementById('addNodeModal').classList.add('hidden'); }
function closeAddEdge() { document.getElementById('addEdgeModal').classList.add('hidden'); freeEdgeSrc=null; pendingEdgeTarget=null; }

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach((b,i)=>b.classList.toggle('active', (i===0&&tab==='auto')||(i===1&&tab==='free')));
  document.getElementById('autoTools').style.display = tab==='auto' ? '' : 'none';
  document.getElementById('freeTools').style.display = tab==='free' ? '' : 'none';
  closeDetail();
  currentMode = 'select';
  document.body.className = '';
  freeEdgeSrc = null;

  if (tab==='auto') {
    loadAutoGraph();
    document.getElementById('scrubber').classList.add('hidden');
    scrubberVisible = false;
  } else {
    // Freehand: start with blank or last saved freehand state
    cy.elements().remove();
    if (freeElements.length) {
      cy.add(freeElements);
      cy.fit(50);
    }
    freeMode('select');
  }
}

// ─────────────────────────────────────────────
// SAVED MAPS
// ─────────────────────────────────────────────
async function loadMapList() {
  try {
    const res = await fetch('/api/maps');
    const data = await res.json();
    savedMaps = data.maps || [];
    renderMapList();
  } catch(e) {
    document.getElementById('mapList').innerHTML = '<div class="no-maps">Kunde inte ladda kartor.</div>';
  }
}

function renderMapList() {
  const el = document.getElementById('mapList');
  if (!savedMaps.length) { el.innerHTML = '<div class="no-maps">Inga sparade kartor ännu.<br><br>Bygg en karta och klicka "Spara".</div>'; return; }
  el.innerHTML = savedMaps.map(m => `
    <div class="map-item ${activeMapId===m.id?'active':''}" onclick="loadMap('${m.id}')">
      <div class="map-item-info">
        <div class="map-item-name">🗺 ${m.name}</div>
        <div class="map-item-meta">av ${m.createdBy} · ${fmtTs(m.updatedAt)}</div>
      </div>
      <button class="map-item-del" title="Radera" onclick="event.stopPropagation();deleteMap('${m.id}')">🗑</button>
    </div>`).join('');
}

async function loadMap(id) {
  try {
    const res = await fetch(`/api/maps/${id}`);
    if (!res.ok) throw new Error();
    const map = await res.json();
    activeMapId = id;

    cy.elements().remove();
    if (map.mapData && map.mapData.elements) {
      cy.add(map.mapData.elements);
      cy.fit(50);
    }
    renderMapList();
    showToast(`📂 Laddade: ${map.name}`);
  } catch(e) {
    showToast('❌ Kunde inte ladda karta');
  }
}

async function deleteMap(id) {
  if (!confirm('Radera denna karta?')) return;
  try {
    await fetch(`/api/maps/${id}`, { method: 'DELETE' });
    savedMaps = savedMaps.filter(m=>m.id!==id);
    if (activeMapId===id) activeMapId=null;
    renderMapList();
    showToast('🗑 Karta raderad');
  } catch(e) {
    showToast('❌ Kunde inte radera');
  }
}

function openSaveModal() {
  document.getElementById('saveModal').classList.remove('hidden');
  const existing = savedMaps.find(m=>m.id===activeMapId);
  document.getElementById('saveMapName').value = existing?.name || '';
  document.getElementById('saveCreator').value = ANALYST_NAME !== 'Okänd' ? ANALYST_NAME : existing?.createdBy || '';
  document.getElementById('saveMapName').focus();
}
function closeSaveModal() { document.getElementById('saveModal').classList.add('hidden'); }

async function confirmSave() {
  const name = document.getElementById('saveMapName').value.trim() || 'Namnlös karta';
  const creator = document.getElementById('saveCreator').value.trim() || ANALYST_NAME;
  const mapData = { elements: cy.elements().jsons() };

  try {
    let res, data;
    if (activeMapId) {
      res = await fetch(`/api/maps/${activeMapId}`, {
        method: 'PUT', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name, mapData })
      });
      data = await res.json();
      const idx = savedMaps.findIndex(m=>m.id===activeMapId);
      if (idx>=0) { savedMaps[idx].name=name; savedMaps[idx].updatedAt=data.updatedAt; }
    } else {
      res = await fetch('/api/maps', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name, createdBy: creator, mapData })
      });
      data = await res.json();
      activeMapId = data.id;
      savedMaps.push({ id:data.id, name, createdBy:creator, createdAt:data.createdAt, updatedAt:data.updatedAt });
    }
    renderMapList();
    closeSaveModal();
    showToast(`✓ Sparad: ${name}`);
  } catch(e) {
    showToast('❌ Kunde inte spara');
  }
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────
function exportPNG() {
  const png = cy.png({ scale: 2, bg: '#080f1e', full: true });
  const a = document.createElement('a');
  a.href = png;
  a.download = `incident-map-${new Date().toISOString().slice(0,10)}.png`;
  a.click();
  showToast('📷 Exporterar PNG...');
}

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if (e.key==='Escape') { closeDetail(); freeMode('select'); setMode('select'); freeEdgeSrc=null; }
  if (e.key==='f'||e.key==='F') fitAll();
  if (e.key==='Delete'||e.key==='Backspace') deleteSelected();
  if ((e.key==='s'||e.key==='S') && (e.metaKey||e.ctrlKey)) { e.preventDefault(); openSaveModal(); }
});

// MODAL: Enter key
document.getElementById('saveMapName').addEventListener('keydown', e => { if(e.key==='Enter') confirmSave(); });
document.getElementById('addNodeName').addEventListener('keydown', e => { if(e.key==='Enter') confirmAddNode(); });
document.getElementById('addEdgeLabel').addEventListener('keydown', e => { if(e.key==='Enter') confirmAddEdge(); });

// Close modals on overlay click
document.getElementById('saveModal').addEventListener('click', e => { if(e.target===document.getElementById('saveModal')) closeSaveModal(); });
document.getElementById('addNodeModal').addEventListener('click', e => { if(e.target===document.getElementById('addNodeModal')) closeAddNode(); });
document.getElementById('addEdgeModal').addEventListener('click', e => { if(e.target===document.getElementById('addEdgeModal')) closeAddEdge(); });

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
initCy();
loadTimeline();
loadMapList();