const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

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
const STORE_FILE = path.join(__dirname, 'chats_store.json');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
let chatsMap = new Map();
let contactsMap = new Map();
let messagesMap = new Map(); // Para armazenar mensagens de cada chat

// === RESOLUÇÃO DE LIDs PARA NÚMEROS REAIS ===
let lidToPnMap = {};
function loadLidMappings() {
    try {
        const authPath = path.join(__dirname, 'auth_info_baileys');
        if (!fs.existsSync(authPath)) return;
        const files = fs.readdirSync(authPath);
        for (const file of files) {
            if (file.startsWith('lid-mapping-') && !file.includes('reverse')) {
                const pn = file.replace('lid-mapping-', '').replace('.json', '');
                const lidRaw = JSON.parse(fs.readFileSync(path.join(authPath, file)));
                const lidStr = typeof lidRaw === 'string' ? lidRaw : String(lidRaw);
                lidToPnMap[lidStr] = pn;
            }
        }
        console.log(`[LID Mapping] Foram carregados ${Object.keys(lidToPnMap).length} mapeamentos de LID para número real.`);
    } catch (e) {
        console.error("Erro ao carregar lid mappings:", e);
    }
}
loadLidMappings();
// ============================================

const profilePicsMap = new Map();
const groupsMetadataMap = new Map();

// Determina tipo de chat pelo JID
function getChatType(jid) {
    if (!jid) return 'user';
    if (jid.endsWith('@g.us')) return 'group';
    if (jid.endsWith('@newsletter')) return 'channel';
    if (jid.endsWith('@lid')) return 'user'; // Linked Identity JIDs (WhatsApp moderno)
    return 'user';
}

// Verifica se o nome atual é um fallback ou número que pode ser substituído
function isInvalidName(name, phone) {
    if (!name) return true;
    if (/^[\+\d\s\-\(\)∙\*\.\_]+$/.test(name)) return true; // Formato numérico / telefone / máscaras
    if (/^Contato \d{4}$/.test(name)) return true;   // Fallback interno
    if (phone && name === phone) return true;
    return false;
}

// Verifica se um JID é do tipo LID (opaco, sem número de telefone)
function isLidJid(jid) {
    return jid && jid.endsWith('@lid');
}

// Carrega store do disco se existir
try {
    if (fs.existsSync(STORE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'), (key, value) => {
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                return Buffer.from(value.data);
            }
            return value;
        });
        if (parsed.chats) {
            chatsMap = new Map(parsed.chats.map(c => [c.id, c]));
        }
        if (parsed.messages) {
            messagesMap = new Map(Object.entries(parsed.messages));
            for (const [jid, list] of messagesMap.entries()) {
                const isSelf = jid.includes('67375756001494') || jid.includes('555181026867');
                for (const m of list) {
                    // Mensagens legadas salvas antes da implementação com 'SENT' estático passam para 'READ'
                    if (m.fromMe && (m.status === 'SENT' || !m.status || isSelf)) {
                        m.status = 'READ';
                    }
                    // Auto-preenchimento de mediaDetails para documentos existentes
                    if (m.hasMedia && m.mediaType === 'document' && !m.mediaDetails && m.rawMsg?.message) {
                        const doc = m.rawMsg.message.documentMessage || m.rawMsg.message.documentWithCaptionMessage?.message?.documentMessage;
                        if (doc) {
                            const thumb = doc.jpegThumbnail ? (typeof doc.jpegThumbnail === 'string' ? doc.jpegThumbnail : Buffer.from(doc.jpegThumbnail).toString('base64')) : null;
                            m.mediaDetails = {
                                fileName: doc.fileName || doc.title || 'Documento.pdf',
                                fileLength: Number(doc.fileLength || 0),
                                pageCount: doc.pageCount || null,
                                mimetype: doc.mimetype || 'application/pdf',
                                jpegThumbnail: thumb
                            };
                        }
                    }
                }
            }
        }
        if (parsed.contacts) {
            for (const [k, v] of Object.entries(parsed.contacts)) {
                contactsMap.set(k, v);
            }
        }
        
        // Auto-healing de nomes inválidos e sincronização de status no chatsMap
        for (const [jid, chat] of chatsMap.entries()) {
            const cleanJid = jid.replace(/:.*@/, '@');
            if (isInvalidName(chat.name, chat.phoneNumber)) {
                const contactName = contactsMap.get(jid) || contactsMap.get(cleanJid);
                if (contactName && !isInvalidName(contactName)) {
                    chat.name = contactName;
                }
            }

            const msgs = messagesMap.get(jid) || messagesMap.get(cleanJid);
            if (msgs && msgs.length > 0) {
                const lastM = msgs[msgs.length - 1];
                chat.lastMessageFromMe = lastM.fromMe;
                chat.lastMessageStatus = lastM.status;
                chat.lastMessage = lastM.text;
            }
        }
        
        console.log(`Carregado store do disco: ${chatsMap.size} conversas, ${contactsMap.size} contatos.`);
    }
} catch (e) {
    console.error('Erro ao ler chats_store.json:', e);
}

