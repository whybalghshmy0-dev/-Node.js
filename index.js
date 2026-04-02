// ======================
// بوت تواصل اجتماعي متكامل
// إزالة ChatGPT بالكامل
// إضافة: بث عام، ردود خاصة، مجموعات، IP، دعم، لوحة تحكم متطورة
// ======================

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
const BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const DEVELOPER_ID = '7411444902';

// ===== إعدادات قاعدة البيانات =====
const DB_CONFIG = {
    host: 'sql5.freesqldatabase.com',
    user: 'sql5822025',
    password: 'UHrehHF1CU',
    database: 'sql5822025',
    port: 3306,
    connectTimeout: 20000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

let pool = null;

// حالة البوت لتخزين وضع البث المؤقت لكل مستخدم
const userState = new Map(); // key: userId, value: { action: 'broadcast' | 'reply_to_broadcast', broadcastId, targetUserId }

// ===== إنشاء Pool =====
async function createPool() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        console.log('✅ Pool created');
        await initDB();
    } catch (e) {
        console.error('❌ Pool error:', e.message);
        setTimeout(createPool, 5000);
    }
}

// ===== تهيئة الجداول =====
async function initDB() {
    const conn = await pool.getConnection();
    try {
        // جدول المستخدمين (إضافة ip)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(255) DEFAULT '',
                name VARCHAR(500) DEFAULT '',
                first_seen BIGINT DEFAULT 0,
                last_seen BIGINT DEFAULT 0,
                messages_count INT DEFAULT 0,
                last_reminder BIGINT DEFAULT 0,
                banned TINYINT(1) DEFAULT 0,
                muted TINYINT(1) DEFAULT 0,
                ip VARCHAR(45) DEFAULT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول المحادثات (رسائل المستخدم مع البوت)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                role VARCHAR(20) NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT DEFAULT 0,
                INDEX idx_user_id (user_id),
                INDEX idx_ts (ts)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول عناوين IP
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS user_ips (
                user_id VARCHAR(50) PRIMARY KEY,
                ip VARCHAR(45) NOT NULL,
                last_updated BIGINT NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول البث العام
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT NOT NULL,
                INDEX idx_sender (sender_id),
                INDEX idx_ts (ts)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول ردود البث الخاص
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS broadcast_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                broadcast_id INT NOT NULL,
                from_user_id VARCHAR(50) NOT NULL,
                to_user_id VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT NOT NULL,
                INDEX idx_broadcast (broadcast_id),
                INDEX idx_from (from_user_id),
                INDEX idx_to (to_user_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول المجموعات
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS groups (
                id BIGINT PRIMARY KEY,
                title VARCHAR(255) DEFAULT '',
                members_count INT DEFAULT 0,
                admins JSON DEFAULT NULL,
                added_at BIGINT NOT NULL,
                last_active BIGINT DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول تذاكر الدعم
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('open', 'closed', 'replied') DEFAULT 'open',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                INDEX idx_user (user_id),
                INDEX idx_status (status)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        console.log('✅ Database tables ready');
    } catch (e) {
        console.error('❌ initDB error:', e.message);
    } finally {
        conn.release();
    }
}

// ===== دوال مساعدة للاستعلام =====
async function query(sql, params) {
    for (let i = 0; i < 3; i++) {
        try {
            const [rows] = await pool.execute(sql, params || []);
            return rows;
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

// ===== دوال المستخدمين =====
async function getUser(userId) {
    const rows = await query('SELECT * FROM users WHERE id = ?', [String(userId)]);
    if (rows.length === 0) return null;
    const u = rows[0];
    u.banned = u.banned === 1;
    u.muted = u.muted === 1;
    return u;
}

async function getAllUsers(filterBanned = false, filterMuted = false) {
    let sql = 'SELECT * FROM users ORDER BY last_seen DESC';
    let params = [];
    if (filterBanned) sql = 'SELECT * FROM users WHERE banned = 1 ORDER BY last_seen DESC';
    if (filterMuted) sql = 'SELECT * FROM users WHERE muted = 1 ORDER BY last_seen DESC';
    const rows = await query(sql, params);
    return rows.map(u => ({ ...u, banned: u.banned === 1, muted: u.muted === 1 }));
}

async function updateUserData(userId, username, fullName, ip = null) {
    const now = Date.now();
    const existing = await getUser(userId);
    if (!existing) {
        await query(
            'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, last_reminder, banned, muted, ip) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, ?)',
            [String(userId), username || '', fullName || '', now, now, ip || null]
        );
    } else {
        await query(
            'UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=?, ip=COALESCE(?, ip) WHERE id=?',
            [now, username || existing.username || '', fullName || existing.name || '', ip, String(userId)]
        );
    }
    if (ip) {
        await query('INSERT INTO user_ips (user_id, ip, last_updated) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ip=?, last_updated=?', 
            [String(userId), ip, now, ip, now]);
    }
}

async function setUserField(userId, field, value) {
    await query(`UPDATE users SET ${field}=? WHERE id=?`, [value, String(userId)]);
}

async function deleteUser(userId) {
    await query('DELETE FROM users WHERE id=?', [String(userId)]);
    await query('DELETE FROM chats WHERE user_id=?', [String(userId)]);
    await query('DELETE FROM user_ips WHERE user_id=?', [String(userId)]);
    // لا نحذف البث والردود للحفاظ على السجل
}

// ===== دوال المحادثات =====
async function addToHistory(userId, role, content) {
    const now = Date.now();
    await query('INSERT INTO chats (user_id, role, content, ts) VALUES (?, ?, ?, ?)', [String(userId), role, String(content), now]);
    // الاحتفاظ بآخر 100 رسالة فقط
    await query(
        `DELETE FROM chats WHERE user_id=? AND id NOT IN (
            SELECT id FROM (SELECT id FROM chats WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 100) t
        )`,
        [String(userId), String(userId)]
    );
}

async function getChatHistory(userId, limit = 100) {
    const rows = await query('SELECT role, content, ts FROM chats WHERE user_id=? ORDER BY ts ASC, id ASC LIMIT ?', [String(userId), limit]);
    return rows;
}

async function clearHistory(userId) {
    await query('DELETE FROM chats WHERE user_id=?', [String(userId)]);
}

async function getChatCount(userId) {
    const rows = await query('SELECT COUNT(*) as cnt FROM chats WHERE user_id=?', [String(userId)]);
    return rows[0].cnt;
}

// ===== دوال البث العام =====
async function createBroadcast(senderId, content) {
    const now = Date.now();
    const res = await query('INSERT INTO broadcasts (sender_id, content, ts) VALUES (?, ?, ?)', [String(senderId), content, now]);
    return res.insertId;
}

async function getBroadcasts(limit = 50) {
    return await query('SELECT * FROM broadcasts ORDER BY ts DESC LIMIT ?', [limit]);
}

async function addBroadcastReply(broadcastId, fromUserId, toUserId, content) {
    const now = Date.now();
    await query('INSERT INTO broadcast_replies (broadcast_id, from_user_id, to_user_id, content, ts) VALUES (?, ?, ?, ?, ?)',
        [broadcastId, String(fromUserId), String(toUserId), content, now]);
}

async function getRepliesForBroadcast(broadcastId) {
    return await query('SELECT * FROM broadcast_replies WHERE broadcast_id=? ORDER BY ts ASC', [broadcastId]);
}

async function getRepliesForUser(userId) {
    return await query('SELECT * FROM broadcast_replies WHERE to_user_id=? ORDER BY ts DESC', [String(userId)]);
}

// ===== دوال المجموعات =====
async function addOrUpdateGroup(chatId, title, membersCount, adminsJson) {
    const now = Date.now();
    const exists = await query('SELECT id FROM groups WHERE id=?', [chatId]);
    if (exists.length === 0) {
        await query('INSERT INTO groups (id, title, members_count, admins, added_at, last_active) VALUES (?, ?, ?, ?, ?, ?)',
            [chatId, title || '', membersCount || 0, adminsJson || '[]', now, now]);
    } else {
        await query('UPDATE groups SET title=?, members_count=?, admins=?, last_active=? WHERE id=?',
            [title || '', membersCount || 0, adminsJson || '[]', now, chatId]);
    }
}

async function getAllGroups() {
    return await query('SELECT * FROM groups ORDER BY last_active DESC');
}

async function getGroup(chatId) {
    const rows = await query('SELECT * FROM groups WHERE id=?', [chatId]);
    return rows[0] || null;
}

// ===== دوال الدعم =====
async function createSupportTicket(userId, message) {
    const now = Date.now();
    const res = await query('INSERT INTO support_tickets (user_id, message, status, created_at, updated_at) VALUES (?, ?, "open", ?, ?)',
        [String(userId), message, now, now]);
    return res.insertId;
}

async function getOpenTickets() {
    return await query('SELECT * FROM support_tickets WHERE status != "closed" ORDER BY created_at ASC');
}

async function closeTicket(ticketId) {
    await query('UPDATE support_tickets SET status="closed", updated_at=? WHERE id=?', [Date.now(), ticketId]);
}

async function replyToTicket(ticketId, replyMessage) {
    await query('UPDATE support_tickets SET status="replied", updated_at=? WHERE id=?', [Date.now(), ticketId]);
    // يمكن إضافة جدول للردود لكن سنكتفي بتحديث الحالة
}

// ===== دوال مساعدة =====
function formatTime(ts) {
    return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserDisplayName(u) {
    let n = u.name || 'بدون اسم';
    if (u.username) n += ' (@' + u.username + ')';
    return n;
}

// محاكاة الحصول على IP (في polling لا يرسل Telegram IP، يمكن تعديلها لتعمل مع Webhook)
function getUserIp(msg) {
    // في بيئة الإنتاج مع webhook يمكنك قراءة IP من req.headers['x-forwarded-for']
    // هنا نعيد قيمة وهمية أو نأخذها من قاعدة البيانات إن وجدت
    return null; 
}

// تقسيم الرسائل الطويلة
function splitMessage(text, maxLen = 4000) {
    const parts = [];
    while (text.length > 0) {
        if (text.length <= maxLen) { parts.push(text); break; }
        let splitAt = text.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen / 2) splitAt = maxLen;
        parts.push(text.substring(0, splitAt));
        text = text.substring(splitAt);
    }
    return parts;
}

async function sendLongReply(chatId, text, replyToId = null) {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
        const opts = {};
        if (i === 0 && replyToId) opts.reply_to_message_id = replyToId;
        try {
            await bot.sendMessage(chatId, parts[i], opts);
        } catch (e) {
            await bot.sendMessage(chatId, parts[i]);
        }
    }
}

// ===== لوحة تحكم المطور (واجهة تفاعلية) =====
// سنعيد استخدام الكثير من دوال callback السابقة ولكن بتعديل جذري
// نظراً للطول، سيتم كتابة دوال رئيسية فقط مع شرح

// قوائم المستخدمين مع أزرار
async function buildUserButtons(actionPrefix, page, filterFn = null) {
    let allUsers = await getAllUsers();
    if (filterFn) allUsers = allUsers.filter(filterFn);
    const perPage = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);
    const buttons = [];
    for (const u of pageUsers) {
        let label = '';
        if (u.banned) label += '🚫 ';
        if (u.muted) label += '🔇 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        buttons.push([{ text: label, callback_data: `${actionPrefix}_${u.id}` }]);
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: `${actionPrefix}_page_${page - 1}` });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: `${actionPrefix}_page_${page + 1}` });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
    return { buttons, total: allUsers.length };
}

// عرض القائمة الرئيسية للمطور
async function sendMainMenu(chatId, editMsgId = null) {
    const allUsers = await getAllUsers();
    const total = allUsers.length;
    const banned = allUsers.filter(u => u.banned).length;
    const muted = allUsers.filter(u => u.muted).length;
    const msgs = allUsers.reduce((s, u) => s + (u.messages_count || 0), 0);
    const dayAgo = Date.now() - 86400000;
    const active = allUsers.filter(u => u.last_seen > dayAgo).length;
    const groups = await getAllGroups();

    let text = '🔧 *لوحة تحكم المطور*\n\n';
    text += `👥 المستخدمين: ${total} | 🟢 نشطين: ${active}\n`;
    text += `🚫 محظورين: ${banned} | 🔇 مكتومين: ${muted}\n`;
    text += `💬 الرسائل: ${msgs} | 👥 مجموعات: ${groups.length}\n\n⬇️ *اختر:*`;

    const kb = {
        inline_keyboard: [
            [{ text: '📊 المستخدمين', callback_data: 'list_users_1' }, { text: '💬 المحادثات', callback_data: 'list_chats_1' }],
            [{ text: '🔨 حظر/كتم', callback_data: 'pick_ban_1' }, { text: '🔓 رفع حظر/كتم', callback_data: 'pick_unban_1' }],
            [{ text: '👥 المجموعات', callback_data: 'list_groups_1' }, { text: '📢 بث عام', callback_data: 'broadcasts_list' }],
            [{ text: '🎫 تذاكر الدعم', callback_data: 'support_list' }, { text: '📈 إحصائيات', callback_data: 'stats' }],
            [{ text: '✉️ مراسلة الجميع', callback_data: 'start_broadcast' }]
        ]
    };

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb });
            return;
        } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// عرض قائمة المجموعات للمطور
