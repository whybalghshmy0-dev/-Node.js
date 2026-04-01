const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ===== إعدادات البوت =====
const token = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const developerId = '7411444902';
const bot = new TelegramBot(token, { polling: true });

console.log('🛠️ نظام الرادار المتطور يعمل...');

// ===== ملف تخزين بيانات المستخدمين =====
var usersFilePath = path.join(__dirname, 'users_data.json');
var usersData = {};
if (fs.existsSync(usersFilePath)) {
    try { usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8')); } catch (e) { usersData = {}; }
} else {
    fs.writeFileSync(usersFilePath, JSON.stringify({}, null, 2));
}

function saveUsersData() {
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
}

// ===== حالة انتظار الرد من المطور =====
var developerState = {};
// مثال: { action: 'reply', targetId: '123456' }
// أو: { action: 'broadcast' }

function updateUserData(userId, userName, fullName) {
    var now = Date.now();
    if (!usersData[userId]) {
        usersData[userId] = {
            id: String(userId),
            username: userName || '',
            name: fullName || '',
            first_seen: now,
            last_seen: now,
            messages_count: 1,
            last_reminder: 0,
            banned: false,
            muted: false
        };
    } else {
        usersData[userId].last_seen = now;
        usersData[userId].messages_count = (usersData[userId].messages_count || 0) + 1;
        if (userName) usersData[userId].username = userName;
        if (fullName) usersData[userId].name = fullName;
    }
    saveUsersData();
}

function formatTime(timestamp) {
    var date = new Date(timestamp);
    return date.toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserDisplayName(user) {
    var name = user.name || 'بدون اسم';
    if (user.username) name += ' (@' + user.username + ')';
    return name;
}

// ===== دالة بناء أزرار المستخدمين =====
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

    // أزرار التنقل
    var navRow = [];
    if (page > 1) navRow.push({ text: '⬅️ السابق', callback_data: actionPrefix + '_page_' + (page - 1) });
    navRow.push({ text: '📄 ' + page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: 'التالي ➡️', callback_data: actionPrefix + '_page_' + (page + 1) });
    if (navRow.length > 0) buttons.push(navRow);

    // زر الرجوع
    buttons.push([{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]);

    return { buttons: buttons, total: allUsers.length, page: page, totalPages: totalPages };
}

// ===== لوحة التحكم الرئيسية =====
async function sendMainMenu(chatId, editMessageId) {
    var totalUsers = Object.keys(usersData).length;
    var bannedCount = Object.values(usersData).filter(function(u) { return u.banned; }).length;
    var mutedCount = Object.values(usersData).filter(function(u) { return u.muted; }).length;
    var totalMessages = Object.values(usersData).reduce(function(sum, u) { return sum + (u.messages_count || 0); }, 0);
    var oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    var activeToday = Object.values(usersData).filter(function(u) { return u.last_seen > oneDayAgo; }).length;

    var text = '🔧 *لوحة تحكم المطور*\n\n';
    text += '👥 المستخدمين: ' + totalUsers + '\n';
    text += '🟢 نشطين اليوم: ' + activeToday + '\n';
    text += '🚫 محظورين: ' + bannedCount + '\n';
    text += '🔇 مكتومين: ' + mutedCount + '\n';
    text += '💬 إجمالي الرسائل: ' + totalMessages + '\n\n';
    text += '⬇️ *اختر الإجراء:*';

    var keyboard = {
        inline_keyboard: [
            [{ text: '📊 عرض المستخدمين', callback_data: 'list_users_1' }],
            [{ text: '🔨 حظر مستخدم', callback_data: 'pick_ban_1' }, { text: '🔓 رفع الحظر', callback_data: 'pick_unban_1' }],
            [{ text: '🔇 كتم مستخدم', callback_data: 'pick_mute_1' }, { text: '🔊 رفع الكتم', callback_data: 'pick_unmute_1' }],
            [{ text: '👢 طرد مستخدم', callback_data: 'pick_kick_1' }],
            [{ text: '💬 رد على مستخدم', callback_data: 'pick_reply_1' }],
            [{ text: '📢 رسالة جماعية', callback_data: 'start_broadcast' }],
            [{ text: '📈 الإحصائيات', callback_data: 'stats' }]
        ]
    };

    if (editMessageId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, parse_mode: 'Markdown', reply_markup: keyboard });
            return;
        } catch (e) { /* fallback to send */ }
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ===== عرض قائمة المستخدمين =====
async function sendUserList(chatId, page, messageId) {
    var result = buildUserButtons('view_user', page, null);
    var text = '📊 *قائمة المستخدمين* (' + result.total + ' مستخدم)\n\nاضغط على أي مستخدم لعرض تفاصيله:';

    var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: result.buttons } };
    if (messageId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
    }
    await bot.sendMessage(chatId, text, opts);
}