// Salva store no disco
function saveStoreToDisk() {
    try {
        const chats = Array.from(chatsMap.values());
        const messages = Object.fromEntries(messagesMap.entries());
        const contacts = Object.fromEntries(contactsMap.entries());
        fs.writeFileSync(STORE_FILE, JSON.stringify({ chats, messages, contacts }, null, 2));
    } catch (e) {
        console.error('Erro ao salvar chats_store.json:', e);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'info' }),
        browser: ['Windows', 'Chrome', '10.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('QR CODE GERADO:', qr);
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
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                if (fs.existsSync(STORE_FILE)) {
                    fs.unlinkSync(STORE_FILE);
                }
                chatsMap.clear();
                messagesMap.clear();
                contactsMap.clear();
                sock = null;
                
                // Inicia um novo socket limpo para gerar QR Code
                setTimeout(() => {
                    connectToWhatsApp();
                }, 2000);
            }
        } else if (connection === 'open') {
            console.log('WhatsApp conectado com sucesso!');
            connectionStatus = 'connected';
            currentQrCode = null;
            phoneNumber = sock.user.id.split(':')[0];
        }
    });

    // 1. Sincronização de Contatos da Agenda do Celular
    const updateContact = (c) => {
        if (!c || !c.id) return;
        const name = c.name || c.notify || c.verifiedName || null;
        if (name) {
            contactsMap.set(c.id, name);
            const cleanId = c.id.replace(/:.*@/, '@');
            contactsMap.set(cleanId, name);
            const phone = c.id.split('@')[0].split(':')[0];
            if (phone) contactsMap.set(phone, name);

            // Atualiza o chat existente se ele tiver apenas o número como nome
            if (chatsMap.has(c.id)) {
                const ch = chatsMap.get(c.id);
                if (isInvalidName(ch.name, ch.phoneNumber)) {
                    ch.name = name;
                }
            }
            if (chatsMap.has(cleanId)) {
                const ch = chatsMap.get(cleanId);
                if (isInvalidName(ch.name, ch.phoneNumber)) {
                    ch.name = name;
                }
            }
        }
    };

    sock.ev.on('contacts.upsert', (contacts) => {
        if (!contacts || !Array.isArray(contacts)) return;
        for (const c of contacts) {
            updateContact(c);
        }
        saveStoreToDisk();
    });

    sock.ev.on('contacts.update', (updates) => {
        if (!updates || !Array.isArray(updates)) return;
        for (const c of updates) {
            updateContact(c);
        }
        saveStoreToDisk();
    });

    // Helper universal para extrair texto e tipo de qualquer mensagem do WhatsApp
    function extractMessageContent(msg) {
        if (!msg || !msg.message) return null;
        let m = msg.message;
        
        // Desempacota estruturas aninhadas do WhatsApp (efêmeras, visualização única, etc.)
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
        if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

        if (!m) return null;

        if (m.conversation) return m.conversation;
        if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
        if (m.imageMessage?.caption) return m.imageMessage.caption;
        if (m.imageMessage) return "📷 Foto";
        if (m.videoMessage?.caption) return m.videoMessage.caption;
        if (m.videoMessage) return "🎥 Vídeo";
        if (m.audioMessage) return "🎵 Áudio";
        if (m.documentMessage) return `📄 ${m.documentMessage.fileName || 'Documento'}`;
        if (m.stickerMessage) return "🎨 Figurinha";
        if (m.contactMessage) return `👤 Contato: ${m.contactMessage.displayName || ''}`;
        if (m.contactsArrayMessage) return "👥 Contatos";
        if (m.locationMessage) return "📍 Localização";
        if (m.liveLocationMessage) return "📍 Localização em tempo real";
        if (m.pollCreationMessage) return `📊 Enquete: ${m.pollCreationMessage.name || ''}`;
        if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
        if (m.listResponseMessage?.title) return m.listResponseMessage.title;
        if (m.templateButtonReplyMessage?.selectedDisplayText) return m.templateButtonReplyMessage.selectedDisplayText;
        
        // Fallback for unknown message types
        const type = Object.keys(m)[0];
        if (type && type !== 'messageContextInfo') {
            return `[Mensagem: ${type}]`;
        }
        
        return "Mensagem Suportada Parcialmente";
    }

    // Processador universal de mensagem
    function processMessage(msg) {
        if (!msg || !msg.message) return;
        const jid = msg.key?.remoteJid;
        if (!jid || jid === 'status@broadcast') return;

        if (
            msg.message.protocolMessage || 
            msg.message.senderKeyDistributionMessage ||
            msg.message.reactionMessage ||
            msg.message.keepAliveMessage ||
            msg.message.historySyncNotification
        ) {
            return;
        }

        const text = extractMessageContent(msg);
        if (!text || text.trim() === '') return;

        const fromMe = Boolean(msg.key.fromMe);
        const type = getChatType(jid);
        
        // Salva pushName no contactsMap (muito importante para @lid)
        if (msg.pushName && !fromMe) {
            const existingName = contactsMap.get(jid);
            if (isInvalidName(existingName)) {
                contactsMap.set(jid, msg.pushName);
            }
        }
        
        const contactName = contactsMap.get(jid) || contactsMap.get(jid.replace(/:.*@/, '@'));
        const existingChat = chatsMap.get(jid) || { unreadCount: 0 };
        
        // Resolução de nome com prioridade: nome já salvo (se válido) > contato > pushName > fallback
        let resolvedName;
        if (existingChat.name && !isInvalidName(existingChat.name, existingChat.phoneNumber)) {
            resolvedName = existingChat.name;
        } else if (contactName && !isInvalidName(contactName)) {
            resolvedName = contactName;
        } else if (msg.pushName) {
            resolvedName = msg.pushName;
        } else if (existingChat.name) {
            resolvedName = existingChat.name;
        } else if (isLidJid(jid)) {
            resolvedName = `Contato ${jid.split('@')[0].slice(-4)}`;
        } else {
            resolvedName = type === 'group' ? 'Grupo' : (type === 'channel' ? 'Canal' : jid.split('@')[0]);
        }
        
        const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

        let hasMedia = false;
        let mediaType = null;
        let mediaDetails = null;
        let rawMsg = null;
        
        let m = msg.message;
        if (m) {
            if (m.ephemeralMessage) m = m.ephemeralMessage.message;
            if (m.viewOnceMessage) m = m.viewOnceMessage.message;
            if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
            if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
            
            if (m?.imageMessage) { hasMedia = true; mediaType = 'image'; rawMsg = msg; }
            else if (m?.videoMessage) { hasMedia = true; mediaType = 'video'; rawMsg = msg; }
            else if (m?.audioMessage) { hasMedia = true; mediaType = 'audio'; rawMsg = msg; }
            else if (m?.documentMessage) { 
                hasMedia = true; 
                mediaType = 'document'; 
                rawMsg = msg;
                const doc = m.documentMessage;
                const thumb = doc.jpegThumbnail ? (typeof doc.jpegThumbnail === 'string' ? doc.jpegThumbnail : Buffer.from(doc.jpegThumbnail).toString('base64')) : null;
                mediaDetails = {
                    fileName: doc.fileName || doc.title || 'Documento.pdf',
                    fileLength: Number(doc.fileLength || 0),
                    pageCount: doc.pageCount || null,
                    mimetype: doc.mimetype || 'application/pdf',
                    jpegThumbnail: thumb
                };
            }
            else if (m?.stickerMessage) { hasMedia = true; mediaType = 'sticker'; rawMsg = msg; }
        }

        let messageStatus = 'RECEIVED';
        if (fromMe) {
            const myPn = sock?.user?.id?.split(':')[0] || sock?.authState?.creds?.me?.id?.split(':')[0];
            const myLid = sock?.authState?.creds?.me?.lid?.split(':')[0];
            const isSelfChat = (myPn && (jid.includes(myPn) || jid.startsWith(myPn))) ||
                               (myLid && (jid.includes(myLid) || jid.startsWith(myLid))) ||
                               jid === '67375756001494@lid';

            if (isSelfChat) {
                messageStatus = 'READ';
            } else if (msg.userReceipt && Array.isArray(msg.userReceipt) && msg.userReceipt.length > 0) {
                const hasRead = msg.userReceipt.some(r => r.readTimestamp || r.playedTimestamp);
                const hasDelivered = msg.userReceipt.some(r => r.receiptTimestamp);
                if (hasRead) messageStatus = 'READ';
                else if (hasDelivered) messageStatus = 'DELIVERED';
                else messageStatus = 'SENT';
            } else if (msg.status === 4 || msg.status === 5 || msg.status === 'READ' || msg.status === 'PLAYED') {
                messageStatus = 'READ';
            } else if (msg.status === 3 || msg.status === 'DELIVERY_ACK') {
                messageStatus = 'DELIVERED';
            } else if (msg.status === 2 || msg.status === 'SERVER_ACK') {
                messageStatus = 'SENT';
            } else {
                messageStatus = 'SENT';
            }
        }

        const messageObj = {
            id: msg.key.id || `${jid}-${timestamp}`,
            text,
            fromMe,
            timestamp,
            status: messageStatus,
            hasMedia,
            mediaType,
            mediaDetails,
            rawMsg
        };

        if (!messagesMap.has(jid)) {
            messagesMap.set(jid, []);
        }
        const chatMessages = messagesMap.get(jid);
        const existingIdx = chatMessages.findIndex(existing => existing.id === messageObj.id);
        if (existingIdx >= 0) {
            // Atualiza status se for mais recente ou definido
            if (messageObj.status && messageObj.status !== 'PENDING') {
                chatMessages[existingIdx].status = messageObj.status;
            }
            if (messageObj.hasMedia) {
                chatMessages[existingIdx].hasMedia = true;
                chatMessages[existingIdx].mediaType = messageObj.mediaType;
                chatMessages[existingIdx].mediaDetails = messageObj.mediaDetails;
                chatMessages[existingIdx].rawMsg = messageObj.rawMsg;
            }
        } else {
            chatMessages.push(messageObj);
            chatMessages.sort((a, b) => a.timestamp - b.timestamp);
            if (chatMessages.length > 2000) chatMessages.shift();
        }

        // Atualiza o resumo do chat
        chatsMap.set(jid, {
            id: jid,
            name: resolvedName,
            phoneNumber: jid.split('@')[0],
            type,
            lastMessage: text,
            lastMessageFromMe: fromMe,
            lastMessageStatus: messageObj.status,
            timestamp: Math.max(timestamp, existingChat.timestamp || 0),
            unreadCount: fromMe ? 0 : (existingChat.unreadCount || 0)
        });
    }

    // 2. Sincronização Inicial Completa do Histórico do WhatsApp (messaging-history.set)
    sock.ev.on('messaging-history.set', async (payload) => {
        const { chats, contacts, messages, syncType } = payload;
        console.log("HISTORY SYNC KEYS:", Object.keys(payload));

        // Processa contatos PRIMEIRO para que os nomes estejam disponíveis para os chats
        if (contacts && Array.isArray(contacts)) {
            for (const c of contacts) {
                updateContact(c);
            }
        }

        if (messages && Array.isArray(messages)) {
            for (const msg of messages) {
                processMessage(msg);
            }
        }

        if (chats && Array.isArray(chats)) {
            for (const chat of chats) {
                const jid = chat.id;
                if (!jid || jid === 'status@broadcast') continue;

                const type = getChatType(jid);
                const existing = chatsMap.get(jid);
                const contactName = contactsMap.get(jid) || contactsMap.get(jid.replace(/:.*@/, '@'));
                
                // Resolução inteligente de nome: prioriza nome salvo > contato > pushName > nome do chat > número
                let name;
                if (existing?.name && !isInvalidName(existing.name, existing.phoneNumber)) {
                    name = existing.name;
                } else if (contactName && !isInvalidName(contactName)) {
                    name = contactName;
                } else if (chat.name && !isInvalidName(chat.name)) {
                    name = chat.name;
                } else if (existing?.name) {
                    name = existing.name;
                } else if (chat.name) {
                    name = chat.name;
                } else if (isLidJid(jid)) {
                    name = `Contato ${jid.split('@')[0].slice(-4)}`;
                } else if (type === 'group') {
                    name = 'Grupo';
                } else if (type === 'channel') {
                    name = 'Canal';
                } else {
                    name = jid.split('@')[0];
                }

                const timestamp = chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : (existing?.timestamp || Date.now());
                
                chatsMap.set(jid, {
                    id: jid,
                    name,
                    phoneNumber: jid.split('@')[0],
                    type,
                    lastMessage: existing?.lastMessage || "Conversa sincronizada",
                    timestamp,
                    unreadCount: chat.unreadCount ?? existing?.unreadCount ?? 0
                });
            }
        }

        saveStoreToDisk();
    });

    // 3. Novas Conversas e Atualizações em Tempo Real (chats.upsert & chats.update)
    sock.ev.on('chats.upsert', (newChats) => {
        if (!newChats || !Array.isArray(newChats)) return;
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

    sock.ev.on('chats.update', (updates) => {
        if (!updates || !Array.isArray(updates)) return;
        for (const update of updates) {
            const jid = update.id;
            if (!jid || !chatsMap.has(jid)) continue;
            const existing = chatsMap.get(jid);
            if (update.unreadCount !== undefined) existing.unreadCount = update.unreadCount;
            if (update.conversationTimestamp) existing.timestamp = Number(update.conversationTimestamp) * 1000;
            if (update.name) existing.name = update.name;
        }
        saveStoreToDisk();
    });

    // 4. Mensagens Recebidas e Enviadas (messages.upsert com processamento de TODOS os itens do lote)
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m || !m.messages || !Array.isArray(m.messages)) return;

            for (const msg of m.messages) {
                processMessage(msg);
            }

            saveStoreToDisk();
        } catch (e) {
            console.error('Erro ao processar mensagens upsert:', e);
        }
    });
    // 5. Atualização de status de mensagens (lida, entregue, reproduzida)
    const updateMessageStatus = (msgId, rawRemoteJid, statusNum) => {
        if (!msgId || statusNum === undefined) return false;
        
        let newStatus;
        if (statusNum === 4 || statusNum === 5 || statusNum === 'READ' || statusNum === 'PLAYED') newStatus = 'READ';
        else if (statusNum === 3 || statusNum === 'DELIVERY_ACK') newStatus = 'DELIVERED';
        else if (statusNum === 2 || statusNum === 'SERVER_ACK') newStatus = 'SENT';
        else return false;

        let target = null;
        if (rawRemoteJid) {
            const cleanJid = rawRemoteJid.replace(/:.*@/, '@');
            if (messagesMap.has(rawRemoteJid)) {
                target = messagesMap.get(rawRemoteJid).find(m => m.id === msgId);
            }
            if (!target && messagesMap.has(cleanJid)) {
                target = messagesMap.get(cleanJid).find(m => m.id === msgId);
            }
        }

        if (!target) {
            // Busca global em todos os chats pelo ID da mensagem
            for (const list of messagesMap.values()) {
                target = list.find(m => m.id === msgId);
                if (target) break;
            }
        }

        if (target && target.status !== newStatus) {
            target.status = newStatus;
            return true;
        }
        return false;
    };

    sock.ev.on('messages.update', (updates) => {
        if (!updates || !Array.isArray(updates)) return;
        let changed = false;
        for (const { key, update } of updates) {
            if (update && update.status !== undefined) {
                if (updateMessageStatus(key.id, key.remoteJid, update.status)) {
                    changed = true;
                }
            }
        }
        if (changed) saveStoreToDisk();
    });

    sock.ev.on('message-receipt.update', (receiptUpdates) => {
        if (!receiptUpdates || !Array.isArray(receiptUpdates)) return;
        let changed = false;
        for (const { key, receipt } of receiptUpdates) {
            const statusNum = receipt.readTimestamp ? 4 : (receipt.receiptTimestamp ? 3 : 2);
            if (updateMessageStatus(key.id, key.remoteJid, statusNum)) {
                changed = true;
            }
        }
        if (changed) saveStoreToDisk();
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
    const list = Array.from(chatsMap.values()).map(chat => {
        let name = chat.name;
        const cleanId = chat.id.replace(/:.*@/, '@');
        let phone = chat.phoneNumber || chat.id.split('@')[0].split(':')[0];
        let contactName = contactsMap.get(chat.id) || contactsMap.get(cleanId) || contactsMap.get(phone);

        let isLid = isLidJid(chat.id);
        let realPn = null;

        // 1. Sempre resolve o LID primeiro se possível
        if (isLid) {
            const lidNumber = chat.id.split('@')[0];
            realPn = lidToPnMap[lidNumber];
            if (realPn) {
                chat.phoneNumber = realPn;
                phone = realPn;
                const realJid = `${realPn}@s.whatsapp.net`;
                const realContactName = contactsMap.get(realJid);
                if (realContactName && !isInvalidName(realContactName)) {
                    contactName = realContactName;
                }
            }
        }

        // Caso especial: Conta Oficial do WhatsApp (0@s.whatsapp.net)
        if (chat.id === '0@s.whatsapp.net' || chat.phoneNumber === '0' || name === '0') {
            return {
                ...chat,
                id: '0@s.whatsapp.net',
                name: 'WhatsApp',
                phoneNumber: '0',
                type: 'business',
                isOfficial: true,
                isBusiness: true,
                lastMessage: (chat.lastMessage === 'Conversa sincronizada' || chat.lastMessage === 'Conversa ativa') 
                    ? 'Canal oficial de avisos e suporte do WhatsApp' 
                    : chat.lastMessage
            };
        }

        // Formatador de número para exibição bonita
        const formatPhoneNumber = (phoneStr) => {
            if (!phoneStr || !/^\d+$/.test(phoneStr)) return phoneStr;
            if (phoneStr.startsWith('55') && phoneStr.length === 12) {
                return `+55 ${phoneStr.slice(2, 4)} ${phoneStr.slice(4, 8)}-${phoneStr.slice(8)}`;
            } else if (phoneStr.startsWith('55') && phoneStr.length === 13) {
                return `+55 ${phoneStr.slice(2, 4)} ${phoneStr.slice(4, 9)}-${phoneStr.slice(9)}`;
            } else if (phoneStr.startsWith('55') && phoneStr.length === 11) {
                return `+55 ${phoneStr.slice(2, 4)} ${phoneStr.slice(4, 7)}-${phoneStr.slice(7)}`;
            }
            return `+${phoneStr}`;
        };

        // 2. Verifica se é um nome inválido que precisa de correção
        if (isInvalidName(name, phone)) {
            if (contactName && !isInvalidName(contactName)) {
                name = contactName;
            } else {
                if (isLid) {
                    if (realPn) {
                        name = formatPhoneNumber(realPn);
                    } else {
                        name = `Contato ${chat.id.split('@')[0].slice(-4)}`;
                    }
                } else if (chat.type === 'group') {
                    name = 'Grupo';
                } else if (chat.type === 'channel') {
                    name = 'Canal';
                } else {
                    name = formatPhoneNumber(phone);
                }
            }
        } else if (!isLid && chat.type === 'user' && /^\d+$/.test(name)) {
            // Se o nome é apenas dígitos, tenta formatar bonitinho
            name = formatPhoneNumber(name);
        }

        // Caso seja o próprio bot e o nome seja 'Você' ou não tenhamos resolvido bem
        if (chat.id === sock?.authState?.creds?.me?.id || (realPn && realPn === sock?.authState?.creds?.me?.id?.split(':')[0])) {
             if (isInvalidName(name, phone)) {
                 name = 'Meu Número (Sistema)';
             }
        }

        // Pega a última mensagem real armazenada para saber status e fromMe
        const msgs = messagesMap.get(chat.id) || messagesMap.get(cleanId);
        let lastMessageFromMe = chat.lastMessageFromMe !== undefined ? chat.lastMessageFromMe : false;
        let lastMessageStatus = chat.lastMessageStatus || null;
        let lastMessageText = chat.lastMessage;

        if (msgs && msgs.length > 0) {
            const lastM = msgs[msgs.length - 1];
            lastMessageFromMe = lastM.fromMe;
            lastMessageStatus = lastM.status;
            lastMessageText = lastM.text;
        }

        return {
            ...chat,
            name,
            lastMessage: lastMessageText,
            lastMessageFromMe,
            lastMessageStatus
        };
    }).sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
});

    app.get('/api/whatsapp/test-profile', async (req, res) => {
        const jid = req.query.jid;
        if (!jid) return res.status(400).json({ error: 'Falta jid' });
        try {
            const profile = await sock.getBusinessProfile(jid);
            res.json({ profile });
        } catch (e) {
            try {
                const contact = await sock.getContact(jid);
                res.json({ contact, errorProfile: e.message });
            } catch (e2) {
                res.status(500).json({ errorProfile: e.message, errorContact: e2.message });
            }
        }
    });