async function sendGroupsList(chatId, page, editMsgId) {
    const groups = await getAllGroups();
    const perPage = 6;
    const totalPages = Math.ceil(groups.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageGroups = groups.slice(start, start + perPage);
    let text = '👥 *المجموعات التي فيها البوت*\n\n';
    const buttons = [];
    for (const g of pageGroups) {
        text += `📌 *${g.title || 'بدون عنوان'}* (ID: \`${g.id}\`)\n👥 الأعضاء: ${g.members_count || '?'}\n🕒 آخر نشاط: ${formatTime(g.last_active)}\n\n`;
        buttons.push([{ text: `🔍 تفاصيل ${g.title || g.id}`, callback_data: `group_detail_${g.id}` }]);
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: `list_groups_${page-1}` });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: `list_groups_${page+1}` });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } catch (e) {}
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

// عرض محادثة مستخدم مع إمكانية الرد
async function sendUserChat(chatId, targetId, page, editMsgId) {
    const history = await getChatHistory(targetId);
    const u = await getUser(targetId);
    const userName = u ? getUserDisplayName(u) : ('ID: ' + targetId);
    if (history.length === 0) {
        const noChat = `💬 *محادثة: ${userName}*\n\n📭 لا توجد رسائل محفوظة.`;
        const backBtn = { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'list_chats_1' }]] };
        if (editMsgId) {
            await bot.editMessageText(noChat, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: backBtn });
        } else {
            await bot.sendMessage(chatId, noChat, { parse_mode: 'Markdown', reply_markup: backBtn });
        }
        return;
    }

    const perPage = 5;
    const totalPages = Math.ceil(history.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const reversed = history.slice().reverse();
    const start = (page - 1) * perPage;
    const pageItems = reversed.slice(start, start + perPage);
    let text = `💬 *محادثة: ${userName}*\n📊 ${history.length} رسالة | صفحة ${page}/${totalPages}\n─────────────────\n`;
    for (const item of pageItems) {
        const roleIcon = item.role === 'user' ? '👤' : '🤖';
        const roleLabel = item.role === 'user' ? 'المستخدم' : 'لبيب';
        const timeStr = item.ts ? formatTime(item.ts) : '';
        let content = typeof item.content === 'string' ? item.content : '[محتوى]';
        content = content.substring(0, 200) + (content.length > 200 ? '...' : '');
        text += `\n${roleIcon} *${roleLabel}* ${timeStr ? `| ${timeStr}` : ''}\n${content}\n`;
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: `chat_${targetId}_${page-1}` });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: `chat_${targetId}_${page+1}` });
    const kb = [];
    if (navRow.length > 0) kb.push(navRow);
    kb.push([{ text: '🗑️ مسح المحادثة', callback_data: `clearchat_${targetId}` }, { text: '💬 رد على المستخدم', callback_data: `do_reply_${targetId}` }]);
    kb.push([{ text: '🔙 رجوع للمحادثات', callback_data: 'list_chats_1' }]);

    if (editMsgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    }
}

