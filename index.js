const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const mysql = require('mysql2/promise');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var OPENAI_API_KEY = process.env.OPENAI_API_KEY || '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';
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
                first_seen BIGINT DEFAULT 0,
                last_seen BIGINT DEFAULT 0,
                messages_count INT DEFAULT 0,
                last_reminder BIGINT DEFAULT 0,
                banned TINYINT(1) DEFAULT 0,
                muted TINYINT(1) DEFAULT 0
            ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);

        // جدول المحادثات
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

        conn.release();
        console.log('✅ تم تهيئة جداول قاعدة البيانات');
    } catch (e) {
        console.error('❌ خطأ في تهيئة الجداول:', e.message);
    }
}

// ===== دالة تنفيذ استعلام مع إعادة المحاولة =====
async function query(sql, params) {
    var maxRetries = 3;
    for (var i = 0; i < maxRetries; i++) {
        try {
            var [rows] = await pool.execute(sql, params || []);
            return rows;
        } catch (e) {
            if (i === maxRetries - 1) throw e;
            console.log('إعادة محاولة الاستعلام...');
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
    } catch (e) {
        console.error('getUser error:', e.message);
        return null;
    }
}

async function getAllUsers() {
    try {
        var rows = await query('SELECT * FROM users ORDER BY last_seen DESC', []);
        return rows.map(function(u) {
            u.banned = u.banned === 1;
            u.muted = u.muted === 1;
            return u;
        });
    } catch (e) {
        console.error('getAllUsers error:', e.message);
        return [];
    }
}

async function updateUserData(userId, userName, fullName) {
    var now = Date.now();
    try {
        var existing = await getUser(userId);
        if (!existing) {
            await query(
                'INSERT INTO users (id, username, name, first_seen, last_seen, messages_count, last_reminder, banned, muted) VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0)',
                [String(userId), userName || '', fullName || '', now, now]
            );
        } else {
            await query(
                'UPDATE users SET last_seen=?, messages_count=messages_count+1, username=?, name=? WHERE id=?',
                [now, userName || existing.username || '', fullName || existing.name || '', String(userId)]
            );
        }
    } catch (e) {
        console.error('updateUserData error:', e.message);
    }
}

async function setUserField(userId, field, value) {
    try {
        await query('UPDATE users SET ' + field + '=? WHERE id=?', [value, String(userId)]);
    } catch (e) {
        console.error('setUserField error:', e.message);
    }
}

async function deleteUser(userId) {
    try {
        await query('DELETE FROM users WHERE id=?', [String(userId)]);
        await query('DELETE FROM chats WHERE user_id=?', [String(userId)]);
    } catch (e) {
        console.error('deleteUser error:', e.message);
    }
}

// ===== دوال المحادثات =====
async function getChatHistory(userId) {
    try {
        var rows = await query('SELECT role, content, ts FROM chats WHERE user_id=? ORDER BY ts ASC, id ASC', [String(userId)]);
        return rows;
    } catch (e) {
        console.error('getChatHistory error:', e.message);
        return [];
    }
}

async function addToHistory(userId, role, content) {
    try {
        var now = Date.now();
        await query('INSERT INTO chats (user_id, role, content, ts) VALUES (?, ?, ?, ?)', [String(userId), role, String(content), now]);
        // نحتفظ بآخر 50 رسالة فقط
        await query(
            'DELETE FROM chats WHERE user_id=? AND id NOT IN (SELECT id FROM (SELECT id FROM chats WHERE user_id=? ORDER BY ts DESC, id DESC LIMIT 50) t)',
            [String(userId), String(userId)]
        );
    } catch (e) {
        console.error('addToHistory error:', e.message);
    }
}

async function clearHistory(userId) {
    try {
        await query('DELETE FROM chats WHERE user_id=?', [String(userId)]);
    } catch (e) {
        console.error('clearHistory error:', e.message);
    }
}

async function getChatCount(userId) {
    try {
        var rows = await query('SELECT COUNT(*) as cnt FROM chats WHERE user_id=?', [String(userId)]);
        return rows[0].cnt;
    } catch (e) {
        return 0;
    }
}

// ===== دوال مساعدة =====
function formatTime(ts) { return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' }); }
function getUserDisplayName(u) { var n = u.name || 'بدون اسم'; if (u.username) n += ' (@' + u.username + ')'; return n; }

// ===== دالة استدعاء OpenAI API =====
function callOpenAI(endpoint, body) {
    return new Promise(function(resolve, reject) {
        var postData = JSON.stringify(body);
        var options = {
            hostname: 'api.openai.com',
            port: 443,
            path: endpoint,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPENAI_API_KEY,
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('فشل تحليل الرد: ' + data.substring(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, function() { req.destroy(); reject(new Error('انتهت المهلة')); });
        req.write(postData);
        req.end();
    });
}

// ===== دالة تحميل ملف من تليجرام =====
function downloadTelegramFile(fileId) {
    return new Promise(function(resolve, reject) {
        bot.getFileLink(fileId).then(function(url) {
            var protocol = url.startsWith('https') ? https : http;
            protocol.get(url, function(res) {
                var chunks = [];
                res.on('data', function(chunk) { chunks.push(chunk); });
                res.on('end', function() { resolve(Buffer.concat(chunks)); });
            }).on('error', reject);
        }).catch(reject);
    });
}

async function getFileBase64(fileId) {
    var buffer = await downloadTelegramFile(fileId);
    return buffer.toString('base64');
}

// ===== الرسالة النظامية - هوية لبيب AI =====
var SYSTEM_PROMPT = `أنت مساعد ذكي متعدد المهارات اسمك "لبيب". أنت تتحدث العربية بطلاقة وتفهم كل اللغات.
أنت خبير في كل المجالات: البرمجة، التصميم، الشبكات، التعليم، الطب، القانون، الأعمال، وكل شيء آخر.
أجب بشكل مفصل ومفيد. استخدم الإيموجي بشكل معتدل.

قواعد مهمة جداً:
- اسمك "لبيب" فقط، لا تذكر أبداً ChatGPT أو OpenAI أو GPT أو أي شركة ذكاء اصطناعي
- إذا سألك أحد "من طورك؟" أو "من صنعك؟" أو "من برمجك؟" أو أي سؤال مشابه، قل فقط: "أنا لبيب، مساعد ذكي طوره فريق متخصص"
- إذا سألك "هل أنت ChatGPT؟" أو "هل أنت من OpenAI؟" قل: "لا، أنا لبيب، مساعد ذكي مستقل"
- تصرف كشخص طبيعي ذكي، لا تقل أنك نموذج لغوي أو AI
- إذا ذكر أحد اسم "لبيب" في سياق التعرف عليك، تفاعل معه بشكل طبيعي`;

var DEEP_THINK_PROMPT = `أنت لبيب، مساعد ذكي متخصص في التحليل العميق والتفكير النقدي.
عند الإجابة:
1. حلل الموضوع من جميع الزوايا والأبعاد
2. قدم حججاً وأدلة منطقية
3. اذكر الإيجابيات والسلبيات
4. قدم خلاصة واضحة وتوصيات عملية
5. استخدم أمثلة واقعية

قواعد الهوية: اسمك "لبيب" فقط، لا تذكر ChatGPT أو OpenAI أبداً.`;

// ===== دالة الرد بالذكاء الاصطناعي =====
async function chatWithGPT(userId, userMessage, deepThink) {
    var history = await getChatHistory(userId);
    await addToHistory(userId, 'user', userMessage);

    var sysPrompt = deepThink ? DEEP_THINK_PROMPT : SYSTEM_PROMPT;
    var messages = [{ role: 'system', content: sysPrompt }];
    var recentHistory = history.slice(-40);
    for (var i = 0; i < recentHistory.length; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
    }
    // أضف رسالة المستخدم الحالية
    messages.push({ role: 'user', content: userMessage });

    try {
        // نجرب gpt-4o-mini أولاً، وإذا فشل نجرب gpt-3.5-turbo
        var modelsToTry = ['gpt-4o-mini', 'gpt-3.5-turbo'];
        var response = null;
        var lastErr = null;
        for (var mi = 0; mi < modelsToTry.length; mi++) {
            try {
                response = await callOpenAI('/v1/chat/completions', {
                    model: modelsToTry[mi],
                    messages: messages,
                    max_tokens: 4096,
                    temperature: deepThink ? 0.9 : 0.7
                });
                if (!response.error) break; // نجح
                lastErr = response.error.message || JSON.stringify(response.error);
                console.error('OpenAI model ' + modelsToTry[mi] + ' error:', lastErr);
            } catch (e) {
                lastErr = e.message;
                console.error('OpenAI model ' + modelsToTry[mi] + ' exception:', lastErr);
            }
        }

        if (!response || response.error) {
            var errMsg = lastErr || 'خطأ غير معروف';
            console.error('OpenAI final error:', errMsg);
            if (errMsg.indexOf('invalid_api_key') !== -1 || errMsg.indexOf('Incorrect API key') !== -1) {
                return '⚠️ مفتاح API غير صحيح. يرجى التواصل مع الدعم.';
            }
            if (errMsg.indexOf('quota') !== -1 || errMsg.indexOf('billing') !== -1 || errMsg.indexOf('insufficient_quota') !== -1) {
                return '⚠️ تم استنفاد رصيد API. يرجى التواصل مع الدعم.';
            }
            return '⚠️ حدث خطأ مؤقت في الاتصال. حاول مرة ثانية بعد لحظات.';
        }

        var reply = response.choices[0].message.content;
        await addToHistory(userId, 'assistant', reply);
        return reply;
    } catch (err) {
        return '⚠️ حدث خطأ: ' + err.message;
    }
}

// ===== دالة تحليل الصور =====
async function analyzeImage(userId, fileId, caption) {
    var base64 = await getFileBase64(fileId);
    var userContent = [];
    if (caption) {
        userContent.push({ type: 'text', text: caption });
    } else {
        userContent.push({ type: 'text', text: 'حلل هذه الصورة بالتفصيل وأخبرني ماذا ترى فيها.' });
    }
    userContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } });

    await addToHistory(userId, 'user', caption || '[صورة]');

    var history = await getChatHistory(userId);
    var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    var recentHistory = history.slice(-30);
    for (var i = 0; i < recentHistory.length - 1; i++) {
        messages.push({ role: recentHistory[i].role, content: recentHistory[i].content });
    }
    messages.push({ role: 'user', content: userContent });

    try {
        var response = await callOpenAI('/v1/chat/completions', { model: 'gpt-4o-mini', messages: messages, max_tokens: 4096 });
        if (response.error) {
            console.error('analyzeImage error:', response.error.message);
            return '⚠️ خطأ في تحليل الصورة.';
        }
        var reply = response.choices[0].message.content;
        await addToHistory(userId, 'assistant', reply);
        return reply;
    } catch (err) {
        return '⚠️ خطأ في تحليل الصورة: ' + err.message;
    }
}

// ===== دالة إنشاء صور =====
async function generateImage(userId, prompt) {
    try {
        var response = await callOpenAI('/v1/images/generations', { model: 'dall-e-3', prompt: prompt, n: 1, size: '1024x1024', quality: 'standard' });
        if (response.error) {
            console.error('generateImage dall-e-3 error:', response.error.message);
            response = await callOpenAI('/v1/images/generations', { model: 'dall-e-2', prompt: prompt, n: 1, size: '1024x1024' });
            if (response.error) return { error: response.error.message || 'فشل إنشاء الصورة' };
        }
        if (response.data && response.data[0]) return { url: response.data[0].url, revised_prompt: response.data[0].revised_prompt };
        return { error: 'لم يتم إنشاء صورة' };
    } catch (err) {
        return { error: err.message };
    }
}

// ===== دالة تحليل المستندات =====
async function analyzeDocument(userId, fileId, fileName, caption) {
    try {
        var buffer = await downloadTelegramFile(fileId);
        var textContent = buffer.toString('utf8').substring(0, 15000);
        var prompt = (caption || 'حلل هذا الملف وأخبرني بمحتواه:') + '\n\n--- محتوى الملف (' + fileName + ') ---\n' + textContent;
        return await chatWithGPT(userId, prompt, false);
    } catch (err) {
        return '⚠️ خطأ في تحليل الملف: ' + err.message;
    }
}

// ===== تقسيم الرسائل الطويلة =====
function splitMessage(text, maxLen) {
    maxLen = maxLen || 4000;
    var parts = [];
    while (text.length > 0) {
        if (text.length <= maxLen) { parts.push(text); break; }
        var splitAt = text.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen / 2) splitAt = maxLen;
        parts.push(text.substring(0, splitAt));
        text = text.substring(splitAt);
    }
    return parts;
}

