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

        await conn.execute("CREATE TABLE IF NOT EXISTS admins (user_id VARCHAR(50) PRIMARY KEY, added_by VARCHAR(50) NOT NULL, added_at BIGINT DEFAULT 0, multi_reply TINYINT(1) DEFAULT 0) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

        // إضافة عمود multi_reply إذا لم يكن موجوداً
        try { await conn.execute('ALTER TABLE admins ADD COLUMN multi_reply TINYINT(1) DEFAULT 0'); } catch(e) {}

        await conn.execute("CREATE TABLE IF NOT EXISTS msg_map (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(50) NOT NULL, user_msg_id INT NOT NULL, fwd_msg_id INT NOT NULL, fwd_chat_id VARCHAR(50) NOT NULL, ts BIGINT DEFAULT 0, INDEX idx_user (user_id), INDEX idx_fwd (fwd_msg_id, fwd_chat_id)) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");

        // جدول التذاكر/الطلبات
        await conn.execute(`CREATE TABLE IF NOT EXISTS tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            claimed_by VARCHAR(50) DEFAULT NULL,
            claimed_at BIGINT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'open',
            created_at BIGINT DEFAULT 0,
            completed_at BIGINT DEFAULT 0,
            rating INT DEFAULT 0,
            INDEX idx_user (user_id),
            INDEX idx_claimed (claimed_by),
            INDEX idx_status (status)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        // جدول إشعارات التحديث
        await conn.execute(`CREATE TABLE IF NOT EXISTS bot_updates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            version VARCHAR(50) NOT NULL,
            msg_users TEXT,
            msg_admins TEXT,
            created_at BIGINT DEFAULT 0,
            sent TINYINT(1) DEFAULT 0
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

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
    if (String(userId) === developerId) return;
    try {
        await query('INSERT IGNORE INTO admins (user_id, added_by, added_at, multi_reply) VALUES (?, ?, ?, 0)', [String(userId), String(addedBy), Date.now()]);
        if (adminIds.indexOf(String(userId)) === -1) adminIds.push(String(userId));
    } catch (e) {}
}

async function removeAdmin(userId) {
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

async function canAdminReply(adminId, targetUserId) {
    // المطور يستطيع دائماً
    if (isDeveloper(adminId)) return true;
    // تحقق من صلاحية multi_reply
    try {
        var rows = await query('SELECT multi_reply FROM admins WHERE user_id=?', [String(adminId)]);
        var multiReply = rows[0] ? rows[0].multi_reply === 1 : false;
        // تحقق من التذكرة المفتوحة
        var ticket = await getOpenTicket(targetUserId);
        if (!ticket) return true; // لا يوجد تذكرة مفتوحة
        if (ticket.claimed_by === String(adminId)) return true; // هو صاحب التذكرة
        if (multiReply) return false; // له صلاحية multi_reply لكن التذكرة محجوزة لآخر
        return false; // التذكرة محجوزة لآخر
    } catch (e) { return true; }
}

// ===== دوال التذاكر =====
async function getOpenTicket(userId) {
    try {
        var rows = await query("SELECT * FROM tickets WHERE user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1", [String(userId)]);
        return rows[0] || null;
    } catch (e) { return null; }
}

async function createTicket(userId) {
    try {
        var result = await query('INSERT INTO tickets (user_id, status, created_at) VALUES (?, ?, ?)', [String(userId), 'open', Date.now()]);
        return result.insertId;
    } catch (e) { return null; }
}

async function claimTicket(ticketId, adminId) {
    try {
        await query('UPDATE tickets SET claimed_by=?, claimed_at=? WHERE id=? AND claimed_by IS NULL', [String(adminId), Date.now(), ticketId]);
        var rows = await query('SELECT * FROM tickets WHERE id=?', [ticketId]);
        return rows[0] || null;
    } catch (e) { return null; }
}

async function completeTicket(ticketId) {
    try {
        await query("UPDATE tickets SET status='completed', completed_at=? WHERE id=?", [Date.now(), ticketId]);
    } catch (e) {}
}

async function rateTicket(ticketId, rating) {
    try {
        await query('UPDATE tickets SET rating=? WHERE id=?', [rating, ticketId]);
    } catch (e) {}
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
            // عرض إشعار التحديث للأدمن
            await showPendingUpdate(chatId, 'admin');
            return;
        }

        // تحقق إذا مستخدم جديد قبل التحديث
        var isNew = !(await getUser(userId));
        await updateUser(userId, msg.from.username, fullName);

        // عرض إشعار التحديث للمستخدم
        await showPendingUpdate(chatId, 'user');

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

    // ===== عرض إشعار التحديث المعلق =====
    async function showPendingUpdate(chatId, role) {
        try {
            var updates = await query("SELECT * FROM bot_updates WHERE sent=0 ORDER BY created_at DESC LIMIT 1", []);
            if (!updates || updates.length === 0) return;
            var upd = updates[0];
            var msgText = role === 'admin' ? upd.msg_admins : upd.msg_users;
            if (!msgText) return;
            await bot.sendMessage(chatId,
                '🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n' + msgText,
                { parse_mode: 'Markdown' }
            );
            // علّم التحديث كمُرسَل بعد إرساله للجميع (نتركه حتى يُرسَل يدوياً)
        } catch (e) {}
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

        // إحصائيات التذاكر
        var openTickets = 0;
        var claimedTickets = 0;
        try {
            var ot = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open' AND claimed_by IS NULL", []);
            openTickets = ot[0] ? ot[0].cnt : 0;
            var ct = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open' AND claimed_by IS NOT NULL", []);
            claimedTickets = ct[0] ? ct[0].cnt : 0;
        } catch (e) {}

        var text = '🔧 *لوحة التحكم*\n'
            + '━━━━━━━━━━━━━━━\n'
            + '👥 المستخدمين: ' + total + '\n'
            + '🟢 نشطين اليوم: ' + active + '\n'
            + '🚫 محظورين: ' + banned + '\n'
            + '🔇 مكتومين: ' + muted + '\n'
            + '👨‍💼 الأدمنية: ' + (admins.length + 1) + '\n'
            + '━━━━━━━━━━━━━━━\n'
            + '🎫 طلبات مفتوحة: ' + openTickets + '\n'
            + '🔒 طلبات محجوزة: ' + claimedTickets + '\n'
            + '━━━━━━━━━━━━━━━';

        var kb = [
            [{ text: '👥 المستخدمين', callback_data: 'users_1' }, { text: '📈 إحصائيات', callback_data: 'stats' }],
            [{ text: '📢 رسالة جماعية', callback_data: 'broadcast' }],
            [{ text: '🔨 حظر', callback_data: 'pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'pick_unban_1' }],
            [{ text: '🔇 كتم', callback_data: 'pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'pick_unmute_1' }],
            [{ text: '💬 مراسلة مستخدم', callback_data: 'pick_reply_1' }],
            [{ text: '🎫 الطلبات المفتوحة', callback_data: 'tickets_open_1' }]
        ];

        if (isDeveloper(chatId)) {
            kb.push([{ text: '👨‍💼 إدارة الأدمنية', callback_data: 'admin_panel' }]);
            kb.push([{ text: '📣 إرسال إشعار تحديث', callback_data: 'send_update' }]);
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

        if (!isAdminUser(userId)) {
            // أزرار المستخدم العادي
            await handleUserCallback(chatId, userId, msgId, data);
            return;
        }

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
                if (String(qrId) === developerId && !isDeveloper(userId)) return;
                // تحقق من صلاحية الرد
                var canReply = await canAdminReply(userId, qrId);
                if (!canReply) {
                    var ticket = await getOpenTicket(qrId);
                    var claimerUser = ticket ? await getUser(ticket.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id, {
                        text: '⛔ هذا الطلب محجوز من: ' + (claimerUser ? (claimerUser.name || ticket.claimed_by) : (ticket ? ticket.claimed_by : 'أدمن آخر')),
                        show_alert: true
                    }).catch(function() {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId: qrId };
                var qrUser = await getUser(qrId);
                await bot.sendMessage(chatId, '💬 *الرد على: ' + (qrUser ? getUserName(qrUser) : qrId) + '*\n\n✏️ اكتب ردك الآن (نص، صورة، فيديو، ملف، أي شيء):', {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                });
                return;
            }

            // ===== التكفل بطلب =====
            if (data.startsWith('claim_')) {
                var claimUserId = data.replace('claim_', '').split('_')[0];
                var claimTicketId = parseInt(data.replace('claim_', '').split('_')[1]);
                if (String(claimUserId) === developerId && !isDeveloper(userId)) return;
                // تحقق أن التذكرة لم تُحجز بعد
                var ticketRows = await query('SELECT * FROM tickets WHERE id=? AND claimed_by IS NULL', [claimTicketId]);
                if (!ticketRows || ticketRows.length === 0) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⚠️ هذا الطلب تم حجزه من قبل أدمن آخر!', show_alert: true }).catch(function() {});
                    return;
                }
                var claimed = await claimTicket(claimTicketId, userId);
                if (!claimed || claimed.claimed_by !== String(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⚠️ هذا الطلب تم حجزه من قبل أدمن آخر!', show_alert: true }).catch(function() {});
                    return;
                }
                var claimAdminUser = await getUser(userId);
                var claimTargetUser = await getUser(claimUserId);
                // إشعار المستخدم
                try {
                    await bot.sendMessage(claimUserId,
                        '✅ *تم التكفل بطلبك!*\n\n'
                        + '👨‍🏫 الأستاذ *' + (claimAdminUser ? (claimAdminUser.name || 'الأستاذ') : 'الأستاذ') + '* سيتولى طلبك الآن.\n'
                        + '⏳ يرجى الانتظار، الرد في الطريق إليك!',
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}
                // إشعار الأدمنية الآخرين
                var allAdmins = await getAdminList();
                var allRecipients = [developerId];
                for (var ai = 0; ai < allAdmins.length; ai++) {
                    if (allAdmins[ai].user_id !== developerId) allRecipients.push(allAdmins[ai].user_id);
                }
                for (var aj = 0; aj < allRecipients.length; aj++) {
                    if (String(allRecipients[aj]) === String(userId)) continue;
                    try {
                        await bot.sendMessage(allRecipients[aj],
                            '🔒 *تم حجز الطلب*\n'
                            + '👤 المستخدم: ' + (claimTargetUser ? getUserName(claimTargetUser) : claimUserId) + '\n'
                            + '👨‍💼 بواسطة: ' + (claimAdminUser ? getUserName(claimAdminUser) : userId),
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {}
                }
                // تحديث رسالة الأدمن الذي ضغط
                try {
                    await bot.editMessageReplyMarkup({
                        inline_keyboard: [
                            [{ text: '↩️ رد على المستخدم', callback_data: 'qr_' + claimUserId }],
                            [{ text: '✅ تم إنهاء المهمة', callback_data: 'done_' + claimUserId + '_' + claimTicketId }],
                            [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                        ]
                    }, { chat_id: chatId, message_id: msgId });
                } catch (e) {}
                await bot.sendMessage(chatId,
                    '✅ *تكفلت بطلب المستخدم*\n'
                    + '👤 ' + (claimTargetUser ? getUserName(claimTargetUser) : claimUserId) + '\n\n'
                    + 'يمكنك الآن الرد عليه. عند الانتهاء اضغط "تم إنهاء المهمة".',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '↩️ رد على المستخدم', callback_data: 'qr_' + claimUserId }],
                            [{ text: '✅ تم إنهاء المهمة', callback_data: 'done_' + claimUserId + '_' + claimTicketId }],
                            [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                        ]}
                    }
                );
                return;
            }

            // ===== إنهاء المهمة =====
            if (data.startsWith('done_')) {
                var doneParts = data.replace('done_', '').split('_');
                var doneUserId = doneParts[0];
                var doneTicketId = parseInt(doneParts[1]);
                // تحقق أن هذا الأدمن هو صاحب التذكرة أو المطور
                var doneTicket = await query('SELECT * FROM tickets WHERE id=?', [doneTicketId]);
                if (!doneTicket || doneTicket.length === 0) { await bot.sendMessage(chatId, '⚠️ الطلب غير موجود.'); return; }
                if (doneTicket[0].claimed_by !== String(userId) && !isDeveloper(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ فقط الأدمن الذي تكفل بالطلب يمكنه إنهاءه.', show_alert: true }).catch(function() {});
                    return;
                }
                await completeTicket(doneTicketId);
                var doneTargetUser = await getUser(doneUserId);
                // إرسال طلب التقييم للمستخدم
                try {
                    await bot.sendMessage(doneUserId,
                        '✅ *تم إنهاء طلبك بنجاح!*\n\n'
                        + '🙏 نشكرك على استخدام البوت.\n\n'
                        + '⭐ *كيف تقيّم تجربتك مع الأستاذ؟*',
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [
                                [
                                    { text: '⭐', callback_data: 'rate_' + doneTicketId + '_1' },
                                    { text: '⭐⭐', callback_data: 'rate_' + doneTicketId + '_2' },
                                    { text: '⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_3' }
                                ],
                                [
                                    { text: '⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_4' },
                                    { text: '⭐⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_5' }
                                ]
                            ]}
                        }
                    );
                } catch (e) {}
                await bot.sendMessage(chatId,
                    '✅ *تم إنهاء المهمة!*\n'
                    + '👤 ' + (doneTargetUser ? getUserName(doneTargetUser) : doneUserId) + '\n\n'
                    + 'تم إرسال طلب التقييم للمستخدم.',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] }
                    }
                );
                return;
            }

            // ===== عرض الطلبات المفتوحة =====
            if (data.startsWith('tickets_open_')) {
                var tPage = parseInt(data.replace('tickets_open_', '')) || 1;
                await showOpenTickets(chatId, tPage, msgId);
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
                var totalTickets = 0;
                var completedTickets = 0;
                try { var ttr = await query('SELECT COUNT(*) as cnt FROM tickets', []); totalTickets = ttr[0] ? ttr[0].cnt : 0; } catch (e) {}
                try { var ctr = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='completed'", []); completedTickets = ctr[0] ? ctr[0].cnt : 0; } catch (e) {}
                var avgRating = 0;
                try { var rtr = await query("SELECT AVG(rating) as avg FROM tickets WHERE rating > 0", []); avgRating = rtr[0] ? (parseFloat(rtr[0].avg) || 0).toFixed(1) : 0; } catch (e) {}

                var stxt = '📈 *الإحصائيات*\n━━━━━━━━━━━━━━━\n'
                    + '👥 إجمالي المستخدمين: ' + allSt.length + '\n'
                    + '🟢 نشطين اليوم: ' + allSt.filter(function(u) { return u.last_seen > sd; }).length + '\n'
                    + '🔵 نشطين الأسبوع: ' + allSt.filter(function(u) { return u.last_seen > sw; }).length + '\n'
                    + '🚫 محظورين: ' + allSt.filter(function(u) { return u.banned; }).length + '\n'
                    + '🔇 مكتومين: ' + allSt.filter(function(u) { return u.muted; }).length + '\n'
                    + '━━━━━━━━━━━━━━━\n'
                    + '💬 إجمالي الرسائل: ' + totalMsgs + '\n'
                    + '📨 رسائل اليوم: ' + todayMsgs + '\n'
                    + '━━━━━━━━━━━━━━━\n'
                    + '🎫 إجمالي الطلبات: ' + totalTickets + '\n'
                    + '✅ مكتملة: ' + completedTickets + '\n'
                    + '⭐ متوسط التقييم: ' + avgRating + '/5';

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

            // ===== إشعار تحديث (المطور فقط) =====
            if (data === 'send_update') {
                if (!isDeveloper(userId)) return;
                devState[chatId] = { action: 'send_update_users' };
                try { await bot.editMessageText(
                    '📣 *إرسال إشعار تحديث*\n\n'
                    + 'الخطوة 1/2: اكتب رسالة التحديث للمستخدمين العاديين:\n'
                    + '(أو أرسل "-" لتخطي رسالة المستخدمين)',
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }
                ); } catch (e) {}
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
                var canR = await canAdminReply(userId, tid3);
                if (!canR) {
                    var t3 = await getOpenTicket(tid3);
                    var cl3 = t3 ? await getUser(t3.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ هذا الطلب محجوز من: ' + (cl3 ? (cl3.name || t3.claimed_by) : 'أدمن آخر'), show_alert: true }).catch(function() {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId: tid3 };
                var u3 = await getUser(tid3);
                try { await bot.editMessageText('💬 *مراسلة: ' + (u3 ? getUserName(u3) : tid3) + '*\n\n✏️ اكتب ردك (نص، صورة، فيديو، ملف):', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }); } catch (e) {}
                return;
            }

            // ===== تأكيد الإجراء =====
            if (data.startsWith('cf_')) {
                var pp4 = data.replace('cf_', '').split('_');
                var act4 = pp4[0]; var tid4 = pp4[1];
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
                if (String(rmId) === developerId) { await bot.sendMessage(chatId, '⛔ لا يمكن إزالة المطور.'); return; }
                await removeAdmin(rmId);
                var rmUser = await getUser(rmId);
                await bot.sendMessage(chatId, '✅ تم إزالة *' + (rmUser ? getUserName(rmUser) : rmId) + '* من الأدمنية.', { parse_mode: 'Markdown' });
                try { await bot.sendMessage(rmId, '⚠️ تم إزالتك من الأدمنية.'); } catch (e) {}
                await showAdminPanel(chatId);
                return;
            }

            // ===== منح صلاحية multi_reply =====
            if (data.startsWith('toggle_multi_')) {
                if (!isDeveloper(userId)) return;
                var tmId = data.replace('toggle_multi_', '');
                var tmRows = await query('SELECT multi_reply FROM admins WHERE user_id=?', [String(tmId)]);
                var curVal = tmRows[0] ? tmRows[0].multi_reply : 0;
                var newVal = curVal ? 0 : 1;
                await query('UPDATE admins SET multi_reply=? WHERE user_id=?', [newVal, String(tmId)]);
                var tmUser = await getUser(tmId);
                await bot.sendMessage(chatId,
                    (newVal ? '✅ تم منح' : '❌ تم سحب') + ' صلاحية الرد على أكثر من مستخدم من *' + (tmUser ? getUserName(tmUser) : tmId) + '*',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } }
                );
                return;
            }

        } catch (err) {
            console.error('خطأ callback:', err.message);
        }
    });

    // ===== أزرار المستخدم العادي =====
    async function handleUserCallback(chatId, userId, msgId, data) {
        // تقييم الخدمة
        if (data.startsWith('rate_')) {
            var rateParts = data.replace('rate_', '').split('_');
            var rateTicketId = parseInt(rateParts[0]);
            var rateValue = parseInt(rateParts[1]);
            await rateTicket(rateTicketId, rateValue);
            var stars = '';
            for (var s = 0; s < rateValue; s++) stars += '⭐';
            try {
                await bot.editMessageText(
                    '🙏 *شكراً على تقييمك!*\n\n'
                    + 'تقييمك: ' + stars + '\n\n'
                    + 'نسعى دائماً لتقديم أفضل خدمة. 💙',
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
            } catch (e) {}
            // إشعار المطور بالتقييم
            try {
                var rateTicketRow = await query('SELECT * FROM tickets WHERE id=?', [rateTicketId]);
                if (rateTicketRow && rateTicketRow.length > 0) {
                    var rateAdminId = rateTicketRow[0].claimed_by;
                    var rateAdminUser = rateAdminId ? await getUser(rateAdminId) : null;
                    var rateUserObj = await getUser(userId);
                    await bot.sendMessage(developerId,
                        '⭐ *تقييم جديد*\n'
                        + '👤 المستخدم: ' + (rateUserObj ? getUserName(rateUserObj) : userId) + '\n'
                        + '👨‍💼 الأستاذ: ' + (rateAdminUser ? getUserName(rateAdminUser) : (rateAdminId || 'غير محدد')) + '\n'
                        + 'التقييم: ' + stars,
                        { parse_mode: 'Markdown' }
                    );
                    if (rateAdminId && rateAdminId !== developerId) {
                        try {
                            await bot.sendMessage(rateAdminId,
                                '⭐ *تقييمك من المستخدم*\n'
                                + '👤 ' + (rateUserObj ? getUserName(rateUserObj) : userId) + '\n'
                                + 'التقييم: ' + stars,
                                { parse_mode: 'Markdown' }
                            );
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
    }

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
                var multiLabel = a.multi_reply ? ' 🔓متعدد' : '';
                text += '• ' + aName + multiLabel + ' (ID: `' + a.user_id + '`)\n';
                btns.push([
                    { text: '❌ إزالة ' + (a.name || a.user_id), callback_data: 'rm_admin_' + a.user_id },
                    { text: (a.multi_reply ? '🔒 سحب متعدد' : '🔓 منح متعدد'), callback_data: 'toggle_multi_' + a.user_id }
                ]);
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

    // ===== عرض الطلبات المفتوحة =====
    async function showOpenTickets(chatId, page, editMsgId) {
        var perPage = 5;
        var offset = (page - 1) * perPage;
        var tickets = [];
        var total = 0;
        try {
            tickets = await query("SELECT t.*, u.name, u.username FROM tickets t LEFT JOIN users u ON t.user_id = u.id WHERE t.status='open' ORDER BY t.created_at DESC LIMIT ? OFFSET ?", [perPage, offset]);
            var tc = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open'", []);
            total = tc[0] ? tc[0].cnt : 0;
        } catch (e) {}
        var totalPages = Math.ceil(total / perPage) || 1;

        var text = '🎫 *الطلبات المفتوحة* (' + total + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';
        var btns = [];

        if (tickets.length === 0) {
            text += '📭 لا توجد طلبات مفتوحة.';
        } else {
            for (var i = 0; i < tickets.length; i++) {
                var t = tickets[i];
                var uName = t.name || t.user_id;
                if (t.username) uName += ' @' + t.username;
                var status = t.claimed_by ? '🔒 محجوز' : '🟢 مفتوح';
                text += status + ' | 👤 ' + uName + '\n🕒 ' + formatTime(t.created_at) + '\n\n';
                var rowBtns = [{ text: '👤 ' + uName, callback_data: 'user_' + t.user_id }];
                if (!t.claimed_by) {
                    rowBtns.push({ text: '🙋 سأتكفل بهذا الطلب', callback_data: 'claim_' + t.user_id + '_' + t.id });
                }
                btns.push(rowBtns);
            }
        }

        var navRow = [];
        if (page > 1) navRow.push({ text: '⬅️', callback_data: 'tickets_open_' + (page - 1) });
        navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
        if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_open_' + (page + 1) });
        if (navRow.length > 0) btns.push(navRow);
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
        var ticketCount = 0;
        try { var tkc = await query('SELECT COUNT(*) as cnt FROM tickets WHERE user_id=?', [String(tid)]); ticketCount = tkc[0] ? tkc[0].cnt : 0; } catch (e) {}
        var avgRating = 0;
        try { var ar = await query('SELECT AVG(rating) as avg FROM tickets WHERE user_id=? AND rating > 0', [String(tid)]); avgRating = ar[0] ? (parseFloat(ar[0].avg) || 0).toFixed(1) : 0; } catch (e) {}

        var isDev = String(tid) === developerId;
        var text = '👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n'
            + (isDev ? '👑 *مطور البوت*\n' : '')
            + '📝 الاسم: ' + (u.name || '-') + '\n'
            + '🔗 يوزر: ' + (u.username ? '@' + u.username : '-') + '\n'
            + '🆔 ID: `' + u.id + '`\n'
            + '━━━━━━━━━━━━━━━\n'
            + '📨 إجمالي الرسائل: ' + msgCount + '\n'
            + '📅 رسائل اليوم: ' + todayMsgs + '\n'
            + '🎫 إجمالي الطلبات: ' + ticketCount + '\n'
            + '⭐ متوسط التقييم: ' + avgRating + '/5\n'
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

        // إنشاء تذكرة جديدة لهذا الطلب
        var ticketId = await createTicket(userId);

        var quickBtns = { inline_keyboard: [
            [
                { text: '↩️ رد', callback_data: 'qr_' + userId },
                { text: '🚫 حظر', callback_data: 'do_ban_' + userId },
                { text: '🔇 كتم', callback_data: 'do_mute_' + userId }
            ],
            [
                { text: '🙋 سأتكفل بهذا الطلب', callback_data: 'claim_' + userId + '_' + ticketId }
            ]
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

        // إشعار التحديث - رسالة المستخدمين
        if (state.action === 'send_update_users' && isDeveloper(userId)) {
            devState[chatId] = { action: 'send_update_admins', update_users_msg: msg.text === '-' ? null : msg.text };
            await bot.sendMessage(chatId,
                '📣 *إرسال إشعار تحديث*\n\n'
                + 'الخطوة 2/2: اكتب رسالة التحديث للأدمنية:\n'
                + '(أو أرسل "-" لتخطي رسالة الأدمنية)',
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }
            );
            return;
        }

        // إشعار التحديث - رسالة الأدمنية
        if (state.action === 'send_update_admins' && isDeveloper(userId)) {
            var usersMsg = state.update_users_msg;
            var adminsMsg = msg.text === '-' ? null : msg.text;
            devState[chatId] = {};

            if (!usersMsg && !adminsMsg) {
                await bot.sendMessage(chatId, '⚠️ لم تكتب أي رسالة.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                return;
            }

            // حفظ التحديث في قاعدة البيانات
            try {
                await query('INSERT INTO bot_updates (version, msg_users, msg_admins, created_at, sent) VALUES (?, ?, ?, ?, 0)',
                    [formatTime(Date.now()), usersMsg || '', adminsMsg || '', Date.now()]);
            } catch (e) {}

            // إرسال للمستخدمين
            var allUsersForUpdate = await getAllUsers();
            var sentOk = 0;
            if (usersMsg) {
                for (var ui = 0; ui < allUsersForUpdate.length; ui++) {
                    var uu = allUsersForUpdate[ui];
                    if (isAdminUser(uu.id)) continue;
                    try {
                        await bot.sendMessage(uu.id,
                            '🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n' + usersMsg + '\n\nاضغط /start لرؤية التحديث.',
                            { parse_mode: 'Markdown' }
                        );
                        sentOk++;
                    } catch (e) {}
                }
            }

            // إرسال للأدمنية
            if (adminsMsg) {
                var allAdminsForUpdate = await getAdminList();
                var adminRecipients = [developerId];
                for (var adi = 0; adi < allAdminsForUpdate.length; adi++) {
                    if (allAdminsForUpdate[adi].user_id !== developerId) adminRecipients.push(allAdminsForUpdate[adi].user_id);
                }
                for (var adj = 0; adj < adminRecipients.length; adj++) {
                    if (String(adminRecipients[adj]) === String(userId)) continue;
                    try {
                        await bot.sendMessage(adminRecipients[adj],
                            '🔔 *تحديث للأدمنية!*\n━━━━━━━━━━━━━━━\n' + adminsMsg + '\n\nاضغط /start لرؤية التحديث.',
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {}
                }
            }

            await bot.sendMessage(chatId,
                '✅ *تم إرسال إشعار التحديث!*\n'
                + '📨 أُرسل للمستخدمين: ' + sentOk + '\n'
                + (adminsMsg ? '👨‍💼 أُرسل للأدمنية أيضاً' : ''),
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } }
            );
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
