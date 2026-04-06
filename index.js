const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
const BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const developerId = '7411444902';

// ===== إعدادات قاعدة البيانات (MySQL) ====
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
let bot = null;
let devState = {};
let pendingNotify = {};
let adminIds = [developerId];

// ===== الصلاحيات الافتراضية (نفس الكود الأول) =====
const DEFAULT_PERMISSIONS = {
    canBan: true,
    canMute: true,
    canBroadcast: false,
    canViewStats: true,
    canManageTickets: true,
    canManageGroups: true,
    canReplyUsers: true
};

// ===== دوال قاعدة البيانات =====
async function createPool() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        console.log('✅ تم إنشاء pool MySQL');
        await initDB();
    } catch (e) {
        console.error('❌ خطأ في pool:', e.message);
        setTimeout(createPool, 5000);
    }
}

async function query(sql, params = []) {
    for (let i = 0; i < 3; i++) {
        try {
            const [rows] = await pool.execute(sql, params);
            return rows;
        } catch (e) {
            if (i === 2) throw e;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

async function initDB() {
    try {
        // ===== جداول المستخدمين والأدمنية (مدمجة من الكودين) =====
        await query(`CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(50) PRIMARY KEY,
            username VARCHAR(255) DEFAULT '',
            name VARCHAR(500) DEFAULT '',
            first_seen BIGINT DEFAULT 0,
            last_seen BIGINT DEFAULT 0,
            messages_count INT DEFAULT 0,
            banned TINYINT(1) DEFAULT 0,
            muted TINYINT(1) DEFAULT 0,
            phone VARCHAR(50) DEFAULT '',
            verified TINYINT(1) DEFAULT 0
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS admins (
            user_id VARCHAR(50) PRIMARY KEY,
            added_by VARCHAR(50) NOT NULL,
            added_at BIGINT DEFAULT 0,
            permissions JSON,
            multi_reply TINYINT(1) DEFAULT 0,
            last_login BIGINT DEFAULT 0,
            total_active_minutes INT DEFAULT 0,
            helped_count INT DEFAULT 0
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        // إضافة أعمدة إذا لم توجد (للتوافق)
        try { await query(`ALTER TABLE admins ADD COLUMN permissions JSON`); } catch(e) {}
        try { await query(`ALTER TABLE admins ADD COLUMN multi_reply TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await query(`ALTER TABLE admins ADD COLUMN last_login BIGINT DEFAULT 0`); } catch(e) {}
        try { await query(`ALTER TABLE admins ADD COLUMN total_active_minutes INT DEFAULT 0`); } catch(e) {}
        try { await query(`ALTER TABLE admins ADD COLUMN helped_count INT DEFAULT 0`); } catch(e) {}

        // ===== جداول التذاكر والأحداث (مطورة مثل الكود الثاني) =====
        await query(`CREATE TABLE IF NOT EXISTS tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            claimed_by VARCHAR(50) DEFAULT NULL,
            claimed_at BIGINT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'open',
            created_at BIGINT DEFAULT 0,
            completed_at BIGINT DEFAULT 0,
            rating INT DEFAULT 0,
            admin_reply_count INT DEFAULT 0,
            user_locked TINYINT(1) DEFAULT 0,
            INDEX idx_user (user_id),
            INDEX idx_claimed (claimed_by),
            INDEX idx_status (status)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS ticket_events (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id INT NOT NULL,
            user_id VARCHAR(50) NOT NULL,
            role VARCHAR(20) DEFAULT 'user',
            event_type VARCHAR(30) DEFAULT 'message',
            content TEXT,
            ts BIGINT DEFAULT 0,
            INDEX idx_ticket (ticket_id),
            INDEX idx_user (user_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        // ===== جداول إضافية من الكود الثاني =====
        await query(`CREATE TABLE IF NOT EXISTS cb_data (
            id INT AUTO_INCREMENT PRIMARY KEY,
            data TEXT NOT NULL,
            ts BIGINT DEFAULT 0
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS msg_map (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            user_msg_id INT NOT NULL,
            fwd_msg_id INT NOT NULL,
            fwd_chat_id VARCHAR(50) NOT NULL,
            ts BIGINT DEFAULT 0,
            INDEX idx_user (user_id),
            INDEX idx_fwd (fwd_msg_id, fwd_chat_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS suggestions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL,
            text TEXT NOT NULL,
            ts BIGINT DEFAULT 0,
            status VARCHAR(20) DEFAULT 'new',
            INDEX idx_user (user_id),
            INDEX idx_status (status)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS bot_updates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            version VARCHAR(50) NOT NULL,
            msg_users TEXT,
            msg_admins TEXT,
            created_at BIGINT DEFAULT 0,
            sent TINYINT(1) DEFAULT 0
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        // ===== جداول القروبات (من الكود الأول) =====
        await query(`CREATE TABLE IF NOT EXISTS groups (
            group_id VARCHAR(50) PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            username VARCHAR(255) DEFAULT '',
            member_count INT DEFAULT 0,
            added_at BIGINT DEFAULT 0,
            added_by VARCHAR(50) NOT NULL,
            is_active TINYINT(1) DEFAULT 1
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS group_members (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(50) NOT NULL,
            user_id VARCHAR(50) NOT NULL,
            username VARCHAR(255) DEFAULT '',
            name VARCHAR(500) DEFAULT '',
            phone VARCHAR(50) DEFAULT '',
            is_admin TINYINT(1) DEFAULT 0,
            is_bot TINYINT(1) DEFAULT 0,
            is_owner TINYINT(1) DEFAULT 0,
            banned TINYINT(1) DEFAULT 0,
            muted TINYINT(1) DEFAULT 0,
            warnings INT DEFAULT 0,
            joined_at BIGINT DEFAULT 0,
            last_seen BIGINT DEFAULT 0,
            UNIQUE KEY uk_group_user (group_id, user_id),
            INDEX idx_group (group_id),
            INDEX idx_user (user_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS group_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(50) NOT NULL,
            user_id VARCHAR(50) NOT NULL,
            message_id INT NOT NULL,
            text TEXT,
            ts BIGINT DEFAULT 0,
            INDEX idx_group (group_id),
            INDEX idx_user (user_id)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        // تحميل قائمة الأدمنية من قاعدة البيانات
        const adminsRows = await query('SELECT user_id FROM admins');
        for (const row of adminsRows) {
            if (!adminIds.includes(row.user_id)) adminIds.push(row.user_id);
        }

        // إضافة المطور كأدمن إن لم يكن موجوداً (اختياري)
        const devExists = await query('SELECT user_id FROM admins WHERE user_id=?', [developerId]);
        if (devExists.length === 0) {
            await query('INSERT IGNORE INTO admins (user_id, added_by, added_at, permissions) VALUES (?, ?, ?, ?)',
                [developerId, developerId, Date.now(), JSON.stringify({ ...DEFAULT_PERMISSIONS, canBroadcast: true, canManageGroups: true })]);
        }

        console.log('✅ تم تهيئة جميع الجداول');
    } catch (e) {
        console.error('❌ خطأ تهيئة DB:', e.message);
        throw e;
    }
}

// ===== دوال مساعدة لـ cb_data (نفس الكود الأول) =====
async function saveCB(data) {
    if (data.length < 50) return data;
    const res = await query('INSERT INTO cb_data (data, ts) VALUES (?, ?)', [data, Date.now()]);
    return 'c_' + res.insertId;
}

async function getCB(id) {
    if (!id.startsWith('c_')) return id;
    const rows = await query('SELECT data FROM cb_data WHERE id=?', [id.substring(2)]);
    return rows.length > 0 ? rows[0].data : null;
}

// ===== دوال المستخدمين (معدلة لـ MySQL) =====
async function getUser(userId) {
    try {
        const rows = await query('SELECT * FROM users WHERE id=?', [String(userId)]);
        if (rows.length === 0) return null;
        const u = rows[0];
        u.banned = u.banned === 1;
        u.muted = u.muted === 1;
        u.verified = u.verified === 1;
        return u;
    } catch (e) { return null; }
}

async function getAllUsers() {
    try {
        const rows = await query('SELECT * FROM users ORDER BY last_seen DESC');
        return rows.map(u => { u.banned = u.banned === 1; u.muted = u.muted === 1; u.verified = u.verified === 1; return u; });
    } catch (e) { return []; }
}

async function updateUser(userId, userName, fullName) {
    const now = Date.now();
    try {
        const existing = await getUser(userId);
        if (!existing) {
            await query('INSERT INTO users (id, username, name, first_seen, last_seen, messages_count) VALUES (?, ?, ?, ?, ?, 1)',
                [String(userId), userName || '', fullName || '', now, now]);
        } else {
            await query('UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=? WHERE id=?',
                [now, userName || existing.username || '', fullName || existing.name || '', String(userId)]);
        }
    } catch (e) { console.error('خطأ updateUser:', e.message); }
}

async function setUserField(userId, field, value) {
    try { await query(`UPDATE users SET ${field}=? WHERE id=?`, [value, String(userId)]); } catch(e) {}
}

// ===== دوال الأدمنية والصلاحيات (معدلة) =====
function isAdminUser(userId) {
    return adminIds.includes(String(userId));
}

function isDeveloper(userId) {
    return String(userId) === developerId;
}

async function addAdmin(userId, addedBy, permissions = DEFAULT_PERMISSIONS) {
    if (String(userId) === developerId) return;
    try {
        await query('INSERT IGNORE INTO admins (user_id, added_by, added_at, permissions) VALUES (?, ?, ?, ?)',
            [String(userId), String(addedBy), Date.now(), JSON.stringify(permissions)]);
        if (!adminIds.includes(String(userId))) adminIds.push(String(userId));
    } catch (e) {}
}

async function removeAdmin(userId) {
    if (String(userId) === developerId) return;
    try {
        await query('DELETE FROM admins WHERE user_id=?', [String(userId)]);
        const idx = adminIds.indexOf(String(userId));
        if (idx > -1) adminIds.splice(idx, 1);
    } catch (e) {}
}

async function getAdminList() {
    try {
        const rows = await query(`SELECT a.*, u.name, u.username FROM admins a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.added_at DESC`);
        return rows.map(r => ({ ...r, permissions: r.permissions ? JSON.parse(r.permissions) : DEFAULT_PERMISSIONS, multi_reply: r.multi_reply === 1 }));
    } catch (e) { return []; }
}

async function getAdminPermissions(adminId) {
    if (isDeveloper(adminId)) return { ...DEFAULT_PERMISSIONS, canBroadcast: true, canManageGroups: true };
    try {
        const rows = await query('SELECT permissions FROM admins WHERE user_id=?', [String(adminId)]);
        if (rows.length && rows[0].permissions) return JSON.parse(rows[0].permissions);
        return DEFAULT_PERMISSIONS;
    } catch (e) { return DEFAULT_PERMISSIONS; }
}

async function updateAdminPermissions(adminId, permissions) {
    try {
        await query('UPDATE admins SET permissions=? WHERE user_id=?', [JSON.stringify(permissions), String(adminId)]);
    } catch (e) {}
}

async function canAdminReply(adminId, targetUserId) {
    if (isDeveloper(adminId)) return true;
    const perms = await getAdminPermissions(adminId);
    if (!perms.canReplyUsers) return false;
    const ticket = await getOpenTicket(targetUserId);
    if (!ticket) return true;
    if (ticket.claimed_by === String(adminId)) return true;
    const rows = await query('SELECT multi_reply FROM admins WHERE user_id=?', [String(adminId)]);
    const multiReply = rows.length ? rows[0].multi_reply === 1 : false;
    return multiReply;
}

// ===== دوال التذاكر والأحداث (متطورة مثل الكود الثاني) =====
async function getOpenTicket(userId) {
    try {
        const rows = await query("SELECT * FROM tickets WHERE user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1", [String(userId)]);
        return rows[0] || null;
    } catch (e) { return null; }
}

async function createTicket(userId) {
    try {
        const result = await query('INSERT INTO tickets (user_id, status, created_at) VALUES (?, ?, ?)', [String(userId), 'open', Date.now()]);
        return result.insertId;
    } catch (e) { return null; }
}

async function claimTicket(ticketId, adminId) {
    try {
        await query('UPDATE tickets SET claimed_by=?, claimed_at=? WHERE id=? AND claimed_by IS NULL', [String(adminId), Date.now(), ticketId]);
        const rows = await query('SELECT * FROM tickets WHERE id=?', [ticketId]);
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

async function saveTicketEvent(ticketId, userId, role, eventType, content) {
    try {
        await query('INSERT INTO ticket_events (ticket_id, user_id, role, event_type, content, ts) VALUES (?, ?, ?, ?, ?, ?)',
            [ticketId, String(userId), role, eventType, content || '', Date.now()]);
    } catch (e) {}
}

// ===== دوال رسائل الماب =====
async function saveMsgMap(userId, userMsgId, fwdMsgId, fwdChatId) {
    try {
        await query('INSERT INTO msg_map (user_id, user_msg_id, fwd_msg_id, fwd_chat_id, ts) VALUES (?, ?, ?, ?, ?)',
            [String(userId), userMsgId, fwdMsgId, String(fwdChatId), Date.now()]);
    } catch (e) {}
}

async function getUserByFwdMsg(fwdMsgId, fwdChatId) {
    try {
        const rows = await query('SELECT user_id FROM msg_map WHERE fwd_msg_id=? AND fwd_chat_id=?', [fwdMsgId, String(fwdChatId)]);
        return rows.length > 0 ? rows[0].user_id : null;
    } catch (e) { return null; }
}

// ===== دوال القروبات (من الكود الأول مع تعديل بسيط) =====
async function saveGroup(groupId, title, username, memberCount, addedBy) {
    try {
        await query(`INSERT INTO groups (group_id, title, username, member_count, added_at, added_by, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE title=?, username=?, member_count=?, is_active=1`,
            [String(groupId), title, username || '', memberCount || 0, Date.now(), String(addedBy), title, username || '', memberCount || 0]);
    } catch (e) {}
}

async function updateGroupMember(groupId, userId, username, name, phone, isAdmin, isBot, isOwner) {
    try {
        const now = Date.now();
        const existing = await query('SELECT * FROM group_members WHERE group_id=? AND user_id=?', [String(groupId), String(userId)]);
        if (existing.length === 0) {
            await query(`INSERT INTO group_members (group_id, user_id, username, name, phone, is_admin, is_bot, is_owner, joined_at, last_seen) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [String(groupId), String(userId), username || '', name || '', phone || '', isAdmin ? 1 : 0, isBot ? 1 : 0, isOwner ? 1 : 0, now, now]);
        } else {
            await query(`UPDATE group_members SET username=?, name=?, phone=?, is_admin=?, is_bot=?, is_owner=?, last_seen=? 
                WHERE group_id=? AND user_id=?`,
                [username || '', name || '', phone || '', isAdmin ? 1 : 0, isBot ? 1 : 0, isOwner ? 1 : 0, now, String(groupId), String(userId)]);
        }
    } catch (e) { console.error('خطأ updateGroupMember:', e.message); }
}

async function updateMemberLastSeen(groupId, userId) {
    try {
        await query('UPDATE group_members SET last_seen=? WHERE group_id=? AND user_id=?', [Date.now(), String(groupId), String(userId)]);
    } catch (e) {}
}

async function saveGroupMessage(groupId, userId, messageId, text) {
    try {
        await query('INSERT INTO group_messages (group_id, user_id, message_id, text, ts) VALUES (?, ?, ?, ?, ?)',
            [String(groupId), String(userId), messageId, text || '', Date.now()]);
    } catch (e) {}
}

async function getAllGroups() {
    try {
        return await query('SELECT * FROM groups WHERE is_active=1 ORDER BY added_at DESC');
    } catch (e) { return []; }
}

async function getGroupMembers(groupId) {
    try {
        return await query('SELECT * FROM group_members WHERE group_id=? ORDER BY last_seen DESC', [String(groupId)]);
    } catch (e) { return []; }
}

async function setGroupMemberField(groupId, userId, field, value) {
    try {
        await query(`UPDATE group_members SET ${field}=? WHERE group_id=? AND user_id=?`, [value, String(groupId), String(userId)]);
    } catch (e) {}
}

// ===== دوال إشعارات التحديث (من الكود الثاني) =====
async function showPendingUpdate(chatId, role) {
    try {
        const updates = await query("SELECT * FROM bot_updates WHERE sent=0 ORDER BY created_at DESC LIMIT 1");
        if (!updates.length) return;
        const upd = updates[0];
        const msgText = role === 'admin' ? upd.msg_admins : upd.msg_users;
        if (!msgText) return;
        await bot.sendMessage(chatId,
            '🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n' + msgText,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}
}

// ===== دوال عرض سجل التذكرة (مثل الكود الثاني) =====
async function showTicketLog(chatId, ticketId, editMsgId) {
    const tickets = await query(
        `SELECT t.*, u.name AS uname, u.username AS uuser, a.name AS aname, a.username AS auser 
         FROM tickets t 
         LEFT JOIN users u ON t.user_id = u.id 
         LEFT JOIN users a ON t.claimed_by = a.id 
         WHERE t.id=?`, [ticketId]);
    if (tickets.length === 0) {
        await bot.sendMessage(chatId, '❌ الطلب غير موجود.');
        return;
    }
    const t = tickets[0];
    const events = await query('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY ts ASC', [ticketId]);

    const uName = t.uname || t.user_id;
    const aName = t.aname || (t.claimed_by || 'غير محدد');
    const statusIcon = t.status === 'completed' ? '✅ مكتمل' : '🔒 جاري';
    let ratingStars = '';
    if (t.rating > 0) for (let s = 0; s < t.rating; s++) ratingStars += '⭐';

    let header = `💬 *سجل الطلب #${ticketId}*\n━━━━━━━━━━━━━━━\n👤 العميل: ${uName}\n👨‍💼 الأستاذ: ${aName}\n📅 بدأ: ${formatTime(t.created_at)}\n🔖 الحالة: ${statusIcon}\n${ratingStars ? `⭐ التقييم: ${ratingStars}\n` : ''}━━━━━━━━━━━━━━━\n\n`;

    let convo = '';
    if (events.length === 0) {
        convo = '📭 لا توجد أحداث مسجلة بعد.';
    } else {
        for (const ev of events) {
            const timeStr = formatTime(ev.ts);
            const roleIcon = ev.role === 'admin' ? '👨‍💼' : '👤';
            const roleName = ev.role === 'admin' ? (aName.split(' ')[0]) : (uName.split(' ')[0]);
            if (ev.event_type === 'message') {
                convo += `${roleIcon} *${roleName}*\n┌─────────────────\n│ ${(ev.content || '').replace(/\n/g, '\n│ ')}\n└─ 🕒 ${timeStr}\n\n`;
            } else if (ev.event_type === 'claimed') {
                convo += `🔒 ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
            } else if (ev.event_type === 'completed') {
                convo += `✅ ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
            } else if (ev.event_type === 'verified') {
                convo += `🔐 ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
            } else if (ev.event_type === 'rating') {
                convo += `⭐ ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
            } else {
                convo += `📌 ─── ${ev.content || ev.event_type} ─── 🕒 ${timeStr}\n\n`;
            }
        }
    }
    let fullText = header + convo;
    if (fullText.length > 4000) fullText = fullText.substring(0, 3900) + '\n\n... (مقتطع)';

    const btns = [
        [{ text: '💬 مراسلة العميل', callback_data: await saveCB('qr_' + t.user_id) }],
        [{ text: '🔙 الطلبات المعلقة', callback_data: 'tickets_claimed_1' }]
    ];
    if (editMsgId) {
        try {
            await bot.editMessageText(fullText, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال عرض الطلبات المعلقة (للمطور فقط) =====
async function showClaimedTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;
    const tickets = await query(
        `SELECT t.*, u.name AS uname, u.username AS uuser, a.name AS aname, a.username AS auser 
         FROM tickets t 
         LEFT JOIN users u ON t.user_id = u.id 
         LEFT JOIN users a ON t.claimed_by = a.id 
         WHERE t.claimed_by IS NOT NULL 
         ORDER BY t.claimed_at DESC LIMIT ? OFFSET ?`,
        [perPage, offset]);
    const totalRes = await query("SELECT COUNT(*) as cnt FROM tickets WHERE claimed_by IS NOT NULL");
    const total = totalRes[0]?.cnt || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `📋 *الطلبات المعلقة* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (tickets.length === 0) {
        text += '📭 لا توجد طلبات معلقة.';
    } else {
        for (const t of tickets) {
            const uName = t.uname || t.user_id;
            const aName = t.aname || t.claimed_by;
            const statusIcon = t.status === 'completed' ? '✅' : '🔒';
            text += `${statusIcon} طلب #${t.id}\n👤 العميل: ${uName}\n👨‍💼 الأستاذ: ${aName}\n🕒 ${formatTime(t.claimed_at)}\n\n`;
            btns.push([{ text: `${statusIcon} #${t.id} - ${uName}`, callback_data: await saveCB('ticket_log_' + t.id) }]);
        }
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'tickets_claimed_' + (page - 1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_claimed_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال عرض الطلبات المفتوحة (معدلة) =====
async function showOpenTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;
    const tickets = await query(
        `SELECT t.*, u.name, u.username FROM tickets t LEFT JOIN users u ON t.user_id = u.id WHERE t.status='open' ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
        [perPage, offset]);
    const totalRes = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open'");
    const total = totalRes[0]?.cnt || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `🎫 *الطلبات المفتوحة* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (tickets.length === 0) {
        text += '📭 لا توجد طلبات مفتوحة.';
    } else {
        for (const t of tickets) {
            const uName = t.name || t.user_id;
            const status = t.claimed_by ? '🔒 محجوز' : '🟢 مفتوح';
            text += `${status} | 👤 ${uName}\n🕒 ${formatTime(t.created_at)}\n\n`;
            const rowBtns = [{ text: `👤 ${uName}`, callback_data: 'user_' + t.user_id }];
            if (!t.claimed_by) {
                rowBtns.push({ text: '🙋 سأتكفل بهذا الطلب', callback_data: await saveCB('claim_' + t.user_id + '_' + t.id) });
            }
            btns.push(rowBtns);
        }
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'tickets_open_' + (page - 1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_open_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال عرض الاقتراحات =====
async function showSuggestions(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;
    const suggestions = await query(
        `SELECT s.*, u.name, u.username FROM suggestions s LEFT JOIN users u ON s.user_id = u.id ORDER BY s.ts DESC LIMIT ? OFFSET ?`,
        [perPage, offset]);
    const totalRes = await query('SELECT COUNT(*) as cnt FROM suggestions');
    const total = totalRes[0]?.cnt || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `💡 *الاقتراحات* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (suggestions.length === 0) {
        text += '📭 لا توجد اقتراحات.';
    } else {
        for (const sg of suggestions) {
            const sgUser = sg.name || sg.user_id;
            const isNew = sg.status === 'new' ? '🔴 ' : '✅ ';
            text += `${isNew}👤 ${sgUser}\n💬 ${(sg.text || '').substring(0, 100)}${sg.text && sg.text.length > 100 ? '...' : ''}\n🕒 ${formatTime(sg.ts)}\n\n`;
            if (sg.status === 'new') {
                btns.push([{ text: `✅ قرأته #${sg.id}`, callback_data: 'sg_read_' + sg.id }]);
            }
        }
    }
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'suggestions_' + (page - 1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'suggestions_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال عرض المستخدمين والمحادثات (من الكود الأول مع تعديلات) =====
async function showUsers(chatId, page, editMsgId) {
    const allUsers = await getAllUsers();
    const perPage = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    let pg = page;
    if (pg < 1) pg = 1;
    if (pg > totalPages) pg = totalPages;
    const start = (pg - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);

    let text = `👥 *المستخدمين* (${allUsers.length}) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━`;
    const btns = [];
    for (const u of pageUsers) {
        let label = '';
        if (u.banned) label += '🚫 ';
        if (u.muted) label += '🔇 ';
        if (u.id === developerId) label += '👑 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        btns.push([{ text: label, callback_data: 'user_' + u.id }]);
    }
    const navRow = [];
    if (pg > 1) navRow.push({ text: '⬅️', callback_data: 'users_' + (pg - 1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: 'users_' + (pg + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function showUserDetail(chatId, targetId, editMsgId) {
    const u = await getUser(targetId);
    if (!u) { await bot.sendMessage(chatId, '❌ المستخدم غير موجود.'); return; }

    const msgCount = (await query('SELECT COUNT(*) as cnt FROM msg_map WHERE user_id=?', [targetId]))[0]?.cnt || 0;
    const todayMsgs = (await query('SELECT COUNT(*) as cnt FROM msg_map WHERE user_id=? AND ts > ?', [targetId, Date.now() - 86400000]))[0]?.cnt || 0;
    const ticketCount = (await query('SELECT COUNT(*) as cnt FROM tickets WHERE user_id=?', [targetId]))[0]?.cnt || 0;
    const avgRatingRes = await query('SELECT AVG(rating) as avg FROM tickets WHERE user_id=? AND rating > 0', [targetId]);
    const avgRating = avgRatingRes[0]?.avg ? parseFloat(avgRatingRes[0].avg).toFixed(1) : 0;
    const suggCount = (await query('SELECT COUNT(*) as cnt FROM suggestions WHERE user_id=?', [targetId]))[0]?.cnt || 0;

    const isDev = String(targetId) === developerId;
    const isViewerDev = isDeveloper(chatId);
    let text = `👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n${isDev ? '👑 *مطور البوت*\n' : ''}📝 الاسم: ${u.name || '-'}\n🔗 يوزر: ${u.username ? '@' + u.username : '-'}\n${isViewerDev ? `🆔 ID: \`${u.id}\`\n` : ''}${isViewerDev && u.phone ? `📱 الهاتف: ${u.phone}\n` : ''}━━━━━━━━━━━━━━━\n📨 إجمالي الرسائل: ${msgCount}\n📅 رسائل اليوم: ${todayMsgs}\n🎫 إجمالي الطلبات: ${ticketCount}\n⭐ متوسط التقييم: ${avgRating}/5\n💡 الاقتراحات: ${suggCount}\n🕒 آخر نشاط: ${formatTime(u.last_seen)}\n📅 أول دخول: ${formatTime(u.first_seen)}\n━━━━━━━━━━━━━━━\n🚫 محظور: ${u.banned ? '✅ نعم' : '❌ لا'}\n🔇 مكتوم: ${u.muted ? '✅ نعم' : '❌ لا'}`;

    const kb = [];
    if (!isDev) {
        kb.push([
            { text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + targetId },
            { text: u.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'do_' + (u.muted ? 'unmute' : 'mute') + '_' + targetId }
        ]);
        if (isDeveloper(chatId)) {
            kb.push([{ text: '🗑️ حذف وحظر كامل', callback_data: 'destroy_user_' + targetId }]);
        }
    }
    kb.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    kb.push([{ text: '📜 عرض محادثاته', callback_data: 'user_msgs_' + targetId + '_1' }]);
    kb.push([{ text: '🔙 رجوع', callback_data: 'users_1' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function showUserConvo(chatId, targetId, page, editMsgId) {
    const u = await getUser(targetId);
    const uName = u ? (u.name || 'مجهول') : targetId;
    const perPage = 10;
    const offset = (page - 1) * perPage;
    const msgs = await query(
        `SELECT te.*, t.id as ticket_id FROM ticket_events te LEFT JOIN tickets t ON te.ticket_id = t.id WHERE t.user_id=? AND te.event_type="message" ORDER BY te.ts DESC LIMIT ? OFFSET ?`,
        [targetId, perPage, offset]);
    const totalRes = await query(`SELECT COUNT(*) as cnt FROM ticket_events te LEFT JOIN tickets t ON te.ticket_id = t.id WHERE t.user_id=? AND te.event_type="message"`, [targetId]);
    const total = totalRes[0]?.cnt || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `📜 *محادثات: ${uName}*\n📊 ${total} رسالة | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    if (msgs.length === 0) {
        text += '📭 لا توجد رسائل.';
    } else {
        for (const m of msgs) {
            const roleIcon = m.role === 'admin' ? '👨‍💼' : '👤';
            const roleName = m.role === 'admin' ? 'الأستاذ' : uName;
            let msgContent = (m.content || '').substring(0, 150);
            if (m.content && m.content.length > 150) msgContent += '...';
            text += `${roleIcon} *${roleName}*\n┌─────────────────\n│ ${msgContent.replace(/\n/g, '\n│ ')}\n└─ 🕒 ${formatTime(m.ts)}\n\n`;
        }
    }
    const btns = [];
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: 'user_msgs_' + targetId + '_' + (page - 1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'user_msgs_' + targetId + '_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    btns.push([{ text: '🔙 ملف المستخدم', callback_data: 'user_' + targetId }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال الإحصائيات ولوحة التحكم (مختصرة لكن كاملة) =====
async function showStats(chatId, editMsgId) {
    const allUsers = await getAllUsers();
    const dayAgo = Date.now() - 86400000;
    const totalMsgs = (await query('SELECT COUNT(*) as cnt FROM msg_map'))[0]?.cnt || 0;
    const todayMsgs = (await query('SELECT COUNT(*) as cnt FROM msg_map WHERE ts > ?', [dayAgo]))[0]?.cnt || 0;
    const totalTickets = (await query('SELECT COUNT(*) as cnt FROM tickets'))[0]?.cnt || 0;
    const completedTickets = (await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='completed'"))[0]?.cnt || 0;
    const avgRatingRes = await query('SELECT AVG(rating) as avg FROM tickets WHERE rating > 0');
    const avgRating = avgRatingRes[0]?.avg ? parseFloat(avgRatingRes[0].avg).toFixed(1) : 0;
    const totalSuggestions = (await query('SELECT COUNT(*) as cnt FROM suggestions'))[0]?.cnt || 0;
    const allGroups = await getAllGroups();

    const text = `📈 *الإحصائيات المتقدمة*\n━━━━━━━━━━━━━━━\n👥 المستخدمين: ${allUsers.length}\n🟢 نشطين اليوم: ${allUsers.filter(u => u.last_seen > dayAgo).length}\n🚫 محظورين: ${allUsers.filter(u => u.banned).length}\n🔇 مكتومين: ${allUsers.filter(u => u.muted).length}\n━━━━━━━━━━━━━━━\n💬 الرسائل الكلية: ${totalMsgs}\n📨 رسائل اليوم: ${todayMsgs}\n━━━━━━━━━━━━━━━\n🎫 الطلبات الكلية: ${totalTickets}\n✅ المكتملة: ${completedTickets}\n⭐ متوسط التقييم: ${avgRating}/5\n━━━━━━━━━━━━━━━\n💡 الاقتراحات: ${totalSuggestions}\n📱 القروبات: ${allGroups.length}`;

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
}

// ===== دوال إدارة الأدمنية (للمطور) =====
async function showAdminPanel(chatId, editMsgId) {
    const admins = await getAdminList();
    let text = `👨‍💼 *إدارة الأدمنية المتطورة*\n━━━━━━━━━━━━━━━\n👑 المطور: (ID: \`${developerId}\`)\n`;
    const btns = [];
    if (admins.length > 0) {
        text += '\n📋 *الأدمنية:*\n';
        for (const a of admins) {
            const aName = a.name || a.user_id;
            const username = a.username ? ` @${a.username}` : '';
            const multiLabel = a.multi_reply ? ' 🔓' : '';
            text += `• ${aName}${username}${multiLabel} (ID: \`${a.user_id}\`)\n`;
            btns.push([
                { text: `❌ إزالة ${aName}`, callback_data: await saveCB('rm_admin_' + a.user_id) }
            ]);
            btns.push([
                { text: a.multi_reply ? '🔒 سحب متعدد' : '🔓 منح متعدد', callback_data: await saveCB('toggle_multi_' + a.user_id) },
                { text: '⚙️ الصلاحيات', callback_data: await saveCB('edit_perms_' + a.user_id) }
            ]);
        }
    } else {
        text += '\n📭 لا يوجد أدمنية';
    }
    btns.push([{ text: '➕ إضافة بالـ ID', callback_data: 'add_admin_id' }]);
    btns.push([{ text: '👥 إضافة من المستخدمين', callback_data: 'pick_add_admin_1' }]);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function showEditPermissions(chatId, adminId, editMsgId) {
    const perms = await getAdminPermissions(adminId);
    const u = await getUser(adminId);
    const permLabels = {
        canBan: '🔨 الحظر/الكتم',
        canMute: '🔇 الكتم',
        canBroadcast: '📢 الرسائل الجماعية',
        canViewStats: '📈 عرض الإحصائيات',
        canManageTickets: '🎫 إدارة الطلبات',
        canManageGroups: '📱 إدارة القروبات',
        canReplyUsers: '💬 الرد على المستخدمين'
    };
    let text = `⚙️ *صلاحيات: ${u ? getUserName(u) : adminId}*\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    for (const [key, label] of Object.entries(permLabels)) {
        const status = perms[key] ? '✅' : '❌';
        text += `${status} ${label}\n`;
        btns.push([{ text: (perms[key] ? '✅ ' : '❌ ') + label, callback_data: await saveCB('perm_toggle_' + adminId + '_' + key) }]);
    }
    btns.push([{ text: '🔙 رجوع', callback_data: 'admin_panel' }]);
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

// ===== دوال القروبات (مختصرة ولكن كاملة من الكود الأول) =====
async function showGroupsList(chatId, page, editMsgId) {
    const allGroups = await getAllGroups();
    const perPage = 8;
    const totalPages = Math.ceil(allGroups.length / perPage) || 1;
    let pg = page;
    if (pg < 1) pg = 1;
    if (pg > totalPages) pg = totalPages;
    const start = (pg - 1) * perPage;
    const pageGroups = allGroups.slice(start, start + perPage);
    let text = `📱 *إدارة القروبات* (${allGroups.length}) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (pageGroups.length === 0) {
        text += '📭 لا توجد قروبات';
    } else {
        for (const g of pageGroups) {
            const members = await getGroupMembers(g.group_id);
            const label = `📱 ${g.title} (${members.length} عضو)`;
            text += `• ${g.title}\n  👥 ${members.length} عضو\n\n`;
            btns.push([{ text: label, callback_data: await saveCB('group_detail_' + g.group_id) }]);
        }
    }
    const navRow = [];
    if (pg > 1) navRow.push({ text: '⬅️', callback_data: 'groups_list_' + (pg - 1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: 'groups_list_' + (pg + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function showGroupDetail(chatId, groupId, editMsgId) {
    const group = (await query('SELECT * FROM groups WHERE group_id=?', [groupId]))[0];
    if (!group) { await bot.sendMessage(chatId, '❌ القروب غير موجود'); return; }
    const members = await getGroupMembers(groupId);
    const admins = members.filter(m => m.is_admin);
    const bots = members.filter(m => m.is_bot);
    const banned = members.filter(m => m.banned);
    const muted = members.filter(m => m.muted);
    let text = `📱 *تفاصيل القروب*\n━━━━━━━━━━━━━━━\n📝 الاسم: ${group.title}\n🔗 اليوزر: ${group.username ? '@' + group.username : '-'}\n🆔 ID: \`${group.group_id}\`\n━━━━━━━━━━━━━━━\n👥 الأعضاء: ${members.length}\n👨‍💼 الأدمنية: ${admins.length}\n🤖 البوتات: ${bots.length}\n🚫 المحظورين: ${banned.length}\n🔇 المكتومين: ${muted.length}\n━━━━━━━━━━━━━━━\n📅 أُضيف: ${formatTime(group.added_at)}`;
    const btns = [
        [{ text: '👥 عرض الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }],
        [{ text: '🔙 القروبات', callback_data: 'groups_list_1' }]
    ];
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function showGroupMembers(chatId, groupId, page, editMsgId) {
    const group = (await query('SELECT * FROM groups WHERE group_id=?', [groupId]))[0];
    const members = await getGroupMembers(groupId);
    const perPage = 8;
    const totalPages = Math.ceil(members.length / perPage) || 1;
    let pg = page;
    if (pg < 1) pg = 1;
    if (pg > totalPages) pg = totalPages;
    const start = (pg - 1) * perPage;
    const pageMembers = members.slice(start, start + perPage);
    let text = `👥 *أعضاء: ${group?.title || groupId}*\n(${members.length} عضو) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    for (const m of pageMembers) {
        let label = '';
        if (m.is_owner) label += '👑 ';
        else if (m.is_admin) label += '👨‍💼 ';
        if (m.is_bot) label += '🤖 ';
        if (m.banned) label += '🚫 ';
        if (m.muted) label += '🔇 ';
        if (m.warnings > 0) label += `⚠️${m.warnings} `;
        label += (m.name || 'بدون اسم');
        if (m.username) label += ` @${m.username}`;
        btns.push([{ text: label, callback_data: await saveCB('gmember_' + groupId + '_u_' + m.user_id) }]);
    }
    const navRow = [];
    if (pg > 1) navRow.push({ text: '⬅️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (pg - 1)) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (pg + 1)) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 تفاصيل القروب', callback_data: await saveCB('group_detail_' + groupId) }]);
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function showMemberActions(chatId, groupId, memberId, editMsgId) {
    const member = (await query('SELECT * FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]))[0];
    if (!member) { await bot.sendMessage(chatId, '❌ العضو غير موجود'); return; }
    const group = (await query('SELECT * FROM groups WHERE group_id=?', [groupId]))[0];
    let text = `👤 *إدارة العضو*\n━━━━━━━━━━━━━━━\n📝 الاسم: ${member.name || 'بدون اسم'}\n🔗 اليوزر: ${member.username ? '@' + member.username : '-'}\n🆔 ID: \`${member.user_id}\`\n${member.phone ? `📱 الهاتف: ${member.phone}\n` : ''}━━━━━━━━━━━━━━━\n📱 القروب: ${group?.title || groupId}\n👨‍💼 أدمن: ${member.is_admin ? '✅' : '❌'}\n🤖 بوت: ${member.is_bot ? '✅' : '❌'}\n⚠️ الإنذارات: ${member.warnings || 0}\n🚫 محظور: ${member.banned ? '✅' : '❌'}\n🔇 مكتوم: ${member.muted ? '✅' : '❌'}\n🕒 آخر نشاط: ${formatTime(member.last_seen)}`;
    const btns = [];
    if (!member.is_owner && !member.is_bot) {
        btns.push([
            { text: '⚠️ إنذار', callback_data: await saveCB('gaction_warn_' + groupId + '_' + memberId) },
            { text: member.is_admin ? '➖ إزالة أدمن' : '➕ ترقية لأدمن', callback_data: await saveCB('gaction_' + (member.is_admin ? 'demote' : 'promote') + '_' + groupId + '_' + memberId) }
        ]);
        btns.push([
            { text: member.banned ? '🔓 رفع الحظر' : '🚫 حظر', callback_data: await saveCB('gaction_' + (member.banned ? 'unban' : 'ban') + '_' + groupId + '_' + memberId) },
            { text: member.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: await saveCB('gaction_' + (member.muted ? 'unmute' : 'mute') + '_' + groupId + '_' + memberId) }
        ]);
        btns.push([{ text: '👢 طرد', callback_data: await saveCB('gaction_kick_' + groupId + '_' + memberId) }]);
    }
    btns.push([{ text: '🔙 الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }]);
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
}

async function executeGroupAction(chatId, action, groupId, memberId, editMsgId) {
    let result = '';
    try {
        if (action === 'warn') {
            const member = (await query('SELECT warnings FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]))[0];
            const newWarnings = (member?.warnings || 0) + 1;
            await setGroupMemberField(groupId, memberId, 'warnings', newWarnings);
            result = `⚠️ تم إنذار العضو (${newWarnings} إنذار)`;
            try { await bot.sendMessage(memberId, `⚠️ تلقيت إنذاراً في القروب! العدد: ${newWarnings}`); } catch(e) {}
        } else if (action === 'promote') {
            await setGroupMemberField(groupId, memberId, 'is_admin', true);
            try {
                await bot.promoteChatMember(groupId, memberId, { can_change_info: true, can_delete_messages: true, can_invite_users: true, can_restrict_members: true, can_pin_messages: true });
                result = '✅ تم ترقية العضو لأدمن';
            } catch(e) { result = '✅ تم تحديث الحالة (قد يلزم منح صلاحيات يدوياً)'; }
        } else if (action === 'demote') {
            await setGroupMemberField(groupId, memberId, 'is_admin', false);
            try {
                await bot.promoteChatMember(groupId, memberId, { can_change_info: false, can_delete_messages: false, can_invite_users: false, can_restrict_members: false, can_pin_messages: false });
                result = '✅ تم إزالة صلاحيات الأدمن';
            } catch(e) { result = '✅ تم تحديث الحالة'; }
        } else if (action === 'ban') {
            await setGroupMemberField(groupId, memberId, 'banned', true);
            try { await bot.banChatMember(groupId, memberId); result = '✅ تم حظر العضو'; } catch(e) { result = '⚠️ تم تحديث الحالة (قد تحتاج صلاحيات)'; }
        } else if (action === 'unban') {
            await setGroupMemberField(groupId, memberId, 'banned', false);
            try { await bot.unbanChatMember(groupId, memberId); result = '✅ تم رفع الحظر'; } catch(e) { result = '✅ تم تحديث الحالة'; }
        } else if (action === 'mute') {
            await setGroupMemberField(groupId, memberId, 'muted', true);
            try { await bot.restrictChatMember(groupId, memberId, { can_send_messages: false, can_send_media_messages: false, can_send_other_messages: false }); result = '✅ تم كتم العضو'; } catch(e) { result = '⚠️ تم تحديث الحالة (قد تحتاج صلاحيات)'; }
        } else if (action === 'unmute') {
            await setGroupMemberField(groupId, memberId, 'muted', false);
            try { await bot.restrictChatMember(groupId, memberId, { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true }); result = '✅ تم رفع الكتم'; } catch(e) { result = '✅ تم تحديث الحالة'; }
        } else if (action === 'kick') {
            try { await bot.banChatMember(groupId, memberId); await bot.unbanChatMember(groupId, memberId); await query('DELETE FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]); result = '✅ تم طرد العضو'; } catch(e) { result = '⚠️ فشل الطرد (قد تحتاج صلاحيات)'; }
        }
    } catch(e) { result = '❌ حدث خطأ: ' + e.message; }
    try {
        await bot.editMessageText(result, { chat_id: chatId, message_id: editMsgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: await saveCB('gmember_' + groupId + '_u_' + memberId) }]] } });
    } catch(e) {}
}

// ===== دوال مساعدة =====
function formatTime(ts) {
    return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserName(u) {
    let n = u.name || 'مجهول';
    if (u.username) n += ' (@' + u.username + ')';
    return n;
}

async function notifyPendingUsers(adminId) {
    const keys = Object.keys(pendingNotify);
    for (const uid of keys) {
        if (pendingNotify[uid] && !pendingNotify[uid].notified) {
            try {
                await bot.sendMessage(uid,
                    '👀 *تمت قراءة رسالتك*\n\n✅ الأستاذ فتح المحادثة وسوف يطلع على رسائلك ويرد عليك قريباً.\n\n⏳ يرجى الانتظار، الرد في الطريق إليك!',
                    { parse_mode: 'Markdown' });
                pendingNotify[uid].notified = true;
            } catch(e) {}
        }
    }
    setTimeout(() => {
        for (const uid in pendingNotify) {
            if (pendingNotify[uid] && pendingNotify[uid].notified) delete pendingNotify[uid];
        }
    }, 3000);
}

// ===== إرسال القائمة الرئيسية (معدلة) =====
async function sendMainMenu(chatId, editMsgId) {
    const userId = String(chatId);
    if (isAdminUser(userId)) {
        await query('UPDATE admins SET last_login=? WHERE user_id=?', [Date.now(), userId]);
    }
    const adminStats = (await query('SELECT * FROM admins WHERE user_id=?', [userId]))[0];
    const allUsers = await getAllUsers();
    const total = allUsers.length;
    const banned = allUsers.filter(u => u.banned).length;
    const muted = allUsers.filter(u => u.muted).length;
    const dayAgo = Date.now() - 86400000;
    const active = allUsers.filter(u => u.last_seen > dayAgo).length;
    const adminsList = await getAdminList();
    let openTickets = 0, claimedTickets = 0, newSuggestions = 0;
    try {
        const ot = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open' AND claimed_by IS NULL");
        openTickets = ot[0]?.cnt || 0;
        const ct = await query("SELECT COUNT(*) as cnt FROM tickets WHERE status='open' AND claimed_by IS NOT NULL");
        claimedTickets = ct[0]?.cnt || 0;
        const sg = await query("SELECT COUNT(*) as cnt FROM suggestions WHERE status='new'");
        newSuggestions = sg[0]?.cnt || 0;
    } catch(e) {}
    const allGroups = await getAllGroups();

    let text = `🔧 *لوحة التحكم المتطورة*\n━━━━━━━━━━━━━━━\n👤 الرتبة: ${isDeveloper(userId) ? '*👑 المطور*' : '*👨‍🏫 أستاذ/أدمن*'}\n${adminStats ? `🤝 ساعدت: \`${adminStats.helped_count || 0}\` | ⏱ نشاط: \`${adminStats.total_active_minutes || 0}\`د\n` : ''}━━━━━━━━━━━━━━━\n👥 المستخدمين: ${total}\n🟢 نشطين اليوم: ${active}\n🚫 محظورين: ${banned}\n🔇 مكتومين: ${muted}\n👨‍💼 الأدمنية: ${adminsList.length + 1}\n📱 القروبات: ${allGroups.length}\n━━━━━━━━━━━━━━━\n🎫 طلبات مفتوحة: ${openTickets}\n🔒 طلبات محجوزة: ${claimedTickets}\n${newSuggestions > 0 ? `💡 اقتراحات جديدة: ${newSuggestions}\n` : ''}━━━━━━━━━━━━━━━`;

    const perms = await getAdminPermissions(userId);
    const kb = [];
    if (perms.canViewStats) {
        kb.push([{ text: '👥 المستخدمين', callback_data: 'users_1' }, { text: '📈 إحصائيات', callback_data: 'stats' }]);
    }
    if (perms.canBroadcast) {
        kb.push([{ text: '📢 رسالة جماعية', callback_data: 'broadcast' }]);
    }
    if (perms.canBan || perms.canMute) {
        const row = [];
        if (perms.canBan) row.push({ text: '🔨 حظر', callback_data: 'pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'pick_unban_1' });
        if (perms.canMute) row.push({ text: '🔇 كتم', callback_data: 'pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'pick_unmute_1' });
        if (row.length) kb.push(row);
    }
    if (perms.canReplyUsers) {
        kb.push([{ text: '💬 مراسلة مستخدم', callback_data: 'pick_reply_1' }]);
    }
    if (perms.canManageTickets) {
        kb.push([{ text: '🎫 الطلبات المفتوحة', callback_data: 'tickets_open_1' }]);
        if (isDeveloper(userId)) {
            kb.push([{ text: '📋 الطلبات المعلقة (سجل)', callback_data: 'tickets_claimed_1' }]);
        }
    }
    kb.push([{ text: `💡 الاقتراحات${newSuggestions > 0 ? ' 🔴' + newSuggestions : ''}`, callback_data: 'suggestions_1' }]);
    if (perms.canManageGroups) {
        kb.push([{ text: `📱 إدارة القروبات (${allGroups.length})`, callback_data: 'groups_list_1' }]);
    }
    if (isDeveloper(chatId)) {
        kb.push([{ text: '👨‍💼 إدارة الأدمنية', callback_data: 'admin_panel' }]);
        kb.push([{ text: '📣 إرسال إشعار تحديث', callback_data: 'send_update' }]);
    }

    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

// ===== باقي دوال اختيار المستخدم والإجراءات (مختصرة) =====
async function buildUserBtns(actionPrefix, page, filterFn, pagePrefix) {
    let allUsers = await getAllUsers();
    if (filterFn) allUsers = allUsers.filter(filterFn);
    const perPage = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    let pg = page;
    if (pg < 1) pg = 1;
    if (pg > totalPages) pg = totalPages;
    const start = (pg - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);
    const buttons = [];
    for (const u of pageUsers) {
        let label = (u.banned ? '🚫 ' : '') + (u.muted ? '🔇 ' : '') + (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        buttons.push([{ text: label, callback_data: actionPrefix + '_' + u.id }]);
    }
    const navRow = [];
    const pp = pagePrefix || actionPrefix;
    if (pg > 1) navRow.push({ text: '⬅️', callback_data: pp + '_' + (pg - 1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: pp + '_' + (pg + 1) });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'main' }]);
    return { buttons, total: allUsers.length };
}

// ===== بدء البوت ومعالجة الأحداث =====
async function startBot() {
    await createPool();
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    devState = {};

    setInterval(async () => {
        try { await query('DELETE FROM cb_data WHERE ts < ?', [Date.now() - 24 * 60 * 60 * 1000]); } catch(e) {}
    }, 3600000);

    bot.setMyCommands([{ command: 'start', description: '🏠 القائمة الرئيسية' }]).catch(() => {});

    // أمر /start
    bot.onText(/^\/(start|panel)$/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        if (isAdminUser(userId)) {
            devState[chatId] = {};
            await sendMainMenu(chatId);
            await notifyPendingUsers(userId);
            await showPendingUpdate(chatId, 'admin');
            return;
        }

        const isNew = !(await getUser(userId));
        await updateUser(userId, msg.from.username || '', fullName);
        await showPendingUpdate(chatId, 'user');

        const introText = '🎓 *هنا أستاذك الخاص*\n\nلقد كثرت الـ AI بشكل كبير ومتفرع جداً، وكلهن متخصصات حتى في حل الواجبات والتكاليف وكل ما يتعلق بالأسئلة الوزارية.\n\nولكن نحيطك علماً — وأنت تعرف ذلك — أن *50% من إجاباتهم خاطئة* ❌\n\nلهذا، هذا البوت يوفر لكم *أساتذة ومعيدين متخصصين* لخدمتكم شخصياً مع *ضمان الإجابات 100%* ✅\n\nسوف يصل طلبك للأستاذ المناسب فوراً.\n\n━━━━━━━━━━━━━━━\n👋 أهلاً بك *' + (fullName || 'عزيزي') + '*!\n\n📩 أرسل سؤالك أو طلبك الآن مباشرة وسيصل للأستاذ.\n\n📌 *يمكنك إرسال:*\n• 📝 نصوص وأسئلة\n• 📸 صور بدقة عالية\n• 🎥 فيديوهات\n• 📁 ملفات وواجبات\n• 🎤 مقاطع صوتية\n• أي شيء!\n\n✅ سوف نعلمك فور فتح الأستاذ للمحادثة.';

        await bot.sendMessage(chatId, introText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح ميزة أو خدمة', callback_data: 'suggest' }]] }
        });

        if (isNew) {
            const newUserNotif = `🆕 *مستخدم جديد انضم!*\n━━━━━━━━━━━━━━━\n👤 ${fullName || 'بدون اسم'}\n🔗 ${msg.from.username ? '@' + msg.from.username : 'بدون يوزر'}\n🆔 \`${userId}\`\n🕒 ${formatTime(Date.now())}`;
            const adminsNew = await getAdminList();
            const recipientsNew = [developerId, ...adminsNew.map(a => a.user_id).filter(id => id !== developerId)];
            for (const rec of recipientsNew) {
                try {
                    await bot.sendMessage(rec, newUserNotif, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 مراسلة', callback_data: 'qr_' + userId }]] } });
                } catch(e) {}
            }
        }
    });

    // معالجة الكولباك (مختصرة ولكن تشمل كل الميزات الجديدة)
    bot.on('callback_query', async (cbq) => {
        const chatId = cbq.message.chat.id;
        const userId = String(cbq.from.id);
        const msgId = cbq.message.message_id;
        const rawData = cbq.data;
        const data = await getCB(rawData);

        await bot.answerCallbackQuery(cbq.id).catch(() => {});

        // تتبع نشاط الأدمن
        if (isAdminUser(userId)) {
            const adminData = (await query('SELECT * FROM admins WHERE user_id=?', [userId]))[0];
            if (adminData) {
                const now = Date.now();
                if (now - adminData.last_login > 60000) {
                    await query('UPDATE admins SET total_active_minutes = total_active_minutes + 1, last_login = ? WHERE user_id = ?', [now, userId]);
                }
            }
        }

        if (!isAdminUser(userId)) {
            // معالجة كولباك المستخدم العادي (اقتراح، تقييم، تحقق)
            if (data === 'suggest') {
                devState[chatId] = { action: 'suggest' };
                try {
                    await bot.editMessageText('💡 *اقتراح ميزة أو خدمة*\n\nاكتب اقتراحك الآن وسيصل مباشرة للمطور:', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_suggest' }]] }
                    });
                } catch(e) {}
                return;
            }
            if (data === 'cancel_suggest') {
                devState[chatId] = {};
                try {
                    await bot.editMessageText('🎓 *هنا أستاذك الخاص*\n\nأرسل سؤالك أو طلبك الآن.', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح ميزة أو خدمة', callback_data: 'suggest' }]] }
                    });
                } catch(e) {}
                return;
            }
            if (data.startsWith('rate_')) {
                const parts = data.replace('rate_', '').split('_');
                const ticketId = parseInt(parts[0]);
                const rating = parseInt(parts[1]);
                await rateTicket(ticketId, rating);
                const stars = '⭐'.repeat(rating);
                try {
                    await bot.editMessageText(`🙏 *شكراً على تقييمك!*\n\nتقييمك: ${stars}`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
                    });
                } catch(e) {}
                const ticket = (await query('SELECT * FROM tickets WHERE id=?', [ticketId]))[0];
                if (ticket) {
                    const adminId = ticket.claimed_by;
                    const adminUser = adminId ? await getUser(adminId) : null;
                    const userObj = await getUser(userId);
                    await saveTicketEvent(ticketId, userId, 'user', 'rating', `تقييم: ${rating} نجوم`);
                    await bot.sendMessage(developerId, `⭐ *تقييم جديد*\n👤 المستخدم: ${getUserName(userObj)}\n👨‍💼 الأستاذ: ${adminUser ? getUserName(adminUser) : 'غير محدد'}\nالتقييم: ${stars}`, { parse_mode: 'Markdown' });
                    if (adminId && adminId !== developerId) {
                        try { await bot.sendMessage(adminId, `⭐ *تقييمك من المستخدم*\n👤 ${getUserName(userObj)}\nالتقييم: ${stars}`, { parse_mode: 'Markdown' }); } catch(e) {}
                    }
                }
                return;
            }
            if (data.startsWith('verify_human_')) {
                const ticketId = parseInt(data.replace('verify_human_', ''));
                try {
                    await bot.editMessageText('✅ *تم التحقق من هويتك!*\n\nشكراً، يمكنك الآن متابعة المحادثة مع الأستاذ.\n⏳ انتظر رد الأستاذ...', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown'
                    });
                } catch(e) {}
                const userObj = await getUser(userId);
                await bot.sendMessage(developerId, `🔐 *تحقق من هوية مستخدم*\n━━━━━━━━━━━━━━━\n👤 الاسم: ${userObj?.name || 'غير معروف'}\n🔗 يوزر: ${userObj?.username ? '@' + userObj.username : 'بدون يوزر'}\n🆔 ID: \`${userId}\`\n🎫 رقم الطلب: ${ticketId}\n🕒 ${formatTime(Date.now())}`, { parse_mode: 'Markdown' });
                await saveTicketEvent(ticketId, userId, 'user', 'verified', 'تحقق المستخدم من هويته');
                return;
            }
            return;
        }

        // من هنا معالجة كولباك الأدمنية (كما في الكود الأول مع إضافات جديدة)
        try {
            if (data === 'main') {
                devState[chatId] = {};
                await sendMainMenu(chatId, msgId);
                await notifyPendingUsers(userId);
                return;
            }
            if (data === 'noop') return;

            // رد سريع
            if (data.startsWith('qr_')) {
                const qrId = data.replace('qr_', '');
                if (String(qrId) === developerId && !isDeveloper(userId)) return;
                const canReply = await canAdminReply(userId, qrId);
                if (!canReply) {
                    const ticket = await getOpenTicket(qrId);
                    const claimerUser = ticket ? await getUser(ticket.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id, { text: `⛔ هذا الطلب محجوز من: ${claimerUser ? (claimerUser.name || ticket.claimed_by) : 'أدمن آخر'}`, show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId: qrId };
                const qrUser = await getUser(qrId);
                await bot.sendMessage(chatId, `💬 *الرد على: ${qrUser ? getUserName(qrUser) : qrId}*\n\n✏️ اكتب ردك الآن (نص، صورة، فيديو، ملف، أي شيء):`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                });
                return;
            }

            // التكفل بطلب
            if (data.startsWith('claim_')) {
                const parts = data.replace('claim_', '').split('_');
                const claimUserId = parts[0];
                const claimTicketId = parseInt(parts[1]);
                const existing = await query('SELECT * FROM tickets WHERE id=? AND claimed_by IS NULL', [claimTicketId]);
                if (existing.length === 0) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⚠️ هذا الطلب تم حجزه من قبل أدمن آخر!', show_alert: true }).catch(() => {});
                    return;
                }
                const claimed = await claimTicket(claimTicketId, userId);
                if (!claimed || claimed.claimed_by !== String(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⚠️ هذا الطلب تم حجزه من قبل أدمن آخر!', show_alert: true }).catch(() => {});
                    return;
                }
                const claimAdminUser = await getUser(userId);
                const claimTargetUser = await getUser(claimUserId);
                await saveTicketEvent(claimTicketId, userId, 'admin', 'claimed', `تكفل ${claimAdminUser?.name || userId} بالطلب`);
                try {
                    await bot.sendMessage(claimUserId,
                        `✅ *تم التكفل بطلبك!*\n\n👨‍🏫 الأستاذ *${claimAdminUser?.name || 'الأستاذ'}* سيتولى طلبك الآن.\n⏳ يرجى الانتظار، الرد في الطريق إليك!\n\n━━━━━━━━━━━━━━━\n🔐 *للمتابعة يرجى التحقق من هويتك:*`,
                        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ تحقق أنك إنسان - اضغط هنا', callback_data: 'verify_human_' + claimTicketId }]] } }
                    );
                } catch(e) {}
                // إشعار الأدمنية الآخرين
                const allAdmins = await getAdminList();
                const recipients = [developerId, ...allAdmins.map(a => a.user_id).filter(id => id !== developerId && id !== userId)];
                for (const rec of recipients) {
                    try {
                        await bot.sendMessage(rec, `🔒 *تم حجز الطلب*\n👤 المستخدم: ${getUserName(claimTargetUser)}\n👨‍💼 بواسطة: ${getUserName(claimAdminUser)}`, { parse_mode: 'Markdown' });
                    } catch(e) {}
                }
                try {
                    await bot.editMessageReplyMarkup({
                        inline_keyboard: [
                            [{ text: '↩️ رد على المستخدم', callback_data: 'qr_' + claimUserId }],
                            [{ text: '✅ تم إنهاء المهمة', callback_data: 'done_' + claimUserId + '_' + claimTicketId }],
                            [{ text: '🗑️ حذف البوت وحظر المستخدم', callback_data: 'destroy_user_' + claimUserId }],
                            [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                        ]
                    }, { chat_id: chatId, message_id: msgId });
                } catch(e) {}
                await bot.sendMessage(chatId, `✅ *تكفلت بطلب المستخدم*\n👤 ${getUserName(claimTargetUser)}\n\nيمكنك الآن الرد عليه. عند الانتهاء اضغط "تم إنهاء المهمة".`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [
                        [{ text: '↩️ رد على المستخدم', callback_data: 'qr_' + claimUserId }],
                        [{ text: '✅ تم إنهاء المهمة', callback_data: 'done_' + claimUserId + '_' + claimTicketId }],
                        [{ text: '🗑️ حذف البوت وحظر المستخدم', callback_data: 'destroy_user_' + claimUserId }],
                        [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                    ]}
                });
                return;
            }

            // إنهاء المهمة
            if (data.startsWith('done_')) {
                const parts = data.replace('done_', '').split('_');
                const doneUserId = parts[0];
                const doneTicketId = parseInt(parts[1]);
                const ticketRows = await query('SELECT * FROM tickets WHERE id=?', [doneTicketId]);
                if (ticketRows.length === 0) { await bot.sendMessage(chatId, '⚠️ الطلب غير موجود.'); return; }
                const ticket = ticketRows[0];
                if (ticket.claimed_by !== String(userId) && !isDeveloper(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ فقط الأدمن الذي تكفل بالطلب يمكنه إنهاءه.', show_alert: true }).catch(() => {});
                    return;
                }
                await completeTicket(doneTicketId);
                const doneAdminUser = await getUser(userId);
                await saveTicketEvent(doneTicketId, userId, 'admin', 'completed', `أنهى ${doneAdminUser?.name || userId} المهمة`);
                const doneTargetUser = await getUser(doneUserId);
                try {
                    await bot.sendMessage(doneUserId,
                        `✅ *تم إنهاء طلبك بنجاح!*\n\n🙏 نشكرك على استخدام البوت.\n\n⭐ *كيف تقيّم تجربتك مع الأستاذ؟*`,
                        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
                            [{ text: '⭐', callback_data: 'rate_' + doneTicketId + '_1' }, { text: '⭐⭐', callback_data: 'rate_' + doneTicketId + '_2' }, { text: '⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_3' }],
                            [{ text: '⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_4' }, { text: '⭐⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_5' }]
                        ] } }
                    );
                } catch(e) {}
                await bot.sendMessage(chatId, `✅ *تم إنهاء المهمة!*\n👤 ${getUserName(doneTargetUser)}\n\nتم إرسال طلب التقييم للمستخدم.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] }
                });
                return;
            }

            // حذف وحظر كامل
            if (data.startsWith('destroy_user_')) {
                if (!isDeveloper(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ هذه الميزة للمطور فقط.', show_alert: true }).catch(() => {});
                    return;
                }
                const destroyId = data.replace('destroy_user_', '');
                try {
                    await bot.editMessageText(`⚠️ *تأكيد الحذف الكامل*\n\n🆔 المستخدم: \`${destroyId}\`\n\nسيتم:\n• 🚫 حظر المستخدم نهائياً\n• 🗑️ حذف جميع رسائله من قاعدة البيانات\n• 📤 إرسال رسالة إنهاء له\n\nهل أنت متأكد؟`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '✅ نعم، احذف وحظر', callback_data: 'cf_destroy_' + destroyId }], [{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }
            if (data.startsWith('cf_destroy_')) {
                if (!isDeveloper(userId)) return;
                const cdId = data.replace('cf_destroy_', '');
                await setUserField(cdId, 'banned', 1);
                try { await bot.sendMessage(cdId, '⛔ تم إنهاء خدمتك في هذا البوت.'); } catch(e) {}
                await query('DELETE FROM msg_map WHERE user_id=?', [cdId]);
                await query('DELETE FROM tickets WHERE user_id=?', [cdId]);
                const cdUser = await getUser(cdId);
                try {
                    await bot.editMessageText(`✅ *تم تنفيذ الإجراء*\n\n👤 ${cdUser ? getUserName(cdUser) : cdId}\n🚫 تم الحظر وحذف جميع البيانات.`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // عرض الطلبات المفتوحة والمعلقة
            if (data.startsWith('tickets_open_')) {
                const page = parseInt(data.replace('tickets_open_', '')) || 1;
                await showOpenTickets(chatId, page, msgId);
                return;
            }
            if (data.startsWith('tickets_claimed_')) {
                if (!isDeveloper(userId)) { await bot.answerCallbackQuery(cbq.id, { text: '⛔ للمطور فقط.', show_alert: true }).catch(() => {}); return; }
                const page = parseInt(data.replace('tickets_claimed_', '')) || 1;
                await showClaimedTickets(chatId, page, msgId);
                return;
            }
            if (data.startsWith('ticket_log_')) {
                if (!isDeveloper(userId)) return;
                const ticketId = parseInt(data.replace('ticket_log_', ''));
                await showTicketLog(chatId, ticketId, msgId);
                return;
            }

            // عرض المستخدمين والملف والمحادثات
            if (data.startsWith('users_')) {
                const page = parseInt(data.replace('users_', '')) || 1;
                await showUsers(chatId, page, msgId);
                return;
            }
            if (data.startsWith('user_') && !data.startsWith('user_msgs_')) {
                const targetId = data.replace('user_', '');
                await showUserDetail(chatId, targetId, msgId);
                return;
            }
            if (data.match(/^user_msgs_\d+_\d+$/)) {
                const parts = data.replace('user_msgs_', '').split('_');
                await showUserConvo(chatId, parts[0], parseInt(parts[1]) || 1, msgId);
                return;
            }

            // الاقتراحات
            if (data.startsWith('suggestions_')) {
                const page = parseInt(data.replace('suggestions_', '')) || 1;
                await showSuggestions(chatId, page, msgId);
                return;
            }
            if (data.startsWith('sg_read_')) {
                const sgId = parseInt(data.replace('sg_read_', ''));
                await query("UPDATE suggestions SET status='read' WHERE id=?", [sgId]);
                await showSuggestions(chatId, 1, msgId);
                return;
            }

            // إحصائيات
            if (data === 'stats') {
                await showStats(chatId, msgId);
                return;
            }

            // رسالة جماعية
            if (data === 'broadcast') {
                const perms = await getAdminPermissions(userId);
                if (!perms.canBroadcast) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ ليس لديك صلاحية', show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'broadcast' };
                const allU = await getAllUsers();
                const activeCount = allU.filter(u => !u.banned).length;
                try {
                    await bot.editMessageText(`📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ${activeCount} مستخدم:`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // إشعار تحديث (للمطور)
            if (data === 'send_update') {
                if (!isDeveloper(userId)) return;
                devState[chatId] = { action: 'send_update_users' };
                try {
                    await bot.editMessageText(
                        '📣 *إرسال إشعار تحديث*\n\nالخطوة 1/2: اكتب رسالة التحديث للمستخدمين العاديين:\n(أو أرسل "-" لتخطي رسالة المستخدمين)',
                        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }
                    );
                } catch(e) {}
                return;
            }

            // اختيار مستخدم للإجراء
            if (data.match(/^pick_(ban|unban|mute|unmute|reply)_\d+$/)) {
                const parts = data.split('_');
                const action = parts[1];
                const page = parseInt(parts[2]) || 1;
                let filterFn = null;
                if (action === 'ban') filterFn = u => !u.banned && u.id !== developerId;
                if (action === 'unban') filterFn = u => u.banned && u.id !== developerId;
                if (action === 'mute') filterFn = u => !u.muted && u.id !== developerId;
                if (action === 'unmute') filterFn = u => u.muted && u.id !== developerId;
                if (action === 'reply') filterFn = u => u.id !== developerId;
                const titles = { ban: '🔨 اختر مستخدم للحظر:', unban: '🔓 اختر مستخدم لرفع الحظر:', mute: '🔇 اختر مستخدم للكتم:', unmute: '🔊 اختر مستخدم لرفع الكتم:', reply: '💬 اختر مستخدم للمراسلة:' };
                const res = await buildUserBtns('do_' + action, page, filterFn, 'pick_' + action);
                let text = titles[action] || 'اختر:';
                if (res.total === 0) text += '\n\n⚠️ لا يوجد مستخدمين.';
                try {
                    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: res.buttons } });
                } catch(e) {}
                return;
            }

            // تنفيذ إجراء
            if (data.match(/^do_(ban|unban|mute|unmute)_\d+$/)) {
                const parts = data.replace('do_', '').split('_');
                const action = parts[0];
                const targetId = parts[1];
                if (String(targetId) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch(e) {}
                    return;
                }
                const u = await getUser(targetId);
                const actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم' };
                const text = `*${actNames[action]}*\n\n👤 ${u ? getUserName(u) : targetId}\n🆔 \`${targetId}\`\n\nهل أنت متأكد؟`;
                try {
                    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد', callback_data: 'cf_' + action + '_' + targetId }], [{ text: '❌ إلغاء', callback_data: 'main' }]] } });
                } catch(e) {}
                return;
            }

            // مراسلة مستخدم
            if (data.startsWith('do_reply_')) {
                const targetId = data.replace('do_reply_', '');
                const canReply = await canAdminReply(userId, targetId);
                if (!canReply) {
                    const ticket = await getOpenTicket(targetId);
                    const claimer = ticket ? await getUser(ticket.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id, { text: `⛔ هذا الطلب محجوز من: ${claimer ? (claimer.name || ticket.claimed_by) : 'أدمن آخر'}`, show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId };
                const u = await getUser(targetId);
                try {
                    await bot.editMessageText(`💬 *مراسلة: ${u ? getUserName(u) : targetId}*\n\n✏️ اكتب ردك (نص، صورة، فيديو، ملف):`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // تأكيد الإجراء
            if (data.startsWith('cf_')) {
                const parts = data.replace('cf_', '').split('_');
                const action = parts[0];
                const targetId = parts[1];
                if (String(targetId) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch(e) {}
                    return;
                }
                let result = '';
                if (action === 'ban') { await setUserField(targetId, 'banned', 1); result = `✅ تم حظر \`${targetId}\``; try { await bot.sendMessage(targetId, '⛔ تم حظرك من البوت.'); } catch(e) {} }
                else if (action === 'unban') { await setUserField(targetId, 'banned', 0); result = `✅ تم رفع الحظر عن \`${targetId}\``; try { await bot.sendMessage(targetId, '✅ تم رفع الحظر عنك.'); } catch(e) {} }
                else if (action === 'mute') { await setUserField(targetId, 'muted', 1); result = `✅ تم كتم \`${targetId}\``; }
                else if (action === 'unmute') { await setUserField(targetId, 'muted', 0); result = `✅ تم رفع الكتم عن \`${targetId}\``; }
                try {
                    await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                } catch(e) {}
                return;
            }

            // إدارة الأدمنية
            if (data === 'admin_panel') {
                if (!isDeveloper(userId)) { await bot.sendMessage(chatId, '⛔ فقط المطور.'); return; }
                await showAdminPanel(chatId, msgId);
                return;
            }
            if (data === 'add_admin_id') {
                if (!isDeveloper(userId)) return;
                devState[chatId] = { action: 'add_admin' };
                try {
                    await bot.editMessageText('👨‍💼 *إضافة أدمن*\n\n✏️ أرسل ID الشخص:', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_panel' }]] }
                    });
                } catch(e) {}
                return;
            }
            if (data.match(/^pick_add_admin_\d+$/)) {
                if (!isDeveloper(userId)) return;
                const page = parseInt(data.replace('pick_add_admin_', '')) || 1;
                const res = await buildUserBtns('add_admin_from', page, u => u.id !== developerId && !isAdminUser(u.id), 'pick_add_admin');
                try {
                    await bot.editMessageText('👨‍💼 اختر مستخدم لإضافته كأدمن:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: res.buttons } });
                } catch(e) {}
                return;
            }
            if (data.startsWith('add_admin_from_')) {
                if (!isDeveloper(userId)) return;
                const aId = data.replace('add_admin_from_', '');
                if (String(aId) === developerId) { await bot.sendMessage(chatId, '⛔ المطور لا يُضاف كأدمن.'); return; }
                await addAdmin(aId, userId);
                const aUser = await getUser(aId);
                await bot.sendMessage(chatId, `✅ تم إضافة *${getUserName(aUser)}* كأدمن.`, { parse_mode: 'Markdown' });
                try { await bot.sendMessage(aId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch(e) {}
                await showAdminPanel(chatId);
                return;
            }
            if (data.startsWith('rm_admin_')) {
                if (!isDeveloper(userId)) { await bot.sendMessage(chatId, '⛔ فقط المطور يمكنه إزالة الأدمنية.'); return; }
                const rmId = data.replace('rm_admin_', '');
                if (String(rmId) === developerId) { await bot.sendMessage(chatId, '⛔ لا يمكن إزالة المطور.'); return; }
                await removeAdmin(rmId);
                const rmUser = await getUser(rmId);
                await bot.sendMessage(chatId, `✅ تم إزالة *${getUserName(rmUser)}* من الأدمنية.`, { parse_mode: 'Markdown' });
                try { await bot.sendMessage(rmId, '⚠️ تم إزالتك من الأدمنية.'); } catch(e) {}
                await showAdminPanel(chatId);
                return;
            }
            if (data.startsWith('toggle_multi_')) {
                if (!isDeveloper(userId)) return;
                const tmId = data.replace('toggle_multi_', '');
                const rows = await query('SELECT multi_reply FROM admins WHERE user_id=?', [tmId]);
                const curVal = rows.length ? rows[0].multi_reply : 0;
                const newVal = curVal ? 0 : 1;
                await query('UPDATE admins SET multi_reply=? WHERE user_id=?', [newVal, tmId]);
                const tmUser = await getUser(tmId);
                await bot.sendMessage(chatId, `${newVal ? '✅ تم منح' : '❌ تم سحب'} صلاحية الرد على أكثر من مستخدم من *${getUserName(tmUser)}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } });
                return;
            }
            if (data.startsWith('edit_perms_')) {
                if (!isDeveloper(userId)) return;
                const adminId = data.replace('edit_perms_', '');
                await showEditPermissions(chatId, adminId, msgId);
                return;
            }
            if (data.startsWith('perm_toggle_')) {
                if (!isDeveloper(userId)) return;
                const parts = data.replace('perm_toggle_', '').split('_');
                const adminId = parts[0];
                const permKey = parts.slice(1).join('_');
                const perms = await getAdminPermissions(adminId);
                perms[permKey] = !perms[permKey];
                await updateAdminPermissions(adminId, perms);
                await showEditPermissions(chatId, adminId, msgId);
                return;
            }

            // إدارة القروبات
            if (data.startsWith('groups_list_')) {
                const page = parseInt(data.replace('groups_list_', '')) || 1;
                await showGroupsList(chatId, page, msgId);
                return;
            }
            if (data.startsWith('group_detail_')) {
                const groupId = data.replace('group_detail_', '');
                await showGroupDetail(chatId, groupId, msgId);
                return;
            }
            if (data.startsWith('group_members_')) {
                const parts = data.replace('group_members_', '').split('_p_');
                const groupId = parts[0];
                const page = parseInt(parts[1]) || 1;
                await showGroupMembers(chatId, groupId, page, msgId);
                return;
            }
            if (data.startsWith('gmember_')) {
                const parts = data.replace('gmember_', '').split('_u_');
                const groupId = parts[0];
                const memberId = parts[1];
                await showMemberActions(chatId, groupId, memberId, msgId);
                return;
            }
            if (data.startsWith('gaction_')) {
                const parts = data.replace('gaction_', '').split('_');
                const action = parts[0];
                const groupId = parts[1];
                const memberId = parts[2];
                await executeGroupAction(chatId, action, groupId, memberId, msgId);
                return;
            }

        } catch (err) {
            console.error('خطأ callback:', err.message);
        }
    });

    // ===== معالجة الرسائل =====
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const userName = msg.from.username || '';
        const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        // معالجة القروبات
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
            try {
                const chatMember = await bot.getChatMember(chatId, userId);
                const isAdmin = ['creator', 'administrator'].includes(chatMember.status);
                const isOwner = chatMember.status === 'creator';
                await updateGroupMember(chatId, userId, userName, fullName, '', isAdmin, msg.from.is_bot, isOwner);
                await updateMemberLastSeen(chatId, userId);
                if (msg.text) {
                    await saveGroupMessage(chatId, userId, msg.message_id, msg.text);
                }
            } catch(e) { console.error('خطأ معالجة رسالة القروب:', e.message); }
            return;
        }

        if (msg.chat.type !== 'private') return;

        // معالجة جهة الاتصال (التحقق)
        if (msg.contact) {
            if (String(msg.contact.user_id) !== userId) {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال جهة اتصالك الخاصة بك فقط!');
                return;
            }
            await query('UPDATE users SET phone=?, verified=1 WHERE id=?', [msg.contact.phone_number, userId]);
            await query('UPDATE tickets SET user_locked=0 WHERE user_id=? AND status="open"', [userId]);
            await bot.sendMessage(chatId, '✅ تم التحقق من هويتك بنجاح! يمكنك الآن متابعة طلبك وإرسال رسائلك.', { reply_markup: { remove_keyboard: true } });
            await bot.sendMessage(developerId, `🆕 *تحقق جديد بجهة اتصال*\n━━━━━━━━━━━━━━━\n👤 الاسم: ${fullName}\n🆔 ID: \`${userId}\`\n📞 الهاتف: \`${msg.contact.phone_number}\`\n🔗 اليوزر: @${userName || 'لا يوجد'}`, { parse_mode: 'Markdown' });
            return;
        }

        if (msg.text && msg.text.startsWith('/')) return;

        if (isAdminUser(userId)) {
            await handleAdminMsg(chatId, userId, msg);
            return;
        }

        await updateUser(userId, userName, fullName);
        const user = await getUser(userId);
        if (user && user.banned) {
            await bot.sendMessage(chatId, '⛔ أنت محظور من البوت.');
            return;
        }
        if (user && user.muted) {
            await bot.sendMessage(chatId, '🔇 أنت مكتوم حالياً ولا يمكنك إرسال رسائل.');
            return;
        }

        const userOpenTicket = await getOpenTicket(userId);
        if (userOpenTicket && userOpenTicket.user_locked === 1 && (!user || !user.verified)) {
            await bot.sendMessage(chatId,
                '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة وحماية البوت، يرجى التحقق من هويتك بمشاركة جهة اتصالك.\n\n⏳ لن تتمكن من إرسال رسائل جديدة حتى تتحقق.',
                { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
            );
            return;
        }

        if (user && !user.verified && (!userOpenTicket || userOpenTicket.admin_reply_count === 0)) {
            await bot.sendMessage(chatId,
                '⚠️ *يجب التحقق من هويتك أولاً*\n━━━━━━━━━━━━━━━\nلضمان جودة الخدمة ومنع الحسابات الوهمية، يرجى الضغط على الزر أدناه لمشاركة جهة اتصالك الحقيقية.',
                { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ اضغط هنا للتحقق 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
            );
            return;
        }

        const state = devState[chatId] || {};
        if (state.action === 'suggest') {
            devState[chatId] = {};
            const suggText = msg.text || '[محتوى غير نصي]';
            await query('INSERT INTO suggestions (user_id, text, ts, status) VALUES (?, ?, ?, ?)', [userId, suggText, Date.now(), 'new']);
            const sgUser = await getUser(userId);
            await bot.sendMessage(developerId, `💡 *اقتراح جديد!*\n━━━━━━━━━━━━━━━\n👤 ${getUserName(sgUser)}\n🆔 \`${userId}\`\n\n📝 ${suggText}\n\n🕒 ${formatTime(Date.now())}`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 رد عليه', callback_data: 'qr_' + userId }]] } });
            await bot.sendMessage(chatId, '✅ *شكراً على اقتراحك!*\n\n💡 تم إرسال اقتراحك للمطور وسيتم مراجعته.\nنقدر مشاركتك في تطوير البوت! 🙏', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح آخر', callback_data: 'suggest' }]] } });
            return;
        }

        const now = Date.now();
        const ticketId = await createTicket(userId);
        if (ticketId) {
            const msgContent = msg.text || (msg.photo ? '[صورة]' : msg.video ? '[فيديو]' : msg.document ? '[ملف]' : msg.voice ? '[صوت]' : '[محتوى]');
            await saveTicketEvent(ticketId, userId, 'user', 'message', msgContent);
        }

        const quickBtns = { inline_keyboard: [
            [{ text: '↩️ رد', callback_data: await saveCB('qr_' + userId) }, { text: '🚫 حظر وحذف', callback_data: await saveCB('do_ban_' + userId) }, { text: '🔇 كتم', callback_data: await saveCB('do_mute_' + userId) }],
            [{ text: '🙋 سأتكفل بهذا الطلب', callback_data: await saveCB('claim_' + userId + '_' + ticketId) }]
        ] };

        const admins = await getAdminList();
        pendingNotify[userId] = { notified: false, ts: now };
        let forwarded = false;

        try {
            await bot.sendMessage(developerId, `📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n👤 ${fullName || 'بدون اسم'}\n🔗 ${userName ? '@' + userName : 'بدون يوزر'}\n🆔 \`${userId}\`\n📞 \`${user?.phone || 'غير متوفر'}\`\n🕒 ${formatTime(now)}`, { parse_mode: 'Markdown' });
            const fwdDev = await bot.forwardMessage(developerId, chatId, msg.message_id);
            await saveMsgMap(userId, msg.message_id, fwdDev.message_id, developerId);
            await bot.sendMessage(developerId, `⬆️ من: *${fullName || 'مستخدم'}*`, { parse_mode: 'Markdown', reply_markup: quickBtns });
            forwarded = true;
        } catch(e) { console.log('فشل التحويل للمطور:', e.message); }

        for (const a of admins) {
            if (a.user_id === developerId) continue;
            try {
                await bot.sendMessage(a.user_id, `📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n👤 ${fullName || 'بدون اسم'}\n🔗 ${userName ? '@' + userName : 'بدون يوزر'}\n🕒 ${formatTime(now)}`, { parse_mode: 'Markdown' });
                const fwdAdmin = await bot.forwardMessage(a.user_id, chatId, msg.message_id);
                await saveMsgMap(userId, msg.message_id, fwdAdmin.message_id, a.user_id);
                await bot.sendMessage(a.user_id, `⬆️ من: *${fullName || 'مستخدم'}*`, { parse_mode: 'Markdown', reply_markup: quickBtns });
                forwarded = true;
            } catch(e) { console.log(`فشل التحويل للأدمن ${a.user_id}:`, e.message); }
        }

        if (forwarded) {
            await bot.sendMessage(chatId, '✅ *تم استلام رسالتك!*\n\n📬 رسالتك وصلت للأستاذ وسيطلع عليها قريباً.\n⏳ سوف نعلمك فور فتح الأستاذ للمحادثة.', { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, '⚠️ حدث خطأ. حاول مرة أخرى.');
        }
    });

    // ===== معالجة رسائل الأدمنية =====
    async function handleAdminMsg(chatId, userId, msg) {
        const state = devState[chatId] || {};
        if (msg.text && msg.text.startsWith('/')) return;

        // إضافة أدمن بالـ ID
        if (state.action === 'add_admin' && isDeveloper(userId)) {
            devState[chatId] = {};
            const adminId = (msg.text || '').trim();
            if (!adminId || !/^\d+$/.test(adminId)) {
                await bot.sendMessage(chatId, '⚠️ أرسل ID صحيح (أرقام فقط).', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'admin_panel' }]] } });
                return;
            }
            if (String(adminId) === developerId) {
                await bot.sendMessage(chatId, '⛔ المطور لا يُضاف كأدمن.');
                return;
            }
            await addAdmin(adminId, userId);
            await bot.sendMessage(chatId, `✅ تم إضافة \`${adminId}\` كأدمن.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } });
            try { await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch(e) {}
            return;
        }

        // إرسال إشعار تحديث - الخطوة 1
        if (state.action === 'send_update_users' && isDeveloper(userId)) {
            devState[chatId] = { action: 'send_update_admins', update_users_msg: msg.text === '-' ? null : msg.text };
            await bot.sendMessage(chatId,
                '📣 *إرسال إشعار تحديث*\n\nالخطوة 2/2: اكتب رسالة التحديث للأدمنية:\n(أو أرسل "-" لتخطي رسالة الأدمنية)',
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }
            );
            return;
        }

        // إرسال إشعار تحديث - الخطوة 2
        if (state.action === 'send_update_admins' && isDeveloper(userId)) {
            const usersMsg = state.update_users_msg;
            const adminsMsg = msg.text === '-' ? null : msg.text;
            devState[chatId] = {};

            if (!usersMsg && !adminsMsg) {
                await bot.sendMessage(chatId, '⚠️ لم تكتب أي رسالة.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                return;
            }

            await query('INSERT INTO bot_updates (version, msg_users, msg_admins, created_at, sent) VALUES (?, ?, ?, ?, 0)', [formatTime(Date.now()), usersMsg || '', adminsMsg || '', Date.now()]);

            if (usersMsg) {
                const allUsers = await getAllUsers();
                let sentOk = 0;
                for (const u of allUsers) {
                    if (isAdminUser(u.id)) continue;
                    try {
                        await bot.sendMessage(u.id, `🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n${usersMsg}\n\nاضغط /start لرؤية التحديث.`, { parse_mode: 'Markdown' });
                        sentOk++;
                    } catch(e) {}
                }
                await bot.sendMessage(chatId, `📨 تم إرسال للمستخدمين: ${sentOk}`);
            }

            if (adminsMsg) {
                const adminsList = await getAdminList();
                const recipients = [developerId, ...adminsList.map(a => a.user_id).filter(id => id !== developerId && id !== userId)];
                for (const rec of recipients) {
                    try {
                        await bot.sendMessage(rec, `🔔 *تحديث للأدمنية!*\n━━━━━━━━━━━━━━━\n${adminsMsg}\n\nاضغط /start لرؤية التحديث.`, { parse_mode: 'Markdown' });
                    } catch(e) {}
                }
            }

            await bot.sendMessage(chatId, '✅ *تم إرسال إشعار التحديث!*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            return;
        }

        // رسالة جماعية
        if (state.action === 'broadcast') {
            devState[chatId] = {};
            const all = (await getAllUsers()).filter(u => !u.banned);
            let ok = 0, fail = 0;
            await bot.sendMessage(chatId, `📢 جاري الإرسال لـ ${all.length} مستخدم...`);
            for (const u of all) {
                try { await bot.copyMessage(u.id, chatId, msg.message_id); ok++; } catch(e) { fail++; }
            }
            await bot.sendMessage(chatId, `✅ تم! نجح: ${ok} | فشل: ${fail}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            return;
        }

        // الرد على مستخدم (حالة reply)
        if (state.action === 'reply' && state.targetId) {
            const target = state.targetId;
            devState[chatId] = {};
            try {
                await bot.copyMessage(target, chatId, msg.message_id);
                await query('UPDATE admins SET helped_count = helped_count + 1 WHERE user_id = ?', [userId]);
                const targetTicket = await getOpenTicket(target);
                if (targetTicket) {
                    const replyContent = msg.text || (msg.photo ? '[صورة]' : msg.video ? '[فيديو]' : msg.document ? '[ملف]' : msg.voice ? '[صوت]' : '[محتوى]');
                    await saveTicketEvent(targetTicket.id, userId, 'admin', 'message', replyContent);
                    await query('UPDATE tickets SET admin_reply_count = admin_reply_count + 1 WHERE id = ?', [targetTicket.id]);
                    const newCount = (targetTicket.admin_reply_count || 0) + 1;
                    if (newCount === 2) {
                        setTimeout(async () => {
                            const targetUserObj = await getUser(target);
                            if (!targetUserObj || targetUserObj.verified) return;
                            await query('UPDATE tickets SET user_locked = 1 WHERE id = ?', [targetTicket.id]);
                            try {
                                await bot.sendMessage(target,
                                    '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة وحماية البوت، يرجى التحقق من هويتك بمشاركة جهة اتصالك.\n\n⏳ لن تتمكن من إرسال رسائل جديدة حتى تتحقق.',
                                    { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
                                );
                            } catch(e) {}
                        }, 5000);
                    }
                }
                try { await bot.sendMessage(target, '💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.', { parse_mode: 'Markdown' }); } catch(e) {}
                await bot.sendMessage(chatId, `✅ تم إرسال الرد للمستخدم \`${target}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '↩️ رد آخر', callback_data: 'qr_' + target }], [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            } catch(err) {
                await bot.sendMessage(chatId, `❌ فشل: ${err.message}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            }
            return;
        }

        // الرد بالرد على رسالة مُعادة
        if (msg.reply_to_message) {
            const repliedMsgId = msg.reply_to_message.message_id;
            const targetUserId = await getUserByFwdMsg(repliedMsgId, chatId);
            if (targetUserId) {
                try {
                    await bot.copyMessage(targetUserId, chatId, msg.message_id);
                    const replyTicket = await getOpenTicket(targetUserId);
                    if (replyTicket) {
                        const replyContent = msg.text || (msg.photo ? '[صورة]' : msg.video ? '[فيديو]' : msg.document ? '[ملف]' : msg.voice ? '[صوت]' : '[محتوى]');
                        await saveTicketEvent(replyTicket.id, userId, 'admin', 'message', replyContent);
                        await query('UPDATE tickets SET admin_reply_count = admin_reply_count + 1 WHERE id = ?', [replyTicket.id]);
                        const newCount = (replyTicket.admin_reply_count || 0) + 1;
                        if (newCount === 2) {
                            setTimeout(async () => {
                                const targetUserObj = await getUser(targetUserId);
                                if (!targetUserObj || targetUserObj.verified) return;
                                await query('UPDATE tickets SET user_locked = 1 WHERE id = ?', [replyTicket.id]);
                                try {
                                    await bot.sendMessage(targetUserId,
                                        '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة وحماية البوت، يرجى التحقق من هويتك بمشاركة جهة اتصالك.\n\n⏳ لن تتمكن من إرسال رسائل جديدة حتى تتحقق.',
                                        { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
                                    );
                                } catch(e) {}
                            }, 5000);
                        }
                    }
                    try { await bot.sendMessage(targetUserId, '💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.', { parse_mode: 'Markdown' }); } catch(e) {}
                    await bot.sendMessage(chatId, `✅ تم إرسال الرد للمستخدم \`${targetUserId}\``, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '↩️ رد آخر', callback_data: 'qr_' + targetUserId }], [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
                } catch(err) {
                    await bot.sendMessage(chatId, `❌ فشل: ${err.message}`);
                }
                return;
            }
        }

        await sendMainMenu(chatId);
    }

    // أحداث القروبات
    bot.on('new_chat_members', async (msg) => {
        const chatId = msg.chat.id;
        const newMembers = msg.new_chat_members;
        for (const member of newMembers) {
            if (member.is_bot && member.username && member.username.includes('bot')) {
                const chatInfo = await bot.getChat(chatId);
                const memberCount = await bot.getChatMemberCount(chatId);
                const addedBy = msg.from.id;
                await saveGroup(chatId, chatInfo.title, chatInfo.username, memberCount, addedBy);
                const notif = `🆕 *تمت إضافة البوت لقروب جديد!*\n━━━━━━━━━━━━━━━\n📱 القروب: ${chatInfo.title}\n🔗 اليوزر: ${chatInfo.username ? '@' + chatInfo.username : '-'}\n🆔 ID: \`${chatId}\`\n👥 الأعضاء: ${memberCount}\n👤 أضافه: ${((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim()}\n🔗 ${msg.from.username ? '@' + msg.from.username : '-'}\n🕒 ${formatTime(Date.now())}`;
                await bot.sendMessage(developerId, notif, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📱 عرض التفاصيل', callback_data: await saveCB('group_detail_' + chatId) }]] } });
                try {
                    const admins = await bot.getChatAdministrators(chatId);
                    for (const admin of admins) {
                        const isOwner = admin.status === 'creator';
                        const isBot = admin.user.is_bot;
                        const fullName = ((admin.user.first_name || '') + ' ' + (admin.user.last_name || '')).trim();
                        await updateGroupMember(chatId, admin.user.id, admin.user.username, fullName, '', true, isBot, isOwner);
                    }
                } catch(e) {}
                return;
            }
            const isBot = member.is_bot;
            const fullName = ((member.first_name || '') + ' ' + (member.last_name || '')).trim();
            await updateGroupMember(chatId, member.id, member.username, fullName, '', false, isBot, false);
        }
    });

    bot.on('left_chat_member', async (msg) => {
        const chatId = msg.chat.id;
        const member = msg.left_chat_member;
        try {
            await query('DELETE FROM group_members WHERE group_id=? AND user_id=?', [String(chatId), String(member.id)]);
        } catch(e) {}
    });

    console.log('✅ البوت جاهز مع جميع الميزات المدمجة');
}

// ===== تشغيل الخادم =====
const app = express();
app.get('/', (req, res) => { res.send('Teachers Bot is running! 🎓'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

const port = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.listen(port, () => {
    console.log(`✅ Port ${port}`);
    setInterval(() => {
        const url = serverUrl + '/health';
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => { console.log('🔄 Keep-alive: ' + res.statusCode); }).on('error', (e) => { console.log('⚠️ Keep-alive error: ' + e.message); });
    }, 14 * 60 * 1000);
});

startBot().catch(e => {
    console.error('خطأ:', e.message);
    process.exit(1);
});