// ===== عرض تفاصيل مستخدم =====
async function sendUserDetails(chatId, targetId, messageId) {
    var user = usersData[targetId];
    if (!user) {
        await bot.sendMessage(chatId, '❌ المستخدم غير موجود.');
        return;
    }

    var text = '👤 *تفاصيل المستخدم*\n\n';
    text += '📝 الاسم: ' + (user.name || 'بدون اسم') + '\n';
    text += '🔗 اليوزر: ' + (user.username ? '@' + user.username : 'بدون يوزر') + '\n';
    text += '🆔 ID: `' + user.id + '`\n';
    text += '📨 عدد الرسائل: ' + (user.messages_count || 0) + '\n';
    text += '📅 أول ظهور: ' + formatTime(user.first_seen) + '\n';
    text += '🕒 آخر تفاعل: ' + formatTime(user.last_seen) + '\n';
    text += '🚫 الحظر: ' + (user.banned ? '✅ محظور' : '❌ غير محظور') + '\n';
    text += '🔇 الكتم: ' + (user.muted ? '✅ مكتوم' : '❌ غير مكتوم') + '\n';

    var buttons = [
        [
            { text: user.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'quick_' + (user.banned ? 'unban' : 'ban') + '_' + targetId },
            { text: user.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'quick_' + (user.muted ? 'unmute' : 'mute') + '_' + targetId }
        ],
        [
            { text: '💬 رد عليه', callback_data: 'quick_reply_' + targetId },
            { text: '👢 طرد', callback_data: 'quick_kick_' + targetId }
        ],
        [{ text: '🔙 رجوع للقائمة', callback_data: 'list_users_1' }],
        [{ text: '🏠 اللوحة الرئيسية', callback_data: 'main_menu' }]
    ];

    var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
    if (messageId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
    }
    await bot.sendMessage(chatId, text, opts);
}

// ===== عرض قائمة اختيار مستخدم لإجراء معين =====
async function sendPickUser(chatId, action, page, messageId) {
    var titles = {
        'pick_ban': '🔨 *اختر المستخدم للحظر:*',
        'pick_unban': '🔓 *اختر المستخدم لرفع الحظر:*',
        'pick_mute': '🔇 *اختر المستخدم للكتم:*',
        'pick_unmute': '🔊 *اختر المستخدم لرفع الكتم:*',
        'pick_kick': '👢 *اختر المستخدم للطرد:*',
        'pick_reply': '💬 *اختر المستخدم للرد عليه:*'
    };

    var filters = {
        'pick_ban': function(u) { return !u.banned; },
        'pick_unban': function(u) { return u.banned; },
        'pick_mute': function(u) { return !u.muted; },
        'pick_unmute': function(u) { return u.muted; },
        'pick_kick': null,
        'pick_reply': null
    };

    var actionPrefix = 'do_' + action.replace('pick_', '');
    var result = buildUserButtons(actionPrefix, page, filters[action]);
    var title = titles[action] || 'اختر مستخدم:';

    if (result.total === 0) {
        var emptyMsg = title + '\n\n⚠️ لا يوجد مستخدمين متاحين لهذا الإجراء.';
        var emptyButtons = [[{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]];
        var opts2 = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: emptyButtons } };
        if (messageId) {
            try { await bot.editMessageText(emptyMsg, { chat_id: chatId, message_id: messageId, ...opts2 }); return; } catch (e) { }
        }
        await bot.sendMessage(chatId, emptyMsg, opts2);
        return;
    }

    var text = title + '\n\n👆 اضغط على المستخدم:';
    var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: result.buttons } };
    if (messageId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
    }
    await bot.sendMessage(chatId, text, opts);
}

