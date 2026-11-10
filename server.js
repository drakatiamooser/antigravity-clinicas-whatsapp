const fs = require('fs');
const path = require('path');
require('dotenv').config();
const rootEnvPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(rootEnvPath)) {
    require('dotenv').config({ path: rootEnvPath });
}
const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    Browsers, 
    downloadMediaMessage,
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Middleware de Autenticação Segura
app.use('/api', (req, res, next) => {
    const authHeader = req.headers.authorization;
    const secret = process.env.WHATSAPP_API_SECRET || process.env.API_SECRET || "antigravity-secure-wapi-7742";
    
    if (!authHeader || authHeader !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Acesso Negado. Chave de API inválida." });
    }
    next();
});

// Configurações do Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qjevnawugjtzsvgdndll.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const TENANT_ID = process.env.TENANT_ID || "00000000-0000-0000-0000-000000000001";

if (!SUPABASE_KEY) {
    console.warn("⚠️ [Aviso]: SUPABASE_SERVICE_ROLE_KEY não configurada. A persistência remota pode falhar.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

let sock = null;
let currentQrCode = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;
let supabaseAuthState = null;

const profilePicsMap = new Map();
const groupsMetadataMap = new Map();
const contactsMap = new Map();
const pushNamesMap = new Map();
const lidToPnMap = new Map();

// === 1. USE SUPABASE AUTH STATE (Substitui useMultiFileAuthState) ===
async function useSupabaseAuthState(sb, tenantId) {
    const authCache = new Map();

    // Carrega chaves salvas do Postgres (com paginação para carregar todas as chaves além do limite de 1000)
    try {
        let from = 0;
        const pageSize = 1000;
        let hasMore = true;

        while (hasMore) {
            const { data, error } = await sb
                .from('whatsapp_auth_keys')
                .select('key_id, key_data')
                .eq('tenant_id', tenantId)
                .range(from, from + pageSize - 1);

            if (error) {
                console.error('[Supabase Auth] Erro ao buscar chaves:', error.message);
                break;
            } else if (data && data.length > 0) {
                for (const row of data) {
                    try {
                        const parsed = typeof row.key_data === 'string'
                            ? JSON.parse(row.key_data, BufferJSON.reviver)
                            : JSON.parse(JSON.stringify(row.key_data), BufferJSON.reviver);
                        authCache.set(row.key_id, parsed);
                    } catch {
                        authCache.set(row.key_id, row.key_data);
                    }
                }
                if (data.length < pageSize) {
                    hasMore = false;
                } else {
                    from += pageSize;
                }
            } else {
                hasMore = false;
            }
        }
        console.log(`[Supabase Auth] Carregadas ${authCache.size} chaves de sessão do Postgres.`);
    } catch (err) {
        console.error('[Supabase Auth] Exceção ao carregar auth keys:', err);
    }

    // Auto-migração transparente: se o banco estiver vazio, importa do disco local (auth_info_baileys)
    const localAuthDir = path.join(__dirname, 'auth_info_baileys');
    if (authCache.size === 0 && fs.existsSync(localAuthDir)) {
        try {
            const files = fs.readdirSync(localAuthDir);
            const migrationRows = [];
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const keyId = file.replace('.json', '');
                    const content = fs.readFileSync(path.join(localAuthDir, file), 'utf-8');
                    try {
                        const parsed = JSON.parse(content, BufferJSON.reviver);
                        authCache.set(keyId, parsed);
                        migrationRows.push({
                            tenant_id: tenantId,
                            key_id: keyId,
                            key_data: JSON.parse(JSON.stringify(parsed, BufferJSON.replacer)),
                            updated_at: new Date().toISOString()
                        });
                    } catch {}
                }
            }

            if (migrationRows.length > 0) {
                for (let i = 0; i < migrationRows.length; i += 100) {
                    const batch = migrationRows.slice(i, i + 100);
                    await sb.from('whatsapp_auth_keys').upsert(batch, { onConflict: 'tenant_id,key_id' });
                }
                console.log(`[Supabase Auth] 🎉 Auto-migração concluída: ${migrationRows.length} chaves locais preservadas no Supabase!`);
            }
        } catch (migErr) {
            console.error('[Supabase Auth] Erro na auto-migração:', migErr.message);
        }
    }

    const creds = authCache.get('creds') || initAuthCreds();

    const writeData = async (data, keyId) => {
        authCache.set(keyId, data);
        const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        try {
            await sb.from('whatsapp_auth_keys').upsert({
                tenant_id: tenantId,
                key_id: keyId,
                key_data: serialized,
                updated_at: new Date().toISOString()
            }, { onConflict: 'tenant_id,key_id' });
        } catch (e) {
            console.error(`[Supabase Auth] Erro ao gravar key ${keyId}:`, e.message);
        }
    };

    const removeData = async (keyId) => {
        authCache.delete(keyId);
        try {
            await sb.from('whatsapp_auth_keys').delete().eq('tenant_id', tenantId).eq('key_id', keyId);
        } catch (e) {
            console.error(`[Supabase Auth] Erro ao remover key ${keyId}:`, e.message);
        }
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    for (const id of ids) {
                        const keyId = `${type}-${id}`;
                        let value = authCache.get(keyId);
                        if (!value) {
                            const { data } = await sb
                                .from('whatsapp_auth_keys')
                                .select('key_data')
                                .eq('tenant_id', tenantId)
                                .eq('key_id', keyId)
                                .maybeSingle();
                            if (data?.key_data) {
                                try {
                                    value = JSON.parse(JSON.stringify(data.key_data), BufferJSON.reviver);
                                    authCache.set(keyId, value);
                                } catch {
                                    value = data.key_data;
                                }
                            }
                        }
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        result[id] = value;
                    }
                    return result;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const keyId = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, keyId));
                            } else {
                                tasks.push(removeData(keyId));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            return writeData(creds, 'creds');
        },
        clearSession: async () => {
            authCache.clear();
            await sb.from('whatsapp_auth_keys').delete().eq('tenant_id', tenantId);
        }
    };
}