app.get('/api/whatsapp/messages', (req, res) => {
    const jid = req.query.jid;
    if (!jid) {
        return res.status(400).json({ error: 'Parâmetro jid é obrigatório.' });
    }
    let list = messagesMap.get(jid) || [];
    
    // Fallback: se a lista completa ainda não foi sincronizada
    const chat = chatsMap.get(jid);
    if (list.length === 0) {
        if (jid === '0@s.whatsapp.net' || jid === '0') {
            list = [{
                id: 'init-whatsapp-official',
                text: '👋 Olá! Esta é a conta oficial do WhatsApp.\n\nAqui você recebe avisos importantes de segurança, atualizações e novos recursos.',
                fromMe: false,
                timestamp: chat?.timestamp || Date.now(),
                status: 'RECEIVED'
            }];
            messagesMap.set('0@s.whatsapp.net', list);
        } else if (chat && chat.lastMessage && chat.lastMessage !== "Conversa sincronizada" && chat.lastMessage !== "Conversa ativa") {
            list = [{
                id: `init-${chat.id}`,
                text: chat.lastMessage,
                fromMe: false,
                timestamp: chat.timestamp || Date.now(),
                status: 'RECEIVED'
            }];
            messagesMap.set(jid, list);
        }
    }

    // Zera contagem de não lidas ao abrir o chat
    if (chat) {
        chat.unreadCount = 0;
    }

    res.json(list);
});

