// server.js — Goethe Watchtower WhatsApp Gateway (FIXED)
//
// What was wrong and what this fixes:
// 1. Pairing code was requested on EVERY 'connecting' event → each reconnect
//    invalidated the code the user was typing, and WhatsApp rate-limits
//    pairing requests per number → 428 spiral → 401 session kill.
//    FIX: request a pairing code at most once per 10 minutes, and only while unregistered.
// 2. No backoff on rate-limit (428) / temporary issues.
//    FIX: exponential backoff with jitter (up to 30 min), reset on successful connect.
// 3. Session stored only on Render's EPHEMERAL disk → every redeploy forced a
//    fresh pairing request (the root cause of your repeated 428/401).
//    FIX: session is snapshotted to a base64 string printed as SESSION_B64.
//    Paste it into Render → Environment → SESSION_B64 and you NEVER re-pair again.
// 4. Pairing code only visible in Render logs → easy to miss.
//    FIX: the code is also sent to your Telegram chat (uses the same
//    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars as main.py).

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

console.log('🔄 Starting Baileys Node.js Service (fixed)...');

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
let creds = null;               // live copy of creds (tracked via creds.update)
let pairingRequestedAt = 0;     // last time we asked WhatsApp for a pairing code
let reconnectDelayMs = 10_000;  // current backoff
let sessionSnapshotFingerprint = '';
let lastSessionExportAt = 0;
let lastLogTime = 0;            // throttle repeated log lines

const PAIRING_COOLDOWN_MS = 10 * 60_000; // don't ask WhatsApp for a code more than once per 10 min

// =============================================================================
// HELPERS
// =============================================================================

function log(msg) {
    console.log(`[NODE] ${msg}`);
}

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

// =============================================================================
// SESSION PERSISTENCE (survives Render restarts / redeploys)
// =============================================================================

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
        log(`Could not restore session from SESSION_B64: ${e.message}`);
        return false;
    }
}

// Print the session snapshot so the user can copy it into Render env vars.
// Prints on pair-complete (force), then at most every 10 min if it changed.
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
            `\n[SESSION_B64] Copy this EXACT line into Render → Environment → SESSION_B64, then redeploy once:\n` +
            `[SESSION_B64] ${b64}\n`
        );
    } catch (e) {
        log(`Session export failed: ${e.message}`);
    }
}

// =============================================================================
// PAIRING
// =============================================================================

