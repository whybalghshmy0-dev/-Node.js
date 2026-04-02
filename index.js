const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var developerId = '7411444902';

// ===== قائمة الأدمنية (يمكن إضافة أكثر من أدمن) =====
var adminIds = [developerId]; // المطور دائماً أدمن + أي أدمن يضيفه

function isAdmin(userId) {
    return adminIds.indexOf(String(userId)) !== -1;
}

function isDeveloper(userId) {
    return String(userId) === developerId;
}

// ===== إعدادات قاعدة البيانات =====
var DB_CONFIG = {
    host: 'sql5.freesqldatabase.com',
    user: 'sql5822025',
    password: 'UHrehHF1CU',
    database: 'sql5822025',
    port: 3306,
    connectTimeout: 20000,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

var pool = null;

// ===== إنشاء Pool الاتصال =====
async function createPool() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        console.log('✅ تم إنشاء pool قاعدة البيانات');
        await initDB();
    } catch (e) {
        console.error('❌ خطأ في إنشاء pool:', e.message);
        setTimeout(createPool, 5000);
    }
}

// ===== تهيئة الجداول =====
async function initDB() {
    try {
        var conn = await pool.getConnection();

        // جدول المستخدمين
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(255) DEFAULT '',
                name VARCHAR(500) DEFAULT '',
                nickname VARCHAR(255) DEFAULT NULL,
                first_seen BIGINT DEFAULT 0,
                last_seen BIGINT DEFAULT 0,
                messages_count INT DEFAULT 0,
                banned TINYINT(1) DEFAULT 0,
                muted TINYINT(1) DEFAULT 0,
                is_admin TINYINT(1) DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
        try { await conn.execute('ALTER TABLE users ADD COLUMN nickname VARCHAR(255) DEFAULT NULL'); } catch(e) {}
        try { await conn.execute('ALTER TABLE users ADD COLUMN is_admin TINYINT(1) DEFAULT 0'); } catch(e) {}

        // جدول الرسائل العامة (المجتمع)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS community_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                sender_name VARCHAR(500) DEFAULT '',
                sender_username VARCHAR(255) DEFAULT '',
                content TEXT NOT NULL,
                media_type VARCHAR(50) DEFAULT NULL,
                file_id TEXT DEFAULT NULL,
                reply_to_id INT DEFAULT NULL,
                deleted TINYINT(1) DEFAULT 0,
                ts BIGINT DEFAULT 0,
                INDEX idx_ts (ts),
                INDEX idx_sender (sender_id),
                INDEX idx_reply (reply_to_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
        try { await conn.execute('ALTER TABLE users ADD COLUMN deleted TINYINT(1) DEFAULT 0'); } catch(e) {}

        // جدول ربط رسائل التيليغرام بالرسائل المجتمعية
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS message_delivery (
                id INT AUTO_INCREMENT PRIMARY KEY,
                community_msg_id INT NOT NULL,
                user_id VARCHAR(50) NOT NULL,
                tg_message_id INT NOT NULL,
                INDEX idx_cmid (community_msg_id),
                INDEX idx_uid (user_id),
                INDEX idx_tgmid (tg_message_id, user_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول الأدمنية
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS admins (
                user_id VARCHAR(50) PRIMARY KEY,
                added_by VARCHAR(50) NOT NULL,
                added_at BIGINT DEFAULT 0,
                permissions TEXT DEFAULT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // تحميل الأدمنية من قاعدة البيانات
        var [adminRows] = await conn.execute('SELECT user_id FROM admins');
        for (var i = 0; i < adminRows.length; i++) {
            if (adminIds.indexOf(adminRows[i].user_id) === -1) {
                adminIds.push(adminRows[i].user_id);
            }
        }

        conn.release();
        console.log('✅ تم تهيئة جداول قاعدة البيانات');
        console.log('👮 الأدمنية:', adminIds);
    } catch (e) {
        console.error('❌ خطأ في تهيئة الجداول:', e.message);
    }
}

// ===== دالة تنفيذ استعلام =====
async function query(sql, params) {
    var maxRetries = 3;
    for (var i = 0; i < maxRetries; i++) {
        try {
            var [rows] = await pool.execute(sql, params || []);
            return rows;
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            await new Promise(function(r) { setTimeout(r, 1000 * (i + 1)); });
        }
    }
}

// ===== دوال المستخدمين =====
async function getUser(userId) {
    try {
        var rows = await query('SELECT * FROM users WHERE id = ?', [String(userId)]);
        if (rows.length === 0) return null;
        var u = rows[0];
        u.banned = u.banned === 1;
        u.muted = u.muted === 1;
        u.is_admin = u.is_admin === 1;
        return u;
    } catch (e) { return null; }
}

async function getAllUsers() {
    try {
        var rows = await query('SELECT * FROM users ORDER BY last_seen DESC', []);
        return rows.map(function(u) { u.banned = u.banned === 1; u.muted = u.muted === 1; u.is_admin = u.is_admin === 1; return u; });
    } catch (e) { return []; }
}

async function updateUserData(userId, userName, fullName) {
    var now = Date.now();
    try {
        var existing = await getUser(userId);
        if (!existing) {
            await query(
                'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, banned, muted, is_admin) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0)',
                [String(userId), userName || '', fullName || '', now, now]
            );
        } else {
            await query(
                'UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=? WHERE id=?',
                [now, userName || existing.username || '', fullName || existing.name || '', String(userId)]
            );
        }
    } catch (e) { console.error('updateUserData error:', e.message); }
}

async function setUserField(userId, field, value) {
    try { await query('UPDATE users SET ' + field + '=? WHERE id=?', [value, String(userId)]); } catch (e) {}
}

async function deleteUser(userId) {
    try { await query('DELETE FROM users WHERE id=?', [String(userId)]); } catch (e) {}
}

// ===== دوال الأدمنية =====
async function addAdmin(userId, addedBy) {
    try {
        await query('INSERT IGNORE INTO admins (user_id, added_by, added_at) VALUES (?, ?, ?)', [String(userId), String(addedBy), Date.now()]);
        await setUserField(userId, 'is_admin', 1);
        if (adminIds.indexOf(String(userId)) === -1) adminIds.push(String(userId));
        return true;
    } catch (e) { return false; }
}

async function removeAdmin(userId) {
    try {
        await query('DELETE FROM admins WHERE user_id=?', [String(userId)]);
        await setUserField(userId, 'is_admin', 0);
        var idx = adminIds.indexOf(String(userId));
        if (idx > -1 && String(userId) !== developerId) adminIds.splice(idx, 1);
        return true;
    } catch (e) { return false; }
}

async function getAdminList() {
    try { return await query('SELECT a.*, u.name, u.username FROM admins a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.added_at DESC'); } catch (e) { return []; }
}

// ===== دوال الرسائل المجتمعية =====
async function saveCommunityMessage(senderId, senderName, senderUsername, content, mediaType, fileId, replyToId) {
    var now = Date.now();
    try {
        var result = await query(
            'INSERT INTO community_messages (sender_id, sender_name, sender_username, content, media_type, file_id, reply_to_id, deleted, ts) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
            [String(senderId), senderName || '', senderUsername || '', content || '', mediaType || null, fileId || null, replyToId || null, now]
        );
        return result.insertId;
    } catch (e) { console.error('saveCommunityMessage error:', e.message); return null; }
}

async function getCommunityMessages(limit, offset) {
    try {
        return await query(
            'SELECT * FROM community_messages WHERE deleted=0 ORDER BY ts DESC LIMIT ? OFFSET ?',
            [limit || 20, offset || 0]
        );
    } catch (e) { return []; }
}

async function getCommunityMessage(msgId) {
    try {
        var rows = await query('SELECT * FROM community_messages WHERE id=?', [msgId]);
        return rows[0] || null;
    } catch (e) { return null; }
}

async function saveDelivery(communityMsgId, userId, tgMessageId) {
    try {
        await query(
            'INSERT INTO message_delivery (community_msg_id, user_id, tg_message_id) VALUES (?, ?, ?)',
            [communityMsgId, String(userId), tgMessageId]
        );
    } catch (e) {}
}

async function getDeliveryByCommunityMsgId(communityMsgId) {
    try {
        return await query('SELECT * FROM message_delivery WHERE community_msg_id=?', [communityMsgId]);
    } catch (e) { return []; }
}

async function getCommunityMsgIdByTgMsg(tgMessageId, userId) {
    try {
        var rows = await query(
            'SELECT community_msg_id FROM message_delivery WHERE tg_message_id=? AND user_id=?',
            [tgMessageId, String(userId)]
        );
        return rows[0] ? rows[0].community_msg_id : null;
    } catch (e) { return null; }
}

// ===== حذف رسالة من الكل =====
async function deleteCommunityMessage(communityMsgId) {
    try {
        // علّم الرسالة كمحذوفة
        await query('UPDATE community_messages SET deleted=1 WHERE id=?', [communityMsgId]);

        // احذف الرسالة من كل المستخدمين على تيليجرام
        var deliveries = await getDeliveryByCommunityMsgId(communityMsgId);
        var deleted = 0;
        for (var i = 0; i < deliveries.length; i++) {
            try {
                await bot.deleteMessage(deliveries[i].user_id, deliveries[i].tg_message_id);
                deleted++;
            } catch (e) {}
        }
        return { total: deliveries.length, deleted: deleted };
    } catch (e) { return { total: 0, deleted: 0 }; }
}

// ===== حذف كل رسائل البوت من عند شخص معين =====
async function deleteAllMessagesForUser(targetUserId) {
    try {
        var deliveries = await query('SELECT tg_message_id FROM message_delivery WHERE user_id=?', [String(targetUserId)]);
        var deleted = 0;
        for (var i = 0; i < deliveries.length; i++) {
            try {
                await bot.deleteMessage(targetUserId, deliveries[i].tg_message_id);
                deleted++;
            } catch (e) {}
        }
        // حذف سجلات التسليم
        await query('DELETE FROM message_delivery WHERE user_id=?', [String(targetUserId)]);
        return { total: deliveries.length, deleted: deleted };
    } catch (e) { return { total: 0, deleted: 0 }; }
}

// ===== تحديث وصف البوت بعدد المستخدمين =====
async function updateBotDescription() {
    try {
        var allUsers = await getAllUsers();
        var activeCount = allUsers.filter(function(u) { return !u.banned; }).length;
        var desc = '👥 ' + activeCount.toLocaleString('ar') + ' مستخدم نشط\n\n'
            + '🌐 مجتمع تواصل مجهول - أرسل رسالتك وتصل للجميع!\n'
            + '🔒 خصوصيتك محمية - يظهر اسمك المستعار فقط';
        await bot.setMyDescription(desc);
        var shortDesc = '👥 ' + activeCount.toLocaleString('ar') + ' مستخدم شهرياً';
        await bot.setMyShortDescription(shortDesc);
        console.log('✅ تم تحديث وصف البوت: ' + activeCount + ' مستخدم');
    } catch (e) {
        console.log('⚠️ تعذر تحديث وصف البوت:', e.message);
    }
}

// ===== دوال مساعدة =====
function formatTime(ts) {
    return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserDisplayName(u) {
    var n = u.name || 'مجهول';
    if (u.username) n += ' (@' + u.username + ')';
    return n;
}

function getSenderAlias(senderId, senderName, nickname) {
    if (nickname && nickname.trim()) return nickname.trim();
    var firstName = (senderName || 'عضو').split(' ')[0];
    var idStr = String(senderId);
    var suffix = idStr.slice(-2);
    return firstName + '#' + suffix;
}

async function isNicknameTaken(nickname, excludeUserId) {
    try {
        var rows = await query(
            'SELECT id FROM users WHERE LOWER(nickname)=LOWER(?) AND id!=?',
            [nickname.trim(), String(excludeUserId)]
        );
        return rows.length > 0;
    } catch(e) { return false; }
}

// ===== طلب الاسم المستعار =====
async function askForNickname(chatId, userId, isFirst, editMsgId) {
    pendingNickname[chatId] = true;
    var text = isFirst
        ? '🌟 *أهلاً بك!*\n\n'
          + 'قبل البدء، اختر اسماً مستعاراً سيظهر للجميع عند مراسلتك:\n\n'
          + '✅ يجب أن يكون فريداً (لم يستخدمه أحد)\n'
          + '✅ بين 3-20 حرفاً\n'
          + '✅ يمكن تغييره لاحقاً بأمر /nickname\n\n'
          + '✏️ *اكتب اسمك المستعار الآن:*'
        : '✏️ *تغيير الاسم المستعار*\n\n'
          + 'اكتب اسمك الجديد (3-20 حرف):'
    ;
    var kb = { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_nickname' }]] };
    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }); return; } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function handleNicknameInput(chatId, userId, text) {
    if (!text || typeof text !== 'string') {
        await bot.sendMessage(chatId, '⚠️ يرجى إرسال نص فقط كاسم مستعار.');
        pendingNickname[chatId] = true;
        return;
    }
    var nick = text.trim();
    if (nick.length < 3 || nick.length > 20) {
        await bot.sendMessage(chatId, '⚠️ الاسم يجب أن يكون بين 3 و 20 حرفاً. حاول مرة أخرى:');
        pendingNickname[chatId] = true;
        return;
    }
    if (/[<>"'`]/.test(nick)) {
        await bot.sendMessage(chatId, '⚠️ الاسم يحتوي على رموز غير مسموحة. حاول مرة أخرى:');
        pendingNickname[chatId] = true;
        return;
    }
    var taken = await isNicknameTaken(nick, userId);
    if (taken) {
        await bot.sendMessage(chatId, '⚠️ هذا الاسم مستخدم بالفعل. اختر اسماً آخر:');
        pendingNickname[chatId] = true;
        return;
    }
    await setUserField(userId, 'nickname', nick);
    await sendWelcomeMenu(chatId, nick);
}

async function sendWelcomeMenu(chatId, nickname) {
    var text = '🌟 أهلاً *' + nickname + '*!\n\n'
        + 'اسمك المستعار: *' + nickname + '*\n'
        + 'أي رسالة تكتبها ستصل لجميع الأعضاء باسمك هذا.\n\n'
        + '⬇️ اختر ما تريد:';
    var kb = { inline_keyboard: [
        [{ text: '📰 آخر رسائل المجتمع', callback_data: 'view_feed_1' }],
        [{ text: '✏️ تغيير اسمك المستعار', callback_data: 'change_nickname' }],
        [{ text: 'ℹ️ كيف يعمل البوت؟', callback_data: 'how_it_works' }]
    ]};
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ===== تشغيل البوت =====
var bot = null;
var developerState = {};
var pendingReplies = {};
var pendingNickname = {};

async function startBot() {
    await createPool();

    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('🤖 بوت التواصل يعمل...');

    bot.setMyCommands([
        { command: 'start', description: '🏠 ابدأ من هنا' },
        { command: 'feed', description: '📰 عرض آخر الرسائل' },
        { command: 'nickname', description: '✏️ تغيير اسمك المستعار' }
    ]).catch(function(e) {});

    // تحديث وصف البوت بعدد المستخدمين عند التشغيل
    setTimeout(function() { updateBotDescription(); }, 5000);
    // تحديث كل ساعة
    setInterval(function() { updateBotDescription(); }, 60 * 60 * 1000);

    // ===== /start =====
    bot.onText(/^\/(start|panel)$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;

        if (isAdmin(userId)) {
            developerState[chatId] = {};
            await sendMainMenu(chatId);
            return;
        }

        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        await updateUserData(userId, msg.from.username, fullName);
        var user = await getUser(userId);

        if (!user || !user.nickname) {
            await askForNickname(chatId, userId, true);
            return;
        }

        await sendWelcomeMenu(chatId, user.nickname);
    });

    // ===== /nickname =====
    bot.onText(/^\/nickname$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        if (isAdmin(userId)) return;
        await askForNickname(chatId, userId, false);
    });

    // ===== /feed =====
    bot.onText(/^\/feed$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        if (isAdmin(userId)) return;
        await showFeed(chatId, 1);
    });

    // ===== معالجة أزرار =====
    bot.on('callback_query', async function(cbq) {
        var chatId = cbq.message.chat.id;
        var userId = cbq.from.id;
        var msgId = cbq.message.message_id;
        var data = cbq.data;

        await bot.answerCallbackQuery(cbq.id).catch(function() {});

        // ===== أزرار الأدمن/المطور =====
        if (isAdmin(userId)) {
            await handleDeveloperCallback(chatId, userId, msgId, data);
            return;
        }

        // ===== أزرار المستخدم =====
        try {
            if (data === 'change_nickname') {
                await askForNickname(chatId, userId, false, msgId);
                return;
            }

            if (data === 'cancel_nickname') {
                delete pendingNickname[chatId];
                var userNick = await getUser(userId);
                if (userNick && userNick.nickname) {
                    await sendWelcomeMenu(chatId, userNick.nickname);
                } else {
                    await bot.sendMessage(chatId, '⚠️ يجب اختيار اسم مستعار للمتابعة. أرسل /start للبدء.');
                }
                return;
            }

            if (data === 'how_it_works') {
                await bot.sendMessage(chatId,
                    'ℹ️ *كيف يعمل البوت؟*\n\n'
                    + '1️⃣ اختر اسمك المستعار عند أول دخول\n'
                    + '2️⃣ اكتب رسالتك مباشرة وتصل لجميع الأعضاء\n'
                    + '3️⃣ أي عضو يضغط "رد" يرد عليك\n'
                    + '4️⃣ ردوده تصلك وتصل للجميع\n\n'
                    + '🔒 *الخصوصية:*\n'
                    + 'يظهر اسمك المستعار الذي اخترته فقط\n'
                    + 'لا يُكشف رقمك أو معلوماتك الحقيقية لأحد',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'back_home' }]] } }
                );
                return;
            }

            if (data === 'back_home') {
                var fullName2 = ((cbq.from.first_name || '') + ' ' + (cbq.from.last_name || '')).trim();
                await updateUserData(userId, cbq.from.username, fullName2);
                var userNow = await getUser(userId);
                var nickNow = userNow ? userNow.nickname : null;
                if (!nickNow) { await askForNickname(chatId, userId, true, msgId); return; }
                var welcomeText2 = '👋 *أهلاً ' + nickNow + '!*\n\nاختر ما تريد:';
                var kb2 = { inline_keyboard: [
                    [{ text: '✉️ إرسال رسالة للمجتمع', callback_data: 'compose_msg' }],
                    [{ text: '📰 آخر رسائل المجتمع', callback_data: 'view_feed_1' }],
                    [{ text: '✏️ تغيير اسمك المستعار', callback_data: 'change_nickname' }],
                    [{ text: 'ℹ️ كيف يعمل البوت؟', callback_data: 'how_it_works' }]
                ]};
                try { await bot.editMessageText(welcomeText2, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kb2 }); } catch (e) { await bot.sendMessage(chatId, welcomeText2, { parse_mode: 'Markdown', reply_markup: kb2 }); }
                return;
            }

            if (data === 'compose_msg' || data === 'cancel_compose') {
                try { await bot.editMessageText('💬 فقط اكتب رسالتك مباشرة وستصل للجميع!', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'back_home' }]] } }); } catch (e) {}
                return;
            }

            if (data.startsWith('view_feed_')) {
                var page = parseInt(data.replace('view_feed_', '')) || 1;
                await showFeed(chatId, page, msgId);
                return;
            }

            if (data.startsWith('reply_msg_')) {
                var communityMsgId = parseInt(data.replace('reply_msg_', ''));
                var origMsg = await getCommunityMessage(communityMsgId);
                if (!origMsg) { await bot.sendMessage(chatId, '⚠️ الرسالة غير موجودة.'); return; }
                if (origMsg.deleted) { await bot.sendMessage(chatId, '⚠️ هذه الرسالة تم حذفها.'); return; }
                pendingReplies[chatId] = { type: 'reply', replyToId: communityMsgId };
                var alias = getSenderAlias(origMsg.sender_id, origMsg.sender_name);
                var preview = (origMsg.content || '[وسائط]').substring(0, 80);
                await bot.sendMessage(chatId,
                    '↩️ *الرد على رسالة:*\n'
                    + '👤 ' + alias + '\n'
                    + '💬 ' + preview + (preview.length >= 80 ? '...' : '') + '\n\n'
                    + '✏️ اكتب ردك الآن:',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_compose' }]] } }
                );
                return;
            }

        } catch (err) {
            console.error('خطأ callback مستخدم:', err.message);
        }
    });

    // ===== معالجة الرسائل =====
    bot.on('message', async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        var userName = msg.from.username || '';
        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        if (msg.text && msg.text.startsWith('/')) return;

        // ===== الأدمن/المطور =====
        if (isAdmin(userId)) {
            await handleDeveloperMessage(chatId, msg);
            return;
        }

        // ===== المستخدم العادي =====
        await updateUserData(userId, userName, fullName);
        var user = await getUser(userId);
        if (user && user.banned) { await bot.sendMessage(chatId, '⛔ أنت محظور من استخدام البوت.'); return; }
        if (user && user.muted) return;

        if (pendingNickname[chatId]) {
            delete pendingNickname[chatId];
            await handleNicknameInput(chatId, userId, msg.text);
            return;
        }

        if (!user || !user.nickname) {
            await askForNickname(chatId, userId, true);
            return;
        }

        var pending = pendingReplies[chatId];
        if (pending) {
            delete pendingReplies[chatId];
            await handleUserPost(msg, userId, userName, fullName, pending);
            return;
        }

        await handleUserPost(msg, userId, userName, fullName, { type: 'new' });
    });

    console.log('✅ البوت جاهز ويستقبل الرسائل');
}