// === 2. WRITE-BEHIND BATCHER (Substitui fs.writeFileSync e o freeze do Node.js) ===
class BatchFlusher {
    constructor(sb, tenantId, intervalMs = 1500) {
        this.sb = sb;
        this.tenantId = tenantId;
        this.intervalMs = intervalMs;
        this.messagesMap = new Map();
        this.chatsMap = new Map();
        this.lidsMap = new Map();
        this.timer = setInterval(() => this.flush(), this.intervalMs);
        this.isFlushing = false;
    }

    queueMessage(msg) {
        if (!msg || !msg.chat_jid || !msg.message_id) return;
        const key = `${msg.chat_jid}:${msg.message_id}`;
        this.messagesMap.set(key, msg);
        if (this.messagesMap.size >= 500) {
            this.flush();
        }
    }

    queueChat(chat) {
        if (!chat || !chat.chat_jid) return;
        const prev = this.chatsMap.get(chat.chat_jid) || {};
        let finalName = chat.name || prev.name || null;
        if (isInvalidName(finalName, chat.phone_number)) {
            finalName = prev.name && !isInvalidName(prev.name, chat.phone_number) ? prev.name : null;
        }
        let finalPushName = chat.push_name || prev.push_name || null;
        let finalPhone = chat.phone_number !== undefined ? chat.phone_number : (prev.phone_number || null);
        // Se o chat for marcado como @lid ou não for @s.whatsapp.net, o phone_number não pode conter hash de LID
        if (finalPhone && (chat.chat_jid.endsWith('@lid') || (!chat.chat_jid.endsWith('@s.whatsapp.net') && !chat.chat_jid.endsWith('@g.us')))) {
            finalPhone = null;
        }
        this.chatsMap.set(chat.chat_jid, { 
            ...prev, 
            ...chat, 
            name: finalName,
            push_name: finalPushName,
            phone_number: finalPhone
        });
    }

    queueLidMapping(lid, pn, phone) {
        if (!lid || !pn) return;
        this.lidsMap.set(lid, {
            tenant_id: this.tenantId,
            lid_jid: lid,
            pn_jid: pn,
            phone_number: phone,
            updated_at: new Date().toISOString()
        });
    }

    async flush() {
        if (this.isFlushing) return;
        this.isFlushing = true;

        try {
            // 1. Flush LIDs
            if (this.lidsMap.size > 0) {
                const lidsToFlush = Array.from(this.lidsMap.values()).slice(0, 500);
                for (const item of lidsToFlush) {
                    this.lidsMap.delete(item.lid_jid);
                }
                const { error: lidErr } = await this.sb
                    .from('whatsapp_lid_mappings')
                    .upsert(lidsToFlush, { onConflict: 'tenant_id,lid_jid' });
                if (lidErr) console.error('[BatchFlusher] Erro upsert LIDs:', lidErr.message);
            }

            // 2. Flush Chats
            if (this.chatsMap.size > 0) {
                const chatsToFlush = Array.from(this.chatsMap.values()).slice(0, 500);
                for (const item of chatsToFlush) {
                    this.chatsMap.delete(item.chat_jid);
                }
                const { error: chatErr } = await this.sb
                    .from('whatsapp_chats')
                    .upsert(chatsToFlush, { onConflict: 'tenant_id,chat_jid' });
                if (chatErr) console.error('[BatchFlusher] Erro upsert Chats:', chatErr.message);
            }

            // 3. Flush Messages
            if (this.messagesMap.size > 0) {
                const msgsToFlush = Array.from(this.messagesMap.values()).slice(0, 500);
                for (const item of msgsToFlush) {
                    this.messagesMap.delete(`${item.chat_jid}:${item.message_id}`);
                }
                const { error: msgErr } = await this.sb
                    .from('whatsapp_messages')
                    .upsert(msgsToFlush, { onConflict: 'tenant_id,chat_jid,message_id' });
                if (msgErr) console.error('[BatchFlusher] Erro upsert Messages:', msgErr.message);
            }
        } catch (e) {
            console.error('[BatchFlusher] Exceção durante flush:', e.message);
        } finally {
            this.isFlushing = false;
        }
    }
}

const batchFlusher = new BatchFlusher(supabase, TENANT_ID, 1500);

