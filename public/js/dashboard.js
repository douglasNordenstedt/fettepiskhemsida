// ─────────────────────────────────────────────
// IR Dashboard — dashboard.js
// Fetches /api/timeline, renders everything.
// Zero dependency on app.js / style.css.
// ─────────────────────────────────────────────

// Sheet column indices (must match server.js TABS.Timeline header)
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

// ── State ──────────────────────────────────────
let allEvents       = [];   // raw rows from API (excluding header)
let filteredEvents  = [];
let activeHostFilter = '';
let activeSevFilter  = 'all';
let searchQuery      = '';
let refreshTimer     = null;
let isLoading        = false;

// ── DOM refs ────────────────────────────────────
const timelineTrack  = document.getElementById('timelineTrack');
const loadingState   = document.getElementById('loadingState');
const emptyState     = document.getElementById('emptyState');
const resultCount    = document.getElementById('resultCount');
const timelineRange  = document.getElementById('timelineRange');
const syncIndicator  = document.getElementById('syncIndicator');
const syncDot        = syncIndicator.querySelector('.sync-dot');
const syncLabel      = document.getElementById('syncLabel');
const refreshBtn     = document.getElementById('refreshBtn');
const searchInput    = document.getElementById('searchInput');
const hostFilter     = document.getElementById('hostFilter');
const userFilter     = document.getElementById('userFilter');

// Stats
const valTotal    = document.getElementById('valTotal');
const valHigh     = document.getElementById('valHigh');
const valMedium   = document.getElementById('valMedium');
const valHosts    = document.getElementById('valHosts');
const valAnalysts = document.getElementById('valAnalysts');
const valLast     = document.getElementById('valLast');
const valLastRel  = document.getElementById('valLastRelative');

// Sidebar
const hostList      = document.getElementById('hostList');
const hostCount     = document.getElementById('hostCount');
const eventTypeList = document.getElementById('eventTypeList');
const analystList   = document.getElementById('analystList');

// ── Helpers ─────────────────────────────────────
function sevKey(raw = '') {
    const s = raw.toLowerCase();
    if (s.includes('high'))   return 'high';
    if (s.includes('medium')) return 'medium';
    if (s.includes('low'))    return 'low';
    return 'info';
}

function fmtTs(ts) {
    if (!ts || ts === 'N/A') return '—';
    try {
        const d = new Date(ts);
        return d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'medium' });
    } catch { return ts; }
}

function relativeTime(ts) {
    if (!ts || ts === 'N/A') return '';
    try {
        const diff = Date.now() - new Date(ts).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 2)   return 'just nu';
        if (mins < 60)  return `${mins} min sedan`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24)   return `${hrs} tim sedan`;
        return `${Math.floor(hrs / 24)} dag(ar) sedan`;
    } catch { return ''; }
}

function parseAnalyst(comment = '') {
    const m = comment.match(/^\[(.+?)\]\s*(.*)/);
    return m ? { analyst: m[1], text: m[2] } : { analyst: '—', text: comment };
}