// ===== معالجة نشر رسالة مستخدم =====
async function handleUserPost(msg, userId, userName, fullName, pending) {
    var chatId = msg.chat.id;

    var content = msg.text || msg.caption || '';
    var mediaType = null;
    var fileId = null;

    if (msg.photo) { mediaType = 'photo'; fileId = msg.photo[msg.photo.length - 1].file_id; }
    else if (msg.video) { mediaType = 'video'; fileId = msg.video.file_id; }
    else if (msg.audio) { mediaType = 'audio'; fileId = msg.audio.file_id; }
    else if (msg.voice) { mediaType = 'voice'; fileId = msg.voice.file_id; }
    else if (msg.document) { mediaType = 'document'; fileId = msg.document.file_id; }
    else if (msg.sticker) { mediaType = 'sticker'; fileId = msg.sticker.file_id; content = content || ''; }
    else if (msg.video_note) { mediaType = 'video_note'; fileId = msg.video_note.file_id; }

    if (!content && !fileId) {
        await bot.sendMessage(chatId, '⚠️ لا يمكن إرسال رسالة فارغة.');
        return;
    }

    var replyToId = (pending.type === 'reply') ? pending.replyToId : null;

    var communityMsgId = await saveCommunityMessage(userId, fullName, userName, content, mediaType, fileId, replyToId);
    if (!communityMsgId) {
        await bot.sendMessage(chatId, '⚠️ حدث خطأ في حفظ الرسالة. حاول مرة أخرى.');
        return;
    }

    var result = await broadcastCommunityMessage(communityMsgId, userId);
    // تأكيد للمرسل
    await bot.sendMessage(chatId, '✅ تم إرسال رسالتك لـ ' + result.sent + ' عضو', {
        reply_markup: { inline_keyboard: [[{ text: '🗑️ حذف رسالتي', callback_data: 'user_delete_msg_' + communityMsgId }]] }
    });
}