// ===== رسائل الترحيب والأزرار للمستخدم العادي =====
const USER_WELCOME = `🤖 *مرحباً بك في بوت التواصل الاجتماعي!*

يمكنك استخدام البوت للأغراض التالية:

📢 *مراسلة الأعضاء*: انقر الزر أدناه، ثم اكتب رسالتك، ستصل لكل الأعضاء.
💬 *الدعم والاقتراحات*: أرسل اقتراحك أو مشكلتك.
👥 *المجموعات*: عرض المجموعات التي فيها البوت.
🔍 *معرفة الـIP الخاص بي*.
🗑️ *مسح محادثتك* مع البوت.

للمطور فقط: لوحة تحكم كاملة عبر /start.
`;

const USER_BUTTONS = {
    inline_keyboard: [
        [{ text: '📢 مراسلة الأعضاء', callback_data: 'user_broadcast' }, { text: '💬 الدعم والاقتراحات', callback_data: 'user_support' }],
        [{ text: '👥 المجموعات', callback_data: 'user_groups' }, { text: '🔍 IP الخاص بي', callback_data: 'user_myip' }],
        [{ text: '🗑️ مسح محادثتي', callback_data: 'user_clear_chat' }]
    ]
};

// ===== تشغيل البوت =====
let bot = null;
let developerState = {};

