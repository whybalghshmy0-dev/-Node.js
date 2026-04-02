// ======================
// بوت تواصل عام (بث)
// نظام بث عام بين المستخدمين + لوحة تحكم للمطور
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

// حالة البوت لتخزين الحالات المؤقتة لكل مستخدم
const userState = new Map(); // key: userId, value: { action, targetUserId, etc }

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
        // جدول المستخدمين
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(255) DEFAULT '',
                name VARCHAR(500) DEFAULT '',
                first_seen BIGINT DEFAULT 0,
                last_seen BIGINT DEFAULT 0,
                messages_count INT DEFAULT 0,
                banned TINYINT(1) DEFAULT 0,
                muted TINYINT(1) DEFAULT 0,
                ip VARCHAR(45) DEFAULT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول البث العام
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                sender_name VARCHAR(500) NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT NOT NULL,
                INDEX idx_sender (sender_id),
                INDEX idx_ts (ts)
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

async function getAllUsers(filterBanned = false) {
    let sql = 'SELECT * FROM users ORDER BY last_seen DESC';
    if (filterBanned) sql = 'SELECT * FROM users WHERE banned = 1 ORDER BY last_seen DESC';
    const rows = await query(sql);
    return rows.map(u => ({ ...u, banned: u.banned === 1, muted: u.muted === 1 }));
}

async function updateUserData(userId, username, fullName, ip = null) {
    const now = Date.now();
    const existing = await getUser(userId);
    if (!existing) {
        await query(
            'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, banned, muted, ip) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)',
            [String(userId), username || '', fullName || '', now, now, ip || null]
        );
    } else {
        await query(
            'UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=?, ip=COALESCE(?, ip) WHERE id=?',
            [now, username || existing.username || '', fullName || existing.name || '', ip, String(userId)]
        );
    }
}

async function setUserField(userId, field, value) {
    await query(`UPDATE users SET ${field}=? WHERE id=?`, [value, String(userId)]);
}

async function deleteUser(userId) {
    await query('DELETE FROM users WHERE id=?', [String(userId)]);
}

// ===== دوال البث العام =====
async function createBroadcast(senderId, senderName, content) {
    const now = Date.now();
    const res = await query('INSERT INTO broadcasts (sender_id, sender_name, content, ts) VALUES (?, ?, ?, ?)',
        [String(senderId), senderName, content, now]);
    return res.insertId;
}

