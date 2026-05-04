const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { google } = require('googleapis');

const app  = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const SPREADSHEET_ID = '1mzZ7d1cUBALEIvgVhR3seKN6DUQpnpS03sV_8kr0zg8';
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-key.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ─────────────────────────────────────────────
// TAB DEFINITIONS
// Each tab has a name and its header row.
// Add new tabs here in the future.
// ─────────────────────────────────────────────
const TABS = {
    Timeline: ['Severity', 'Log ID', 'Timestamp', 'Hostname', 'User', 'Event', 'Process', 'Details', 'Analyst Comment'],
    NBI:      ['Severity', 'Log ID', 'Timestamp', 'Src IP', 'Src Port', 'Dst IP', 'Dst Port', 'Protocol', 'Domain/URL', 'User Agent', 'Rule/Alert', 'Analyst Comment'],
    HBI:      ['Severity', 'Log ID', 'Timestamp', 'Hostname', 'User', 'Process', 'Process Path', 'PID', 'File Path', 'File Hash', 'Registry Key', 'Rule/Detection', 'Analyst Comment'],
};

// ─────────────────────────────────────────────
// ENSURE TABS EXIST
// On each ingest: rename old "Blad1" to "Timeline" if needed,
// then create any missing NBI / HBI tabs.
// ─────────────────────────────────────────────
async function ensureTabs(sheets) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existing = meta.data.sheets.map(s => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId
    }));
    const existingTitles = existing.map(s => s.title);

    const requests = [];

    // Rename "Blad1" → "Timeline" if Timeline doesn't exist yet
    if (!existingTitles.includes('Timeline')) {
        const blad1 = existing.find(s => s.title === 'Blad1' || s.title === 'Sheet1');
        if (blad1) {
            requests.push({
                updateSheetProperties: {
                    properties: { sheetId: blad1.sheetId, title: 'Timeline' },
                    fields: 'title'
                }
            });
        }
    }

    // Create missing tabs (NBI, HBI)
    for (const tabName of ['NBI', 'HBI']) {
        if (!existingTitles.includes(tabName)) {
            requests.push({ addSheet: { properties: { title: tabName } } });
        }
    }

    if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests }
        });
        console.log(`✅ Tabs ensured: ${requests.map(r =>
            r.updateSheetProperties?.properties?.title || r.addSheet?.properties?.title
        ).join(', ')}`);
    }
}

// ─────────────────────────────────────────────
// EVENT-AWARE DETAIL EXTRACTOR  (mirrors app.js)
// ─────────────────────────────────────────────
function getEventDetails(src) {
    const eventId = String(src.winlog?.event_id || src.event?.code || '');
    switch (eventId) {
        case '1':  return src.process?.command_line || src.process?.executable || 'N/A';
        case '3':  return [
                       src.destination?.ip ? `→ ${src.destination.ip}:${src.destination?.port}` : null,
                       src.network?.protocol ? `(${src.network.protocol})` : null
                   ].filter(Boolean).join(' ') || 'N/A';
        case '5':  return src.process?.executable || src.process?.name || 'N/A';
        case '7':  return src.file?.path || src.dll?.path || 'N/A';
        case '11': return src.file?.path || src.file?.name || 'N/A';
        case '12':
        case '13':
        case '14': return src.registry?.path || src.registry?.key || 'N/A';
        case '22': {
            const domain = src.dns?.question?.name || 'N/A';
            const ips    = src.dns?.resolved_ip;
            const ipStr  = Array.isArray(ips) ? ips.slice(0, 3).join(', ') : (ips || '');
            return ipStr ? `${domain} → ${ipStr}` : domain;
        }
        case '23':
        case '26': return src.file?.path || 'N/A';
        default:   return src.process?.command_line
                       || src.registry?.path
                       || src.dns?.question?.name
                       || src.file?.path
                       || src.message?.split('\n')[0]
                       || 'N/A';
    }
}

// ─────────────────────────────────────────────
// WRITE TO A TAB (generic helper)
// Appends a row, keeps header, sorts by Timestamp column (index 2).
// ─────────────────────────────────────────────
async function writeToTab(sheets, tabName, newRow) {
    const headers = TABS[tabName];

    const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: tabName
    });
    let allData = getRows.data.values || [];
    if (allData.length > 0) allData.shift(); // drop old header

    allData.push(newRow);
    allData.sort((a, b) => new Date(a[2]) - new Date(b[2])); // col 2 = Timestamp

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers, ...allData] }
    });

    // Formatting per tab
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
    if (!sheet) return;
    const sheetId = sheet.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
            requests: [
                {
                    updateSheetProperties: {
                        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                        fields: 'gridProperties.frozenRowCount'
                    }
                },
                {
                    repeatCell: {
                        range: { sheetId },
                        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
                        fields: 'userEnteredFormat.wrapStrategy'
                    }
                }
            ]
        }
    });
}

// ─────────────────────────────────────────────
// INGEST ROUTE
// ─────────────────────────────────────────────
app.post('/api/ingest', async (req, res) => {
    try {
        const { log, comment, severity, submittedAt } = req.body;
        const src    = log._source || {};
        const logId  = log._id || 'N/A';
        const sev    = severity || '⚪ Info';

        const user      = src.user?.domain
                            ? `${src.user.domain}\\${src.user.name}`
                            : (src.user?.name || 'N/A');
        const eventId   = src.winlog?.event_id || src.event?.code || '?';
        const eventType = src.event?.action || src.winlog?.task || 'N/A';
        const ts        = src['@timestamp'] || submittedAt;

        const timelineRow = [
            sev,
            logId,
            ts,
            src.host?.hostname || 'N/A',
            user,
            `${eventId} — ${eventType}`,
            src.process?.executable || src.process?.name || 'N/A',
            getEventDetails(src),
            comment
        ];

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        await ensureTabs(sheets);
        await writeToTab(sheets, 'Timeline', timelineRow);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Sheets Error:', error);
        res.status(500).json({ error: 'Kunde inte spara.' });
    }
});

app.use('/', express.static(path.join(__dirname, 'public')));

const certPath = path.join(__dirname, 'server.cert');
const keyPath  = path.join(__dirname, 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
        .listen(port, () => console.log(`🛡️  HTTPS at https://localhost:${port}`));
} else {
    http.createServer(app)
        .listen(port, () => console.log(`⚠️  HTTP at http://localhost:${port}`));
}
