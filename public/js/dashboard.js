// ─────────────────────────────────────────────
// IR Dashboard — dashboard.js  v3
// Multi-select checkbox filters, all sidebar panels
// clickable, date range, scrollable sidebar panels.
// ─────────────────────────────────────────────

const COL = {
    SEVERITY:   0,
    LOG_ID:     1,
    TIMESTAMP:  2,
    SRC_HOST:   3,
    DST_HOST:   4,
    USER:       5,
    EVENT:      6,
    PROCESS:    7,
    LOG_SOURCE: 8,
    HOST_OS:    9,
    DETAILS:    10,
    SUBMITTED:  11,
    COMMENT:    12,
};

// ── Filter state — all multi-select Sets ───────
const activeFilters = {
    severity:   new Set(),
    eventType:  new Set(),
    srcHost:    new Set(),
    user:       new Set(),
    logSource:  new Set(),
};
let searchQuery  = '';
let dateFrom     = null;
let dateTo       = null;

// ── Data state ─────────────────────────────────
let allEvents       = [];
let filteredEvents  = [];
let refreshTimer    = null;
let isLoading       = false;
let filterPanelOpen = false;

// ── DOM ─────────────────────────────────────────
const $ = id => document.getElementById(id);

const timelineTrack   = $('timelineTrack');
const loadingState    = $('loadingState');
const emptyState      = $('emptyState');
const resultCount     = $('resultCount');
const timelineRange   = $('timelineRange');
const syncDot         = $('syncIndicator').querySelector('.sync-dot');
const syncLabel       = $('syncLabel');
const refreshBtn      = $('refreshBtn');
const searchInput     = $('searchInput');
const dateFromEl      = $('dateFrom');
const dateToEl        = $('dateTo');
const dateClearBtn    = $('dateClearBtn');
const filterToggleBtn = $('filterToggleBtn');
const filterPanel     = $('filterPanel');
const filterBadge     = $('filterBadge');
const filterClearAll  = $('filterClearAll');
const toast           = $('toast');

// Stats
const valTotal   = $('valTotal');
const valHigh    = $('valHigh');
const valMedium  = $('valMedium');
const valHosts   = $('valHosts');
const valAnalysts= $('valAnalysts');
const valLast    = $('valLast');
const valLastRel = $('valLastRelative');

// ── Helpers ──────────────────────────────────────
function sevKey(raw = '') {
    const s = raw.toLowerCase();
    if (s.includes('high'))   return 'high';
    if (s.includes('medium')) return 'medium';
    if (s.includes('low'))    return 'low';
    return 'info';
}

function fmtTs(ts) {
    if (!ts || ts === 'N/A') return '—';
    try { return new Date(ts).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'medium' }); }
    catch { return ts; }
}

function relativeTime(ts) {
    if (!ts || ts === 'N/A') return '';
    try {
        const diff = Date.now() - new Date(ts).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 2)  return 'just nu';
        if (mins < 60) return `${mins} min sedan`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24)  return `${hrs} tim sedan`;
        return `${Math.floor(hrs / 24)} dag(ar) sedan`;
    } catch { return ''; }
}

function parseAnalyst(comment = '') {
    const m = comment.match(/^\[(.+?)\]\s*(.*)/);
    return m ? { analyst: m[1], text: m[2] } : { analyst: '—', text: comment };
}

function esc(s = '') {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function eventLabel(cell = '') {
    // "1 — Process Create" → "Process Create"
    const parts = String(cell).split('—');
    return parts.length > 1 ? parts.slice(1).join('—').trim() : cell;
}

function showToast(msg, ms = 1800) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
}

function totalActiveFilters() {
    return Object.values(activeFilters).reduce((n, s) => n + s.size, 0);
}

function updateFilterBadge() {
    const n = totalActiveFilters();
    filterBadge.textContent = n;
    filterBadge.style.display = n ? 'inline-flex' : 'none';
    filterToggleBtn.classList.toggle('active', n > 0 || filterPanelOpen);
}

// ── Fetch ────────────────────────────────────────
async function fetchTimeline() {
    if (isLoading) return;
    isLoading = true;
    setSyncState('loading');
    refreshBtn.classList.add('spinning');
    try {
        const res  = await fetch('/api/timeline');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allEvents  = data.rows || [];
        renderStats();
        rebuildFilterPanel();
        renderSidebar();
        applyFilters();
        setSyncState('live');
    } catch (err) {
        console.error('Dashboard fetch error:', err);
        setSyncState('error');
    } finally {
        isLoading = false;
        refreshBtn.classList.remove('spinning');
        scheduleRefresh();
    }
}

