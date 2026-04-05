var TelegramBot = require('node-telegram-bot-api');
var express = require('express');
var mysql = require('mysql2/promise');
var https = require('https');
var http = require('http');

// ===== إعدادات البوت =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var developerId = '7411444902';

// ===== قائمة الأدمنية =====
var adminIds = [developerId];

function isAdminUser(userId) {
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

async function createPool() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        console.log('✅ تم إنشاء pool قاعدة البيانات');
        await initDB();
    } catch (e) {
        console.error('❌ خطأ:', e.message);
        setTimeout(createPool, 5000);
    }
}

async function initDB() {
    try {
        var conn = await pool.getConnection();

        await conn.execute("CREATE TABLE IF NOT EXISTS users (id VARCHAR(50) PRIMARY KEY, username VARCHAR(255) DEFAULT '', name VARCHAR(500) DEFAULT '', first_seen BIGINT DEFAULT 0, last_seen BIGINT DEFAULT 0, messages_count INT DEFAULT 0, banned TINYINT(1) DEFAULT 0, muted TINYINT(1) DEFAULT 0) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

        await conn.execute("CREATE TABLE IF NOT EXISTS admins (user_id VARCHAR(50) PRIMARY KEY, added_by VARCHAR(50) NOT NULL, added_at BIGINT DEFAULT 0) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

        await conn.execute("CREATE TABLE IF NOT EXISTS msg_map (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(50) NOT NULL, user_msg_id INT NOT NULL, fwd_msg_id INT NOT NULL, fwd_chat_id VARCHAR(50) NOT NULL, ts BIGINT DEFAULT 0, INDEX idx_user (user_id), INDEX idx_fwd (fwd_msg_id, fwd_chat_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

        // تحميل الأدمنية من قاعدة البيانات
        var adminRows = await conn.execute('SELECT user_id FROM admins');
        for (var i = 0; i < adminRows[0].length; i++) {
            if (adminIds.indexOf(adminRows[0][i].user_id) === -1) {
                adminIds.push(adminRows[0][i].user_id);
            }
        }

        conn.release();
        console.log('✅ تم تهيئة الجداول');
    } catch (e) {
        console.error('❌ خطأ تهيئة:', e.message);
    }
}

async function query(sql, params) {
    for (var i = 0; i < 3; i++) {
        try {
            var result = await pool.execute(sql, params || []);
            return result[0];
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(function(r) { setTimeout(r, 1000 * (i + 1)); });
        }
    }
}

// ===== دوال المستخدمين =====
async function getUser(userId) {
    try {
        var rows = await query('SELECT * FROM users WHERE id=?', [String(userId)]);
        if (rows.length === 0) return null;
        var u = rows[0]; u.banned = u.banned === 1; u.muted = u.muted === 1;
        return u;
    } catch (e) { return null; }
}

async function getAllUsers() {
    try {
        var rows = await query('SELECT * FROM users ORDER BY last_seen DESC', []);
        return rows.map(function(u) { u.banned = u.banned === 1; u.muted = u.muted === 1; return u; });
    } catch (e) { return []; }
}

async function updateUser(userId, userName, fullName) {
    var now = Date.now();
    try {
        var existing = await getUser(userId);
        if (!existing) {
            await query('INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, banned, muted) VALUES (?, ?, ?, ?, ?, 1, 0, 0)', [String(userId), userName || '', fullName || '', now, now]);
        } else {
            await query('UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=? WHERE id=?', [now, userName || existing.username || '', fullName || existing.name || '', String(userId)]);
        }
    } catch (e) {}
}

async function setUserField(userId, field, value) {
    try { await query('UPDATE users SET ' + field + '=? WHERE id=?', [value, String(userId)]); } catch (e) {}
}

// ===== دوال الأدمنية =====
async function addAdmin(userId, addedBy) {
    // المطور لا يُضاف كأدمن (هو أعلى مرتبة)
    if (String(userId) === developerId) return;
    try {
        await query('INSERT IGNORE INTO admins (user_id, added_by, added_at) VALUES (?, ?, ?)', [String(userId), String(addedBy), Date.now()]);
        if (adminIds.indexOf(String(userId)) === -1) adminIds.push(String(userId));
    } catch (e) {}
}

async function removeAdmin(userId) {
    // المطور محمي تماماً - لا يمكن إزالته أبداً
    if (String(userId) === developerId) return;
    try {
        await query('DELETE FROM admins WHERE user_id=?', [String(userId)]);
        var idx = adminIds.indexOf(String(userId));
        if (idx > -1) adminIds.splice(idx, 1);
    } catch (e) {}
}

async function getAdminList() {
    try { return await query('SELECT a.*, u.name, u.username FROM admins a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.added_at DESC'); } catch (e) { return []; }
}

// ===== دوال ربط الرسائل =====
async function saveMsgMap(userId, userMsgId, fwdMsgId, fwdChatId) {
    try { await query('INSERT INTO msg_map (user_id, user_msg_id, fwd_msg_id, fwd_chat_id, ts) VALUES (?, ?, ?, ?, ?)', [String(userId), userMsgId, fwdMsgId, String(fwdChatId), Date.now()]); } catch (e) {}
}

async function getUserByFwdMsg(fwdMsgId, fwdChatId) {
    try {
        var rows = await query('SELECT user_id FROM msg_map WHERE fwd_msg_id=? AND fwd_chat_id=?', [fwdMsgId, String(fwdChatId)]);
        return rows.length > 0 ? rows[0].user_id : null;
    } catch (e) { return null; }
}

// ===== دوال مساعدة =====
function formatTime(ts) {
    return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserName(u) {
    var n = u.name || 'مجهول';
    if (u.username) n += ' (@' + u.username + ')';
    return n;
}

// ===== المتغيرات العامة =====
var bot = null;
var devState = {};
var pendingNotify = {};

// ===== تشغيل البوت =====
async function startBot() {
    await createPool();

    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('🤖 بوت الأساتذة يعمل...');

    bot.setMyCommands([
        { command: 'start', description: '🏠 القائمة الرئيسية' }
    ]).catch(function() {});

    // ===== أمر /start =====
    bot.onText(/^\/(start|panel)$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        if (isAdminUser(userId)) {
            devState[chatId] = {};
            await sendMainMenu(chatId);
            await notifyPendingUsers(userId);
            return;
        }

        // تحقق إذا مستخدم جديد قبل التحديث
        var isNew = !(await getUser(userId));
        await updateUser(userId, msg.from.username, fullName);

        // رسالة الترحيب الكاملة
        var introText = '🎓 *هنا أستاذك الخاص*\n\n'
            + 'لقد كثرت الـ AI بشكل كبير ومتفرع جداً، وكلهن متخصصات حتى في حل الواجبات والتكاليف وكل ما يتعلق بالأسئلة الوزارية.\n\n'
            + 'ولكن نحيطك علماً — وأنت تعرف ذلك — أن *50% من إجاباتهم خاطئة* ❌\n\n'
            + 'لهذا، هذا البوت يوفر لكم *أساتذة ومعيدين متخصصين* لخدمتكم شخصياً مع *ضمان الإجابات 100%* ✅\n\n'
            + 'سوف يصل طلبك للأستاذ المناسب فوراً.\n\n'
            + '━━━━━━━━━━━━━━━\n'
            + '👋 أهلاً بك *' + (fullName || 'عزيزي') + '*!\n\n'
            + '📩 أرسل سؤالك أو طلبك الآن مباشرة وسيصل للأستاذ.\n\n'
            + '📌 *يمكنك إرسال:*\n'
            + '• 📝 نصوص وأسئلة\n'
            + '• 📸 صور بدقة عالية\n'
            + '• 🎥 فيديوهات\n'
            + '• 📁 ملفات وواجبات\n'
            + '• 🎤 مقاطع صوتية\n'
            + '• أي شيء!\n\n'
            + '✅ سوف نعلمك فور فتح الأستاذ للمحادثة.';

        await bot.sendMessage(chatId, introText, { parse_mode: 'Markdown' });

        // إشعار جميع الأدمنية بمستخدم جديد
        if (isNew) {
            var newUserNotif = '🆕 *مستخدم جديد انضم!*\n━━━━━━━━━━━━━━━\n'
                + '👤 ' + (fullName || 'بدون اسم') + '\n'
                + '🔗 ' + (msg.from.username ? '@' + msg.from.username : 'بدون يوزر') + '\n'
                + '🆔 `' + userId + '`\n'
                + '🕒 ' + formatTime(Date.now());
            var adminsNew = await getAdminList();
            var recipientsNew = [developerId];
            for (var ni = 0; ni < adminsNew.length; ni++) {
                if (adminsNew[ni].user_id !== developerId) recipientsNew.push(adminsNew[ni].user_id);
            }
            for (var nj = 0; nj < recipientsNew.length; nj++) {
                try {
                    await bot.sendMessage(recipientsNew[nj], newUserNotif, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '💬 مراسلة', callback_data: 'qr_' + userId }]] }
                    });
                } catch (e) {}
            }
        }
    });

    // ===== إشعار المستخدمين بفتح المحادثة =====
    async function notifyPendingUsers(adminId) {
        var keys = Object.keys(pendingNotify);
        for (var i = 0; i < keys.length; i++) {
            var uid = keys[i];
            if (pendingNotify[uid] && !pendingNotify[uid].notified) {
                try {
                    await bot.sendMessage(uid,
                        '👀 *تمت قراءة رسالتك*\n\n'
                        + '✅ الأستاذ فتح المحادثة وسوف يطلع على رسائلك ويرد عليك قريباً.\n\n'
                        + '⏳ يرجى الانتظار، الرد في الطريق إليك!',
                        { parse_mode: 'Markdown' }
                    );
                    pendingNotify[uid].notified = true;
                } catch (e) {}
            }
        }
        setTimeout(function() {
            var ks = Object.keys(pendingNotify);
            for (var j = 0; j < ks.length; j++) {
                if (pendingNotify[ks[j]] && pendingNotify[ks[j]].notified) {
                    delete pendingNotify[ks[j]];
                }
            }
        }, 3000);
    }

    // ===== لوحة التحكم الرئيسية =====
    async function sendMainMenu(chatId, editMsgId) {
        var allUsers = await getAllUsers();
        var total = allUsers.length;
        var banned = allUsers.filter(function(u) { return u.banned; }).length;
        var muted = allUsers.filter(function(u) { return u.muted; }).length;
        var dayAgo = Date.now() - 86400000;
        var active = allUsers.filter(function(u) { return u.last_seen > dayAgo; }).length;
        var admins = await getAdminList();

        var text = '🔧 *لوحة التحكم*\n'
            + '━━━━━━━━━━━━━━━\n'
            + '👥 المستخدمين: ' + total + '\n'
            + '🟢 نشطين اليوم: ' + active + '\n'
            + '🚫 محظورين: ' + banned + '\n'
            + '🔇 مكتومين: ' + muted + '\n'
            + '👨‍💼 الأدمنية: ' + (admins.length + 1) + '\n'
            + '━━━━━━━━━━━━━━━';

        var kb = [
            [{ text: '👥 المستخدمين', callback_data: 'users_1' }, { text: '📈 إحصائيات', callback_data: 'stats' }],
            [{ text: '📢 رسالة جماعية', callback_data: 'broadcast' }],
            [{ text: '🔨 حظر', callback_data: 'pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'pick_unban_1' }],
            [{ text: '🔇 كتم', callback_data: 'pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'pick_unmute_1' }],
            [{ text: '💬 مراسلة مستخدم', callback_data: 'pick_reply_1' }]
        ];

        if (isDeveloper(chatId)) {
            kb.push([{ text: '👨‍💼 إدارة الأدمنية', callback_data: 'admin_panel' }]);
        }

        if (editMsgId) {
            try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }); return; } catch (e) {}
        }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    }

    // ===== معالجة الأزرار =====
    bot.on('callback_query', async function(cbq) {
        var chatId = cbq.message.chat.id;
        var userId = cbq.from.id;
        var msgId = cbq.message.message_id;
        var data = cbq.data;

        await bot.answerCallbackQuery(cbq.id).catch(function() {});

        if (!isAdminUser(userId)) return;

        try {
            if (data === 'main') {
                devState[chatId] = {};
                await sendMainMenu(chatId, msgId);
                await notifyPendingUsers(userId);
                return;
            }

            if (data === 'noop') return;

            // ===== رد سريع =====
            if (data.startsWith('qr_')) {
                var qrId = data.replace('qr_', '');
                // حماية المطور من الإجراءات
                if (String(qrId) === developerId && !isDeveloper(userId)) return;
                devState[chatId] = { action: 'reply', targetId: qrId };
                var qrUser = await getUser(qrId);
                await bot.sendMessage(chatId, '💬 *الرد على: ' + (qrUser ? getUserName(qrUser) : qrId) + '*\n\n✏️ اكتب ردك الآن (نص، صورة، فيديو، ملف، أي شيء):', {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                });
                return;
            }

            // ===== قائمة المستخدمين =====
            if (data.startsWith('users_')) {
                var pg = parseInt(data.replace('users_', '')) || 1;
                await showUsers(chatId, pg, msgId);
                return;
            }

            // ===== تفاصيل مستخدم =====
            if (data.startsWith('user_') && !data.startsWith('user_msgs_')) {
                var tid = data.replace('user_', '');
                await showUserDetail(chatId, tid, msgId);
                return;
            }

            // ===== محادثات مستخدم =====
            if (data.match(/^user_msgs_\d+_\d+$/)) {
                var parts5 = data.replace('user_msgs_', '').split('_');
                await showUserConvo(chatId, parts5[0], parseInt(parts5[1]) || 1, msgId);
                return;
            }

            // ===== إحصائيات =====
            if (data === 'stats') {
                var allSt = await getAllUsers();
                var sd = Date.now() - 86400000;
                var sw = Date.now() - 604800000;
                var totalMsgs = 0;
                try { var mr = await query('SELECT COUNT(*) as cnt FROM msg_map', []); totalMsgs = mr[0] ? mr[0].cnt : 0; } catch (e) {}
                var todayMsgs = 0;
                try { var tr = await query('SELECT COUNT(*) as cnt FROM msg_map WHERE ts > ?', [Date.now() - 86400000]); todayMsgs = tr[0] ? tr[0].cnt : 0; } catch (e) {}

                var stxt = '📈 *الإحصائيات*\n━━━━━━━━━━━━━━━\n'
                    + '👥 إجمالي المستخدمين: ' + allSt.length + '\n'
                    + '🟢 نشطين اليوم: ' + allSt.filter(function(u) { return u.last_seen > sd; }).length + '\n'
                    + '🔵 نشطين الأسبوع: ' + allSt.filter(function(u) { return u.last_seen > sw; }).length + '\n'
                    + '🚫 محظورين: ' + allSt.filter(function(u) { return u.banned; }).length + '\n'
                    + '🔇 مكتومين: ' + allSt.filter(function(u) { return u.muted; }).length + '\n'
                    + '━━━━━━━━━━━━━━━\n'
                    + '💬 إجمالي الرسائل: ' + totalMsgs + '\n'
                    + '📨 رسائل اليوم: ' + todayMsgs;

                try { await bot.editMessageText(stxt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== رسالة جماعية =====
            if (data === 'broadcast') {
                devState[chatId] = { action: 'broadcast' };
                var allU = await getAllUsers();
                var activeCount = allU.filter(function(u) { return !u.banned; }).length;
                try { await bot.editMessageText('📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ' + activeCount + ' مستخدم:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== اختيار مستخدم للإجراء =====
            if (data.match(/^pick_(ban|unban|mute|unmute|reply)_\d+$/)) {
                var parts = data.split('_');
                var action = parts[1];
                var pg2 = parseInt(parts[2]) || 1;
                var filterFn = null;
                if (action === 'ban') filterFn = function(u) { return !u.banned && u.id !== developerId; };
                if (action === 'unban') filterFn = function(u) { return u.banned && u.id !== developerId; };
                if (action === 'mute') filterFn = function(u) { return !u.muted && u.id !== developerId; };
                if (action === 'unmute') filterFn = function(u) { return u.muted && u.id !== developerId; };
                var titles = { ban: '🔨 اختر مستخدم للحظر:', unban: '🔓 اختر مستخدم لرفع الحظر:', mute: '🔇 اختر مستخدم للكتم:', unmute: '🔊 اختر مستخدم لرفع الكتم:', reply: '💬 اختر مستخدم للمراسلة:' };
                var r = await buildUserBtns('do_' + action, pg2, filterFn, 'pick_' + action);
                var t2 = titles[action] || 'اختر:';
                if (r.total === 0) t2 += '\n\n⚠️ لا يوجد مستخدمين.';
                try { await bot.editMessageText(t2, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); } catch (e) {}
                return;
            }

            // ===== تنفيذ إجراء =====
            if (data.match(/^do_(ban|unban|mute|unmute)_\d+$/)) {
                var pp = data.replace('do_', '').split('_');
                var act = pp[0]; var tid2 = pp[1];
                // حماية المطور من أي إجراء
                if (String(tid2) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch (e) {}
                    return;
                }
                var u2 = await getUser(tid2);
                var actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم' };
                var ct = '*' + actNames[act] + '*\n\n👤 ' + (u2 ? getUserName(u2) : tid2) + '\n🆔 `' + tid2 + '`\n\nهل أنت متأكد؟';
                try { await bot.editMessageText(ct, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم', callback_data: 'cf_' + act + '_' + tid2 }, { text: '❌ لا', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== مراسلة مستخدم =====
            if (data.startsWith('do_reply_')) {
                var tid3 = data.replace('do_reply_', '');
                devState[chatId] = { action: 'reply', targetId: tid3 };
                var u3 = await getUser(tid3);
                try { await bot.editMessageText('💬 *مراسلة: ' + (u3 ? getUserName(u3) : tid3) + '*\n\n✏️ اكتب ردك (نص، صورة، فيديو، ملف، أي شيء):', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== تأكيد الإجراء =====
            if (data.startsWith('cf_')) {
                var pp4 = data.replace('cf_', '').split('_');
                var act4 = pp4[0]; var tid4 = pp4[1];
                // حماية المطور
                if (String(tid4) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch (e) {}
                    return;
                }
                var result = '';
                if (act4 === 'ban') {
                    await setUserField(tid4, 'banned', 1); result = '✅ تم حظر `' + tid4 + '`';
                    try { await bot.sendMessage(tid4, '⛔ تم حظرك من البوت.'); } catch (e) {}
                } else if (act4 === 'unban') {
                    await setUserField(tid4, 'banned', 0); result = '✅ تم رفع الحظر عن `' + tid4 + '`';
                    try { await bot.sendMessage(tid4, '✅ تم رفع الحظر عنك.'); } catch (e) {}
                } else if (act4 === 'mute') {
                    await setUserField(tid4, 'muted', 1); result = '✅ تم كتم `' + tid4 + '`';
                } else if (act4 === 'unmute') {
                    await setUserField(tid4, 'muted', 0); result = '✅ تم رفع الكتم عن `' + tid4 + '`';
                }
                try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== إدارة الأدمنية (المطور فقط) =====
            if (data === 'admin_panel') {
                if (!isDeveloper(userId)) { await bot.sendMessage(chatId, '⛔ فقط المطور.'); return; }
                await showAdminPanel(chatId, msgId);
                return;
            }

            if (data === 'add_admin_id') {
                if (!isDeveloper(userId)) return;
                devState[chatId] = { action: 'add_admin' };
                try { await bot.editMessageText('👨‍💼 *إضافة أدمن*\n\n✏️ أرسل ID الشخص:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_panel' }]] } }); } catch (e) {}
                return;
            }

            if (data.match(/^pick_add_admin_\d+$/)) {
                if (!isDeveloper(userId)) return;
                var pg3 = parseInt(data.replace('pick_add_admin_', '')) || 1;
                var r3 = await buildUserBtns('add_admin_from', pg3, function(u) { return u.id !== developerId; }, 'pick_add_admin');
                try { await bot.editMessageText('👨‍💼 اختر مستخدم لإضافته كأدمن:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r3.buttons } }); } catch (e) {}
                return;
            }

            if (data.startsWith('add_admin_from_')) {
                if (!isDeveloper(userId)) return;
                var aId = data.replace('add_admin_from_', '');
                if (String(aId) === developerId) { await bot.sendMessage(chatId, '⛔ المطور لا يُضاف كأدمن.'); return; }
                await addAdmin(aId, userId);
                var aUser = await getUser(aId);
                await bot.sendMessage(chatId, '✅ تم إضافة *' + (aUser ? getUserName(aUser) : aId) + '* كأدمن.', { parse_mode: 'Markdown' });
                try { await bot.sendMessage(aId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch (e) {}
                await showAdminPanel(chatId);
                return;
            }

            if (data.startsWith('rm_admin_')) {
                if (!isDeveloper(userId)) { await bot.sendMessage(chatId, '⛔ فقط المطور يمكنه إزالة الأدمنية.'); return; }
                var rmId = data.replace('rm_admin_', '');
                // حماية المطور
                if (String(rmId) === developerId) { await bot.sendMessage(chatId, '⛔ لا يمكن إزالة المطور.'); return; }
                await removeAdmin(rmId);
                var rmUser = await getUser(rmId);
                await bot.sendMessage(chatId, '✅ تم إزالة *' + (rmUser ? getUserName(rmUser) : rmId) + '* من الأدمنية.', { parse_mode: 'Markdown' });
                try { await bot.sendMessage(rmId, '⚠️ تم إزالتك من الأدمنية.'); } catch (e) {}
                await showAdminPanel(chatId);
                return;
            }

        } catch (err) {
            console.error('خطأ callback:', err.message);
        }
    });

    // ===== لوحة الأدمنية =====
    async function showAdminPanel(chatId, editMsgId) {
        var admins = await getAdminList();
        var text = '👨‍💼 *إدارة الأدمنية*\n━━━━━━━━━━━━━━━\n'
            + '👑 المطور: (ID: `' + developerId + '`) - محمي دائماً\n';

        var btns = [];
        if (admins.length > 0) {
            text += '\n📋 *الأدمنية الحاليين:*\n';
            for (var i = 0; i < admins.length; i++) {
                var a = admins[i];
                var aName = a.name || a.user_id;
                if (a.username) aName += ' @' + a.username;
                text += '• ' + aName + ' (ID: `' + a.user_id + '`)\n';
                btns.push([{ text: '❌ إزالة ' + (a.name || a.user_id), callback_data: 'rm_admin_' + a.user_id }]);
            }
        } else {
            text += '\n📭 لا يوجد أدمنية.';
        }

        btns.push([{ text: '➕ إضافة بالـ ID', callback_data: 'add_admin_id' }]);
        btns.push([{ text: '👥 إضافة من المستخدمين', callback_data: 'pick_add_admin_1' }]);
        btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

        if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
    }

    // ===== عرض المستخدمين =====
    async function showUsers(chatId, page, editMsgId) {
        var allUsers = await getAllUsers();
        var perPage = 8;
        var totalPages = Math.ceil(allUsers.length / perPage) || 1;
        if (page < 1) page = 1;
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * perPage;
        var pageUsers = allUsers.slice(start, start + perPage);

        var text = '👥 *المستخدمين* (' + allUsers.length + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━';
        var btns = [];

        for (var i = 0; i < pageUsers.length; i++) {
            var u = pageUsers[i];
            var label = '';
            if (u.banned) label += '🚫 ';
            if (u.muted) label += '🔇 ';
            if (u.id === developerId) label += '👑 ';
            label += (u.name || 'بدون اسم');
            if (u.username) label += ' @' + u.username;
            btns.push([{ text: label, callback_data: 'user_' + u.id }]);
        }

        var navRow = [];
        if (page > 1) navRow.push({ text: '⬅️', callback_data: 'users_' + (page - 1) });
        navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
        if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'users_' + (page + 1) });
        if (navRow.length > 0) btns.push(navRow);
        btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

        if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
    }

    // ===== تفاصيل مستخدم =====
    async function showUserDetail(chatId, tid, editMsgId) {
        var u = await getUser(tid);
        if (!u) { await bot.sendMessage(chatId, '❌ المستخدم غير موجود.'); return; }

        var msgCount = 0;
        try { var mc = await query('SELECT COUNT(*) as cnt FROM msg_map WHERE user_id=?', [String(tid)]); msgCount = mc[0] ? mc[0].cnt : 0; } catch (e) {}
        var todayMsgs = 0;
        try { var tm = await query('SELECT COUNT(*) as cnt FROM msg_map WHERE user_id=? AND ts > ?', [String(tid), Date.now() - 86400000]); todayMsgs = tm[0] ? tm[0].cnt : 0; } catch (e) {}

        var isDev = String(tid) === developerId;
        var text = '👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n'
            + (isDev ? '👑 *مطور البوت*\n' : '')
            + '📝 الاسم: ' + (u.name || '-') + '\n'
            + '🔗 يوزر: ' + (u.username ? '@' + u.username : '-') + '\n'
            + '🆔 ID: `' + u.id + '`\n'
            + '━━━━━━━━━━━━━━━\n'
            + '📨 إجمالي الرسائل: ' + msgCount + '\n'
            + '📅 رسائل اليوم: ' + todayMsgs + '\n'
            + '🕒 آخر نشاط: ' + formatTime(u.last_seen) + '\n'
            + '📅 أول دخول: ' + formatTime(u.first_seen) + '\n'
            + '━━━━━━━━━━━━━━━\n'
            + '🚫 محظور: ' + (u.banned ? '✅ نعم' : '❌ لا') + '\n'
            + '🔇 مكتوم: ' + (u.muted ? '✅ نعم' : '❌ لا');

        var kb = [];
        if (!isDev) {
            kb.push([
                { text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + tid },
                { text: u.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'do_' + (u.muted ? 'unmute' : 'mute') + '_' + tid }
            ]);
        }
        kb.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + tid }]);
        kb.push([{ text: '📜 عرض محادثاته', callback_data: 'user_msgs_' + tid + '_1' }]);
        kb.push([{ text: '🔙 رجوع', callback_data: 'users_1' }]);

        if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }); return; } catch (e) {} }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    }

    // ===== عرض محادثات مستخدم =====
    async function showUserConvo(chatId, tid, page, editMsgId) {
        var u = await getUser(tid);
        var uName = u ? (u.name || 'مجهول') : tid;
        var perPage = 10;
        var offset = (page - 1) * perPage;

        var msgs = [];
        try { msgs = await query('SELECT * FROM msg_map WHERE user_id=? ORDER BY ts DESC LIMIT ? OFFSET ?', [String(tid), perPage, offset]); } catch (e) {}
        var total = 0;
        try { var tc = await query('SELECT COUNT(*) as cnt FROM msg_map WHERE user_id=?', [String(tid)]); total = tc[0] ? tc[0].cnt : 0; } catch (e) {}
        var totalPages = Math.ceil(total / perPage) || 1;

        var text = '📜 *محادثات: ' + uName + '*\n📊 ' + total + ' رسالة | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';

        if (msgs.length === 0) {
            text += '📭 لا توجد رسائل.';
        } else {
            for (var i = 0; i < msgs.length; i++) {
                text += '📨 رسالة #' + msgs[i].id + ' | 🕒 ' + formatTime(msgs[i].ts) + '\n\n';
            }
        }

        var btns = [];
        var navRow = [];
        if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: 'user_msgs_' + tid + '_' + (page - 1) });
        navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
        if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'user_msgs_' + tid + '_' + (page + 1) });
        if (navRow.length > 0) btns.push(navRow);
        btns.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + tid }]);
        btns.push([{ text: '🔙 ملف المستخدم', callback_data: 'user_' + tid }]);

        if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }); return; } catch (e) {} }
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
    }

    // ===== بناء أزرار اختيار مستخدم =====
    async function buildUserBtns(actionPrefix, page, filterFn, pagePrefix) {
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
        navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
        if (page < totalPages) navRow.push({ text: '➡️', callback_data: pp + '_' + (page + 1) });
        if (navRow.length > 0) buttons.push(navRow);
        buttons.push([{ text: '🔙 رجوع', callback_data: 'main' }]);
        return { buttons: buttons, total: allUsers.length };
    }

    // ===== معالجة رسائل المستخدم العادي =====
    bot.on('message', async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        var userName = msg.from.username || '';
        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        if (msg.text && msg.text.startsWith('/')) return;

        // المطور أو الأدمن
        if (isAdminUser(userId)) {
            await handleAdminMsg(chatId, userId, msg);
            return;
        }

        // المستخدم العادي
        await updateUser(userId, userName, fullName);
        var user = await getUser(userId);
        if (user && user.banned) {
            await bot.sendMessage(chatId, '⛔ أنت محظور من البوت.');
            return;
        }
        if (user && user.muted) {
            await bot.sendMessage(chatId, '🔇 أنت مكتوم حالياً ولا يمكنك إرسال رسائل.');
            return;
        }

        var now = Date.now();
        var time = formatTime(now);
        var report = '📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n'
            + '👤 ' + (fullName || 'بدون اسم') + '\n'
            + '🔗 ' + (userName ? '@' + userName : 'بدون يوزر') + '\n'
            + '🆔 `' + userId + '`\n'
            + '🕒 ' + time + '\n━━━━━━━━━━━━━━━';

        var quickBtns = { inline_keyboard: [
            [{ text: '↩️ رد', callback_data: 'qr_' + userId }, { text: '🚫 حظر', callback_data: 'do_ban_' + userId }, { text: '🔇 كتم', callback_data: 'do_mute_' + userId }]
        ]};

        // قائمة المستلمين
        var recipients = [developerId];
        var admins = await getAdminList();
        for (var i = 0; i < admins.length; i++) {
            if (admins[i].user_id !== developerId) recipients.push(admins[i].user_id);
        }

        // تسجيل انتظار فتح المحادثة
        pendingNotify[String(userId)] = { notified: false, ts: now };

        var forwarded = false;
        for (var j = 0; j < recipients.length; j++) {
            try {
                await bot.sendMessage(recipients[j], report, { parse_mode: 'Markdown' });
                var fwd = await bot.forwardMessage(recipients[j], chatId, msg.message_id);
                await saveMsgMap(userId, msg.message_id, fwd.message_id, recipients[j]);
                await bot.sendMessage(recipients[j], '⬆️ من: *' + (fullName || 'مستخدم') + '*', { parse_mode: 'Markdown', reply_markup: quickBtns });
                forwarded = true;
            } catch (e) {
                console.log('فشل التحويل لـ ' + recipients[j] + ': ' + e.message);
            }
        }

        if (forwarded) {
            await bot.sendMessage(chatId,
                '✅ *تم استلام رسالتك!*\n\n'
                + '📬 رسالتك وصلت للأستاذ وسيطلع عليها قريباً.\n'
                + '⏳ سوف نعلمك فور فتح الأستاذ للمحادثة.',
                { parse_mode: 'Markdown' }
            );
        } else {
            await bot.sendMessage(chatId, '⚠️ حدث خطأ. حاول مرة أخرى.');
        }
    });

    // ===== معالجة رسائل المطور/الأدمن =====
    async function handleAdminMsg(chatId, userId, msg) {
        var state = devState[chatId] || {};

        if (msg.text && msg.text.startsWith('/')) return;

        // إضافة أدمن بالـ ID
        if (state.action === 'add_admin' && isDeveloper(userId)) {
            devState[chatId] = {};
            var adminId = (msg.text || '').trim();
            if (!adminId || !/^\d+$/.test(adminId)) {
                await bot.sendMessage(chatId, '⚠️ أرسل ID صحيح (أرقام فقط).', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'admin_panel' }]] } });
                return;
            }
            if (String(adminId) === developerId) {
                await bot.sendMessage(chatId, '⛔ المطور لا يُضاف كأدمن.');
                return;
            }
            await addAdmin(adminId, userId);
            await bot.sendMessage(chatId, '✅ تم إضافة `' + adminId + '` كأدمن.', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } });
            try { await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch (e) {}
            return;
        }

        // رسالة جماعية
        if (state.action === 'broadcast') {
            devState[chatId] = {};
            var all = (await getAllUsers()).filter(function(u) { return !u.banned && u.id; });
            var ok = 0, fail = 0;
            await bot.sendMessage(chatId, '📢 جاري الإرسال لـ ' + all.length + ' مستخدم...');
            for (var i = 0; i < all.length; i++) {
                try { await bot.copyMessage(all[i].id, chatId, msg.message_id); ok++; } catch (e) { fail++; }
            }
            await bot.sendMessage(chatId, '✅ تم! نجح: ' + ok + ' | فشل: ' + fail, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            return;
        }

        // رد على مستخدم
        if (state.action === 'reply' && state.targetId) {
            var target = state.targetId;
            devState[chatId] = {};
            try {
                await bot.copyMessage(target, chatId, msg.message_id);
                // إشعار المستخدم بالرد
                try {
                    await bot.sendMessage(target,
                        '💬 *وصلك رد من الأستاذ*\n\n'
                        + '⬇️ الرد أعلاه من الأستاذ المختص.',
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}
                await bot.sendMessage(chatId, '✅ تم إرسال الرد للمستخدم `' + target + '`', {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [
                        [{ text: '↩️ رد آخر', callback_data: 'qr_' + target }],
                        [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                    ]}
                });
            } catch (err) {
                await bot.sendMessage(chatId, '❌ فشل: ' + err.message, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            }
            return;
        }

        // رد عبر Reply على رسالة محولة
        if (msg.reply_to_message) {
            var repliedMsgId = msg.reply_to_message.message_id;
            var targetUserId = await getUserByFwdMsg(repliedMsgId, chatId);
            if (targetUserId) {
                try {
                    await bot.copyMessage(targetUserId, chatId, msg.message_id);
                    // إشعار المستخدم
                    try {
                        await bot.sendMessage(targetUserId,
                            '💬 *وصلك رد من الأستاذ*\n\n'
                            + '⬇️ الرد أعلاه من الأستاذ المختص.',
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {}
                    await bot.sendMessage(chatId, '✅ تم إرسال الرد للمستخدم `' + targetUserId + '`', {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '↩️ رد آخر', callback_data: 'qr_' + targetUserId }],
                            [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                        ]}
                    });
                } catch (err) {
                    await bot.sendMessage(chatId, '❌ فشل: ' + err.message);
                }
                return;
            }
        }

        // إذا ما في حالة → لوحة التحكم
        await sendMainMenu(chatId);
    }

    console.log('✅ البوت جاهز');
}

// ===== Express + Keep-Alive =====
var app = express();
app.get('/', function(req, res) { res.send('Teachers Bot is running! 🎓'); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });
var port = process.env.PORT || 3000;
var serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.listen(port, function() {
    console.log('✅ Port ' + port);
    setInterval(function() {
        var url = serverUrl + '/health';
        var protocol = url.startsWith('https') ? https : http;
        protocol.get(url, function(res) { console.log('🔄 Keep-alive: ' + res.statusCode); }).on('error', function(e) { console.log('⚠️ Keep-alive error: ' + e.message); });
    }, 14 * 60 * 1000);
});

startBot().catch(function(e) {
    console.error('خطأ:', e.message);
    process.exit(1);
});