// ===== تأكيد الإجراء =====
async function sendConfirmation(chatId, action, targetId, messageId) {
    var user = usersData[targetId];
    if (!user) {
        await bot.sendMessage(chatId, '❌ المستخدم غير موجود.');
        return;
    }

    var actionTexts = {
        'ban': '🔨 *تأكيد الحظر*\n\nهل تريد حظر هذا المستخدم؟',
        'unban': '🔓 *تأكيد رفع الحظر*\n\nهل تريد رفع الحظر عن هذا المستخدم؟',
        'mute': '🔇 *تأكيد الكتم*\n\nهل تريد كتم هذا المستخدم؟',
        'unmute': '🔊 *تأكيد رفع الكتم*\n\nهل تريد رفع الكتم عن هذا المستخدم؟',
        'kick': '👢 *تأكيد الطرد*\n\n⚠️ هل تريد طرد هذا المستخدم وحذف جميع بياناته؟'
    };

    var text = (actionTexts[action] || 'تأكيد الإجراء') + '\n\n';
    text += '👤 ' + (user.name || 'بدون اسم') + '\n';
    text += '🆔 ID: `' + user.id + '`\n';
    if (user.username) text += '🔗 @' + user.username + '\n';

    var buttons = [
        [
            { text: '✅ نعم، نفذ', callback_data: 'confirm_' + action + '_' + targetId },
            { text: '❌ لا، إلغاء', callback_data: 'main_menu' }
        ]
    ];

    var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
    if (messageId) {
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
    }
    await bot.sendMessage(chatId, text, opts);
}