function setSyncState(state) {
    syncDot.className = 'sync-dot';
    if (state === 'live')    { syncDot.classList.add('live');  syncLabel.textContent = 'Live'; }
    else if (state === 'loading') { syncLabel.textContent = 'Synkroniserar...'; }
    else { syncDot.classList.add('error'); syncLabel.textContent = 'Fel – kontrollera anslutning'; }
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(fetchTimeline, 60_000);
}

// ── Stats ─────────────────────────────────────────
function renderStats() {
    const high     = allEvents.filter(r => sevKey(r[COL.SEVERITY]) === 'high').length;
    const medium   = allEvents.filter(r => sevKey(r[COL.SEVERITY]) === 'medium').length;
    const hosts    = new Set(allEvents.map(r => r[COL.SRC_HOST]).filter(h => h && h !== 'N/A')).size;
    const analysts = new Set(
        allEvents.map(r => parseAnalyst(r[COL.COMMENT]).analyst).filter(a => a !== '—')
    ).size;

    valTotal.textContent    = allEvents.length;
    valHigh.textContent     = high;
    valMedium.textContent   = medium;
    valHosts.textContent    = hosts;
    valAnalysts.textContent = analysts || '—';

    const tss = allEvents.map(r => r[COL.TIMESTAMP]).filter(t => t && t !== 'N/A')
        .map(t => new Date(t)).filter(d => !isNaN(d));

    if (tss.length) {
        const latest   = new Date(Math.max(...tss));
        const earliest = new Date(Math.min(...tss));
        valLast.textContent    = fmtTs(latest.toISOString());
        valLastRel.textContent = relativeTime(latest.toISOString());
        if (tss.length > 1)
            timelineRange.textContent = `${fmtTs(earliest.toISOString())} → ${fmtTs(latest.toISOString())}`;
    }
}

// ── Filter Panel ──────────────────────────────────

// Map filter key → { colIndex, labelFn, colorFn }
const FILTER_DEFS = [
    {
        key: 'severity', elId: 'fciSeverity',
        values: () => {
            const map = {};
            allEvents.forEach(r => {
                const v = r[COL.SEVERITY] || '⚪ Info';
                map[v] = (map[v] || 0) + 1;
            });
            // Fixed order
            return ['🔴 High','🟡 Medium','🔵 Low','⚪ Info']
                .filter(k => map[k])
                .map(k => ({ value: k, count: map[k] }));
        },
        dotColor: v => {
            const k = sevKey(v);
            return k === 'high' ? '#ef4444' : k === 'medium' ? '#f59e0b' : k === 'low' ? '#3b82f6' : '#475569';
        }
    },
    {
        key: 'eventType', elId: 'fciEventType',
        values: () => {
            const map = {};
            allEvents.forEach(r => {
                const v = eventLabel(r[COL.EVENT]) || 'Okänd';
                map[v] = (map[v] || 0) + 1;
            });
            return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([value,count])=>({value,count}));
        },
    },
    {
        key: 'srcHost', elId: 'fciHost',
        values: () => {
            const map = {};
            allEvents.forEach(r => {
                const v = r[COL.SRC_HOST];
                if (v && v !== 'N/A') map[v] = (map[v] || 0) + 1;
            });
            return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([value,count])=>({value,count}));
        },
    },
    {
        key: 'user', elId: 'fciUser',
        values: () => {
            const map = {};
            allEvents.forEach(r => {
                const v = r[COL.USER];
                if (v && v !== 'N/A') map[v] = (map[v] || 0) + 1;
            });
            return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([value,count])=>({value,count}));
        },
    },
    {
        key: 'logSource', elId: 'fciLogSource',
        values: () => {
            const map = {};
            allEvents.forEach(r => {
                const v = r[COL.LOG_SOURCE];
                if (v && v !== 'N/A') map[v] = (map[v] || 0) + 1;
            });
            return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([value,count])=>({value,count}));
        },
    },
];

function rebuildFilterPanel() {
    FILTER_DEFS.forEach(def => {
        const container = $(def.elId);
        if (!container) return;
        const items = def.values();
        if (!items.length) { container.innerHTML = '<div style="padding:6px 0;font-size:0.7rem;color:var(--muted)">—</div>'; return; }

        container.innerHTML = items.map(({ value, count }) => {
            const checked = activeFilters[def.key].has(value);
            const dot     = def.dotColor ? `<span class="fci-sev-dot" style="background:${def.dotColor(value)}"></span>` : '';
            const short   = value.length > 22 ? value.slice(0, 21) + '…' : value;
            return `
                <div class="fci-row ${checked ? 'checked' : ''}"
                     data-key="${esc(def.key)}" data-val="${esc(value)}"
                     onclick="toggleFilterItem('${esc(def.key)}','${esc(value)}',this)">
                    <span class="fci-cb">${checked ? '✓' : ''}</span>
                    ${dot}
                    <span class="fci-label" title="${esc(value)}">${esc(short)}</span>
                    <span class="fci-count">${count}</span>
                </div>`;
        }).join('');
    });
}