// === 3. UNIFICAÇÃO DE LIDs E JIDs CANÔNICOS ===
async function loadLidMappingsFromDb() {
    try {
        const { data, error } = await supabase
            .from('whatsapp_lid_mappings')
            .select('lid_jid, pn_jid')
            .eq('tenant_id', TENANT_ID);

        if (!error && data) {
            for (const r of data) {
                lidToPnMap.set(r.lid_jid, r.pn_jid);
            }
            console.log(`[LID Mapping] Carregados ${lidToPnMap.size} mapeamentos de LID do Supabase.`);
        }
    } catch (e) {
        console.error('[LID Mapping] Erro ao carregar do DB:', e.message);
    }
}

function registerLidMapping(lid, pn) {
    if (!lid || !pn) return;
    const cleanLid = lid.replace(/:.*@/, '@');
    const cleanPn = pn.replace(/:.*@/, '@');
    const rawNumber = cleanPn.split('@')[0];
    lidToPnMap.set(cleanLid, cleanPn);
    batchFlusher.queueLidMapping(cleanLid, cleanPn, rawNumber);
}

async function resolveCanonicalJidAsync(keyOrJid, alt = null) {
    if (!keyOrJid) return null;
    let jid = typeof keyOrJid === 'string' ? keyOrJid : keyOrJid.remoteJid;
    let altJid = alt || (typeof keyOrJid === 'object' ? keyOrJid.remoteJidAlt : null);

    if (jid) jid = jid.replace(/:.*@/, '@');
    if (altJid) altJid = altJid.replace(/:.*@/, '@');

    if (jid?.endsWith('@lid') && altJid?.endsWith('@s.whatsapp.net')) {
        registerLidMapping(jid, altJid);
        return altJid;
    }
    if (jid?.endsWith('@s.whatsapp.net') && altJid?.endsWith('@lid')) {
        registerLidMapping(altJid, jid);
        return jid;
    }
    if (jid?.endsWith('@lid')) {
        if (lidToPnMap.has(jid)) {
            return lidToPnMap.get(jid);
        }
        if (sock?.signalRepository?.lidMapping?.getPNForLID) {
            try {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
                if (pn) {
                    const fullPn = pn.endsWith('@s.whatsapp.net') ? pn : `${pn}@s.whatsapp.net`;
                    registerLidMapping(jid, fullPn);
                    return fullPn;
                }
            } catch (e) {}
        }
    }
    return jid;
}

function resolveCanonicalJid(keyOrJid, alt = null) {
    if (!keyOrJid) return null;
    let jid = typeof keyOrJid === 'string' ? keyOrJid : keyOrJid.remoteJid;
    let altJid = alt || (typeof keyOrJid === 'object' ? keyOrJid.remoteJidAlt : null);

    if (jid) jid = jid.replace(/:.*@/, '@');
    if (altJid) altJid = altJid.replace(/:.*@/, '@');

    if (jid?.endsWith('@lid') && altJid?.endsWith('@s.whatsapp.net')) {
        registerLidMapping(jid, altJid);
        return altJid;
    }
    if (jid?.endsWith('@s.whatsapp.net') && altJid?.endsWith('@lid')) {
        registerLidMapping(altJid, jid);
        return jid;
    }
    if (jid?.endsWith('@lid') && lidToPnMap.has(jid)) {
        return lidToPnMap.get(jid);
    }
    return jid;
}

function getChatType(jid) {
    if (!jid) return 'user';
    if (jid.endsWith('@g.us')) return 'group';
    if (jid.endsWith('@newsletter')) return 'channel';
    return 'user';
}

function isInvalidName(name, phone) {
    if (!name) return true;
    if (/^[\+\d\s\-\(\)∙\*\.\_]+$/.test(name)) return true;
    if (/^Contato \d{4}$/.test(name)) return true;
    if (phone && name === phone) return true;
    return false;
}

// === 4. PROCESSADOR UNIVERSAL DE MENSAGENS E MÍDIAS ===
function extractMessageContent(msg) {
    if (!msg || !msg.message) return null;
    let m = msg.message;
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
    
    const type = Object.keys(m)[0];
    if (type && type !== 'messageContextInfo') {
        return `[Mensagem: ${type}]`;
    }
    return "Mensagem Suportada Parcialmente";
}