app.get('/api/whatsapp/media/:chatId/:msgId', async (req, res) => {
    const { chatId, msgId } = req.params;
    if (!chatId || !msgId) return res.status(400).json({ error: 'Falta chatId ou msgId' });

    try {
        let msg = null;
        if (messagesMap.has(chatId)) {
            msg = messagesMap.get(chatId).find(m => m.id === msgId);
        }
        if (!msg) {
            const cleanChatId = chatId.replace(/:.*@/, '@');
            if (messagesMap.has(cleanChatId)) {
                msg = messagesMap.get(cleanChatId).find(m => m.id === msgId);
            }
        }
        if (!msg) {
            for (const list of messagesMap.values()) {
                msg = list.find(m => m.id === msgId);
                if (msg) break;
            }
        }

        if (!msg || !msg.hasMedia || !msg.rawMsg) {
            return res.status(404).json({ error: 'Mídia não encontrada nesta mensagem' });
        }

        // Determina o mimetype
        let mimetype = 'application/octet-stream';
        const m = msg.rawMsg.message;
        if (m) {
            const realM = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
            if (realM.imageMessage) mimetype = realM.imageMessage.mimetype || 'image/jpeg';
            else if (realM.videoMessage) mimetype = realM.videoMessage.mimetype || 'video/mp4';
            else if (realM.audioMessage) mimetype = realM.audioMessage.mimetype || 'audio/ogg';
            else if (realM.documentMessage) mimetype = realM.documentMessage.mimetype || 'application/pdf';
            else if (realM.stickerMessage) mimetype = realM.stickerMessage.mimetype || 'image/webp';
        }

        const buffer = await downloadMediaMessage(
            msg.rawMsg,
            'buffer',
            { },
            { logger: pino({ level: 'silent' }) }
        );

        res.set('Content-Type', mimetype);
        res.set('Cache-Control', 'public, max-age=31536000'); // Cache no navegador por 1 ano
        res.send(buffer);
    } catch (e) {
        console.error('Erro ao baixar mídia:', e);
        res.status(500).json({ error: 'Falha ao baixar mídia', details: e.message });
    }
});