function escHtml(s = '') {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Extract event-id number from strings like "1 — Process Create"
function eventIdFromCell(cell = '') {
    const m = String(cell).match(/^(\d+)/);
    return m ? m[1] : cell;
}

function eventLabelShort(cell = '') {
    // "1 — Process Create"  →  "Process Create"
    const parts = String(cell).split('—');
    return parts.length > 1 ? parts.slice(1).join('—').trim() : cell;
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
        const data = await res.json();          // { rows: [[...], ...] }
        allEvents  = data.rows || [];

        buildDropdowns();
        applyFilters();
        renderStats();
        renderSidebar();
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
    if (state === 'live') {
        syncDot.classList.add('live');
        syncLabel.textContent = 'Live';
    } else if (state === 'loading') {
        syncLabel.textContent = 'Synkroniserar...';
    } else {
        syncDot.classList.add('error');
        syncLabel.textContent = 'Fel – kontrollera anslutning';
    }
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(fetchTimeline, 60_000);
}

// ── Dropdowns ────────────────────────────────────
function buildDropdowns() {
    const hosts = [...new Set(allEvents.map(r => r[COL.SRC_HOST]).filter(h => h && h !== 'N/A'))].sort();
    const users = [...new Set(allEvents.map(r => r[COL.USER]).filter(u => u && u !== 'N/A'))].sort();

    const prevHost = hostFilter.value;
    const prevUser = userFilter.value;

    hostFilter.innerHTML = '<option value="">Alla värdar</option>' +
        hosts.map(h => `<option value="${escHtml(h)}">${escHtml(h)}</option>`).join('');
    userFilter.innerHTML = '<option value="">Alla användare</option>' +
        users.map(u => `<option value="${escHtml(u)}">${escHtml(u)}</option>`).join('');

    if (prevHost) hostFilter.value = prevHost;
    if (prevUser) userFilter.value = prevUser;
}

// ── Filter ────────────────────────────────────────
function applyFilters() {
    const q     = searchQuery.toLowerCase();
    const sev   = activeSevFilter;
    const host  = hostFilter.value;
    const user  = userFilter.value;

    filteredEvents = allEvents.filter(row => {
        // Severity filter
        if (sev !== 'all' && sevKey(row[COL.SEVERITY]) !== sev) return false;
        // Host sidebar filter
        if (activeHostFilter && row[COL.SRC_HOST] !== activeHostFilter) return false;
        // Dropdown filters
        if (host && row[COL.SRC_HOST] !== host) return false;
        if (user && row[COL.USER] !== user) return false;
        // Text search
        if (q) {
            const haystack = [
                row[COL.EVENT], row[COL.SRC_HOST], row[COL.DST_HOST],
                row[COL.USER],  row[COL.DETAILS],  row[COL.COMMENT],
                row[COL.PROCESS]
            ].join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
        }
        return true;
    });

    renderTimeline();
    resultCount.textContent = `${filteredEvents.length} / ${allEvents.length} händelser`;
}

// ── Stats ─────────────────────────────────────────
function renderStats() {
    const high   = allEvents.filter(r => sevKey(r[COL.SEVERITY]) === 'high').length;
    const medium = allEvents.filter(r => sevKey(r[COL.SEVERITY]) === 'medium').length;
    const hosts  = new Set(allEvents.map(r => r[COL.SRC_HOST]).filter(h => h && h !== 'N/A')).size;

    // Count distinct analysts from comment fields
    const analysts = new Set(
        allEvents.map(r => parseAnalyst(r[COL.COMMENT]).analyst).filter(a => a !== '—')
    ).size;

    valTotal.textContent    = allEvents.length;
    valHigh.textContent     = high;
    valMedium.textContent   = medium;
    valHosts.textContent    = hosts;
    valAnalysts.textContent = analysts || '—';

    // Latest event by timestamp
    const timestamps = allEvents
        .map(r => r[COL.TIMESTAMP])
        .filter(t => t && t !== 'N/A')
        .map(t => new Date(t))
        .filter(d => !isNaN(d));

    if (timestamps.length) {
        const latest = new Date(Math.max(...timestamps));
        valLast.textContent  = fmtTs(latest.toISOString());
        valLastRel.textContent = relativeTime(latest.toISOString());
    } else {
        valLast.textContent  = '—';
        valLastRel.textContent = '';
    }

    // Timeline range label
    if (timestamps.length > 1) {
        const earliest = new Date(Math.min(...timestamps));
        const latest   = new Date(Math.max(...timestamps));
        timelineRange.textContent = `${fmtTs(earliest.toISOString())} → ${fmtTs(latest.toISOString())}`;
    }
}

// ── Sidebar ───────────────────────────────────────
function renderSidebar() {
    renderHostPanel();
    renderEventTypes();
    renderAnalysts();
}

function renderHostPanel() {
    // Group events by host, find max severity per host
    const map = {};
    allEvents.forEach(row => {
        const h = row[COL.SRC_HOST];
        if (!h || h === 'N/A') return;
        if (!map[h]) map[h] = { count: 0, maxSev: 'info' };
        map[h].count++;
        const s = sevKey(row[COL.SEVERITY]);
        const order = { high: 3, medium: 2, low: 1, info: 0 };
        if (order[s] > order[map[h].maxSev]) map[h].maxSev = s;
    });

    const sorted = Object.entries(map).sort((a, b) => {
        const order = { high: 3, medium: 2, low: 1, info: 0 };
        return order[b[1].maxSev] - order[a[1].maxSev] || b[1].count - a[1].count;
    });

    hostCount.textContent = sorted.length;

    if (!sorted.length) {
        hostList.innerHTML = '<div class="sidebar-empty">Inga värdar ännu.</div>';
        return;
    }

    hostList.innerHTML = sorted.map(([name, info]) => `
        <div class="host-item ${activeHostFilter === name ? 'active-filter' : ''}"
             data-host="${escHtml(name)}" onclick="toggleHostFilter('${escHtml(name)}')">
            <span class="host-dot ${info.maxSev}"></span>
            <span class="host-name" title="${escHtml(name)}">${escHtml(name)}</span>
            <span class="host-count">${info.count}</span>
        </div>
    `).join('');
}

function renderEventTypes() {
    const map = {};
    allEvents.forEach(row => {
        const label = eventLabelShort(row[COL.EVENT]) || 'Okänd';
        map[label] = (map[label] || 0) + 1;
    });

    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const max    = sorted[0]?.[1] || 1;

    if (!sorted.length) {
        eventTypeList.innerHTML = '<div class="sidebar-empty">Inga händelsetyper ännu.</div>';
        return;
    }

    eventTypeList.innerHTML = sorted.map(([label, count]) => `
        <div class="event-type-row">
            <div class="event-type-label">
                <span title="${escHtml(label)}">${escHtml(label.length > 28 ? label.slice(0, 28) + '…' : label)}</span>
                <span>${count}</span>
            </div>
            <div class="event-type-bar-bg">
                <div class="event-type-bar-fill" style="width:${Math.round(count / max * 100)}%"></div>
            </div>
        </div>
    `).join('');
}

function renderAnalysts() {
    const map = {};
    allEvents.forEach(row => {
        const { analyst } = parseAnalyst(row[COL.COMMENT]);
        if (analyst !== '—') map[analyst] = (map[analyst] || 0) + 1;
    });

    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);

    if (!sorted.length) {
        analystList.innerHTML = '<div class="sidebar-empty">Inga analytiker ännu.</div>';
        return;
    }

    analystList.innerHTML = sorted.map(([name, count]) => `
        <div class="analyst-item">
            <div class="analyst-avatar">${escHtml(name.slice(0, 2).toUpperCase())}</div>
            <span class="analyst-name">${escHtml(name)}</span>
            <span class="analyst-count">${count} loggar</span>
        </div>
    `).join('');
}