async function uploadMediaToStorage(msg, tenantId) {
    if (!msg || !msg.message) return null;
    let m = msg.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

    let mediaObj = null;
    let ext = 'bin';
    let mime = 'application/octet-stream';

    if (m?.imageMessage) { mediaObj = m.imageMessage; ext = 'jpg'; mime = mediaObj.mimetype || 'image/jpeg'; }
    else if (m?.videoMessage) { mediaObj = m.videoMessage; ext = 'mp4'; mime = mediaObj.mimetype || 'video/mp4'; }
    else if (m?.audioMessage) { mediaObj = m.audioMessage; ext = 'ogg'; mime = mediaObj.mimetype || 'audio/ogg'; }
    else if (m?.documentMessage) { 
        mediaObj = m.documentMessage; 
        ext = mediaObj.fileName ? path.extname(mediaObj.fileName).replace('.', '') || 'pdf' : 'pdf';
        mime = mediaObj.mimetype || 'application/pdf';
    }
    else if (m?.stickerMessage) { mediaObj = m.stickerMessage; ext = 'webp'; mime = mediaObj.mimetype || 'image/webp'; }

    if (!mediaObj) return null;

    try {
        const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger: pino({ level: 'silent' }) }
        );

        if (!buffer || buffer.length === 0) return null;

        const filePath = `${tenantId}/${msg.key.id}.${ext}`;
        const { error } = await supabase.storage
            .from('whatsapp-media')
            .upload(filePath, buffer, { contentType: mime, upsert: true });

        if (error) {
            console.error('[Storage Upload Error]:', error.message);
            return null;
        }

        const { data: publicUrlData } = supabase.storage
            .from('whatsapp-media')
            .getPublicUrl(filePath);

        return {
            mediaUrl: publicUrlData?.publicUrl || null,
            mime,
            fileName: mediaObj.fileName || `media.${ext}`
        };
    } catch (e) {
        console.error('[Download/Upload Media]:', e.message);
        return null;
    }
}

async function processMessage(msg) {
    if (!msg || !msg.message) return;
    const rawJid = msg.key?.remoteJid;
    if (!rawJid || rawJid === 'status@broadcast') return;

    if (
        msg.message.protocolMessage || 
        msg.message.senderKeyDistributionMessage ||
        msg.message.reactionMessage ||
        msg.message.keepAliveMessage ||
        msg.message.historySyncNotification
    ) {
        return;
    }

    const canonicalJid = await resolveCanonicalJidAsync(msg.key);
    const text = extractMessageContent(msg);
    if (!text || text.trim() === '') return;

    const fromMe = Boolean(msg.key.fromMe);
    const type = getChatType(canonicalJid);
    const isLid = canonicalJid.endsWith('@lid');
    const phone = isLid ? null : canonicalJid.split('@')[0];

    if (msg.pushName && !fromMe) {
        pushNamesMap.set(canonicalJid, msg.pushName);
        if (rawJid !== canonicalJid) pushNamesMap.set(rawJid, msg.pushName);
    }

    const agendaName = contactsMap.get(canonicalJid) || contactsMap.get(rawJid) || null;
    const pushName = pushNamesMap.get(canonicalJid) || pushNamesMap.get(rawJid) || msg.pushName || null;
    let resolvedName = agendaName || null;
    if (isInvalidName(resolvedName, phone)) {
        resolvedName = type === 'group' ? 'Grupo' : null;
    }

    const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();

    let hasMedia = false;
    let mediaType = null;
    let m = msg.message;
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;

    if (m?.imageMessage) { hasMedia = true; mediaType = 'image'; }
    else if (m?.videoMessage) { hasMedia = true; mediaType = 'video'; }
    else if (m?.audioMessage) { hasMedia = true; mediaType = 'audio'; }
    else if (m?.documentMessage) { hasMedia = true; mediaType = 'document'; }
    else if (m?.stickerMessage) { hasMedia = true; mediaType = 'sticker'; }

    let messageStatus = 'RECEIVED';
    if (fromMe) {
        if (msg.status === 4 || msg.status === 5 || msg.status === 'READ' || msg.status === 'PLAYED') messageStatus = 'READ';
        else if (msg.status === 3 || msg.status === 'DELIVERY_ACK') messageStatus = 'DELIVERED';
        else messageStatus = 'SENT';
    }

    const msgRecord = {
        tenant_id: TENANT_ID,
        chat_jid: canonicalJid,
        message_id: msg.key.id || `${canonicalJid}-${timestamp}`,
        from_me: fromMe,
        sender_jid: msg.key.participant ? resolveCanonicalJid({ remoteJid: msg.key.participant }) : null,
        text_content: text,
        timestamp_ms: timestamp,
        status: messageStatus,
        has_media: hasMedia,
        media_type: mediaType,
        media_url: null,
        media_mime: null,
        media_filename: null,
        quoted_message_id: null,
        raw_key: msg.key,
        raw_message: msg.message,
        created_at: new Date(timestamp).toISOString()
    };

    batchFlusher.queueMessage(msgRecord);

    // Atualiza conversa no lote
    batchFlusher.queueChat({
        tenant_id: TENANT_ID,
        chat_jid: canonicalJid,
        lid_jid: isLid ? canonicalJid : (rawJid.endsWith('@lid') ? rawJid : null),
        name: resolvedName,
        push_name: pushName,
        phone_number: phone,
        chat_type: type,
        last_message_text: text,
        last_message_from_me: fromMe,
        last_message_status: messageStatus,
        last_message_ts: timestamp,
        unread_count: fromMe ? 0 : 1,
        updated_at: new Date().toISOString()
    });

    // Se tiver mídia, dispara o upload em background sem bloquear o fluxo
    if (hasMedia) {
        uploadMediaToStorage(msg, TENANT_ID).then(storageResult => {
            if (storageResult?.mediaUrl) {
                batchFlusher.queueMessage({
                    tenant_id: TENANT_ID,
                    chat_jid: canonicalJid,
                    message_id: msgRecord.message_id,
                    from_me: fromMe,
                    text_content: text,
                    timestamp_ms: timestamp,
                    has_media: true,
                    media_type: mediaType,
                    media_url: storageResult.mediaUrl,
                    media_mime: storageResult.mime,
                    media_filename: storageResult.fileName
                });
            }
        }).catch(err => {
            console.error('[Async Media Upload Error]:', err.message);
        });
    }
}

