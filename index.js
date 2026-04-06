'use strict';
const TelegramBot = require('node-telegram-bot-api');
const express    = require('express');
const mysql      = require('mysql2/promise');
const https      = require('https');
const http       = require('http');

// ============================================================
//  ⚙️  الإعدادات الأساسية
// ============================================================
const BOT_TOKEN   = process.env.BOT_TOKEN   || '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const developerId = process.env.DEVELOPER_ID || '7411444902';

const DB_CONFIG = {
    host            : process.env.DB_HOST     || 'sql5.freesqldatabase.com',
    user            : process.env.DB_USER     || 'sql5822025',
    password        : process.env.DB_PASS     || 'UHrehHF1CU',
    database        : process.env.DB_NAME     || 'sql5822025',
    port            : parseInt(process.env.DB_PORT || '3306'),
    connectTimeout  : 20000,
    waitForConnections: true,
    connectionLimit : 10,
    queueLimit      : 0,
    enableKeepAlive : true,
    keepAliveInitialDelay: 0
};

// الصلاحيات الافتراضية للأدمن
const DEFAULT_PERMISSIONS = {
    canBan          : true,
    canMute         : true,
    canBroadcast    : false,
    canViewStats    : true,
    canManageTickets: true,
    canManageGroups : true,
    canReplyUsers   : true
};

// ============================================================
//  🗄️  متغيرات عامة
// ============================================================
let pool      = null;
let bot       = null;
let devState  = {};        // حالات المحادثة
let adminIds  = [developerId];
const spamMap = {};        // حماية من السبام { userId: { count, ts } }
const SPAM_LIMIT   = 5;    // عدد الرسائل المسموح بها
const SPAM_WINDOW  = 10000; // نافذة زمنية (10 ثانية)
const REMIND_AFTER = 15 * 60 * 1000; // تذكير الأدمن بعد 15 دقيقة

// ============================================================
//  🔌  قاعدة البيانات
// ============================================================
async function createPool() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        await pool.execute('SELECT 1'); // اختبار الاتصال
        console.log('✅ تم الاتصال بـ MySQL');
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
            await sleep(1000 * (i + 1));
        }
    }
}

