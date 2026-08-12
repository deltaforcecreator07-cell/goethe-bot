import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

import express from 'express';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import pino from 'pino';

console.log("🔄 Starting Baileys Node.js Service...");

const app = express();
app.use(express.json());

const PORT = 3000;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''); // trim & clean

let sock;

async function connectToWhatsApp() {
    // Fetch the correct version dynamically (avoid mismatch)
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp Web version: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'info' }), // show info for now (to see errors)
        browser: ["Goethe Watchtower", "Chrome", "20.0.04"],
        version
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            console.log('🟡 Socket connecting...');
            // Only request pairing code if not already registered
            if (!sock.authState.creds.registered) {
                if (!PHONE_NUMBER) {
                    console.error('🔴 PHONE_NUMBER is empty! Set it in Render env.');
                    return;
                }
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
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Status: ${statusCode}`);
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🔴 Logged out. You’ll need to restart the service to pair again.');
            } else {
                // Reconnect after a delay for non-fatal disconnects
                console.log('🔄 Reconnecting in 10 seconds…');
                setTimeout(() => connectToWhatsApp(), 10_000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Group ID sniffer
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

// Start everything
connectToWhatsApp().catch(err => console.error('Startup error:', err));
app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));
