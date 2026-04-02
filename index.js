const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var developerId = '7411444902';

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
                muted TINYINT(1) DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
        // إضافة عمود nickname إذا لم يكن موجوداً (للقواعد القديمة)
        try { await conn.execute('ALTER TABLE users ADD COLUMN nickname VARCHAR(255) DEFAULT NULL'); } catch(e) {}

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
                ts BIGINT DEFAULT 0,
                INDEX idx_ts (ts),
                INDEX idx_sender (sender_id),
                INDEX idx_reply (reply_to_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول ربط رسائل التيليغرام بالرسائل المجتمعية
        // (لكل رسالة مجتمعية نحفظ message_id في كل مستخدم وصلته)
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

        conn.release();
        console.log('✅ تم تهيئة جداول قاعدة البيانات');
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
        return u;
    } catch (e) { return null; }
}

async function getAllUsers() {
    try {
        var rows = await query('SELECT * FROM users ORDER BY last_seen DESC', []);
        return rows.map(function(u) { u.banned = u.banned === 1; u.muted = u.muted === 1; return u; });
    } catch (e) { return []; }
}

async function updateUserData(userId, userName, fullName) {
    var now = Date.now();
    try {
        var existing = await getUser(userId);
        if (!existing) {
            await query(
                'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, banned, muted) VALUES (?, ?, ?, ?, ?, 1, 0, 0)',
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
    try {
        await query('DELETE FROM users WHERE id=?', [String(userId)]);
    } catch (e) {}
}

// ===== دوال الرسائل المجتمعية =====
async function saveCommunityMessage(senderId, senderName, senderUsername, content, mediaType, fileId, replyToId) {
    var now = Date.now();
    try {
        var result = await query(
            'INSERT INTO community_messages (sender_id, sender_name, sender_username, content, media_type, file_id, reply_to_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [String(senderId), senderName || '', senderUsername || '', content || '', mediaType || null, fileId || null, replyToId || null, now]
        );
        return result.insertId;
    } catch (e) { console.error('saveCommunityMessage error:', e.message); return null; }
}

async function getCommunityMessages(limit, offset) {
    try {
        return await query(
            'SELECT * FROM community_messages ORDER BY ts DESC LIMIT ? OFFSET ?',
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

// البحث عن رسالة مجتمعية بناءً على tg_message_id و user_id
async function getCommunityMsgIdByTgMsg(tgMessageId, userId) {
    try {
        var rows = await query(
            'SELECT community_msg_id FROM message_delivery WHERE tg_message_id=? AND user_id=?',
            [tgMessageId, String(userId)]
        );
        return rows[0] ? rows[0].community_msg_id : null;
    } catch (e) { return null; }
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

// بناء اسم العرض للمرسل
function getSenderAlias(senderId, senderName, nickname) {
    if (nickname && nickname.trim()) return nickname.trim();
    // fallback: الاسم الأول + آخر رقمين
    var firstName = (senderName || 'عضو').split(' ')[0];
    var idStr = String(senderId);
    var suffix = idStr.slice(-2);
    return firstName + '#' + suffix;
}

// التحقق من تكرار الاسم المستعار
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
    // منع الرموز الخطرة
    if (/[<>"'`]/.test(nick)) {
        await bot.sendMessage(chatId, '⚠️ الاسم يحتوي على رموز غير مسموحة. حاول مرة أخرى:');
        pendingNickname[chatId] = true;
        return;
    }
    var taken = await isNicknameTaken(nick, userId);
    if (taken) {
        await bot.sendMessage(chatId, '⚠️ هذا الاسم مستخدم من عضو آخر. جرب اسماً آخر:');
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

// حالة انتظار الرد من المستخدمين (userId -> communityMsgId)
var pendingReplies = {};
// حالة انتظار إدخال الاسم المستعار
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

    // ===== /start =====
    bot.onText(/^\/(start|panel)$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;

        if (userId.toString() === developerId) {
            developerState[chatId] = {};
            await sendMainMenu(chatId);
            return;
        }

        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        await updateUserData(userId, msg.from.username, fullName);
        var user = await getUser(userId);

        // إذا لم يختر اسماً مستعاراً بعد -> اطلب منه
        if (!user || !user.nickname) {
            await askForNickname(chatId, userId, true);
            return;
        }

        await sendWelcomeMenu(chatId, user.nickname);
    });

    // ===== /nickname - تغيير الاسم المستعار =====
    bot.onText(/^\/nickname$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        if (userId.toString() === developerId) return;
        await askForNickname(chatId, userId, false);
    });

    // ===== /feed =====
    bot.onText(/^\/feed$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        if (userId.toString() === developerId) return;
        await showFeed(chatId, 1);
    });

    // ===== معالجة أزرار =====
    bot.on('callback_query', async function(cbq) {
        var chatId = cbq.message.chat.id;
        var userId = cbq.from.id;
        var msgId = cbq.message.message_id;
        var data = cbq.data;

        await bot.answerCallbackQuery(cbq.id).catch(function() {});

        // ===== أزرار المطور =====
        if (userId.toString() === developerId) {
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
                // لا يوجد وضع كتابة - الرسائل تُرسل مباشرة
                try { await bot.editMessageText('💬 فقط اكتب رسالتك مباشرة وستصل للجميع!', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'back_home' }]] } }); } catch (e) {}
                return;
            }

            if (data.startsWith('view_feed_')) {
                var page = parseInt(data.replace('view_feed_', '')) || 1;
                await showFeed(chatId, page, msgId);
                return;
            }

            // رد على رسالة مجتمعية
            if (data.startsWith('reply_msg_')) {
                var communityMsgId = parseInt(data.replace('reply_msg_', ''));
                var origMsg = await getCommunityMessage(communityMsgId);
                if (!origMsg) { await bot.sendMessage(chatId, '⚠️ الرسالة غير موجودة.'); return; }
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

        // ===== المطور =====
        if (userId.toString() === developerId) {
            await handleDeveloperMessage(chatId, msg);
            return;
        }

        // ===== المستخدم العادي =====
        await updateUserData(userId, userName, fullName);
        var user = await getUser(userId);
        if (user && user.banned) { await bot.sendMessage(chatId, '⛔ أنت محظور من استخدام البوت.'); return; }
        if (user && user.muted) return;

        // هل ينتظر إدخال اسم مستعار؟
        if (pendingNickname[chatId]) {
            delete pendingNickname[chatId];
            await handleNicknameInput(chatId, userId, msg.text);
            return;
        }

        // إذا لم يختر اسماً مستعاراً بعد
        if (!user || !user.nickname) {
            await askForNickname(chatId, userId, true);
            return;
        }

        // إذا كان في وضع رد على رسالة محددة
        var pending = pendingReplies[chatId];
        if (pending) {
            delete pendingReplies[chatId];
            await handleUserPost(msg, userId, userName, fullName, pending);
            return;
        }

        // أي رسالة عادية -> ترسل للمجتمع مباشرة بدون خطوات
        await handleUserPost(msg, userId, userName, fullName, { type: 'new' });
    });

    console.log('✅ البوت جاهز ويستقبل الرسائل');
}

// ===== معالجة نشر رسالة مستخدم =====
async function handleUserPost(msg, userId, userName, fullName, pending) {
    var chatId = msg.chat.id;

    // استخراج المحتوى
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

    // حفظ الرسالة في قاعدة البيانات
    var communityMsgId = await saveCommunityMessage(userId, fullName, userName, content, mediaType, fileId, replyToId);
    if (!communityMsgId) {
        await bot.sendMessage(chatId, '⚠️ حدث خطأ في حفظ الرسالة. حاول مرة أخرى.');
        return;
    }

    // إرسال للجميع (بدون تأكيد للمرسل - تجربة طبيعية مثل تيليغرام)
    await broadcastCommunityMessage(communityMsgId, userId);
}

// ===== بث رسالة مجتمعية لجميع الأعضاء =====
async function broadcastCommunityMessage(communityMsgId, senderUserId) {
    var msgData = await getCommunityMessage(communityMsgId);
    if (!msgData) return;

    var allUsers = await getAllUsers();
    // جلب بيانات المرسل مع الاسم المستعار
    var senderUser = await getUser(msgData.sender_id);
    var alias = getSenderAlias(msgData.sender_id, msgData.sender_name, senderUser ? senderUser.nickname : null);

    // بناء نص الرسالة
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

    for (var i = 0; i < allUsers.length; i++) {
        var u = allUsers[i];
        if (u.banned || u.muted) continue;
        // لا نرسل الرسالة للمرسل نفسه
        if (u.id === String(senderUserId)) continue;

        try {
            var sentMsg = null;
            if (!msgData.media_type || msgData.media_type === null) {
                // رسالة نصية
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
            } else if (msgData.media_type === 'video_note') {
                sentMsg = await bot.sendVideoNote(u.id, msgData.file_id);
            } else {
                var capDef = header + (msgData.content || '') + footer;
                sentMsg = await bot.sendMessage(u.id, capDef, { parse_mode: 'Markdown', reply_markup: kb });
            }

            if (sentMsg) {
                await saveDelivery(communityMsgId, u.id, sentMsg.message_id);
            }
        } catch (e) {
            console.log('فشل الإرسال للمستخدم ' + u.id + ': ' + e.message);
        }
    }

    // إرسال للمطور أيضاً (بدون زر رد - فقط للمراقبة)
    try {
        var devText = '📨 *رسالة جديدة #' + communityMsgId + '*\n'
            + '👤 ' + alias + ' | ID: `' + senderUserId + '`\n'
            + '🕒 ' + formatTime(msgData.ts) + '\n'
            + (msgData.reply_to_id ? '↩️ رد على #' + msgData.reply_to_id + '\n' : '')
            + '💬 ' + (msgData.content || '[وسائط: ' + msgData.media_type + ']').substring(0, 300);
        await bot.sendMessage(developerId, devText, { parse_mode: 'Markdown' });
    } catch (e) {}
}

// ===== عرض آخر رسائل المجتمع =====
async function showFeed(chatId, page, editMsgId) {
    var perPage = 5;
    var offset = (page - 1) * perPage;
    var msgs = await getCommunityMessages(perPage, offset);

    // عدد الكل
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages', []);
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

// ===== لوحة تحكم المطور =====
async function sendMainMenu(chatId, editMsgId) {
    var allUsers = await getAllUsers();
    var total = allUsers.length;
    var banned = allUsers.filter(function(u) { return u.banned; }).length;
    var muted = allUsers.filter(function(u) { return u.muted; }).length;
    var dayAgo = Date.now() - 86400000;
    var active = allUsers.filter(function(u) { return u.last_seen > dayAgo; }).length;
    var totalMsgs = await query('SELECT COUNT(*) as cnt FROM community_messages', []);
    var msgCount = totalMsgs[0] ? totalMsgs[0].cnt : 0;

    var text = '🔧 *لوحة تحكم المطور*\n\n'
        + '👥 الأعضاء: ' + total + ' | 🟢 نشطين اليوم: ' + active + '\n'
        + '🚫 محظورين: ' + banned + ' | 🔇 مكتومين: ' + muted + '\n'
        + '💬 رسائل المجتمع: ' + msgCount + '\n\n'
        + '⬇️ *اختر:*';

    var kb = { inline_keyboard: [
        [{ text: '📰 رسائل المجتمع', callback_data: 'dev_feed_1' }, { text: '👥 الأعضاء', callback_data: 'dev_users_1' }],
        [{ text: '📢 رسالة جماعية', callback_data: 'dev_broadcast' }, { text: '📈 إحصائيات', callback_data: 'dev_stats' }],
        [{ text: '🔨 حظر عضو', callback_data: 'dev_pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'dev_pick_unban_1' }],
        [{ text: '🔇 كتم عضو', callback_data: 'dev_pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'dev_pick_unmute_1' }],
        [{ text: '💬 مراسلة عضو', callback_data: 'dev_pick_reply_1' }]
    ]};

    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }); return; } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ===== معالجة أزرار المطور =====
async function handleDeveloperCallback(chatId, userId, msgId, data) {
    try {
        if (data === 'dev_main') { developerState[chatId] = {}; await sendMainMenu(chatId, msgId); return; }
        if (data === 'noop_feed') { return; }

        // عرض رسائل المجتمع للمطور
        if (data.startsWith('dev_feed_')) {
            var page = parseInt(data.replace('dev_feed_', '')) || 1;
            await showDevFeed(chatId, page, msgId);
            return;
        }

        // قائمة الأعضاء
        if (data.startsWith('dev_users_')) {
            var pg = parseInt(data.replace('dev_users_', '')) || 1;
            await showDevUsers(chatId, pg, msgId);
            return;
        }

        // تفاصيل عضو
        if (data.startsWith('dev_user_')) {
            var tid = data.replace('dev_user_', '');
            await showDevUserDetail(chatId, tid, msgId);
            return;
        }

        // إحصائيات
        if (data === 'dev_stats') {
            var allSt = await getAllUsers();
            var sd = Date.now() - 86400000;
            var sw = Date.now() - 604800000;
            var sad = allSt.filter(function(u) { return u.last_seen > sd; }).length;
            var saw = allSt.filter(function(u) { return u.last_seen > sw; }).length;
            var totalMsgs2 = await query('SELECT COUNT(*) as cnt FROM community_messages', []);
            var mc = totalMsgs2[0] ? totalMsgs2[0].cnt : 0;
            var todayMsgs = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE ts > ?', [Date.now() - 86400000]);
            var tmc = todayMsgs[0] ? todayMsgs[0].cnt : 0;
            var stxt = '📈 *إحصائيات المجتمع*\n\n'
                + '👥 إجمالي الأعضاء: ' + allSt.length + '\n'
                + '🟢 نشطين اليوم: ' + sad + '\n'
                + '🔵 نشطين هذا الأسبوع: ' + saw + '\n'
                + '🚫 محظورين: ' + allSt.filter(function(u) { return u.banned; }).length + '\n'
                + '🔇 مكتومين: ' + allSt.filter(function(u) { return u.muted; }).length + '\n\n'
                + '💬 إجمالي الرسائل: ' + mc + '\n'
                + '📨 رسائل اليوم: ' + tmc;
            try { await bot.editMessageText(stxt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // رسالة جماعية
        if (data === 'dev_broadcast') {
            developerState[chatId] = { action: 'broadcast' };
            var allU = await getAllUsers();
            var bc = '📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ' + allU.filter(function(u) { return !u.banned; }).length + ' عضو:';
            try { await bot.editMessageText(bc, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // اختيار عضو للإجراء
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

        // تنفيذ إجراء على عضو
        if (data.match(/^dev_do_(ban|unban|mute|unmute)_\d+$/)) {
            var pp = data.replace('dev_do_', '').split('_');
            var act = pp[0]; var tid2 = pp[1];
            var u2 = await getUser(tid2);
            var actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم' };
            var ct = '*' + actNames[act] + '*\n\n👤 ' + (u2 ? getUserDisplayName(u2) : tid2) + '\n🆔 `' + tid2 + '`\n\nهل أنت متأكد؟';
            var cb = [[{ text: '✅ نعم', callback_data: 'dev_confirm_' + act + '_' + tid2 }, { text: '❌ لا', callback_data: 'dev_main' }]];
            try { await bot.editMessageText(ct, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: cb } }); } catch (e) {}
            return;
        }

        // مراسلة عضو
        if (data.startsWith('dev_do_reply_')) {
            var tid3 = data.replace('dev_do_reply_', '');
            developerState[chatId] = { action: 'reply', targetId: tid3 };
            var u3 = await getUser(tid3);
            var rt = '💬 *مراسلة عضو*\n\n👤 ' + (u3 ? getUserDisplayName(u3) : tid3) + '\n\n✏️ اكتب رسالتك:';
            try { await bot.editMessageText(rt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // تأكيد الإجراء
        if (data.startsWith('dev_confirm_')) {
            var pp4 = data.replace('dev_confirm_', '').split('_');
            var act4 = pp4[0]; var tid4 = pp4[1];
            var result = '';
            if (act4 === 'ban') { await setUserField(tid4, 'banned', 1); result = '✅ تم حظر العضو `' + tid4 + '`'; try { await bot.sendMessage(tid4, '⛔ تم حظرك من البوت.'); } catch (e) {} }
            else if (act4 === 'unban') { await setUserField(tid4, 'banned', 0); result = '✅ تم رفع الحظر عن `' + tid4 + '`'; try { await bot.sendMessage(tid4, '✅ تم رفع الحظر عنك، يمكنك استخدام البوت مجدداً.'); } catch (e) {} }
            else if (act4 === 'mute') { await setUserField(tid4, 'muted', 1); result = '✅ تم كتم العضو `' + tid4 + '`'; }
            else if (act4 === 'unmute') { await setUserField(tid4, 'muted', 0); result = '✅ تم رفع الكتم عن `' + tid4 + '`'; }
            try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } }); } catch (e) {}
            return;
        }

        // عرض كل رسائل عضو محدد
        if (data.match(/^dev_user_msgs_\d+_\d+$/)) {
            var parts5 = data.replace('dev_user_msgs_', '').split('_');
            var umTid = parts5[0];
            var umPage = parseInt(parts5[1]) || 1;
            await showUserMessages(chatId, umTid, umPage, msgId);
            return;
        }

        // عرض رسالة مجتمعية كاملة للمطور
        if (data.startsWith('dev_view_msg_')) {
            var cmid = parseInt(data.replace('dev_view_msg_', ''));
            var m = await getCommunityMessage(cmid);
            if (!m) { await bot.sendMessage(chatId, '⚠️ الرسالة غير موجودة.'); return; }
            var mSenderUser = await getUser(m.sender_id);
    var alias2 = getSenderAlias(m.sender_id, m.sender_name, mSenderUser ? mSenderUser.nickname : null);
            var fullInfo = '📨 *رسالة #' + m.id + '*\n\n'
                + '👤 ' + alias2 + '\n'
                + '🆔 ID: `' + m.sender_id + '`\n'
                + '🕒 ' + formatTime(m.ts) + '\n'
                + (m.reply_to_id ? '↩️ رد على #' + m.reply_to_id + '\n' : '')
                + (m.media_type ? '📎 ' + m.media_type + '\n' : '')
                + '\n💬 ' + (m.content || '[وسائط]');
            var deliveries = await getDeliveryByCommunityMsgId(cmid);
            fullInfo += '\n\n📬 وصلت لـ ' + deliveries.length + ' عضو';
            try { await bot.editMessageText(fullInfo, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_feed_1' }]] } }); } catch (e) {}
            return;
        }

    } catch (err) {
        console.error('خطأ callback مطور:', err.message);
    }
}

// ===== عرض رسائل المجتمع للمطور =====
async function showDevFeed(chatId, page, editMsgId) {
    var perPage = 8;
    var offset = (page - 1) * perPage;
    var msgs = await getCommunityMessages(perPage, offset);
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages', []);
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

// ===== تفاصيل عضو للمطور (ملف شامل) =====
async function showDevUserDetail(chatId, tid, editMsgId) {
    var u = await getUser(tid);
    if (!u) { await bot.sendMessage(chatId, '❌ العضو غير موجود.'); return; }

    // إحصائيات الرسائل
    var msgCount = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=?', [String(tid)]);
    var mc = msgCount[0] ? msgCount[0].cnt : 0;

    // آخر 3 رسائل للعضو
    var lastMsgs = await query(
        'SELECT content, media_type, ts FROM community_messages WHERE sender_id=? ORDER BY ts DESC LIMIT 3',
        [String(tid)]
    );

    // رسائل اليوم
    var todayMsgs = await query(
        'SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND ts > ?',
        [String(tid), Date.now() - 86400000]
    );
    var tmc = todayMsgs[0] ? todayMsgs[0].cnt : 0;

    // رسائل الأسبوع
    var weekMsgs = await query(
        'SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=? AND ts > ?',
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
        [{ text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر العضو', callback_data: 'dev_do_' + (u.banned ? 'unban' : 'ban') + '_' + tid },
         { text: u.muted ? '🔊 رفع الكتم' : '🔇 كتم العضو', callback_data: 'dev_do_' + (u.muted ? 'unmute' : 'mute') + '_' + tid }],
        [{ text: '💬 مراسلة العضو', callback_data: 'dev_do_reply_' + tid }],
        [{ text: '📜 كل رسائله', callback_data: 'dev_user_msgs_' + tid + '_1' }],
        [{ text: '🔙 رجوع للأعضاء', callback_data: 'dev_users_1' }]
    ];

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

// ===== عرض كل رسائل عضو محدد للمطور =====
async function showUserMessages(chatId, tid, page, editMsgId) {
    var u = await getUser(tid);
    var userName = u ? (u.name || 'مجهول') : tid;
    var perPage = 5;
    var offset = (page - 1) * perPage;

    var msgs = await query(
        'SELECT * FROM community_messages WHERE sender_id=? ORDER BY ts DESC LIMIT ? OFFSET ?',
        [String(tid), perPage, offset]
    );
    var totalRows = await query('SELECT COUNT(*) as cnt FROM community_messages WHERE sender_id=?', [String(tid)]);
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
        var label = (u.banned ? '🚫 ' : '') + (u.muted ? '🔇 ' : '') + (u.name || 'بدون اسم');
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

// ===== معالجة رسائل المطور =====
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

    // إذا لم يكن في أي وضع -> افتح لوحة التحكم
    await sendMainMenu(chatId);
}

// ===== Express + Keep-Alive =====
var app = express();
app.get('/', function(req, res) { res.send('Community Bot is running! 🤖'); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });
var port = process.env.PORT || 3000;
var serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.listen(port, function() {
    console.log('✅ Port ' + port);
    // Keep-Alive: منع الخمول على Render المجاني (ping كل 14 دقيقة)
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
