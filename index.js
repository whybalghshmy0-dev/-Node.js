'use strict';
var TelegramBot = require('node-telegram-bot-api');
var express = require('express');
var mysql = require('mysql2/promise');
var https = require('https');
var http = require('http');

// ===== إعدادات =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var DEV_ID = '7411444902';

// ===== قائمة الأدمنية في الذاكرة =====
var adminIds = [DEV_ID];
var adminMulti = {}; // adminId -> true/false (صلاحية متعدد المهام)

function isAdmin(uid) { return adminIds.indexOf(String(uid)) !== -1; }
function isDev(uid) { return String(uid) === DEV_ID; }

// ===== قاعدة البيانات =====
var DB = {
    host: 'sql5.freesqldatabase.com', user: 'sql5822025',
    password: 'UHrehHF1CU', database: 'sql5822025', port: 3306,
    connectTimeout: 20000, waitForConnections: true,
    connectionLimit: 5, queueLimit: 0
};
var pool = null;

async function initDB() {
    pool = mysql.createPool(DB);
    var c = await pool.getConnection();
    // جدول المستخدمين
    await c.execute(`CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(255) DEFAULT '',
        name VARCHAR(500) DEFAULT '',
        phone VARCHAR(50) DEFAULT NULL,
        first_seen BIGINT DEFAULT 0,
        last_seen BIGINT DEFAULT 0,
        msg_count INT DEFAULT 0,
        banned TINYINT(1) DEFAULT 0,
        muted TINYINT(1) DEFAULT 0,
        verified TINYINT(1) DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    // إضافة أعمدة جديدة إن لم تكن موجودة
    for (var col of [
        "ALTER TABLE users ADD COLUMN phone VARCHAR(50) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN verified TINYINT(1) DEFAULT 0"
    ]) { try { await c.execute(col); } catch(e) {} }

    // جدول الأدمنية
    await c.execute(`CREATE TABLE IF NOT EXISTS admins (
        user_id VARCHAR(50) PRIMARY KEY,
        added_by VARCHAR(50) NOT NULL,
        added_at BIGINT DEFAULT 0,
        multi_reply TINYINT(1) DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    try { await c.execute("ALTER TABLE admins ADD COLUMN multi_reply TINYINT(1) DEFAULT 0"); } catch(e) {}

    // جدول ربط الرسائل
    await c.execute(`CREATE TABLE IF NOT EXISTS msg_map (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        user_msg_id INT NOT NULL,
        fwd_msg_id INT NOT NULL,
        fwd_chat_id VARCHAR(50) NOT NULL,
        ts BIGINT DEFAULT 0,
        INDEX idx_u (user_id), INDEX idx_f (fwd_msg_id, fwd_chat_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // جدول التذاكر
    await c.execute(`CREATE TABLE IF NOT EXISTS tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        claimed_by VARCHAR(50) DEFAULT NULL,
        claimed_at BIGINT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'open',
        created_at BIGINT DEFAULT 0,
        completed_at BIGINT DEFAULT 0,
        rating INT DEFAULT 0,
        INDEX idx_u (user_id), INDEX idx_s (status), INDEX idx_c (claimed_by)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // جدول أحداث التذاكر
    await c.execute(`CREATE TABLE IF NOT EXISTS ticket_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ticket_id INT NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        event_type VARCHAR(30) DEFAULT 'message',
        content TEXT,
        ts BIGINT DEFAULT 0,
        INDEX idx_t (ticket_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // جدول جلسات الأدمن
    await c.execute(`CREATE TABLE IF NOT EXISTS admin_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id VARCHAR(50) NOT NULL,
        login_at BIGINT DEFAULT 0,
        logout_at BIGINT DEFAULT 0,
        duration_sec INT DEFAULT 0,
        helped_count INT DEFAULT 0,
        INDEX idx_a (admin_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // جدول الاقتراحات
    await c.execute(`CREATE TABLE IF NOT EXISTS suggestions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        ts BIGINT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'new',
        INDEX idx_s (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // جدول تحديثات البوت
    await c.execute(`CREATE TABLE IF NOT EXISTS bot_updates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        msg_users TEXT,
        msg_admins TEXT,
        created_at BIGINT DEFAULT 0,
        sent TINYINT(1) DEFAULT 0
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // تحميل الأدمنية
    var rows = await c.execute('SELECT user_id, multi_reply FROM admins');
    for (var r of rows[0]) {
        if (!adminIds.includes(r.user_id)) adminIds.push(r.user_id);
        adminMulti[r.user_id] = r.multi_reply === 1;
    }
    c.release();
    console.log('✅ DB جاهز');
}

async function q(sql, p) {
    for (var i = 0; i < 3; i++) {
        try { return (await pool.execute(sql, p || []))[0]; }
        catch(e) { if (i===2) throw e; await sleep(1000*(i+1)); }
    }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== دوال المستخدمين =====
async function getUser(uid) {
    var r = await q('SELECT * FROM users WHERE id=?', [String(uid)]);
    if (!r || !r[0]) return null;
    var u = r[0]; u.banned = u.banned===1; u.muted = u.muted===1; u.verified = u.verified===1;
    return u;
}
async function getAllUsers() {
    var r = await q('SELECT * FROM users ORDER BY last_seen DESC', []);
    return (r||[]).map(u => { u.banned=u.banned===1; u.muted=u.muted===1; u.verified=u.verified===1; return u; });
}
async function upsertUser(uid, username, name) {
    var now = Date.now();
    var ex = await getUser(uid);
    if (!ex) {
        await q('INSERT INTO users (id,username,name,first_seen,last_seen,msg_count) VALUES (?,?,?,?,?,1)',
            [String(uid), username||'', name||'', now, now]);
    } else {
        await q('UPDATE users SET last_seen=?,msg_count=msg_count+1,username=?,name=? WHERE id=?',
            [now, username||ex.username||'', name||ex.name||'', String(uid)]);
    }
}
async function setField(uid, field, val) {
    await q('UPDATE users SET '+field+'=? WHERE id=?', [val, String(uid)]);
}
function uname(u) {
    var n = u.name || 'مجهول';
    if (u.username) n += ' (@'+u.username+')';
    return n;
}
function ft(ts) { return new Date(ts).toLocaleString('ar-YE',{timeZone:'Asia/Aden'}); }

// ===== دوال الأدمنية =====
async function addAdmin(uid, by) {
    if (isDev(uid)) return;
    await q('INSERT IGNORE INTO admins (user_id,added_by,added_at,multi_reply) VALUES (?,?,?,0)',
        [String(uid), String(by), Date.now()]);
    if (!adminIds.includes(String(uid))) adminIds.push(String(uid));
    adminMulti[String(uid)] = false;
}
async function removeAdmin(uid) {
    if (isDev(uid)) return;
    await q('DELETE FROM admins WHERE user_id=?', [String(uid)]);
    adminIds = adminIds.filter(x => x !== String(uid));
    delete adminMulti[String(uid)];
}
async function toggleMulti(uid) {
    if (isDev(uid)) return;
    var cur = adminMulti[String(uid)] ? 1 : 0;
    var nw = cur ? 0 : 1;
    await q('UPDATE admins SET multi_reply=? WHERE user_id=?', [nw, String(uid)]);
    adminMulti[String(uid)] = nw === 1;
    return nw === 1;
}
async function getAdmins() {
    return await q('SELECT a.*,u.name,u.username FROM admins a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.added_at DESC', []) || [];
}

// ===== دوال التذاكر =====
async function getOpenTicket(uid) {
    var r = await q("SELECT * FROM tickets WHERE user_id=? AND status='open' ORDER BY created_at DESC LIMIT 1", [String(uid)]);
    return r && r[0] ? r[0] : null;
}
async function createTicket(uid) {
    var ex = await getOpenTicket(uid);
    if (ex) return ex.id;
    var r = await q('INSERT INTO tickets (user_id,status,created_at) VALUES (?,?,?)', [String(uid),'open',Date.now()]);
    return r.insertId;
}
async function claimTicket(tid, adminId) {
    var r = await q('SELECT * FROM tickets WHERE id=? AND claimed_by IS NULL', [tid]);
    if (!r || !r[0]) return null;
    await q('UPDATE tickets SET claimed_by=?,claimed_at=? WHERE id=? AND claimed_by IS NULL',
        [String(adminId), Date.now(), tid]);
    var r2 = await q('SELECT * FROM tickets WHERE id=?', [tid]);
    return r2 && r2[0] ? r2[0] : null;
}
async function completeTicket(tid) {
    await q("UPDATE tickets SET status='completed',completed_at=? WHERE id=?", [Date.now(), tid]);
}
async function rateTicket(tid, rating) {
    await q('UPDATE tickets SET rating=? WHERE id=?', [rating, tid]);
}
async function saveEvent(tid, uid, role, type, content) {
    await q('INSERT INTO ticket_events (ticket_id,user_id,role,event_type,content,ts) VALUES (?,?,?,?,?,?)',
        [tid, String(uid), role, type, content||'', Date.now()]);
}

// ===== دوال ربط الرسائل =====
async function saveMsgMap(uid, userMsgId, fwdMsgId, fwdChatId) {
    await q('INSERT INTO msg_map (user_id,user_msg_id,fwd_msg_id,fwd_chat_id,ts) VALUES (?,?,?,?,?)',
        [String(uid), userMsgId, fwdMsgId, String(fwdChatId), Date.now()]);
}
async function getUserByFwd(fwdMsgId, fwdChatId) {
    var r = await q('SELECT user_id FROM msg_map WHERE fwd_msg_id=? AND fwd_chat_id=?', [fwdMsgId, String(fwdChatId)]);
    return r && r[0] ? r[0].user_id : null;
}

// ===== دوال جلسات الأدمن =====
var adminSessions = {}; // adminId -> { sessionId, loginAt, helpedCount }
async function adminLogin(adminId) {
    var r = await q('INSERT INTO admin_sessions (admin_id,login_at,helped_count) VALUES (?,?,0)',
        [String(adminId), Date.now()]);
    adminSessions[String(adminId)] = { sessionId: r.insertId, loginAt: Date.now(), helpedCount: 0 };
}
async function adminLogout(adminId) {
    var s = adminSessions[String(adminId)];
    if (!s) return;
    var dur = Math.floor((Date.now() - s.loginAt) / 1000);
    await q('UPDATE admin_sessions SET logout_at=?,duration_sec=?,helped_count=? WHERE id=?',
        [Date.now(), dur, s.helpedCount, s.sessionId]);
    delete adminSessions[String(adminId)];
}
async function adminHelped(adminId) {
    var s = adminSessions[String(adminId)];
    if (s) {
        s.helpedCount++;
        await q('UPDATE admin_sessions SET helped_count=? WHERE id=?', [s.helpedCount, s.sessionId]);
    }
}
async function getAdminStats(adminId) {
    var r = await q('SELECT SUM(duration_sec) as total_sec, SUM(helped_count) as total_helped, COUNT(*) as sessions FROM admin_sessions WHERE admin_id=?', [String(adminId)]);
    return r && r[0] ? r[0] : { total_sec: 0, total_helped: 0, sessions: 0 };
}

// ===== التحقق من صلاحية الرد =====
async function canReply(adminId, uid) {
    if (isDev(adminId)) return true;
    var t = await getOpenTicket(uid);
    if (!t) return true;
    if (!t.claimed_by) return true;
    if (t.claimed_by === String(adminId)) return true;
    if (adminMulti[String(adminId)]) return true;
    return false;
}

// ===== المتغيرات العامة =====
var bot = null;
var devState = {};
var pendingNotify = {};
var waitingContact = {}; // uid -> true (ينتظر إرسال جهة الاتصال)

// ===== تشغيل البوت =====
async function startBot() {
    await initDB();
    bot = new TelegramBot(BOT_TOKEN, { polling: { interval: 300, autoStart: true, params: { timeout: 10 } } });
    console.log('🤖 البوت يعمل');

    bot.setMyCommands([{ command: 'start', description: '🏠 القائمة الرئيسية' }]).catch(()=>{});

    // ===== /start =====
    bot.onText(/^\/(start|panel)$/, async (msg) => {
        var cid = msg.chat.id, uid = msg.from.id;
        var name = ((msg.from.first_name||'') + ' ' + (msg.from.last_name||'')).trim();

        if (isAdmin(uid)) {
            devState[cid] = {};
            if (!adminSessions[String(uid)]) await adminLogin(uid);
            await sendMenu(cid);
            await notifyPending(uid);
            await showUpdate(cid, 'admin');
            return;
        }

        var isNew = !(await getUser(uid));
        await upsertUser(uid, msg.from.username, name);
        await showUpdate(cid, 'user');

        // طلب التحقق بجهة الاتصال إذا لم يتحقق بعد
        var u = await getUser(uid);
        if (!u || !u.verified) {
            waitingContact[String(uid)] = true;
            await bot.sendMessage(cid,
                '🎓 *أهلاً بك في بوت الأساتذة!*\n\n'
                + '🔐 *التحقق من هويتك*\n\n'
                + 'لضمان جودة الخدمة وحماية المستخدمين، نحتاج التحقق من أنك إنسان حقيقي.\n\n'
                + '📱 اضغط الزر أدناه لإرسال رقم هاتفك (يُحفظ بشكل آمن ولا يُشارك مع أحد):',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: '📱 إرسال رقم هاتفي للتحقق', request_contact: true }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
            return;
        }

        await sendWelcome(cid, name, isNew, uid, msg.from.username);
    });

    // ===== معالجة جهة الاتصال =====
    bot.on('contact', async (msg) => {
        var cid = msg.chat.id, uid = msg.from.id;
        if (!waitingContact[String(uid)]) return;
        if (msg.contact.user_id && String(msg.contact.user_id) !== String(uid)) {
            await bot.sendMessage(cid, '⚠️ يرجى إرسال رقم هاتفك الشخصي فقط.', {
                reply_markup: {
                    keyboard: [[{ text: '📱 إرسال رقم هاتفي للتحقق', request_contact: true }]],
                    resize_keyboard: true, one_time_keyboard: true
                }
            });
            return;
        }
        delete waitingContact[String(uid)];
        var phone = msg.contact.phone_number || '';
        var name = ((msg.from.first_name||'') + ' ' + (msg.from.last_name||'')).trim();
        // حفظ الهاتف وتعليم التحقق
        await q('UPDATE users SET phone=?,verified=1 WHERE id=?', [phone, String(uid)]);
        // إزالة لوحة المفاتيح
        await bot.sendMessage(cid, '✅ *تم التحقق بنجاح!*\n\nيمكنك الآن استخدام البوت.', {
            parse_mode: 'Markdown',
            reply_markup: { remove_keyboard: true }
        });
        // إشعار المطور
        try {
            await bot.sendMessage(DEV_ID,
                '🔐 *مستخدم جديد تحقق*\n━━━━━━━━━━━━━━━\n'
                + '👤 ' + name + '\n'
                + '📱 ' + phone + '\n'
                + '🆔 `' + uid + '`\n'
                + '🕒 ' + ft(Date.now()),
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 مراسلة', callback_data: 'r_'+uid }]] } }
            );
        } catch(e) {}
        var isNew = !(await getUser(uid));
        await upsertUser(uid, msg.from.username, name);
        await sendWelcome(cid, name, isNew, uid, msg.from.username);
    });

    // ===== إرسال رسالة الترحيب =====
    async function sendWelcome(cid, name, isNew, uid, username) {
        var txt = '🎓 *هنا أستاذك الخاص*\n\n'
            + 'لقد كثرت الـ AI بشكل كبير جداً، وكلهن متخصصات حتى في حل الواجبات والأسئلة الوزارية.\n\n'
            + 'ولكن نحيطك علماً — وأنت تعرف ذلك — أن *50% من إجاباتهم خاطئة* ❌\n\n'
            + 'لهذا، هذا البوت يوفر لكم *أساتذة ومعيدين متخصصين* مع *ضمان الإجابات 100%* ✅\n\n'
            + '━━━━━━━━━━━━━━━\n'
            + '👋 أهلاً *' + (name||'عزيزي') + '*!\n\n'
            + '📩 أرسل سؤالك أو طلبك الآن وسيصل للأستاذ المناسب فوراً.\n\n'
            + '📌 *يمكنك إرسال:* نصوص، صور، فيديوهات، ملفات، صوتيات، أي شيء!';
        await bot.sendMessage(cid, txt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح ميزة', callback_data: 'suggest' }]] }
        });
        if (isNew) {
            var notif = '🆕 *مستخدم جديد انضم!*\n━━━━━━━━━━━━━━━\n'
                + '👤 ' + (name||'بدون اسم') + '\n'
                + '🔗 ' + (username ? '@'+username : 'بدون يوزر') + '\n'
                + '🆔 `' + uid + '`\n🕒 ' + ft(Date.now());
            var recs = await getAllAdminIds();
            for (var r of recs) {
                try { await bot.sendMessage(r, notif, { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{text:'💬 مراسلة',callback_data:'r_'+uid}]] } }); } catch(e) {}
            }
        }
    }

    async function getAllAdminIds() {
        var list = [DEV_ID];
        var adms = await getAdmins();
        for (var a of adms) if (a.user_id !== DEV_ID) list.push(a.user_id);
        return list;
    }

    // ===== إشعار قراءة الرسالة =====
    async function notifyPending(adminId) {
        for (var uid of Object.keys(pendingNotify)) {
            if (pendingNotify[uid] && !pendingNotify[uid].done) {
                try {
                    await bot.sendMessage(uid,
                        '👀 *تمت قراءة رسالتك*\n\n✅ الأستاذ فتح المحادثة وسيرد قريباً.\n⏳ يرجى الانتظار...',
                        { parse_mode: 'Markdown' }
                    );
                    pendingNotify[uid].done = true;
                } catch(e) {}
            }
        }
        setTimeout(() => {
            for (var k of Object.keys(pendingNotify)) {
                if (pendingNotify[k] && pendingNotify[k].done) delete pendingNotify[k];
            }
        }, 5000);
    }

    // ===== إشعار التحديث =====
    async function showUpdate(cid, role) {
        try {
            var r = await q("SELECT * FROM bot_updates WHERE sent=0 ORDER BY created_at DESC LIMIT 1", []);
            if (!r || !r[0]) return;
            var txt = role==='admin' ? r[0].msg_admins : r[0].msg_users;
            if (!txt) return;
            await bot.sendMessage(cid, '🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n'+txt, { parse_mode:'Markdown' });
        } catch(e) {}
    }

    // ===== لوحة التحكم =====
    async function sendMenu(cid, editId) {
        var all = await getAllUsers();
        var total = all.length;
        var banned = all.filter(u=>u.banned).length;
        var muted = all.filter(u=>u.muted).length;
        var active = all.filter(u=>u.last_seen > Date.now()-86400000).length;
        var adms = await getAdmins();
        var openT=0, claimedT=0, newSugg=0;
        try { var ot=await q("SELECT COUNT(*) c FROM tickets WHERE status='open' AND claimed_by IS NULL",[]); openT=ot[0]?ot[0].c:0; } catch(e){}
        try { var ct=await q("SELECT COUNT(*) c FROM tickets WHERE status='open' AND claimed_by IS NOT NULL",[]); claimedT=ct[0]?ct[0].c:0; } catch(e){}
        try { var sg=await q("SELECT COUNT(*) c FROM suggestions WHERE status='new'",[]); newSugg=sg[0]?sg[0].c:0; } catch(e){}

        var txt = '🔧 *لوحة التحكم*\n━━━━━━━━━━━━━━━\n'
            + '👥 المستخدمين: '+total+'\n'
            + '🟢 نشطين اليوم: '+active+'\n'
            + '🚫 محظورين: '+banned+' | 🔇 مكتومين: '+muted+'\n'
            + '👨‍💼 الأدمنية: '+(adms.length+1)+'\n'
            + '━━━━━━━━━━━━━━━\n'
            + '🎫 طلبات مفتوحة: '+openT+'\n'
            + '🔒 طلبات محجوزة: '+claimedT+'\n'
            + (newSugg>0?'💡 اقتراحات جديدة: '+newSugg+'\n':'')
            + '━━━━━━━━━━━━━━━';

        var kb = [
            [{text:'👥 المستخدمين',callback_data:'ul_1'},{text:'📈 إحصائيات',callback_data:'stats'}],
            [{text:'🎫 الطلبات المفتوحة'+(openT>0?' 🔴'+openT:''),callback_data:'to_1'}],
            [{text:'📋 الطلبات المحجوزة',callback_data:'tc_1'}],
            [{text:'💡 الاقتراحات'+(newSugg>0?' 🔴'+newSugg:''),callback_data:'sg_1'}],
            [{text:'📢 رسالة جماعية',callback_data:'bc'}],
            [{text:'🔨 حظر',callback_data:'pb_1'},{text:'🔓 رفع حظر',callback_data:'pub_1'}],
            [{text:'🔇 كتم',callback_data:'pm_1'},{text:'🔊 رفع كتم',callback_data:'pum_1'}],
            [{text:'💬 مراسلة مستخدم',callback_data:'pr_1'}]
        ];
        if (isDev(cid)) kb.push([{text:'👨‍💼 إدارة الأدمنية',callback_data:'ap'},{text:'📣 إرسال تحديث',callback_data:'su'}]);

        if (editId) {
            try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:kb}}); return; } catch(e){}
        }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:kb}});
    }

    // ===== معالجة الأزرار =====
    bot.on('callback_query', async (cbq) => {
        var cid = cbq.message.chat.id;
        var uid = cbq.from.id;
        var mid = cbq.message.message_id;
        var d = cbq.data;

        await bot.answerCallbackQuery(cbq.id).catch(()=>{});
        if (!isAdmin(uid)) {
            // أزرار المستخدم العادي
            await handleUserCallback(cid, uid, mid, d, cbq);
            return;
        }

        try {
            // ===== رجوع =====
            if (d === 'main') { devState[cid]={}; await sendMenu(cid, mid); return; }
            if (d === 'noop') return;

            // ===== رد سريع =====
            if (d.startsWith('r_')) {
                var tid = d.slice(2);
                if (String(tid)===DEV_ID && !isDev(uid)) { await bot.answerCallbackQuery(cbq.id,{text:'⛔ لا يمكن.',show_alert:true}).catch(()=>{}); return; }
                var ok = await canReply(uid, tid);
                if (!ok) {
                    var ot = await getOpenTicket(tid);
                    var cl = ot ? await getUser(ot.claimed_by) : null;
                    await bot.answerCallbackQuery(cbq.id,{text:'⛔ محجوز من: '+(cl?uname(cl):'أدمن آخر'),show_alert:true}).catch(()=>{});
                    return;
                }
                devState[cid] = {action:'reply', target:tid};
                var tu = await getUser(tid);
                try { await bot.editMessageText('💬 *مراسلة: '+(tu?uname(tu):tid)+'*\n\n✏️ اكتب ردك الآن:', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== التكفل بطلب =====
            if (d.startsWith('cl_')) {
                var parts = d.slice(3).split('_');
                var clUid = parts[0], clTid = parseInt(parts[1]);
                if (String(clUid)===DEV_ID && !isDev(uid)) return;
                var claimed = await claimTicket(clTid, uid);
                if (!claimed || claimed.claimed_by !== String(uid)) {
                    await bot.answerCallbackQuery(cbq.id,{text:'⚠️ تم الحجز من أدمن آخر!',show_alert:true}).catch(()=>{});
                    return;
                }
                var adminU = await getUser(uid);
                var targetU = await getUser(clUid);
                await saveEvent(clTid, uid, 'admin', 'claimed', 'تكفل '+(adminU?uname(adminU):uid)+' بالطلب');
                // إشعار المستخدم
                try {
                    await bot.sendMessage(clUid,
                        '🎉 *تم قبول طلبك!*\n\n'
                        + '👨‍🏫 الأستاذ *'+(adminU?(adminU.name||'الأستاذ'):'الأستاذ')+'* سيتولى طلبك الآن.\n'
                        + '⏳ انتظر رده...',
                        { parse_mode:'Markdown' }
                    );
                } catch(e){}
                // إخفاء زر التكفل من الأدمنية الآخرين
                try {
                    await bot.editMessageReplyMarkup({inline_keyboard:[
                        [{text:'↩️ رد',callback_data:'r_'+clUid},{text:'🚫 حظر',callback_data:'bn_'+clUid}],
                        [{text:'✅ تم إنهاء المهمة',callback_data:'dn_'+clUid+'_'+clTid}],
                        [{text:'👤 ملف المستخدم',callback_data:'ud_'+clUid}]
                    ]}, {chat_id:cid, message_id:mid});
                } catch(e){}
                await bot.sendMessage(cid,
                    '✅ *تكفلت بالطلب*\n━━━━━━━━━━━━━━━\n'
                    + '👤 '+(targetU?uname(targetU):clUid)+'\n'
                    + '🎫 رقم الطلب: '+clTid,
                    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
                        [{text:'↩️ رد على المستخدم',callback_data:'r_'+clUid}],
                        [{text:'✅ تم إنهاء المهمة',callback_data:'dn_'+clUid+'_'+clTid}],
                        [{text:'🔙 لوحة التحكم',callback_data:'main'}]
                    ]}}
                );
                return;
            }

            // ===== إنهاء المهمة =====
            if (d.startsWith('dn_')) {
                var pp = d.slice(3).split('_');
                var dnUid = pp[0], dnTid = parseInt(pp[1]);
                var tk = await q('SELECT * FROM tickets WHERE id=?', [dnTid]);
                if (!tk || !tk[0]) return;
                if (tk[0].claimed_by !== String(uid) && !isDev(uid)) {
                    await bot.answerCallbackQuery(cbq.id,{text:'⛔ هذا الطلب ليس لك.',show_alert:true}).catch(()=>{});
                    return;
                }
                await completeTicket(dnTid);
                var dnAdmin = await getUser(uid);
                await saveEvent(dnTid, uid, 'admin', 'completed', 'أنهى '+(dnAdmin?uname(dnAdmin):uid)+' المهمة');
                await adminHelped(uid);
                // طلب التقييم من المستخدم
                try {
                    await bot.sendMessage(dnUid,
                        '✅ *تم إنهاء طلبك بنجاح!*\n\n'
                        + '🙏 شكراً لاستخدامك بوت الأساتذة.\n\n'
                        + '⭐ كيف تقيّم تعامل الأستاذ معك؟',
                        { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
                            [{text:'⭐⭐⭐⭐⭐ ممتاز',callback_data:'rt_'+dnTid+'_5'}],
                            [{text:'⭐⭐⭐⭐ جيد جداً',callback_data:'rt_'+dnTid+'_4'}],
                            [{text:'⭐⭐⭐ جيد',callback_data:'rt_'+dnTid+'_3'}],
                            [{text:'⭐⭐ مقبول',callback_data:'rt_'+dnTid+'_2'}],
                            [{text:'⭐ ضعيف',callback_data:'rt_'+dnTid+'_1'}]
                        ]}}
                    );
                } catch(e){}
                try { await bot.editMessageText('✅ *تم إنهاء المهمة بنجاح!*\n\nتم إرسال طلب التقييم للمستخدم.', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 لوحة التحكم',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== قائمة المستخدمين =====
            if (d.startsWith('ul_')) { await showUsers(cid, parseInt(d.slice(3))||1, mid); return; }

            // ===== تفاصيل مستخدم =====
            if (d.startsWith('ud_')) { await showUserDetail(cid, d.slice(3), mid); return; }

            // ===== محادثات مستخدم =====
            if (d.startsWith('um_')) {
                var pp2 = d.slice(3).split('_');
                await showUserConvo(cid, pp2[0], parseInt(pp2[1])||1, mid);
                return;
            }

            // ===== إحصائيات =====
            if (d === 'stats') {
                var all2 = await getAllUsers();
                var totalM=0, todayM=0;
                try { var mr=await q('SELECT COUNT(*) c FROM msg_map',[]); totalM=mr[0]?mr[0].c:0; } catch(e){}
                try { var tr=await q('SELECT COUNT(*) c FROM msg_map WHERE ts>?',[Date.now()-86400000]); todayM=tr[0]?tr[0].c:0; } catch(e){}
                var completedT=0;
                try { var ctr=await q("SELECT COUNT(*) c FROM tickets WHERE status='completed'",[]); completedT=ctr[0]?ctr[0].c:0; } catch(e){}
                var avgR=0;
                try { var avr=await q('SELECT AVG(rating) a FROM tickets WHERE rating>0',[]); avgR=avr[0]?(parseFloat(avr[0].a)||0).toFixed(1):0; } catch(e){}
                var txt2 = '📈 *الإحصائيات الكاملة*\n━━━━━━━━━━━━━━━\n'
                    + '👥 إجمالي المستخدمين: '+all2.length+'\n'
                    + '🟢 نشطين اليوم: '+all2.filter(u=>u.last_seen>Date.now()-86400000).length+'\n'
                    + '🔵 نشطين الأسبوع: '+all2.filter(u=>u.last_seen>Date.now()-604800000).length+'\n'
                    + '🚫 محظورين: '+all2.filter(u=>u.banned).length+'\n'
                    + '🔇 مكتومين: '+all2.filter(u=>u.muted).length+'\n'
                    + '✅ متحققين: '+all2.filter(u=>u.verified).length+'\n'
                    + '━━━━━━━━━━━━━━━\n'
                    + '💬 إجمالي الرسائل: '+totalM+'\n'
                    + '📨 رسائل اليوم: '+todayM+'\n'
                    + '🎫 طلبات مكتملة: '+completedT+'\n'
                    + '⭐ متوسط التقييم: '+avgR+'/5';
                try { await bot.editMessageText(txt2, {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== الطلبات المفتوحة =====
            if (d.startsWith('to_')) { await showOpenTickets(cid, parseInt(d.slice(3))||1, mid); return; }
            if (d.startsWith('tc_')) { await showClaimedTickets(cid, parseInt(d.slice(3))||1, mid); return; }

            // ===== الاقتراحات =====
            if (d.startsWith('sg_')) { await showSuggestions(cid, parseInt(d.slice(3))||1, mid); return; }
            if (d.startsWith('sd_')) {
                var sgId = d.slice(3);
                await q("UPDATE suggestions SET status='done' WHERE id=?", [sgId]);
                try { await bot.editMessageText('✅ تم تعليم الاقتراح كمنجز.', {chat_id:cid,message_id:mid,reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'sg_1'}]]}}); } catch(e){}
                return;
            }

            // ===== رسالة جماعية =====
            if (d === 'bc') {
                devState[cid] = {action:'broadcast'};
                var allU = (await getAllUsers()).filter(u=>!u.banned);
                try { await bot.editMessageText('📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ '+allU.length+' مستخدم:', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== اختيار مستخدم للإجراء =====
            var pickMap = {pb:'ban',pub:'unban',pm:'mute',pum:'unmute',pr:'reply'};
            for (var [prefix, action] of Object.entries(pickMap)) {
                if (d.startsWith(prefix+'_')) {
                    var pg = parseInt(d.slice(prefix.length+1))||1;
                    await showPickUser(cid, mid, action, pg);
                    return;
                }
            }

            // ===== تنفيذ إجراء =====
            if (d.startsWith('bn_') || d.startsWith('ubn_') || d.startsWith('mt_') || d.startsWith('umt_')) {
                var actMap = {bn:'ban',ubn:'unban',mt:'mute',umt:'unmute'};
                var actKey = Object.keys(actMap).find(k => d.startsWith(k+'_'));
                var actVal = actMap[actKey];
                var actUid = d.slice(actKey.length+1);
                if (String(actUid)===DEV_ID) { await bot.answerCallbackQuery(cbq.id,{text:'⛔ لا يمكن.',show_alert:true}).catch(()=>{}); return; }
                var actU = await getUser(actUid);
                var actNames = {ban:'🔨 حظر',unban:'🔓 رفع حظر',mute:'🔇 كتم',unmute:'🔊 رفع كتم'};
                try { await bot.editMessageText('*'+actNames[actVal]+'*\n\n👤 '+(actU?uname(actU):actUid)+'\n🆔 `'+actUid+'`\n\nهل أنت متأكد؟', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'✅ تأكيد',callback_data:'cf_'+actVal+'_'+actUid},{text:'❌ إلغاء',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== تأكيد إجراء =====
            if (d.startsWith('cf_')) {
                var cfParts = d.slice(3).split('_');
                var cfAct = cfParts[0], cfUid = cfParts[1];
                if (String(cfUid)===DEV_ID) { await bot.answerCallbackQuery(cbq.id,{text:'⛔ لا يمكن.',show_alert:true}).catch(()=>{}); return; }
                var cfRes = '';
                if (cfAct==='ban') {
                    await setField(cfUid,'banned',1); cfRes='✅ تم حظر `'+cfUid+'`';
                    // حذف رسائل المحادثة من عند المستخدم غير ممكن تقنياً في تيليغرام
                    // لكن نرسل إشعار
                    try { await bot.sendMessage(cfUid,'⛔ تم حظرك من البوت. للتواصل مع الإدارة راجع الجهة المختصة.'); } catch(e){}
                } else if (cfAct==='unban') {
                    await setField(cfUid,'banned',0); cfRes='✅ تم رفع الحظر عن `'+cfUid+'`';
                    try { await bot.sendMessage(cfUid,'✅ تم رفع الحظر عنك. يمكنك استخدام البوت مجدداً.'); } catch(e){}
                } else if (cfAct==='mute') {
                    await setField(cfUid,'muted',1); cfRes='✅ تم كتم `'+cfUid+'`';
                } else if (cfAct==='unmute') {
                    await setField(cfUid,'muted',0); cfRes='✅ تم رفع الكتم عن `'+cfUid+'`';
                }
                try { await bot.editMessageText(cfRes, {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== حذف وحظر كامل (المطور فقط) =====
            if (d.startsWith('dstr_')) {
                if (!isDev(uid)) { await bot.answerCallbackQuery(cbq.id,{text:'⛔ فقط المطور.',show_alert:true}).catch(()=>{}); return; }
                var dstId = d.slice(5);
                if (String(dstId)===DEV_ID) return;
                await setField(dstId,'banned',1);
                try { await bot.sendMessage(dstId,'⛔ تم حظرك وإزالة بياناتك من البوت.'); } catch(e){}
                // حذف البيانات
                await q('DELETE FROM msg_map WHERE user_id=?',[dstId]);
                await q('DELETE FROM tickets WHERE user_id=?',[dstId]);
                await q('DELETE FROM ticket_events WHERE user_id=?',[dstId]);
                await q('DELETE FROM suggestions WHERE user_id=?',[dstId]);
                try { await bot.editMessageText('✅ تم حذف وحظر المستخدم `'+dstId+'` بالكامل.', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== إدارة الأدمنية =====
            if (d === 'ap') {
                if (!isDev(uid)) return;
                await showAdminPanel(cid, mid);
                return;
            }
            if (d === 'ap_addid') {
                if (!isDev(uid)) return;
                devState[cid] = {action:'add_admin'};
                try { await bot.editMessageText('👨‍💼 *إضافة أدمن*\n\n✏️ أرسل ID الشخص:', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'ap'}]]}}); } catch(e){}
                return;
            }
            if (d.startsWith('ap_rm_')) {
                if (!isDev(uid)) return;
                var rmId = d.slice(6);
                if (String(rmId)===DEV_ID) return;
                await removeAdmin(rmId);
                var rmU = await getUser(rmId);
                try { await bot.sendMessage(rmId,'⚠️ تم إزالتك من الأدمنية.'); } catch(e){}
                await bot.sendMessage(cid,'✅ تم إزالة '+(rmU?uname(rmU):rmId)+' من الأدمنية.', {reply_markup:{inline_keyboard:[[{text:'🔙 إدارة الأدمنية',callback_data:'ap'}]]}});
                return;
            }
            if (d.startsWith('ap_ml_')) {
                if (!isDev(uid)) return;
                var mlId = d.slice(6);
                var newVal = await toggleMulti(mlId);
                await bot.answerCallbackQuery(cbq.id,{text:(newVal?'✅ منح صلاحية متعدد المهام':'🔒 سحب صلاحية متعدد المهام'),show_alert:true}).catch(()=>{});
                await showAdminPanel(cid, mid);
                return;
            }
            if (d.startsWith('ap_af_')) {
                if (!isDev(uid)) return;
                var afId = d.slice(6);
                await addAdmin(afId, uid);
                var afU = await getUser(afId);
                try { await bot.sendMessage(afId,'🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch(e){}
                await bot.sendMessage(cid,'✅ تم إضافة '+(afU?uname(afU):afId)+' كأدمن.', {reply_markup:{inline_keyboard:[[{text:'🔙 إدارة الأدمنية',callback_data:'ap'}]]}});
                return;
            }
            if (d.startsWith('ap_pa_')) {
                if (!isDev(uid)) return;
                var pg4 = parseInt(d.slice(6))||1;
                var r4 = await buildPickBtns('ap_af', pg4, u=>u.id!==DEV_ID, 'ap_pa');
                try { await bot.editMessageText('👥 اختر مستخدم لإضافته كأدمن:', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:r4.btns}}); } catch(e){}
                return;
            }

            // ===== إرسال تحديث =====
            if (d === 'su') {
                if (!isDev(uid)) return;
                devState[cid] = {action:'upd_users'};
                try { await bot.editMessageText('📣 *إرسال تحديث*\n\nالخطوة 1/2: اكتب رسالة التحديث للمستخدمين:\n(أو أرسل "-" لتخطي)', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'main'}]]}}); } catch(e){}
                return;
            }

            // ===== إحصائيات أدمن =====
            if (d.startsWith('as_')) {
                var asId = d.slice(3);
                var asStats = await getAdminStats(asId);
                var asU = await getUser(asId);
                var hours = Math.floor((asStats.total_sec||0)/3600);
                var mins = Math.floor(((asStats.total_sec||0)%3600)/60);
                var txt3 = '📊 *إحصائيات الأدمن*\n━━━━━━━━━━━━━━━\n'
                    + '👤 '+(asU?uname(asU):asId)+'\n'
                    + '━━━━━━━━━━━━━━━\n'
                    + '🔑 جلسات: '+(asStats.sessions||0)+'\n'
                    + '⏱️ إجمالي الوقت: '+hours+'س '+mins+'د\n'
                    + '✅ طلبات أنجزها: '+(asStats.total_helped||0);
                try { await bot.editMessageText(txt3, {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'ap'}]]}}); } catch(e){}
                return;
            }

        } catch(err) {
            console.error('callback error:', err.message);
            try { await bot.sendMessage(cid, '⚠️ حدث خطأ. حاول مرة أخرى.'); } catch(e){}
        }
    });

    // ===== أزرار المستخدم العادي =====
    async function handleUserCallback(cid, uid, mid, d, cbq) {
        // تقييم
        if (d.startsWith('rt_')) {
            var pp = d.slice(3).split('_');
            var rtTid = parseInt(pp[0]), rtVal = parseInt(pp[1]);
            await rateTicket(rtTid, rtVal);
            var stars = '⭐'.repeat(rtVal);
            try { await bot.editMessageText('✅ *شكراً على تقييمك!*\n\n'+stars+'\n\nنسعى دائماً لتقديم أفضل خدمة.', {chat_id:cid,message_id:mid,parse_mode:'Markdown'}); } catch(e){}
            // إشعار المطور بالتقييم
            var ratedTicket = await q('SELECT * FROM tickets WHERE id=?',[rtTid]);
            if (ratedTicket && ratedTicket[0] && ratedTicket[0].claimed_by) {
                try {
                    await bot.sendMessage(ratedTicket[0].claimed_by,
                        '⭐ *تقييم جديد!*\n\n'+'المستخدم قيّمك بـ: '+stars+' ('+rtVal+'/5)',
                        { parse_mode:'Markdown' }
                    );
                } catch(e){}
            }
            return;
        }
        // اقتراح
        if (d === 'suggest') {
            devState[cid] = {action:'suggest'};
            try { await bot.editMessageText('💡 *اقتراح ميزة*\n\n✏️ اكتب اقتراحك الآن:', {chat_id:cid,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'cancel_suggest'}]]}}); } catch(e){}
            return;
        }
        if (d === 'cancel_suggest') {
            devState[cid] = {};
            try { await bot.editMessageText('تم الإلغاء.', {chat_id:cid,message_id:mid}); } catch(e){}
            return;
        }
    }

    // ===== لوحة الأدمنية =====
    async function showAdminPanel(cid, editId) {
        var adms = await getAdmins();
        var txt = '👨‍💼 *إدارة الأدمنية*\n━━━━━━━━━━━━━━━\n👑 المطور: `'+DEV_ID+'` (محمي دائماً)\n';
        var btns = [];
        if (adms.length > 0) {
            txt += '\n📋 *الأدمنية:*\n';
            for (var a of adms) {
                var an = a.name || a.user_id;
                if (a.username) an += ' @'+a.username;
                txt += '• '+an+(a.multi_reply?' 🔓':'')+ ' (`'+a.user_id+'`)\n';
                btns.push([
                    {text:'❌ إزالة '+(a.name||a.user_id), callback_data:'ap_rm_'+a.user_id},
                    {text:(a.multi_reply?'🔒 سحب متعدد':'🔓 منح متعدد'), callback_data:'ap_ml_'+a.user_id}
                ]);
                btns.push([{text:'📊 إحصائيات '+( a.name||a.user_id), callback_data:'as_'+a.user_id}]);
            }
        } else { txt += '\n📭 لا يوجد أدمنية.'; }
        btns.push([{text:'➕ إضافة بالـ ID',callback_data:'ap_addid'},{text:'👥 من المستخدمين',callback_data:'ap_pa_1'}]);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== عرض المستخدمين =====
    async function showUsers(cid, pg, editId) {
        var all = await getAllUsers();
        var pp=8, tp=Math.ceil(all.length/pp)||1;
        pg = Math.max(1,Math.min(pg,tp));
        var page = all.slice((pg-1)*pp, pg*pp);
        var txt = '👥 *المستخدمين* ('+all.length+') | صفحة '+pg+'/'+tp+'\n━━━━━━━━━━━━━━━';
        var btns = [];
        for (var u of page) {
            var lbl = (u.banned?'🚫 ':'')+(u.muted?'🔇 ':'')+(u.id===DEV_ID?'👑 ':'')+(u.verified?'✅ ':'')+( u.name||'بدون اسم')+(u.username?' @'+u.username:'');
            btns.push([{text:lbl, callback_data:'ud_'+u.id}]);
        }
        var nav=[];
        if (pg>1) nav.push({text:'⬅️',callback_data:'ul_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:'ul_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== تفاصيل مستخدم =====
    async function showUserDetail(cid, tid, editId) {
        var u = await getUser(tid);
        if (!u) { await bot.sendMessage(cid,'❌ المستخدم غير موجود.'); return; }
        var mc=0,tm=0,tc=0,ar=0;
        try { var r1=await q('SELECT COUNT(*) c FROM msg_map WHERE user_id=?',[tid]); mc=r1[0]?r1[0].c:0; } catch(e){}
        try { var r2=await q('SELECT COUNT(*) c FROM msg_map WHERE user_id=? AND ts>?',[tid,Date.now()-86400000]); tm=r2[0]?r2[0].c:0; } catch(e){}
        try { var r3=await q('SELECT COUNT(*) c FROM tickets WHERE user_id=?',[tid]); tc=r3[0]?r3[0].c:0; } catch(e){}
        try { var r4=await q('SELECT AVG(rating) a FROM tickets WHERE user_id=? AND rating>0',[tid]); ar=(parseFloat(r4[0]?r4[0].a:0)||0).toFixed(1); } catch(e){}
        var isDevU = String(tid)===DEV_ID;
        var txt = '👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n'
            +(isDevU?'👑 *مطور البوت*\n':'')
            +'📝 الاسم: '+(u.name||'-')+'\n'
            +'🔗 يوزر: '+(u.username?'@'+u.username:'-')+'\n'
            +'🆔 ID: `'+u.id+'`\n'
            +(u.phone?'📱 الهاتف: '+u.phone+'\n':'')
            +'✅ متحقق: '+(u.verified?'نعم':'لا')+'\n'
            +'━━━━━━━━━━━━━━━\n'
            +'📨 الرسائل: '+mc+' | اليوم: '+tm+'\n'
            +'🎫 الطلبات: '+tc+' | ⭐ التقييم: '+ar+'/5\n'
            +'🕒 آخر نشاط: '+ft(u.last_seen)+'\n'
            +'📅 أول دخول: '+ft(u.first_seen)+'\n'
            +'━━━━━━━━━━━━━━━\n'
            +'🚫 محظور: '+(u.banned?'✅':'❌')+' | 🔇 مكتوم: '+(u.muted?'✅':'❌');
        var kb = [];
        if (!isDevU) {
            kb.push([
                {text:u.banned?'🔓 رفع الحظر':'🔨 حظر', callback_data:(u.banned?'ubn_':'bn_')+tid},
                {text:u.muted?'🔊 رفع الكتم':'🔇 كتم', callback_data:(u.muted?'umt_':'mt_')+tid}
            ]);
            if (isDev(cid)) kb.push([{text:'🗑️ حذف وحظر كامل',callback_data:'dstr_'+tid}]);
        }
        kb.push([{text:'💬 مراسلة',callback_data:'r_'+tid}]);
        kb.push([{text:'📜 عرض محادثاته',callback_data:'um_'+tid+'_1'}]);
        kb.push([{text:'🔙 رجوع',callback_data:'ul_1'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:kb}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:kb}});
    }

    // ===== عرض محادثات مستخدم =====
    async function showUserConvo(cid, tid, pg, editId) {
        var u = await getUser(tid);
        var pp=10, total=0, msgs=[];
        try { var tc=await q('SELECT COUNT(*) c FROM msg_map WHERE user_id=?',[tid]); total=tc[0]?tc[0].c:0; } catch(e){}
        var tp=Math.ceil(total/pp)||1;
        pg=Math.max(1,Math.min(pg,tp));
        try { msgs=await q('SELECT * FROM msg_map WHERE user_id=? ORDER BY ts DESC LIMIT ? OFFSET ?',[tid,pp,(pg-1)*pp]); } catch(e){}
        var txt = '📜 *محادثات: '+(u?u.name||tid:tid)+'*\n📊 '+total+' رسالة | صفحة '+pg+'/'+tp+'\n━━━━━━━━━━━━━━━\n\n';
        if (!msgs || msgs.length===0) { txt += '📭 لا توجد رسائل.'; }
        else { for (var m of msgs) txt += '📨 #'+m.id+' | 🕒 '+ft(m.ts)+'\n'; }
        var btns=[];
        var nav=[];
        if (pg>1) nav.push({text:'⬅️',callback_data:'um_'+tid+'_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:'um_'+tid+'_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'💬 مراسلة',callback_data:'r_'+tid}]);
        btns.push([{text:'🔙 ملف المستخدم',callback_data:'ud_'+tid}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== عرض الطلبات المفتوحة =====
    async function showOpenTickets(cid, pg, editId) {
        var pp=5, total=0, tickets=[];
        try { var tc=await q("SELECT COUNT(*) c FROM tickets WHERE status='open'",[]); total=tc[0]?tc[0].c:0; } catch(e){}
        var tp=Math.ceil(total/pp)||1;
        pg=Math.max(1,Math.min(pg,tp));
        try { tickets=await q("SELECT t.*,u.name,u.username FROM tickets t LEFT JOIN users u ON t.user_id=u.id WHERE t.status='open' ORDER BY t.created_at DESC LIMIT ? OFFSET ?",[pp,(pg-1)*pp]); } catch(e){}
        var txt = '🎫 *الطلبات المفتوحة* ('+total+') | صفحة '+pg+'/'+tp+'\n━━━━━━━━━━━━━━━\n\n';
        var btns=[];
        if (!tickets||tickets.length===0) { txt+='📭 لا توجد طلبات.'; }
        else {
            for (var t of tickets) {
                var un = t.name||t.user_id; if (t.username) un+=' @'+t.username;
                var st = t.claimed_by?'🔒 محجوز':'🟢 مفتوح';
                txt += st+' | 👤 '+un+'\n🕒 '+ft(t.created_at)+'\n\n';
                var row = [{text:'👤 '+un, callback_data:'ud_'+t.user_id}];
                if (!t.claimed_by) row.push({text:'🙋 سأتكفل', callback_data:'cl_'+t.user_id+'_'+t.id});
                btns.push(row);
            }
        }
        var nav=[];
        if (pg>1) nav.push({text:'⬅️',callback_data:'to_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:'to_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== عرض الطلبات المحجوزة =====
    async function showClaimedTickets(cid, pg, editId) {
        var pp=5, total=0, tickets=[];
        try { var tc=await q("SELECT COUNT(*) c FROM tickets WHERE status='open' AND claimed_by IS NOT NULL",[]); total=tc[0]?tc[0].c:0; } catch(e){}
        var tp=Math.ceil(total/pp)||1;
        pg=Math.max(1,Math.min(pg,tp));
        try { tickets=await q("SELECT t.*,u.name,u.username,a.name an,a.username au FROM tickets t LEFT JOIN users u ON t.user_id=u.id LEFT JOIN users a ON t.claimed_by=a.id WHERE t.status='open' AND t.claimed_by IS NOT NULL ORDER BY t.claimed_at DESC LIMIT ? OFFSET ?",[pp,(pg-1)*pp]); } catch(e){}
        var txt = '📋 *الطلبات المحجوزة* ('+total+') | صفحة '+pg+'/'+tp+'\n━━━━━━━━━━━━━━━\n\n';
        var btns=[];
        if (!tickets||tickets.length===0) { txt+='📭 لا توجد طلبات محجوزة.'; }
        else {
            for (var t of tickets) {
                var un = t.name||t.user_id; if (t.username) un+=' @'+t.username;
                var an = t.an||t.claimed_by; if (t.au) an+=' @'+t.au;
                txt += '👤 '+un+'\n👨‍🏫 الأستاذ: '+an+'\n🕒 '+ft(t.claimed_at)+'\n\n';
                btns.push([
                    {text:'👤 '+un, callback_data:'ud_'+t.user_id},
                    {text:'↩️ رد', callback_data:'r_'+t.user_id},
                    {text:'✅ إنهاء', callback_data:'dn_'+t.user_id+'_'+t.id}
                ]);
            }
        }
        var nav=[];
        if (pg>1) nav.push({text:'⬅️',callback_data:'tc_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:'tc_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== عرض الاقتراحات =====
    async function showSuggestions(cid, pg, editId) {
        var pp=5, total=0, suggs=[];
        try { var tc=await q("SELECT COUNT(*) c FROM suggestions WHERE status='new'",[]); total=tc[0]?tc[0].c:0; } catch(e){}
        var tp=Math.ceil(total/pp)||1;
        pg=Math.max(1,Math.min(pg,tp));
        try { suggs=await q("SELECT s.*,u.name,u.username FROM suggestions s LEFT JOIN users u ON s.user_id=u.id WHERE s.status='new' ORDER BY s.ts DESC LIMIT ? OFFSET ?",[pp,(pg-1)*pp]); } catch(e){}
        var txt = '💡 *الاقتراحات الجديدة* ('+total+') | صفحة '+pg+'/'+tp+'\n━━━━━━━━━━━━━━━\n\n';
        var btns=[];
        if (!suggs||suggs.length===0) { txt+='📭 لا توجد اقتراحات جديدة.'; }
        else {
            for (var s of suggs) {
                var un = s.name||s.user_id; if (s.username) un+=' @'+s.username;
                txt += '💡 '+s.text+'\n👤 '+un+' | 🕒 '+ft(s.ts)+'\n\n';
                btns.push([
                    {text:'✅ تم', callback_data:'sd_'+s.id},
                    {text:'💬 رد', callback_data:'r_'+s.user_id}
                ]);
            }
        }
        var nav=[];
        if (pg>1) nav.push({text:'⬅️',callback_data:'sg_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:'sg_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
    }

    // ===== بناء أزرار اختيار مستخدم =====
    async function buildPickBtns(prefix, pg, filterFn, pagePrefix) {
        var all = await getAllUsers();
        if (filterFn) all = all.filter(filterFn);
        var pp=8, tp=Math.ceil(all.length/pp)||1;
        pg=Math.max(1,Math.min(pg,tp));
        var page = all.slice((pg-1)*pp, pg*pp);
        var btns=[];
        for (var u of page) {
            var lbl = (u.banned?'🚫 ':'')+(u.name||'بدون اسم')+(u.username?' @'+u.username:'');
            btns.push([{text:lbl, callback_data:prefix+'_'+u.id}]);
        }
        var nav=[];
        var pp2 = pagePrefix||prefix;
        if (pg>1) nav.push({text:'⬅️',callback_data:pp2+'_'+(pg-1)});
        nav.push({text:pg+'/'+tp,callback_data:'noop'});
        if (pg<tp) nav.push({text:'➡️',callback_data:pp2+'_'+(pg+1)});
        if (nav.length>0) btns.push(nav);
        btns.push([{text:'🔙 رجوع',callback_data:'main'}]);
        return {btns, total:all.length};
    }

    // ===== عرض اختيار مستخدم للإجراء =====
    async function showPickUser(cid, editId, action, pg) {
        var titles = {ban:'🔨 اختر مستخدم للحظر:',unban:'🔓 اختر مستخدم لرفع الحظر:',mute:'🔇 اختر مستخدم للكتم:',unmute:'🔊 اختر مستخدم لرفع الكتم:',reply:'💬 اختر مستخدم للمراسلة:'};
        var prefixMap = {ban:'bn',unban:'ubn',mute:'mt',unmute:'umt',reply:'r'};
        var pageMap = {ban:'pb',unban:'pub',mute:'pm',unmute:'pum',reply:'pr'};
        var filterMap = {
            ban: u=>!u.banned&&u.id!==DEV_ID,
            unban: u=>u.banned&&u.id!==DEV_ID,
            mute: u=>!u.muted&&u.id!==DEV_ID,
            unmute: u=>u.muted&&u.id!==DEV_ID,
            reply: u=>u.id!==DEV_ID
        };
        var r = await buildPickBtns(prefixMap[action], pg, filterMap[action], pageMap[action]);
        var txt = titles[action]||'اختر:';
        if (r.total===0) txt += '\n\n⚠️ لا يوجد مستخدمين.';
        if (editId) { try { await bot.editMessageText(txt, {chat_id:cid,message_id:editId,parse_mode:'Markdown',reply_markup:{inline_keyboard:r.btns}}); return; } catch(e){} }
        await bot.sendMessage(cid, txt, {parse_mode:'Markdown',reply_markup:{inline_keyboard:r.btns}});
    }

    // ===== معالجة رسائل المستخدمين =====
    bot.on('message', async (msg) => {
        var cid = msg.chat.id, uid = msg.from.id;
        var username = msg.from.username||'';
        var name = ((msg.from.first_name||'')+ ' '+(msg.from.last_name||'')).trim();

        if (msg.text && msg.text.startsWith('/')) return;
        if (msg.contact) return; // handled separately

        if (isAdmin(uid)) {
            await handleAdminMsg(cid, uid, msg);
            return;
        }

        // تحقق من الحظر والكتم
        var u = await getUser(uid);
        if (!u) { await bot.sendMessage(cid,'أرسل /start أولاً.'); return; }
        if (u.banned) { await bot.sendMessage(cid,'⛔ أنت محظور من البوت.'); return; }
        if (u.muted) { await bot.sendMessage(cid,'🔇 أنت مكتوم حالياً.'); return; }

        // تحقق من التحقق
        if (!u.verified) {
            waitingContact[String(uid)] = true;
            await bot.sendMessage(cid, '🔐 يجب التحقق من هويتك أولاً. أرسل /start.', {reply_markup:{remove_keyboard:true}});
            return;
        }

        // اقتراح
        var state = devState[cid]||{};
        if (state.action === 'suggest') {
            devState[cid] = {};
            var suggText = msg.text||'[محتوى]';
            await q('INSERT INTO suggestions (user_id,text,ts,status) VALUES (?,?,?,?)',[String(uid),suggText,Date.now(),'new']);
            var recs = await getAllAdminIds();
            for (var r of recs) {
                try { await bot.sendMessage(r,'💡 *اقتراح جديد*\n━━━━━━━━━━━━━━━\n👤 '+name+'\n🆔 `'+uid+'`\n\n'+suggText,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💬 رد',callback_data:'r_'+uid}]]}}); } catch(e){}
            }
            await bot.sendMessage(cid,'✅ *شكراً على اقتراحك!*\n\n💡 تم إرسال اقتراحك للمطور.',{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💡 اقتراح آخر',callback_data:'suggest'}]]}});
            return;
        }

        // رسالة عادية
        await upsertUser(uid, username, name);
        var now = Date.now();
        var tid = await createTicket(uid);
        var msgContent = msg.text||(msg.photo?'[صورة]':msg.video?'[فيديو]':msg.document?'[ملف]':msg.voice?'[صوت]':msg.audio?'[صوت]':msg.sticker?'[ملصق]':'[محتوى]');
        if (tid) await saveEvent(tid, uid, 'user', 'message', msgContent);

        var report = '📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n'
            +'👤 '+(name||'بدون اسم')+'\n'
            +'🔗 '+(username?'@'+username:'بدون يوزر')+'\n'
            +'🆔 `'+uid+'`\n'
            +(u.phone?'📱 '+u.phone+'\n':'')
            +'🕒 '+ft(now)+'\n━━━━━━━━━━━━━━━';

        var quickBtns = {inline_keyboard:[
            [{text:'↩️ رد',callback_data:'r_'+uid},{text:'🚫 حظر',callback_data:'bn_'+uid},{text:'🔇 كتم',callback_data:'mt_'+uid}],
            [{text:'🙋 سأتكفل بهذا الطلب',callback_data:'cl_'+uid+'_'+tid}]
        ]};

        var recs = await getAllAdminIds();
        pendingNotify[String(uid)] = {done:false, ts:now};
        var forwarded = false;
        for (var r of recs) {
            try {
                await bot.sendMessage(r, report, {parse_mode:'Markdown'});
                var fwd = await bot.forwardMessage(r, cid, msg.message_id);
                await saveMsgMap(uid, msg.message_id, fwd.message_id, r);
                await bot.sendMessage(r, '⬆️ من: *'+(name||'مستخدم')+'*', {parse_mode:'Markdown',reply_markup:quickBtns});
                forwarded = true;
            } catch(e) { console.log('fwd fail to '+r+': '+e.message); }
        }

        if (forwarded) {
            await bot.sendMessage(cid,
                '✅ *تم استلام رسالتك!*\n\n📬 رسالتك وصلت للأستاذ وسيطلع عليها قريباً.\n⏳ سوف نعلمك فور فتح الأستاذ للمحادثة.',
                {parse_mode:'Markdown'}
            );
        } else {
            await bot.sendMessage(cid,'⚠️ حدث خطأ. حاول مرة أخرى.');
        }
    });

    // ===== معالجة رسائل الأدمن =====
    async function handleAdminMsg(cid, uid, msg) {
        var state = devState[cid]||{};
        if (msg.text && msg.text.startsWith('/')) return;

        // إضافة أدمن بالـ ID
        if (state.action==='add_admin' && isDev(uid)) {
            devState[cid]={};
            var aid = (msg.text||'').trim();
            if (!aid||!/^\d+$/.test(aid)) { await bot.sendMessage(cid,'⚠️ أرسل ID صحيح.',{reply_markup:{inline_keyboard:[[{text:'🔙 رجوع',callback_data:'ap'}]]}}); return; }
            if (String(aid)===DEV_ID) { await bot.sendMessage(cid,'⛔ المطور لا يُضاف كأدمن.'); return; }
            await addAdmin(aid, uid);
            await bot.sendMessage(cid,'✅ تم إضافة `'+aid+'` كأدمن.',{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔙 إدارة الأدمنية',callback_data:'ap'}]]}});
            try { await bot.sendMessage(aid,'🎉 تم تعيينك كأدمن! أرسل /start لفتح لوحة التحكم.'); } catch(e){}
            return;
        }

        // رسالة جماعية
        if (state.action==='broadcast') {
            devState[cid]={};
            var all = (await getAllUsers()).filter(u=>!u.banned);
            var ok=0,fail=0;
            await bot.sendMessage(cid,'📢 جاري الإرسال لـ '+all.length+' مستخدم...');
            for (var u of all) {
                try { await bot.copyMessage(u.id, cid, msg.message_id); ok++; } catch(e) { fail++; }
                await sleep(50);
            }
            await bot.sendMessage(cid,'✅ تم! نجح: '+ok+' | فشل: '+fail,{reply_markup:{inline_keyboard:[[{text:'🔙 لوحة التحكم',callback_data:'main'}]]}});
            return;
        }

        // تحديث - رسالة المستخدمين
        if (state.action==='upd_users' && isDev(uid)) {
            devState[cid] = {action:'upd_admins', upd_users: msg.text==='-'?null:msg.text};
            await bot.sendMessage(cid,'📣 الخطوة 2/2: اكتب رسالة التحديث للأدمنية:\n(أو أرسل "-" لتخطي)',{reply_markup:{inline_keyboard:[[{text:'❌ إلغاء',callback_data:'main'}]]}});
            return;
        }

        // تحديث - رسالة الأدمنية
        if (state.action==='upd_admins' && isDev(uid)) {
            var uMsg = state.upd_users;
            var aMsg = msg.text==='-'?null:msg.text;
            devState[cid]={};
            await q('INSERT INTO bot_updates (msg_users,msg_admins,created_at,sent) VALUES (?,?,?,0)',[uMsg,aMsg,Date.now()]);
            // إرسال فوري للجميع
            var allU = await getAllUsers();
            var allAdm = await getAllAdminIds();
            var ok2=0;
            for (var u2 of allU) {
                if (!u2.banned && uMsg) {
                    try {
                        await bot.sendMessage(u2.id,
                            '🔔 *تحديث جديد للبوت!*\n━━━━━━━━━━━━━━━\n'+uMsg+'\n\n_اضغط /start لرؤية التحديث_',
                            {parse_mode:'Markdown'}
                        );
                        ok2++;
                    } catch(e){}
                    await sleep(50);
                }
            }
            for (var a2 of allAdm) {
                if (aMsg) {
                    try { await bot.sendMessage(a2,'🔔 *تحديث للأدمنية!*\n━━━━━━━━━━━━━━━\n'+aMsg,{parse_mode:'Markdown'}); } catch(e){}
                }
            }
            await q("UPDATE bot_updates SET sent=1 WHERE sent=0",[]);
            await bot.sendMessage(cid,'✅ تم إرسال التحديث لـ '+ok2+' مستخدم.',{reply_markup:{inline_keyboard:[[{text:'🔙 لوحة التحكم',callback_data:'main'}]]}});
            return;
        }

        // رد على مستخدم (من الحالة)
        if (state.action==='reply' && state.target) {
            var target = state.target;
            devState[cid]={};
            var ok3 = await canReply(uid, target);
            if (!ok3) { await bot.sendMessage(cid,'⛔ لا يمكنك الرد على هذا الطلب.'); return; }
            try {
                await bot.copyMessage(target, cid, msg.message_id);
                var tk = await getOpenTicket(target);
                if (tk) await saveEvent(tk.id, uid, 'admin', 'message', msg.text||'[محتوى]');
                try { await bot.sendMessage(target,'💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.',{parse_mode:'Markdown'}); } catch(e){}
                await bot.sendMessage(cid,'✅ تم إرسال الرد لـ `'+target+'`',{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
                    [{text:'↩️ رد آخر',callback_data:'r_'+target}],
                    [{text:'🔙 لوحة التحكم',callback_data:'main'}]
                ]}});
            } catch(err) {
                await bot.sendMessage(cid,'❌ فشل: '+err.message,{reply_markup:{inline_keyboard:[[{text:'🔙 لوحة التحكم',callback_data:'main'}]]}});
            }
            return;
        }

        // رد عبر Reply على رسالة محولة
        if (msg.reply_to_message) {
            var tuid = await getUserByFwd(msg.reply_to_message.message_id, cid);
            if (tuid) {
                var ok4 = await canReply(uid, tuid);
                if (!ok4) { await bot.sendMessage(cid,'⛔ هذا الطلب محجوز من أدمن آخر.'); return; }
                try {
                    await bot.copyMessage(tuid, cid, msg.message_id);
                    var tk2 = await getOpenTicket(tuid);
                    if (tk2) await saveEvent(tk2.id, uid, 'admin', 'message', msg.text||'[محتوى]');
                    try { await bot.sendMessage(tuid,'💬 *وصلك رد من الأستاذ*\n\n⬇️ الرد أعلاه من الأستاذ المختص.',{parse_mode:'Markdown'}); } catch(e){}
                    await bot.sendMessage(cid,'✅ تم إرسال الرد.',{reply_markup:{inline_keyboard:[
                        [{text:'↩️ رد آخر',callback_data:'r_'+tuid}],
                        [{text:'🔙 لوحة التحكم',callback_data:'main'}]
                    ]}});
                } catch(err) { await bot.sendMessage(cid,'❌ فشل: '+err.message); }
                return;
            }
        }

        await sendMenu(cid);
    }

    console.log('✅ البوت جاهز تماماً');
}

// ===== Express + Keep-Alive =====
var app = express();
var port = process.env.PORT||3000;
var serverUrl = process.env.RENDER_EXTERNAL_URL||('http://localhost:'+port);
app.get('/', (req,res) => res.send('🎓 Teachers Bot Running!'));
app.get('/health', (req,res) => res.json({status:'ok',time:new Date().toISOString()}));
app.listen(port, () => {
    console.log('✅ Port '+port);
    setInterval(() => {
        var url = serverUrl+'/health';
        var prot = url.startsWith('https')?https:http;
        prot.get(url, r => console.log('🔄 keep-alive: '+r.statusCode)).on('error', e => console.log('⚠️ '+e.message));
    }, 14*60*1000);
});

startBot().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
