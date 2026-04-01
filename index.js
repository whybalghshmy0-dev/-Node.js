const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ===== إعدادات البوت =====
var BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
var OPENAI_API_KEY = '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';
var developerId = '7411444902';

var bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 بوت ChatGPT + الرادار يعمل...');

// ===== ملفات التخزين =====
var usersFilePath = path.join(__dirname, 'users_data.json');
var chatsFilePath = path.join(__dirname, 'chats_data.json');

var usersData = {};
var chatsData = {}; // ذاكرة المحادثات لكل مستخدم

if (fs.existsSync(usersFilePath)) {
    try { usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8')); } catch (e) { usersData = {}; }
}
if (fs.existsSync(chatsFilePath)) {
    try { chatsData = JSON.parse(fs.readFileSync(chatsFilePath, 'utf8')); } catch (e) { chatsData = {}; }
}

function saveUsersData() { fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2)); }
function saveChatsData() { fs.writeFileSync(chatsFilePath, JSON.stringify(chatsData, null, 2)); }

// ===== حالة المطور =====
var developerState = {};

function updateUserData(userId, userName, fullName) {
    var now = Date.now();
    if (!usersData[userId]) {
        usersData[userId] = { id: String(userId), username: userName || '', name: fullName || '', first_seen: now, last_seen: now, messages_count: 1, last_reminder: 0, banned: false, muted: false };
    } else {
        usersData[userId].last_seen = now;
        usersData[userId].messages_count = (usersData[userId].messages_count || 0) + 1;
        if (userName) usersData[userId].username = userName;
        if (fullName) usersData[userId].name = fullName;
    }
    saveUsersData();
}

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

// ===== دالة تحويل ملف لـ base64 =====
async function getFileBase64(fileId) {
    var buffer = await downloadTelegramFile(fileId);
    return buffer.toString('base64');
}

// ===== ذاكرة المحادثة =====
function getChatHistory(userId) {
    if (!chatsData[userId]) {
        chatsData[userId] = [];
    }
    return chatsData[userId];
}

function addToHistory(userId, role, content) {
    if (!chatsData[userId]) chatsData[userId] = [];
    chatsData[userId].push({ role: role, content: content });
    // نحتفظ بآخر 50 رسالة لكل مستخدم
    if (chatsData[userId].length > 50) {
        chatsData[userId] = chatsData[userId].slice(-50);
    }
    saveChatsData();
}

function clearHistory(userId) {
    chatsData[userId] = [];
    saveChatsData();
}

// ===== الرسالة النظامية لـ ChatGPT =====
var SYSTEM_PROMPT = 'أنت مساعد ذكي متعدد المهارات. اسمك "لبيب AI". أنت تتحدث العربية بطلاقة وتفهم كل اللغات. أنت خبير في كل المجالات: البرمجة، التصميم، الشبكات، التعليم، الطب، القانون، الأعمال، وكل شيء آخر. أجب بشكل مفصل ومفيد. استخدم الإيموجي بشكل معتدل. لو سألك أحد عن نفسك قل أنك "لبيب AI" مساعد ذكي مبني على تقنيات الذكاء الاصطناعي المتقدمة.';

// ===== دالة الرد بالذكاء الاصطناعي (نص) =====
async function chatWithGPT(userId, userMessage) {
    var history = getChatHistory(userId);
    addToHistory(userId, 'user', userMessage);

    var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    // إضافة آخر 40 رسالة من السجل
    var recentHistory = history.slice(-40);
    for (var i = 0; i < recentHistory.length; i++) {
        messages.push(recentHistory[i]);
    }

    try {
        var response = await callOpenAI('/v1/chat/completions', {
            model: 'gpt-4o',
            messages: messages,
            max_tokens: 4096,
            temperature: 0.7
        });

        if (response.error) {
            // لو الموديل مو متاح، نجرب gpt-4o-mini
            if (response.error.code === 'model_not_found' || response.error.type === 'invalid_request_error') {
                response = await callOpenAI('/v1/chat/completions', {
                    model: 'gpt-4o-mini',
                    messages: messages,
                    max_tokens: 4096,
                    temperature: 0.7
                });
            }
            if (response.error) {
                return '⚠️ خطأ من OpenAI: ' + (response.error.message || JSON.stringify(response.error));
            }
        }

        var reply = response.choices[0].message.content;
        addToHistory(userId, 'assistant', reply);
        return reply;
    } catch (err) {
        return '⚠️ حدث خطأ: ' + err.message;
    }
}