async function initDB() {
    // ── جدول المستخدمين ──
    await query(`CREATE TABLE IF NOT EXISTS users (
        id            VARCHAR(50)  PRIMARY KEY,
        username      VARCHAR(255) DEFAULT '',
        name          VARCHAR(500) DEFAULT '',
        first_seen    BIGINT       DEFAULT 0,
        last_seen     BIGINT       DEFAULT 0,
        messages_count INT         DEFAULT 0,
        banned        TINYINT(1)   DEFAULT 0,
        muted         TINYINT(1)   DEFAULT 0,
        phone         VARCHAR(50)  DEFAULT '',
        verified      TINYINT(1)   DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول الأدمنية ──
    await query(`CREATE TABLE IF NOT EXISTS admins (
        user_id              VARCHAR(50) PRIMARY KEY,
        added_by             VARCHAR(50) NOT NULL,
        added_at             BIGINT      DEFAULT 0,
        permissions          JSON,
        multi_reply          TINYINT(1)  DEFAULT 0,
        last_login           BIGINT      DEFAULT 0,
        total_active_minutes INT         DEFAULT 0,
        helped_count         INT         DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول التذاكر ──
    await query(`CREATE TABLE IF NOT EXISTS tickets (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        user_id          VARCHAR(50) NOT NULL,
        claimed_by       VARCHAR(50) DEFAULT NULL,
        claimed_at       BIGINT      DEFAULT 0,
        status           VARCHAR(20) DEFAULT 'open',
        created_at       BIGINT      DEFAULT 0,
        completed_at     BIGINT      DEFAULT 0,
        rating           INT         DEFAULT 0,
        admin_reply_count INT        DEFAULT 0,
        user_locked      TINYINT(1)  DEFAULT 0,
        reminded         TINYINT(1)  DEFAULT 0,
        INDEX idx_user   (user_id),
        INDEX idx_claimed(claimed_by),
        INDEX idx_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول أحداث التذاكر ──
    await query(`CREATE TABLE IF NOT EXISTS ticket_events (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id  INT         NOT NULL,
        user_id    VARCHAR(50) NOT NULL,
        role       VARCHAR(20) DEFAULT 'user',
        event_type VARCHAR(30) DEFAULT 'message',
        content    TEXT,
        ts         BIGINT      DEFAULT 0,
        INDEX idx_ticket(ticket_id),
        INDEX idx_user  (user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول خرائط الرسائل ──
    await query(`CREATE TABLE IF NOT EXISTS msg_map (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        user_id     VARCHAR(50) NOT NULL,
        user_msg_id INT         NOT NULL,
        fwd_msg_id  INT         NOT NULL,
        fwd_chat_id VARCHAR(50) NOT NULL,
        ts          BIGINT      DEFAULT 0,
        INDEX idx_user(user_id),
        INDEX idx_fwd (fwd_msg_id, fwd_chat_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول الاقتراحات ──
    await query(`CREATE TABLE IF NOT EXISTS suggestions (
        id      INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        text    TEXT        NOT NULL,
        ts      BIGINT      DEFAULT 0,
        status  VARCHAR(20) DEFAULT 'new',
        INDEX idx_user  (user_id),
        INDEX idx_status(status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول بيانات الأزرار ──
    await query(`CREATE TABLE IF NOT EXISTS cb_data (
        id   INT AUTO_INCREMENT PRIMARY KEY,
        data TEXT   NOT NULL,
        ts   BIGINT DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول تحديثات البوت ──
    await query(`CREATE TABLE IF NOT EXISTS bot_updates (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        version    VARCHAR(50) NOT NULL,
        msg_users  TEXT,
        msg_admins TEXT,
        created_at BIGINT      DEFAULT 0,
        sent       TINYINT(1)  DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جداول القروبات ──
    await query(`CREATE TABLE IF NOT EXISTS \`groups\` (
        group_id     VARCHAR(50)  PRIMARY KEY,
        title        VARCHAR(255) NOT NULL,
        username     VARCHAR(255) DEFAULT '',
        member_count INT          DEFAULT 0,
        added_at     BIGINT       DEFAULT 0,
        added_by     VARCHAR(50)  NOT NULL,
        is_active    TINYINT(1)   DEFAULT 1
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS group_members (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        group_id   VARCHAR(50)  NOT NULL,
        user_id    VARCHAR(50)  NOT NULL,
        username   VARCHAR(255) DEFAULT '',
        name       VARCHAR(500) DEFAULT '',
        phone      VARCHAR(50)  DEFAULT '',
        is_admin   TINYINT(1)   DEFAULT 0,
        is_bot     TINYINT(1)   DEFAULT 0,
        is_owner   TINYINT(1)   DEFAULT 0,
        banned     TINYINT(1)   DEFAULT 0,
        muted      TINYINT(1)   DEFAULT 0,
        warnings   INT          DEFAULT 0,
        joined_at  BIGINT       DEFAULT 0,
        last_seen  BIGINT       DEFAULT 0,
        UNIQUE KEY uk_group_user(group_id, user_id),
        INDEX idx_group(group_id),
        INDEX idx_user (user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS group_messages (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        group_id   VARCHAR(50) NOT NULL,
        user_id    VARCHAR(50) NOT NULL,
        message_id INT         NOT NULL,
        text       TEXT,
        ts         BIGINT      DEFAULT 0,
        INDEX idx_group(group_id),
        INDEX idx_user (user_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // ── جدول سجل الأخطاء ──
    await query(`CREATE TABLE IF NOT EXISTS error_logs (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        context    VARCHAR(100) DEFAULT '',
        message    TEXT,
        stack      TEXT,
        ts         BIGINT DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // تحميل الأدمنية من DB
    const adminsRows = await query('SELECT user_id FROM admins');
    for (const row of adminsRows) {
        if (!adminIds.includes(row.user_id)) adminIds.push(row.user_id);
    }

    // تأكد من وجود المطور في جدول admins
    const devExists = await query('SELECT user_id FROM admins WHERE user_id=?', [developerId]);
    if (devExists.length === 0) {
        await query(
            'INSERT IGNORE INTO admins (user_id, added_by, added_at, permissions) VALUES (?,?,?,?)',
            [developerId, developerId, Date.now(),
             JSON.stringify({ ...DEFAULT_PERMISSIONS, canBroadcast: true, canManageGroups: true })]
        );
    }

    console.log('✅ تم تهيئة جميع الجداول');
}

// ============================================================
//  🛠️  دوال مساعدة عامة
// ============================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (isNaN(d)) return '—';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getUserName(u) {
    if (!u) return 'مجهول';
    const name = (u.name || '').trim() || (u.username ? '@' + u.username : '') || String(u.id || u.user_id || '');
    return name;
}

function escMd(text) {
    return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function logError(context, err) {
    console.error(`[${context}]`, err.message);
    try {
        await query('INSERT INTO error_logs (context, message, stack, ts) VALUES (?,?,?,?)',
            [context, err.message, err.stack || '', Date.now()]);
    } catch(_) {}
}

// ── حماية من السبام ──
function isSpam(userId) {
    const now = Date.now();
    if (!spamMap[userId]) { spamMap[userId] = { count: 1, ts: now }; return false; }
    if (now - spamMap[userId].ts > SPAM_WINDOW) { spamMap[userId] = { count: 1, ts: now }; return false; }
    spamMap[userId].count++;
    return spamMap[userId].count > SPAM_LIMIT;
}

// ============================================================
//  📦  cb_data (ضغط بيانات الأزرار)
// ============================================================
async function saveCB(data) {
    if (data.length < 50) return data;
    try {
        const res = await query('INSERT INTO cb_data (data, ts) VALUES (?,?)', [data, Date.now()]);
        return 'c_' + res.insertId;
    } catch(e) { return data.substring(0, 64); }
}

async function getCB(id) {
    if (!String(id).startsWith('c_')) return id;
    try {
        const rows = await query('SELECT data FROM cb_data WHERE id=?', [id.substring(2)]);
        return rows.length > 0 ? rows[0].data : null;
    } catch(e) { return null; }
}

// ============================================================
//  👤  دوال المستخدمين
// ============================================================
async function getUser(userId) {
    try {
        const rows = await query('SELECT * FROM users WHERE id=?', [String(userId)]);
        if (!rows.length) return null;
        const u = rows[0];
        u.banned   = u.banned   === 1;
        u.muted    = u.muted    === 1;
        u.verified = u.verified === 1;
        return u;
    } catch(e) { return null; }
}

async function getAllUsers() {
    try {
        const rows = await query('SELECT * FROM users ORDER BY last_seen DESC');
        return rows.map(u => {
            u.banned   = u.banned   === 1;
            u.muted    = u.muted    === 1;
            u.verified = u.verified === 1;
            return u;
        });
    } catch(e) { return []; }
}

async function updateUser(userId, userName, fullName) {
    const now = Date.now();
    try {
        const existing = await getUser(userId);
        if (!existing) {
            await query(
                'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count) VALUES (?,?,?,?,?,1)',
                [String(userId), userName || '', fullName || '', now, now]
            );
        } else {
            await query(
                'UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=? WHERE id=?',
                [now, userName || existing.username, fullName || existing.name, String(userId)]
            );
        }
    } catch(e) { await logError('updateUser', e); }
}

async function setUserField(userId, field, value) {
    const allowed = ['banned','muted','phone','verified','username','name'];
    if (!allowed.includes(field)) return;
    try { await query(`UPDATE users SET ${field}=? WHERE id=?`, [value, String(userId)]); } catch(e) {}
}

async function searchUsers(term) {
    try {
        const t = `%${term}%`;
        return await query(
            'SELECT * FROM users WHERE name LIKE ? OR username LIKE ? OR id LIKE ? OR phone LIKE ? LIMIT 20',
            [t, t, t, t]
        );
    } catch(e) { return []; }
}

// ============================================================
//  👨‍💼  دوال الأدمنية
// ============================================================
const isAdminUser  = userId => adminIds.includes(String(userId));
const isDeveloper  = userId => String(userId) === String(developerId);

async function addAdmin(userId, addedBy, permissions = DEFAULT_PERMISSIONS) {
    if (isDeveloper(userId)) return;
    try {
        await query(
            'INSERT IGNORE INTO admins (user_id, added_by, added_at, permissions) VALUES (?,?,?,?)',
            [String(userId), String(addedBy), Date.now(), JSON.stringify(permissions)]
        );
        if (!adminIds.includes(String(userId))) adminIds.push(String(userId));
    } catch(e) { await logError('addAdmin', e); }
}

async function removeAdmin(userId) {
    if (isDeveloper(userId)) return;
    try {
        await query('DELETE FROM admins WHERE user_id=?', [String(userId)]);
        const idx = adminIds.indexOf(String(userId));
        if (idx > -1) adminIds.splice(idx, 1);
    } catch(e) {}
}

async function getAdminList() {
    try {
        const rows = await query(
            `SELECT a.*, u.name, u.username
             FROM admins a LEFT JOIN users u ON a.user_id = u.id
             ORDER BY a.added_at DESC`
        );
        return rows.map(r => ({
            ...r,
            permissions: r.permissions ? (typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions) : DEFAULT_PERMISSIONS,
            multi_reply: r.multi_reply === 1
        }));
    } catch(e) { return []; }
}

async function getAdminPermissions(adminId) {
    if (isDeveloper(adminId)) return { ...DEFAULT_PERMISSIONS, canBroadcast: true, canManageGroups: true };
    try {
        const rows = await query('SELECT permissions FROM admins WHERE user_id=?', [String(adminId)]);
        if (rows.length && rows[0].permissions) {
            const p = rows[0].permissions;
            return typeof p === 'string' ? JSON.parse(p) : p;
        }
        return DEFAULT_PERMISSIONS;
    } catch(e) { return DEFAULT_PERMISSIONS; }
}

async function updateAdminPermissions(adminId, permissions) {
    try { await query('UPDATE admins SET permissions=? WHERE user_id=?', [JSON.stringify(permissions), String(adminId)]); } catch(e) {}
}

async function canAdminReply(adminId, targetUserId) {
    if (isDeveloper(adminId)) return true;
    const perms = await getAdminPermissions(adminId);
    if (!perms.canReplyUsers) return false;
    const ticket = await getOpenTicket(targetUserId);
    if (!ticket) return true;
    if (ticket.claimed_by === String(adminId)) return true;
    const rows = await query('SELECT multi_reply FROM admins WHERE user_id=?', [String(adminId)]);
    return rows.length ? rows[0].multi_reply === 1 : false;
}

// ============================================================
//  🎫  دوال التذاكر
// ============================================================
async function getOpenTicket(userId) {
    try {
        const rows = await query(
            "SELECT * FROM tickets WHERE user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1",
            [String(userId)]
        );
        return rows[0] || null;
    } catch(e) { return null; }
}

async function createTicket(userId) {
    try {
        // أغلق أي تذكرة مفتوحة قديمة أولاً
        await query("UPDATE tickets SET status='archived' WHERE user_id=? AND status='open'", [String(userId)]);
        const res = await query(
            'INSERT INTO tickets (user_id, status, created_at) VALUES (?,?,?)',
            [String(userId), 'open', Date.now()]
        );
        return res.insertId;
    } catch(e) { return null; }
}

async function claimTicket(ticketId, adminId) {
    try {
        await query(
            'UPDATE tickets SET claimed_by=?, claimed_at=? WHERE id=? AND (claimed_by IS NULL OR claimed_by=?)',
            [String(adminId), Date.now(), ticketId, String(adminId)]
        );
        const rows = await query('SELECT * FROM tickets WHERE id=?', [ticketId]);
        return rows[0] || null;
    } catch(e) { return null; }
}

async function completeTicket(ticketId) {
    try {
        await query(
            "UPDATE tickets SET status='completed', completed_at=? WHERE id=?",
            [Date.now(), ticketId]
        );
    } catch(e) {}
}

async function rateTicket(ticketId, rating) {
    try { await query('UPDATE tickets SET rating=? WHERE id=?', [rating, ticketId]); } catch(e) {}
}

async function saveTicketEvent(ticketId, userId, role, eventType, content) {
    try {
        await query(
            'INSERT INTO ticket_events (ticket_id, user_id, role, event_type, content, ts) VALUES (?,?,?,?,?,?)',
            [ticketId, String(userId), role, eventType, content || '', Date.now()]
        );
    } catch(e) {}
}

// ============================================================
//  🗺️  دوال خرائط الرسائل
// ============================================================
async function saveMsgMap(userId, userMsgId, fwdMsgId, fwdChatId) {
    try {
        await query(
            'INSERT INTO msg_map (user_id, user_msg_id, fwd_msg_id, fwd_chat_id, ts) VALUES (?,?,?,?,?)',
            [String(userId), userMsgId, fwdMsgId, String(fwdChatId), Date.now()]
        );
    } catch(e) {}
}

async function getUserByFwdMsg(fwdMsgId, fwdChatId) {
    try {
        const rows = await query(
            'SELECT user_id FROM msg_map WHERE fwd_msg_id=? AND fwd_chat_id=?',
            [fwdMsgId, String(fwdChatId)]
        );
        return rows.length > 0 ? rows[0].user_id : null;
    } catch(e) { return null; }
}

// ============================================================
//  📱  دوال القروبات
// ============================================================
async function saveGroup(groupId, title, username, memberCount, addedBy) {
    try {
        await query(
            `INSERT INTO \`groups\` (group_id, title, username, member_count, added_at, added_by, is_active)
             VALUES (?,?,?,?,?,?,1)
             ON DUPLICATE KEY UPDATE title=?, username=?, member_count=?, is_active=1`,
            [String(groupId), title, username||'', memberCount||0, Date.now(), String(addedBy),
             title, username||'', memberCount||0]
        );
    } catch(e) { await logError('saveGroup', e); }
}

async function updateGroupMember(groupId, userId, username, name, phone, isAdmin, isBot, isOwner) {
    try {
        const now = Date.now();
        await query(
            `INSERT INTO group_members
                (group_id, user_id, username, name, phone, is_admin, is_bot, is_owner, joined_at, last_seen)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
                username=VALUES(username), name=VALUES(name), phone=VALUES(phone),
                is_admin=VALUES(is_admin), is_bot=VALUES(is_bot), is_owner=VALUES(is_owner), last_seen=VALUES(last_seen)`,
            [String(groupId), String(userId), username||'', name||'', phone||'',
             isAdmin?1:0, isBot?1:0, isOwner?1:0, now, now]
        );
    } catch(e) { await logError('updateGroupMember', e); }
}

async function setGroupMemberField(groupId, userId, field, value) {
    const allowed = ['banned','muted','warnings','is_admin'];
    if (!allowed.includes(field)) return;
    try { await query(`UPDATE group_members SET ${field}=? WHERE group_id=? AND user_id=?`, [value, String(groupId), String(userId)]); } catch(e) {}
}

async function getAllGroups() {
    try { return await query("SELECT * FROM \`groups\` WHERE is_active=1 ORDER BY added_at DESC"); } catch(e) { return []; }
}

async function getGroupMembers(groupId) {
    try { return await query('SELECT * FROM group_members WHERE group_id=? ORDER BY last_seen DESC', [String(groupId)]); } catch(e) { return []; }
}

// ============================================================
//  🔧  دوال بناء الأزرار
// ============================================================
async function buildUserBtns(cbPrefix, page, filterFn, backPrefix) {
    const all = await getAllUsers();
    const filtered = filterFn ? all.filter(filterFn) : all;
    const perPage = 8;
    const totalPages = Math.ceil(filtered.length / perPage) || 1;
    let pg = Math.max(1, Math.min(page, totalPages));
    const pageUsers = filtered.slice((pg-1)*perPage, pg*perPage);
    const btns = [];
    for (const u of pageUsers) {
        let label = '';
        if (u.banned)              label += '🚫 ';
        if (u.muted)               label += '🔇 ';
        if (u.id === developerId)  label += '👑 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        btns.push([{ text: label, callback_data: await saveCB(cbPrefix + '_' + u.id) }]);
    }
    const navRow = [];
    if (pg > 1)          navRow.push({ text: '⬅️', callback_data: backPrefix + '_' + (pg-1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: backPrefix + '_' + (pg+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);
    return { buttons: btns, total: filtered.length };
}

// ============================================================
//  🏠  لوحة التحكم الرئيسية
// ============================================================
async function sendMainMenu(chatId, editMsgId) {
    const isAdmin = isAdminUser(chatId);
    const isDev   = isDeveloper(chatId);

    // إحصائيات سريعة
    const openCount     = ((await query("SELECT COUNT(*) as c FROM tickets WHERE status='open'"))[0]?.c) || 0;
    const claimedCount  = ((await query("SELECT COUNT(*) as c FROM tickets WHERE claimed_by IS NOT NULL AND status='open'"))[0]?.c) || 0;
    const unclaimedCount = openCount - claimedCount;
    const newSugg       = ((await query("SELECT COUNT(*) as c FROM suggestions WHERE status='new'"))[0]?.c) || 0;

    let text = `🎓 *لوحة التحكم*\n━━━━━━━━━━━━━━━\n`;
    text += `🎫 طلبات مفتوحة: *${openCount}* (${unclaimedCount} بانتظار)\n`;
    text += `💡 اقتراحات جديدة: *${newSugg}*\n━━━━━━━━━━━━━━━`;

    const btns = [];

    // صف الطلبات
    btns.push([
        { text: `🎫 الطلبات المفتوحة (${openCount})`, callback_data: 'tickets_open_1' },
        { text: `📋 الطلبات المعلقة (${claimedCount})`, callback_data: 'tickets_claimed_1' }
    ]);

    // صف المستخدمين والإحصائيات
    btns.push([
        { text: '👥 المستخدمين', callback_data: 'users_1' },
        { text: '📈 الإحصائيات', callback_data: 'stats' }
    ]);

    // صف الاقتراحات والبحث
    btns.push([
        { text: `💡 الاقتراحات${newSugg > 0 ? ` (${newSugg} 🔴)` : ''}`, callback_data: 'suggestions_1' },
        { text: '🔍 بحث عن مستخدم', callback_data: 'search_user' }
    ]);

    // صف الرسائل الجماعية والقروبات
    const perms = await getAdminPermissions(chatId);
    if (perms.canBroadcast || isDev) {
        btns.push([{ text: '📢 رسالة جماعية', callback_data: 'broadcast' }]);
    }
    if (perms.canManageGroups || isDev) {
        btns.push([{ text: '📱 إدارة القروبات', callback_data: 'groups_list_1' }]);
    }

    // للمطور فقط
    if (isDev) {
        btns.push([
            { text: '👨‍💼 إدارة الأدمنية', callback_data: 'admin_panel' },
            { text: '📣 إشعار تحديث', callback_data: 'send_update' }
        ]);
        btns.push([
            { text: '📤 تصدير المستخدمين CSV', callback_data: 'export_users' },
            { text: '🗑️ أرشفة التذاكر القديمة', callback_data: 'archive_old_tickets' }
        ]);
    }

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts });
            return;
        } catch(e) {}
    }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  📈  الإحصائيات
// ============================================================
async function showStats(chatId, editMsgId) {
    const allUsers      = await getAllUsers();
    const dayAgo        = Date.now() - 86400000;
    const totalMsgs     = ((await query('SELECT COUNT(*) as c FROM msg_map'))[0]?.c) || 0;
    const todayMsgs     = ((await query('SELECT COUNT(*) as c FROM msg_map WHERE ts>?', [dayAgo]))[0]?.c) || 0;
    const totalTickets  = ((await query('SELECT COUNT(*) as c FROM tickets'))[0]?.c) || 0;
    const completedT    = ((await query("SELECT COUNT(*) as c FROM tickets WHERE status='completed'"))[0]?.c) || 0;
    const avgRatingRes  = await query('SELECT AVG(rating) as avg FROM tickets WHERE rating>0');
    const avgRating     = avgRatingRes[0]?.avg ? parseFloat(avgRatingRes[0].avg).toFixed(1) : '—';
    const totalSugg     = ((await query('SELECT COUNT(*) as c FROM suggestions'))[0]?.c) || 0;
    const allGroups     = await getAllGroups();
    const adminsCount   = adminIds.length;
    const bannedCount   = allUsers.filter(u => u.banned).length;
    const mutedCount    = allUsers.filter(u => u.muted).length;
    const activeToday   = allUsers.filter(u => u.last_seen > dayAgo).length;
    const verifiedCount = allUsers.filter(u => u.verified).length;

    const text =
`📈 *الإحصائيات المتقدمة*
━━━━━━━━━━━━━━━
👥 إجمالي المستخدمين: *${allUsers.length}*
✅ موثقين: *${verifiedCount}*
🟢 نشطين اليوم: *${activeToday}*
🚫 محظورين: *${bannedCount}*
🔇 مكتومين: *${mutedCount}*
👨‍💼 الأدمنية: *${adminsCount}*
━━━━━━━━━━━━━━━
💬 إجمالي الرسائل: *${totalMsgs}*
📨 رسائل اليوم: *${todayMsgs}*
━━━━━━━━━━━━━━━
🎫 إجمالي الطلبات: *${totalTickets}*
✅ مكتملة: *${completedT}*
⭐ متوسط التقييم: *${avgRating}/5*
━━━━━━━━━━━━━━━
💡 الاقتراحات: *${totalSugg}*
📱 القروبات: *${allGroups.length}*`;

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } };
    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {}
    }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  📜  سجل التذكرة
// ============================================================
async function showTicketLog(chatId, ticketId, editMsgId) {
    try {
        const tickets = await query(
            `SELECT t.*, u.name AS uname, u.username AS uuser, a.name AS aname, a.username AS auser
             FROM tickets t
             LEFT JOIN users u ON t.user_id = u.id
             LEFT JOIN users a ON t.claimed_by = a.id
             WHERE t.id=?`, [ticketId]
        );
        if (!tickets.length) { await bot.sendMessage(chatId, '❌ الطلب غير موجود.'); return; }
        const t      = tickets[0];
        const events = await query('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY ts ASC', [ticketId]);
        const uName  = t.uname || t.user_id;
        const aName  = t.aname || (t.claimed_by || 'غير محدد');
        const statusIcon = t.status === 'completed' ? '✅ مكتمل' : (t.status === 'archived' ? '📦 مؤرشف' : '🔒 جاري');
        let ratingStars = '';
        if (t.rating > 0) ratingStars = '⭐'.repeat(t.rating);

        let header = `💬 *سجل الطلب #${ticketId}*\n━━━━━━━━━━━━━━━\n`;
        header += `👤 العميل: ${uName}\n`;
        header += `👨‍💼 الأستاذ: ${aName}\n`;
        header += `📅 بدأ: ${formatTime(t.created_at)}\n`;
        header += `🔖 الحالة: ${statusIcon}\n`;
        if (ratingStars) header += `⭐ التقييم: ${ratingStars}\n`;
        header += `━━━━━━━━━━━━━━━\n\n`;

        let convo = '';
        if (!events.length) {
            convo = '📭 لا توجد أحداث مسجلة.';
        } else {
            for (const ev of events) {
                const timeStr  = formatTime(ev.ts);
                const roleIcon = ev.role === 'admin' ? '👨‍💼' : '👤';
                const roleName = ev.role === 'admin' ? aName.split(' ')[0] : uName.split(' ')[0];
                if (ev.event_type === 'message') {
                    convo += `${roleIcon} *${roleName}*\n┌─────────────────\n│ ${(ev.content||'').replace(/\n/g,'\n│ ')}\n└─ 🕒 ${timeStr}\n\n`;
                } else if (ev.event_type === 'claimed') {
                    convo += `🔒 ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
                } else if (ev.event_type === 'completed') {
                    convo += `✅ ─── ${ev.content} ─── 🕒 ${timeStr}\n\n`;
                } else if (ev.event_type === 'rated') {
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
        const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
        if (editMsgId) {
            try { await bot.editMessageText(fullText, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {}
        }
        await bot.sendMessage(chatId, fullText, opts);
    } catch(e) { await logError('showTicketLog', e); }
}

// ============================================================
//  🎫  عرض الطلبات المفتوحة
// ============================================================
async function showOpenTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset  = (page-1) * perPage;
    const tickets = await query(
        `SELECT t.*, u.name, u.username FROM tickets t
         LEFT JOIN users u ON t.user_id = u.id
         WHERE t.status='open' ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
        [perPage, offset]
    );
    const total      = ((await query("SELECT COUNT(*) as c FROM tickets WHERE status='open'"))[0]?.c) || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `🎫 *الطلبات المفتوحة* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (!tickets.length) {
        text += '📭 لا توجد طلبات مفتوحة.';
    } else {
        for (const t of tickets) {
            const uName  = t.name || t.user_id;
            const status = t.claimed_by ? '🔒 محجوز' : '🟢 مفتوح';
            text += `${status} | 👤 ${uName}\n🕒 ${formatTime(t.created_at)}\n\n`;
            const rowBtns = [{ text: `👤 ${uName}`, callback_data: 'user_' + t.user_id }];
            if (!t.claimed_by) {
                rowBtns.push({ text: '🙋 سأتكفل', callback_data: await saveCB('claim_' + t.user_id + '_' + t.id) });
            }
            btns.push(rowBtns);
        }
    }
    const navRow = [];
    if (page > 1)          navRow.push({ text: '⬅️', callback_data: 'tickets_open_' + (page-1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_open_' + (page+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  📋  عرض الطلبات المعلقة
// ============================================================
async function showClaimedTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset  = (page-1) * perPage;
    const tickets = await query(
        `SELECT t.*, u.name AS uname, a.name AS aname
         FROM tickets t
         LEFT JOIN users u ON t.user_id = u.id
         LEFT JOIN users a ON t.claimed_by = a.id
         WHERE t.claimed_by IS NOT NULL
         ORDER BY t.claimed_at DESC LIMIT ? OFFSET ?`,
        [perPage, offset]
    );
    const total      = ((await query("SELECT COUNT(*) as c FROM tickets WHERE claimed_by IS NOT NULL"))[0]?.c) || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `📋 *الطلبات المعلقة* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (!tickets.length) {
        text += '📭 لا توجد طلبات معلقة.';
    } else {
        for (const t of tickets) {
            const uName      = t.uname || t.user_id;
            const aName      = t.aname || t.claimed_by;
            const statusIcon = t.status === 'completed' ? '✅' : '🔒';
            text += `${statusIcon} طلب #${t.id}\n👤 ${uName}\n👨‍💼 ${aName}\n🕒 ${formatTime(t.claimed_at)}\n\n`;
            btns.push([{ text: `${statusIcon} #${t.id} - ${uName}`, callback_data: await saveCB('ticket_log_' + t.id) }]);
        }
    }
    const navRow = [];
    if (page > 1)          navRow.push({ text: '⬅️', callback_data: 'tickets_claimed_' + (page-1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_claimed_' + (page+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  💡  الاقتراحات
// ============================================================
async function showSuggestions(chatId, page, editMsgId) {
    const perPage = 5;
    const offset  = (page-1) * perPage;
    const suggestions = await query(
        `SELECT s.*, u.name, u.username FROM suggestions s
         LEFT JOIN users u ON s.user_id = u.id
         ORDER BY s.ts DESC LIMIT ? OFFSET ?`,
        [perPage, offset]
    );
    const total      = ((await query('SELECT COUNT(*) as c FROM suggestions'))[0]?.c) || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `💡 *الاقتراحات* (${total}) | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (!suggestions.length) {
        text += '📭 لا توجد اقتراحات.';
    } else {
        for (const sg of suggestions) {
            const sgUser = sg.name || sg.user_id;
            const isNew  = sg.status === 'new' ? '🔴 ' : '✅ ';
            text += `${isNew}👤 ${sgUser}\n💬 ${(sg.text||'').substring(0,100)}${sg.text&&sg.text.length>100?'...':''}\n🕒 ${formatTime(sg.ts)}\n\n`;
            if (sg.status === 'new') btns.push([{ text: `✅ قرأته #${sg.id}`, callback_data: 'sg_read_' + sg.id }]);
        }
    }
    const navRow = [];
    if (page > 1)          navRow.push({ text: '⬅️', callback_data: 'suggestions_' + (page-1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'suggestions_' + (page+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  👥  عرض المستخدمين
// ============================================================
async function showUsers(chatId, page, editMsgId) {
    const allUsers   = await getAllUsers();
    const perPage    = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    let pg = Math.max(1, Math.min(page, totalPages));
    const pageUsers  = allUsers.slice((pg-1)*perPage, pg*perPage);

    let text = `👥 *المستخدمين* (${allUsers.length}) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━`;
    const btns = [];
    for (const u of pageUsers) {
        let label = '';
        if (u.banned)             label += '🚫 ';
        if (u.muted)              label += '🔇 ';
        if (u.id === developerId) label += '👑 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        btns.push([{ text: label, callback_data: 'user_' + u.id }]);
    }
    const navRow = [];
    if (pg > 1)          navRow.push({ text: '⬅️', callback_data: 'users_' + (pg-1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: 'users_' + (pg+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  👤  ملف المستخدم التفصيلي
// ============================================================
async function showUserDetail(chatId, targetId, editMsgId) {
    const u = await getUser(targetId);
    if (!u) { await bot.sendMessage(chatId, '❌ المستخدم غير موجود.'); return; }

    const msgCount   = ((await query('SELECT COUNT(*) as c FROM msg_map WHERE user_id=?', [targetId]))[0]?.c) || 0;
    const todayMsgs  = ((await query('SELECT COUNT(*) as c FROM msg_map WHERE user_id=? AND ts>?', [targetId, Date.now()-86400000]))[0]?.c) || 0;
    const ticketCount= ((await query('SELECT COUNT(*) as c FROM tickets WHERE user_id=?', [targetId]))[0]?.c) || 0;
    const avgRatingR = await query('SELECT AVG(rating) as avg FROM tickets WHERE user_id=? AND rating>0', [targetId]);
    const avgRating  = avgRatingR[0]?.avg ? parseFloat(avgRatingR[0].avg).toFixed(1) : '—';
    const suggCount  = ((await query('SELECT COUNT(*) as c FROM suggestions WHERE user_id=?', [targetId]))[0]?.c) || 0;

    const isDev     = String(targetId) === developerId;
    const isViewDev = isDeveloper(chatId);

    let text = `👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n`;
    if (isDev) text += `👑 *مطور البوت*\n`;
    text += `📝 الاسم: ${u.name || '—'}\n`;
    text += `🔗 يوزر: ${u.username ? '@'+u.username : '—'}\n`;
    if (isViewDev) text += `🆔 ID: \`${u.id}\`\n`;
    if (isViewDev && u.phone) text += `📱 الهاتف: ${u.phone}\n`;
    text += `✅ موثق: ${u.verified ? 'نعم' : 'لا'}\n`;
    text += `━━━━━━━━━━━━━━━\n`;
    text += `📨 إجمالي الرسائل: ${msgCount}\n`;
    text += `📅 رسائل اليوم: ${todayMsgs}\n`;
    text += `🎫 إجمالي الطلبات: ${ticketCount}\n`;
    text += `⭐ متوسط التقييم: ${avgRating}/5\n`;
    text += `💡 الاقتراحات: ${suggCount}\n`;
    text += `🕒 آخر نشاط: ${formatTime(u.last_seen)}\n`;
    text += `📅 أول دخول: ${formatTime(u.first_seen)}\n`;
    text += `━━━━━━━━━━━━━━━\n`;
    text += `🚫 محظور: ${u.banned ? '✅ نعم' : '❌ لا'}\n`;
    text += `🔇 مكتوم: ${u.muted ? '✅ نعم' : '❌ لا'}`;

    const kb = [];
    if (!isDev) {
        kb.push([
            { text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + targetId },
            { text: u.muted  ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'do_' + (u.muted  ? 'unmute' : 'mute') + '_' + targetId }
        ]);
        if (isDeveloper(chatId)) {
            kb.push([{ text: '🗑️ حذف وحظر كامل', callback_data: 'destroy_user_' + targetId }]);
        }
    }
    kb.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    kb.push([{ text: '📜 عرض محادثاته', callback_data: 'user_msgs_' + targetId + '_1' }]);
    kb.push([{ text: '🔙 رجوع', callback_data: 'users_1' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  📜  محادثات المستخدم
// ============================================================
async function showUserConvo(chatId, targetId, page, editMsgId) {
    const u     = await getUser(targetId);
    const uName = u ? (u.name || 'مجهول') : targetId;
    const perPage = 10;
    const offset  = (page-1) * perPage;
    const msgs = await query(
        `SELECT te.*, t.id as ticket_id
         FROM ticket_events te
         LEFT JOIN tickets t ON te.ticket_id = t.id
         WHERE t.user_id=? AND te.event_type='message'
         ORDER BY te.ts DESC LIMIT ? OFFSET ?`,
        [targetId, perPage, offset]
    );
    const total      = ((await query(`SELECT COUNT(*) as c FROM ticket_events te LEFT JOIN tickets t ON te.ticket_id=t.id WHERE t.user_id=? AND te.event_type='message'`, [targetId]))[0]?.c) || 0;
    const totalPages = Math.ceil(total / perPage) || 1;

    let text = `📜 *محادثات: ${uName}*\n📊 ${total} رسالة | صفحة ${page}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    if (!msgs.length) {
        text += '📭 لا توجد رسائل.';
    } else {
        for (const m of msgs) {
            const roleIcon = m.role === 'admin' ? '👨‍💼' : '👤';
            const roleName = m.role === 'admin' ? 'الأستاذ' : uName;
            let msgContent = (m.content || '').substring(0, 150);
            if (m.content && m.content.length > 150) msgContent += '...';
            text += `${roleIcon} *${roleName}*\n┌─────────────────\n│ ${msgContent.replace(/\n/g,'\n│ ')}\n└─ 🕒 ${formatTime(m.ts)}\n\n`;
        }
    }
    const btns = [];
    const navRow = [];
    if (page > 1)          navRow.push({ text: '⬅️ أحدث', callback_data: 'user_msgs_' + targetId + '_' + (page-1) });
    navRow.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'user_msgs_' + targetId + '_' + (page+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    btns.push([{ text: '🔙 ملف المستخدم', callback_data: 'user_' + targetId }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  👨‍💼  لوحة إدارة الأدمنية
// ============================================================
async function showAdminPanel(chatId, editMsgId) {
    const admins = await getAdminList();
    let text = `👨‍💼 *إدارة الأدمنية*\n━━━━━━━━━━━━━━━\n👑 المطور: \`${developerId}\`\n`;
    const btns = [];
    if (admins.length > 0) {
        text += '\n📋 *الأدمنية:*\n';
        for (const a of admins) {
            const aName      = a.name || a.user_id;
            const username   = a.username ? ` @${a.username}` : '';
            const multiLabel = a.multi_reply ? ' 🔓' : '';
            text += `• ${aName}${username}${multiLabel} (\`${a.user_id}\`)\n`;
            btns.push([{ text: `❌ إزالة ${aName}`, callback_data: await saveCB('rm_admin_' + a.user_id) }]);
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

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

async function showEditPermissions(chatId, adminId, editMsgId) {
    const perms = await getAdminPermissions(adminId);
    const u     = await getUser(adminId);
    const permLabels = {
        canBan          : '🔨 الحظر',
        canMute         : '🔇 الكتم',
        canBroadcast    : '📢 الرسائل الجماعية',
        canViewStats    : '📈 عرض الإحصائيات',
        canManageTickets: '🎫 إدارة الطلبات',
        canManageGroups : '📱 إدارة القروبات',
        canReplyUsers   : '💬 الرد على المستخدمين'
    };
    let text = `⚙️ *صلاحيات: ${u ? getUserName(u) : adminId}*\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    for (const [key, label] of Object.entries(permLabels)) {
        const status = perms[key] ? '✅' : '❌';
        text += `${status} ${label}\n`;
        btns.push([{ text: (perms[key] ? '✅ ' : '❌ ') + label, callback_data: await saveCB('perm_toggle_' + adminId + '_' + key) }]);
    }
    btns.push([{ text: '🔙 رجوع', callback_data: 'admin_panel' }]);
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

// ============================================================
//  📱  إدارة القروبات
// ============================================================
async function showGroupsList(chatId, page, editMsgId) {
    const allGroups  = await getAllGroups();
    const perPage    = 8;
    const totalPages = Math.ceil(allGroups.length / perPage) || 1;
    let pg = Math.max(1, Math.min(page, totalPages));
    const pageGroups = allGroups.slice((pg-1)*perPage, pg*perPage);

    let text = `📱 *إدارة القروبات* (${allGroups.length}) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    if (!pageGroups.length) {
        text += '📭 لا توجد قروبات';
    } else {
        for (const g of pageGroups) {
            const members = await getGroupMembers(g.group_id);
            text += `• ${g.title}\n  👥 ${members.length} عضو\n\n`;
            btns.push([{ text: `📱 ${g.title} (${members.length})`, callback_data: await saveCB('group_detail_' + g.group_id) }]);
        }
    }
    const navRow = [];
    if (pg > 1)          navRow.push({ text: '⬅️', callback_data: 'groups_list_' + (pg-1) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: 'groups_list_' + (pg+1) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

async function showGroupDetail(chatId, groupId, editMsgId) {
    const group = (await query("SELECT * FROM \`groups\` WHERE group_id=?", [groupId]))[0];
    if (!group) { await bot.sendMessage(chatId, '❌ القروب غير موجود'); return; }
    const members = await getGroupMembers(groupId);
    const admins  = members.filter(m => m.is_admin);
    const bots    = members.filter(m => m.is_bot);
    const banned  = members.filter(m => m.banned);
    const muted   = members.filter(m => m.muted);

    const text = `📱 *تفاصيل القروب*\n━━━━━━━━━━━━━━━\n📝 الاسم: ${group.title}\n🔗 اليوزر: ${group.username ? '@'+group.username : '—'}\n🆔 ID: \`${group.group_id}\`\n━━━━━━━━━━━━━━━\n👥 الأعضاء: ${members.length}\n👨‍💼 الأدمنية: ${admins.length}\n🤖 البوتات: ${bots.length}\n🚫 المحظورين: ${banned.length}\n🔇 المكتومين: ${muted.length}\n━━━━━━━━━━━━━━━\n📅 أُضيف: ${formatTime(group.added_at)}`;
    const btns = [
        [{ text: '👥 عرض الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }],
        [{ text: '🔙 القروبات', callback_data: 'groups_list_1' }]
    ];
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

async function showGroupMembers(chatId, groupId, page, editMsgId) {
    const group   = (await query("SELECT * FROM \`groups\` WHERE group_id=?", [groupId]))[0];
    const members = await getGroupMembers(groupId);
    const perPage = 8;
    const totalPages = Math.ceil(members.length / perPage) || 1;
    let pg = Math.max(1, Math.min(page, totalPages));
    const pageMembers = members.slice((pg-1)*perPage, pg*perPage);

    let text = `👥 *أعضاء: ${group?.title || groupId}*\n(${members.length} عضو) | صفحة ${pg}/${totalPages}\n━━━━━━━━━━━━━━━\n\n`;
    const btns = [];
    for (const m of pageMembers) {
        let label = '';
        if (m.is_owner)   label += '👑 ';
        else if (m.is_admin) label += '👨‍💼 ';
        if (m.is_bot)     label += '🤖 ';
        if (m.banned)     label += '🚫 ';
        if (m.muted)      label += '🔇 ';
        if (m.warnings>0) label += `⚠️${m.warnings} `;
        label += (m.name || 'بدون اسم');
        if (m.username) label += ` @${m.username}`;
        btns.push([{ text: label, callback_data: await saveCB('gmember_' + groupId + '_u_' + m.user_id) }]);
    }
    const navRow = [];
    if (pg > 1)          navRow.push({ text: '⬅️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (pg-1)) });
    navRow.push({ text: `${pg}/${totalPages}`, callback_data: 'noop' });
    if (pg < totalPages) navRow.push({ text: '➡️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (pg+1)) });
    if (navRow.length > 1) btns.push(navRow);
    btns.push([{ text: '🔙 تفاصيل القروب', callback_data: await saveCB('group_detail_' + groupId) }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

async function showMemberActions(chatId, groupId, memberId, editMsgId) {
    const member = (await query('SELECT * FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]))[0];
    if (!member) { await bot.sendMessage(chatId, '❌ العضو غير موجود'); return; }
    const group = (await query("SELECT * FROM \`groups\` WHERE group_id=?", [groupId]))[0];

    const text = `👤 *إدارة العضو*\n━━━━━━━━━━━━━━━\n📝 الاسم: ${member.name||'بدون اسم'}\n🔗 اليوزر: ${member.username?'@'+member.username:'—'}\n🆔 ID: \`${member.user_id}\`\n${member.phone?`📱 الهاتف: ${member.phone}\n`:''}\n━━━━━━━━━━━━━━━\n📱 القروب: ${group?.title||groupId}\n👨‍💼 أدمن: ${member.is_admin?'✅':'❌'}\n🤖 بوت: ${member.is_bot?'✅':'❌'}\n⚠️ الإنذارات: ${member.warnings||0}\n🚫 محظور: ${member.banned?'✅':'❌'}\n🔇 مكتوم: ${member.muted?'✅':'❌'}\n🕒 آخر نشاط: ${formatTime(member.last_seen)}`;

    const btns = [];
    if (!member.is_owner && !member.is_bot) {
        btns.push([
            { text: '⚠️ إنذار', callback_data: await saveCB('gaction_warn_' + groupId + '_' + memberId) },
            { text: member.is_admin ? '➖ إزالة أدمن' : '➕ ترقية', callback_data: await saveCB('gaction_' + (member.is_admin?'demote':'promote') + '_' + groupId + '_' + memberId) }
        ]);
        btns.push([
            { text: member.banned ? '🔓 رفع الحظر' : '🚫 حظر', callback_data: await saveCB('gaction_' + (member.banned?'unban':'ban') + '_' + groupId + '_' + memberId) },
            { text: member.muted  ? '🔊 رفع الكتم' : '🔇 كتم',  callback_data: await saveCB('gaction_' + (member.muted?'unmute':'mute') + '_' + groupId + '_' + memberId) }
        ]);
        btns.push([{ text: '👢 طرد', callback_data: await saveCB('gaction_kick_' + groupId + '_' + memberId) }]);
    }
    btns.push([{ text: '🔙 الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }]);

    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } };
    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
    await bot.sendMessage(chatId, text, opts);
}

async function executeGroupAction(chatId, action, groupId, memberId, editMsgId) {
    try {
        let result = '';
        if (action === 'warn') {
            await query('UPDATE group_members SET warnings=warnings+1 WHERE group_id=? AND user_id=?', [groupId, memberId]);
            const m = (await query('SELECT warnings FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]))[0];
            result = `⚠️ تم إنذار العضو. إجمالي الإنذارات: ${m?.warnings || 1}`;
        } else if (action === 'ban') {
            await setGroupMemberField(groupId, memberId, 'banned', 1);
            try { await bot.banChatMember(groupId, memberId); } catch(e) {}
            result = '🚫 تم حظر العضو من القروب.';
        } else if (action === 'unban') {
            await setGroupMemberField(groupId, memberId, 'banned', 0);
            try { await bot.unbanChatMember(groupId, memberId); } catch(e) {}
            result = '🔓 تم رفع الحظر عن العضو.';
        } else if (action === 'mute') {
            await setGroupMemberField(groupId, memberId, 'muted', 1);
            try { await bot.restrictChatMember(groupId, memberId, { permissions: { can_send_messages: false } }); } catch(e) {}
            result = '🔇 تم كتم العضو.';
        } else if (action === 'unmute') {
            await setGroupMemberField(groupId, memberId, 'muted', 0);
            try { await bot.restrictChatMember(groupId, memberId, { permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true } }); } catch(e) {}
            result = '🔊 تم رفع الكتم عن العضو.';
        } else if (action === 'kick') {
            try { await bot.banChatMember(groupId, memberId); await sleep(500); await bot.unbanChatMember(groupId, memberId); } catch(e) {}
            await query('DELETE FROM group_members WHERE group_id=? AND user_id=?', [groupId, memberId]);
            result = '👢 تم طرد العضو.';
        } else if (action === 'promote') {
            await setGroupMemberField(groupId, memberId, 'is_admin', 1);
            try { await bot.promoteChatMember(groupId, memberId, { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }); } catch(e) {}
            result = '➕ تم ترقية العضو لأدمن.';
        } else if (action === 'demote') {
            await setGroupMemberField(groupId, memberId, 'is_admin', 0);
            try { await bot.promoteChatMember(groupId, memberId, { can_manage_chat: false, can_delete_messages: false, can_restrict_members: false }); } catch(e) {}
            result = '➖ تم إزالة صلاحيات الأدمن.';
        }

        const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع للأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }]] } };
        if (editMsgId) { try { await bot.editMessageText(result, { chat_id: chatId, message_id: editMsgId, ...opts }); return; } catch(e) {} }
        await bot.sendMessage(chatId, result, opts);
    } catch(e) { await logError('executeGroupAction', e); }
}

// ============================================================
//  📣  إشعار التحديث
// ============================================================
async function showPendingUpdate(chatId, role) {
    try {
        const updates = await query("SELECT * FROM bot_updates WHERE sent=0 ORDER BY created_at DESC LIMIT 1");
        if (!updates.length) return;
        const upd     = updates[0];
        const msgText = role === 'admin' ? upd.msg_admins : upd.msg_users;
        if (!msgText) return;
        await bot.sendMessage(chatId, `🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n${msgText}`, { parse_mode: 'Markdown' });
    } catch(e) {}
}

// ============================================================
//  📤  تصدير المستخدمين CSV
// ============================================================
async function exportUsersCSV(chatId) {
    try {
        const users = await getAllUsers();
        let csv = 'ID,الاسم,اليوزر,الهاتف,موثق,محظور,مكتوم,عدد الرسائل,أول دخول,آخر نشاط\n';
        for (const u of users) {
            csv += `"${u.id}","${(u.name||'').replace(/"/g,'""')}","${u.username||''}","${u.phone||''}","${u.verified?'نعم':'لا'}","${u.banned?'نعم':'لا'}","${u.muted?'نعم':'لا'}","${u.messages_count||0}","${formatTime(u.first_seen)}","${formatTime(u.last_seen)}"\n`;
        }
        const fs   = require('fs');
        const path = '/tmp/users_export.csv';
        fs.writeFileSync(path, '\uFEFF' + csv, 'utf8'); // BOM for Excel
        await bot.sendDocument(chatId, path, {}, { filename: `users_${Date.now()}.csv`, contentType: 'text/csv' });
        fs.unlinkSync(path);
    } catch(e) { await logError('exportUsersCSV', e); await bot.sendMessage(chatId, '❌ فشل التصدير: ' + e.message); }
}

// ============================================================
//  🗑️  أرشفة التذاكر القديمة
// ============================================================
async function archiveOldTickets(chatId) {
    try {
        const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 يوم
        const res = await query(
            "UPDATE tickets SET status='archived' WHERE status='open' AND created_at < ? AND claimed_by IS NULL",
            [cutoff]
        );
        const count = res.affectedRows || 0;
        await bot.sendMessage(chatId, `✅ تم أرشفة *${count}* تذكرة قديمة (أكثر من 30 يوم بدون رد).`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
    } catch(e) { await logError('archiveOldTickets', e); }
}

// ============================================================
//  ⏰  نظام التذكير التلقائي
// ============================================================
function startReminderJob() {
    setInterval(async () => {
        try {
            const cutoff = Date.now() - REMIND_AFTER;
            const tickets = await query(
                "SELECT t.*, u.name FROM tickets t LEFT JOIN users u ON t.user_id=u.id WHERE t.status='open' AND t.claimed_by IS NULL AND t.created_at < ? AND t.reminded=0",
                [cutoff]
            );
            for (const t of tickets) {
                const uName = t.name || t.user_id;
                const msg   = `⏰ *تذكير!*\n\nطلب من *${uName}* لم يُرد عليه منذ أكثر من ${Math.round(REMIND_AFTER/60000)} دقيقة.\n🎫 طلب #${t.id}\n🕒 بدأ: ${formatTime(t.created_at)}`;
                const btns  = { inline_keyboard: [[{ text: '🙋 سأتكفل', callback_data: await saveCB('claim_' + t.user_id + '_' + t.id) }]] };
                // إرسال تذكير لجميع الأدمنية
                for (const aId of adminIds) {
                    try { await bot.sendMessage(aId, msg, { parse_mode: 'Markdown', reply_markup: btns }); } catch(e) {}
                }
                await query('UPDATE tickets SET reminded=1 WHERE id=?', [t.id]);
            }
        } catch(e) { await logError('reminderJob', e); }
    }, 5 * 60 * 1000); // كل 5 دقائق
}

// ============================================================
//  🤖  تشغيل البوت الرئيسي
// ============================================================
async function startBot() {
    await createPool();

    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('✅ البوت يعمل...');

    startReminderJob();

    // ──────────────────────────────────────────────
    //  📌  الأوامر
    // ──────────────────────────────────────────────
    bot.onText(/\/start/, async (msg) => {
        const chatId   = msg.chat.id;
        const userId   = String(msg.from.id);
        const userName = msg.from.username || '';
        const fullName = ((msg.from.first_name||'') + ' ' + (msg.from.last_name||'')).trim();

        await updateUser(userId, userName, fullName);

        if (isAdminUser(userId)) {
            await query('UPDATE admins SET last_login=? WHERE user_id=?', [Date.now(), userId]);
            await showPendingUpdate(chatId, 'admin');
            await sendMainMenu(chatId);
        } else {
            await showPendingUpdate(chatId, 'user');
            await bot.sendMessage(chatId,
                `👋 *أهلاً ${fullName || 'بك'}!*\n━━━━━━━━━━━━━━━\n\n🎓 مرحباً بك في بوت الدعم.\n\n📩 أرسل رسالتك مباشرةً وسيصلك الرد في أقرب وقت.\n\n💡 يمكنك أيضاً إرسال اقتراحاتك لتطوير الخدمة.`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💡 إرسال اقتراح', callback_data: 'suggest' }]] } }
            );
        }
    });

    bot.onText(/\/help/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        if (isAdminUser(userId)) {
            await bot.sendMessage(chatId,
                `📖 *دليل الأدمن*\n━━━━━━━━━━━━━━━\n/start - لوحة التحكم\n/help - هذه الرسالة\n/status - حالة البوت\n/myid - معرفك\n\n💡 يمكنك الرد على رسائل المستخدمين مباشرة بالضغط على زر الرد أو بالرد على الرسالة المُعادة.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await bot.sendMessage(chatId,
                `📖 *المساعدة*\n━━━━━━━━━━━━━━━\n• أرسل رسالتك مباشرةً للتواصل مع الأستاذ\n• يمكنك إرسال نصوص، صور، فيديو، ملفات، وصوت\n• /myid - معرفك\n• /status - حالة البوت`,
                { parse_mode: 'Markdown' }
            );
        }
    });

    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;
        const uptime = process.uptime();
        const hours  = Math.floor(uptime / 3600);
        const mins   = Math.floor((uptime % 3600) / 60);
        await bot.sendMessage(chatId,
            `✅ *البوت يعمل بشكل طبيعي*\n⏱️ وقت التشغيل: ${hours}h ${mins}m\n🕒 الوقت الحالي: ${formatTime(Date.now())}`,
            { parse_mode: 'Markdown' }
        );
    });

    bot.onText(/\/myid/, async (msg) => {
        await bot.sendMessage(msg.chat.id, `🆔 معرفك: \`${msg.from.id}\``, { parse_mode: 'Markdown' });
    });

    // ──────────────────────────────────────────────
    //  🖱️  معالجة الأزرار (callback_query)
    // ──────────────────────────────────────────────
    bot.on('callback_query', async (cbq) => {
        const chatId = cbq.message.chat.id;
        const msgId  = cbq.message.message_id;
        const userId = String(cbq.from.id);
        let data     = cbq.data || '';

        try {
            await bot.answerCallbackQuery(cbq.id).catch(() => {});

            // فك ضغط البيانات
            if (data.startsWith('c_')) {
                data = await getCB(data);
                if (!data) { await bot.sendMessage(chatId, '❌ انتهت صلاحية هذا الزر.'); return; }
            }

            if (!isAdminUser(userId)) {
                // ── أزرار المستخدمين العاديين ──
                if (data === 'suggest') {
                    devState[chatId] = { action: 'suggest' };
                    await bot.sendMessage(chatId, '💡 *إرسال اقتراح*\n\n✏️ اكتب اقتراحك:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_suggest' }]] } });
                    return;
                }
                if (data === 'cancel_suggest') {
                    devState[chatId] = {};
                    await bot.sendMessage(chatId, '❌ تم الإلغاء.');
                    return;
                }
                // تقييم التذكرة
                if (data.startsWith('rate_')) {
                    const parts    = data.replace('rate_', '').split('_');
                    const ticketId = parseInt(parts[0]);
                    const rating   = parseInt(parts[1]);
                    if (ticketId && rating >= 1 && rating <= 5) {
                        await rateTicket(ticketId, rating);
                        await saveTicketEvent(ticketId, userId, 'user', 'rated', `تقييم: ${'⭐'.repeat(rating)}`);
                        try {
                            await bot.editMessageText(
                                `✅ شكراً على تقييمك!\n⭐ تقييمك: ${'⭐'.repeat(rating)}`,
                                { chat_id: chatId, message_id: msgId }
                            );
                        } catch(e) {}
                    }
                    return;
                }
                return;
            }

            // ── أزرار الأدمنية ──

            if (data === 'noop') return;
            if (data === 'main') { await sendMainMenu(chatId, msgId); return; }

            // إحصائيات
            if (data === 'stats') {
                const perms = await getAdminPermissions(userId);
                if (!perms.canViewStats && !isDeveloper(userId)) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ ليس لديك صلاحية.', show_alert: true }).catch(() => {});
                    return;
                }
                await showStats(chatId, msgId);
                return;
            }

            // بحث عن مستخدم
            if (data === 'search_user') {
                devState[chatId] = { action: 'search_user' };
                try {
                    await bot.editMessageText('🔍 *بحث عن مستخدم*\n\n✏️ أرسل الاسم أو ID أو رقم الهاتف:', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // تصدير المستخدمين
            if (data === 'export_users') {
                if (!isDeveloper(userId)) return;
                await bot.sendMessage(chatId, '⏳ جاري تصدير البيانات...');
                await exportUsersCSV(chatId);
                return;
            }

            // أرشفة التذاكر القديمة
            if (data === 'archive_old_tickets') {
                if (!isDeveloper(userId)) return;
                await archiveOldTickets(chatId);
                return;
            }

            // الطلبات المفتوحة
            if (data.startsWith('tickets_open_')) {
                await showOpenTickets(chatId, parseInt(data.replace('tickets_open_', '')) || 1, msgId);
                return;
            }

            // الطلبات المعلقة
            if (data.startsWith('tickets_claimed_')) {
                await showClaimedTickets(chatId, parseInt(data.replace('tickets_claimed_', '')) || 1, msgId);
                return;
            }

            // سجل التذكرة
            if (data.startsWith('ticket_log_')) {
                await showTicketLog(chatId, parseInt(data.replace('ticket_log_', '')), msgId);
                return;
            }

            // إغلاق التذكرة
            if (data.startsWith('close_ticket_')) {
                const parts    = data.replace('close_ticket_', '').split('_');
                const targetId = parts[0];
                const ticketId = parseInt(parts[1]);
                await completeTicket(ticketId);
                await saveTicketEvent(ticketId, userId, 'admin', 'completed', `أُغلق الطلب بواسطة الأستاذ`);
                // إرسال رسالة تقييم للمستخدم
                const ratingBtns = { inline_keyboard: [[
                    { text: '⭐', callback_data: `rate_${ticketId}_1` },
                    { text: '⭐⭐', callback_data: `rate_${ticketId}_2` },
                    { text: '⭐⭐⭐', callback_data: `rate_${ticketId}_3` },
                    { text: '⭐⭐⭐⭐', callback_data: `rate_${ticketId}_4` },
                    { text: '⭐⭐⭐⭐⭐', callback_data: `rate_${ticketId}_5` }
                ]] };
                try { await bot.sendMessage(targetId, '✅ *تم إنهاء محادثتك مع الأستاذ.*\n\n⭐ كيف تقيّم الخدمة؟', { parse_mode: 'Markdown', reply_markup: ratingBtns }); } catch(e) {}
                try {
                    await bot.editMessageText(`✅ تم إغلاق الطلب #${ticketId}`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                } catch(e) {}
                return;
            }

            // تكفل بطلب
            if (data.startsWith('claim_')) {
                const parts    = data.replace('claim_', '').split('_');
                const targetId = parts[0];
                const ticketId = parseInt(parts[1]);
                const ticket   = await claimTicket(ticketId, userId);
                if (!ticket) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⚠️ هذا الطلب محجوز بالفعل.', show_alert: true }).catch(() => {});
                    return;
                }
                await saveTicketEvent(ticketId, userId, 'admin', 'claimed', `تكفّل الأستاذ بالطلب`);
                const adminUser = await getUser(userId);
                try { await bot.sendMessage(targetId, `🔒 *تكفّل الأستاذ بطلبك!*\n\n👨‍💼 ${getUserName(adminUser)} يراجع طلبك الآن.\n⏳ انتظر الرد قريباً.`, { parse_mode: 'Markdown' }); } catch(e) {}
                try {
                    await bot.editMessageText(`✅ تكفلت بطلب المستخدم \`${targetId}\``, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '💬 رد', callback_data: 'do_reply_' + targetId }],
                            [{ text: '✅ إغلاق الطلب', callback_data: await saveCB('close_ticket_' + targetId + '_' + ticketId) }],
                            [{ text: '🔙 رجوع', callback_data: 'main' }]
                        ]}
                    });
                } catch(e) {}
                return;
            }

            // رد سريع qr_
            if (data.startsWith('qr_')) {
                const targetId = data.replace('qr_', '');
                const canReply = await canAdminReply(userId, targetId);
                if (!canReply) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ هذا الطلب محجوز من أدمن آخر.', show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId };
                const u = await getUser(targetId);
                try {
                    await bot.editMessageText(`💬 *مراسلة: ${u ? getUserName(u) : targetId}*\n\n✏️ اكتب ردك (نص، صورة، فيديو، ملف، صوت):`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // عرض المستخدمين
            if (data.startsWith('users_')) {
                await showUsers(chatId, parseInt(data.replace('users_', '')) || 1, msgId);
                return;
            }
            if (data.startsWith('user_') && !data.startsWith('user_msgs_')) {
                await showUserDetail(chatId, data.replace('user_', ''), msgId);
                return;
            }
            if (data.match(/^user_msgs_\d+_\d+$/)) {
                const parts = data.replace('user_msgs_', '').split('_');
                await showUserConvo(chatId, parts[0], parseInt(parts[1]) || 1, msgId);
                return;
            }

            // الاقتراحات
            if (data.startsWith('suggestions_')) {
                await showSuggestions(chatId, parseInt(data.replace('suggestions_', '')) || 1, msgId);
                return;
            }
            if (data.startsWith('sg_read_')) {
                await query("UPDATE suggestions SET status='read' WHERE id=?", [parseInt(data.replace('sg_read_', ''))]);
                await showSuggestions(chatId, 1, msgId);
                return;
            }

            // رسالة جماعية
            if (data === 'broadcast') {
                const perms = await getAdminPermissions(userId);
                if (!perms.canBroadcast) {
                    await bot.answerCallbackQuery(cbq.id, { text: '⛔ ليس لديك صلاحية.', show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'broadcast' };
                const activeCount = (await getAllUsers()).filter(u => !u.banned).length;
                try {
                    await bot.editMessageText(`📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ${activeCount} مستخدم:`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // إشعار تحديث
            if (data === 'send_update') {
                if (!isDeveloper(userId)) return;
                devState[chatId] = { action: 'send_update_users' };
                try {
                    await bot.editMessageText('📣 *إرسال إشعار تحديث*\n\nالخطوة 1/2: اكتب رسالة التحديث للمستخدمين:\n(أو أرسل "-" لتخطي)', {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // اختيار مستخدم للإجراء
            if (data.match(/^pick_(ban|unban|mute|unmute|reply)_\d+$/)) {
                const parts  = data.split('_');
                const action = parts[1];
                const page   = parseInt(parts[2]) || 1;
                const filters = {
                    ban   : u => !u.banned && u.id !== developerId,
                    unban : u => u.banned && u.id !== developerId,
                    mute  : u => !u.muted && u.id !== developerId,
                    unmute: u => u.muted && u.id !== developerId,
                    reply : u => u.id !== developerId
                };
                const titles = {
                    ban   : '🔨 اختر مستخدم للحظر:',
                    unban : '🔓 اختر مستخدم لرفع الحظر:',
                    mute  : '🔇 اختر مستخدم للكتم:',
                    unmute: '🔊 اختر مستخدم لرفع الكتم:',
                    reply : '💬 اختر مستخدم للمراسلة:'
                };
                const res = await buildUserBtns('do_' + action, page, filters[action], 'pick_' + action);
                let text  = titles[action] || 'اختر:';
                if (res.total === 0) text += '\n\n⚠️ لا يوجد مستخدمين.';
                try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: res.buttons } }); } catch(e) {}
                return;
            }

            // تنفيذ إجراء (حظر/كتم)
            if (data.match(/^do_(ban|unban|mute|unmute)_\d+$/)) {
                const parts    = data.replace('do_', '').split('_');
                const action   = parts[0];
                const targetId = parts[1];
                if (String(targetId) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch(e) {}
                    return;
                }
                const u       = await getUser(targetId);
                const actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم' };
                const text    = `*${actNames[action]}*\n\n👤 ${u ? getUserName(u) : targetId}\n🆔 \`${targetId}\`\n\nهل أنت متأكد؟`;
                try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ تأكيد', callback_data: 'cf_' + action + '_' + targetId }], [{ text: '❌ إلغاء', callback_data: 'main' }]] } }); } catch(e) {}
                return;
            }

            // مراسلة مستخدم
            if (data.startsWith('do_reply_')) {
                const targetId = data.replace('do_reply_', '');
                const canReply = await canAdminReply(userId, targetId);
                if (!canReply) {
                    const ticket  = await getOpenTicket(targetId);
                    const claimer = ticket ? await getUser(ticket.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id, { text: `⛔ هذا الطلب محجوز من: ${claimer ? getUserName(claimer) : 'أدمن آخر'}`, show_alert: true }).catch(() => {});
                    return;
                }
                devState[chatId] = { action: 'reply', targetId };
                const u = await getUser(targetId);
                try {
                    await bot.editMessageText(`💬 *مراسلة: ${u ? getUserName(u) : targetId}*\n\n✏️ اكتب ردك:`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // تأكيد الإجراء
            if (data.startsWith('cf_')) {
                const parts    = data.replace('cf_', '').split('_');
                const action   = parts[0];
                const targetId = parts[1];
                if (String(targetId) === developerId) {
                    try { await bot.editMessageText('⛔ لا يمكن تطبيق أي إجراء على المطور.', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch(e) {}
                    return;
                }
                let result = '';
                if (action === 'ban')    { await setUserField(targetId, 'banned', 1); result = `✅ تم حظر \`${targetId}\``; try { await bot.sendMessage(targetId, '⛔ تم حظرك من البوت.'); } catch(e) {} }
                else if (action === 'unban')  { await setUserField(targetId, 'banned', 0); result = `✅ تم رفع الحظر عن \`${targetId}\``; try { await bot.sendMessage(targetId, '✅ تم رفع الحظر عنك.'); } catch(e) {} }
                else if (action === 'mute')   { await setUserField(targetId, 'muted', 1);  result = `✅ تم كتم \`${targetId}\``; }
                else if (action === 'unmute') { await setUserField(targetId, 'muted', 0);  result = `✅ تم رفع الكتم عن \`${targetId}\``; }
                try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } }); } catch(e) {}
                return;
            }

            // حذف وحظر كامل
            if (data.startsWith('destroy_user_')) {
                if (!isDeveloper(userId)) return;
                const destroyId = data.replace('destroy_user_', '');
                try {
                    await bot.editMessageText(`⚠️ *تأكيد الحذف الكامل*\n\n🆔 المستخدم: \`${destroyId}\`\n\nسيتم:\n• 🚫 حظر المستخدم نهائياً\n• 🗑️ حذف جميع بياناته\n• 📤 إرسال رسالة إنهاء له\n\nهل أنت متأكد؟`, {
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
                await query('DELETE FROM ticket_events WHERE user_id=?', [cdId]);
                await query('DELETE FROM suggestions WHERE user_id=?', [cdId]);
                const cdUser = await getUser(cdId);
                try {
                    await bot.editMessageText(`✅ *تم تنفيذ الإجراء*\n\n👤 ${cdUser ? getUserName(cdUser) : cdId}\n🚫 تم الحظر وحذف جميع البيانات.`, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] }
                    });
                } catch(e) {}
                return;
            }

            // إدارة الأدمنية
            if (data === 'admin_panel') {
                if (!isDeveloper(userId)) return;
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
                const res  = await buildUserBtns('add_admin_from', page, u => u.id !== developerId && !isAdminUser(u.id), 'pick_add_admin');
                try { await bot.editMessageText('👨‍💼 اختر مستخدم لإضافته كأدمن:', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: res.buttons } }); } catch(e) {}
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
                if (!isDeveloper(userId)) return;
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
                const tmId  = data.replace('toggle_multi_', '');
                const rows  = await query('SELECT multi_reply FROM admins WHERE user_id=?', [tmId]);
                const curVal = rows.length ? rows[0].multi_reply : 0;
                const newVal = curVal ? 0 : 1;
                await query('UPDATE admins SET multi_reply=? WHERE user_id=?', [newVal, tmId]);
                const tmUser = await getUser(tmId);
                await bot.sendMessage(chatId, `${newVal ? '✅ تم منح' : '❌ تم سحب'} صلاحية الرد على أكثر من مستخدم من *${getUserName(tmUser)}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } });
                return;
            }
            if (data.startsWith('edit_perms_')) {
                if (!isDeveloper(userId)) return;
                await showEditPermissions(chatId, data.replace('edit_perms_', ''), msgId);
                return;
            }
            if (data.startsWith('perm_toggle_')) {
                if (!isDeveloper(userId)) return;
                const parts   = data.replace('perm_toggle_', '').split('_');
                const adminId = parts[0];
                const permKey = parts.slice(1).join('_');
                const perms   = await getAdminPermissions(adminId);
                perms[permKey] = !perms[permKey];
                await updateAdminPermissions(adminId, perms);
                await showEditPermissions(chatId, adminId, msgId);
                return;
            }

            // إدارة القروبات
            if (data.startsWith('groups_list_')) { await showGroupsList(chatId, parseInt(data.replace('groups_list_', '')) || 1, msgId); return; }
            if (data.startsWith('group_detail_')) { await showGroupDetail(chatId, data.replace('group_detail_', ''), msgId); return; }
            if (data.startsWith('group_members_')) {
                const parts   = data.replace('group_members_', '').split('_p_');
                await showGroupMembers(chatId, parts[0], parseInt(parts[1]) || 1, msgId);
                return;
            }
            if (data.startsWith('gmember_')) {
                const parts = data.replace('gmember_', '').split('_u_');
                await showMemberActions(chatId, parts[0], parts[1], msgId);
                return;
            }
            if (data.startsWith('gaction_')) {
                const parts  = data.replace('gaction_', '').split('_');
                const action = parts[0];
                const gId    = parts[1];
                const mId    = parts[2];
                await executeGroupAction(chatId, action, gId, mId, msgId);
                return;
            }

        } catch(err) {
            await logError('callback_query', err);
        }
    });

    // ──────────────────────────────────────────────
    //  💬  معالجة الرسائل
    // ──────────────────────────────────────────────
    bot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return; // الأوامر تُعالج بـ onText

        const chatId   = msg.chat.id;
        const userId   = String(msg.from.id);
        const userName = msg.from.username || '';
        const fullName = ((msg.from.first_name||'') + ' ' + (msg.from.last_name||'')).trim();

        // ── رسائل القروبات ──
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
            try {
                const chatMember = await bot.getChatMember(chatId, userId);
                const isAdmin    = ['creator', 'administrator'].includes(chatMember.status);
                const isOwner    = chatMember.status === 'creator';
                await updateGroupMember(chatId, userId, userName, fullName, '', isAdmin, msg.from.is_bot, isOwner);
                if (msg.text) await saveGroupMessage(chatId, userId, msg.message_id, msg.text);
            } catch(e) {}
            return;
        }

        if (msg.chat.type !== 'private') return;

        // ── التحقق بجهة الاتصال ──
        if (msg.contact) {
            if (String(msg.contact.user_id) !== userId) {
                await bot.sendMessage(chatId, '⚠️ يرجى إرسال جهة اتصالك الخاصة بك فقط!');
                return;
            }
            await query('UPDATE users SET phone=?, verified=1 WHERE id=?', [msg.contact.phone_number, userId]);
            await query("UPDATE tickets SET user_locked=0 WHERE user_id=? AND status='open'", [userId]);
            await bot.sendMessage(chatId, '✅ *تم التحقق من هويتك بنجاح!*\n\nيمكنك الآن متابعة طلبك وإرسال رسائلك.', { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
            await bot.sendMessage(developerId, `🆕 *تحقق جديد*\n━━━━━━━━━━━━━━━\n👤 ${fullName}\n🆔 \`${userId}\`\n📞 \`${msg.contact.phone_number}\`\n🔗 ${userName ? '@'+userName : '—'}`, { parse_mode: 'Markdown' });
            return;
        }

        // ── رسائل الأدمنية ──
        if (isAdminUser(userId)) {
            await handleAdminMsg(chatId, userId, msg);
            return;
        }

        // ── رسائل المستخدمين العاديين ──
        await updateUser(userId, userName, fullName);
        const user = await getUser(userId);

        if (user?.banned) { await bot.sendMessage(chatId, '⛔ أنت محظور من البوت.'); return; }
        if (user?.muted)  { await bot.sendMessage(chatId, '🔇 أنت مكتوم ولا يمكنك إرسال رسائل.'); return; }

        // حماية من السبام
        if (isSpam(userId)) {
            await bot.sendMessage(chatId, '⚠️ أرسلت رسائل كثيرة جداً. انتظر قليلاً.');
            return;
        }

        // التحقق من الهوية
        const userOpenTicket = await getOpenTicket(userId);
        if (userOpenTicket && userOpenTicket.user_locked === 1 && !user?.verified) {
            await bot.sendMessage(chatId,
                '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة، يرجى مشاركة جهة اتصالك.',
                { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
            );
            return;
        }

        if (user && !user.verified && (!userOpenTicket || userOpenTicket.admin_reply_count === 0)) {
            await bot.sendMessage(chatId,
                '⚠️ *يجب التحقق من هويتك أولاً*\n━━━━━━━━━━━━━━━\nلضمان جودة الخدمة، يرجى مشاركة جهة اتصالك.',
                { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ اضغط هنا للتحقق 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
            );
            return;
        }

        // حالة الاقتراح
        const state = devState[chatId] || {};
        if (state.action === 'suggest') {
            devState[chatId] = {};
            const suggText = msg.text || '[محتوى غير نصي]';
            await query('INSERT INTO suggestions (user_id, text, ts, status) VALUES (?,?,?,?)', [userId, suggText, Date.now(), 'new']);
            const sgUser = await getUser(userId);
            await bot.sendMessage(developerId,
                `💡 *اقتراح جديد!*\n━━━━━━━━━━━━━━━\n👤 ${getUserName(sgUser)}\n🆔 \`${userId}\`\n\n📝 ${suggText}\n\n🕒 ${formatTime(Date.now())}`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 رد عليه', callback_data: 'qr_' + userId }]] } }
            );
            await bot.sendMessage(chatId, '✅ *شكراً على اقتراحك!*\n\n💡 تم إرسال اقتراحك للمطور وسيتم مراجعته. 🙏', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح آخر', callback_data: 'suggest' }]] } });
            return;
        }

        // إنشاء تذكرة جديدة وإرسال الرسالة
        const ticketId = await createTicket(userId);
        if (ticketId) {
            const msgContent = getMsgContent(msg);
            await saveTicketEvent(ticketId, userId, 'user', 'message', msgContent);
        }

        const quickBtns = { inline_keyboard: [
            [
                { text: '↩️ رد',       callback_data: await saveCB('qr_' + userId) },
                { text: '🚫 حظر',      callback_data: await saveCB('do_ban_' + userId) },
                { text: '🔇 كتم',      callback_data: await saveCB('do_mute_' + userId) }
            ],
            [{ text: '🙋 سأتكفل بهذا الطلب', callback_data: await saveCB('claim_' + userId + '_' + ticketId) }]
        ]};

        const now      = Date.now();
        const admins   = await getAdminList();
        let forwarded  = false;

        const headerMsg = `📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n👤 ${fullName || 'بدون اسم'}\n🔗 ${userName ? '@'+userName : '—'}\n🆔 \`${userId}\`\n📞 \`${user?.phone || 'غير متوفر'}\`\n🕒 ${formatTime(now)}`;

        // إرسال للمطور
        try {
            await bot.sendMessage(developerId, headerMsg, { parse_mode: 'Markdown' });
            const fwdDev = await bot.forwardMessage(developerId, chatId, msg.message_id);
            await saveMsgMap(userId, msg.message_id, fwdDev.message_id, developerId);
            await bot.sendMessage(developerId, `⬆️ من: *${fullName || 'مستخدم'}*`, { parse_mode: 'Markdown', reply_markup: quickBtns });
            forwarded = true;
        } catch(e) { await logError('fwd_developer', e); }

        // إرسال للأدمنية
        for (const a of admins) {
            if (a.user_id === developerId) continue;
            try {
                await bot.sendMessage(a.user_id, headerMsg, { parse_mode: 'Markdown' });
                const fwdAdmin = await bot.forwardMessage(a.user_id, chatId, msg.message_id);
                await saveMsgMap(userId, msg.message_id, fwdAdmin.message_id, a.user_id);
                await bot.sendMessage(a.user_id, `⬆️ من: *${fullName || 'مستخدم'}*`, { parse_mode: 'Markdown', reply_markup: quickBtns });
                forwarded = true;
            } catch(e) {}
        }

        if (forwarded) {
            await bot.sendMessage(chatId, '✅ *تم استلام رسالتك!*\n\n📬 رسالتك وصلت للأستاذ وسيطلع عليها قريباً.\n⏳ سوف نعلمك فور فتح الأستاذ للمحادثة.', { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, '⚠️ حدث خطأ مؤقت. حاول مرة أخرى.');
        }
    });

    // ──────────────────────────────────────────────
    //  👨‍💼  معالجة رسائل الأدمنية
    // ──────────────────────────────────────────────
    async function handleAdminMsg(chatId, userId, msg) {
        const state = devState[chatId] || {};

        // إضافة أدمن بالـ ID
        if (state.action === 'add_admin' && isDeveloper(userId)) {
            devState[chatId] = {};
            const adminId = (msg.text || '').trim();
            if (!adminId || !/^\d+$/.test(adminId)) {
                await bot.sendMessage(chatId, '⚠️ أرسل ID صحيح (أرقام فقط).', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'admin_panel' }]] } });
                return;
            }
            if (String(adminId) === developerId) { await bot.sendMessage(chatId, '⛔ المطور لا يُضاف كأدمن.'); return; }
            await addAdmin(adminId, userId);
            await bot.sendMessage(chatId, `✅ تم إضافة \`${adminId}\` كأدمن.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] } });
            try { await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch(e) {}
            return;
        }

        // بحث عن مستخدم
        if (state.action === 'search_user') {
            devState[chatId] = {};
            const term    = (msg.text || '').trim();
            const results = await searchUsers(term);
            if (!results.length) {
                await bot.sendMessage(chatId, '🔍 لا توجد نتائج.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                return;
            }
            let text = `🔍 *نتائج البحث عن "${term}"*\n━━━━━━━━━━━━━━━\n\n`;
            const btns = [];
            for (const u of results) {
                text += `• ${u.name||'—'} ${u.username?'@'+u.username:''} | \`${u.id}\`\n`;
                btns.push([{ text: (u.name||u.id), callback_data: 'user_' + u.id }]);
            }
            btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
            return;
        }

        // إرسال إشعار تحديث - الخطوة 1
        if (state.action === 'send_update_users' && isDeveloper(userId)) {
            devState[chatId] = { action: 'send_update_admins', update_users_msg: msg.text === '-' ? null : msg.text };
            await bot.sendMessage(chatId,
                '📣 *إرسال إشعار تحديث*\n\nالخطوة 2/2: اكتب رسالة التحديث للأدمنية:\n(أو أرسل "-" لتخطي)',
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] } }
            );
            return;
        }

        // إرسال إشعار تحديث - الخطوة 2
        if (state.action === 'send_update_admins' && isDeveloper(userId)) {
            const usersMsg  = state.update_users_msg;
            const adminsMsg = msg.text === '-' ? null : msg.text;
            devState[chatId] = {};

            if (!usersMsg && !adminsMsg) {
                await bot.sendMessage(chatId, '⚠️ لم تكتب أي رسالة.', { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] } });
                return;
            }

            await query('INSERT INTO bot_updates (version, msg_users, msg_admins, created_at, sent) VALUES (?,?,?,?,0)',
                [formatTime(Date.now()), usersMsg||'', adminsMsg||'', Date.now()]);

            if (usersMsg) {
                const allUsers = await getAllUsers();
                let sentOk = 0;
                for (const u of allUsers) {
                    if (isAdminUser(u.id)) continue;
                    try { await bot.sendMessage(u.id, `🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n${usersMsg}\n\nاضغط /start لرؤية التحديث.`, { parse_mode: 'Markdown' }); sentOk++; } catch(e) {}
                }
                await bot.sendMessage(chatId, `📨 تم الإرسال للمستخدمين: ${sentOk}`);
            }

            if (adminsMsg) {
                const adminsList = await getAdminList();
                const recipients = [developerId, ...adminsList.map(a => a.user_id).filter(id => id !== developerId && id !== userId)];
                for (const rec of recipients) {
                    try { await bot.sendMessage(rec, `🔔 *تحديث للأدمنية!*\n━━━━━━━━━━━━━━━\n${adminsMsg}\n\nاضغط /start لرؤية التحديث.`, { parse_mode: 'Markdown' }); } catch(e) {}
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
                if ((ok + fail) % 20 === 0) await sleep(1000); // تجنب rate limit
            }
            await bot.sendMessage(chatId, `✅ تم!\n✔️ نجح: ${ok}\n❌ فشل: ${fail}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
            return;
        }

        // الرد على مستخدم (حالة reply)
        if (state.action === 'reply' && state.targetId) {
            const target = state.targetId;
            devState[chatId] = {};
            try {
                await bot.copyMessage(target, chatId, msg.message_id);
                await query('UPDATE admins SET helped_count=helped_count+1 WHERE user_id=?', [userId]);
                const targetTicket = await getOpenTicket(target);
                if (targetTicket) {
                    const replyContent = getMsgContent(msg);
                    await saveTicketEvent(targetTicket.id, userId, 'admin', 'message', replyContent);
                    await query('UPDATE tickets SET admin_reply_count=admin_reply_count+1 WHERE id=?', [targetTicket.id]);
                    const newCount = (targetTicket.admin_reply_count || 0) + 1;
                    // قفل التذكرة بعد ردين للتحقق
                    if (newCount === 2) {
                        setTimeout(async () => {
                            const targetUserObj = await getUser(target);
                            if (!targetUserObj || targetUserObj.verified) return;
                            await query('UPDATE tickets SET user_locked=1 WHERE id=?', [targetTicket.id]);
                            try {
                                await bot.sendMessage(target,
                                    '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة، يرجى مشاركة جهة اتصالك.',
                                    { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
                                );
                            } catch(e) {}
                        }, 5000);
                    }
                }
                try { await bot.sendMessage(target, '💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.', { parse_mode: 'Markdown' }); } catch(e) {}
                await bot.sendMessage(chatId, `✅ تم إرسال الرد للمستخدم \`${target}\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [
                        [{ text: '↩️ رد آخر', callback_data: 'qr_' + target }],
                        [{ text: '✅ إغلاق الطلب', callback_data: await saveCB('close_ticket_' + target + '_' + (await getOpenTicket(target))?.id) }],
                        [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                    ]}
                });
            } catch(err) {
                await bot.sendMessage(chatId, `❌ فشل الإرسال: ${err.message}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 لوحة التحكم', callback_data: 'main' }]] } });
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
                        const replyContent = getMsgContent(msg);
                        await saveTicketEvent(replyTicket.id, userId, 'admin', 'message', replyContent);
                        await query('UPDATE tickets SET admin_reply_count=admin_reply_count+1 WHERE id=?', [replyTicket.id]);
                        const newCount = (replyTicket.admin_reply_count || 0) + 1;
                        if (newCount === 2) {
                            setTimeout(async () => {
                                const targetUserObj = await getUser(targetUserId);
                                if (!targetUserObj || targetUserObj.verified) return;
                                await query('UPDATE tickets SET user_locked=1 WHERE id=?', [replyTicket.id]);
                                try {
                                    await bot.sendMessage(targetUserId,
                                        '⚠️ *يجب التحقق من هويتك للمتابعة*\n━━━━━━━━━━━━━━━\n\n🔐 لضمان جودة الخدمة، يرجى مشاركة جهة اتصالك.',
                                        { parse_mode: 'Markdown', reply_markup: { keyboard: [[{ text: '✅ تحقق من هويتي 👤', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
                                    );
                                } catch(e) {}
                            }, 5000);
                        }
                    }
                    try { await bot.sendMessage(targetUserId, '💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.', { parse_mode: 'Markdown' }); } catch(e) {}
                    await bot.sendMessage(chatId, `✅ تم إرسال الرد للمستخدم \`${targetUserId}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [
                            [{ text: '↩️ رد آخر', callback_data: 'qr_' + targetUserId }],
                            [{ text: '🔙 لوحة التحكم', callback_data: 'main' }]
                        ]}
                    });
                } catch(err) {
                    await bot.sendMessage(chatId, `❌ فشل: ${err.message}`);
                }
                return;
            }
        }

        // إذا لم تكن هناك حالة، عرض لوحة التحكم
        await sendMainMenu(chatId);
    }

    // ──────────────────────────────────────────────
    //  📱  أحداث القروبات
    // ──────────────────────────────────────────────
    bot.on('new_chat_members', async (msg) => {
        const chatId     = msg.chat.id;
        const newMembers = msg.new_chat_members;
        for (const member of newMembers) {
            if (member.is_bot && member.id === bot.options?.id) {
                // البوت نفسه أُضيف للقروب
                try {
                    const chatInfo    = await bot.getChat(chatId);
                    const memberCount = await bot.getChatMemberCount(chatId);
                    await saveGroup(chatId, chatInfo.title, chatInfo.username, memberCount, msg.from.id);
                    const notif = `🆕 *تمت إضافة البوت لقروب جديد!*\n━━━━━━━━━━━━━━━\n📱 القروب: ${chatInfo.title}\n🔗 اليوزر: ${chatInfo.username ? '@'+chatInfo.username : '—'}\n🆔 ID: \`${chatId}\`\n👥 الأعضاء: ${memberCount}\n👤 أضافه: ${((msg.from.first_name||'') + ' ' + (msg.from.last_name||'')).trim()}\n🕒 ${formatTime(Date.now())}`;
                    await bot.sendMessage(developerId, notif, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📱 عرض التفاصيل', callback_data: await saveCB('group_detail_' + chatId) }]] } });
                    const admins = await bot.getChatAdministrators(chatId);
                    for (const admin of admins) {
                        const isOwner  = admin.status === 'creator';
                        const isBot    = admin.user.is_bot;
                        const fullName = ((admin.user.first_name||'') + ' ' + (admin.user.last_name||'')).trim();
                        await updateGroupMember(chatId, admin.user.id, admin.user.username, fullName, '', true, isBot, isOwner);
                    }
                } catch(e) { await logError('new_chat_members_bot', e); }
            } else {
                const isBot    = member.is_bot;
                const fullName = ((member.first_name||'') + ' ' + (member.last_name||'')).trim();
                await updateGroupMember(chatId, member.id, member.username, fullName, '', false, isBot, false);
            }
        }
    });

    bot.on('left_chat_member', async (msg) => {
        const chatId = msg.chat.id;
        const member = msg.left_chat_member;
        try { await query('DELETE FROM group_members WHERE group_id=? AND user_id=?', [String(chatId), String(member.id)]); } catch(e) {}
    });

    // معالجة أخطاء polling
    bot.on('polling_error', async (err) => {
        await logError('polling_error', err);
    });

    console.log('✅ البوت جاهز مع جميع الميزات المتكاملة 🎓');
}

// ============================================================
//  🔧  دالة مساعدة: استخراج محتوى الرسالة
// ============================================================
function getMsgContent(msg) {
    if (msg.text)     return msg.text;
    if (msg.photo)    return '[صورة]';
    if (msg.video)    return '[فيديو]';
    if (msg.document) return '[ملف: ' + (msg.document.file_name || 'document') + ']';
    if (msg.voice)    return '[رسالة صوتية]';
    if (msg.audio)    return '[ملف صوتي]';
    if (msg.sticker)  return '[ستيكر: ' + (msg.sticker.emoji || '') + ']';
    if (msg.video_note) return '[فيديو دائري]';
    if (msg.location) return '[موقع جغرافي]';
    if (msg.contact)  return '[جهة اتصال]';
    return '[محتوى]';
}

// ============================================================
//  🌐  تشغيل الخادم (Express)
// ============================================================
const app  = express();
const port = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.get('/', (req, res) => res.send('🎓 Teachers Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() }));

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    // Keep-alive ping لمنع النوم على Render.com
    setInterval(() => {
        const url      = serverUrl + '/health';
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, res => {
            console.log('🔄 Keep-alive:', res.statusCode);
        }).on('error', e => {
            console.log('⚠️ Keep-alive error:', e.message);
        });
    }, 14 * 60 * 1000);
});

// ============================================================
//  🚀  نقطة البداية
// ============================================================
startBot().catch(e => {
    console.error('❌ خطأ فادح:', e.message);
    process.exit(1);
});
