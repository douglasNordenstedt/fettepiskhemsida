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

let validJsonData = null; // Stores parsed JSON when valid

// 1. LIVE PREVIEW: Listen to typing/pasting
logInput.addEventListener('input', () => {
    const rawData = logInput.value.trim();

    if (!rawData) {
        logPreview.textContent = "Väntar på giltig JSON...";
        logPreview.style.color = "#94a3b8"; // muted text
        preSendBtn.disabled = true;
        validJsonData = null;
        return;
    }

    try {
        // Try to parse it to ensure it's real JSON
        validJsonData = JSON.parse(rawData);
        
        // Show pretty-printed JSON in the preview box
        logPreview.textContent = JSON.stringify(validJsonData, null, 2);
        logPreview.style.color = "#10b981"; // green text = good
        preSendBtn.disabled = false; // Enable the send button
    } catch (e) {
        logPreview.textContent = "❌ Ogiltigt JSON-format. Vänligen kontrollera syntaxen.";
        logPreview.style.color = "#ef4444"; // red text = bad
        preSendBtn.disabled = true;
        validJsonData = null;
    }
});

// 2. OPEN MODAL: When clicking "Granska och Skicka"
preSendBtn.addEventListener('click', () => {
    commentModal.style.display = 'flex';
    commentInput.value = ''; // clear previous comment
    commentInput.focus();
});

// 3. CLOSE MODAL: When clicking "Avbryt"
cancelBtn.addEventListener('click', () => {
    commentModal.style.display = 'none';
});

// 4. CONFIRM SEND: When hitting send inside the modal
confirmSendBtn.addEventListener('click', async () => {
    const comment = commentInput.value.trim() || "Ingen kommentar.";
    const ParsedJSON = JSON.parse(validJsonData); 
    const payloadToSend = {
        //log: validJsonData,
        Timestamp: ParsedJSON["@timestamp"],
        comment: comment,
        submittedAt: new Date().toISOString()
    };

    commentModal.style.display = 'none';
    statusMessage.textContent = "⏳ Skickar till kalkylblad...";
    statusMessage.style.color = "#3b82f6";
    preSendBtn.disabled = true;

    try {
        // DETTA ÄR INTEGRATIONEN:
        const response = await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadToSend)
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Serverfel');
        }

        // On Success:
        statusMessage.textContent = "✅ Logg sparad i Sheets!";
        statusMessage.style.color = "#10b981";

        lastComment.textContent = comment;
        lastLogData.textContent = JSON.stringify(validJsonData, null, 2);
        lastSentCard.style.display = 'block';

        // Återställ formulär
        logInput.value = '';
        logPreview.textContent = "Väntar på giltig JSON...";
        logPreview.style.color = "#94a3b8";
        validJsonData = null;

        setTimeout(() => { statusMessage.textContent = ""; }, 4000);

    } catch (error) {
        statusMessage.textContent = "❌ Fel: " + error.message;
        statusMessage.style.color = "#ef4444";
        preSendBtn.disabled = false;
        console.error('Fetch error:', error);
    }
});