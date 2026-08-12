import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';

const app = express();
app.use(express.json());

const PORT = 3000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;
let sock;
let pairingCodeRequested = false;   // guard to request pairing code only once

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Goethe Watchtower", "Chrome", "20.0.04"]
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            // Request pairing code only if not yet registered AND not already requested
            if (!sock.authState.creds.registered && PHONE_NUMBER && !pairingCodeRequested) {
                pairingCodeRequested = true;
                console.log(`Requesting pairing code for ${PHONE_NUMBER}...`);
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n=========================================================`);
                    console.log(`🚨 PAIRING CODE: ${code}`);
                    console.log(`1. WhatsApp > Linked Devices > Link a device`);
                    console.log(`2. Tap 'Link with phone number instead'`);
                    console.log(`3. Enter this code: ${code}`);
                    console.log(`=========================================================\n`);
                } catch (err) {
                    console.error("❌ Pairing code request failed:", err.message);
                    pairingCodeRequested = false;   // allow retry on next reconnect
                }
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Gateway connected!');
            pairingCodeRequested = false;   // reset for future reconnections (unlikely)
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (code ${statusCode})`);

            // Terminal logout – stop reconnecting
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🔴 Logged out. Restart service to pair again.');
                return;
            }

            // Reconnect after a short delay
            console.log('Reconnecting in 5s...');
            setTimeout(() => connectToWhatsApp().catch(e => console.error(e)), 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Group ID capture (temporary)
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.remoteJid.endsWith('@g.us')) {
            console.log(`\n🎯 GROUP ID FOUND: ${msg.key.remoteJid}\n`);
        }
    });
}

app.post('/send', async (req, res) => {
    const { to, body } = req.body;
    if (!sock) return res.status(500).json({ error: 'Socket not ready' });
    try {
        const chatId = to.includes('@g.us') ? to : `${to}@g.us`;
        await sock.sendMessage(chatId, { text: body });
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ error: err.toString() });
    }
});

// Optional endpoint to update WA_GROUP_ID without redeploy
app.post('/set-group', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });
    process.env.WA_GROUP_ID = groupId;
    console.log(`WA_GROUP_ID set to ${groupId}`);
    res.json({ status: 'ok', groupId });
});

connectToWhatsApp().catch(e => console.error('Startup error:', e));
app.listen(PORT, () => console.log(`WA Gateway on port ${PORT}`));
