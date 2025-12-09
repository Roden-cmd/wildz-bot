const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG_FILE = './channels.json';
const activeBots = new Map();
const processedMessages = new Set();

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function loadChannels() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function saveChannels(channels) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(channels, null, 2));
}

let channels = loadChannels();

// Web Control Panel
app.get('/', (req, res) => {
    channels = loadChannels();
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Wildz Bot Control</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
        body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px;margin:0}
        .card{background:#16213e;padding:20px;border-radius:10px;margin:15px 0}
        input,button{padding:10px;margin:5px 0;width:100%;border:none;border-radius:5px;box-sizing:border-box}
        input{background:#0f3460;color:#fff}
        button{background:#00d4ff;color:#000;cursor:pointer;font-weight:bold}
        .ch{background:#0f3460;padding:15px;margin:10px 0;border-radius:8px}
        .on{color:#0f0}.off{color:#f00}
        h1{color:#00d4ff;text-align:center}
        .btn-sm{width:auto;padding:8px 15px;margin:5px}
        .btn-danger{background:#ff4444;color:#fff}
        .cmd{background:#1a1a2e;padding:8px;margin:5px 0;border-radius:5px;font-size:14px}
    </style>
</head>
<body>
    <h1>⚡ Wildz Bot Control</h1>
    
    <div class="card">
        <h3>➕ Add Channel</h3>
        <form method="POST" action="/add">
            <input name="name" placeholder="Channel Name" required>
            <input name="url" placeholder="https://wildz.com/..." required>
            <input name="username" placeholder="Username">
            <input name="password" type="password" placeholder="Password">
            <button type="submit">Add Channel</button>
        </form>
    </div>
    
    <div class="card">
        <h3>📺 Channels (${Object.keys(channels).length})</h3>
        ${Object.keys(channels).length === 0 ? '<p style="opacity:0.5">No channels yet</p>' : ''}
        ${Object.entries(channels).map(([id, ch]) => `
            <div class="ch">
                <b>${ch.name}</b> - <span class="${ch.status === 'active' ? 'on' : 'off'}">${ch.status.toUpperCase()}</span>
                <br><small style="opacity:0.7">${ch.url}</small>
                <br><small>Bot: ${activeBots.has(id) ? '🟢 Running' : '⚪ Stopped'}</small>
                <div style="margin-top:10px">
                    <form method="POST" action="/toggle" style="display:inline">
                        <input type="hidden" name="id" value="${id}">
                        <button class="btn-sm">${ch.status === 'active' ? '⏸ Pause' : '▶ Start'}</button>
                    </form>
                    <form method="POST" action="/delete" style="display:inline" onsubmit="return confirm('Delete?')">
                        <input type="hidden" name="id" value="${id}">
                        <button class="btn-sm btn-danger">🗑 Delete</button>
                    </form>
                </div>
                <div style="margin-top:15px;border-top:1px solid #0f3460;padding-top:10px">
                    <b>Commands:</b>
                    ${(ch.commands || []).map(c => `<div class="cmd"><code>${c.trigger}</code> → ${c.response}</div>`).join('')}
                    <form method="POST" action="/addcmd" style="margin-top:10px;display:flex;gap:5px">
                        <input type="hidden" name="id" value="${id}">
                        <input name="trigger" placeholder="!cmd" style="width:25%" required>
                        <input name="response" placeholder="Response" style="width:50%" required>
                        <button style="width:25%">Add</button>
                    </form>
                </div>
            </div>
        `).join('')}
    </div>
    
    <div class="card">
        <h3>📊 Status</h3>
        <p>Active Bots: ${activeBots.size}</p>
        <p>Total Channels: ${Object.keys(channels).length}</p>
    </div>
</body>
</html>
    `);
});

app.post('/add', (req, res) => {
    const id = 'ch_' + Date.now();
    channels[id] = {
        name: req.body.name,
        url: req.body.url,
        username: req.body.username || '',
        password: req.body.password || '',
        status: 'active',
        commands: [],
        auto_replies: []
    };
    saveChannels(channels);
    checkChannels();
    res.redirect('/');
});

app.post('/toggle', (req, res) => {
    const id = req.body.id;
    if (channels[id]) {
        channels[id].status = channels[id].status === 'active' ? 'inactive' : 'active';
        saveChannels(channels);
        checkChannels();
    }
    res.redirect('/');
});

app.post('/delete', (req, res) => {
    const id = req.body.id;
    if (activeBots.has(id)) {
        activeBots.get(id).stop();
        activeBots.delete(id);
    }
    delete channels[id];
    saveChannels(channels);
    res.redirect('/');
});

app.post('/addcmd', (req, res) => {
    const id = req.body.id;
    if (channels[id]) {
        if (!channels[id].commands) channels[id].commands = [];
        channels[id].commands.push({
            trigger: req.body.trigger,
            response: req.body.response
        });
        saveChannels(channels);
        if (activeBots.has(id)) {
            activeBots.get(id).config = channels[id];
        }
    }
    res.redirect('/');
});

app.get('/api/config', (req, res) => {
    res.json(channels);
});

// Bot Class
class WildzBot {
    constructor(id, config) {
        this.id = id;
        this.config = config;
        this.browser = null;
        this.page = null;
        this.running = false;
    }

    async start() {
        try {
            log(`Starting bot: ${this.config.name}`);
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process'
                ]
            });
            this.page = await this.browser.newPage();
            await this.page.setViewport({ width: 1920, height: 1080 });
            
            log(`Navigating to: ${this.config.url}`);
            await this.page.goto(this.config.url, { waitUntil: 'networkidle2', timeout: 60000 });
            
            if (this.config.username && this.config.password) {
                await this.login();
            }
            
            this.running = true;
            log(`Bot started: ${this.config.name}`);
            this.monitorChat();
        } catch (e) {
            log(`Start failed: ${e.message}`);
        }
    }

    async login() {
        try {
            log('Attempting login...');
            
            // Go directly to login page
            log('Navigating to login page...');
            await this.page.goto('https://www.wildz.com/en/login/', { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 5000));
            
            // Wait for login form to appear
            log('Waiting for login form...');
            
            // Try multiple times to find the fields
            let emailInput = null;
            let passInput = null;
            
            for (let i = 0; i < 10; i++) {
                emailInput = await this.page.$('.field--username input, input[name="username"], input[type="email"]');
                passInput = await this.page.$('.field--password input, input[type="password"]');
                
                if (emailInput && passInput) {
                    break;
                }
                log(`Waiting for form... attempt ${i + 1}`);
                await new Promise(r => setTimeout(r, 2000));
            }
            
            if (emailInput && passInput) {
                log('Found login fields!');
                
                // Enter email
                await emailInput.click();
                await emailInput.type(this.config.username, { delay: 50 });
                log('Email entered');
                
                // Enter password  
                await passInput.click();
                await passInput.type(this.config.password, { delay: 50 });
                log('Password entered');
                
                await new Promise(r => setTimeout(r, 1000));
                
                // Click login button
                const loginBtn = await this.page.$('button.btn-purple, button.btn-big, form button');
                if (loginBtn) {
                    await loginBtn.click();
                    log('Login button clicked');
                } else {
                    await this.page.keyboard.press('Enter');
                    log('Login submitted via Enter');
                }
                
                await new Promise(r => setTimeout(r, 5000));
                
                // Navigate back to chat after login
                log('Navigating back to chat...');
                await this.page.goto(this.config.url, { waitUntil: 'networkidle2', timeout: 60000 });
                await new Promise(r => setTimeout(r, 3000));
                
                log('Login complete!');
            } else {
                log('Login fields not found - taking screenshot for debug');
                const html = await this.page.content();
                log('Page title: ' + await this.page.title());
            }
        } catch (e) {
            log(`Login error: ${e.message}`);
        }
    }

    monitorChat() {
        setInterval(async () => {
            if (!this.running) return;
            try {
                const messages = await this.page.evaluate(() => {
                    const msgs = document.querySelectorAll('[class*="chat"] [class*="message"], [class*="Message"], .message-content, .chat-message');
                    return Array.from(msgs).slice(-10).map(m => m.innerText.trim());
                });
                
                for (const msg of messages) {
                    if (!msg || processedMessages.has(msg)) continue;
                    processedMessages.add(msg);
                    
                    if (processedMessages.size > 500) {
                        const first = processedMessages.values().next().value;
                        processedMessages.delete(first);
                    }
                    
                    await this.checkCommands(msg);
                }
            } catch (e) {}
        }, 2000);
    }

    async checkCommands(msg) {
        if (!this.config.commands) return;
        
        for (const cmd of this.config.commands) {
            if (msg.toLowerCase().includes(cmd.trigger.toLowerCase())) {
                log(`Command triggered: ${cmd.trigger}`);
                await this.sendMessage(cmd.response);
                break;
            }
        }
    }

    async sendMessage(text) {
        try {
            const input = await this.page.$('input[type="text"], textarea[class*="chat"], [class*="input"], textarea');
            if (input) {
                await input.click();
                await input.type(text, { delay: 30 });
                await this.page.keyboard.press('Enter');
                log(`Sent: ${text}`);
            }
        } catch (e) {
            log(`Send error: ${e.message}`);
        }
    }

    async stop() {
        this.running = false;
        if (this.browser) {
            await this.browser.close();
        }
        log(`Bot stopped: ${this.config.name}`);
    }
}

// Check and manage bots
async function checkChannels() {
    for (const [id, cfg] of Object.entries(channels)) {
        if (cfg.status === 'active' && !activeBots.has(id)) {
            const bot = new WildzBot(id, cfg);
            activeBots.set(id, bot);
            bot.start();
        }
        if (cfg.status === 'inactive' && activeBots.has(id)) {
            const bot = activeBots.get(id);
            await bot.stop();
            activeBots.delete(id);
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`⚡ Wildz Bot running on port ${PORT}`);
    log(`Open http://localhost:${PORT} to access control panel`);
    checkChannels();
});

// Check for config changes every 10 seconds
setInterval(() => {
    channels = loadChannels();
    checkChannels();
}, 10000);