// ===== تنفيذ الإجراء =====
async function executeAction(chatId, action, targetId, messageId) {
    var user = usersData[targetId];
    var resultText = '';

    if (action === 'ban') {
        if (!user) { usersData[targetId] = { id: targetId, banned: true, muted: false, messages_count: 0, first_seen: Date.now(), last_seen: Date.now() }; }
        else { usersData[targetId].banned = true; }
        saveUsersData();
        resultText = '✅ *تم الحظر بنجاح!*\n\n🚫 المستخدم `' + targetId + '` محظور الآن.';
        // إبلاغ المستخدم
        try { await bot.sendMessage(targetId, '⛔ تم حظرك من التواصل مع هذا البوت.'); } catch (e) { }
    }
    else if (action === 'unban') {
        if (user) { usersData[targetId].banned = false; saveUsersData(); }
        resultText = '✅ *تم رفع الحظر!*\n\n🔓 المستخدم `' + targetId + '` يمكنه التواصل الآن.';
        try { await bot.sendMessage(targetId, '✅ تم رفع الحظر عنك. يمكنك التواصل معنا مجدداً.'); } catch (e) { }
    }
    else if (action === 'mute') {
        if (!user) { usersData[targetId] = { id: targetId, banned: false, muted: true, messages_count: 0, first_seen: Date.now(), last_seen: Date.now() }; }
        else { usersData[targetId].muted = true; }
        saveUsersData();
        resultText = '✅ *تم الكتم بنجاح!*\n\n🔇 المستخدم `' + targetId + '` مكتوم الآن (رسائله لن تصلك).';
    }
    else if (action === 'unmute') {
        if (user) { usersData[targetId].muted = false; saveUsersData(); }
        resultText = '✅ *تم رفع الكتم!*\n\n🔊 المستخدم `' + targetId + '` رسائله ستصلك الآن.';
    }
    else if (action === 'kick') {
        if (user) { delete usersData[targetId]; saveUsersData(); }
        resultText = '✅ *تم الطرد بنجاح!*\n\n👢 المستخدم `' + targetId + '` تم حذف جميع بياناته.';
        try { await bot.sendMessage(targetId, '👢 تم إزالتك من النظام.'); } catch (e) { }
    }
    else if (action === 'reply') {
        // تفعيل وضع انتظار الرد
        developerState = { action: 'reply', targetId: targetId };
        var userName = user ? getUserDisplayName(user) : targetId;
        resultText = '💬 *وضع الرد مفعل*\n\n';
        resultText += '👤 الرد على: ' + userName + '\n\n';
        resultText += '✏️ اكتب رسالتك الآن (نص، صورة، فيديو، أي شيء) وسيتم إرسالها مباشرة.\n\n';
        resultText += '❌ للإلغاء اضغط الزر:';

        var cancelBtn = [[{ text: '❌ إلغاء الرد', callback_data: 'cancel_reply' }]];
        var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: cancelBtn } };
        if (messageId) {
            try { await bot.editMessageText(resultText, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
        }
        await bot.sendMessage(chatId, resultText, opts);
        return;
    }

    // عرض النتيجة مع زر الرجوع
    var buttons = [
        [{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]
    ];
    var opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
    if (messageId) {
        try { await bot.editMessageText(resultText, { chat_id: chatId, message_id: messageId, ...opts }); return; } catch (e) { }
    }
    await bot.sendMessage(chatId, resultText, opts);
}

// ===== أمر /start و /panel =====
bot.onText(/^\/(start|panel)$/, async function(msg) {
    var chatId = msg.chat.id;
    var userId = msg.from.id;

    if (chatId.toString() === developerId || userId.toString() === developerId) {
        developerState = {}; // إلغاء أي حالة انتظار
        await sendMainMenu(chatId);
        return;
    }

    // المستخدم العادي
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
    updateUserData(userId, msg.from.username, fullName);
    if (usersData[userId]) { usersData[userId].last_reminder = Date.now(); saveUsersData(); }
    await bot.sendMessage(chatId, '👋 أهلاً بك!\n\nيمكنك إرسال رسالتك هنا (نص، صورة، فيديو، ملف، صوت، أي شيء) وسوف تصل مباشرة.\n\n📌 سيتم الرد عليك في أقرب وقت.');
});

// ===== معالجة الأزرار =====
bot.on('callback_query', async function(query) {
    var chatId = query.message.chat.id;
    var userId = query.from.id;
    var msgId = query.message.message_id;
    var data = query.data;

    // التحقق من المطور
    if (chatId.toString() !== developerId && userId.toString() !== developerId) {
        await bot.answerCallbackQuery(query.id, { text: 'هذه اللوحة مخصصة للمطور فقط.', show_alert: true });
        return;
    }

    await bot.answerCallbackQuery(query.id);

    try {
        // ===== اللوحة الرئيسية =====
        if (data === 'main_menu') {
            developerState = {};
            await sendMainMenu(chatId, msgId);
        }
        // ===== noop (لا شيء) =====
        else if (data === 'noop') {
            // لا شيء
        }
        // ===== عرض المستخدمين =====
        else if (data.startsWith('list_users_')) {
            var page = parseInt(data.replace('list_users_', ''));
            await sendUserList(chatId, page, msgId);
        }
        // ===== تفاصيل مستخدم =====
        else if (data.startsWith('view_user_page_')) {
            var pg = parseInt(data.replace('view_user_page_', ''));
            await sendUserList(chatId, pg, msgId);
        }
        else if (data.startsWith('view_user_')) {
            var tid = data.replace('view_user_', '');
            await sendUserDetails(chatId, tid, msgId);
        }
        // ===== اختيار مستخدم لإجراء =====
        else if (data.startsWith('pick_ban_') || data.startsWith('pick_unban_') || data.startsWith('pick_mute_') || data.startsWith('pick_unmute_') || data.startsWith('pick_kick_') || data.startsWith('pick_reply_')) {
            // استخراج الإجراء والصفحة
            var parts = data.split('_');
            var actionName = 'pick_' + parts[1];
            var pg2 = parseInt(parts[2]) || 1;
            await sendPickUser(chatId, actionName, pg2, msgId);
        }
        // ===== تنقل صفحات الاختيار =====
        else if (data.startsWith('do_ban_page_') || data.startsWith('do_unban_page_') || data.startsWith('do_mute_page_') || data.startsWith('do_unmute_page_') || data.startsWith('do_kick_page_') || data.startsWith('do_reply_page_')) {
            var parts2 = data.split('_');
            // do_ban_page_2 → pick_ban, page 2
            var act = 'pick_' + parts2[1];
            var pg3 = parseInt(parts2[3]) || 1;
            await sendPickUser(chatId, act, pg3, msgId);
        }
        // ===== تنفيذ إجراء (عرض تأكيد) =====
        else if (data.startsWith('do_ban_') || data.startsWith('do_unban_') || data.startsWith('do_mute_') || data.startsWith('do_unmute_') || data.startsWith('do_kick_')) {
            var parts3 = data.split('_');
            var act2 = parts3[1]; // ban, unban, mute, unmute, kick
            var tid2 = parts3[2];
            await sendConfirmation(chatId, act2, tid2, msgId);
        }
        // ===== الرد على مستخدم =====
        else if (data.startsWith('do_reply_')) {
            var tid3 = data.replace('do_reply_', '');
            await executeAction(chatId, 'reply', tid3, msgId);
        }
        // ===== تأكيد التنفيذ =====
        else if (data.startsWith('confirm_')) {
            var parts4 = data.replace('confirm_', '').split('_');
            var act3 = parts4[0];
            var tid4 = parts4[1];
            await executeAction(chatId, act3, tid4, msgId);
        }
        // ===== إجراءات سريعة من صفحة التفاصيل =====
        else if (data.startsWith('quick_reply_')) {
            var tid5 = data.replace('quick_reply_', '');
            await executeAction(chatId, 'reply', tid5, msgId);
        }
        else if (data.startsWith('quick_ban_') || data.startsWith('quick_unban_') || data.startsWith('quick_mute_') || data.startsWith('quick_unmute_') || data.startsWith('quick_kick_')) {
            var parts5 = data.replace('quick_', '').split('_');
            var act4 = parts5[0];
            var tid6 = parts5[1];
            await sendConfirmation(chatId, act4, tid6, msgId);
        }
        // ===== إلغاء الرد =====
        else if (data === 'cancel_reply') {
            developerState = {};
            await sendMainMenu(chatId, msgId);
        }
        // ===== رسالة جماعية =====
        else if (data === 'start_broadcast') {
            developerState = { action: 'broadcast' };
            var bcText = '📢 *وضع الرسالة الجماعية*\n\n';
            bcText += '✏️ اكتب رسالتك الآن وسيتم إرسالها لجميع المستخدمين.\n\n';
            bcText += '👥 سيتم الإرسال لـ ' + Object.values(usersData).filter(function(u) { return !u.banned; }).length + ' مستخدم\n\n';
            bcText += '❌ للإلغاء اضغط الزر:';
            var cancelBc = [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]];
            try {
                await bot.editMessageText(bcText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: cancelBc } });
            } catch (e) {
                await bot.sendMessage(chatId, bcText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: cancelBc } });
            }
        }
        // ===== الإحصائيات =====
        else if (data === 'stats') {
            var totalUsers = Object.keys(usersData).length;
            var banned = Object.values(usersData).filter(function(u) { return u.banned; }).length;
            var muted = Object.values(usersData).filter(function(u) { return u.muted; }).length;
            var totalMsgs = Object.values(usersData).reduce(function(sum, u) { return sum + (u.messages_count || 0); }, 0);
            var dayAgo = Date.now() - (24 * 60 * 60 * 1000);
            var weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
            var activeDay = Object.values(usersData).filter(function(u) { return u.last_seen > dayAgo; }).length;
            var activeWeek = Object.values(usersData).filter(function(u) { return u.last_seen > weekAgo; }).length;

            var sText = '📈 *الإحصائيات الكاملة*\n\n';
            sText += '👥 إجمالي المستخدمين: ' + totalUsers + '\n';
            sText += '🟢 نشطين (24 ساعة): ' + activeDay + '\n';
            sText += '🔵 نشطين (أسبوع): ' + activeWeek + '\n';
            sText += '🚫 محظورين: ' + banned + '\n';
            sText += '🔇 مكتومين: ' + muted + '\n';
            sText += '💬 إجمالي الرسائل: ' + totalMsgs + '\n';

            var sBtn = [[{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]];
            try {
                await bot.editMessageText(sText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: sBtn } });
            } catch (e) {
                await bot.sendMessage(chatId, sText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: sBtn } });
            }
        }
    } catch (error) {
        console.error('خطأ في معالجة الزر:', error);
        await bot.sendMessage(chatId, '⚠️ حدث خطأ: ' + error.message);
    }
});