async function getBroadcasts(limit = 50) {
    return await query('SELECT * FROM broadcasts ORDER BY ts DESC LIMIT ?', [limit]);
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

async function getGroup(groupId) {
    const rows = await query('SELECT * FROM groups WHERE id=?', [groupId]);
    return rows.length ? rows[0] : null;
}

// ===== دوال الدعم =====
async function createSupportTicket(userId, message) {
    const now = Date.now();
    const res = await query('INSERT INTO support_tickets (user_id, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [String(userId), message, 'open', now, now]);
    return res.insertId;
}

async function getOpenTickets() {
    return await query('SELECT * FROM support_tickets WHERE status IN ("open", "replied") ORDER BY created_at DESC');
}

async function replyToTicket(ticketId, message) {
    const now = Date.now();
    await query('UPDATE support_tickets SET status=?, updated_at=? WHERE id=?', ['replied', now, ticketId]);
}

async function closeTicket(ticketId) {
    await query('UPDATE support_tickets SET status=? WHERE id=?', ['closed', ticketId]);
}

// ===== دوال مساعدة =====
function getUserIp(msg) {
    return msg.from.is_bot ? null : (msg.from.id ? `user_${msg.from.id}` : null);
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString('ar-SA');
}

function getUserDisplayName(user) {
    if (user.name) return user.name;
    if (user.username) return `@${user.username}`;
    return user.id;
}

// ===== الرسائل الترحيبية =====
const USER_WELCOME = `🤖 *مرحباً بك في بوت التواصل العام!*

يمكنك استخدام البوت للأغراض التالية:

📢 *مراسلة الجميع*: أرسل رسالتك وستصل لكل الأعضاء باسمك
💬 *عرض آخر الرسائل*: شاهد آخر الرسائل المرسلة
👥 *المجموعات*: عرض المجموعات التي فيها البوت
🔍 *معرفة الـIP الخاص بي*
🗑️ *مسح محادثتك* مع البوت

للمطور فقط: لوحة تحكم كاملة عبر /start.
`;

const USER_BUTTONS = {
    inline_keyboard: [
        [{ text: '📢 مراسلة الجميع', callback_data: 'user_broadcast' }],
        [{ text: '💬 آخر الرسائل', callback_data: 'view_broadcasts' }],
        [{ text: '👥 المجموعات', callback_data: 'user_groups' }, { text: '🔍 IP الخاص بي', callback_data: 'user_myip' }]
    ]
};

// ===== تشغيل البوت =====
let bot = null;
let developerState = {};

async function startBot() {
    await createPool();
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('🤖 Bot started (broadcast bot)');

    // أوامر البوت
    await bot.setMyCommands([
        { command: 'start', description: '🏠 الرئيسية' },
        { command: 'help', description: '❓ المساعدة' },
        { command: 'broadcast', description: '📢 مراسلة الجميع' },
        { command: 'myip', description: '🔍 عرض IP الخاص بك' },
        { command: 'groups', description: '👥 المجموعات' }
    ]);

    // ===== معالج الأوامر =====
    bot.onText(/^\/(start|panel)$/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        const ip = getUserIp(msg);
        
        // تحديث بيانات المستخدم أولاً
        await updateUserData(userId, msg.from.username, fullName, ip);

        // التحقق من أنه المطور
        if (chatId.toString() === DEVELOPER_ID || userId.toString() === DEVELOPER_ID) {
            await sendMainMenu(chatId);
            return;
        }

        // إذا لم يكن المطور، عرض الترحيب العادي
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
        await bot.sendMessage(msg.chat.id, '📢 *وضع مراسلة الجميع*\n\nأرسل الآن الرسالة التي تريد نشرها لكل الأعضاء.\n(لإلغاء اكتب /cancel)', { parse_mode: 'Markdown' });
    });

    bot.onText(/^\/myip$/, async (msg) => {
        const userId = msg.from.id;
        const rows = await query('SELECT ip FROM users WHERE id=?', [String(userId)]);
        const ip = rows.length ? rows[0].ip : 'غير محدد';
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
            await bot.sendMessage(chatId, '📢 *وضع مراسلة الجميع*\n\nأرسل الآن الرسالة التي تريد نشرها.', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'view_broadcasts') {
            const broadcasts = await getBroadcasts(10);
            if (broadcasts.length === 0) {
                await bot.sendMessage(chatId, '📭 لا يوجد رسائل بعد.');
                return;
            }
            let text = '📢 *آخر الرسائل:*\n\n';
            for (const b of broadcasts) {
                text += `👤 من: ${b.sender_name}\n📝 ${b.content.substring(0, 100)}${b.content.length > 100 ? '...' : ''}\n🕒 ${formatTime(b.ts)}\n\n─────────────────\n`;
            }
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
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
            const rows = await query('SELECT ip FROM users WHERE id=?', [String(userId)]);
            const ip = rows.length ? rows[0].ip : 'غير محدد';
            await bot.sendMessage(chatId, `🔍 *IP الخاص بك:*\n\`${ip}\``, { parse_mode: 'Markdown' });
            return;
        }

        // أزرار المطور (التحقق من الصلاحية)
        if (chatId.toString() !== DEVELOPER_ID && userId.toString() !== DEVELOPER_ID) return;

        // معالجة أزرار لوحة المطور
        if (data === 'main_menu') {
            await sendMainMenu(chatId, msgId);
        } else if (data.startsWith('list_users_')) {
            const page = parseInt(data.split('_')[2]) || 1;
            const { buttons, total } = await buildUserButtons('view_user', page);
            const text = `📊 *المستخدمين* (${total})\n\nاضغط لعرض التفاصيل:`;
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        } else if (data.startsWith('view_user_') && !data.includes('page')) {
            const targetId = data.replace('view_user_', '');
            const u = await getUser(targetId);
            if (!u) {
                await bot.sendMessage(chatId, '❌ غير موجود');
                return;
            }
            const dt = `👤 *تفاصيل المستخدم*\n\n📝 ${u.name || '-'}\n🔗 ${u.username ? '@' + u.username : '-'}\n🆔 \`${u.id}\`\n📨 ${u.messages_count || 0} رسالة\n🕒 آخر ظهور: ${formatTime(u.last_seen)}\n🌐 IP: \`${u.ip || 'غير محدد'}\`\n🚫 ${u.banned ? 'محظور' : 'لا'}\n🔇 ${u.muted ? 'مكتوم' : 'لا'}`;
            const buttons = [
                [{ text: '🚫 حظر', callback_data: `do_ban_${targetId}` }, { text: '✅ رفع حظر', callback_data: `do_unban_${targetId}` }],
                [{ text: '🔇 كتم', callback_data: `do_mute_${targetId}` }, { text: '🔊 رفع كتم', callback_data: `do_unmute_${targetId}` }],
                [{ text: '👢 طرد', callback_data: `do_kick_${targetId}` }],
                [{ text: '🔙 رجوع', callback_data: 'list_users_1' }]
            ];
            await bot.editMessageText(dt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
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
            for (const b of broadcasts) {
                text += `👤 من: ${b.sender_name}\n📝 ${b.content.substring(0, 100)}${b.content.length > 100 ? '...' : ''}\n🕒 ${formatTime(b.ts)}\n\n`;
            }
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
        } else if (data === 'stats') {
            const allUsers = await getAllUsers();
            const total = allUsers.length;
            const banned = allUsers.filter(u => u.banned).length;
            const muted = allUsers.filter(u => u.muted).length;
            const msgs = allUsers.reduce((s, u) => s + (u.messages_count || 0), 0);
            const groups = await getAllGroups();
            const broadcasts = await getBroadcasts(100);
            const statsText = `📈 *إحصائيات البوت*\n\n👥 المستخدمين: ${total}\n🚫 محظور: ${banned}\n🔇 مكتوم: ${muted}\n💬 إجمالي الرسائل: ${msgs}\n👥 المجموعات: ${groups.length}\n📢 عدد البث العام: ${broadcasts.length}`;
            await bot.editMessageText(statsText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
        }
    });

    // ===== معالجة الرسائل النصية =====
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

        // التحقق من الحظر للمستخدمين العاديين
        if (isPrivate) {
            const user = await getUser(userId);
            if (user && user.banned) {
                await bot.sendMessage(chatId, '⛔ أنت محظور من استخدام البوت.');
                return;
            }
        }

        // معالجة حالة البث
        const state = userState.get(userId);
        if (state && state.action === 'broadcast' && isPrivate) {
            const content = text || '📎 مرفق (صورة/ملف)';
            const user = await getUser(userId);
            const senderName = user ? (user.name || user.username || user.id) : userId;

            // إنشاء البث
            await createBroadcast(userId, senderName, content);

            // إرسال البث لجميع المستخدمين
            const allUsers = await getAllUsers();
            let sent = 0;
            for (const u of allUsers) {
                if (u.banned || u.id === String(userId)) continue;
                try {
                    await bot.sendMessage(u.id, `📢 *رسالة عامة من ${senderName}:*\n\n${content}`, { parse_mode: 'Markdown' });
                    sent++;
                } catch (e) { console.error(`فشل إرسال البث للمستخدم ${u.id}:`, e.message); }
            }
            await bot.sendMessage(chatId, `✅ تم إرسال رسالتك إلى ${sent} مستخدم.`);
            userState.delete(userId);
            return;
        }

        // رسالة عادية
        if (isPrivate && text && !state) {
            await bot.sendMessage(chatId, '📨 تم استلام رسالتك. استخدم الأزرار للمراسلة أو أرسل /broadcast للبث العام.');
        }
    });

    // ===== رصد إضافة البوت إلى مجموعة =====
    bot.on('new_chat_members', async (msg) => {
        for (const member of msg.new_chat_members) {
            if (member.id === (await bot.getMe()).id) {
                const chatId = msg.chat.id;
                const title = msg.chat.title || '';
                try {
                    const admins = await bot.getChatAdministrators(chatId);
                    const adminsJson = JSON.stringify(admins.map(a => ({ id: a.user.id, first_name: a.user.first_name, last_name: a.user.last_name })));
                    const memberCount = await bot.getChatMembersCount(chatId);
                    await addOrUpdateGroup(chatId, title, memberCount, adminsJson);
                    await bot.sendMessage(chatId, '🤖 مرحباً! تم إضافة البوت. يمكنكم التواصل العام بين الأعضاء.');
                } catch (e) { console.error('خطأ في جلب معلومات المجموعة:', e.message); }
            }
        }
    });

    console.log('✅ البوت جاهز للبث العام');
}

// ===== دوال لوحة التحكم =====
async function buildUserButtons(action, page = 1) {
    const allUsers = await getAllUsers();
    const perPage = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    const start = (page - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);
    const buttons = [];
    for (const u of pageUsers) {
        let label = `👤 ${u.name || 'بدون اسم'}`;
        if (u.username) label += ` @${u.username}`;
        buttons.push([{ text: label, callback_data: `${action}_${u.id}` }]);
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: `list_users_${page-1}` });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: `list_users_${page+1}` });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
    return { buttons, total: allUsers.length };
}

async function sendMainMenu(chatId, msgId = null) {
    const allUsers = await getAllUsers();
    const total = allUsers.length;
    const banned = allUsers.filter(u => u.banned).length;
    const muted = allUsers.filter(u => u.muted).length;
    const groups = await getAllGroups();
    const broadcasts = await getBroadcasts(100);
    const text = `🎛️ *لوحة التحكم*\n\n📊 الإحصائيات:\n👥 المستخدمين: ${total}\n🚫 محظور: ${banned}\n🔇 مكتوم: ${muted}\n👥 المجموعات: ${groups.length}\n📢 البث العام: ${broadcasts.length}`;
    const buttons = [
        [{ text: '👥 المستخدمين', callback_data: 'list_users_1' }],
        [{ text: '📢 البث العام', callback_data: 'broadcasts_list' }],
        [{ text: '📈 الإحصائيات', callback_data: 'stats' }]
    ];
    if (msgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

// ===== Express server مع keep-alive =====
const app = express();
app.get('/', (req, res) => res.send('Broadcast bot running!'));
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