// Endpoint para Pareamento de WhatsApp via Número de Telefone (Código de 8 dígitos)
app.post('/api/whatsapp/pair-code', async (req, res) => {
    try {
        let { phoneNumber } = req.body;
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Número de telefone é obrigatório.' });
        }

        let clean = phoneNumber.replace(/\D/g, '');
        if (!clean.startsWith('55') && clean.length <= 11) {
            clean = '55' + clean;
        }

        if (!sock) {
            await connectToWhatsApp();
            // Aguarda a conexão do websocket (WS) ficar OPEN (readyState === 1)
            let attempts = 0;
            while (sock.ws?.readyState !== 1 && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 500));
                attempts++;
            }
            if (sock.ws?.readyState !== 1) {
                return res.status(500).json({ error: 'Falha ao conectar ao servidor do WhatsApp (Timeout).' });
            }
        }

        if (sock.authState?.creds?.registered) {
            return res.status(400).json({ error: 'WhatsApp já está conectado e registrado nesta sessão.' });
        }

        // Solicita o código de pareamento oficial ao WhatsApp
        const code = await sock.requestPairingCode(clean);
        console.log(`Código de pareamento gerado para ${clean}: ${code}`);

        res.json({ success: true, code, phoneNumber: clean });
    } catch (err) {
        console.error('Erro ao gerar pairing code:', err);
        res.status(500).json({ error: 'Erro ao solicitar código de pareamento: ' + err.message });
    }
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

