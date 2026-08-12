import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';

console.log('🔄 Starting Baileys Node.js Service (Stabilized)...');

const app = express();
app.use(express.json());

const PORT = 3000;
const AUTH_DIR = 'auth_info_baileys';

const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const SESSION_B64 = process.env.SESSION_B64 || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// ---- state ----
let sock = null;
let creds = null;
let pairingRequestedAt = 0;
let reconnectDelayMs = 10_000;
let sessionSnapshotFingerprint = '';
let lastSessionExportAt = 0;
let lastLogTime = 0;

const PAIRING_COOLDOWN_MS = 10 * 60_000; // 10 Minutes 

// =============================================================================
// HELPERS & PERSISTENCE
// =============================================================================

function log(msg) { console.log(`[NODE] ${msg}`); }

function logThrottled(msg, minIntervalMs = 60_000) {
    const now = Date.now();
    if (now - lastLogTime < minIntervalMs) return;
    lastLogTime = now;
    log(msg);
}

async function notifyTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        });
    } catch (e) {
        log(`Telegram notify failed: ${e.message}`);
    }
}

function sessionToB64() {
    const files = fs.readdirSync(AUTH_DIR);
    const snapshot = {};
    for (const f of files) {
        const p = path.join(AUTH_DIR, f);
        if (!fs.statSync(p).isFile()) continue;
        snapshot[f] = fs.readFileSync(p).toString('base64');
    }
    return Buffer.from(JSON.stringify(snapshot)).toString('base64');
}

function restoreSessionFromB64(b64) {
    try {
        const snapshot = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [name, data] of Object.entries(snapshot)) {
            fs.writeFileSync(path.join(AUTH_DIR, name), Buffer.from(data, 'base64'));
        }
        return true;
    } catch (e) {
        log(`Could not restore session: ${e.message}`);
        return false;
    }
}

function maybeExportSession(force = false) {
    if (!creds || !creds.registered) return;
    try {
        const b64 = sessionToB64();
        const fp = b64.length + ':' + b64.slice(0, 64);
        if (!force && fp === sessionSnapshotFingerprint) return;
        if (!force && Date.now() - lastSessionExportAt < 10 * 60_000) return;
        sessionSnapshotFingerprint = fp;
        lastSessionExportAt = Date.now();
        console.log(
            `\n[SESSION_B64] Copy this EXACT line into Render → Environment → SESSION_B64:\n` +
            `[SESSION_B64] ${b64}\n`
        );
    } catch (e) {
        log(`Session export failed: ${e.message}`);
    }
}

// =============================================================================
// PAIRING LOGIC
// =============================================================================

async function tryRequestPairingCode() {
    if (!PHONE_NUMBER) {
        logThrottled('⚠️ PHONE_NUMBER env var not set. Cannot pair.');
        return;
    }
    if (creds && creds.registered) return;          
    if (Date.now() - pairingRequestedAt < PAIRING_COOLDOWN_MS) return; 

    pairingRequestedAt = Date.now(); 
    try {
        log(`Requesting pairing code for ${PHONE_NUMBER}...`);
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        const msg =
            `\n=========================================================\n` +
            `🚨 PAIRING CODE: ${code}\n` +
            `1. Open WhatsApp on your phone → Settings → Linked Devices\n` +
            `2. Tap "Link with phone number instead"\n` +
            `3. Enter this code within ~2 minutes: ${code}\n` +
            `=========================================================\n`;
        console.log(msg);
        await notifyTelegram(`🔑 Goethe Watchtower pairing code:\n\n${code}`);
    } catch (err) {
        console.error(`🔴 Failed to request pairing code: ${err.message}`);
    }
}

// =============================================================================
// WHATSAPP CONNECTION
// =============================================================================

async function connectToWhatsApp() {
    const { version } = await fetchLatestBaileysVersion();
    log(`Using WhatsApp Web version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    creds = state.creds;

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60_000,
        connectTimeoutMs: 120_000,
        keepAliveIntervalMs: 30_000,
    });

    sock.ev.on('creds.update', async (update) => {
        const wasRegistered = !!(creds && creds.registered);
        creds = { ...(creds || {}), ...update };
        saveCreds(update);

        if (!wasRegistered && creds.registered) {
            log('✅ Pairing complete! WhatsApp session is now saved.');
            reconnectDelayMs = 10_000;
            maybeExportSession(true); 
            await notifyTelegram('✅ Goethe Watchtower is now paired with WhatsApp.');
        } else {
            maybeExportSession(false);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // OFFICIAL FIX: Wait for the 'qr' emission to signal the WS server is ready for pairing payload.
        if (qr && !creds?.registered) {
            tryRequestPairingCode();
        }

        if (connection === 'connecting') {
            logThrottled('🟡 Socket connecting...', 30_000);
        } else if (connection === 'open') {
            log('✅ WhatsApp connected!');
            reconnectDelayMs = 10_000;
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'unknown';
            log(`Connection closed. Status: ${statusCode} (${reason})`);

            // OFFICIAL FIX: Auto-heal corrupted/loggedOut sessions.
            if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
                console.log(`\n🔴 Session terminated (401). Wiping dead keys and restarting loop...\n`);
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
                creds = null;
                pairingRequestedAt = 0; // Safe to reset here since keys are wiped.
                await notifyTelegram(`⚠️ WhatsApp session logged out (${statusCode}). Wiping keys and restarting to generate new pairing code.`);
                setTimeout(() => connectToWhatsApp(), 5000);
                return;
            }

            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('🔴 Session was opened on another device. Close the other session and restart.');
                return;
            }

            // OFFICIAL FIX: Do not reset pairingRequestedAt on 428!
            if (statusCode === 428) {
                reconnectDelayMs = Math.min(reconnectDelayMs * 2 + Math.floor(Math.random() * 10_000), 30 * 60_000);
                log(`⏳ WhatsApp rate-limited us (428). Waiting ${Math.round(reconnectDelayMs / 1000)}s...`);
            } else if (statusCode === 515 || statusCode === 408 || !statusCode) {
                reconnectDelayMs = 10_000;
            } else {
                reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
            }

            setTimeout(() => connectToWhatsApp().catch(err => console.error(err)), reconnectDelayMs);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (msg?.key?.remoteJid?.endsWith('@g.us')) {
                console.log(`\n🎯 GROUP ID FOUND!\nGroup ID: ${msg.key.remoteJid}\n`);
            }
        } catch (e) {}
    });
}

// =============================================================================
// HTTP API & BOOT
// =============================================================================

app.post('/send', async (req, res) => {
    const { to, body } = req.body || {};
    if (!sock || !sock.ws || !sock.ws.isOpen) {
        return res.status(503).json({ error: 'WhatsApp not connected yet.' });
    }
    try {
        const chatId = to.includes('@') ? to : `${to}@g.us`;
        await Promise.race([
            sock.sendMessage(chatId, { text: body }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000)),
        ]);
        res.status(200).json({ status: 'success' });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

if (SESSION_B64) {
    restoreSessionFromB64(SESSION_B64);
}
connectToWhatsApp();
app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));