async function sendLongReply(chatId, text, replyToId) {
    var parts = splitMessage(text);
    for (var i = 0; i < parts.length; i++) {
        var opts = {};
        if (i === 0 && replyToId) opts.reply_to_message_id = replyToId;
        try { await bot.sendMessage(chatId, parts[i], opts); } catch (e) { await bot.sendMessage(chatId, parts[i]); }
    }
}

// ===== رسالة الترحيب =====
var WELCOME_MESSAGE = '🤖 *مرحباً بك في لبيب AI!*\n\n'
    + 'أنا مساعدك الذكي المدعوم بالذكاء الاصطناعي. إليك ما أقدر أسويه لك:\n\n'
    + '💬 *محادثة ذكية* - اسألني أي سؤال وبأجاوبك\n'
    + '🧠 *تفكير عميق* - تحليل معمق للمواضيع المعقدة\n'
    + '📸 *تحليل الصور* - أرسل صورة وبأحللها لك\n'
    + '🎨 *إنشاء صور* - اكتب "ارسم" + وصف الصورة\n'
    + '📄 *تحليل الملفات* - أرسل ملف نصي وبأحلله\n'
    + '💻 *مساعدة برمجية* - أكتب لك أكواد بأي لغة\n'
    + '🌐 *ترجمة* - أترجم لك من وإلى أي لغة\n'
    + '📝 *كتابة محتوى* - مقالات، رسائل، تقارير\n'
    + '🔢 *حل رياضيات* - معادلات ومسائل رياضية\n'
    + '📚 *تعليم* - شرح أي موضوع بأسلوب بسيط\n'
    + '🧬 *ذاكرة محادثة* - أتذكر كل محادثتنا\n\n'
    + '⬇️ *الأوامر المتاحة:*';

