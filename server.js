const express = require('express');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { google } = require('googleapis');
const crypto  = require('crypto');

const app  = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

const SPREADSHEET_ID = '1mzZ7d1cUBALEIvgVhR3seKN6DUQpnpS03sV_8kr0zg8';

const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-key.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const TABS = {
    Timeline: ['Severity', 'Log ID', 'Timestamp', 'Source Hostname', 'Dest Hostname', 'User', 'Event', 'Process', 'Log Source', 'Host OS', 'Details', 'Submited At', 'Analyst Comment'],
    NBI:      ['Severity', 'Log ID', 'Timestamp', 'Src IP', 'Src Port', 'Dst IP', 'Dst Port', 'Protocol', 'Domain/URL', 'User Agent', 'Rule/Alert', 'Analyst Comment'],
    HBI:      ['Severity', 'Log ID', 'Timestamp', 'Hostname', 'User', 'Process', 'Process Path', 'PID', 'File Path', 'File Hash', 'Registry Key', 'Rule/Detection', 'Analyst Comment'],
    Maps:     ['Map ID', 'Map Name', 'Created By', 'Created At', 'Updated At', 'Map Data'],
};

async function ensureTabs(sheets) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const existing = meta.data.sheets.map(s => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId
    }));
    const existingTitles = existing.map(s => s.title);

    const requests = [];

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

    for (const tabName of ['NBI', 'HBI', 'Maps']) {
        if (!existingTitles.includes(tabName)) {
            requests.push({ addSheet: { properties: { title: tabName } } });
        }
    }

    if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests }
        });
    }
}

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
        default:   return src.process?.command_line || src.registry?.path || src.dns?.question?.name || src.file?.path || src.message?.split('\n')[0] || 'N/A';
    }
}

async function writeToTab(sheets, tabName, newRow) {
    const headers = TABS[tabName];
    const getRows = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: tabName
    });
    let allData = getRows.data.values || [];
    if (allData.length > 0) allData.shift();

    allData.push(newRow);
    allData.sort((a, b) => new Date(a[2]) - new Date(b[2]));

    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers, ...allData] }
    });

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
// INGEST
// ─────────────────────────────────────────────
app.post('/api/ingest', async (req, res) => {
    try {
        const { log, comment, severity, submittedAt, analystName } = req.body;
        const src    = log._source || {};
        const logId  = log._id || 'N/A';
        const sev    = severity || '⚪ Info';
        const analystComment = analystName ? `[${analystName}] ${comment}` : comment;
        const user      = src.user?.domain ? `${src.user.domain}\\${src.user.name}` : (src.user?.name || 'N/A');
        const eventId   = src.winlog?.event_id || src.event?.code || '?';
        const eventType = src.event?.action || src.winlog?.task || 'N/A';
        const ts        = src['@timestamp'] || 'N/A';
        const destHost  = src.dns?.question?.name || src.destination?.address || src.url?.domain || 'N/A';
        const osInfo    = src.host?.os?.name ? `${src.host.os.name} ${src.host.os.version || ''}${src.host.os.build ? ` (Build ${src.host.os.build})` : ''}`.trim() : 'N/A';
        const agentInfo = src.agent?.type && src.agent?.name ? `${src.agent.type} — ${src.agent.name}` : (src.agent?.name || src.agent?.type || 'N/A');

        const timelineRow = [
            sev, logId, ts,
            src.host?.hostname || 'N/A',
            destHost, user,
            `${eventId} — ${eventType}`,
            src.process?.executable || src.process?.name || 'N/A',
            agentInfo, osInfo,
            getEventDetails(src),
            submittedAt, analystComment
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

// ─────────────────────────────────────────────
// TIMELINE
// ─────────────────────────────────────────────
app.get('/api/timeline', async (req, res) => {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await ensureTabs(sheets);
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Timeline',
        });
        const values = result.data.values || [];
        const rows = values.length > 1 ? values.slice(1) : [];
        res.status(200).json({ rows });
    } catch (error) {
        console.error('❌ Timeline fetch error:', error);
        res.status(500).json({ error: 'Kunde inte hämta timeline.' });
    }
});

// ─────────────────────────────────────────────
// MAPS API
// ─────────────────────────────────────────────

// List all maps (without the heavy JSON data)
app.get('/api/maps', async (req, res) => {
    try {
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await ensureTabs(sheets);
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Maps',
        });
        const values = result.data.values || [];
        const rows = values.length > 1 ? values.slice(1) : [];
        // Return metadata only (no Map Data column for list performance)
        const maps = rows.map(r => ({
            id:        r[0] || '',
            name:      r[1] || 'Namnlös karta',
            createdBy: r[2] || '—',
            createdAt: r[3] || '',
            updatedAt: r[4] || '',
        })).filter(m => m.id);
        res.status(200).json({ maps });
    } catch (error) {
        console.error('❌ Maps list error:', error);
        res.status(500).json({ error: 'Kunde inte hämta kartor.' });
    }
});

