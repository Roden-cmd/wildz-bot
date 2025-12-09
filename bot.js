const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

let channels = {};
const activeBots = new Map();
const processedMessages = new Set();

function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${msg}`);
}

app.get('/', (req, res) => {
    res.json({ status: 'Bot running', channels: Object.keys(channels).length });
});

app.get('/config', (req, res) => {
    res.json(channels);
});

app.post('/config', (req, res) => {
    channels = req.body;
    res.json({ success: true });
    checkChannels();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`API running on port ${PORT}`));
