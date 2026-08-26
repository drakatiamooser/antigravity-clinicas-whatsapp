const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Middleware de Autenticação Segura
app.use('/api', (req, res, next) => {
    const authHeader = req.headers.authorization;
    const secret = process.env.API_SECRET || "antigravity-secure-wapi-7742"; // Fallback caso a secret falhe no deploy
    
    if (!authHeader || authHeader !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Acesso Negado. Chave de API inválida." });
    }
    next();
});

let sock;
let currentQrCode = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQrCode = await QRCode.toDataURL(qr);
            connectionStatus = 'qrcode';
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            phoneNumber = null;
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log('WhatsApp conectado!');
            connectionStatus = 'connected';
            currentQrCode = null;
            phoneNumber = sock.user.id.split(':')[0];
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Inicia a primeira tentativa de conexão
connectToWhatsApp();

app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: currentQrCode,
        number: phoneNumber
    });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    if (sock) {
        sock.logout();
        res.json({ success: true, message: 'Desconectado.' });
    } else {
        res.json({ success: false, message: 'Nenhuma instância rodando.' });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`WhatsApp Server rodando na porta ${PORT}`);
});
