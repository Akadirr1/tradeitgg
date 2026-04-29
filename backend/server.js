const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to read database
const readDB = () => {
    if (!fs.existsSync(DB_PATH)) {
        return { keys: {} };
    }
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
};

// Helper function to write database
const writeDB = (data) => {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
};

// Activation Endpoint
app.post('/api/activate', (req, res) => {
    const { apiKey, deviceId } = req.body;

    if (!apiKey || !deviceId) {
        return res.status(400).json({ error: 'API key and Device ID are required.' });
    }

    const db = readDB();

    if (!db.keys[apiKey]) {
        return res.status(401).json({ error: 'Geçersiz API Anahtarı.' });
    }

    const boundDeviceId = db.keys[apiKey].deviceId;

    // If key is not bound to any device yet, bind it
    if (!boundDeviceId) {
        db.keys[apiKey].deviceId = deviceId;
        writeDB(db);
        return res.json({ success: true, message: 'Başarıyla aktifleştirildi.' });
    }

    // If key is bound, check if the device ID matches
    if (boundDeviceId === deviceId) {
        return res.json({ success: true, message: 'Zaten aktifleştirilmiş.' });
    }

    // If bound device ID does not match, reject
    return res.status(403).json({ error: 'Bu API anahtarı zaten başka bir cihazda kullanılıyor.' });
});

// Verification Endpoint (for periodic checks)
app.post('/api/verify', (req, res) => {
    const { apiKey, deviceId } = req.body;

    if (!apiKey || !deviceId) {
        return res.status(400).json({ error: 'API key and Device ID are required.' });
    }

    const db = readDB();

    if (!db.keys[apiKey] || db.keys[apiKey].deviceId !== deviceId) {
        return res.status(401).json({ error: 'Yetkisiz.' });
    }

    return res.json({ success: true, valid: true });
});

app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
    console.log(`Available API keys for testing: test-api-key-123, premium-key-456`);
});