// === 5. CONEXÃO BAILEYS V7 COM SUPABASE AUTH ===
async function connectToWhatsApp() {
    await loadLidMappingsFromDb();
    supabaseAuthState = await useSupabaseAuthState(supabase, TENANT_ID);

    sock = makeWASocket({
        auth: supabaseAuthState.state,
        logger: pino({ level: 'warn' }),
        // 1. Identificar como Desktop obriga o WhatsApp a enviar histórico FULL
        browser: Browsers.macOS('Desktop'),
        // 2. Solicita sincronização completa de histórico no pareamento
        syncFullHistory: true,
        // 3. Aceita processar todos os pacotes de histórico (RECENT, FULL, ON_DEMAND)
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: false,
        // 4. Obrigatório para Baileys decodificar mensagens antigas e responder Retry Receipts
        getMessage: async (key) => {
            const { data } = await supabase
                .from('whatsapp_messages')
                .select('raw_message')
                .eq('tenant_id', TENANT_ID)
                .eq('message_id', key.id)
                .maybeSingle();
            return data?.raw_message || undefined;
        }
    });

    sock.ev.on('creds.update', supabaseAuthState.saveCreds);

    // Escuta novos mapeamentos @lid <-> @s.whatsapp.net descobertos nativamente no Baileys v7
    sock.ev.on('lid-mapping.update', async (mappings) => {
        try {
            if (!mappings) return;
            if (Array.isArray(mappings)) {
                for (const item of mappings) {
                    if (item.lid && item.pn) registerLidMapping(item.lid, item.pn);
                }
            } else if (typeof mappings === 'object') {
                for (const [lid, pn] of Object.entries(mappings)) {
                    registerLidMapping(lid, pn);
                }
            }
        } catch (e) {
            console.error('[LID mapping update error]:', e.message);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR CODE GERADO PARA WHATSAPP');
            currentQrCode = await QRCode.toDataURL(qr);
            connectionStatus = 'qrcode';
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            phoneNumber = null;

            if (shouldReconnect) {
                console.log('WhatsApp desconectado temporariamente. Reconectando...');
                connectToWhatsApp();
            } else {
                console.log('WhatsApp desconectado por LOGOUT. Limpando chaves de autenticação...');
                // CRÍTICO: Limpa apenas as chaves da sessão desconectada. NUNCA apaga mensagens ou chats!
                if (supabaseAuthState) {
                    await supabaseAuthState.clearSession();
                }
                const localAuthDir = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(localAuthDir)) {
                    fs.rmSync(localAuthDir, { recursive: true, force: true });
                }
                sock = null;
                setTimeout(() => connectToWhatsApp(), 2000);
            }
        } else if (connection === 'open') {
            console.log('WhatsApp conectado com sucesso via Supabase Auth!');
            connectionStatus = 'connected';
            currentQrCode = null;
            phoneNumber = sock.user.id.split(':')[0];

            // Atualiza status na tabela whatsapp_sessions se ela existir
            supabase.from('whatsapp_sessions').upsert({
                tenant_id: TENANT_ID,
                status: 'connected',
                connected_phone: phoneNumber,
                updated_at: new Date().toISOString()
            }, { onConflict: 'tenant_id' }).then(() => {});
        }
    });

    // Sincronização de Contatos
    const handleContact = (c) => {
        if (!c || !c.id) return;
        const cleanId = c.id.replace(/:.*@/, '@');
        
        // Mapeamento nativo LID se fornecido no contato
        if (c.lid) {
            registerLidMapping(c.lid, cleanId);
        }

        // Nome da agenda do celular
        if (c.name) {
            contactsMap.set(cleanId, c.name);
            const phone = cleanId.split('@')[0];
            if (phone) contactsMap.set(phone, c.name);
            if (c.lid) contactsMap.set(c.lid.replace(/:.*@/, '@'), c.name);
        }

        // PushName público do WhatsApp
        const pushName = c.notify || c.verifiedName || null;
        if (pushName) {
            pushNamesMap.set(cleanId, pushName);
            const phone = cleanId.split('@')[0];
            if (phone) pushNamesMap.set(phone, pushName);
            if (c.lid) pushNamesMap.set(c.lid.replace(/:.*@/, '@'), pushName);
        }
    };

    sock.ev.on('contacts.upsert', (contacts) => {
        if (Array.isArray(contacts)) contacts.forEach(handleContact);
    });
    sock.ev.on('contacts.update', (updates) => {
        if (Array.isArray(updates)) updates.forEach(handleContact);
    });

    // Sincronização Inicial Completa (messaging-history.set)
    sock.ev.on('messaging-history.set', async (payload) => {
        const { contacts, messages, chats, lidPnMappings } = payload;
        console.log(`[messaging-history.set] Recebidos: ${contacts?.length || 0} contatos, ${chats?.length || 0} chats, ${messages?.length || 0} msgs, ${lidPnMappings?.length || 0} lidMappings.`);

        // 1. Processar mapeamentos LID <-> PN enviados na sincronização do histórico
        if (lidPnMappings && Array.isArray(lidPnMappings)) {
            for (const item of lidPnMappings) {
                if (item.lid && item.pn) {
                    registerLidMapping(item.lid, item.pn);
                }
            }
        }

        // 2. Processar Contatos e Nomes
        if (contacts && Array.isArray(contacts)) {
            contacts.forEach(handleContact);
        }

        // 3. Processar Mensagens
        if (messages && Array.isArray(messages)) {
            for (const msg of messages) {
                await processMessage(msg);
            }
        }

        // 4. Processar Lista de Conversas (Chats)
        if (chats && Array.isArray(chats)) {
            for (const c of chats) {
                if (!c.id || c.id === 'status@broadcast') continue;
                const rawJid = c.id.replace(/:.*@/, '@');
                const canJid = await resolveCanonicalJidAsync(rawJid, c.lidJid || c.accountLid || null);
                const type = getChatType(canJid);
                
                const isLid = canJid.endsWith('@lid');
                const phone = isLid ? null : canJid.split('@')[0];
                
                const agendaName = contactsMap.get(canJid) || contactsMap.get(rawJid) || c.name || null;
                const pushName = pushNamesMap.get(canJid) || pushNamesMap.get(rawJid) || null;
                
                let name = agendaName;
                if (isInvalidName(name, phone)) {
                    name = type === 'group' ? (c.name || 'Grupo') : null;
                }

                batchFlusher.queueChat({
                    tenant_id: TENANT_ID,
                    chat_jid: canJid,
                    lid_jid: isLid ? canJid : (rawJid.endsWith('@lid') ? rawJid : null),
                    name,
                    push_name: pushName,
                    phone_number: phone,
                    chat_type: type,
                    last_message_ts: c.conversationTimestamp ? Number(c.conversationTimestamp) * 1000 : Date.now(),
                    unread_count: c.unreadCount || 0,
                    updated_at: new Date().toISOString()
                });
            }
        }

        await batchFlusher.flush();
    });

    // Mensagens em Tempo Real (messages.upsert)
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (!m?.messages || !Array.isArray(m.messages)) return;
            for (const msg of m.messages) {
                await processMessage(msg);
            }
        } catch (e) {
            console.error('[messages.upsert] Erro:', e.message);
        }
    });

    // Atualização de Status de Mensagens (Lida, Entregue)
    const updateMessageStatus = async (msgId, rawRemoteJid, statusStr) => {
        if (!msgId || !statusStr) return;
        const canJid = resolveCanonicalJid({ remoteJid: rawRemoteJid });

        try {
            await supabase
                .from('whatsapp_messages')
                .update({ status: statusStr })
                .eq('tenant_id', TENANT_ID)
                .eq('message_id', msgId);
        } catch (e) {
            console.error('[updateMessageStatus] Erro:', e.message);
        }
    };

    sock.ev.on('messages.update', (updates) => {
        if (!Array.isArray(updates)) return;
        for (const { key, update } of updates) {
            if (update?.status !== undefined) {
                let s = 'SENT';
                if (update.status === 4 || update.status === 5) s = 'READ';
                else if (update.status === 3) s = 'DELIVERED';
                updateMessageStatus(key.id, key.remoteJid, s);
            }
        }
    });

    sock.ev.on('message-receipt.update', (receiptUpdates) => {
        if (!Array.isArray(receiptUpdates)) return;
        for (const { key, receipt } of receiptUpdates) {
            const s = receipt.readTimestamp ? 'READ' : (receipt.receiptTimestamp ? 'DELIVERED' : 'SENT');
            updateMessageStatus(key.id, key.remoteJid, s);
        }
    });
}

