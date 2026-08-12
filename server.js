// server.js — Goethe Watchtower WhatsApp Gateway
// Connection logic aligned with QuickCart AI for Render compatibility.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

import express from 'express';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';

console.log('🔄 Starting Baileys Node.js Service...');

const app = express();
app.use(express.json());

const PORT = 3000;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');

let sock;
let isTerminated = false; // prevents reconnection after fatal errors

async function connectToWhatsApp() {
    if (isTerminated) return;

    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],   // ← Critical for Render
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 120000,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            console.log('🟡 Socket connecting...');
            if (!sock.authState.creds.registered && PHONE_NUMBER) {
                try {
                    console.log(`Requesting pairing code for ${PHONE_NUMBER}...`);
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n=========================================================`);
                    console.log(`🚨 PAIRING CODE: ${code}`);
                    console.log(`1. WhatsApp > Linked Devices > Link a device`);
                    console.log(`2. Tap 'Link with phone number instead'`);
                    console.log(`3. Enter this code: ${code}`);
                    console.log(`=========================================================\n`);
                } catch (err) {
                    console.error('🔴 Failed to request pairing code:', err.message);
                }
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected!');
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Status: ${statusCode}`);

            if (
                statusCode === DisconnectReason.loggedOut ||
                statusCode === DisconnectReason.conflict ||
                statusCode === 440
            ) {
                console.log('🔴 Session terminated. You must re‑pair by restarting the service.');
                isTerminated = true;
                return;
            }

            console.log('🔄 Reconnecting in 10 seconds…');
            setTimeout(connectToWhatsApp, 10_000);
        }
    });

    // Group ID sniffer
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.remoteJid.endsWith('@g.us')) {
            console.log(`\n🎯 GROUP ID FOUND!`);
            console.log(`Group ID: ${msg.key.remoteJid}\n`);
        }
    });
}

app.post('/send', async (req, res) => {
    const { to, body } = req.body;
    if (!sock) return res.status(500).json({ error: 'Socket not ready.' });

    try {
        const chatId = to.includes('@g.us') ? to : `${to}@g.us`;
        await sock.sendMessage(chatId, { text: body });
        res.status(200).json({ status: 'success' });
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

connectToWhatsApp().catch(err => console.error('Startup error:', err));
app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));
