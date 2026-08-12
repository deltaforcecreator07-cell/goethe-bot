// server.js — Goethe Watchtower WhatsApp Gateway (FIXED v3)
//
// v3 changes:
// - A pairing code, once issued, stays valid across reconnects: no new code
//   is requested until the cooldown expires (10 min), so you can never have
//   a code invalidated by a reconnect again.
// - Pairing cooldown is persisted to disk, so even a RESTART of the service
//   won't immediately re-request a code (prevents self-inflicted rate limits).
// - Optional PROXY_URL env var (Plan C): route the WhatsApp WebSocket through
//   a residential/mobile proxy if WhatsApp blocks Render's datacenter IP.
// - 401/403/440 are terminal (no reconnect spam) with clear re-pair guidance.

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
import { HttpsProxyAgent } from 'https-proxy-agent';

console.log('🔄 Starting Baileys Node.js Service (fixed v3)...');

const app = express();
app.use(express.json());

const PORT = 3000;
const AUTH_DIR = 'auth_info_baileys';
const STATE_FILE = path.join(AUTH_DIR, '..', 'pairing_state.json');

const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const SESSION_B64 = process.env.SESSION_B64 || '';
const PROXY_URL = process.env.PROXY_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const PAIRING_COOLDOWN_MS = 10 * 60_000; // WhatsApp rate-limits pairing-code requests

// ---- state ----
let sock = null;
let creds = null;
let reconnectDelayMs = 10_000;
let sessionSnapshotFingerprint = '';
let lastSessionExportAt = 0;
let lastLogTime = 0;

// =============================================================================
// PERSISTED PAIRING COOLDOWN (survives restarts)
// =============================================================================

function loadPairingRequestedAt() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).requestedAt || 0;
        }
    } catch (e) { /* ignore */ }
    return 0;
}

function savePairingRequestedAt(ts) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ requestedAt: ts }));
    } catch (e) { /* ignore */ }
}

let pairingRequestedAt = loadPairingRequestedAt();

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
// PAIRING — one code per 10 min, code stays valid across reconnects
// =============================================================================

async function tryRequestPairingCode() {
    if (!PHONE_NUMBER) {
        logThrottled('⚠️ PHONE_NUMBER env var not set — cannot pair. Set it in Render → Environment.');
        return;
    }
    if (creds && creds.registered) return; // already paired — never request codes

    const elapsed = Date.now() - pairingRequestedAt;
    if (elapsed < PAIRING_COOLDOWN_MS) {
        const mins = Math.max(1, Math.ceil((PAIRING_COOLDOWN_MS - elapsed) / 60_000));
        logThrottled(
            `⏳ A pairing code was already requested ${Math.floor(elapsed / 60_000)}m ago. ` +
            `The SAME code is still valid — enter it in WhatsApp. ` +
            `A new code is only issued after the ${mins} min cooldown.`,
            60_000
        );
        return;
    }

    pairingRequestedAt = Date.now(); // BEFORE the request — even failures cool down
    savePairingRequestedAt(pairingRequestedAt);
    try {
        log(`Requesting pairing code for ${PHONE_NUMBER}...`);
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        const msg =
            `\n=========================================================\n` +
            `🚨 PAIRING CODE: ${code}\n` +
            `1. Open WhatsApp on your phone → Settings → Linked Devices → Link a device\n` +
            `2. Tap "Link with phone number instead"\n` +
            `3. Enter this code: ${code}\n` +
            `4. IMPORTANT: this code stays valid for the next 10 minutes — even if the\n` +
            `   socket reconnects, no new code will be issued before then.\n` +
            `=========================================================\n`;
        console.log(msg);
        await notifyTelegram(`🔑 Goethe Watchtower pairing code:\n\n${code}\n\nEnter it in WhatsApp → Linked Devices → Link with phone number instead.\nValid ~10 minutes.`);
    } catch (err) {
        console.error(`🔴 Failed to request pairing code: ${err.message}`);
        // cooldown stays active — we will NOT hammer WhatsApp again for 10 min
    }
}

// =============================================================================
// WHATSAPP CONNECTION
// =============================================================================

async function connectToWhatsApp() {
    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
        version = [2, 3000, 1043857760]; // fallback if the version endpoint is blocked
        log(`⚠️ Could not fetch latest version (${e.message}), using fallback ${version.join('.')}`);
    }
    log(`Using WhatsApp Web version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    creds = state.creds;

    if (creds.registered) {
        log(`📂 Session loaded (already paired as ${creds.me?.id || PHONE_NUMBER}). Connecting without pairing...`);
    }

    // Optional proxy (Plan C): PROXY_URL=http://user:pass@host:port
    const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
    if (agent) log(`🌐 Using proxy for WhatsApp connection: ${PROXY_URL.replace(/\/\/.*@/, '//***@')}`);

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
        agent, // passed through to the WebSocket client
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
            tryRequestPairingCode(); // safe: rate-limited + cooldown-protected
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
                    `   2. Verify PHONE_NUMBER is the number linked to the WhatsApp app on your phone.\n` +
                    `   3. PAIR FROM HOME (see README): run "node pair-local.mjs" on your own\n` +
                    `      WiFi/hotspot — WhatsApp often blocks pairing from cloud IPs like Render's.\n` +
                    `   4. Paste the saved session into SESSION_B64 and redeploy.\n`
                );
                await notifyTelegram(`⚠️ WhatsApp session ended (${statusCode}). Re-pairing required — see Render logs / README.`);
                return;
            }
            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('🔴 Session was opened on another device. Close the other session and restart this service.');
                return;
            }

            // --- Rate-limited: back off HARD. The current pairing code REMAINS valid ---
            if (statusCode === 428) {
                // Do NOT reset pairingRequestedAt here: the code already issued
                // stays valid until the 10-min cooldown passes.
                reconnectDelayMs = Math.min(reconnectDelayMs * 2 + Math.floor(Math.random() * 10_000), 30 * 60_000);
                log(`⏳ WhatsApp rate-limited us (428). Waiting ${Math.round(reconnectDelayMs / 1000)}s before retrying...`);
                log(`   The pairing code from before is STILL valid — enter it in WhatsApp now if you haven't.`);
            } else if (statusCode === 515 || statusCode === 408 || !statusCode) {
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

if (pairingRequestedAt > 0) {
    const minsAgo = Math.floor((Date.now() - pairingRequestedAt) / 60_000);
    log(`⏳ Pairing cooldown restored from previous run (last request ${minsAgo}m ago). No new code until it expires.`);
}

connectToWhatsApp().catch(err => console.error('Startup error:', err));

app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));

process.on('unhandledRejection', (err) => {
    console.error('[NODE] Unhandled rejection (ignored, connection loop continues):', err?.message || err);
});