// Inicializa conexão
connectToWhatsApp();

// === 6. ROTAS HTTP REST ===

app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: currentQrCode,
        number: phoneNumber
    });
});

// Endpoint de lista de chats (compatibilidade e fallback)
app.get('/api/whatsapp/chats', async (req, res) => {
    try {
        if (supabase && SUPABASE_KEY) {
            const { data, error } = await supabase
                .from('whatsapp_chats')
                .select('*')
                .eq('tenant_id', TENANT_ID)
                .order('last_message_ts', { ascending: false })
                .limit(50);
            if (!error && data && data.length > 0) {
                const list = data.map(c => ({
                    id: c.chat_jid,
                    name: c.name || null,
                    pushName: c.push_name || null,
                    phoneNumber: c.phone_number || (c.chat_jid.endsWith('@s.whatsapp.net') ? c.chat_jid.split('@')[0] : null),
                    type: c.chat_type,
                    lastMessage: c.last_message_text || 'Conversa sincronizada',
                    timestamp: Number(c.last_message_ts),
                    unreadCount: c.unread_count || 0
                }));
                return res.json(list);
            }
        }
    } catch (e) {}

    // Fallback de memória ativa do processo Baileys
    if (batchFlusher?.chatsMap?.size > 0) {
        const memoryChats = Array.from(batchFlusher.chatsMap.values())
            .filter(c => c.chat_jid && c.chat_jid !== 'status@broadcast')
            .sort((a, b) => (Number(b.last_message_ts) || 0) - (Number(a.last_message_ts) || 0))
            .slice(0, 100)
            .map(c => ({
                id: c.chat_jid,
                name: c.name || null,
                pushName: c.push_name || null,
                phoneNumber: c.phone_number || (c.chat_jid.endsWith('@s.whatsapp.net') ? c.chat_jid.split('@')[0] : null),
                type: c.chat_type || 'user',
                lastMessage: c.last_message_text || 'Conversa sincronizada',
                timestamp: Number(c.last_message_ts) || Date.now(),
                unreadCount: c.unread_count || 0
            }));
        if (memoryChats.length > 0) return res.json(memoryChats);
    }

    // Fallback do arquivo local chats_store.json
    try {
        const storePath = path.join(__dirname, 'chats_store.json');
        if (fs.existsSync(storePath)) {
            const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            if (raw.chats && raw.chats.length > 0) {
                return res.json(raw.chats);
            }
        }
    } catch (e) {}

    res.json([]);
});

