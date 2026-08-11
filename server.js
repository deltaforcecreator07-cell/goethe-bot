import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';

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

    if (!sock.authState.creds.registered) {
        if (!PHONE_NUMBER) {
            console.error("🔴 ERROR: PHONE_NUMBER environment variable is not set!");
            return;
        }
        
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log(`\n=========================================================`);
                console.log(`🚨 ACTION REQUIRED: WHATSAPP PAIRING CODE`);
                console.log(`1. Go to WhatsApp > Linked Devices > Link a device.`);
                console.log(`2. Tap 'Link with phone number instead'.`);
                console.log(`3. Enter this code: ${code}`);
                console.log(`=========================================================\n`);
            } catch (err) {
                console.error("🔴 Failed to request pairing code:", err);
            }
        }, 3000); 
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Baileys WhatsApp Gateway is connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // TEMPORARY LISTENER TO SNIFF GROUP ID
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

connectToWhatsApp();
app.listen(PORT, () => console.log(`🚀 WA Gateway running on internal port ${PORT}`));