// ===== قائمة أنواع الوسائط =====
var forwardableTypes = ['photo', 'video', 'audio', 'voice', 'document', 'video_note', 'sticker', 'animation', 'location', 'venue', 'contact', 'poll'];

function getMediaType(msg) {
    for (var i = 0; i < forwardableTypes.length; i++) {
        if (msg[forwardableTypes[i]]) return forwardableTypes[i];
    }
    return null;
}

function buildReport(msg, mediaType) {
    var userId = msg.from.id;
    var userName = msg.from.username || 'بدون يوزر';
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim() || 'بدون اسم';
    var lang = msg.from.language_code || 'غير معروف';
    var time = new Date().toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });

    var report = '👤 *مستخدم يتواصل:*\n';
    report += '📝 الاسم: ' + fullName + '\n';
    report += '🔗 اليوزر: @' + userName + '\n';
    report += '🆔 ID: `' + userId + '`\n';
    report += '🌍 اللغة: ' + lang + '\n';
    report += '🕒 الوقت: ' + time + '\n';
    if (mediaType) report += '📎 نوع: ' + mediaType.toUpperCase() + '\n';
    var caption = msg.caption || msg.text;
    if (caption) report += '💬 النص: ' + caption + '\n';
    return report;
}

// ===== معالجة الرسائل العامة =====
bot.on('message', async function(msg) {
    var chatId = msg.chat.id;
    var userId = msg.from.id;
    var userName = msg.from.username;
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

    // تجاهل الأوامر
    if (msg.text && msg.text.startsWith('/')) return;

    // ===== رسائل المطور =====
    if (chatId.toString() === developerId) {

        // وضع الرد على مستخدم
        if (developerState.action === 'reply' && developerState.targetId) {
            var targetId = developerState.targetId;
            developerState = {};
            try {
                await bot.copyMessage(targetId, developerId, msg.message_id);
                var successText = '✅ تم إرسال ردك للمستخدم `' + targetId + '` بنجاح!';
                var backBtn = [[{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]];
                await bot.sendMessage(chatId, successText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: backBtn } });
            } catch (err) {
                await bot.sendMessage(chatId, '❌ فشل إرسال الرد: ' + err.message, {
                    reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] }
                });
            }
            return;
        }

        // وضع الرسالة الجماعية
        if (developerState.action === 'broadcast') {
            developerState = {};
            var allUsers = Object.values(usersData).filter(function(u) { return !u.banned && u.id; });
            var sent = 0;
            var failed = 0;

            await bot.sendMessage(chatId, '📢 جاري الإرسال لـ ' + allUsers.length + ' مستخدم...');

            for (var i = 0; i < allUsers.length; i++) {
                try {
                    await bot.copyMessage(allUsers[i].id, developerId, msg.message_id);
                    sent++;
                } catch (err) {
                    failed++;
                }
            }

            var bcResult = '✅ *تم الإرسال الجماعي!*\n\n📨 نجح: ' + sent + '\n❌ فشل: ' + failed;
            var backBtn2 = [[{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]];
            await bot.sendMessage(chatId, bcResult, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: backBtn2 } });
            return;
        }

        // الرد الذكي (Reply على رسالة محولة)
        if (msg.reply_to_message) {
            var origText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
            var idMatch = origText.match(/🆔 ID:\s*`?(\d+)`?/);
            if (idMatch) {
                var replyTarget = idMatch[1];
                try {
                    await bot.copyMessage(replyTarget, developerId, msg.message_id);
                    await bot.sendMessage(developerId, '✅ تم إرسال ردك للمستخدم `' + replyTarget + '`.', { parse_mode: 'Markdown' });
                } catch (err) {
                    await bot.sendMessage(developerId, '❌ فشل: ' + err.message);
                }
                return;
            }
            if (msg.reply_to_message.forward_from) {
                try {
                    await bot.copyMessage(msg.reply_to_message.forward_from.id, developerId, msg.message_id);
                    await bot.sendMessage(developerId, '✅ تم إرسال ردك.');
                } catch (err) {
                    await bot.sendMessage(developerId, '❌ فشل: ' + err.message);
                }
                return;
            }
        }
        return;
    }

    // ===== رسائل المستخدمين العاديين =====
    updateUserData(userId, userName, fullName);
    var user = usersData[userId];

    // محظور
    if (user && user.banned) {
        await bot.sendMessage(chatId, '⛔ أنت محظور من التواصل مع هذا البوت.');
        return;
    }

    // مكتوم (لا نحول رسالته ولا نخبره)
    if (user && user.muted) return;

    var mediaType = getMediaType(msg);
    var report = buildReport(msg, mediaType);

    // إرسال التقرير للمطور مع أزرار سريعة
    var quickButtons = [
        [
            { text: '💬 رد', callback_data: 'quick_reply_' + userId },
            { text: '🔨 حظر', callback_data: 'quick_ban_' + userId },
            { text: '🔇 كتم', callback_data: 'quick_mute_' + userId }
        ]
    ];

    try {
        await bot.sendMessage(developerId, report, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: quickButtons } });
        if (mediaType) {
            await bot.forwardMessage(developerId, chatId, msg.message_id);
        }
    } catch (err) {
        console.error('خطأ في إرسال التقرير:', err);
    }

    // رسالة ترحيب (أول مرة أو بعد 3 ساعات)
    var now = Date.now();
    var THREE_HOURS = 3 * 60 * 60 * 1000;
    var lastReminder = user.last_reminder || 0;

    if (lastReminder === 0 || (now - lastReminder) > THREE_HOURS) {
        usersData[userId].last_reminder = now;
        saveUsersData();
        await bot.sendMessage(chatId, '👋 أهلاً بك!\n\nرسالتك وصلت وسيتم الرد عليك في أقرب وقت. 📌');
    }
});

// ===== Express Server =====
var app = express();
app.get('/', function(req, res) { res.send('Radar System is Active!'); });
var port = process.env.PORT || 3000;
app.listen(port, function() { console.log('✅ Express server running on port ' + port); });