// Busca sob demanda no aparelho celular (fetchMessageHistory)
app.post('/api/whatsapp/fetch-older-history', async (req, res) => {
    try {
        const { chatJid } = req.body;
        if (!chatJid) {
            return res.status(400).json({ error: 'chatJid é obrigatório.' });
        }

        if (!sock || connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp não está conectado.' });
        }

        // Busca a mensagem mais antiga que temos no Supabase para esse chat
        const { data: oldestMsg, error } = await supabase
            .from('whatsapp_messages')
            .select('message_id, timestamp_ms, from_me, raw_key')
            .eq('tenant_id', TENANT_ID)
            .eq('chat_jid', chatJid)
            .order('timestamp_ms', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error || !oldestMsg) {
            return res.status(404).json({ error: 'Sem mensagem âncora para puxar histórico retroativo.' });
        }

        const msgKey = oldestMsg.raw_key || {
            remoteJid: chatJid,
            fromMe: oldestMsg.from_me,
            id: oldestMsg.message_id
        };

        if (typeof sock.fetchMessageHistory === 'function') {
            const requestId = await sock.fetchMessageHistory(50, msgKey, oldestMsg.timestamp_ms);
            return res.json({ 
                success: true, 
                status: 'requested', 
                requestId, 
                oldestTimestampMs: oldestMsg.timestamp_ms 
            });
        } else {
            return res.status(501).json({ error: 'fetchMessageHistory não disponível no socket' });
        }
    } catch (e) {
        console.error('Erro em fetch-older-history:', e);
        res.status(500).json({ error: e.message });
    }
});

// Envio de Mensagens
app.post('/api/whatsapp/send-message', async (req, res) => {
    try {
        const { to, message, documentUrl, documentName } = req.body;
        if (!to || (!message && !documentUrl)) {
            return res.status(400).json({ error: 'Destinatário e mensagem/documento são obrigatórios.' });
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

        const timestamp = Date.now();
        const canJid = resolveCanonicalJid(sentMsg.key) || jid;

        // Persiste via batchFlusher
        const msgRecord = {
            tenant_id: TENANT_ID,
            chat_jid: canJid,
            message_id: sentMsg.key.id,
            from_me: true,
            text_content: message || (documentName ? `📄 ${documentName}` : '[Documento]'),
            timestamp_ms: timestamp,
            status: 'SENT',
            has_media: Boolean(documentUrl),
            media_type: documentUrl ? 'document' : null,
            media_url: documentUrl || null,
            raw_key: sentMsg.key,
            raw_message: sentMsg.message,
            created_at: new Date(timestamp).toISOString()
        };
        batchFlusher.queueMessage(msgRecord);

        batchFlusher.queueChat({
            tenant_id: TENANT_ID,
            chat_jid: canJid,
            last_message_text: msgRecord.text_content,
            last_message_from_me: true,
            last_message_status: 'SENT',
            last_message_ts: timestamp,
            updated_at: new Date().toISOString()
        });

        res.json({ success: true, messageId: sentMsg.key.id });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ error: 'Erro ao disparar mensagem: ' + err.message });
    }
});