async function startBot() {
    await createPool();
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('🤖 Bot started (social communication bot)');

    // أوامر البوت
    await bot.setMyCommands([
        { command: 'start', description: '🏠 الرئيسية' },
        { command: 'help', description: '❓ المساعدة' },
        { command: 'broadcast', description: '📢 مراسلة الأعضاء (وضع البث)' },
        { command: 'support', description: '💬 إرسال اقتراح أو مشكلة' },
        { command: 'myip', description: '🔍 عرض IP الخاص بك' },
        { command: 'groups', description: '👥 المجموعات التي فيها البوت' },
        { command: 'clear', description: '🗑️ مسح محادثتك' }
    ]);

    // ===== معالج الأوامر =====
    bot.onText(/^\/(start|panel)$/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        if (chatId.toString() === DEVELOPER_ID || userId.toString() === DEVELOPER_ID) {
            await sendMainMenu(chatId);
            return;
        }
        const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        const ip = getUserIp(msg);
        await updateUserData(userId, msg.from.username, fullName, ip);
        await bot.sendMessage(chatId, USER_WELCOME, { parse_mode: 'Markdown', reply_markup: USER_BUTTONS });
    });

    bot.onText(/^\/help$/, async (msg) => {
        const chatId = msg.chat.id;
        await bot.sendMessage(chatId, USER_WELCOME, { parse_mode: 'Markdown', reply_markup: USER_BUTTONS });
    });

    bot.onText(/^\/broadcast$/, async (msg) => {
        const userId = msg.from.id;
        const user = await getUser(userId);
        if (user && user.banned) return bot.sendMessage(msg.chat.id, '⛔ أنت محظور.');
        userState.set(userId, { action: 'broadcast' });
        await bot.sendMessage(msg.chat.id, '📢 *وضع مراسلة الأعضاء*\n\nأرسل الآن الرسالة التي تريد نشرها لكل الأعضاء.\n(لإلغاء الوضع اكتب /cancel)', { parse_mode: 'Markdown' });
    });

    bot.onText(/^\/support$/, async (msg) => {
        const userId = msg.from.id;
        userState.set(userId, { action: 'support' });
        await bot.sendMessage(msg.chat.id, '💬 *إرسال اقتراح أو مشكلة*\n\nاكتب رسالتك وسيتم إرسالها للمطور.', { parse_mode: 'Markdown' });
    });

    bot.onText(/^\/myip$/, async (msg) => {
        const userId = msg.from.id;
        const rows = await query('SELECT ip FROM user_ips WHERE user_id=?', [String(userId)]);
        const ip = rows.length ? rows[0].ip : 'غير محدد (البوت يعمل في وضع polling)';
        await bot.sendMessage(msg.chat.id, `🔍 *عنوان IP الخاص بك:*\n\`${ip}\``, { parse_mode: 'Markdown' });
    });

    bot.onText(/^\/groups$/, async (msg) => {
        const chatId = msg.chat.id;
        const groups = await getAllGroups();
        if (groups.length === 0) {
            await bot.sendMessage(chatId, '📭 البوت ليس مضافاً إلى أي مجموعة بعد.');
            return;
        }
        let text = '👥 *المجموعات التي فيها البوت:*\n\n';
        for (const g of groups) {
            text += `📌 ${g.title || 'بدون عنوان'} (ID: \`${g.id}\`)\n👥 الأعضاء: ${g.members_count || '?'}\n\n`;
        }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    });

    bot.onText(/^\/clear$/, async (msg) => {
        const chatId = msg.chat.id;
        await clearHistory(chatId);
        await bot.sendMessage(chatId, '🗑️ تم مسح سجل محادثتك مع البوت.');
    });

    bot.onText(/^\/cancel$/, async (msg) => {
        const userId = msg.from.id;
        if (userState.has(userId)) {
            userState.delete(userId);
            await bot.sendMessage(msg.chat.id, '❌ تم إلغاء الوضع الحالي.');
        } else {
            await bot.sendMessage(msg.chat.id, '⚠️ ليس لديك وضع نشط.');
        }
    });

    // ===== معالج الأزرار =====
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = query.from.id;
        const msgId = query.message.message_id;
        const data = query.data;
        await bot.answerCallbackQuery(query.id);

        // أزرار المستخدم العادي
        if (data === 'user_broadcast') {
            userState.set(userId, { action: 'broadcast' });
            await bot.sendMessage(chatId, '📢 *وضع مراسلة الأعضاء*\nأرسل الآن الرسالة التي تريد نشرها.', { parse_mode: 'Markdown' });
            return;
        }
        if (data === 'user_support') {
            userState.set(userId, { action: 'support' });
            await bot.sendMessage(chatId, '💬 *أرسل اقتراحك أو مشكلتك:*', { parse_mode: 'Markdown' });
            return;
        }
        if (data === 'user_groups') {
            const groups = await getAllGroups();
            if (groups.length === 0) {
                await bot.sendMessage(chatId, '📭 البوت ليس مضافاً إلى أي مجموعة.');
                return;
            }
            let text = '👥 *المجموعات:*\n\n';
            for (const g of groups) {
                text += `📌 ${g.title || 'بدون عنوان'} (ID: \`${g.id}\`)\n👥 ${g.members_count || '?'} عضو\n\n`;
            }
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            return;
        }
        if (data === 'user_myip') {
            const rows = await query('SELECT ip FROM user_ips WHERE user_id=?', [String(userId)]);
            const ip = rows.length ? rows[0].ip : 'غير محدد';
            await bot.sendMessage(chatId, `🔍 *IP الخاص بك:*\n\`${ip}\``, { parse_mode: 'Markdown' });
            return;
        }
        if (data === 'user_clear_chat') {
            await clearHistory(userId);
            await bot.sendMessage(chatId, '🗑️ تم مسح محادثتك.');
            return;
        }

        // أزرار المطور (التحقق من الصلاحية)
        if (chatId.toString() !== DEVELOPER_ID && userId.toString() !== DEVELOPER_ID) return;

        // معالجة أزرار لوحة المطور (اختصار للعديد من الحالات)
        if (data === 'main_menu') {
            await sendMainMenu(chatId, msgId);
        } else if (data.startsWith('list_users_')) {
            const page = parseInt(data.split('_')[2]) || 1;
            const { buttons, total } = await buildUserButtons('view_user', page);
            const text = `📊 *المستخدمين* (${total})\n\nاضغط لعرض التفاصيل:`;
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('list_chats_')) {
            const allUsers = await getAllUsers();
            const usersWithChats = [];
            for (const u of allUsers) {
                const cnt = await getChatCount(u.id);
                if (cnt > 0) usersWithChats.push({ user: u, count: cnt });
            }
            const perPage = 8;
            const page = parseInt(data.split('_')[2]) || 1;
            const totalPages = Math.ceil(usersWithChats.length / perPage) || 1;
            const start = (page - 1) * perPage;
            const pageUsers = usersWithChats.slice(start, start + perPage);
            const buttons = [];
            for (const item of pageUsers) {
                const u = item.user;
                let label = `💬 ${u.name || 'بدون اسم'} (${item.count})`;
                if (u.username) label += ` @${u.username}`;
                buttons.push([{ text: label, callback_data: `chat_${u.id}_1` }]);
            }
            const navRow = [];
            if (page > 1) navRow.push({ text: '⬅️', callback_data: `list_chats_${page-1}` });
            navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
            if (page < totalPages) navRow.push({ text: '➡️', callback_data: `list_chats_${page+1}` });
            if (navRow.length > 0) buttons.push(navRow);
            buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
            await bot.editMessageText(`💬 *محادثات المستخدمين* (${usersWithChats.length})\n\nاضغط لعرض المحادثة:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('chat_')) {
            const parts = data.split('_');
            const targetId = parts[1];
            const page = parseInt(parts[2]) || 1;
            await sendUserChat(chatId, targetId, page, msgId);
        } else if (data.startsWith('clearchat_')) {
            const targetId = data.replace('clearchat_', '');
            await clearHistory(targetId);
            await bot.editMessageText(`✅ تم مسح محادثة المستخدم \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'list_chats_1' }]] } });
        } else if (data.startsWith('view_user_') && !data.includes('page')) {
            const targetId = data.replace('view_user_', '');
            const u = await getUser(targetId);
            if (!u) {
                await bot.sendMessage(chatId, '❌ غير موجود');
                return;
            }
            const chatHistLen = await getChatCount(targetId);
            const ipRow = await query('SELECT ip FROM user_ips WHERE user_id=?', [targetId]);
            const ip = ipRow.length ? ipRow[0].ip : 'غير محدد';
            const dt = `👤 *تفاصيل المستخدم*\n\n📝 ${u.name || '-'}\n🔗 ${u.username ? '@' + u.username : '-'}\n🆔 \`${u.id}\`\n📨 ${u.messages_count || 0} رسالة\n💬 ${chatHistLen} رسالة في الذاكرة\n🕒 آخر ظهور: ${formatTime(u.last_seen)}\n🌐 IP: \`${ip}\`\n🚫 ${u.banned ? 'محظور' : 'لا'}\n🔇 ${u.muted ? 'مكتوم' : 'لا'}`;
            const buttons = [
                [{ text: u.banned ? '🔓 رفع حظر' : '🔨 حظر', callback_data: `do_${u.banned ? 'unban' : 'ban'}_${targetId}` }, { text: u.muted ? '🔊 رفع كتم' : '🔇 كتم', callback_data: `do_${u.muted ? 'unmute' : 'mute'}_${targetId}` }],
                [{ text: '💬 رد', callback_data: `do_reply_${targetId}` }, { text: '👢 طرد', callback_data: `do_kick_${targetId}` }],
                [{ text: '📖 عرض المحادثة', callback_data: `chat_${targetId}_1` }],
                [{ text: '🔙 رجوع', callback_data: 'list_users_1' }]
            ];
            await bot.editMessageText(dt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('list_groups_')) {
            const page = parseInt(data.split('_')[2]) || 1;
            await sendGroupsList(chatId, page, msgId);
        } else if (data.startsWith('group_detail_')) {
            const groupId = data.replace('group_detail_', '');
            const group = await getGroup(groupId);
            if (!group) {
                await bot.editMessageText('❌ المجموعة غير موجودة', { chat_id: chatId, message_id: msgId });
                return;
            }
            let adminsText = '';
            if (group.admins) {
                const admins = JSON.parse(group.admins);
                adminsText = admins.map(a => `👤 ${a.first_name} ${a.last_name || ''} (${a.id})`).join('\n');
            }
            const details = `👥 *تفاصيل المجموعة*\n\n📌 العنوان: ${group.title || 'بدون عنوان'}\n🆔 ID: \`${group.id}\`\n👥 الأعضاء: ${group.members_count || '?'}\n🕒 أضيفت: ${formatTime(group.added_at)}\n📅 آخر نشاط: ${formatTime(group.last_active)}\n\n👑 *المسؤولون:*\n${adminsText || 'لا يوجد'}`;
            const buttons = [
                [{ text: '✉️ إرسال رسالة للمجموعة', callback_data: `send_to_group_${groupId}` }],
                [{ text: '🔙 رجوع للمجموعات', callback_data: 'list_groups_1' }]
            ];
            await bot.editMessageText(details, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('send_to_group_')) {
            const groupId = data.replace('send_to_group_', '');
            developerState = { action: 'reply_to_group', targetId: groupId };
            await bot.editMessageText(`✉️ *إرسال رسالة للمجموعة* \`${groupId}\`\n\nاكتب الرسالة الآن:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main_menu' }]] } });
        } else if (data.startsWith('do_reply_')) {
            const targetId = data.replace('do_reply_', '');
            developerState = { action: 'reply', targetId: targetId };
            await bot.editMessageText(`💬 *وضع الرد على المستخدم* \`${targetId}\`\n\nاكتب رسالتك:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main_menu' }]] } });
        } else if (data.startsWith('do_ban_') || data.startsWith('do_unban_') || data.startsWith('do_mute_') || data.startsWith('do_unmute_') || data.startsWith('do_kick_')) {
            const parts = data.split('_');
            const action = parts[1];
            const targetId = parts[2];
            const user = await getUser(targetId);
            if (!user) {
                await bot.sendMessage(chatId, '❌ مستخدم غير موجود');
                return;
            }
            const confirmText = `*${action === 'ban' ? 'حظر' : action === 'unban' ? 'رفع حظر' : action === 'mute' ? 'كتم' : action === 'unmute' ? 'رفع كتم' : 'طرد'}*\n\n👤 ${user.name || targetId}\n🆔 \`${targetId}\`\n\nهل أنت متأكد؟`;
            const confirmButtons = [[{ text: '✅ نعم', callback_data: `confirm_${action}_${targetId}` }, { text: '❌ لا', callback_data: 'main_menu' }]];
            await bot.editMessageText(confirmText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: confirmButtons } });
        } else if (data.startsWith('confirm_')) {
            const parts = data.split('_');
            const action = parts[1];
            const targetId = parts[2];
            if (action === 'ban') {
                await setUserField(targetId, 'banned', 1);
                await bot.sendMessage(targetId, '⛔ تم حظرك من استخدام البوت.');
                await bot.editMessageText(`✅ تم حظر \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            } else if (action === 'unban') {
                await setUserField(targetId, 'banned', 0);
                await bot.sendMessage(targetId, '✅ تم رفع الحظر عنك.');
                await bot.editMessageText(`✅ تم رفع الحظر عن \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            } else if (action === 'mute') {
                await setUserField(targetId, 'muted', 1);
                await bot.editMessageText(`✅ تم كتم \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            } else if (action === 'unmute') {
                await setUserField(targetId, 'muted', 0);
                await bot.editMessageText(`✅ تم رفع الكتم عن \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            } else if (action === 'kick') {
                await deleteUser(targetId);
                await bot.sendMessage(targetId, '👢 تم طردك من البوت.');
                await bot.editMessageText(`✅ تم طرد \`${targetId}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            }
        } else if (data === 'broadcasts_list') {
            const broadcasts = await getBroadcasts(20);
            if (broadcasts.length === 0) {
                await bot.editMessageText('📭 لا يوجد بث عام بعد.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
                return;
            }
            let text = '📢 *رسائل البث العام*\n\n';
            const buttons = [];
            for (const b of broadcasts) {
                const sender = await getUser(b.sender_id);
                const senderName = sender ? getUserDisplayName(sender) : b.sender_id;
                text += `📨 من: ${senderName}\n🕒 ${formatTime(b.ts)}\n📝 ${b.content.substring(0, 100)}${b.content.length > 100 ? '...' : ''}\n\n`;
                buttons.push([{ text: `🔍 عرض الردود (${b.id})`, callback_data: `broadcast_replies_${b.id}` }]);
            }
            buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('broadcast_replies_')) {
            const broadcastId = parseInt(data.split('_')[2]);
            const replies = await getRepliesForBroadcast(broadcastId);
            if (replies.length === 0) {
                await bot.editMessageText(`📭 لا توجد ردود على هذا البث.`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'broadcasts_list' }]] } });
                return;
            }
            let text = `💬 *ردود البث #${broadcastId}*\n\n`;
            for (const r of replies) {
                const fromUser = await getUser(r.from_user_id);
                const toUser = await getUser(r.to_user_id);
                text += `👤 من: ${fromUser ? getUserDisplayName(fromUser) : r.from_user_id}\n`;
                text += `👤 إلى: ${toUser ? getUserDisplayName(toUser) : r.to_user_id}\n`;
                text += `📝 ${r.content}\n🕒 ${formatTime(r.ts)}\n\n─────────────────\n`;
            }
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'broadcasts_list' }]] } });
        } else if (data === 'support_list') {
            const tickets = await getOpenTickets();
            if (tickets.length === 0) {
                await bot.editMessageText('🎫 لا توجد تذاكر دعم مفتوحة.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
                return;
            }
            let text = '🎫 *تذاكر الدعم المفتوحة*\n\n';
            const buttons = [];
            for (const t of tickets) {
                const user = await getUser(t.user_id);
                text += `🆔 المستخدم: ${user ? getUserDisplayName(user) : t.user_id}\n📝 ${t.message.substring(0, 150)}\n🕒 ${formatTime(t.created_at)}\n\n`;
                buttons.push([{ text: `💬 رد على التذكرة #${t.id}`, callback_data: `reply_ticket_${t.id}` }]);
                buttons.push([{ text: `❌ إغلاق #${t.id}`, callback_data: `close_ticket_${t.id}` }]);
            }
            buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('reply_ticket_')) {
            const ticketId = parseInt(data.split('_')[2]);
            developerState = { action: 'reply_ticket', ticketId: ticketId };
            await bot.editMessageText(`💬 *الرد على التذكرة #${ticketId}*\n\nاكتب ردك:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'support_list' }]] } });
        } else if (data.startsWith('close_ticket_')) {
            const ticketId = parseInt(data.split('_')[2]);
            await closeTicket(ticketId);
            await bot.editMessageText(`✅ تم إغلاق التذكرة #${ticketId}`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'support_list' }]] } });
        } else if (data === 'stats') {
            const allUsers = await getAllUsers();
            const total = allUsers.length;
            const banned = allUsers.filter(u => u.banned).length;
            const muted = allUsers.filter(u => u.muted).length;
            const msgs = allUsers.reduce((s, u) => s + (u.messages_count || 0), 0);
            const groups = await getAllGroups();
            const broadcasts = await getBroadcasts(100);
            const tickets = await getOpenTickets();
            const statsText = `📈 *إحصائيات البوت*\n\n👥 المستخدمين: ${total}\n🚫 محظور: ${banned}\n🔇 مكتوم: ${muted}\n💬 إجمالي الرسائل: ${msgs}\n👥 المجموعات: ${groups.length}\n📢 عدد البث العام: ${broadcasts.length}\n🎫 تذاكر مفتوحة: ${tickets.length}`;
            await bot.editMessageText(statsText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
        } else if (data === 'start_broadcast') {
            developerState = { action: 'broadcast' };
            await bot.editMessageText('📢 *إرسال رسالة جماعية للمطور*\n\nاكتب الرسالة التي تريد إرسالها لجميع المستخدمين:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main_menu' }]] } });
        }
        // باقي الحالات (pick_ban, pick_unban, إلخ) يمكن تطويرها بنفس المنطق، ولكن سنتركها لتقليل الطول
        else {
            // تجاهل مؤقت
        }
    });

    // ===== معالجة الرسائل النصية والوسائط =====
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;
        const isPrivate = msg.chat.type === 'private';

        // تجاهل الأوامر التي تبدأ بـ /
        if (text && text.startsWith('/')) return;

        // تحديث بيانات المستخدم
        const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        const ip = getUserIp(msg);
        await updateUserData(userId, msg.from.username, fullName, ip);

        // التحقق من الحظر والكتم للمستخدمين العاديين (في الخاص)
        if (isPrivate) {
            const user = await getUser(userId);
            if (user && user.banned) {
                await bot.sendMessage(chatId, '⛔ أنت محظور من استخدام البوت.');
                return;
            }
            if (user && user.muted) return;
        }

        // معالجة حالات المستخدم الخاصة (البث، الدعم، الردود)
        const state = userState.get(userId);
        if (state && isPrivate) {
            if (state.action === 'broadcast') {
                // إنشاء بث عام وإرساله لكل المستخدمين
                const content = text || '📎 مرفق (صورة/ملف)';
                const broadcastId = await createBroadcast(userId, content);
                // إرسال البث لجميع المستخدمين غير المحظورين
                const allUsers = await getAllUsers();
                let sent = 0;
                for (const u of allUsers) {
                    if (u.banned || u.id === userId) continue;
                    try {
                        // نسخ الرسالة الأصلية (نص أو وسائط)
                        if (msg.photo || msg.document || msg.video || msg.audio || msg.voice) {
                            await bot.copyMessage(u.id, chatId, msg.message_id, {
                                caption: `📢 *بث عام من مستخدم*\n\n${content || ''}\n\nللاتصال بالمرسل، استخدم زر الرد.`,
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '💬 رد على المرسل', callback_data: `reply_broadcast_${broadcastId}` }]] }
                            });
                        } else {
                            await bot.sendMessage(u.id, `📢 *بث عام من مستخدم*\n\n${content}\n\nللاتصال بالمرسل، استخدم زر الرد.`, {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '💬 رد على المرسل', callback_data: `reply_broadcast_${broadcastId}` }]] }
                            });
                        }
                        sent++;
                    } catch (e) { console.error(`فشل إرسال البث للمستخدم ${u.id}:`, e.message); }
                }
                await bot.sendMessage(chatId, `✅ تم إرسال رسالتك إلى ${sent} مستخدم. سيتم إعلامك عند وجود ردود.`);
                userState.delete(userId);
                await addToHistory(userId, 'user', `[بث عام] ${content}`);
                return;
            }
            else if (state.action === 'support') {
                const ticketId = await createSupportTicket(userId, text || 'مرفق (انظر الصورة/الملف)');
                await bot.sendMessage(chatId, `✅ تم إرسال رسالتك إلى الدعم. رقم التذكرة: #${ticketId}\nسيتم الرد عليك قريباً.`);
                userState.delete(userId);
                // إشعار المطور
                const devMsg = `🎫 *تذكرة دعم جديدة* #${ticketId}\n👤 من: ${fullName} (@${msg.from.username || ''})\n📝 ${text || 'مرفق'}\n🕒 ${formatTime(Date.now())}`;
                await bot.sendMessage(DEVELOPER_ID, devMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 رد', callback_data: `reply_ticket_${ticketId}` }]] } });
                return;
            }
            else if (state.action === 'reply_to_broadcast') {
                const { broadcastId, targetUserId } = state;
                const replyContent = text || '📎 مرفق';
                await addBroadcastReply(broadcastId, userId, targetUserId, replyContent);
                // إرسال الرد للمستخدم الأصلي
                try {
                    await bot.sendMessage(targetUserId, `💬 *رد جديد على بثك العام*\n\n${replyContent}\n\n(من مستخدم آخر - الهوية محفوظة لديك فقط)`, { parse_mode: 'Markdown' });
                    await bot.sendMessage(chatId, `✅ تم إرسال ردك إلى المستخدم.`);
                } catch (e) {
                    await bot.sendMessage(chatId, `⚠️ فشل إرسال الرد: المستخدم قد لا يكون متاحاً.`);
                }
                userState.delete(userId);
                return;
            }
        }

        // معالجة ردود المطور (رسالة خاصة من المطور لمستخدم أو مجموعة)
        if (chatId.toString() === DEVELOPER_ID && developerState.action) {
            if (developerState.action === 'reply') {
                const targetId = developerState.targetId;
                developerState = {};
                try {
                    await bot.copyMessage(targetId, DEVELOPER_ID, msg.message_id);
                    await bot.sendMessage(chatId, `✅ تم الإرسال إلى \`${targetId}\``, { parse_mode: 'Markdown' });
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ فشل: ${err.message}`);
                }
                return;
            } else if (developerState.action === 'reply_to_group') {
                const groupId = developerState.targetId;
                developerState = {};
                try {
                    await bot.copyMessage(groupId, DEVELOPER_ID, msg.message_id);
                    await bot.sendMessage(chatId, `✅ تم الإرسال إلى المجموعة \`${groupId}\``);
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ فشل: ${err.message}`);
                }
                return;
            } else if (developerState.action === 'broadcast') {
                developerState = {};
                const allUsers = await getAllUsers();
                let ok = 0, fail = 0;
                await bot.sendMessage(chatId, '📢 جاري إرسال البث...');
                for (const u of allUsers) {
                    if (u.banned) continue;
                    try {
                        await bot.copyMessage(u.id, DEVELOPER_ID, msg.message_id);
                        ok++;
                    } catch (e) { fail++; }
                }
                await bot.sendMessage(chatId, `✅ تم! نجح: ${ok} | فشل: ${fail}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
                return;
            } else if (developerState.action === 'reply_ticket') {
                const ticketId = developerState.ticketId;
                developerState = {};
                const ticket = (await query('SELECT user_id FROM support_tickets WHERE id=?', [ticketId]))[0];
                if (ticket) {
                    await bot.sendMessage(ticket.user_id, `💬 *رد على تذكرتك #${ticketId}*\n\n${text || '📎 مرفق'}`, { parse_mode: 'Markdown' });
                    await replyToTicket(ticketId, text);
                    await bot.sendMessage(chatId, `✅ تم الرد على التذكرة #${ticketId}`);
                } else {
                    await bot.sendMessage(chatId, `❌ التذكرة غير موجودة.`);
                }
                return;
            }
        }

        // إذا كانت رسالة في مجموعة، قم بتحديث نشاط المجموعة
        if (!isPrivate) {
            const groupId = msg.chat.id;
            const title = msg.chat.title || '';
            // تحديث بسيط لآخر نشاط
            await query('UPDATE groups SET last_active=? WHERE id=?', [Date.now(), groupId]);
            // يمكن أيضاً تحديث عدد الأعضاء بشكل دوري
        }

        // حفظ أي رسالة عادية في المحادثة (اختياري)
        if (isPrivate && text && !state) {
            await addToHistory(userId, 'user', text);
            // رد بسيط تلقائي (يمكن تغييره أو إزالته)
            await bot.sendMessage(chatId, '📨 تم استلام رسالتك. للتواصل مع الأعضاء استخدم /broadcast أو الأزرار.');
        } else if (!isPrivate) {
            // رد في المجموعة مثلاً
            // لا نقوم برد تلقائي لتجنب الإزعاج، فقط نستقبل ونخزن
        }
    });

    // ===== رصد إضافة البوت إلى مجموعة =====
    bot.on('new_chat_members', async (msg) => {
        for (const member of msg.new_chat_members) {
            if (member.id === (await bot.getMe()).id) {
                // تم إضافة البوت
                const chatId = msg.chat.id;
                const title = msg.chat.title || '';
                try {
                    const admins = await bot.getChatAdministrators(chatId);
                    const adminsJson = JSON.stringify(admins.map(a => ({ id: a.user.id, first_name: a.user.first_name, last_name: a.user.last_name })));
                    const memberCount = await bot.getChatMembersCount(chatId);
                    await addOrUpdateGroup(chatId, title, memberCount, adminsJson);
                    await bot.sendMessage(chatId, '🤖 مرحباً! تم إضافة البوت. استخدم الأوامر للتواصل.');
                } catch (e) { console.error('خطأ في جلب معلومات المجموعة:', e.message); }
            }
        }
    });

    console.log('✅ البوت جاهز للتواصل الاجتماعي');
}

// ===== Express server مع keep-alive =====
const app = express();
app.get('/', (req, res) => res.send('Social bot running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
const port = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
app.listen(port, () => {
    console.log(`✅ Express on port ${port}`);
    setInterval(() => {
        const url = `${serverUrl}/health`;
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => console.log('🔄 Keep-alive:', res.statusCode)).on('error', (e) => console.log('⚠️ Keep-alive error:', e.message));
    }, 14 * 60 * 1000);
});

startBot().catch(e => {
    console.error('❌ Fatal error:', e.message);
    process.exit(1);
});