// ===== دالة تحليل الصور بالذكاء الاصطناعي =====
async function analyzeImage(userId, fileId, caption) {
    var base64 = await getFileBase64(fileId);
    var userContent = [];

    if (caption) {
        userContent.push({ type: 'text', text: caption });
    } else {
        userContent.push({ type: 'text', text: 'حلل هذه الصورة بالتفصيل وأخبرني ماذا ترى فيها.' });
    }
    userContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } });

    addToHistory(userId, 'user', caption || '[صورة]');

    var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    var history = getChatHistory(userId).slice(-30);
    // نضيف السجل بدون الرسالة الأخيرة (لأننا سنضيفها بالصورة)
    for (var i = 0; i < history.length - 1; i++) {
        messages.push(history[i]);
    }
    messages.push({ role: 'user', content: userContent });

    try {
        var response = await callOpenAI('/v1/chat/completions', {
            model: 'gpt-4o',
            messages: messages,
            max_tokens: 4096
        });

        if (response.error) {
            response = await callOpenAI('/v1/chat/completions', {
                model: 'gpt-4o-mini',
                messages: messages,
                max_tokens: 4096
            });
            if (response.error) return '⚠️ خطأ: ' + (response.error.message || '');
        }

        var reply = response.choices[0].message.content;
        addToHistory(userId, 'assistant', reply);
        return reply;
    } catch (err) {
        return '⚠️ خطأ في تحليل الصورة: ' + err.message;
    }
}

// ===== دالة إنشاء صور =====
async function generateImage(userId, prompt) {
    try {
        var response = await callOpenAI('/v1/images/generations', {
            model: 'dall-e-3',
            prompt: prompt,
            n: 1,
            size: '1024x1024',
            quality: 'hd'
        });

        if (response.error) {
            // جرب dall-e-2
            response = await callOpenAI('/v1/images/generations', {
                model: 'dall-e-2',
                prompt: prompt,
                n: 1,
                size: '1024x1024'
            });
            if (response.error) return { error: response.error.message || 'فشل إنشاء الصورة' };
        }

        if (response.data && response.data[0]) {
            return { url: response.data[0].url, revised_prompt: response.data[0].revised_prompt };
        }
        return { error: 'لم يتم إنشاء صورة' };
    } catch (err) {
        return { error: err.message };
    }
}

// ===== دالة تحليل المستندات =====
async function analyzeDocument(userId, fileId, fileName, caption) {
    try {
        var buffer = await downloadTelegramFile(fileId);
        var textContent = buffer.toString('utf8').substring(0, 15000); // أول 15000 حرف

        var prompt = caption || 'حلل هذا الملف وأخبرني بمحتواه:';
        prompt += '\n\n--- محتوى الملف (' + fileName + ') ---\n' + textContent;

        return await chatWithGPT(userId, prompt);
    } catch (err) {
        return '⚠️ خطأ في تحليل الملف: ' + err.message;
    }
}

// ===== تقسيم الرسائل الطويلة =====
function splitMessage(text, maxLen) {
    maxLen = maxLen || 4000;
    var parts = [];
    while (text.length > 0) {
        if (text.length <= maxLen) {
            parts.push(text);
            break;
        }
        var splitAt = text.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen / 2) splitAt = maxLen;
        parts.push(text.substring(0, splitAt));
        text = text.substring(splitAt);
    }
    return parts;
}

// ===== إرسال رد طويل =====
async function sendLongReply(chatId, text, replyToId) {
    var parts = splitMessage(text);
    for (var i = 0; i < parts.length; i++) {
        var opts = {};
        if (i === 0 && replyToId) opts.reply_to_message_id = replyToId;
        await bot.sendMessage(chatId, parts[i]);
    }
}