// Get a specific map with full data
app.get('/api/maps/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Maps',
        });
        const values = result.data.values || [];
        const rows = values.length > 1 ? values.slice(1) : [];
        const row = rows.find(r => r[0] === id);
        if (!row) return res.status(404).json({ error: 'Karta hittades inte.' });
        res.status(200).json({
            id:        row[0],
            name:      row[1],
            createdBy: row[2],
            createdAt: row[3],
            updatedAt: row[4],
            mapData:   row[5] ? JSON.parse(row[5]) : {},
        });
    } catch (error) {
        console.error('❌ Map get error:', error);
        res.status(500).json({ error: 'Kunde inte hämta karta.' });
    }
});

// Save a new map
app.post('/api/maps', async (req, res) => {
    try {
        const { name, createdBy, mapData } = req.body;
        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        const row = [id, name || 'Namnlös karta', createdBy || '—', now, now, JSON.stringify(mapData || {})];

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        await ensureTabs(sheets);

        // Ensure header
        const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Maps' });
        const currentRows = existing.data.values || [];
        if (currentRows.length === 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: 'Maps!A1',
                valueInputOption: 'RAW',
                requestBody: { values: [TABS.Maps] }
            });
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Maps!A1',
            valueInputOption: 'RAW',
            requestBody: { values: [row] }
        });

        res.status(201).json({ id, name, createdBy, createdAt: now, updatedAt: now });
    } catch (error) {
        console.error('❌ Map save error:', error);
        res.status(500).json({ error: 'Kunde inte spara karta.' });
    }
});

// Update an existing map
app.put('/api/maps/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, mapData, updatedBy } = req.body;
        const now = new Date().toISOString();

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Maps' });
        const values = result.data.values || [];

        // Find the row index (including header)
        const rowIdx = values.findIndex((r, i) => i > 0 && r[0] === id);
        if (rowIdx === -1) return res.status(404).json({ error: 'Karta hittades inte.' });

        const existingRow = values[rowIdx];
        const updatedRow = [
            id,
            name || existingRow[1],
            existingRow[2],   // createdBy never changes
            existingRow[3],   // createdAt never changes
            now,
            JSON.stringify(mapData || {})
        ];

        // Row index in sheet is 1-based and we need to account for header at row 1
        const sheetRow = rowIdx + 1;
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Maps!A${sheetRow}`,
            valueInputOption: 'RAW',
            requestBody: { values: [updatedRow] }
        });

        res.status(200).json({ id, updatedAt: now });
    } catch (error) {
        console.error('❌ Map update error:', error);
        res.status(500).json({ error: 'Kunde inte uppdatera karta.' });
    }
});

// Delete a map
app.delete('/api/maps/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Maps' });
        const values = result.data.values || [];
        const rowIdx = values.findIndex((r, i) => i > 0 && r[0] === id);
        if (rowIdx === -1) return res.status(404).json({ error: 'Karta hittades inte.' });

        // Clear the row instead of deleting (simpler with Sheets API)
        const sheetRow = rowIdx + 1;
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `Maps!A${sheetRow}:F${sheetRow}`,
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Map delete error:', error);
        res.status(500).json({ error: 'Kunde inte radera karta.' });
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