window.toggleFilterItem = function(key, value, el) {
    const set = activeFilters[key];
    if (set.has(value)) { set.delete(value); el.classList.remove('checked'); el.querySelector('.fci-cb').textContent = ''; }
    else                { set.add(value);    el.classList.add('checked');    el.querySelector('.fci-cb').textContent = '✓'; }
    updateFilterBadge();
    applyFilters();
    renderSidebar();   // re-highlight sidebar items
};

// ── Sidebar ───────────────────────────────────────
function renderSidebar() {
    renderHostPanel();
    renderEventTypePanel();
    renderAnalystPanel();
    renderLogSourcePanel();
}

function renderHostPanel() {
    const el = $('hostList');
    const hostCount = $('hostCount');
    const map = {};
    allEvents.forEach(r => {
        const h = r[COL.SRC_HOST];
        if (!h || h === 'N/A') return;
        if (!map[h]) map[h] = { count: 0, maxSev: 'info' };
        map[h].count++;
        const s = sevKey(r[COL.SEVERITY]);
        const ord = { high:3, medium:2, low:1, info:0 };
        if (ord[s] > ord[map[h].maxSev]) map[h].maxSev = s;
    });
    const sorted = Object.entries(map).sort((a,b) => {
        const ord = { high:3, medium:2, low:1, info:0 };
        return ord[b[1].maxSev] - ord[a[1].maxSev] || b[1].count - a[1].count;
    });
    hostCount.textContent = sorted.length;
    if (!sorted.length) { el.innerHTML = '<div class="sidebar-empty">Inga värdar.</div>'; return; }
    el.innerHTML = sorted.map(([name, info]) => `
        <div class="sidebar-row ${activeFilters.srcHost.has(name) ? 'active-filter' : ''}"
             onclick="toggleSidebarFilter('srcHost','${esc(name)}')" title="${esc(name)}">
            <span class="sidebar-row-dot ${info.maxSev}"></span>
            <span class="sidebar-row-name">${esc(name)}</span>
            <span class="sidebar-row-count">${info.count}</span>
        </div>`).join('');
}

function renderEventTypePanel() {
    const el = $('eventTypeList');
    const map = {};
    allEvents.forEach(r => {
        const v = eventLabel(r[COL.EVENT]) || 'Okänd';
        map[v] = (map[v] || 0) + 1;
    });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    const max = sorted[0]?.[1] || 1;
    if (!sorted.length) { el.innerHTML = '<div class="sidebar-empty">Inga händelsetyper.</div>'; return; }
    el.innerHTML = sorted.map(([name, count]) => {
        const pct = Math.round(count / max * 100);
        return `
        <div class="sidebar-row ${activeFilters.eventType.has(name) ? 'active-filter' : ''}"
             onclick="toggleSidebarFilter('eventType','${esc(name)}')" title="Filtrera: ${esc(name)}">
            <span class="sidebar-row-name">${esc(name.length > 20 ? name.slice(0,19)+'…' : name)}</span>
            <div class="evt-bar-wrap"><div class="evt-bar-fill" style="width:${pct}%"></div></div>
            <span class="sidebar-row-count">${count}</span>
        </div>`;
    }).join('');
}

function renderAnalystPanel() {
    const el = $('analystList');
    const map = {};
    allEvents.forEach(r => {
        const { analyst } = parseAnalyst(r[COL.COMMENT]);
        if (analyst !== '—') map[analyst] = (map[analyst] || 0) + 1;
    });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    if (!sorted.length) { el.innerHTML = '<div class="sidebar-empty">Inga analytiker.</div>'; return; }
    // Analyst filter → we filter on comment field. We add a virtual filter key "analyst" by
    // mapping analyst names into the user/comment search. Simplest: we store analyst name
    // in a separate activeFilters.analyst set — but we only have 5 fields in our state.
    // We'll handle analyst filtering via search trick: clicking analyst sets searchQuery to
    // analyst name wrapped in brackets.
    el.innerHTML = sorted.map(([name, count]) => `
        <div class="sidebar-row ${searchQuery === '['+name+']' ? 'active-filter' : ''}"
             onclick="filterByAnalyst('${esc(name)}')" title="Filtrera på ${esc(name)}">
            <div class="analyst-avatar">${esc(name.slice(0,2).toUpperCase())}</div>
            <span class="sidebar-row-name">${esc(name)}</span>
            <span class="sidebar-row-count">${count} loggar</span>
        </div>`).join('');
}