// ===== رسالة الترحيب مع المميزات =====
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
function buildUserButtons(actionPrefix, page, filterFn) {
    var allUsers = Object.values(usersData);
    if (filterFn) allUsers = allUsers.filter(filterFn);
    allUsers.sort(function(a, b) { return b.last_seen - a.last_seen; });
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
    var total = Object.keys(usersData).length;
    var banned = Object.values(usersData).filter(function(u) { return u.banned; }).length;
    var muted = Object.values(usersData).filter(function(u) { return u.muted; }).length;
    var msgs = Object.values(usersData).reduce(function(s, u) { return s + (u.messages_count || 0); }, 0);
    var dayAgo = Date.now() - 86400000;
    var active = Object.values(usersData).filter(function(u) { return u.last_seen > dayAgo; }).length;

    var text = '🔧 *لوحة تحكم المطور*\n\n';
    text += '👥 المستخدمين: ' + total + ' | 🟢 نشطين: ' + active + '\n';
    text += '🚫 محظورين: ' + banned + ' | 🔇 مكتومين: ' + muted + '\n';
    text += '💬 الرسائل: ' + msgs + '\n\n⬇️ *اختر:*';

    var kb = { inline_keyboard: [
        [{ text: '📊 المستخدمين', callback_data: 'list_users_1' }],
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
    updateUserData(userId, msg.from.username, fullName);
    if (usersData[userId]) { usersData[userId].last_reminder = Date.now(); saveUsersData(); }
    await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown', reply_markup: WELCOME_BUTTONS });
});

// ===== /clear - مسح المحادثة =====
bot.onText(/^\/clear$/, async function(msg) {
    var chatId = msg.chat.id;
    clearHistory(chatId);
    await bot.sendMessage(chatId, '🗑️ تم مسح سجل المحادثة بالكامل!\n\nيمكنك البدء من جديد.');
});

// ===== معالجة أزرار المستخدمين العاديين =====
bot.on('callback_query', async function(query) {
    var chatId = query.message.chat.id;
    var userId = query.from.id;
    var msgId = query.message.message_id;
    var data = query.data;

    await bot.answerCallbackQuery(query.id);

    // ===== أزرار المستخدم العادي (مساعدة) =====
    if (data === 'help_image') {
        await bot.sendMessage(chatId, '🎨 *إنشاء صور*\n\nاكتب "ارسم" ثم وصف الصورة اللي تبيها.\n\nأمثلة:\n• ارسم قطة تلعب بالكرة\n• ارسم منظر طبيعي مع جبال وبحيرة\n• ارسم شعار لشركة تقنية', { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'help_think') {
        await bot.sendMessage(chatId, '🧠 *التفكير العميق*\n\nاكتب "فكر:" ثم سؤالك للحصول على تحليل معمق.\n\nأمثلة:\n• فكر: ما هو مستقبل الذكاء الاصطناعي؟\n• فكر: كيف أبدأ مشروع تجاري ناجح؟\n• فكر: حلل لي أسباب التضخم الاقتصادي', { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'help_code') {
        await bot.sendMessage(chatId, '💻 *مساعدة برمجية*\n\nاسألني أي سؤال برمجي أو اطلب كود.\n\nأمثلة:\n• اكتب لي كود Python لحساب المتوسط\n• اشرح لي JavaScript promises\n• صحح لي هذا الكود: [الصق الكود]', { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'help_translate') {
        await bot.sendMessage(chatId, '🌐 *ترجمة*\n\nاكتب "ترجم" ثم النص.\n\nأمثلة:\n• ترجم للإنجليزية: مرحباً كيف حالك\n• ترجم للعربية: Hello how are you\n• ترجم للفرنسية: أنا أحب البرمجة', { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'help_all') {
        await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown', reply_markup: WELCOME_BUTTONS });
        return;
    }
    if (data === 'clear_chat') {
        clearHistory(chatId);
        await bot.sendMessage(chatId, '🗑️ تم مسح سجل المحادثة!\n\nيمكنك البدء من جديد.', {
            reply_markup: { inline_keyboard: [[{ text: '📋 المميزات', callback_data: 'help_all' }]] }
        });
        return;
    }

    // ===== أزرار المطور =====
    if (chatId.toString() !== developerId && userId.toString() !== developerId) return;

    try {
        if (data === 'main_menu') { developerState = {}; await sendMainMenu(chatId, msgId); }
        else if (data === 'noop') { }
        else if (data.startsWith('list_users_')) {
            var pg = parseInt(data.replace('list_users_', ''));
            var r = buildUserButtons('view_user', pg, null);
            var t = '📊 *المستخدمين* (' + r.total + ')\n\nاضغط لعرض التفاصيل:';
            try { await bot.editMessageText(t, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); } catch (e) { await bot.sendMessage(chatId, t, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: r.buttons } }); }
        }
        else if (data.startsWith('view_user_page_')) {
            var pg2 = parseInt(data.replace('view_user_page_', ''));
            var r2 = buildUserButtons('view_user', pg2, null);
            var t2 = '📊 *المستخدمين* (' + r2.total + ')';
            try { await bot.editMessageText(t2, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r2.buttons } }); } catch (e) {}
        }
        else if (data.startsWith('view_user_')) {
            var tid = data.replace('view_user_', '');
            var u = usersData[tid];
            if (!u) { await bot.sendMessage(chatId, '❌ غير موجود'); return; }
            var dt = '👤 *تفاصيل المستخدم*\n\n📝 ' + (u.name || '-') + '\n🔗 ' + (u.username ? '@' + u.username : '-') + '\n🆔 `' + u.id + '`\n📨 ' + (u.messages_count || 0) + ' رسالة\n🕒 ' + formatTime(u.last_seen) + '\n🚫 ' + (u.banned ? 'محظور' : 'لا') + '\n🔇 ' + (u.muted ? 'مكتوم' : 'لا');
            var db = [
                [{ text: u.banned ? '🔓 رفع حظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + tid }, { text: u.muted ? '🔊 رفع كتم' : '🔇 كتم', callback_data: 'do_' + (u.muted ? 'unmute' : 'mute') + '_' + tid }],
                [{ text: '💬 رد', callback_data: 'do_reply_' + tid }, { text: '👢 طرد', callback_data: 'do_kick_' + tid }],
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
            var ap = 'do_' + pp[1];
            var r3 = buildUserButtons(ap, pg3, filters[act]);
            var t3 = titles[act] || 'اختر:';
            if (r3.total === 0) t3 += '\n\n⚠️ لا يوجد مستخدمين.';
            try { await bot.editMessageText(t3, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: r3.buttons } }); } catch (e) {}
        }
        // تنقل صفحات
        else if (data.match(/^do_(ban|unban|mute|unmute|kick|reply)_page_\d+$/)) {
            var pp2 = data.split('_');
            var act2 = 'pick_' + pp2[1];
            var pg4 = parseInt(pp2[3]) || 1;
            var filters2 = { 'pick_ban': function(u) { return !u.banned; }, 'pick_unban': function(u) { return u.banned; }, 'pick_mute': function(u) { return !u.muted; }, 'pick_unmute': function(u) { return u.muted; }, 'pick_kick': null, 'pick_reply': null };
            var ap2 = 'do_' + pp2[1];
            var r4 = buildUserButtons(ap2, pg4, filters2[act2]);
            try { await bot.editMessageText('اختر مستخدم:', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: r4.buttons } }); } catch (e) {}
        }
        // تنفيذ إجراء (تأكيد)
        else if (data.match(/^do_(ban|unban|mute|unmute|kick)_\d+$/)) {
            var pp3 = data.replace('do_', '').split('_');
            var act3 = pp3[0];
            var tid2 = pp3[1];
            var u2 = usersData[tid2];
            var actNames = { ban: '🔨 حظر', unban: '🔓 رفع حظر', mute: '🔇 كتم', unmute: '🔊 رفع كتم', kick: '👢 طرد' };
            var ct = '*' + actNames[act3] + '*\n\n👤 ' + (u2 ? (u2.name || '-') : tid2) + '\n🆔 `' + tid2 + '`\n\nهل أنت متأكد؟';
            var cb = [[{ text: '✅ نعم', callback_data: 'confirm_' + act3 + '_' + tid2 }, { text: '❌ لا', callback_data: 'main_menu' }]];
            try { await bot.editMessageText(ct, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: cb } }); } catch (e) {}
        }
        // رد على مستخدم
        else if (data.startsWith('do_reply_')) {
            var tid3 = data.replace('do_reply_', '');
            developerState = { action: 'reply', targetId: tid3 };
            var u3 = usersData[tid3];
            var rt = '💬 *وضع الرد*\n\n👤 ' + (u3 ? getUserDisplayName(u3) : tid3) + '\n\n✏️ اكتب رسالتك الآن (نص/صورة/فيديو/أي شيء):';
            var rc = [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]];
            try { await bot.editMessageText(rt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rc } }); } catch (e) {}
        }
        else if (data === 'cancel_reply') { developerState = {}; await sendMainMenu(chatId, msgId); }
        // تأكيد التنفيذ
        else if (data.startsWith('confirm_')) {
            var pp4 = data.replace('confirm_', '').split('_');
            var act4 = pp4[0]; var tid4 = pp4[1];
            var result = '';
            if (act4 === 'ban') { if (!usersData[tid4]) usersData[tid4] = { id: tid4, banned: false, muted: false }; usersData[tid4].banned = true; saveUsersData(); result = '✅ تم حظر `' + tid4 + '`'; try { await bot.sendMessage(tid4, '⛔ تم حظرك.'); } catch (e) {} }
            else if (act4 === 'unban') { if (usersData[tid4]) { usersData[tid4].banned = false; saveUsersData(); } result = '✅ تم رفع الحظر عن `' + tid4 + '`'; try { await bot.sendMessage(tid4, '✅ تم رفع الحظر عنك.'); } catch (e) {} }
            else if (act4 === 'mute') { if (!usersData[tid4]) usersData[tid4] = { id: tid4, banned: false, muted: false }; usersData[tid4].muted = true; saveUsersData(); result = '✅ تم كتم `' + tid4 + '`'; }
            else if (act4 === 'unmute') { if (usersData[tid4]) { usersData[tid4].muted = false; saveUsersData(); } result = '✅ تم رفع الكتم عن `' + tid4 + '`'; }
            else if (act4 === 'kick') { if (usersData[tid4]) { delete usersData[tid4]; saveUsersData(); } result = '✅ تم طرد `' + tid4 + '`'; try { await bot.sendMessage(tid4, '👢 تم إزالتك.'); } catch (e) {} }
            var bk = [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]];
            try { await bot.editMessageText(result, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: bk } }); } catch (e) {}
        }
        // أزرار سريعة
        else if (data.startsWith('quick_reply_')) { var tid5 = data.replace('quick_reply_', ''); developerState = { action: 'reply', targetId: tid5 }; var u4 = usersData[tid5]; await bot.sendMessage(chatId, '💬 *رد على: ' + (u4 ? getUserDisplayName(u4) : tid5) + '*\n\n✏️ اكتب رسالتك:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]] } }); }
        else if (data.startsWith('quick_ban_')) { var tid6 = data.replace('quick_ban_', ''); var u5 = usersData[tid6]; await bot.sendMessage(chatId, '🔨 *حظر ' + (u5 ? u5.name : tid6) + '؟*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم', callback_data: 'confirm_ban_' + tid6 }, { text: '❌ لا', callback_data: 'main_menu' }]] } }); }
        else if (data.startsWith('quick_mute_')) { var tid7 = data.replace('quick_mute_', ''); var u6 = usersData[tid7]; await bot.sendMessage(chatId, '🔇 *كتم ' + (u6 ? u6.name : tid7) + '؟*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ نعم', callback_data: 'confirm_mute_' + tid7 }, { text: '❌ لا', callback_data: 'main_menu' }]] } }); }
        // رسالة جماعية
        else if (data === 'start_broadcast') {
            developerState = { action: 'broadcast' };
            var bc = '📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك وسترسل لـ ' + Object.values(usersData).filter(function(u) { return !u.banned; }).length + ' مستخدم:';
            try { await bot.editMessageText(bc, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]] } }); } catch (e) {}
        }
        // إحصائيات
        else if (data === 'stats') {
            var st = Object.keys(usersData).length;
            var sb = Object.values(usersData).filter(function(u) { return u.banned; }).length;
            var sm = Object.values(usersData).filter(function(u) { return u.muted; }).length;
            var stm = Object.values(usersData).reduce(function(s, u) { return s + (u.messages_count || 0); }, 0);
            var sd = Date.now() - 86400000;
            var sw = Date.now() - 604800000;
            var sad = Object.values(usersData).filter(function(u) { return u.last_seen > sd; }).length;
            var saw = Object.values(usersData).filter(function(u) { return u.last_seen > sw; }).length;
            var stxt = '📈 *إحصائيات*\n\n👥 الكل: ' + st + '\n🟢 اليوم: ' + sad + '\n🔵 الأسبوع: ' + saw + '\n🚫 محظور: ' + sb + '\n🔇 مكتوم: ' + sm + '\n💬 رسائل: ' + stm;
            try { await bot.editMessageText(stxt, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } }); } catch (e) {}
        }
    } catch (err) {
        console.error('خطأ:', err);
    }
});

