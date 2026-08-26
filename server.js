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

// Armazenamento em memória e persistência em disco de chats e mensagens
const STORE_FILE = './chats_store.json';
let chatsMap = new Map();
let messagesMap = new Map();
const contactsMap = new Map();
const profilePicsMap = new Map();
const groupsMetadataMap = new Map();

// Determina tipo de chat pelo JID
function getChatType(jid) {
    if (!jid) return 'user';
    if (jid.endsWith('@g.us')) return 'group';
    if (jid.endsWith('@newsletter')) return 'channel';
    return 'user';
}

// Carrega store do disco se existir
try {
    if (fs.existsSync(STORE_FILE)) {
        const raw = fs.readFileSync(STORE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.chats) {
            chatsMap = new Map(parsed.chats.map(c => [c.id, c]));
        }
        if (parsed.messages) {
            messagesMap = new Map(Object.entries(parsed.messages));
        }
        console.log(`Carregado store do disco: ${chatsMap.size} conversas.`);
    }
} catch (e) {
    console.error('Erro ao ler chats_store.json:', e);
}

// Salva store no disco
function saveStoreToDisk() {
    try {
        const chats = Array.from(chatsMap.values());
        const messages = Object.fromEntries(messagesMap.entries());
        fs.writeFileSync(STORE_FILE, JSON.stringify({ chats, messages }, null, 2));
    } catch (e) {
        console.error('Erro ao salvar chats_store.json:', e);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        syncFullHistory: true
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

    // 1. Sincronização de Contatos da Agenda do Celular
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id) {
                const name = c.name || c.notify || c.verifiedName || null;
                if (name) contactsMap.set(c.id, name);
            }
        }
    });

    // 2. Sincronização Inicial Completa do Histórico do WhatsApp (messaging-history.set)
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        console.log(`[Histórico] Sincronizando: ${chats?.length || 0} conversas e ${messages?.length || 0} mensagens.`);

        if (contacts) {
            for (const c of contacts) {
                if (c.id) {
                    const name = c.name || c.notify || c.verifiedName || null;
                    if (name) contactsMap.set(c.id, name);
                }
            }
        }

        if (messages) {
            for (const msg of messages) {
                const jid = msg.key?.remoteJid;
                if (!jid || jid === 'status@broadcast') continue;

                const text = msg.message?.conversation || 
                             msg.message?.extendedTextMessage?.text || 
                             msg.message?.imageMessage?.caption ||
                             (msg.message?.documentMessage ? `📄 ${msg.message.documentMessage.fileName || 'Documento'}` : null) ||
                             (msg.message?.imageMessage ? '📷 Foto' : null) ||
                             (msg.message?.audioMessage ? '🎵 Áudio' : null);

                if (!text) continue;

                const fromMe = Boolean(msg.key.fromMe);
                const type = getChatType(jid);
                const pushName = msg.pushName || contactsMap.get(jid) || (type === 'group' ? 'Grupo WhatsApp' : jid.split('@')[0]);
                const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

                const messageObj = {
                    id: msg.key.id,
                    text,
                    fromMe,
                    timestamp,
                    status: fromMe ? 'SENT' : 'RECEIVED'
                };

                if (!messagesMap.has(jid)) messagesMap.set(jid, []);
                const chatMessages = messagesMap.get(jid);
                if (!chatMessages.some(m => m.id === messageObj.id)) {
                    chatMessages.push(messageObj);
                }

                // Atualiza resumo da conversa
                const existing = chatsMap.get(jid);
                if (!existing || timestamp >= existing.timestamp) {
                    chatsMap.set(jid, {
                        id: jid,
                        name: pushName,
                        phoneNumber: jid.split('@')[0],
                        type,
                        lastMessage: text,
                        timestamp,
                        unreadCount: existing ? existing.unreadCount : 0
                    });
                }
            }
        }

        if (chats) {
            for (const chat of chats) {
                const jid = chat.id;
                if (!jid || jid === 'status@broadcast') continue;

                const type = getChatType(jid);
                if (!chatsMap.has(jid)) {
                    const name = chat.name || contactsMap.get(jid) || (type === 'group' ? 'Grupo WhatsApp' : (type === 'channel' ? 'Canal' : jid.split('@')[0]));
                    const timestamp = chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : Date.now();
                    chatsMap.set(jid, {
                        id: jid,
                        name,
                        phoneNumber: jid.split('@')[0],
                        type,
                        lastMessage: "Conversa sincronizada",
                        timestamp,
                        unreadCount: chat.unreadCount || 0
                    });
                }
            }
        }

        saveStoreToDisk();
    });

    // 3. Novas Conversas e Atualizações em Tempo Real (chats.upsert & chats.update)
    sock.ev.on('chats.upsert', (newChats) => {
        for (const chat of newChats) {
            const jid = chat.id;
            if (!jid || jid === 'status@broadcast') continue;
            
            const type = getChatType(jid);
            const prev = chatsMap.get(jid) || {};
            const name = chat.name || prev.name || contactsMap.get(jid) || (type === 'group' ? 'Grupo' : jid.split('@')[0]);
            const timestamp = chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : (prev.timestamp || Date.now());

            chatsMap.set(jid, {
                id: jid,
                name,
                phoneNumber: jid.split('@')[0],
                type,
                lastMessage: prev.lastMessage || "Conversa ativa",
                timestamp,
                unreadCount: chat.unreadCount !== undefined ? chat.unreadCount : (prev.unreadCount || 0)
            });
        }
        saveStoreToDisk();
    });

    // 4. Mensagens Recebidas e Enviadas (messages.upsert)
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast') return;

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
            const type = getChatType(jid);
            const pushName = msg.pushName || contactsMap.get(jid) || (type === 'group' ? 'Grupo' : jid.split('@')[0]);
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
                type,
                lastMessage: text,
                timestamp,
                unreadCount: fromMe ? 0 : (prevChat.unreadCount + 1)
            });

            saveStoreToDisk();

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

// Endpoint para buscar Foto de Perfil do Contato ou Grupo
app.get('/api/whatsapp/avatar', async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'JID obrigatório' });

    if (profilePicsMap.has(jid)) {
        return res.json({ url: profilePicsMap.get(jid) });
    }

    try {
        if (sock && connectionStatus === 'connected') {
            const url = await sock.profilePictureUrl(jid, 'preview').catch(() => null);
            profilePicsMap.set(jid, url || null);
            return res.json({ url: url || null });
        }
    } catch (e) {}

    res.json({ url: null });
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
        let jid = to;
        if (!to.includes('@')) {
            if (!cleanNumber.startsWith('55') && cleanNumber.length <= 11) {
                cleanNumber = '55' + cleanNumber;
            }
            jid = cleanNumber + '@s.whatsapp.net';
        }

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
            type: getChatType(jid),
            lastMessage: msgObj.text,
            timestamp,
            unreadCount: 0
        });

        saveStoreToDisk();

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