// ===== بث رسالة مجتمعية لجميع الأعضاء =====
async function broadcastCommunityMessage(communityMsgId, senderUserId) {
    var msgData = await getCommunityMessage(communityMsgId);
    if (!msgData) return { sent: 0 };

    var allUsers = await getAllUsers();
    var senderUser = await getUser(msgData.sender_id);
    var alias = getSenderAlias(msgData.sender_id, msgData.sender_name, senderUser ? senderUser.nickname : null);

    var header = '';
    if (msgData.reply_to_id) {
        var origMsg = await getCommunityMessage(msgData.reply_to_id);
        if (origMsg) {
            var origSenderUser = await getUser(origMsg.sender_id);
            var origAlias = getSenderAlias(origMsg.sender_id, origMsg.sender_name, origSenderUser ? origSenderUser.nickname : null);
            var origPreview = (origMsg.content || '[وسائط]').substring(0, 60);
            header = '↩️ *رد على ' + origAlias + ':*\n_' + origPreview + (origPreview.length >= 60 ? '...' : '') + '_\n\n';
        }
    }

    var timeStr = formatTime(msgData.ts);
    var footer = '\n\n👤 *' + alias + '* | 🕒 ' + timeStr;

    var replyBtn = [{ text: '↩️ رد', callback_data: 'reply_msg_' + communityMsgId }];
    var kb = { inline_keyboard: [replyBtn] };

    var sent = 0;
    for (var i = 0; i < allUsers.length; i++) {
        var u = allUsers[i];
        if (u.banned || u.muted) continue;
        if (u.id === String(senderUserId)) continue;

        try {
            var sentMsg = null;
            if (!msgData.media_type || msgData.media_type === null) {
                var textToSend = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendMessage(u.id, textToSend, { parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'photo') {
                var cap = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendPhoto(u.id, msgData.file_id, { caption: cap, parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'video') {
                var cap2 = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendVideo(u.id, msgData.file_id, { caption: cap2, parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'audio') {
                var cap3 = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendAudio(u.id, msgData.file_id, { caption: cap3, parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'voice') {
                sentMsg = await bot.sendVoice(u.id, msgData.file_id, { caption: header + footer, parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'document') {
                var cap4 = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendDocument(u.id, msgData.file_id, { caption: cap4, parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'sticker') {
                sentMsg = await bot.sendSticker(u.id, msgData.file_id);
                // أرسل رسالة إضافية مع زر الرد للملصقات
                await bot.sendMessage(u.id, '👤 *' + alias + '* | 🕒 ' + timeStr, { parse_mode: 'Markdown', reply_markup: kb });
            } else if (msgData.media_type === 'video_note') {
                sentMsg = await bot.sendVideoNote(u.id, msgData.file_id);
                await bot.sendMessage(u.id, '👤 *' + alias + '* | 🕒 ' + timeStr, { parse_mode: 'Markdown', reply_markup: kb });
            } else {
                var capDef = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendMessage(u.id, capDef, { parse_mode: 'Markdown', reply_markup: kb });
            }

            if (sentMsg) {
                await saveDelivery(communityMsgId, u.id, sentMsg.message_id);
                sent++;
            }
        } catch (e) {
            console.log('فشل الإرسال للمستخدم ' + u.id + ': ' + e.message);
        }
    }

    // إرسال للأدمنية (للمراقبة)
    for (var a = 0; a < adminIds.length; a++) {
        try {
            var devText = '📨 *رسالة #' + communityMsgId + '*\n'
                + '👤 ' + alias + ' | ID: `' + senderUserId + '`\n'
                + '🕒 ' + formatTime(msgData.ts) + '\n'
                + (msgData.reply_to_id ? '↩️ رد على #' + msgData.reply_to_id + '\n' : '')
                + '💬 ' + (msgData.content || '[وسائط: ' + msgData.media_type + ']').substring(0, 300);
            var devKb = { inline_keyboard: [
                [{ text: '🗑️ حذف من الكل', callback_data: 'dev_delete_msg_' + communityMsgId }],
                [{ text: '🔨 حظر المرسل', callback_data: 'dev_do_ban_' + senderUserId }]
            ]};
            await bot.sendMessage(adminIds[a], devText, { parse_mode: 'Markdown', reply_markup: devKb });
            if (msgData.media_type && msgData.file_id) {
                await bot.forwardMessage(adminIds[a], senderUserId, msg ? msg.message_id : 0).catch(function(){});
            }
        } catch (e) {}
    }

    return { sent: sent };
}

// ===== عرض آخر رسائل المجتمع =====
async function showFeed(chatId, page, editMsgId) {
    var perPage = 5;
    var offset = (page - 1) * perPage;
    var msgs = await getCommunityMessages(perPage, offset);

    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE deleted=0', []);
    var total = totalRows[0] ? totalRows[0].cnt : 0;
    var totalPages = Math.ceil(total / perPage) || 1;

    if (msgs.length === 0) {
        var emptyText = '📰 *آخر رسائل المجتمع*\n\n📭 لا توجد رسائل بعد.\nكن أول من يرسل!';
        var emptyKb = { inline_keyboard: [[{ text: '✉️ إرسال رسالة', callback_data: 'compose_msg' }]] };
        if (editMsgId) { try { await bot.editMessageText(emptyText, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: emptyKb }); return; } catch (e) {} }
        await bot.sendMessage(chatId, emptyText, { parse_mode: 'Markdown', reply_markup: emptyKb });
        return;
    }

    var text = '📰 *آخر رسائل المجتمع* | صفحة ' + page + '/' + totalPages + '\n';
    text += '─────────────────\n\n';

    var btns = [];
    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var mUser = await getUser(m.sender_id);
        var alias = getSenderAlias(m.sender_id, m.sender_name, mUser ? mUser.nickname : null);
        var timeStr = formatTime(m.ts);
        var preview = (m.content || '[' + (m.media_type || 'وسائط') + ']').substring(0, 100);
        var replyInfo = m.reply_to_id ? '↩️ رد على #' + m.reply_to_id + '\n' : '';
        text += replyInfo + '👤 *' + alias + '* | 🕒 ' + timeStr + '\n';
        text += preview + (m.content && m.content.length > 100 ? '...' : '') + '\n\n';
        btns.push([{ text: '↩️ رد على ' + alias, callback_data: 'reply_msg_' + m.id }]);
    }

    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: 'view_feed_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'view_feed_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '✉️ إرسال رسالة', callback_data: 'compose_msg' }, { text: '🔄 تحديث', callback_data: 'view_feed_' + page }]);

    var kb = { inline_keyboard: btns };
    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }); return; } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ===== لوحة تحكم المطور/الأدمن =====
async function sendMainMenu(chatId, editMsgId) {
    var allUsers = await getAllUsers();
    var total = allUsers.length;
    var banned = allUsers.filter(function(u) { return u.banned; }).length;
    var muted = allUsers.filter(function(u) { return u.muted; }).length;
    var dayAgo = Date.now() - 86400000;
    var active = allUsers.filter(function(u) { return u.last_seen > dayAgo; }).length;
    var totalMsgs = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE deleted=0', []);
    var msgCount = totalMsgs[0] ? totalMsgs[0].cnt : 0;
    var adminsCount = adminIds.length;

    var text = '🔧 *لوحة تحكم المطور*\n\n'
        + '👥 الأعضاء: ' + total + ' | 🟢 نشطين: ' + active + '\n'
        + '🚫 محظورين: ' + banned + ' | 🔇 مكتومين: ' + muted + '\n'
        + '💬 الرسائل: ' + msgCount + ' | 👮 الأدمنية: ' + adminsCount + '\n\n'
        + '⬇️ *اختر:*';

    var userId = chatId; // chatId هو نفسه userId في المحادثات الخاصة
    var kb = { inline_keyboard: [
        [{ text: '📰 رسائل المجتمع', callback_data: 'dev_feed_1' }, { text: '👥 الأعضاء', callback_data: 'dev_users_1' }],
        [{ text: '📢 رسالة جماعية', callback_data: 'dev_broadcast' }, { text: '📈 إحصائيات', callback_data: 'dev_stats' }],
        [{ text: '🔨 حظر', callback_data: 'dev_pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'dev_pick_unban_1' }],
        [{ text: '🔇 كتم', callback_data: 'dev_pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'dev_pick_unmute_1' }],
        [{ text: '💬 مراسلة عضو', callback_data: 'dev_pick_reply_1' }],
        [{ text: '🗑️ حذف رسالة من الكل', callback_data: 'dev_pick_delete_1' }],
        [{ text: '🧹 مسح بوت من عند شخص', callback_data: 'dev_pick_wipe_1' }]
    ]};

    // أزرار إدارة الأدمنية (للمطور فقط)
    if (isDeveloper(chatId)) {
        kb.inline_keyboard.push([{ text: '👮 إدارة الأدمنية', callback_data: 'dev_admins' }]);
    }

    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }); return; } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ===== معالجة أزرار المطور/الأدمن =====
async function handleDeveloperCallback(chatId, userId, msgId, data) {
    try {
        if (data === 'dev_main') { developerState[chatId] = {}; await sendMainMenu(chatId, msgId); return; }
        if (data === 'noop_feed') { return; }

        // ===== حذف رسالة من الكل (الأدمن يختار رسالة) =====
        if (data.startsWith('dev_pick_delete_')) {
            var delPage = parseInt(data.replace('dev_pick_delete_', '')) || 1;
            await showDeletePicker(chatId, delPage, msgId);
            return;
        }

        if (data.startsWith('dev_delete_msg_')) {
            var delMsgId = parseInt(data.replace('dev_delete_msg_', ''));
            var delMsg = await getCommunityMessage(delMsgId);
            if (!delMsg) { await bot.sendMessage(chatId, '⚠️ الرسالة غير موجودة.'); return; }
            var mSender = await getUser(delMsg.sender_id);
            var delAlias = getSenderAlias(delMsg.sender_id, delMsg.sender_name, mSender ? mSender.nickname : null);
            var confirmText = '🗑️ *حذف رسالة #' + delMsgId + '*\n\n'
                + '👤 المرسل: ' + delAlias + '\n'
                + '💬 ' + (delMsg.content || '[وسائط]').substring(0, 200) + '\n\n'
                + '⚠️ سيتم حذفها من عند جميع المستخدمين!\n\nهل أنت متأكد؟';
            var confirmBtns = [[{ text: '✅ نعم احذف', callback_data: 'dev_confirm_delete_' + delMsgId }, { text: '❌ إلغاء', callback_data: 'dev_main' }]];
            try { await bot.editMessageText(confirmText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: confirmBtns } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_confirm_delete_')) {
            var cdMsgId = parseInt(data.replace('dev_confirm_delete_', ''));
            var result = await deleteCommunityMessage(cdMsgId);
            var resultText = '✅ تم حذف الرسالة #' + cdMsgId + '\n📬 حُذفت من ' + result.deleted + '/' + result.total + ' مستخدم';
            try { await bot.editMessageText(resultText, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // ===== حذف رسالة بواسطة المستخدم نفسه =====
        if (data.startsWith('user_delete_msg_')) {
            var udMsgId = parseInt(data.replace('user_delete_msg_', ''));
            var udMsg = await getCommunityMessage(udMsgId);
            if (!udMsg || String(udMsg.sender_id) !== String(userId)) {
                await bot.sendMessage(chatId, '⚠️ لا يمكنك حذف هذه الرسالة.');
                return;
            }
            var udResult = await deleteCommunityMessage(udMsgId);
            try { await bot.editMessageText('✅ تم حذف رسالتك من عند الجميع (' + udResult.deleted + ' مستخدم)', { chat_id: chatId, message_id: msgId }); } catch (e) {}
            return;
        }

        // ===== مسح كل رسائل البوت من عند شخص =====
        if (data.startsWith('dev_pick_wipe_')) {
            var wipePage = parseInt(data.replace('dev_pick_wipe_', '')) || 1;
            var wipeR = await buildUserButtons('dev_do_wipe', wipePage, null, 'dev_pick_wipe');
            var wipeText = '🧹 *اختر شخص لمسح كل رسائل البوت من عنده:*';
            if (wipeR.total === 0) wipeText += '\n\n⚠️ لا يوجد أعضاء.';
            try { await bot.editMessageText(wipeText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: wipeR.buttons } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_do_wipe_') && !data.includes('page')) {
            var wipeId = data.replace('dev_do_wipe_', '');
            var wipeUser = await getUser(wipeId);
            var wipeName = wipeUser ? getUserDisplayName(wipeUser) : wipeId;
            var wipeConfirm = '🧹 *مسح كل رسائل البوت من عند:*\n\n👤 ' + wipeName + '\n🆔 `' + wipeId + '`\n\n⚠️ سيتم حذف كل الرسائل المرسلة له!\n\nهل أنت متأكد؟';
            try { await bot.editMessageText(wipeConfirm, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم امسح', callback_data: 'dev_confirm_wipe_' + wipeId }, { text: '❌ إلغاء', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_confirm_wipe_')) {
            var cwId = data.replace('dev_confirm_wipe_', '');
            await bot.sendMessage(chatId, '🧹 جاري المسح...');
            var wipeResult = await deleteAllMessagesForUser(cwId);
            var wipeResultText = '✅ تم مسح ' + wipeResult.deleted + '/' + wipeResult.total + ' رسالة من عند `' + cwId + '`';
            await bot.sendMessage(chatId, wipeResultText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } });
            return;
        }

        // ===== إدارة الأدمنية (المطور فقط) =====
        if (data === 'dev_admins' && isDeveloper(userId)) {
            var adminList = await getAdminList();
            var adminText = '👮 *إدارة الأدمنية*\n\n';
            adminText += '👑 المطور الرئيسي: `' + developerId + '`\n\n';
            if (adminList.length > 0) {
                adminText += '📋 *الأدمنية الحاليين:*\n';
                for (var ai = 0; ai < adminList.length; ai++) {
                    var adm = adminList[ai];
                    adminText += '• ' + (adm.name || 'بدون اسم') + (adm.username ? ' @' + adm.username : '') + '\n  🆔 `' + adm.user_id + '` | 📅 ' + formatTime(adm.added_at) + '\n';
                }
            } else {
                adminText += '📭 لا يوجد أدمنية إضافيين.\n';
            }
            adminText += '\n⬇️ اختر:';
            var adminBtns = [
                [{ text: '➕ إضافة أدمن', callback_data: 'dev_add_admin' }],
            ];
            if (adminList.length > 0) {
                for (var aj = 0; aj < adminList.length; aj++) {
                    adminBtns.push([{ text: '❌ إزالة: ' + (adminList[aj].name || adminList[aj].user_id), callback_data: 'dev_remove_admin_' + adminList[aj].user_id }]);
                }
            }
            adminBtns.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);
            try { await bot.editMessageText(adminText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: adminBtns } }); } catch (e) {}
            return;
        }

        if (data === 'dev_add_admin' && isDeveloper(userId)) {
            developerState[chatId] = { action: 'add_admin' };
            var addAdminText = '👮 *إضافة أدمن جديد*\n\n'
                + '✏️ أرسل معرف (ID) الشخص الذي تريد إضافته كأدمن:\n\n'
                + '💡 يمكنك معرفة ID أي شخص من قائمة الأعضاء';
            try { await bot.editMessageText(addAdminText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 اختر من الأعضاء', callback_data: 'dev_pick_admin_1' }], [{ text: '❌ إلغاء', callback_data: 'dev_admins' }]] } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_pick_admin_')) {
            var adminPg = parseInt(data.replace('dev_pick_admin_', '')) || 1;
            var adminR = await buildUserButtons('dev_do_addadmin', adminPg, function(u) { return !isAdmin(u.id); }, 'dev_pick_admin');
            var adminPickText = '👮 *اختر عضو لإضافته كأدمن:*';
            try { await bot.editMessageText(adminPickText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: adminR.buttons } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_do_addadmin_') && !data.includes('page')) {
            var newAdminId = data.replace('dev_do_addadmin_', '');
            var success = await addAdmin(newAdminId, userId);
            if (success) {
                var newAdminUser = await getUser(newAdminId);
                var addResult = '✅ تم إضافة *' + (newAdminUser ? getUserDisplayName(newAdminUser) : newAdminId) + '* كأدمن!';
                try { await bot.sendMessage(newAdminId, '🎉 تم تعيينك كأدمن في البوت! أرسل /start لفتح لوحة التحكم.'); } catch (e) {}
            } else {
                var addResult = '❌ فشل إضافة الأدمن.';
            }
            try { await bot.editMessageText(addResult, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👮 الأدمنية', callback_data: 'dev_admins' }], [{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_remove_admin_') && isDeveloper(userId)) {
            var removeId = data.replace('dev_remove_admin_', '');
            if (removeId === developerId) {
                await bot.sendMessage(chatId, '⚠️ لا يمكن إزالة المطور الرئيسي!');
                return;
            }
            var removeSuccess = await removeAdmin(removeId);
            var removeUser = await getUser(removeId);
            var removeResult = removeSuccess
                ? '✅ تم إزالة *' + (removeUser ? getUserDisplayName(removeUser) : removeId) + '* من الأدمنية'
                : '❌ فشل الإزالة';
            if (removeSuccess) { try { await bot.sendMessage(removeId, '⚠️ تم إزالتك من الأدمنية.'); } catch (e) {} }
            try { await bot.editMessageText(removeResult, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👮 الأدمنية', callback_data: 'dev_admins' }], [{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // ===== باقي أزرار المطور الأصلية =====
        if (data.startsWith('dev_feed_')) {
            var page = parseInt(data.replace('dev_feed_', '')) || 1;
            await showDevFeed(chatId, page, msgId);
            return;
        }

        if (data.startsWith('dev_users_')) {
            var pg = parseInt(data.replace('dev_users_', '')) || 1;
            await showDevUsers(chatId, pg, msgId);
            return;
        }

        if (data.startsWith('dev_user_') && !data.startsWith('dev_user_msgs_')) {
            var tid = data.replace('dev_user_', '');
            await showDevUserDetail(chatId, tid, msgId);
            return;
        }

        if (data === 'dev_stats') {
            var allSt = await getAllUsers();
            var sd = Date.now() - 86400000;
            var sw = Date.now() - 604800000;
            var sad = allSt.filter(function(u) { return u.last_seen > sd; }).length;
            var saw = allSt.filter(function(u) { return u.last_seen > sw; }).length;
            var totalMsgs2 = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE deleted=0', []);
            var mc = totalMsgs2[0] ? totalMsgs2[0].cnt : 0;
            var todayMsgs = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE ts > ? AND deleted=0', [Date.now() - 86400000]);
            var tmc = todayMsgs[0] ? todayMsgs[0].cnt : 0;
            var stxt = '📈 *إحصائيات المجتمع*\n\n'
                + '👥 إجمالي الأعضاء: ' + allSt.length + '\n'
                + '🟢 نشطين اليوم: ' + sad + '\n'
                + '🔵 نشطين هذا الأسبوع: ' + saw + '\n'
                + '🚫 محظورين: ' + allSt.filter(function(u) { return u.banned; }).length + '\n'
                + '🔇 مكتومين: ' + allSt.filter(function(u) { return u.muted; }).length + '\n'
                + '👮 أدمنية: ' + adminIds.length + '\n\n'
                + '💬 إجمالي الرسائل: ' + mc + '\n'
                + '📨 رسائل اليوم: ' + tmc;
            try { await bot.editMessageText(stxt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data === 'dev_broadcast') {
            developerState[chatId] = { action: 'broadcast' };
            var allU = await getAllUsers();
            var bc = '📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ' + allU.filter(function(u) { return !u.banned; }).length + ' عضو:';
            try { await bot.editMessageText(bc, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data.match(/^dev_pick_(ban|unban|mute|unmute|reply)_\d+$/)) {
            var parts = data.split('_');
            var action = parts[2];
            var pg2 = parseInt(parts[3]) || 1;
            var filterFn = null;
            if (action === 'ban') filterFn = function(u) { return !u.banned; };
            if (action === 'unban') filterFn = function(u) { return u.banned; };
            if (action === 'mute') filterFn = function(u) { return !u.muted; };
            if (action === 'unmute') filterFn = function(u) { return u.muted; };
            var titles2 = { ban: '🔨 اختر عضواً للحظر:', unban: '🔓 اختر عضواً لرفع الحظر:', mute: '🔇 اختر عضواً للكتم:', unmute: '🔊 اختر عضواً لرفع الكتم:', reply: '💬 اختر عضواً للمراسلة:' };
            var r = await buildUserButtons('dev_do_' + action, pg2, filterFn, 'dev_pick_' + action);
            var t2 = titles2[action] || 'اختر:';
            if (r.total === 0) t2 += '\n\n⚠️ لا يوجد أعضاء.';
            try { await bot.editMessageText(t2, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); } catch (e) {}
            return;
        }

        if (data.match(/^dev_do_(ban|unban|mute|unmute)_\d+$/) && !data.includes('addadmin') && !data.includes('wipe')) {
            var pp = data.replace('dev_do_', '').split('_');
            var act = pp[0]; var tid2 = pp[1];
            var u2 = await getUser(tid2);
            var actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم' };
            var ct = '*' + actNames[act] + '*\n\n👤 ' + (u2 ? getUserDisplayName(u2) : tid2) + '\n🆔 `' + tid2 + '`\n\nهل أنت متأكد؟';
            var cb = [[{ text: '✅ نعم', callback_data: 'dev_confirm_' + act + '_' + tid2 }, { text: '❌ لا', callback_data: 'dev_main' }]];
            try { await bot.editMessageText(ct, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: cb } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_do_reply_') && !data.includes('page')) {
            var tid3 = data.replace('dev_do_reply_', '');
            developerState[chatId] = { action: 'reply', targetId: tid3 };
            var u3 = await getUser(tid3);
            var rt = '💬 *مراسلة عضو*\n\n👤 ' + (u3 ? getUserDisplayName(u3) : tid3) + '\n\n✏️ اكتب رسالتك:';
            try { await bot.editMessageText(rt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data.startsWith('dev_confirm_') && !data.startsWith('dev_confirm_delete_') && !data.startsWith('dev_confirm_wipe_')) {
            var pp4 = data.replace('dev_confirm_', '').split('_');
            var act4 = pp4[0]; var tid4 = pp4[1];
            var result = '';
            if (act4 === 'ban') { await setUserField(tid4, 'banned', 1); result = '✅ تم حظر العضو `' + tid4 + '`'; try { await bot.sendMessage(tid4, '⛔ تم حظرك من البوت.'); } catch (e) {} }
            else if (act4 === 'unban') { await setUserField(tid4, 'banned', 0); result = '✅ تم رفع الحظر عن `' + tid4 + '`'; try { await bot.sendMessage(tid4, '✅ تم رفع الحظر عنك.'); } catch (e) {} }
            else if (act4 === 'mute') { await setUserField(tid4, 'muted', 1); result = '✅ تم كتم العضو `' + tid4 + '`'; }
            else if (act4 === 'unmute') { await setUserField(tid4, 'muted', 0); result = '✅ تم رفع الكتم عن `' + tid4 + '`'; }
            try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        if (data.match(/^dev_user_msgs_\d+_\d+$/)) {
            var parts5 = data.replace('dev_user_msgs_', '').split('_');
            var umTid = parts5[0];
            var umPage = parseInt(parts5[1]) || 1;
            await showUserMessages(chatId, umTid, umPage, msgId);
            return;
        }

        if (data.startsWith('dev_view_msg_')) {
            var cmid = parseInt(data.replace('dev_view_msg_', ''));
            var m = await getCommunityMessage(cmid);
            if (!m) { await bot.sendMessage(chatId, '⚠️ الرسالة غير موجودة.'); return; }
            var mSenderUser = await getUser(m.sender_id);
            var alias2 = getSenderAlias(m.sender_id, m.sender_name, mSenderUser ? mSenderUser.nickname : null);
            var fullInfo = '📨 *رسالة #' + m.id + '*' + (m.deleted ? ' 🗑️ *محذوفة*' : '') + '\n\n'
                + '👤 ' + alias2 + '\n'
                + '🆔 ID: `' + m.sender_id + '`\n'
                + '🕒 ' + formatTime(m.ts) + '\n'
                + (m.reply_to_id ? '↩️ رد على #' + m.reply_to_id + '\n' : '')
                + (m.media_type ? '📎 ' + m.media_type + '\n' : '')
                + '\n💬 ' + (m.content || '[وسائط]');
            var deliveries = await getDeliveryByCommunityMsgId(cmid);
            fullInfo += '\n\n📬 وصلت لـ ' + deliveries.length + ' عضو';
            var msgBtns = [[{ text: '🔙 رجوع', callback_data: 'dev_feed_1' }]];
            if (!m.deleted) {
                msgBtns.unshift([{ text: '🗑️ حذف من الكل', callback_data: 'dev_delete_msg_' + cmid }]);
            }
            try { await bot.editMessageText(fullInfo, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: msgBtns } }); } catch (e) {}
            return;
        }

    } catch (err) {
        console.error('خطأ callback مطور:', err.message);
    }
}

// ===== اختيار رسالة للحذف =====
async function showDeletePicker(chatId, page, editMsgId) {
    var perPage = 8;
    var offset = (page - 1) * perPage;
    var msgs = await getCommunityMessages(perPage, offset);
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE deleted=0', []);
    var total = totalRows[0] ? totalRows[0].cnt : 0;
    var totalPages = Math.ceil(total / perPage) || 1;

    if (msgs.length === 0) {
        var emptyText = '🗑️ *حذف رسالة*\n\n📭 لا توجد رسائل.';
        if (editMsgId) { try { await bot.editMessageText(emptyText, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); return; } catch (e) {} }
        return;
    }

    var text = '🗑️ *اختر رسالة لحذفها من الكل:*\n\n';
    var btns = [];

    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var mUser = await getUser(m.sender_id);
        var alias = getSenderAlias(m.sender_id, m.sender_name, mUser ? mUser.nickname : null);
        var preview = (m.content || '[وسائط]').substring(0, 30);
        btns.push([{ text: '#' + m.id + ' ' + alias + ': ' + preview, callback_data: 'dev_delete_msg_' + m.id }]);
    }

    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'dev_pick_delete_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'dev_pick_delete_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== عرض رسائل المجتمع للمطور =====
async function showDevFeed(chatId, page, editMsgId) {
    var perPage = 8;
    var offset = (page - 1) * perPage;
    var msgs = await getCommunityMessages(perPage, offset);
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE deleted=0', []);
    var total = totalRows[0] ? totalRows[0].cnt : 0;
    var totalPages = Math.ceil(total / perPage) || 1;

    if (msgs.length === 0) {
        var emptyText = '📰 *رسائل المجتمع*\n\n📭 لا توجد رسائل.';
        if (editMsgId) { try { await bot.editMessageText(emptyText, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); return; } catch (e) {} }
        await bot.sendMessage(chatId, emptyText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } });
        return;
    }

    var text = '📰 *رسائل المجتمع* | ' + total + ' رسالة | صفحة ' + page + '/' + totalPages + '\n─────────────────\n\n';
    var btns = [];

    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var mUser2 = await getUser(m.sender_id);
        var alias = getSenderAlias(m.sender_id, m.sender_name, mUser2 ? mUser2.nickname : null);
        var preview = (m.content || '[' + (m.media_type || 'وسائط') + ']').substring(0, 60);
        var replyMark = m.reply_to_id ? '↩️ ' : '';
        text += replyMark + '#' + m.id + ' | 👤 ' + alias + ' | ' + formatTime(m.ts) + '\n' + preview + '\n\n';
        btns.push([{ text: '#' + m.id + ' - ' + alias + ' - ' + preview.substring(0, 30), callback_data: 'dev_view_msg_' + m.id }]);
    }

    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'dev_feed_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'dev_feed_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== عرض الأعضاء للمطور =====
async function showDevUsers(chatId, page, editMsgId) {
    var allUsers = await getAllUsers();
    var perPage = 8;
    var totalPages = Math.ceil(allUsers.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    var start = (page - 1) * perPage;
    var pageUsers = allUsers.slice(start, start + perPage);

    var text = '👥 *الأعضاء* (' + allUsers.length + ') | صفحة ' + page + '/' + totalPages + '\n─────────────────\n';
    var btns = [];

    for (var i = 0; i < pageUsers.length; i++) {
        var u = pageUsers[i];
        var label = '';
        if (isAdmin(u.id)) label += '👮 ';
        if (u.banned) label += '🚫 ';
        if (u.muted) label += '🔇 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        btns.push([{ text: label, callback_data: 'dev_user_' + u.id }]);
    }

    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'dev_users_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'dev_users_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== تفاصيل عضو =====
async function showDevUserDetail(chatId, tid, editMsgId) {
    var u = await getUser(tid);
    if (!u) { await bot.sendMessage(chatId, '❌ العضو غير موجود.'); return; }

    var msgCount = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND deleted=0', [String(tid)]);
    var mc = msgCount[0] ? msgCount[0].cnt : 0;

    var lastMsgs = await query(
        'SELECT content, media_type, ts FROM community_messages WHERE sender_id=? AND deleted=0 ORDER BY ts DESC LIMIT 3',
        [String(tid)]
    );

    var todayMsgs = await query(
        'SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND ts > ? AND deleted=0',
        [String(tid), Date.now() - 86400000]
    );
    var tmc = todayMsgs[0] ? todayMsgs[0].cnt : 0;

    var weekMsgs = await query(
        'SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND ts > ? AND deleted=0',
        [String(tid), Date.now() - 604800000]
    );
    var wmc = weekMsgs[0] ? weekMsgs[0].cnt : 0;

    var alias = getSenderAlias(tid, u.name, u.nickname);

    var text = '👤 *ملف العضو الكامل*\n';
    text += '─────────────────\n';
    text += '📝 الاسم: ' + (u.name || '-') + '\n';
    text += '🔗 يوزر: ' + (u.username ? '@' + u.username : '-') + '\n';
    text += '🆔 ID: `' + u.id + '`\n';
    text += '🎭 البصمة: ' + alias + '\n';
    if (isAdmin(u.id)) text += '👮 *أدمن*\n';
    text += '─────────────────\n';
    text += '📊 *إحصائيات النشاط:*\n';
    text += '📨 إجمالي الرسائل: ' + mc + '\n';
    text += '📅 رسائل اليوم: ' + tmc + '\n';
    text += '📆 رسائل الأسبوع: ' + wmc + '\n';
    text += '🕒 آخر نشاط: ' + formatTime(u.last_seen) + '\n';
    text += '📅 أول دخول: ' + formatTime(u.first_seen) + '\n';
    text += '─────────────────\n';
    text += '🚫 محظور: ' + (u.banned ? '✅ نعم' : '❌ لا') + '\n';
    text += '🔇 مكتوم: ' + (u.muted ? '✅ نعم' : '❌ لا') + '\n';

    if (lastMsgs.length > 0) {
        text += '─────────────────\n';
        text += '💬 *آخر رسائله:*\n';
        for (var i = 0; i < lastMsgs.length; i++) {
            var lm = lastMsgs[i];
            var preview = (lm.content || '[' + (lm.media_type || 'وسائط') + ']').substring(0, 80);
            text += '• ' + preview + (preview.length >= 80 ? '...' : '') + '\n';
            text += '  🕒 ' + formatTime(lm.ts) + '\n';
        }
    }

    var kb = [
        [{ text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'dev_do_' + (u.banned ? 'unban' : 'ban') + '_' + tid },
         { text: u.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'dev_do_' + (u.muted ? 'unmute' : 'mute') + '_' + tid }],
        [{ text: '💬 مراسلة', callback_data: 'dev_do_reply_' + tid }],
        [{ text: '📜 كل رسائله', callback_data: 'dev_user_msgs_' + tid + '_1' }],
        [{ text: '🧹 مسح البوت من عنده', callback_data: 'dev_do_wipe_' + tid }],
        [{ text: '🔙 رجوع', callback_data: 'dev_users_1' }]
    ];

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

// ===== عرض رسائل عضو =====
async function showUserMessages(chatId, tid, page, editMsgId) {
    var u = await getUser(tid);
    var userName = u ? (u.name || 'مجهول') : tid;
    var perPage = 5;
    var offset = (page - 1) * perPage;

    var msgs = await query(
        'SELECT * FROM community_messages WHERE sender_id=? AND deleted=0 ORDER BY ts DESC LIMIT ? OFFSET ?',
        [String(tid), perPage, offset]
    );
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND deleted=0', [String(tid)]);
    var total = totalRows[0] ? totalRows[0].cnt : 0;
    var totalPages = Math.ceil(total / perPage) || 1;

    var alias = getSenderAlias(tid, userName, u ? u.nickname : null);
    var text = '📜 *رسائل: ' + alias + '*\n';
    text += '📊 ' + total + ' رسالة | صفحة ' + page + '/' + totalPages + '\n';
    text += '─────────────────\n\n';

    if (msgs.length === 0) {
        text += '📭 لا توجد رسائل.';
    } else {
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            var preview = (m.content || '[' + (m.media_type || 'وسائط') + ']').substring(0, 120);
            var replyMark = m.reply_to_id ? '↩️ رد على #' + m.reply_to_id + '\n' : '';
            text += '#' + m.id + ' | ' + formatTime(m.ts) + '\n';
            text += replyMark + preview + (m.content && m.content.length > 120 ? '...' : '') + '\n\n';
        }
    }

    var btns = [];
    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: 'dev_user_msgs_' + tid + '_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'dev_user_msgs_' + tid + '_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 ملف العضو', callback_data: 'dev_user_' + tid }]);

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== بناء أزرار اختيار مستخدم =====
async function buildUserButtons(actionPrefix, page, filterFn, pagePrefix) {
    var allUsers = await getAllUsers();
    if (filterFn) allUsers = allUsers.filter(filterFn);
    var perPage = 8;
    var totalPages = Math.ceil(allUsers.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    var start = (page - 1) * perPage;
    var pageUsers = allUsers.slice(start, start + perPage);
    var buttons = [];
    for (var i = 0; i < pageUsers.length; i++) {
        var u = pageUsers[i];
        var label = (u.banned ? '🚫 ' : '') + (u.muted ? '🔇 ' : '') + (isAdmin(u.id) ? '👮 ' : '') + (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        buttons.push([{ text: label, callback_data: actionPrefix + '_' + u.id }]);
    }
    var navRow = [];
    var pp = pagePrefix || actionPrefix;
    if (page > 1) navRow.push({ text: '⬅️', callback_data: pp + '_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop_feed' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: pp + '_' + (page + 1) });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);
    return { buttons: buttons, total: allUsers.length };
}

// ===== معالجة رسائل المطور/الأدمن =====
async function handleDeveloperMessage(chatId, msg) {
    var state = developerState[chatId] || {};

    if (msg.text && msg.text.startsWith('/')) return;

    // رسالة جماعية
    if (state.action === 'broadcast') {
        developerState[chatId] = {};
        var all = (await getAllUsers()).filter(function(u) { return !u.banned && u.id; });
        var ok = 0, fail = 0;
        await bot.sendMessage(chatId, '📢 جاري الإرسال لـ ' + all.length + ' عضو...');
        for (var i = 0; i < all.length; i++) {
            try { await bot.copyMessage(all[i].id, chatId, msg.message_id); ok++; } catch (e) { fail++; }
        }
        await bot.sendMessage(chatId, '✅ تم! نجح: ' + ok + ' | فشل: ' + fail, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'dev_main' }]] } });
        return;
    }

    // رد على عضو
    if (state.action === 'reply' && state.targetId) {
        var target = state.targetId;
        developerState[chatId] = {};
        try {
            await bot.copyMessage(target, chatId, msg.message_id);
            await bot.sendMessage(chatId, '✅ تم إرسال الرسالة للعضو `' + target + '`', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'dev_main' }]] } });
        } catch (err) {
            await bot.sendMessage(chatId, '❌ فشل الإرسال: ' + err.message);
        }
        return;
    }

    // إضافة أدمن بالـ ID
    if (state.action === 'add_admin') {
        developerState[chatId] = {};
        var adminId = (msg.text || '').trim();
        if (!/^\d+$/.test(adminId)) {
            await bot.sendMessage(chatId, '⚠️ يرجى إرسال رقم ID صحيح.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_admins' }]] } });
            return;
        }
        var success = await addAdmin(adminId, chatId);
        if (success) {
            await bot.sendMessage(chatId, '✅ تم إضافة `' + adminId + '` كأدمن!', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '👮 الأدمنية', callback_data: 'dev_admins' }]] } });
            try { await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch (e) {}
        } else {
            await bot.sendMessage(chatId, '❌ فشل الإضافة.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_admins' }]] } });
        }
        return;
    }

    // إذا لم يكن في أي وضع -> لوحة التحكم
    await sendMainMenu(chatId);
}

// ===== Express + Keep-Alive =====
var app = express();
app.get('/', function(req, res) { res.send('Community Bot is running! 🤖'); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString(), users: adminIds.length }); });
var port = process.env.PORT || 3000;
var serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.listen(port, function() {
    console.log('✅ Port ' + port);
    setInterval(function() {
        var url = serverUrl + '/health';
        var protocol = url.startsWith('https') ? https : http;
        protocol.get(url, function(res) {
            console.log('🔄 Keep-alive: ' + res.statusCode);
        }).on('error', function(e) {
            console.log('⚠️ Keep-alive error: ' + e.message);
        });
    }, 14 * 60 * 1000);
});

// ===== تشغيل كل شيء =====
startBot().catch(function(e) {
    console.error('خطأ في تشغيل البوت:', e.message);
    process.exit(1);
});