// ── Timeline render ────────────────────────────────
function renderTimeline() {
    loadingState.style.display = 'none';

    if (!filteredEvents.length) {
        emptyState.style.display = 'flex';
        timelineTrack.innerHTML  = '';
        return;
    }

    emptyState.style.display = 'none';

    // Sort newest first
    const sorted = [...filteredEvents].sort((a, b) => {
        const ta = new Date(a[COL.TIMESTAMP]);
        const tb = new Date(b[COL.TIMESTAMP]);
        return tb - ta;
    });

    timelineTrack.innerHTML = sorted.map((row, i) => buildEventCard(row, i)).join('');
}

function buildEventCard(row, idx) {
    const sev     = sevKey(row[COL.SEVERITY]);
    const ts      = fmtTs(row[COL.TIMESTAMP]);
    const event   = row[COL.EVENT] || 'N/A';
    const srcHost = row[COL.SRC_HOST] || 'N/A';
    const dstHost = row[COL.DST_HOST] || 'N/A';
    const user    = row[COL.USER] || 'N/A';
    const process = row[COL.PROCESS] || 'N/A';
    const details = row[COL.DETAILS] || 'N/A';
    const logSrc  = row[COL.LOG_SOURCE] || 'N/A';
    const os      = row[COL.HOST_OS] || 'N/A';
    const logId   = row[COL.LOG_ID] || 'N/A';
    const { analyst, text: comment } = parseAnalyst(row[COL.COMMENT]);

    const eventShort = eventLabelShort(event);
    const delay      = Math.min(idx * 0.03, 0.5);

    return `
    <div class="event-card" data-sev="${sev}" style="animation-delay:${delay}s" onclick="toggleCard(this)">
        <div class="event-header">
            <span class="event-ts">${escHtml(ts)}</span>
            <span class="event-sev-badge">${escHtml(row[COL.SEVERITY] || '⚪ Info')}</span>
            <span class="event-type">${escHtml(eventShort)}</span>
            <span class="expand-toggle">▾</span>
        </div>

        <div class="event-summary">
            <span class="event-tag host" title="${escHtml(srcHost)}">⬡ ${escHtml(srcHost)}</span>
            ${dstHost !== 'N/A' && dstHost !== srcHost ? `
                <span class="event-tag arrow">→</span>
                <span class="event-tag host" title="${escHtml(dstHost)}">${escHtml(dstHost)}</span>
            ` : ''}
            ${user !== 'N/A' ? `<span class="event-tag user">👤 ${escHtml(user)}</span>` : ''}
        </div>

        <div class="event-detail">
            ${detailRow('Log ID',      logId)}
            ${detailRow('Tidsstämpel', row[COL.TIMESTAMP] || 'N/A')}
            ${detailRow('Händelse',    event)}
            ${detailRow('Detaljer',    details,  'highlight')}
            ${detailRow('Process',     process)}
            ${detailRow('Dst Host',    dstHost)}
            ${detailRow('OS',          os)}
            ${detailRow('Loggkälla',   logSrc)}
            ${detailRow('Kommentar',   `[${analyst}] ${comment}`, 'comment')}
        </div>
    </div>`;
}

function detailRow(label, value, cls = '') {
    if (!value || value === 'N/A' || value === '[—] ') return '';
    return `
        <div class="detail-row">
            <span class="detail-label">${escHtml(label)}</span>
            <span class="detail-value ${cls}">${escHtml(value)}</span>
        </div>`;
}

// ── Interactions ────────────────────────────────────
window.toggleCard = function(card) {
    card.classList.toggle('expanded');
};

window.toggleHostFilter = function(host) {
    activeHostFilter = activeHostFilter === host ? '' : host;
    // Sync host-item active state
    document.querySelectorAll('.host-item').forEach(el => {
        el.classList.toggle('active-filter', el.dataset.host === activeHostFilter);
    });
    applyFilters();
};

// Severity filter pills
document.querySelectorAll('.sev-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sev-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSevFilter = btn.dataset.sev;
        applyFilters();
    });
});

// Text search (debounced)
let searchTimer;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        searchQuery = searchInput.value.trim();
        applyFilters();
    }, 200);
});

// Dropdowns
hostFilter.addEventListener('change', applyFilters);
userFilter.addEventListener('change', applyFilters);

// Refresh button
refreshBtn.addEventListener('click', () => {
    clearTimeout(refreshTimer);
    fetchTimeline();
});

// ── Boot ──────────────────────────────────────────
fetchTimeline();