async function tryRequestPairingCode() {
    if (!PHONE_NUMBER) {
        logThrottled('⚠️ PHONE_NUMBER env var not set — cannot pair. Set it in Render → Environment.');
        return;
    }
    if (creds && creds.registered) return;          // already paired
    if (Date.now() - pairingRequestedAt < PAIRING_COOLDOWN_MS) return; // respect WhatsApp rate limit

    pairingRequestedAt = Date.now(); // BEFORE the request, so slow/failed requests still cool down
    try {
        log(`Requesting pairing code for ${PHONE_NUMBER}...`);
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        const msg =
            `\n=========================================================\n` +
            `🚨 PAIRING CODE: ${code}\n` +
            `1. Open WhatsApp on your phone → Settings → Linked Devices → Link a device\n` +
            `2. Tap "Link with phone number instead"\n` +
            `3. Enter this code within ~2 minutes: ${code}\n` +
            `(A new code is only requested if the socket drops and 10+ minutes pass.)\n` +
            `=========================================================\n`;
        console.log(msg);
        await notifyTelegram(`🔑 Goethe Watchtower pairing code:\n\n${code}\n\nEnter it in WhatsApp → Linked Devices → Link with phone number instead.\n(Valid ~2 minutes.)`);
    } catch (err) {
        console.error(`🔴 Failed to request pairing code: ${err.message}`);
        // Keep the cooldown: pairingRequestedAt was already set, so we won't
        // hammer WhatsApp again for another 10 minutes.
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

    if (creds.registered) {
        log(`📂 Session loaded (already paired as ${creds.me?.id || PHONE_NUMBER}). Connecting without pairing...`);
    }

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
            maybeExportSession(true); // print SESSION_B64 once — save it in Render!
            await notifyTelegram('✅ Goethe Watchtower is now paired with WhatsApp and online.');
        } else {
            maybeExportSession(false);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            logThrottled('🟡 Socket connecting...', 30_000);
            tryRequestPairingCode(); // safe: rate-limited internally
        } else if (connection === 'open') {
            log('✅ WhatsApp connected!');
            reconnectDelayMs = 10_000;
            await notifyTelegram('✅ Goethe Watchtower is ONLINE and connected to WhatsApp.');
        } else if (connection === 'close') {
            const prevSock = sock;
            sock = null;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'unknown';
            log(`Connection closed. Status: ${statusCode} (${reason})`);

            // --- TERMINAL states: do NOT auto-reconnect (prevents ban spirals) ---
            if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden) {
                console.log(
                    `\n🔴 Session terminated (${statusCode}). Re-pairing is required:\n` +
                    `   1. If SESSION_B64 is set in Render env, DELETE it (the old session is dead).\n` +
                    `   2. Restart the service and enter the new pairing code within ~2 minutes.\n`
                );
                await notifyTelegram(`⚠️ WhatsApp session ended (${statusCode}). Re-pairing required — check Render logs for a new pairing code.`);
                return;
            }
            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('🔴 Session was opened on another device. Close the other session and restart this service.');
                return;
            }

            // --- Rate-limited: back off HARD, and allow a fresh pairing request AFTER the wait ---
            if (statusCode === 428) {
                pairingRequestedAt = 0; // allow new pairing request after the backoff completes
                reconnectDelayMs = Math.min(reconnectDelayMs * 2 + Math.floor(Math.random() * 10_000), 30 * 60_000);
                log(`⏳ WhatsApp rate-limited us (428). Waiting ${Math.round(reconnectDelayMs / 1000)}s before retrying...`);
            } else if (statusCode === 515 || statusCode === 408 || !statusCode) {
                // restart required / timeout / unknown → normal retry
                reconnectDelayMs = 10_000;
                log(`🔄 Reconnecting in ${Math.round(reconnectDelayMs / 1000)}s...`);
            } else {
                reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
                log(`🔄 Reconnecting in ${Math.round(reconnectDelayMs / 1000)}s...`);
            }

            setTimeout(() => connectToWhatsApp().catch(err => console.error('Reconnect error:', err)), reconnectDelayMs);
        }
    });

    // Group ID sniffer
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (msg?.key?.remoteJid?.endsWith('@g.us')) {
                console.log(`\n🎯 GROUP ID FOUND!\nGroup ID: ${msg.key.remoteJid}\n`);
            }
        } catch (e) { /* ignore */ }
    });
}

// =============================================================================
// HTTP API (internal, used by main.py on localhost:3000)
// =============================================================================

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        connected: !!(sock && sock.ws && sock.ws.isOpen),
        registered: !!(creds && creds.registered),
    });
});

app.post('/send', async (req, res) => {
    const { to, body } = req.body || {};
    if (!sock || !sock.ws || !sock.ws.isOpen) {
        return res.status(503).json({ error: 'WhatsApp not connected yet.' });
    }
    if (!to || !body) {
        return res.status(400).json({ error: 'Missing "to" or "body".' });
    }
    try {
        const chatId = to.includes('@') ? to : `${to}@g.us`;
        await Promise.race([
            sock.sendMessage(chatId, { text: body }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('send timeout (15s)')), 15_000)),
        ]);
        res.status(200).json({ status: 'success' });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

// =============================================================================
// BOOT
// =============================================================================

if (SESSION_B64) {
    const restored = restoreSessionFromB64(SESSION_B64);
    log(restored ? '📂 Session restored from SESSION_B64.' : '⚠️ SESSION_B64 set but could not be restored.');
}

connectToWhatsApp().catch(err => console.error('Startup error:', err));

app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));

process.on('unhandledRejection', (err) => {
    console.error('[NODE] Unhandled rejection (ignored, connection loop continues):', err?.message || err);
});