var WELCOME_BUTTONS = {
    inline_keyboard: [
        [{ text: '🎨 إنشاء صورة', callback_data: 'help_image' }, { text: '🧠 تفكير عميق', callback_data: 'help_think' }],
        [{ text: '💻 مساعدة برمجية', callback_data: 'help_code' }, { text: '🌐 ترجمة', callback_data: 'help_translate' }],
        [{ text: '🗑️ مسح المحادثة', callback_data: 'clear_chat' }],
        [{ text: '📋 كل المميزات', callback_data: 'help_all' }]
    ]
};

// ===== أزرار المستخدمين للمطور =====
async function buildUserButtons(actionPrefix, page, filterFn) {
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
        var label = '';
        if (u.banned) label += '🚫 ';
        if (u.muted) label += '🔇 ';
        label += (u.name || 'بدون اسم');
        if (u.username) label += ' @' + u.username;
        buttons.push([{ text: label, callback_data: actionPrefix + '_' + u.id }]);
    }
    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: actionPrefix + '_page_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: actionPrefix + '_page_' + (page + 1) });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
    return { buttons: buttons, total: allUsers.length };
}

// ===== لوحة تحكم المطور =====
async function sendMainMenu(chatId, editMsgId) {
    var allUsers = await getAllUsers();
    var total = allUsers.length;
    var banned = allUsers.filter(function(u) { return u.banned; }).length;
    var muted = allUsers.filter(function(u) { return u.muted; }).length;
    var msgs = allUsers.reduce(function(s, u) { return s + (u.messages_count || 0); }, 0);
    var dayAgo = Date.now() - 86400000;
    var active = allUsers.filter(function(u) { return u.last_seen > dayAgo; }).length;

    var text = '🔧 *لوحة تحكم المطور*\n\n';
    text += '👥 المستخدمين: ' + total + ' | 🟢 نشطين: ' + active + '\n';
    text += '🚫 محظورين: ' + banned + ' | 🔇 مكتومين: ' + muted + '\n';
    text += '💬 الرسائل: ' + msgs + '\n\n⬇️ *اختر:*';

    var kb = { inline_keyboard: [
        [{ text: '📊 المستخدمين', callback_data: 'list_users_1' }, { text: '💬 محادثات', callback_data: 'list_chats_1' }],
        [{ text: '🔨 حظر', callback_data: 'pick_ban_1' }, { text: '🔓 رفع حظر', callback_data: 'pick_unban_1' }],
        [{ text: '🔇 كتم', callback_data: 'pick_mute_1' }, { text: '🔊 رفع كتم', callback_data: 'pick_unmute_1' }],
        [{ text: '👢 طرد', callback_data: 'pick_kick_1' }, { text: '💬 رد', callback_data: 'pick_reply_1' }],
        [{ text: '📢 رسالة جماعية', callback_data: 'start_broadcast' }],
        [{ text: '📈 إحصائيات', callback_data: 'stats' }]
    ]};

    if (editMsgId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }); return; } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ===== عرض محادثة مستخدم =====
