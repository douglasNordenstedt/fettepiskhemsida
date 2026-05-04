// UI Elements
const logInput = document.getElementById('logInput');
const logPreview = document.getElementById('logPreview');
const preSendBtn = document.getElementById('preSendBtn');
const statusMessage = document.getElementById('statusMessage');

// Modal Elements
const commentModal = document.getElementById('commentModal');
const commentInput = document.getElementById('commentInput');
const cancelBtn = document.getElementById('cancelBtn');
const confirmSendBtn = document.getElementById('confirmSendBtn');

// Last Sent Elements
const lastSentCard = document.getElementById('lastSentCard');
const lastComment = document.getElementById('lastComment');
const lastLogData = document.getElementById('lastLogData');

let validJsonData = null;

// NEW: Function to extract key fields and create a clean HTML view
function renderTimelineView(data) {
    const src = data._source || {};
    const fields = [
        { label: "Timestamp", value: src['@timestamp'] || "N/A" },
        { label: "Hostname",  value: src.host?.hostname || "N/A" },
        { label: "User",      value: src.user?.name || "N/A" },
        { label: "Process",   value: src.process?.name || "N/A" },
        { label: "Command",   value: src.process?.command_line || src.message || "N/A" },
        { label: "Action",    value: src.event?.action || src.winlog?.task || "N/A" }
    ];

    // Build the HTML for the preview box
    return fields.map(field => `
        <div style="display: flex; border-bottom: 1px solid #334155; padding: 4px 0;">
            <strong style="color: #94a3b8; width: 100px; flex-shrink: 0;">${field.label}</strong>
            <span style="color: #f8fafc; font-family: 'Courier New', monospace; word-break: break-all;">${field.value}</span>
        </div>
    `).join('');
}

// LIVE PREVIEW
logInput.addEventListener('input', () => {
    const rawData = logInput.value.trim();
    if (!rawData) {
        logPreview.innerHTML = "Väntar på giltig JSON...";
        preSendBtn.disabled = true;
        validJsonData = null;
        return;
    }

    try {
        validJsonData = JSON.parse(rawData);
        // Use the new render function for the preview
        logPreview.innerHTML = renderTimelineView(validJsonData);
        preSendBtn.disabled = false;
    } catch (e) {
        logPreview.innerHTML = `<span style="color: #ef4444;">❌ Ogiltigt JSON-format.</span>`;
        preSendBtn.disabled = true;
        validJsonData = null;
    }
});

// OPEN MODAL
preSendBtn.addEventListener('click', () => {
    commentModal.style.display = 'flex';
    commentInput.value = '';
    commentInput.focus();
});

// CLOSE MODAL
cancelBtn.addEventListener('click', () => {
    commentModal.style.display = 'none';
});

// CONFIRM SEND
confirmSendBtn.addEventListener('click', async () => {
    const comment = commentInput.value.trim() || "Ingen kommentar.";
    const payloadToSend = {
        log: validJsonData,
        comment: comment,
        submittedAt: new Date().toISOString()
    };

    commentModal.style.display = 'none';
    statusMessage.textContent = "⏳ Skickar...";
    statusMessage.style.color = "#3b82f6";
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

        statusMessage.textContent = "✅ Logg sparad!";
        statusMessage.style.color = "#10b981";

        lastComment.textContent = comment;
        // Use the new render function for the "Last Sent" box too
        lastLogData.innerHTML = renderTimelineView(validJsonData);
        lastSentCard.style.display = 'block';

        // Reset form
        logInput.value = '';
        logPreview.innerHTML = "Väntar på giltig JSON...";
        validJsonData = null;
        setTimeout(() => { statusMessage.textContent = ""; }, 4000);

    } catch (error) {
        statusMessage.textContent = "❌ Fel: " + error.message;
        statusMessage.style.color = "#ef4444";
        preSendBtn.disabled = false;
    }
});
