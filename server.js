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

// Armazenamento em memória de chats e mensagens
const chatsMap = new Map();
const messagesMap = new Map();

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
            console.log('WhatsApp conectado com sucesso!');
            connectionStatus = 'connected';
            currentQrCode = null;
            phoneNumber = sock.user.id.split(':')[0];
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.includes('@g.us')) return;

            // Ignora pacotes de protocolo / sincronização interna do Baileys
            if (
                msg.message.protocolMessage || 
                msg.message.senderKeyDistributionMessage ||
                msg.message.reactionMessage ||
                msg.message.pollUpdateMessage ||
                msg.message.keepAliveMessage
            ) {
                return;
            }

            let text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message.imageMessage?.caption ||
                       (msg.message.documentMessage ? `📄 ${msg.message.documentMessage.fileName || 'Documento'}` : null) ||
                       (msg.message.imageMessage ? '📷 Foto' : null) ||
                       (msg.message.audioMessage ? '🎵 Áudio' : null) ||
                       (msg.message.videoMessage ? '🎥 Vídeo' : null);

            if (!text || text.trim() === '') return;
            
            const fromMe = Boolean(msg.key.fromMe);
            const pushName = msg.pushName || jid.split('@')[0];
            const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

            const messageObj = {
                id: msg.key.id,
                text,
                fromMe,
                timestamp,
                status: fromMe ? 'SENT' : 'RECEIVED'
            };

            // Salva na lista de mensagens do chat
            if (!messagesMap.has(jid)) {
                messagesMap.set(jid, []);
            }
            const chatMessages = messagesMap.get(jid);
            
            // Evita duplicatas pelo ID da mensagem
            if (!chatMessages.some(existing => existing.id === msg.key.id)) {
                chatMessages.push(messageObj);
                if (chatMessages.length > 100) chatMessages.shift();
            }

            // Atualiza resumo do chat
            const prevChat = chatsMap.get(jid) || { unreadCount: 0 };
            chatsMap.set(jid, {
                id: jid,
                name: pushName,
                phoneNumber: jid.split('@')[0],
                lastMessage: text,
                timestamp,
                unreadCount: fromMe ? 0 : (prevChat.unreadCount + 1)
            });

        } catch (e) {
            console.error('Erro ao processar mensagem recebida:', e);
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

app.get('/api/whatsapp/chats', (req, res) => {
    const list = Array.from(chatsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
});

app.get('/api/whatsapp/messages', (req, res) => {
    const jid = req.query.jid;
    if (!jid) {
        return res.status(400).json({ error: 'Parâmetro jid é obrigatório.' });
    }
    const list = messagesMap.get(jid) || [];
    
    // Zera contagem de não lidas ao abrir o chat
    const chat = chatsMap.get(jid);
    if (chat) {
        chat.unreadCount = 0;
    }

    res.json(list);
});

app.post('/api/whatsapp/send-message', async (req, res) => {
    try {
        const { to, message, documentUrl, documentName } = req.body;
        if (!to || (!message && !documentUrl)) {
            return res.status(400).json({ error: 'Destinatário (to) e mensagem/documento são obrigatórios.' });
        }

        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não está conectado.' });
        }

        let cleanNumber = to.replace(/\D/g, '');
        if (!cleanNumber.startsWith('55') && cleanNumber.length <= 11) {
            cleanNumber = '55' + cleanNumber;
        }
        const jid = cleanNumber + '@s.whatsapp.net';

        let sentMsg;
        if (documentUrl) {
            sentMsg = await sock.sendMessage(jid, {
                document: { url: documentUrl },
                mimetype: 'application/pdf',
                fileName: documentName || 'Documento-Clinica.pdf',
                caption: message || ''
            });
        } else {
            sentMsg = await sock.sendMessage(jid, { text: message });
        }

        // Salva na memória
        const timestamp = Date.now();
        const msgObj = {
            id: sentMsg.key.id,
            text: message || (documentName ? `📄 ${documentName}` : '[Documento]'),
            fromMe: true,
            timestamp,
            status: 'SENT'
        };

        if (!messagesMap.has(jid)) messagesMap.set(jid, []);
        messagesMap.get(jid).push(msgObj);

        chatsMap.set(jid, {
            id: jid,
            name: cleanNumber,
            phoneNumber: cleanNumber,
            lastMessage: msgObj.text,
            timestamp,
            unreadCount: 0
        });

        res.json({ success: true, messageId: sentMsg.key.id });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ error: 'Erro ao disparar mensagem no WhatsApp: ' + err.message });
    }
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