// Endpoint de Propriedades / Metadados do Grupo (WhatsApp Web)
app.get('/api/whatsapp/group-metadata', async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'JID obrigatório' });

    try {
        if (groupsMetadataMap.has(jid)) {
            const cached = groupsMetadataMap.get(jid);
            if (Date.now() - (cached._cachedAt || 0) < 60000) {
                return res.json(cached);
            }
        }

        if (sock && connectionStatus === 'connected' && jid.endsWith('@g.us')) {
            const metadata = await sock.groupMetadata(jid).catch(() => null);
            if (metadata) {
                const enriched = {
                    id: metadata.id,
                    subject: metadata.subject,
                    creation: metadata.creation ? new Date(metadata.creation * 1000).toLocaleDateString('pt-BR') : null,
                    owner: metadata.owner ? metadata.owner.split('@')[0] : null,
                    desc: metadata.desc || 'Nenhuma descrição informada.',
                    size: metadata.size || (metadata.participants ? metadata.participants.length : 0),
                    participants: (metadata.participants || []).map(p => {
                        const contactName = contactsMap.get(p.id);
                        return {
                            id: p.id,
                            phoneNumber: p.id.split('@')[0],
                            name: contactName || p.id.split('@')[0],
                            isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                            isSuperAdmin: p.admin === 'superadmin'
                        };
                    }),
                    _cachedAt: Date.now()
                };
                groupsMetadataMap.set(jid, enriched);
                return res.json(enriched);
            }
        }
    } catch (e) {
        console.error('Erro ao buscar groupMetadata:', e.message);
    }

    const chat = chatsMap.get(jid);
    res.json({
        id: jid,
        subject: chat ? chat.name : 'Grupo do WhatsApp',
        creation: null,
        owner: null,
        desc: 'Grupo sincronizado.',
        size: 0,
        participants: []
    });
});