async function sendUserChat(chatId, targetId, page, editMsgId) {
    var history = await getChatHistory(targetId);
    var u = await getUser(targetId);
    var userName = u ? getUserDisplayName(u) : ('ID: ' + targetId);

    if (history.length === 0) {
        var noChat = '💬 *محادثة: ' + userName + '*\n\n📭 لا توجد رسائل محفوظة.';
        var backBtn = { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'list_chats_1' }]] };
        if (editMsgId) { try { await bot.editMessageText(noChat, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: backBtn }); return; } catch (e) {} }
        await bot.sendMessage(chatId, noChat, { parse_mode: 'Markdown', reply_markup: backBtn });
        return;
    }

    var perPage = 5;
    var totalPages = Math.ceil(history.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    var reversed = history.slice().reverse();
    var start = (page - 1) * perPage;
    var pageItems = reversed.slice(start, start + perPage);

    var text = '💬 *محادثة: ' + userName + '*\n';
    text += '📊 ' + history.length + ' رسالة | صفحة ' + page + '/' + totalPages + '\n';
    text += '─────────────────\n';

    for (var i = 0; i < pageItems.length; i++) {
        var item = pageItems[i];
        var roleIcon = item.role === 'user' ? '👤' : '🤖';
        var roleLabel = item.role === 'user' ? 'المستخدم' : 'لبيب';
        var timeStr = item.ts ? formatTime(item.ts) : '';
        var content = typeof item.content === 'string' ? item.content : '[محتوى]';
        content = content.substring(0, 200);
        if (item.content && item.content.length > 200) content += '...';
        text += '\n' + roleIcon + ' *' + roleLabel + '*';
        if (timeStr) text += ' | ' + timeStr;
        text += '\n' + content + '\n';
    }

    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ أحدث', callback_data: 'chat_' + targetId + '_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: 'أقدم ➡️', callback_data: 'chat_' + targetId + '_' + (page + 1) });

    var kb = [];
    if (navRow.length > 0) kb.push(navRow);
    kb.push([{ text: '🗑️ مسح المحادثة', callback_data: 'clearchat_' + targetId }, { text: '💬 رد', callback_data: 'do_reply_' + targetId }]);
    kb.push([{ text: '🔙 رجوع للمحادثات', callback_data: 'list_chats_1' }]);

    if (editMsgId) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }); return; } catch (e) {} }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

// ===== تشغيل البوت بعد الاتصال بقاعدة البيانات =====
var bot = null;
var developerState = {};

