// ============================================================
// 🤖 بوت التواصل الاجتماعي المتطور (نسخة مطورة بالكامل)
// ============================================================
// المميزات المضافة:
// 1. إزالة ChatGPT بالكامل وتحويله لبوت تواصل.
// 2. نظام قواعد بيانات متكامل (MySQL) لحفظ كل شيء.
// 3. لوحة تحكم متطورة للمطور (إحصائيات، إدارة مستخدمين، مجموعات).
// 4. نظام مراسلة جماعي (بث) مع "بصمة هوية" للحفاظ على الخصوصية.
// 5. نظام ردود متسلسل في البث الجماعي.
// 6. تتبع الـ IP، اليوزر، ومعلومات المجموعات (أعضاء، مسؤولين، رسائل).
// 7. نظام دعم واقتراحات متطور.
// 8. ميزة مراسلة مستخدم معين (للمطور).
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// ===== إعدادات البوت (يرجى التأكد من صحتها) =====
const BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const DEVELOPER_ID = '7411444902';

// ===== إعدادات قاعدة البيانات =====
const DB_CONFIG = {
    host: 'sql5.freesqldatabase.com',
    user: 'sql5822025',
    password: 'UHrehHF1CU',
    database: 'sql5822025',
    port: 3306,
    connectTimeout: 30000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

let pool = null;

// حالة البوت لتخزين وضع المستخدم الحالي
const userState = new Map(); // key: userId, value: { action: string, data: any }

// ===== إنشاء اتصال قاعدة البيانات =====
async function initDB() {
    try {
        pool = mysql.createPool(DB_CONFIG);
        const conn = await pool.getConnection();
        console.log('✅ متصل بقاعدة البيانات بنجاح');

        // 1. جدول المستخدمين
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(255) DEFAULT '',
                name VARCHAR(500) DEFAULT '',
                anon_fingerprint VARCHAR(50) UNIQUE,
                first_seen BIGINT DEFAULT 0,
                last_seen BIGINT DEFAULT 0,
                messages_count INT DEFAULT 0,
                banned TINYINT(1) DEFAULT 0,
                muted TINYINT(1) DEFAULT 0,
                ip VARCHAR(45) DEFAULT NULL,
                device_info TEXT DEFAULT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // 2. جدول المجموعات
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS groups (
                id BIGINT PRIMARY KEY,
                title VARCHAR(255) DEFAULT '',
                members_count INT DEFAULT 0,
                admins_count INT DEFAULT 0,
                messages_count INT DEFAULT 0,
                added_at BIGINT NOT NULL,
                last_active BIGINT DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // 3. جدول رسائل البث الجماعي (المراسلة بين الأعضاء)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS broadcast_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id VARCHAR(50) NOT NULL,
                anon_fingerprint VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT NOT NULL,
                parent_id INT DEFAULT NULL,
                INDEX idx_parent (parent_id),
                INDEX idx_sender (sender_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // 4. جدول تذاكر الدعم والاقتراحات
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('open', 'replied', 'closed') DEFAULT 'open',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // 5. جدول سجل المحادثات الخاصة (للمطور فقط)
        await conn.execute(`
            CREATE TABLE IF NOT EXISTS private_chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                role ENUM('user', 'bot') NOT NULL,
                content TEXT NOT NULL,
                ts BIGINT NOT NULL,
                INDEX idx_user (user_id)
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        conn.release();
        console.log('✅ الجداول جاهزة');
    } catch (e) {
        console.error('❌ خطأ في تهيئة قاعدة البيانات:', e.message);
        process.exit(1);
    }
}

// ===== دوال مساعدة لقاعدة البيانات =====
async function query(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (e) {
        console.error(`❌ خطأ في الاستعلام (${sql}):`, e.message);
        return [];
    }
}

// توليد بصمة هوية فريدة للمستخدم (مثلاً: مستخدم #A1B2)
function generateFingerprint() {
    return 'مستخدم #' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

async function getOrRegisterUser(msg) {
    const userId = String(msg.from.id);
    const username = msg.from.username || '';
    const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
    const now = Date.now();
    
    let user = (await query('SELECT * FROM users WHERE id = ?', [userId]))[0];
    
    if (!user) {
        const fingerprint = generateFingerprint();
        await query(
            'INSERT INTO users (id, username, name, anon_fingerprint, first_seen, last_seen, messages_count) VALUES (?, ?, ?, ?, ?, ?, 1)',
            [userId, username, fullName, fingerprint, now, now]
        );
        user = { id: userId, username, name: fullName, anon_fingerprint: fingerprint, banned: 0, muted: 0 };
    } else {
        await query(
            'UPDATE users SET last_seen = ?, messages_count = messages_count + 1, username = ?, name = ? WHERE id = ?',
            [now, username, fullName, userId]
        );
    }
    return user;
}

async function updateGroupInfo(chat) {
    if (chat.type === 'private') return;
    const now = Date.now();
    const groupId = chat.id;
    const title = chat.title || '';
    
    // محاولة الحصول على عدد الأعضاء والمسؤولين (قد تفشل إذا لم يكن البوت مسؤولاً)
    let membersCount = 0;
    let adminsCount = 0;
    try {
        membersCount = await bot.getChatMemberCount(groupId);
        const admins = await bot.getChatAdministrators(groupId);
        adminsCount = admins.length;
    } catch (e) {}

    const exists = (await query('SELECT id FROM groups WHERE id = ?', [groupId]))[0];
    if (!exists) {
        await query(
            'INSERT INTO groups (id, title, members_count, admins_count, added_at, last_active) VALUES (?, ?, ?, ?, ?, ?)',
            [groupId, title, membersCount, adminsCount, now, now]
        );
    } else {
        await query(
            'UPDATE groups SET title = ?, members_count = ?, admins_count = ?, last_active = ?, messages_count = messages_count + 1 WHERE id = ?',
            [title, membersCount, adminsCount, now, groupId]
        );
    }
}

// ===== واجهات المستخدم (Keyboards) =====
const MAIN_MENU_USER = {
    inline_keyboard: [
        [{ text: '📢 مراسلة الأعضاء (بث)', callback_data: 'user_broadcast' }],
        [{ text: '💬 اقتراح ميزة / دعم', callback_data: 'user_support' }],
        [{ text: '👤 ملفي الشخصي', callback_data: 'user_profile' }, { text: '👥 المجموعات', callback_data: 'user_groups' }]
    ]
};

const MAIN_MENU_DEV = {
    inline_keyboard: [
        [{ text: '📊 إحصائيات عامة', callback_data: 'dev_stats' }],
        [{ text: '👥 إدارة المستخدمين', callback_data: 'dev_users_1' }, { text: '🏢 إدارة المجموعات', callback_data: 'dev_groups_1' }],
        [{ text: '📩 تذاكر الدعم', callback_data: 'dev_tickets_1' }],
        [{ text: '📢 إرسال بث رسمي', callback_data: 'dev_broadcast' }]
    ]
};

// ===== تشغيل البوت =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

async function start() {
    await initDB();
    console.log('🚀 البوت يعمل الآن...');

    // معالجة الرسائل النصية
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const userId = String(msg.from.id);
        const text = msg.text;

        // تحديث بيانات المجموعة إذا كانت الرسالة من مجموعة
        if (msg.chat.type !== 'private') {
            await updateGroupInfo(msg.chat);
        }

        // تسجيل المستخدم وتحديث بياناته
        const user = await getOrRegisterUser(msg);
        if (user.banned && userId !== DEVELOPER_ID) return;

        // الأوامر الأساسية
        if (text === '/start' || text === '/panel') {
            if (userId === DEVELOPER_ID) {
                return bot.sendMessage(chatId, '👋 أهلاً بك أيها المطور في لوحة التحكم المتطورة.', { reply_markup: MAIN_MENU_DEV });
            } else {
                return bot.sendMessage(chatId, `👋 أهلاً بك ${user.name} في بوت التواصل الاجتماعي.\n\nبصمتك الفريدة: \`${user.anon_fingerprint}\`\n\nاستخدم القائمة أدناه للتفاعل:`, { parse_mode: 'Markdown', reply_markup: MAIN_MENU_USER });
            }
        }

        // معالجة الحالات (States)
        const state = userState.get(userId);
        if (state) {
            if (text === '/cancel') {
                userState.delete(userId);
                return bot.sendMessage(chatId, '❌ تم إلغاء العملية.');
            }

            if (state.action === 'broadcast_input') {
                // إرسال رسالة بث للأعضاء
                if (user.muted) return bot.sendMessage(chatId, '🔇 أنت مكتوم من إرسال البث.');
                
                const broadcastId = (await query(
                    'INSERT INTO broadcast_messages (sender_id, anon_fingerprint, content, ts) VALUES (?, ?, ?, ?)',
                    [userId, user.anon_fingerprint, text, Date.now()]
                )).insertId;

                userState.delete(userId);
                bot.sendMessage(chatId, '✅ تم إرسال رسالتك لجميع الأعضاء بنجاح!');

                // إرسال للجميع (بشكل غير متزامن لتجنب البطء)
                const allUsers = await query('SELECT id FROM users WHERE banned = 0 AND id != ?', [userId]);
                for (const u of allUsers) {
                    bot.sendMessage(u.id, `📢 *رسالة جديدة من ${user.anon_fingerprint}:*\n\n${text}\n\n_للرد على هذه الرسالة، اضغط على الزر أدناه._`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '↩️ رد على الرسالة', callback_data: `reply_br_${broadcastId}` }]] }
                    }).catch(() => {});
                }
                return;
            }

            if (state.action === 'reply_input') {
                const parentId = state.data.parentId;
                const parentMsg = (await query('SELECT * FROM broadcast_messages WHERE id = ?', [parentId]))[0];
                
                if (!parentMsg) {
                    userState.delete(userId);
                    return bot.sendMessage(chatId, '❌ الرسالة الأصلية لم تعد موجودة.');
                }

                await query(
                    'INSERT INTO broadcast_messages (sender_id, anon_fingerprint, content, ts, parent_id) VALUES (?, ?, ?, ?, ?)',
                    [userId, user.anon_fingerprint, text, Date.now(), parentId]
                );

                userState.delete(userId);
                bot.sendMessage(chatId, '✅ تم إرسال ردك بنجاح!');

                // إشعار صاحب الرسالة الأصلية
                bot.sendMessage(parentMsg.sender_id, `↩️ *وصلك رد جديد من ${user.anon_fingerprint} على رسالتك:*\n\n_${parentMsg.content}_\n\n*الرد:* ${text}`, { parse_mode: 'Markdown' }).catch(() => {});
                return;
            }

            if (state.action === 'support_input') {
                await query(
                    'INSERT INTO support_tickets (user_id, message, created_at, updated_at) VALUES (?, ?, ?, ?)',
                    [userId, text, Date.now(), Date.now()]
                );
                userState.delete(userId);
                bot.sendMessage(chatId, '✅ تم إرسال اقتراحك/طلبك للمطور بنجاح. سنرد عليك قريباً.');
                bot.sendMessage(DEVELOPER_ID, `📩 *تذكرة دعم جديدة من ${user.name} (@${user.username}):*\n\n${text}`, { parse_mode: 'Markdown' });
                return;
            }

            if (state.action === 'dev_broadcast_input' && userId === DEVELOPER_ID) {
                const allUsers = await query('SELECT id FROM users');
                userState.delete(userId);
                bot.sendMessage(chatId, `📢 بدأ إرسال البث الرسمي لـ ${allUsers.length} مستخدم...`);
                let success = 0;
                for (const u of allUsers) {
                    try {
                        await bot.sendMessage(u.id, `📢 *رسالة إدارية رسمية:*\n\n${text}`, { parse_mode: 'Markdown' });
                        success++;
                    } catch (e) {}
                }
                return bot.sendMessage(chatId, `✅ اكتمل البث.\nتم الإرسال بنجاح لـ: ${success}\nفشل: ${allUsers.length - success}`);
            }

            if (state.action === 'dev_msg_user' && userId === DEVELOPER_ID) {
                const targetId = state.data.targetId;
                userState.delete(userId);
                try {
                    await bot.sendMessage(targetId, `💬 *رسالة خاصة من المطور:*\n\n${text}`, { parse_mode: 'Markdown' });
                    bot.sendMessage(chatId, '✅ تم إرسال الرسالة للمستخدم.');
                } catch (e) {
                    bot.sendMessage(chatId, '❌ فشل إرسال الرسالة. قد يكون المستخدم حظر البوت.');
                }
                return;
            }
        }

        // حفظ المحادثات الخاصة (للمطور)
        if (msg.chat.type === 'private') {
            await query('INSERT INTO private_chats (user_id, role, content, ts) VALUES (?, ?, ?, ?)', [userId, 'user', text, Date.now()]);
        }
    });

    // معالجة الأزرار (Callback Queries)
    bot.on('callback_query', async (callbackQuery) => {
        const chatId = callbackQuery.message.chat.id;
        const userId = String(callbackQuery.from.id);
        const data = callbackQuery.data;
        const msgId = callbackQuery.message.message_id;

        await bot.answerCallbackQuery(callbackQuery.id);

        // --- أزرار المستخدم ---
        if (data === 'user_broadcast') {
            userState.set(userId, { action: 'broadcast_input' });
            return bot.sendMessage(chatId, '📢 *وضع مراسلة الأعضاء*\n\nاكتب رسالتك الآن وسيتم إرسالها لجميع مستخدمي البوت.\n(لإلغاء العملية اكتب /cancel)', { parse_mode: 'Markdown' });
        }

        if (data.startsWith('reply_br_')) {
            const parentId = data.split('_')[2];
            userState.set(userId, { action: 'reply_input', data: { parentId } });
            return bot.sendMessage(chatId, '↩️ اكتب ردك الآن على هذه الرسالة:', { parse_mode: 'Markdown' });
        }

        if (data === 'user_support') {
            userState.set(userId, { action: 'support_input' });
            return bot.sendMessage(chatId, '💬 *إرسال اقتراح أو دعم*\n\nاكتب ما تريد إرساله للمطور (اقتراح ميزة، مشكلة، إلخ):', { parse_mode: 'Markdown' });
        }

        if (data === 'user_profile') {
            const user = (await query('SELECT * FROM users WHERE id = ?', [userId]))[0];
            const text = `👤 *ملفك الشخصي:*\n\n📝 الاسم: ${user.name}\n🔗 اليوزر: @${user.username || 'لا يوجد'}\n🆔 المعرف: \`${user.id}\`\n🛡️ البصمة: \`${user.anon_fingerprint}\`\n📨 رسائلك: ${user.messages_count}\n🕒 أول ظهور: ${new Date(Number(user.first_seen)).toLocaleDateString('ar-EG')}`;
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }

        if (data === 'user_groups') {
            const groups = await query('SELECT * FROM groups ORDER BY last_active DESC LIMIT 10');
            let text = '👥 *أحدث المجموعات التي يتواجد فيها البوت:*\n\n';
            if (groups.length === 0) text += 'لا توجد مجموعات مسجلة بعد.';
            for (const g of groups) {
                text += `📌 ${g.title}\n👥 الأعضاء: ${g.members_count} | 💬 الرسائل: ${g.messages_count}\n\n`;
            }
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }

        // --- أزرار المطور ---
        if (userId !== DEVELOPER_ID) return;

        if (data === 'dev_stats') {
            const uCount = (await query('SELECT COUNT(*) as c FROM users'))[0].c;
            const gCount = (await query('SELECT COUNT(*) as c FROM groups'))[0].c;
            const mCount = (await query('SELECT SUM(messages_count) as c FROM users'))[0].c;
            const bCount = (await query('SELECT COUNT(*) as c FROM broadcast_messages'))[0].c;
            
            const text = `📊 *إحصائيات البوت العامة:*\n\n👥 عدد المستخدمين: ${uCount}\n🏢 عدد المجموعات: ${gCount}\n💬 إجمالي رسائل المستخدمين: ${mCount || 0}\n📢 إجمالي رسائل البث: ${bCount}\n\nتم التحديث: ${new Date().toLocaleString('ar-EG')}`;
            return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'dev_main' }]] } });
        }

        if (data === 'dev_main') {
            return bot.editMessageText('👋 أهلاً بك أيها المطور في لوحة التحكم المتطورة.', { chat_id: chatId, message_id: msgId, reply_markup: MAIN_MENU_DEV });
        }

        if (data.startsWith('dev_users_')) {
            const page = parseInt(data.split('_')[2]);
            const offset = (page - 1) * 5;
            const users = await query('SELECT * FROM users ORDER BY last_seen DESC LIMIT 5 OFFSET ?', [offset]);
            const total = (await query('SELECT COUNT(*) as c FROM users'))[0].c;
            
            let text = `👥 *إدارة المستخدمين (صفحة ${page}):*\nإجمالي المستخدمين: ${total}\n\n`;
            const buttons = [];
            for (const u of users) {
                text += `👤 ${u.name} (@${u.username || 'N/A'})\n🆔 \`${u.id}\` | 🛡️ ${u.anon_fingerprint}\n\n`;
                buttons.push([{ text: `إدارة: ${u.name}`, callback_data: `manage_u_${u.id}` }]);
            }
            
            const nav = [];
            if (page > 1) nav.push({ text: '⬅️ السابق', callback_data: `dev_users_${page - 1}` });
            if (offset + 5 < total) nav.push({ text: 'التالي ➡️', callback_data: `dev_users_${page + 1}` });
            if (nav.length > 0) buttons.push(nav);
            buttons.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);
            
            return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        }

        if (data.startsWith('manage_u_')) {
            const uId = data.split('_')[2];
            const u = (await query('SELECT * FROM users WHERE id = ?', [uId]))[0];
            const text = `🛠️ *إدارة المستخدم:* ${u.name}\n🆔 \`${u.id}\`\n🚫 الحالة: ${u.banned ? 'محظور' : 'نشط'}\n🔇 الكتم: ${u.muted ? 'مكتوم' : 'لا'}`;
            const buttons = [
                [{ text: u.banned ? '✅ إلغاء الحظر' : '🚫 حظر المستخدم', callback_data: `toggle_ban_${uId}` }],
                [{ text: u.muted ? '🔊 إلغاء الكتم' : '🔇 كتم من البث', callback_data: `toggle_mute_${uId}` }],
                [{ text: '💬 مراسلة خاصة', callback_data: `msg_u_${uId}` }],
                [{ text: '🔙 رجوع للقائمة', callback_data: 'dev_users_1' }]
            ];
            return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        }

        if (data.startsWith('toggle_ban_')) {
            const uId = data.split('_')[2];
            await query('UPDATE users SET banned = 1 - banned WHERE id = ?', [uId]);
            return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ تم تغيير حالة الحظر' });
        }

        if (data.startsWith('toggle_mute_')) {
            const uId = data.split('_')[2];
            await query('UPDATE users SET muted = 1 - muted WHERE id = ?', [uId]);
            return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ تم تغيير حالة الكتم' });
        }

        if (data.startsWith('msg_u_')) {
            const uId = data.split('_')[2];
            userState.set(DEVELOPER_ID, { action: 'dev_msg_user', data: { targetId: uId } });
            return bot.sendMessage(chatId, '💬 اكتب الرسالة التي تريد إرسالها لهذا المستخدم:');
        }

        if (data.startsWith('dev_groups_')) {
            const page = parseInt(data.split('_')[2]);
            const offset = (page - 1) * 5;
            const groups = await query('SELECT * FROM groups ORDER BY last_active DESC LIMIT 5 OFFSET ?', [offset]);
            const total = (await query('SELECT COUNT(*) as c FROM groups'))[0].c;
            
            let text = `🏢 *إدارة المجموعات (صفحة ${page}):*\nإجمالي المجموعات: ${total}\n\n`;
            const buttons = [];
            for (const g of groups) {
                text += `📌 ${g.title}\n🆔 \`${g.id}\`\n👥 الأعضاء: ${g.members_count} | 👮 المسؤولين: ${g.admins_count}\n💬 الرسائل: ${g.messages_count}\n\n`;
                buttons.push([{ text: `مغادرة: ${g.title}`, callback_data: `leave_g_${g.id}` }]);
            }
            
            const nav = [];
            if (page > 1) nav.push({ text: '⬅️ السابق', callback_data: `dev_groups_${page - 1}` });
            if (offset + 5 < total) nav.push({ text: 'التالي ➡️', callback_data: `dev_groups_${page + 1}` });
            if (nav.length > 0) buttons.push(nav);
            buttons.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);
            
            return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        }

        if (data.startsWith('leave_g_')) {
            const gId = data.split('_')[2];
            try {
                await bot.leaveChat(gId);
                await query('DELETE FROM groups WHERE id = ?', [gId]);
                bot.answerCallbackQuery(callbackQuery.id, { text: '✅ غادر البوت المجموعة وتم حذف بياناتها' });
            } catch (e) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '❌ فشل مغادرة المجموعة' });
            }
        }

        if (data === 'dev_broadcast') {
            userState.set(DEVELOPER_ID, { action: 'dev_broadcast_input' });
            return bot.sendMessage(chatId, '📢 اكتب الرسالة الرسمية التي تريد إرسالها لجميع مستخدمي البوت:');
        }

        if (data.startsWith('dev_tickets_')) {
            const tickets = await query('SELECT * FROM support_tickets WHERE status = "open" ORDER BY created_at DESC LIMIT 10');
            let text = '📩 *تذاكر الدعم المفتوحة:*\n\n';
            if (tickets.length === 0) text += 'لا توجد تذاكر مفتوحة حالياً.';
            const buttons = [];
            for (const t of tickets) {
                text += `🎫 #${t.id} | من: \`${t.user_id}\`\n📝 ${t.message.substring(0, 30)}...\n\n`;
                buttons.push([{ text: `رد على #${t.id}`, callback_data: `reply_t_${t.id}` }]);
            }
            buttons.push([{ text: '🔙 رجوع', callback_data: 'dev_main' }]);
            return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        }

        if (data.startsWith('reply_t_')) {
            const tId = data.split('_')[2];
            const t = (await query('SELECT * FROM support_tickets WHERE id = ?', [tId]))[0];
            userState.set(DEVELOPER_ID, { action: 'dev_msg_user', data: { targetId: t.user_id } });
            await query('UPDATE support_tickets SET status = "replied", updated_at = ? WHERE id = ?', [Date.now(), tId]);
            return bot.sendMessage(chatId, `💬 اكتب ردك على تذكرة المستخدم (\`${t.user_id}\`):\n\nرسالته: ${t.message}`);
        }
    });
}

start().catch(console.error);