function renderLogSourcePanel() {
    const el = $('logSourceList');
    const map = {};
    allEvents.forEach(r => {
        const v = r[COL.LOG_SOURCE];
        if (v && v !== 'N/A') map[v] = (map[v] || 0) + 1;
    });
    const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
    if (!sorted.length) { el.innerHTML = '<div class="sidebar-empty">Inga loggkällor.</div>'; return; }
    el.innerHTML = sorted.map(([name, count]) => `
        <div class="sidebar-row ${activeFilters.logSource.has(name) ? 'active-filter' : ''}"
             onclick="toggleSidebarFilter('logSource','${esc(name)}')" title="${esc(name)}">
            <span class="sidebar-row-name">${esc(name.length > 22 ? name.slice(0,21)+'…' : name)}</span>
            <span class="sidebar-row-count">${count}</span>
        </div>`).join('');
}

// Sidebar click → toggle filter set + rebuild panel + apply
window.toggleSidebarFilter = function(key, value) {
    const set = activeFilters[key];
    if (set.has(value)) set.delete(value);
    else                set.add(value);
    updateFilterBadge();
    rebuildFilterPanel();   // keep checkboxes in sync
    renderSidebar();
    applyFilters();
    showToast(set.has(value) ? `✓ Filtrerar: ${value}` : `✕ Filter borttaget`);
};

window.filterByAnalyst = function(name) {
    // Toggle: if already filtering this analyst, clear; otherwise set
    const bracket = '[' + name + ']';
    if (searchQuery === bracket) {
        searchQuery = '';
        searchInput.value = '';
    } else {
        searchQuery = bracket;
        searchInput.value = bracket;
    }
    renderSidebar();
    applyFilters();
};

