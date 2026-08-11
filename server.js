import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';   // <-- add this line
console.log("🔄 Starting Baileys Node.js Service...");

const app = express();
app.use(express.json());

const PORT = 3000;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Goethe Watchtower", "Chrome", "20.0.04"]
    });

    // Listen to connection updates to request pairing code at the right moment
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            // Socket is ready – request pairing code if not already registered
            if (!sock.authState.creds.registered && PHONE_NUMBER) {
                console.log(`Requesting pairing code for ${PHONE_NUMBER}...`);
                try {
                    const code = await sock.requestPairingCode(PHONE_NUMBER);
                    console.log(`\n=========================================================`);
                    console.log(`🚨 ACTION REQUIRED: WHATSAPP PAIRING CODE`);
                    console.log(`1. Go to WhatsApp > Linked Devices > Link a device.`);
                    console.log(`2. Tap 'Link with phone number instead'.`);
                    console.log(`3. Enter this code: ${code}`);
                    console.log(`=========================================================\n`);
                } catch (err) {
                    console.error("🔴 Failed to request pairing code:", err.message);
                }
            }
        } else if (connection === 'open') {
            console.log('✅ Baileys WhatsApp Gateway is connected!');
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Status code: ${statusCode}`);

            // If logged out (401), don't reconnect – manual re-pair needed
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out. Please restart the service to pair again.');
                return;
            }

            // For other disconnects, attempt reconnection
            console.log('Attempting to reconnect in 5 seconds...');
            setTimeout(() => {
                connectToWhatsApp().catch(err => console.error('Reconnect error:', err));
            }, 5000);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Temporary listener to capture group ID
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.remoteJid.endsWith('@g.us')) {
            console.log(`\n🎯 GROUP ID FOUND!`);
            console.log(`Group ID: ${msg.key.remoteJid}\n`);
        }
    });
}

// Express endpoint to send messages
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

// Start the connection and the Express server
connectToWhatsApp().catch(err => console.error('Initial connection error:', err));
app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));