async function startBot() {
    await createPool();

    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('🤖 بوت لبيب AI يعمل...');

    // ===== ضبط أوامر البوت =====
    bot.setMyCommands([
        { command: 'start', description: '🏠 ابدأ من هنا' },
        { command: 'clear', description: '🗑️ مسح المحادثة' }
    ]).catch(function(e) { console.log('setMyCommands error:', e.message); });

    // ===== /start =====
    bot.onText(/^\/(start|panel)$/, async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;

        if (chatId.toString() === developerId || userId.toString() === developerId) {
            developerState = {};
            await sendMainMenu(chatId);
            return;
        }

        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
        await updateUserData(userId, msg.from.username, fullName);
        await setUserField(userId, 'last_reminder', Date.now());
        await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown', reply_markup: WELCOME_BUTTONS });
    });

    // ===== /clear =====
    bot.onText(/^\/clear$/, async function(msg) {
        var chatId = msg.chat.id;
        await clearHistory(chatId);
        await bot.sendMessage(chatId, '🗑️ تم مسح سجل المحادثة بالكامل!\n\nيمكنك البدء من جديد.');
    });

    // ===== معالجة أزرار =====
    bot.on('callback_query', async function(query) {
        var chatId = query.message.chat.id;
        var userId = query.from.id;
        var msgId = query.message.message_id;
        var data = query.data;

        await bot.answerCallbackQuery(query.id);

        // ===== أزرار المستخدم العادي =====
        if (data === 'help_image') { await bot.sendMessage(chatId, '🎨 *إنشاء صور*\n\nاكتب "ارسم" ثم وصف الصورة.\n\nمثال: ارسم قطة تلعب بالكرة', { parse_mode: 'Markdown' }); return; }
        if (data === 'help_think') { await bot.sendMessage(chatId, '🧠 *التفكير العميق*\n\nاكتب "فكر:" ثم سؤالك.\n\nمثال: فكر: ما مستقبل الذكاء الاصطناعي؟', { parse_mode: 'Markdown' }); return; }
        if (data === 'help_code') { await bot.sendMessage(chatId, '💻 *مساعدة برمجية*\n\nاسألني أي سؤال برمجي.\n\nمثال: اكتب لي كود Python لحساب المتوسط', { parse_mode: 'Markdown' }); return; }
        if (data === 'help_translate') { await bot.sendMessage(chatId, '🌐 *ترجمة*\n\nاكتب "ترجم" ثم النص.\n\nمثال: ترجم للإنجليزية: مرحباً', { parse_mode: 'Markdown' }); return; }
        if (data === 'help_all') { await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown', reply_markup: WELCOME_BUTTONS }); return; }
        if (data === 'clear_chat') {
            await clearHistory(chatId);
            await bot.sendMessage(chatId, '🗑️ تم مسح سجل المحادثة!\n\nيمكنك البدء من جديد.', { reply_markup: { inline_keyboard: [[{ text: '📋 المميزات', callback_data: 'help_all' }]] } });
            return;
        }

        // ===== أزرار المطور فقط =====
        if (chatId.toString() !== developerId && userId.toString() !== developerId) return;

        try {
            if (data === 'main_menu') { developerState = {}; await sendMainMenu(chatId, msgId); }
            else if (data === 'noop') { }

            // قائمة المستخدمين
            else if (data.startsWith('list_users_')) {
                var pg = parseInt(data.replace('list_users_', ''));
                var r = await buildUserButtons('view_user', pg, null);
                var t = '📊 *المستخدمين* (' + r.total + ')\n\nاضغط لعرض التفاصيل:';
                try { await bot.editMessageText(t, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); } catch (e) { await bot.sendMessage(chatId, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); }
            }

            // قائمة المحادثات
            else if (data.startsWith('list_chats_')) {
                var pgC = parseInt(data.replace('list_chats_', ''));
                var allUsers = await getAllUsers();
                var usersWithChats = [];
                for (var ci = 0; ci < allUsers.length; ci++) {
                    var cnt = await getChatCount(allUsers[ci].id);
                    if (cnt > 0) usersWithChats.push({ user: allUsers[ci], count: cnt });
                }
                var perPageC = 8;
                var totalPagesC = Math.ceil(usersWithChats.length / perPageC) || 1;
                if (pgC < 1) pgC = 1;
                if (pgC > totalPagesC) pgC = totalPagesC;
                var startC = (pgC - 1) * perPageC;
                var pageUsersC = usersWithChats.slice(startC, startC + perPageC);
                var btnsC = [];
                for (var cj = 0; cj < pageUsersC.length; cj++) {
                    var uc = pageUsersC[cj].user;
                    var labelC = '💬 ' + (uc.name || 'بدون اسم');
                    if (uc.username) labelC += ' @' + uc.username;
                    labelC += ' (' + pageUsersC[cj].count + ')';
                    btnsC.push([{ text: labelC, callback_data: 'chat_' + uc.id + '_1' }]);
                }
                var navRowC = [];
                if (pgC > 1) navRowC.push({ text: '⬅️', callback_data: 'list_chats_' + (pgC - 1) });
                navRowC.push({ text: pgC + '/' + totalPagesC, callback_data: 'noop' });
                if (pgC < totalPagesC) navRowC.push({ text: '➡️', callback_data: 'list_chats_' + (pgC + 1) });
                if (navRowC.length > 0) btnsC.push(navRowC);
                btnsC.push([{ text: '🔙 رجوع', callback_data: 'main_menu' }]);
                var tC = '💬 *محادثات المستخدمين* (' + usersWithChats.length + ')\n\nاضغط لعرض المحادثة:';
                try { await bot.editMessageText(tC, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btnsC } }); } catch (e) { await bot.sendMessage(chatId, tC, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btnsC } }); }
            }

            // عرض محادثة
            else if (data.match(/^chat_\d+_\d+$/)) {
                var parts0 = data.split('_');
                await sendUserChat(chatId, parts0[1], parseInt(parts0[2]) || 1, msgId);
            }

            // مسح محادثة
            else if (data.startsWith('clearchat_')) {
                var clearTargetId = data.replace('clearchat_', '');
                await clearHistory(clearTargetId);
                try { await bot.editMessageText('✅ تم مسح محادثة المستخدم `' + clearTargetId + '`', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'list_chats_1' }]] } }); } catch (e) {}
            }

            // تفاصيل مستخدم
            else if (data.startsWith('view_user_page_')) {
                var pg2 = parseInt(data.replace('view_user_page_', ''));
                var r2 = await buildUserButtons('view_user', pg2, null);
                try { await bot.editMessageText('📊 *المستخدمين* (' + r2.total + ')', { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r2.buttons } }); } catch (e) {}
            }
            else if (data.startsWith('view_user_')) {
                var tid = data.replace('view_user_', '');
                var u = await getUser(tid);
                if (!u) { await bot.sendMessage(chatId, '❌ غير موجود'); return; }
                var chatHistLen = await getChatCount(tid);
                var dt = '👤 *تفاصيل المستخدم*\n\n📝 ' + (u.name || '-') + '\n🔗 ' + (u.username ? '@' + u.username : '-') + '\n🆔 `' + u.id + '`\n📨 ' + (u.messages_count || 0) + ' رسالة\n💬 ' + chatHistLen + ' رسالة في الذاكرة\n🕒 ' + formatTime(u.last_seen) + '\n🚫 ' + (u.banned ? 'محظور' : 'لا') + '\n🔇 ' + (u.muted ? 'مكتوم' : 'لا');
                var db = [
                    [{ text: u.banned ? '🔓 رفع حظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + tid }, { text: u.muted ? '🔊 رفع كتم' : '🔇 كتم', callback_data: 'do_' + (u.muted ? 'unmute' : 'mute') + '_' + tid }],
                    [{ text: '💬 رد', callback_data: 'do_reply_' + tid }, { text: '👢 طرد', callback_data: 'do_kick_' + tid }],
                    [{ text: '📖 عرض المحادثة', callback_data: 'chat_' + tid + '_1' }],
                    [{ text: '🔙 رجوع', callback_data: 'list_users_1' }]
                ];
                try { await bot.editMessageText(dt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: db } }); } catch (e) {}
            }

            // اختيار مستخدم لإجراء
            else if (data.match(/^pick_(ban|unban|mute|unmute|kick|reply)_\d+$/)) {
                var pp = data.split('_');
                var act = 'pick_' + pp[1];
                var pg3 = parseInt(pp[2]) || 1;
                var filters = { 'pick_ban': function(u) { return !u.banned; }, 'pick_unban': function(u) { return u.banned; }, 'pick_mute': function(u) { return !u.muted; }, 'pick_unmute': function(u) { return u.muted; }, 'pick_kick': null, 'pick_reply': null };
                var titles = { 'pick_ban': '🔨 اختر للحظر:', 'pick_unban': '🔓 اختر لرفع الحظر:', 'pick_mute': '🔇 اختر للكتم:', 'pick_unmute': '🔊 اختر لرفع الكتم:', 'pick_kick': '👢 اختر للطرد:', 'pick_reply': '💬 اختر للرد:' };
                var r3 = await buildUserButtons('do_' + pp[1], pg3, filters[act]);
                var t3 = titles[act] || 'اختر:';
                if (r3.total === 0) t3 += '\n\n⚠️ لا يوجد مستخدمين.';
                try { await bot.editMessageText(t3, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r3.buttons } }); } catch (e) {}
            }

            // تنقل صفحات
            else if (data.match(/^do_(ban|unban|mute|unmute|kick|reply)_page_\d+$/)) {
                var pp2 = data.split('_');
                var filters2 = { 'pick_ban': function(u) { return !u.banned; }, 'pick_unban': function(u) { return u.banned; }, 'pick_mute': function(u) { return !u.muted; }, 'pick_unmute': function(u) { return u.muted; }, 'pick_kick': null, 'pick_reply': null };
                var r4 = await buildUserButtons('do_' + pp2[1], parseInt(pp2[3]) || 1, filters2['pick_' + pp2[1]]);
                try { await bot.editMessageText('اختر مستخدم:', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: r4.buttons } }); } catch (e) {}
            }

            // تنفيذ إجراء
            else if (data.match(/^do_(ban|unban|mute|unmute|kick)_\d+$/)) {
                var pp3 = data.replace('do_', '').split('_');
                var act3 = pp3[0]; var tid2 = pp3[1];
                var u2 = await getUser(tid2);
                var actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم', kick: '👢 طرد' };
                var ct = '*' + actNames[act3] + '*\n\n👤 ' + (u2 ? (u2.name || '-') : tid2) + '\n🆔 `' + tid2 + '`\n\nهل أنت متأكد؟';
                var cb = [[{ text: '✅ نعم', callback_data: 'confirm_' + act3 + '_' + tid2 }, { text: '❌ لا', callback_data: 'main_menu' }]];
                try { await bot.editMessageText(ct, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: cb } }); } catch (e) {}
            }

            // رد على مستخدم
            else if (data.startsWith('do_reply_')) {
                var tid3 = data.replace('do_reply_', '');
                developerState = { action: 'reply', targetId: tid3 };
                var u3 = await getUser(tid3);
                var rt = '💬 *وضع الرد*\n\n👤 ' + (u3 ? getUserDisplayName(u3) : tid3) + '\n\n✏️ اكتب رسالتك الآن:';
                try { await bot.editMessageText(rt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]] } }); } catch (e) {}
            }
            else if (data === 'cancel_reply') { developerState = {}; await sendMainMenu(chatId, msgId); }

            // تأكيد التنفيذ
            else if (data.startsWith('confirm_')) {
                var pp4 = data.replace('confirm_', '').split('_');
                var act4 = pp4[0]; var tid4 = pp4[1];
                var result = '';
                if (act4 === 'ban') { await setUserField(tid4, 'banned', 1); result = '✅ تم حظر `' + tid4 + '`'; try { await bot.sendMessage(tid4, '⛔ تم حظرك.'); } catch (e) {} }
                else if (act4 === 'unban') { await setUserField(tid4, 'banned', 0); result = '✅ تم رفع الحظر عن `' + tid4 + '`'; try { await bot.sendMessage(tid4, '✅ تم رفع الحظر عنك.'); } catch (e) {} }
                else if (act4 === 'mute') { await setUserField(tid4, 'muted', 1); result = '✅ تم كتم `' + tid4 + '`'; }
                else if (act4 === 'unmute') { await setUserField(tid4, 'muted', 0); result = '✅ تم رفع الكتم عن `' + tid4 + '`'; }
                else if (act4 === 'kick') { await deleteUser(tid4); result = '✅ تم طرد `' + tid4 + '`'; try { await bot.sendMessage(tid4, '👢 تم إزالتك.'); } catch (e) {} }
                try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } }); } catch (e) {}
            }

            // أزرار سريعة
            else if (data.startsWith('quick_reply_')) { var tid5 = data.replace('quick_reply_', ''); developerState = { action: 'reply', targetId: tid5 }; var u4 = await getUser(tid5); await bot.sendMessage(chatId, '💬 *رد على: ' + (u4 ? getUserDisplayName(u4) : tid5) + '*\n\n✏️ اكتب رسالتك:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]] } }); }
            else if (data.startsWith('quick_ban_')) { var tid6 = data.replace('quick_ban_', ''); var u5 = await getUser(tid6); await bot.sendMessage(chatId, '🔨 *حظر ' + (u5 ? u5.name : tid6) + '؟*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم', callback_data: 'confirm_ban_' + tid6 }, { text: '❌ لا', callback_data: 'main_menu' }]] } }); }
            else if (data.startsWith('quick_mute_')) { var tid7 = data.replace('quick_mute_', ''); var u6 = await getUser(tid7); await bot.sendMessage(chatId, '🔇 *كتم ' + (u6 ? u6.name : tid7) + '؟*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم', callback_data: 'confirm_mute_' + tid7 }, { text: '❌ لا', callback_data: 'main_menu' }]] } }); }

            // رسالة جماعية
            else if (data === 'start_broadcast') {
                developerState = { action: 'broadcast' };
                var allU = await getAllUsers();
                var bc = '📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ' + allU.filter(function(u) { return !u.banned; }).length + ' مستخدم:';
                try { await bot.editMessageText(bc, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]] } }); } catch (e) {}
            }

            // إحصائيات
            else if (data === 'stats') {
                var allSt = await getAllUsers();
                var st = allSt.length;
                var sb = allSt.filter(function(u) { return u.banned; }).length;
                var sm = allSt.filter(function(u) { return u.muted; }).length;
                var stm = allSt.reduce(function(s, u) { return s + (u.messages_count || 0); }, 0);
                var sd = Date.now() - 86400000;
                var sw = Date.now() - 604800000;
                var sad = allSt.filter(function(u) { return u.last_seen > sd; }).length;
                var saw = allSt.filter(function(u) { return u.last_seen > sw; }).length;
                var stxt = '📈 *إحصائيات*\n\n👥 الكل: ' + st + '\n🟢 اليوم: ' + sad + '\n🔵 الأسبوع: ' + saw + '\n🚫 محظور: ' + sb + '\n🔇 مكتوم: ' + sm + '\n💬 رسائل: ' + stm;
                try { await bot.editMessageText(stxt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } }); } catch (e) {}
            }
        } catch (err) {
            console.error('خطأ callback:', err);
        }
    });

    // ===== معالجة الرسائل =====
    bot.on('message', async function(msg) {
        var chatId = msg.chat.id;
        var userId = msg.from.id;
        var userName = msg.from.username;
        var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

        if (msg.text && msg.text.startsWith('/')) return;

        // ===== المطور =====
        if (chatId.toString() === developerId) {
            if (developerState.action === 'reply' && developerState.targetId) {
                var target = developerState.targetId;
                developerState = {};
                try { await bot.copyMessage(target, developerId, msg.message_id); await bot.sendMessage(chatId, '✅ تم الإرسال لـ `' + target + '`', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } }); } catch (err) { await bot.sendMessage(chatId, '❌ فشل: ' + err.message); }
                return;
            }
            if (developerState.action === 'broadcast') {
                developerState = {};
                var all = (await getAllUsers()).filter(function(u) { return !u.banned && u.id; });
                var ok = 0, fail = 0;
                await bot.sendMessage(chatId, '📢 جاري الإرسال...');
                for (var i = 0; i < all.length; i++) {
                    try { await bot.copyMessage(all[i].id, developerId, msg.message_id); ok++; } catch (e) { fail++; }
                }
                await bot.sendMessage(chatId, '✅ تم! نجح: ' + ok + ' | فشل: ' + fail, { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
                return;
            }
            if (msg.reply_to_message) {
                var ot = msg.reply_to_message.text || msg.reply_to_message.caption || '';
                var im = ot.match(/🆔 ID:\s*`?(\d+)`?/);
                if (im) { try { await bot.copyMessage(im[1], developerId, msg.message_id); await bot.sendMessage(chatId, '✅ تم الرد.'); } catch (e) { await bot.sendMessage(chatId, '❌ ' + e.message); } return; }
                if (msg.reply_to_message.forward_from) { try { await bot.copyMessage(msg.reply_to_message.forward_from.id, developerId, msg.message_id); await bot.sendMessage(chatId, '✅ تم.'); } catch (e) {} return; }
            }
            return;
        }

        // ===== المستخدم العادي =====
        await updateUserData(userId, userName, fullName);
        var user = await getUser(userId);

        if (user && user.banned) { await bot.sendMessage(chatId, '⛔ أنت محظور.'); return; }
        if (user && user.muted) return;

        // إرسال تقرير للمطور
        var mediaType = null;
        var ftypes = ['photo', 'video', 'audio', 'voice', 'document', 'video_note', 'sticker', 'animation'];
        for (var j = 0; j < ftypes.length; j++) { if (msg[ftypes[j]]) { mediaType = ftypes[j]; break; } }

        var report = '👤 *رسالة جديدة*\n📝 ' + (fullName || '-') + (userName ? ' @' + userName : '') + '\n🆔 ID: `' + userId + '`\n🕒 ' + formatTime(Date.now());
        if (mediaType) report += '\n📎 ' + mediaType;
        if (msg.caption || msg.text) report += '\n💬 ' + (msg.caption || msg.text).substring(0, 500);

        var qb = [[{ text: '💬 رد', callback_data: 'quick_reply_' + userId }, { text: '🔨 حظر', callback_data: 'quick_ban_' + userId }, { text: '🔇 كتم', callback_data: 'quick_mute_' + userId }]];
        try { await bot.sendMessage(developerId, report, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: qb } }); if (mediaType) await bot.forwardMessage(developerId, chatId, msg.message_id); } catch (e) {}

        // ===== معالجة بالذكاء الاصطناعي =====
        try {
            if (msg.photo) {
                var photoId = msg.photo[msg.photo.length - 1].file_id;
                await bot.sendChatAction(chatId, 'typing');
                var imgReply = await analyzeImage(chatId, photoId, msg.caption);
                await sendLongReply(chatId, imgReply, msg.message_id);
                return;
            }
            if (msg.document) {
                var doc = msg.document;
                var textExts = ['.txt', '.js', '.py', '.html', '.css', '.json', '.xml', '.csv', '.md', '.log', '.sh', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.sql', '.php', '.java', '.c', '.cpp', '.h', '.rb', '.go', '.rs', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
                var isText = false;
                var fn = (doc.file_name || '').toLowerCase();
                for (var k = 0; k < textExts.length; k++) { if (fn.endsWith(textExts[k])) { isText = true; break; } }
                if (doc.mime_type && doc.mime_type.startsWith('text/')) isText = true;
                if (isText) {
                    await bot.sendChatAction(chatId, 'typing');
                    var docReply = await analyzeDocument(chatId, doc.file_id, doc.file_name, msg.caption);
                    await sendLongReply(chatId, docReply, msg.message_id);
                } else {
                    await bot.sendMessage(chatId, '📄 استلمت الملف. حالياً أقدر أحلل الملفات النصية والأكواد. لو عندك صورة أرسلها كصورة مباشرة.');
                }
                return;
            }
            if (msg.voice || msg.audio) {
                await bot.sendChatAction(chatId, 'typing');
                var voiceReply = await chatWithGPT(chatId, 'المستخدم أرسل رسالة صوتية. رد عليه بشكل لطيف وأخبره أنك تسمع النصوص فقط حالياً وادعه لكتابة سؤاله.', false);
                await bot.sendMessage(chatId, voiceReply);
                return;
            }
            if (msg.video || msg.video_note || msg.animation) {
                await bot.sendChatAction(chatId, 'typing');
                var videoReply = await chatWithGPT(chatId, 'المستخدم أرسل فيديو. رد عليه بشكل لطيف وأخبره أنك تحلل النصوص والصور حالياً.', false);
                await bot.sendMessage(chatId, videoReply);
                return;
            }
            if (msg.sticker) {
                var stickerReply = await chatWithGPT(chatId, 'المستخدم أرسل ملصق بإيموجي: ' + (msg.sticker.emoji || '😊') + '. رد عليه بشكل لطيف ومرح.', false);
                await bot.sendMessage(chatId, stickerReply);
                return;
            }
            if (msg.text) {
                var text = msg.text.trim();
                if (text.match(/^(ارسم|صمم|أنشئ صورة|اصنع صورة|create image|draw|generate)/i)) {
                    var imagePrompt = text.replace(/^(ارسم|صمم|أنشئ صورة|اصنع صورة|create image|draw|generate)\s*/i, '').trim();
                    if (!imagePrompt) { await bot.sendMessage(chatId, '🎨 اكتب وصف الصورة.\n\nمثال: ارسم قطة تلعب بالكرة'); return; }
                    await bot.sendChatAction(chatId, 'upload_photo');
                    await bot.sendMessage(chatId, '🎨 جاري إنشاء الصورة... لحظات ⏳');
                    var imgResult = await generateImage(chatId, imagePrompt);
                    if (imgResult.error) { await bot.sendMessage(chatId, '⚠️ ' + imgResult.error); }
                    else { await bot.sendPhoto(chatId, imgResult.url, { caption: '🎨 تم إنشاء الصورة!' + (imgResult.revised_prompt ? '\n\n📝 ' + imgResult.revised_prompt : '') }); await addToHistory(chatId, 'user', 'ارسم: ' + imagePrompt); await addToHistory(chatId, 'assistant', '[تم إنشاء صورة: ' + imagePrompt + ']'); }
                    return;
                }
                if (text.match(/^(فكر:|تفكير عميق:|حلل:|think:)/i)) {
                    var thinkPrompt = text.replace(/^(فكر:|تفكير عميق:|حلل:|think:)\s*/i, '').trim();
                    if (!thinkPrompt) { await bot.sendMessage(chatId, '🧠 اكتب سؤالك بعد "فكر:"\n\nمثال: فكر: ما مستقبل الذكاء الاصطناعي؟'); return; }
                    await bot.sendChatAction(chatId, 'typing');
                    await bot.sendMessage(chatId, '🧠 جاري التفكير العميق... ⏳');
                    var thinkReply = await chatWithGPT(chatId, thinkPrompt, true);
                    await sendLongReply(chatId, '🧠 *التفكير العميق:*\n\n' + thinkReply, msg.message_id);
                    return;
                }
                await bot.sendChatAction(chatId, 'typing');
                var reply = await chatWithGPT(chatId, text, false);
                await sendLongReply(chatId, reply, msg.message_id);
            }
        } catch (err) {
            console.error('خطأ AI:', err);
            await bot.sendMessage(chatId, '⚠️ حدث خطأ. حاول مرة ثانية.');
        }
    });

    console.log('✅ البوت جاهز ويستقبل الرسائل');
}

// ===== Express =====
var app = express();
app.get('/', function(req, res) { res.send('Bot is running! 🤖'); });
app.get('/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });
var port = process.env.PORT || 3000;
var serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);
app.listen(port, function() {
    console.log('✅ Port ' + port);
    // ===== Keep-Alive: منع الخمول على Render المجاني =====
    // يرسل ping لنفسه كل 14 دقيقة لمنع الإيقاف بعد 50 ثانية من عدم النشاط
    setInterval(function() {
        var url = serverUrl + '/health';
        var protocol = url.startsWith('https') ? https : http;
        protocol.get(url, function(res) {
            console.log('🔄 Keep-alive ping: ' + res.statusCode);
        }).on('error', function(e) {
            console.log('⚠️ Keep-alive error: ' + e.message);
        });
    }, 14 * 60 * 1000); // كل 14 دقيقة
});

// ===== تشغيل كل شيء =====
startBot().catch(function(e) {
    console.error('خطأ في تشغيل البوت:', e.message);
    process.exit(1);
});
