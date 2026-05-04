const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const SPREADSHEET_ID = '1mzZ7d1cUBALEIvgVhR3seKN6DUQpnpS03sV_8kr0zg8';
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-key.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ─────────────────────────────────────────────
// EVENT-AWARE DETAIL EXTRACTOR  (server-side mirror of app.js)
// This decides what goes in the "Details" column of the spreadsheet.
// TO ADD A NEW EVENT TYPE: add a case below with the Sysmon event_id.
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
        case '13': // Registry Value Set
        case '14': // Registry Key Renamed
            return src.registry?.path || src.registry?.key || 'N/A';

        case '22': { // DNS Query
            const domain = src.dns?.question?.name || 'N/A';
            const ips = src.dns?.resolved_ip;
            const ipStr = Array.isArray(ips) ? ips.slice(0, 3).join(', ') : (ips || '');
            return ipStr ? `${domain} → ${ipStr}` : domain;
        }

        case '23': // File Delete
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
// INGEST ROUTE
// Columns: Timestamp | Hostname | User | Event | Process | Details | Comment
// ─────────────────────────────────────────────
app.post('/api/ingest', async (req, res) => {
    try {
        const { log, comment, submittedAt } = req.body;
        const src = log._source || {};

        const user = src.user?.domain
            ? `${src.user.domain}\\${src.user.name}`
            : (src.user?.name || 'N/A');

        const eventId   = src.winlog?.event_id || src.event?.code || '?';
        const eventType = src.event?.action || src.winlog?.task || 'N/A';

        const newRow = [
            src['@timestamp'] || submittedAt,               // A: Timestamp
            src.host?.hostname || 'N/A',                    // B: Hostname
            user,                                           // C: User (DOMAIN\name)
            `${eventId} — ${eventType}`,                    // D: Event ID + Type
            src.process?.executable || src.process?.name || 'N/A', // E: Process
            getEventDetails(src),                           // F: Details (event-specific)
            comment                                         // G: Analyst Comment
        ];

        const headers = ['Timestamp', 'Hostname', 'User', 'Event', 'Process', 'Details', 'Analyst Comment'];

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        // Fetch existing data, sort, rewrite
        const getRows = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Blad1' });
        let allData = getRows.data.values || [];
        if (allData.length > 0) allData.shift(); // remove old header row

        allData.push(newRow);
        allData.sort((a, b) => new Date(a[0]) - new Date(b[0]));

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Blad1!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [headers, ...allData] }
        });

        // Formatting: freeze header + clip wrap
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
                            fields: 'gridProperties.frozenRowCount'
                        }
                    },
                    {
                        repeatCell: {
                            range: { sheetId: 0 },
                            cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } },
                            fields: 'userEnteredFormat.wrapStrategy'
                        }
                    }
                ]
            }
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('❌ Sheets Error:', error);
        res.status(500).json({ error: 'Kunde inte spara.' });
    }
});

app.use('/', express.static(path.join(__dirname, 'public')));

// Server start
const certPath = path.join(__dirname, 'server.cert');
const keyPath  = path.join(__dirname, 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
        .listen(port, () => console.log(`🛡️  HTTPS running at https://localhost:${port}`));
} else {
    http.createServer(app)
        .listen(port, () => console.log(`⚠️  HTTP running at http://localhost:${port}`));
}
