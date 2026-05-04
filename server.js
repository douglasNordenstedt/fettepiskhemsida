const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis'); // 1. Lägg till Google API

const app = express();
const port = process.env.PORT || 3000;

// Middleware för att läsa JSON-body från din app.js
app.use(express.json());

// 2. Google Sheets Inställningar
const SPREADSHEET_ID = '1mzZ7d1cUBALEIvgVhR3seKN6DUQpnpS03sV_8kr0zg8';
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-key.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// 3. API-route för att ta emot loggar
app.post('/api/ingest', async (req, res) => {
    try {
        const { log, comment, submittedAt } = req.body;
        const src = log._source || {};

        const newRow = [
            src['@timestamp'] || submittedAt,
            src.host?.hostname || "N/A",
            src.user?.name || "N/A",
            src.process?.name || "N/A",
            src.process?.command_line || src.message || "N/A",
            src.event?.action || src.winlog?.task || "N/A",
            comment
        ];

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const spreadsheetId = SPREADSHEET_ID;

        // 1. Hämta data och headers
        const getRows = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Blad1' });
        let allData = getRows.data.values || [];
        const headers = allData.length > 0 ? allData.shift() : ['Timestamp', 'Hostname', 'User', 'Process', 'Command/Details', 'Action', 'Analyst Comment'];

        // 2. Lägg till ny logg och sortera (Nyast längst upp)
        allData.push(newRow);
        allData.sort((a, b) => new Date(a[0]) - new Date(b[0]));

        // 3. Skriv tillbaka allt
        await sheets.spreadsheets.values.update({
            spreadsheetId, range: 'Blad1!A1', valueInputOption: 'USER_ENTERED',
            requestBody: { values: [headers, ...allData] }
        });

        // 4. AUTOMATISK FORMATERING (Frys rad 1 + Textbrytning)
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    { // Frys första raden
                        updateSheetProperties: {
                            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } },
                            fields: 'gridProperties.frozenRowCount'
                        }
                    },
                    { // Sätt Text Wrap = CLIP på hela arket
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


// Servera statiska filer
app.use('/', express.static(path.join(__dirname, 'public')));

// --- SERVER START LOGIC ---

const certPath = path.join(__dirname, 'server.cert');
const keyPath = path.join(__dirname, 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };

    https.createServer(options, app).listen(port, () => {
        console.log(`🛡️  Certificates found! Secure server running at https://localhost:${port}`);
    });
} else {
    http.createServer(app).listen(port, () => {
        console.log(`⚠️  No certificates found. Running in HTTP mode at http://localhost:${port}`);
    });
}