// ── Apply Filters ─────────────────────────────────
function applyFilters() {
    const q = searchQuery.toLowerCase();

    filteredEvents = allEvents.filter(row => {
        // Multi-select filters
        if (activeFilters.severity.size  && !activeFilters.severity.has(row[COL.SEVERITY] || '⚪ Info')) return false;
        if (activeFilters.eventType.size && !activeFilters.eventType.has(eventLabel(row[COL.EVENT]))) return false;
        if (activeFilters.srcHost.size   && !activeFilters.srcHost.has(row[COL.SRC_HOST])) return false;
        if (activeFilters.user.size      && !activeFilters.user.has(row[COL.USER])) return false;
        if (activeFilters.logSource.size && !activeFilters.logSource.has(row[COL.LOG_SOURCE])) return false;

        // Date range
        if (dateFrom || dateTo) {
            const ts = new Date(row[COL.TIMESTAMP]);
            if (isNaN(ts)) return false;
            if (dateFrom && ts < dateFrom) return false;
            if (dateTo   && ts > dateTo)   return false;
        }

        // Text / analyst search
        if (q) {
            const hay = [
                row[COL.EVENT], row[COL.SRC_HOST], row[COL.DST_HOST],
                row[COL.USER],  row[COL.DETAILS],  row[COL.COMMENT],
                row[COL.PROCESS], row[COL.LOG_ID], row[COL.LOG_SOURCE]
            ].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    renderTimeline();
    resultCount.textContent = `${filteredEvents.length} / ${allEvents.length} händelser`;
}

function clearAllFilters() {
    Object.values(activeFilters).forEach(s => s.clear());
    searchQuery = '';
    searchInput.value = '';
    dateFrom = null; dateTo = null;
    dateFromEl.value = ''; dateToEl.value = '';
    updateFilterBadge();
    rebuildFilterPanel();
    renderSidebar();
    applyFilters();
    showToast('✕ Alla filter rensade');
}

// ── Timeline ──────────────────────────────────────
function renderTimeline() {
    loadingState.style.display = 'none';
    if (!filteredEvents.length) {
        emptyState.style.display = 'flex';
        timelineTrack.innerHTML  = '';
        return;
    }
    emptyState.style.display = 'none';
    const sorted = [...filteredEvents].sort((a,b) =>
        new Date(b[COL.TIMESTAMP]) - new Date(a[COL.TIMESTAMP])
    );
    timelineTrack.innerHTML = sorted.map((row, i) => buildCard(row, i)).join('');
}

function buildCard(row, idx) {
    const sev      = sevKey(row[COL.SEVERITY]);
    const srcHost  = row[COL.SRC_HOST] || 'N/A';
    const dstHost  = row[COL.DST_HOST] || 'N/A';
    const user     = row[COL.USER] || 'N/A';
    const evtShort = eventLabel(row[COL.EVENT] || 'N/A');
    const delay    = Math.min(idx * 0.03, 0.5);
    const { analyst, text: comment } = parseAnalyst(row[COL.COMMENT] || '');

    return `
    <div class="event-card" data-sev="${sev}" style="animation-delay:${delay}s" onclick="toggleCard(this)">
        <div class="event-header">
            <span class="event-ts">${esc(fmtTs(row[COL.TIMESTAMP]))}</span>
            <span class="event-sev-badge">${esc(row[COL.SEVERITY] || '⚪ Info')}</span>
            <span class="event-type">${esc(evtShort)}</span>
            <span class="expand-toggle">▾</span>
        </div>
        <div class="event-summary">
            <span class="event-tag host" title="${esc(srcHost)}">⬡ ${esc(srcHost)}</span>
            ${dstHost !== 'N/A' && dstHost !== srcHost
                ? `<span class="event-tag arrow">→</span><span class="event-tag host" title="${esc(dstHost)}">${esc(dstHost)}</span>`
                : ''}
            ${user !== 'N/A' ? `<span class="event-tag user">👤 ${esc(user)}</span>` : ''}
        </div>
        <div class="event-detail">
            ${dRow('Log ID',      row[COL.LOG_ID],        '', true)}
            ${dRow('Tidsstämpel', row[COL.TIMESTAMP])}
            ${dRow('Händelse',    row[COL.EVENT])}
            ${dRow('Detaljer',    row[COL.DETAILS],       'highlight')}
            ${dRow('Process',     row[COL.PROCESS])}
            ${dRow('Dst Host',    dstHost)}
            ${dRow('OS',          row[COL.HOST_OS])}
            ${dRow('Loggkälla',   row[COL.LOG_SOURCE])}
            ${dRow('Kommentar',   `[${analyst}] ${comment}`, 'comment')}
        </div>
    </div>`;
}

function dRow(label, value, cls = '', copyable = false) {
    if (!value || value === 'N/A' || value === '[—] ') return '';
    const cp = copyable
        ? `onclick="event.stopPropagation();copyText('${esc(value)}')" title="Klicka för att kopiera"`
        : '';
    return `
        <div class="detail-row">
            <span class="detail-label">${esc(label)}</span>
            <span class="detail-value ${cls} ${copyable?'copyable':''}" ${cp}>${esc(value)}</span>
        </div>`;
}

// ── Interactions ──────────────────────────────────
window.toggleCard = el => el.classList.toggle('expanded');

window.copyText = text => {
    navigator.clipboard.writeText(text).then(() => showToast(`✓ Kopierat`));
};

// Filter panel toggle
filterToggleBtn.addEventListener('click', () => {
    filterPanelOpen = !filterPanelOpen;
    filterPanel.classList.toggle('open', filterPanelOpen);
    filterToggleBtn.classList.toggle('active', filterPanelOpen || totalActiveFilters() > 0);
});

// Close filter panel when clicking outside
document.addEventListener('click', e => {
    if (filterPanelOpen &&
        !filterPanel.contains(e.target) &&
        !filterToggleBtn.contains(e.target)) {
        filterPanelOpen = false;
        filterPanel.classList.remove('open');
        filterToggleBtn.classList.toggle('active', totalActiveFilters() > 0);
    }
});

filterClearAll.addEventListener('click', clearAllFilters);

// Search (debounced)
let searchTimer;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        searchQuery = searchInput.value.trim();
        renderSidebar(); // update analyst highlight
        applyFilters();
    }, 200);
});

// Date range
dateFromEl.addEventListener('change', () => { dateFrom = dateFromEl.value ? new Date(dateFromEl.value) : null; applyFilters(); });
dateToEl.addEventListener('change',   () => { dateTo   = dateToEl.value   ? new Date(dateToEl.value)   : null; applyFilters(); });
dateClearBtn.addEventListener('click', () => {
    dateFromEl.value = ''; dateToEl.value = '';
    dateFrom = null; dateTo = null;
    applyFilters();
});

// Refresh
refreshBtn.addEventListener('click', () => { clearTimeout(refreshTimer); fetchTimeline(); });

// Keyboard: R = refresh, Escape = clear filters
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'r' || e.key === 'R') { clearTimeout(refreshTimer); fetchTimeline(); showToast('↺ Uppdaterar...'); }
    if (e.key === 'Escape' && totalActiveFilters() > 0) clearAllFilters();
});

// ── Boot ──────────────────────────────────────────
fetchTimeline();