// ===== معالجة الرسائل =====
bot.on('message', async function(msg) {
    var chatId = msg.chat.id;
    var userId = msg.from.id;
    var userName = msg.from.username;
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

    if (msg.text && msg.text.startsWith('/')) return;

    updateUserData(userId, userName, fullName);
    var user = usersData[userId];

    // ===== المطور =====
    if (chatId.toString() === developerId) {
        // وضع الرد
        if (developerState.action === 'reply' && developerState.targetId) {
            var target = developerState.targetId;
            developerState = {};
            try {
                await bot.copyMessage(target, developerId, msg.message_id);
                await bot.sendMessage(chatId, '✅ تم الإرسال لـ `' + target + '`', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            } catch (err) { await bot.sendMessage(chatId, '❌ فشل: ' + err.message); }
            return;
        }
        // رسالة جماعية
        if (developerState.action === 'broadcast') {
            developerState = {};
            var all = Object.values(usersData).filter(function(u) { return !u.banned && u.id; });
            var ok = 0, fail = 0;
            await bot.sendMessage(chatId, '📢 جاري الإرسال...');
            for (var i = 0; i < all.length; i++) {
                try { await bot.copyMessage(all[i].id, developerId, msg.message_id); ok++; } catch (e) { fail++; }
            }
            await bot.sendMessage(chatId, '✅ تم! نجح: ' + ok + ' | فشل: ' + fail, { reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } });
            return;
        }
        // رد ذكي
        if (msg.reply_to_message) {
            var ot = msg.reply_to_message.text || msg.reply_to_message.caption || '';
            var im = ot.match(/🆔 ID:\s*`?(\d+)`?/);
            if (im) { try { await bot.copyMessage(im[1], developerId, msg.message_id); await bot.sendMessage(chatId, '✅ تم الرد.'); } catch (e) { await bot.sendMessage(chatId, '❌ ' + e.message); } return; }
            if (msg.reply_to_message.forward_from) { try { await bot.copyMessage(msg.reply_to_message.forward_from.id, developerId, msg.message_id); await bot.sendMessage(chatId, '✅ تم.'); } catch (e) {} return; }
        }
        return;
    }

    // ===== المستخدم العادي =====
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
    try {
        await bot.sendMessage(developerId, report, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: qb } });
        if (mediaType) await bot.forwardMessage(developerId, chatId, msg.message_id);
    } catch (e) {}

    // ===== معالجة بالذكاء الاصطناعي =====
    try {
        // صورة
        if (msg.photo) {
            var photoId = msg.photo[msg.photo.length - 1].file_id;
            await bot.sendChatAction(chatId, 'typing');
            var imgReply = await analyzeImage(chatId, photoId, msg.caption);
            await sendLongReply(chatId, imgReply, msg.message_id);
            return;
        }

        // مستند/ملف
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
                return;
            } else {
                await bot.sendMessage(chatId, '📄 استلمت الملف. حالياً أقدر أحلل الملفات النصية والأكواد. لو عندك صورة أرسلها كصورة مباشرة.');
                return;
            }
        }

        // صوت
        if (msg.voice || msg.audio) {
            await bot.sendMessage(chatId, '🎵 استلمت الملف الصوتي. حالياً أقدر أساعدك بالنصوص والصور. أرسل لي سؤالك كتابة وبأجاوبك!');
            return;
        }

        // فيديو
        if (msg.video || msg.video_note || msg.animation) {
            await bot.sendMessage(chatId, '🎬 استلمت الفيديو. حالياً أقدر أساعدك بالنصوص والصور. لو عندك سؤال عن الفيديو اكتبه وبأجاوبك!');
            return;
        }

        // ملصق
        if (msg.sticker) {
            var stickerReply = await chatWithGPT(chatId, 'المستخدم أرسل ملصق (ستيكر) بإيموجي: ' + (msg.sticker.emoji || '😊') + '. رد عليه بشكل لطيف ومرح.');
            await bot.sendMessage(chatId, stickerReply);
            return;
        }

        // نص
        if (msg.text) {
            var text = msg.text.trim();

            // إنشاء صورة
            if (text.match(/^(ارسم|صمم|أنشئ صورة|اصنع صورة|create image|draw|generate)/i)) {
                var imagePrompt = text.replace(/^(ارسم|صمم|أنشئ صورة|اصنع صورة|create image|draw|generate)\s*/i, '').trim();
                if (!imagePrompt) {
                    await bot.sendMessage(chatId, '🎨 اكتب وصف الصورة اللي تبيها.\n\nمثال: ارسم قطة تلعب بالكرة');
                    return;
                }
                await bot.sendChatAction(chatId, 'upload_photo');
                await bot.sendMessage(chatId, '🎨 جاري إنشاء الصورة... لحظات ⏳');
                var imgResult = await generateImage(chatId, imagePrompt);
                if (imgResult.error) {
                    await bot.sendMessage(chatId, '⚠️ ' + imgResult.error);
                } else {
                    await bot.sendPhoto(chatId, imgResult.url, { caption: '🎨 تم إنشاء الصورة!' + (imgResult.revised_prompt ? '\n\n📝 ' + imgResult.revised_prompt : '') });
                    addToHistory(chatId, 'user', 'ارسم: ' + imagePrompt);
                    addToHistory(chatId, 'assistant', '[تم إنشاء صورة: ' + imagePrompt + ']');
                }
                return;
            }

            // تفكير عميق
            if (text.match(/^(فكر:|تفكير عميق:|حلل:|think:)/i)) {
                var thinkPrompt = text.replace(/^(فكر:|تفكير عميق:|حلل:|think:)\s*/i, '').trim();
                if (!thinkPrompt) {
                    await bot.sendMessage(chatId, '🧠 اكتب سؤالك بعد "فكر:"\n\nمثال: فكر: ما مستقبل الذكاء الاصطناعي؟');
                    return;
                }
                await bot.sendChatAction(chatId, 'typing');
                await bot.sendMessage(chatId, '🧠 جاري التفكير العميق... ⏳');
                var deepPrompt = 'أريدك تفكر بعمق وبشكل تحليلي في هذا الموضوع. قدم تحليل شامل من عدة زوايا مع أمثلة وأدلة. فكر خطوة بخطوة:\n\n' + thinkPrompt;
                var thinkReply = await chatWithGPT(chatId, deepPrompt);
                await sendLongReply(chatId, '🧠 *التفكير العميق:*\n\n' + thinkReply, msg.message_id);
                return;
            }

            // محادثة عادية
            await bot.sendChatAction(chatId, 'typing');
            var reply = await chatWithGPT(chatId, text);
            await sendLongReply(chatId, reply, msg.message_id);
        }
    } catch (err) {
        console.error('خطأ AI:', err);
        await bot.sendMessage(chatId, '⚠️ حدث خطأ. حاول مرة ثانية.');
    }

    // رسالة ترحيب (أول مرة أو بعد 3 ساعات)
    var now = Date.now();
    var lastR = user.last_reminder || 0;
    if (lastR === 0) {
        usersData[userId].last_reminder = now;
        saveUsersData();
    }
});

// ===== Express =====
var app = express();
app.get('/', function(req, res) { res.send('Bot is running!'); });
var port = process.env.PORT || 3000;
app.listen(port, function() { console.log('✅ Port ' + port); });
