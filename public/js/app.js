// UI Elements
const logInput      = document.getElementById('logInput');
const logPreview    = document.getElementById('logPreview');
const preSendBtn    = document.getElementById('preSendBtn');
const statusMessage = document.getElementById('statusMessage');

// Modal Elements
const commentModal  = document.getElementById('commentModal');
const commentInput  = document.getElementById('commentInput');
const cancelBtn     = document.getElementById('cancelBtn');
const confirmSendBtn = document.getElementById('confirmSendBtn');

// Last Sent Elements
const lastSentCard  = document.getElementById('lastSentCard');
const lastComment   = document.getElementById('lastComment');
const lastSeverity  = document.getElementById('lastSeverity');
const lastLogData   = document.getElementById('lastLogData');

let validJsonData   = null;
let selectedSeverity = null;

// ─────────────────────────────────────────────
// SEVERITY PICKER
// ─────────────────────────────────────────────
document.querySelectorAll('.sev-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('sev-active'));
        btn.classList.add('sev-active');
        selectedSeverity = btn.dataset.sev;
        confirmSendBtn.disabled = false; // unlock Send once severity chosen
    });
});

// ─────────────────────────────────────────────
// EVENT-AWARE DETAIL EXTRACTOR
// TO ADD A NEW EVENT TYPE: add a case with the Sysmon event_id.
// ─────────────────────────────────────────────
function getEventDetails(src) {
    const eventId = String(src.winlog?.event_id || src.event?.code || '');

    switch (eventId) {
        case '1':  // Process Create
            return src.process?.command_line || src.process?.executable || 'N/A';

        case '3':  // Network Connection
            return [
                src.destination?.ip ? `→ ${src.destination.ip}:${src.destination?.port}` : null,
                src.network?.protocol ? `(${src.network.protocol})` : null
            ].filter(Boolean).join(' ') || 'N/A';

        case '5':  // Process Terminated
            return src.process?.executable || src.process?.name || 'N/A';

        case '7':  // Image/DLL Loaded
            return src.file?.path || src.dll?.path || 'N/A';

        case '11': // File Created
            return src.file?.path || src.file?.name || 'N/A';

        case '12': // Registry Object Added/Deleted
            return src.regitry?.path || src.registry?.key || 'N/A';
        case '13': // Registry Value Set
            return src.regitry?.path || src.registry?.key || 'N/A';
        case '14': // Registry Key Renamed
            return src.registry?.path || src.registry?.key || 'N/A';

        case '22': { // DNS Query
            const domain = src.dns?.question?.name || 'N/A';
            const ips    = src.dns?.resolved_ip;
            const ipStr  = Array.isArray(ips) ? ips.slice(0, 3).join(', ') : (ips || '');
            return ipStr ? `${domain} → ${ipStr}` : domain;
        }

        case '23': // File Delete
            return src.file?.path || src.file?.name || 'N/A';
        case '26': // File Delete Logged
            return src.file?.path || 'N/A';

        default:
            return src.process?.command_line
                || src.registry?.path
                || src.dns?.question?.name
                || src.file?.path
                || src.message?.split('\n')[0]
                || 'N/A';
    }
}

// ─────────────────────────────────────────────
// RENDER PREVIEW
// ─────────────────────────────────────────────
function renderTimelineView(data) {
    const src       = data._source || {};
    const eventId   = src.winlog?.event_id || src.event?.code || '?';
    const eventType = src.event?.action || src.winlog?.task || 'N/A';
    const user      = src.user?.domain
                        ? `${src.user.domain}\\${src.user.name}`
                        : (src.user?.name || 'N/A');

    const commonFields = [
        { label: 'Log ID',    value: data._id || 'N/A',                                                color: '#e2e8f0' },
        { label: 'Timestamp', value: src['@timestamp'] || 'N/A',                           color: '#7dd3fc' },
        { label: 'Hostname',  value: src.host?.hostname || 'N/A',                          color: '#f8fafc' },
        { label: 'User',      value: user,                                                  color: '#f8fafc' },
        { label: 'Event ID',  value: `${eventId} — ${eventType}`,                          color: '#fde68a' },
        { label: 'Process',   value: src.process?.executable || src.process?.name || 'N/A', color: '#f8fafc' },
        { label: 'Details',   value: getEventDetails(src),                                  color: '#6ee7b7' },
    ];

    return commonFields.map(f => `
        <div style="display:flex; border-bottom:1px solid #334155; padding:5px 0; gap:8px;">
            <strong style="color:#94a3b8; width:85px; flex-shrink:0; font-size:0.8em; padding-top:2px;">${f.label}</strong>
            <span style="color:${f.color}; font-family:'Courier New',monospace; font-size:0.85em; word-break:break-all;">${f.value}</span>
        </div>
    `).join('');
}

// ─────────────────────────────────────────────
// LIVE PREVIEW
// ─────────────────────────────────────────────
logInput.addEventListener('input', () => {
    const rawData = logInput.value.trim();
    if (!rawData) {
        logPreview.innerHTML = 'Väntar på giltig JSON...';
        preSendBtn.disabled = true;
        validJsonData = null;
        return;
    }

    try {
        validJsonData = JSON.parse(rawData);
        logPreview.innerHTML = renderTimelineView(validJsonData);
        preSendBtn.disabled = false;
    } catch (e) {
        logPreview.innerHTML = `<span style="color:#ef4444;">❌ Ogiltigt JSON-format.</span>`;
        preSendBtn.disabled = true;
        validJsonData = null;
    }
});

// OPEN MODAL
preSendBtn.addEventListener('click', () => {
    // Reset severity state each time
    selectedSeverity = null;
    document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('sev-active'));
    confirmSendBtn.disabled = true;
    commentInput.value = '';

    commentModal.style.display = 'flex';
    commentInput.focus();
});

// CLOSE MODAL
cancelBtn.addEventListener('click', () => {
    commentModal.style.display = 'none';
});

// CONFIRM SEND
confirmSendBtn.addEventListener('click', async () => {
    const comment  = commentInput.value.trim() || 'Ingen kommentar.';
    const severity = selectedSeverity || '⚪ Info';

    const payloadToSend = {
        log: validJsonData,
        comment,
        severity,
        submittedAt: new Date().toISOString()
    };

    commentModal.style.display = 'none';
    statusMessage.textContent = '⏳ Skickar...';
    statusMessage.style.color = '#3b82f6';
    preSendBtn.disabled = true;

    try {
        const response = await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadToSend)
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Serverfel');
        }

        statusMessage.textContent = '✅ Logg sparad!';
        statusMessage.style.color = '#10b981';

        lastSeverity.textContent = severity;
        lastComment.textContent  = comment;
        lastLogData.innerHTML    = renderTimelineView(validJsonData);
        lastSentCard.style.display = 'block';

        // Reset
        logInput.value = '';
        logPreview.innerHTML = 'Väntar på giltig JSON...';
        validJsonData = null;
        setTimeout(() => { statusMessage.textContent = ''; }, 4000);

    } catch (error) {
        statusMessage.textContent = '❌ Fel: ' + error.message;
        statusMessage.style.color = '#ef4444';
        preSendBtn.disabled = false;
    }
});