// Endpoint de Propriedades / Informações do Contato e WhatsApp Business (WhatsApp Web)
app.get('/api/whatsapp/contact-info', async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'JID obrigatório' });

    // Caso Especial: Conta Oficial do WhatsApp
    if (jid === '0@s.whatsapp.net' || jid === '0') {
        return res.json({
            id: '0@s.whatsapp.net',
            name: 'WhatsApp',
            phoneNumber: '0',
            type: 'business',
            isOfficial: true,
            isBusiness: true,
            statusText: 'Conta Oficial do WhatsApp • Verificada pela Meta',
            statusDate: null,
            avatarUrl: null,
            businessProfile: {
                description: 'Esta é a conta oficial do WhatsApp. Fique por dentro dos novos recursos, avisos de segurança e dicas úteis diretamente da equipe do WhatsApp.',
                category: 'Aplicativo Oficial & Suporte Meta',
                email: 'support@whatsapp.com',
                website: ['https://www.whatsapp.com'],
                address: 'Menlo Park, Califórnia, EUA',
                business_hours: null
            }
        });
    }

    let status = null;
    let businessProfile = null;
    let profilePic = profilePicsMap.get(jid) || null;

    try {
        if (sock && connectionStatus === 'connected' && !jid.endsWith('@g.us') && !jid.endsWith('@newsletter')) {
            // Busca Status / Recado
            status = await sock.fetchStatus(jid).catch(() => null);
            
            // Busca Foto de Perfil em Alta Resolução
            if (!profilePic) {
                profilePic = await sock.profilePictureUrl(jid, 'image').catch(() => null);
                if (profilePic) profilePicsMap.set(jid, profilePic);
            }

            // Busca Perfil do WhatsApp Business (se existir)
            businessProfile = await sock.getBusinessProfile(jid).catch(() => null);
        }
    } catch (e) {
        console.error('Erro ao buscar dados adicionais do contato/business:', e.message);
    }

    const chat = chatsMap.get(jid);
    const contactName = contactsMap.get(jid);
    let resolvedName = chat ? chat.name : (contactName || jid.split('@')[0]);

    if ((!resolvedName || /^\d+$/.test(resolvedName)) && contactName) {
        resolvedName = contactName;
    }

    res.json({
        id: jid,
        name: resolvedName,
        phoneNumber: jid.split('@')[0],
        type: businessProfile ? 'business' : getChatType(jid),
        isBusiness: Boolean(businessProfile),
        isOfficial: false,
        statusText: status?.status || (businessProfile?.description ? businessProfile.description.slice(0, 80) : "Disponível"),
        statusDate: status?.setAt ? new Date(status.setAt).toLocaleDateString('pt-BR') : null,
        avatarUrl: profilePic,
        businessProfile: businessProfile ? {
            description: businessProfile.description || null,
            category: businessProfile.category || "Conta Comercial",
            email: businessProfile.email || null,
            website: businessProfile.website || [],
            address: businessProfile.address || null,
            business_hours: businessProfile.business_hours || null
        } : null
    });
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

        const existingChat = chatsMap.get(jid);
        const contactName = contactsMap.get(jid) || contactsMap.get(jid.replace(/:.*@/, '@'));
        
        let resolvedName = cleanNumber;
        if (existingChat?.name && !/^\d+$/.test(existingChat.name)) {
            resolvedName = existingChat.name;
        } else if (contactName) {
            resolvedName = contactName;
        }

        chatsMap.set(jid, {
            id: jid,
            name: resolvedName,
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
        // Se já estiver nulo, limpa e força reiniciar
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
        chatsMap.clear();
        messagesMap.clear();
        contactsMap.clear();
        
        connectToWhatsApp();
        res.json({ success: true, message: 'Sessão limpa e reiniciando.' });
    }
});

app.post('/api/whatsapp/connect', async (req, res) => {
    if (!sock) {
        connectToWhatsApp();
        res.json({ success: true, message: 'Iniciando conexão.' });
    } else {
        res.json({ success: true, message: 'Conexão já em andamento.' });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`WhatsApp Server rodando na porta ${PORT}`);
});
