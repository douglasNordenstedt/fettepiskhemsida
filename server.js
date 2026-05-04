const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

// Path to certificates
const certPath = path.join(__dirname, 'server.cert');
const keyPath = path.join(__dirname, 'server.key');

app.use('/', express.static(path.join(__dirname, 'public')));

// Check if both certificate files exist
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };

    https.createServer(options, app).listen(port, () => {
        console.log(`🛡️  Certificates found! Secure server running at https://localhost:${port}`);
    });
} else {
    // FALLBACK TO HTTP
    http.createServer(app).listen(port, () => {
        console.log(`⚠️  No certificates found. Running in HTTP mode at http://localhost:${port}`);
        console.log(`💡 Hint: Run 'openssl' command (see README) to enable HTTPS locally.`);
    });
}
