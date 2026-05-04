const express = require('express');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const port = 3000;

app.use(express.json());

// Inställningar för Google Sheets
const SPREADSHEET_ID = '15LPZIL3INQxmyJrW8-3GMA86DkwaOz3HtLb4f5oz6fs';
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Endpoint för att ta emot loggen
app.post('/api/ingest', async (req, res) => {
    try {
        const { log, comment, submittedAt } = req.body;

        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        // Förbered raden (Platta ut JSON-objektet till en sträng)
        const row = [
            submittedAt,
            comment,
            JSON.stringify(log, null, 2)
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A1',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] },
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Sheets Error:', error);
        res.status(500).json({ error: 'Kunde inte spara till kalkylbladet.' });
    }
});

app.use('/', express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
    console.log(`Server körs på http://localhost:${port}`);
});