// Fallback de download direto de mídia
app.get('/api/whatsapp/media/:chatId/:msgId', async (req, res) => {
    const { chatId, msgId } = req.params;
    try {
        const { data: msg } = await supabase
            .from('whatsapp_messages')
            .select('raw_message, media_url, media_mime')
            .eq('tenant_id', TENANT_ID)
            .eq('message_id', msgId)
            .maybeSingle();

        if (msg?.media_url) {
            return res.redirect(msg.media_url);
        }

        if (!msg || !msg.raw_message) {
            return res.status(404).json({ error: 'Mídia não encontrada.' });
        }

        const buffer = await downloadMediaMessage(
            { key: { id: msgId, remoteJid: chatId }, message: msg.raw_message },
            'buffer',
            {},
            { logger: pino({ level: 'silent' }) }
        );

        res.set('Content-Type', msg.media_mime || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=31536000');
        res.send(buffer);
    } catch (e) {
        console.error('Erro ao baixar mídia:', e);
        res.status(500).json({ error: 'Falha ao baixar mídia: ' + e.message });
    }
});

// Pareamento via Código de Telefone
app.post('/api/whatsapp/pair-code', async (req, res) => {
    try {
        let { phoneNumber: pn } = req.body;
        if (!pn) return res.status(400).json({ error: 'Número de telefone é obrigatório.' });

        let clean = pn.replace(/\D/g, '');
        if (!clean.startsWith('55') && clean.length <= 11) clean = '55' + clean;

        if (!sock) {
            await connectToWhatsApp();
            let attempts = 0;
            while (sock?.ws?.readyState !== 1 && attempts < 20) {
                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }
        }

        if (sock?.authState?.creds?.registered) {
            return res.status(400).json({ error: 'WhatsApp já registrado nesta sessão.' });
        }

        const code = await sock.requestPairingCode(clean);
        res.json({ success: true, code, phoneNumber: clean });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Metadados de Grupo
app.get('/api/whatsapp/group-metadata', async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'JID obrigatório' });

    try {
        if (groupsMetadataMap.has(jid)) {
            const cached = groupsMetadataMap.get(jid);
            if (Date.now() - (cached._cachedAt || 0) < 60000) return res.json(cached);
        }

        if (sock && connectionStatus === 'connected' && jid.endsWith('@g.us')) {
            const meta = await sock.groupMetadata(jid).catch(() => null);
            if (meta) {
                const enriched = {
                    id: meta.id,
                    subject: meta.subject,
                    creation: meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('pt-BR') : null,
                    owner: meta.owner ? meta.owner.split('@')[0] : null,
                    desc: meta.desc || 'Nenhuma descrição informada.',
                    size: meta.size || meta.participants?.length || 0,
                    participants: (meta.participants || []).map(p => ({
                        id: p.id,
                        phoneNumber: p.id.split('@')[0],
                        name: contactsMap.get(p.id) || p.id.split('@')[0],
                        isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
                    })),
                    _cachedAt: Date.now()
                };
                groupsMetadataMap.set(jid, enriched);
                return res.json(enriched);
            }
        }
    } catch (e) {}

    res.json({ id: jid, subject: 'Grupo do WhatsApp', desc: 'Grupo sincronizado.', participants: [] });
});

// Informações de Contato
app.get('/api/whatsapp/contact-info', async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ error: 'JID obrigatório' });

    let status = null;
    let businessProfile = null;
    let profilePic = profilePicsMap.get(jid) || null;

    try {
        if (sock && connectionStatus === 'connected' && !jid.endsWith('@g.us')) {
            status = await sock.fetchStatus(jid).catch(() => null);
            if (!profilePic) {
                profilePic = await sock.profilePictureUrl(jid, 'image').catch(() => null);
                if (profilePic) profilePicsMap.set(jid, profilePic);
            }
            businessProfile = await sock.getBusinessProfile(jid).catch(() => null);
        }
    } catch (e) {}

    const contactName = contactsMap.get(jid);
    res.json({
        id: jid,
        name: contactName || jid.split('@')[0],
        phoneNumber: jid.split('@')[0],
        type: businessProfile ? 'business' : getChatType(jid),
        isBusiness: Boolean(businessProfile),
        statusText: status?.status || (businessProfile?.description ? businessProfile.description.slice(0, 80) : "Disponível"),
        statusDate: status?.setAt ? new Date(status.setAt).toLocaleDateString('pt-BR') : null,
        avatarUrl: profilePic,
        businessProfile: businessProfile ? {
            description: businessProfile.description || null,
            category: businessProfile.category || "Conta Comercial",
            email: businessProfile.email || null,
            website: businessProfile.website || []
        } : null
    });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    if (sock) {
        sock.logout();
        res.json({ success: true, message: 'Desconectando sessão...' });
    } else {
        if (supabaseAuthState) await supabaseAuthState.clearSession();
        connectToWhatsApp();
        res.json({ success: true, message: 'Sessão limpa e reiniciando.' });
    }
});

app.post('/api/whatsapp/connect', async (req, res) => {
    try {
        if (connectionStatus === 'connected') {
            return res.json({ 
                success: true, 
                message: 'WhatsApp já está conectado.', 
                status: 'connected', 
                number: phoneNumber 
            });
        }
        
        if (currentQrCode && connectionStatus === 'qrcode') {
            return res.json({ 
                success: true, 
                message: 'QR Code ativo pronto para leitura.', 
                status: 'qrcode', 
                qr: currentQrCode 
            });
        }

        if (sock) {
            try { sock.end(); } catch (e) {}
            sock = null;
        }
        currentQrCode = null;
        connectionStatus = 'connecting';
        await connectToWhatsApp();
        res.json({ success: true, message: 'Novo socket Baileys inicializado.' });
    } catch (err) {
        console.error('[Connect API Error]:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`WhatsApp Server com Persistência Supabase rodando na porta ${PORT}`);
});
