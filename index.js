const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ===== إعدادات البوت =====
const token = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const developerId = '7411444902'; // ايدي لبيب
const bot = new TelegramBot(token, { polling: true });

console.log('🛠️ نظام الرادار والتواصل المتطور يعمل...');

// ===== ملف تخزين بيانات المستخدمين =====
const usersFilePath = path.join(__dirname, 'users_data.json');
let usersData = {};
if (fs.existsSync(usersFilePath)) {
    try {
        usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
    } catch (e) {
        usersData = {};
    }
} else {
    fs.writeFileSync(usersFilePath, JSON.stringify({}, null, 2));
}

function saveUsersData() {
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
}

function updateUserData(userId, userName, fullName) {
    const now = Date.now();
    if (!usersData[userId]) {
        usersData[userId] = {
            id: userId,
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

function formatLastSeen(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

// ===== لوحة التحكم الرئيسية (أزرار) =====
function getMainMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 عرض المستخدمين', callback_data: 'users' }],
                [{ text: '➕ حظر مستخدم', callback_data: 'ban' }, { text: '🔓 رفع الحظر', callback_data: 'unban' }],
                [{ text: '🔇 كتم مستخدم', callback_data: 'mute' }, { text: '🔊 رفع الكتم', callback_data: 'unmute' }],
                [{ text: '👢 طرد مستخدم', callback_data: 'kick' }],
                [{ text: '💬 رد على مستخدم', callback_data: 'reply' }],
                [{ text: '📈 الإحصائيات', callback_data: 'stats' }],
                [{ text: '📢 إرسال رسالة جماعية', callback_data: 'broadcast' }]
            ]
        }
    };
}

// دالة إرسال اللوحة للمطور
async function sendDeveloperPanel(chatId) {
    try {
        var totalUsers = Object.keys(usersData).length;
        var bannedCount = Object.values(usersData).filter(function(u) { return u.banned; }).length;
        var totalMessages = Object.values(usersData).reduce(function(sum, u) { return sum + (u.messages_count || 0); }, 0);

        var welcomeText = '🔧 *لوحة تحكم المطور*\n\n';
        welcomeText += '👥 المستخدمين: ' + totalUsers + '\n';
        welcomeText += '🚫 المحظورين: ' + bannedCount + '\n';
        welcomeText += '💬 إجمالي الرسائل: ' + totalMessages + '\n\n';
        welcomeText += '⬇️ اختر الإجراء المطلوب:';

        await bot.sendMessage(chatId, welcomeText, {
            parse_mode: 'Markdown',
            ...getMainMenuKeyboard()
        });
    } catch (err) {
        console.error('خطأ في إرسال اللوحة:', err);
    }
}

// دالة عرض المستخدمين مع أزرار تنقل
async function sendUserList(chatId, page) {
    page = page || 1;
    var users = Object.values(usersData).sort(function(a, b) { return b.last_seen - a.last_seen; });
    if (users.length === 0) {
        await bot.sendMessage(chatId, 'لا يوجد مستخدمون مسجلون بعد.');
        return;
    }

    var perPage = 10;
    var totalPages = Math.ceil(users.length / perPage);
    var start = (page - 1) * perPage;
    var end = start + perPage;
    var pageUsers = users.slice(start, end);

    var message = '📊 *قائمة المستخدمين (الصفحة ' + page + '/' + totalPages + ')*\n\n';
    for (var i = 0; i < pageUsers.length; i++) {
        var user = pageUsers[i];
        var status = [];
        if (user.banned) status.push('🚫 محظور');
        if (user.muted) status.push('🔇 مكتوم');
        var statusText = status.length ? ' (' + status.join(', ') + ')' : '';
        message += '👤 ' + (user.name || 'بدون اسم') + ' (@' + (user.username || 'بدون يوزر') + ')\n';
        message += '🆔 ID: `' + user.id + '`\n';
        message += '📨 رسائل: ' + (user.messages_count || 0) + '\n';
        message += '🕒 آخر تفاعل: ' + formatLastSeen(user.last_seen) + statusText + '\n\n';
    }

    var navigation = [];
    if (page > 1) navigation.push({ text: '⬅️ السابق', callback_data: 'users_' + (page - 1) });
    if (page < totalPages) navigation.push({ text: 'التالي ➡️', callback_data: 'users_' + (page + 1) });

    var replyMarkup = { inline_keyboard: [] };
    if (navigation.length) replyMarkup.inline_keyboard.push(navigation);
    replyMarkup.inline_keyboard.push([{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
    });
}

// ===== معالجة أمر /start و /panel =====
bot.onText(/^\/(start|panel)$/, async function(msg) {
    var chatId = msg.chat.id;
    var userId = msg.from.id;

    // المطور → لوحة التحكم
    if (chatId.toString() === developerId || userId.toString() === developerId) {
        await sendDeveloperPanel(chatId);
        return;
    }

    // المستخدم العادي → رسالة ترحيب
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();
    updateUserData(userId, msg.from.username, fullName);
    if (usersData[userId]) usersData[userId].last_reminder = Date.now();
    saveUsersData();

    await bot.sendMessage(chatId, '👋 أهلاً بك!\n\nيمكنك إرسال رسالتك هنا (نص، صورة، فيديو، ملف، صوت، أي شيء) وسوف تصل إلى المطور مباشرة.\n\n📌 سيتم الرد عليك في أقرب وقت.');
});

// ===== معالجة الأزرار (callback_query) =====
bot.on('callback_query', async function(callbackQuery) {
    var chatId = callbackQuery.message.chat.id;
    var userId = callbackQuery.from.id;
    var data = callbackQuery.data;

    // التحقق من أن المستخدم هو المطور
    if (chatId.toString() !== developerId && userId.toString() !== developerId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'هذه اللوحة مخصصة للمطور فقط.', show_alert: true });
        return;
    }

    await bot.answerCallbackQuery(callbackQuery.id);

    try {
        // زر الرجوع للوحة الرئيسية
        if (data === 'main_menu') {
            await sendDeveloperPanel(chatId);
        }
        else if (data === 'users') {
            await sendUserList(chatId, 1);
        }
        else if (data.startsWith('users_')) {
            var page = parseInt(data.split('_')[1]);
            await sendUserList(chatId, page);
        }
        else if (data === 'ban') {
            await bot.sendMessage(chatId, '🔨 أرسل الأمر التالي لحظر مستخدم:\n\n`/ban معرف_المستخدم`\n\nمثال:\n`/ban 123456789`', { parse_mode: 'Markdown' });
        }
        else if (data === 'unban') {
            await bot.sendMessage(chatId, '🔓 أرسل الأمر التالي لرفع الحظر:\n\n`/unban معرف_المستخدم`\n\nمثال:\n`/unban 123456789`', { parse_mode: 'Markdown' });
        }
        else if (data === 'mute') {
            await bot.sendMessage(chatId, '🔇 أرسل الأمر التالي لكتم مستخدم:\n\n`/mute معرف_المستخدم`\n\nمثال:\n`/mute 123456789`', { parse_mode: 'Markdown' });
        }
        else if (data === 'unmute') {
            await bot.sendMessage(chatId, '🔊 أرسل الأمر التالي لرفع الكتم:\n\n`/unmute معرف_المستخدم`\n\nمثال:\n`/unmute 123456789`', { parse_mode: 'Markdown' });
        }
        else if (data === 'kick') {
            await bot.sendMessage(chatId, '👢 أرسل الأمر التالي لطرد مستخدم:\n\n`/kick معرف_المستخدم`\n\nمثال:\n`/kick 123456789`\n\n⚠️ هذا سيحذف جميع بيانات المستخدم.', { parse_mode: 'Markdown' });
        }
        else if (data === 'reply') {
            await bot.sendMessage(chatId, '💬 عندك طريقتين للرد:\n\n*الطريقة 1 (الأسهل):*\nاعمل رد (Reply) على رسالة المستخدم المحولة وسيصل الرد تلقائياً.\n\n*الطريقة 2:*\nأرسل الأمر:\n`/reply معرف_المستخدم النص`\n\nمثال:\n`/reply 123456789 أهلاً بك، كيف أقدر أساعدك؟`', { parse_mode: 'Markdown' });
        }
        else if (data === 'broadcast') {
            await bot.sendMessage(chatId, '📢 لإرسال رسالة جماعية لجميع المستخدمين:\n\n`/broadcast النص المراد إرساله`\n\nمثال:\n`/broadcast مرحباً بالجميع! عندنا تحديث جديد.`\n\n⚠️ سيتم إرسالها لجميع المستخدمين غير المحظورين.', { parse_mode: 'Markdown' });
        }
        else if (data === 'stats') {
            var totalUsers = Object.keys(usersData).length;
            var banned = Object.values(usersData).filter(function(u) { return u.banned; }).length;
            var muted = Object.values(usersData).filter(function(u) { return u.muted; }).length;
            var totalMessages = Object.values(usersData).reduce(function(sum, u) { return sum + (u.messages_count || 0); }, 0);

            // حساب المستخدمين النشطين (آخر 24 ساعة)
            var oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
            var activeToday = Object.values(usersData).filter(function(u) { return u.last_seen > oneDayAgo; }).length;

            var statsMsg = '📈 *الإحصائيات الكاملة*\n\n';
            statsMsg += '👥 إجمالي المستخدمين: ' + totalUsers + '\n';
            statsMsg += '🟢 نشطين (آخر 24 ساعة): ' + activeToday + '\n';
            statsMsg += '🚫 محظورون: ' + banned + '\n';
            statsMsg += '🔇 مكتومون: ' + muted + '\n';
            statsMsg += '💬 إجمالي الرسائل: ' + totalMessages + '\n';

            await bot.sendMessage(chatId, statsMsg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔙 رجوع للوحة التحكم', callback_data: 'main_menu' }]
                    ]
                }
            });
        }
    } catch (error) {
        console.error('خطأ في معالجة الزر:', error);
        await bot.sendMessage(chatId, '⚠️ حدث خطأ: ' + error.message);
    }
});

// ===== قائمة بأنواع الوسائط =====
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
    if (mediaType) report += '📎 نوع الوسائط: ' + mediaType.toUpperCase() + '\n';
    var caption = msg.caption || msg.text;
    if (caption) report += '💬 النص: ' + caption + '\n';
    if (msg.location) report += '📍 الموقع: ' + msg.location.latitude + ', ' + msg.location.longitude + '\n';
    if (msg.venue) report += '🏢 المكان: ' + msg.venue.title + '\n' + msg.venue.address + '\n';
    if (msg.contact) report += '📞 جهة اتصال: ' + msg.contact.first_name + ' ' + (msg.contact.last_name || '') + '\nرقم: ' + msg.contact.phone_number + '\n';
    if (msg.poll) report += '📊 استطلاع: ' + msg.poll.question + '\n';
    return report;
}

// ===== أوامر المطور النصية =====

// أمر الحظر
bot.onText(/^\/ban\s+(\d+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    if (!usersData[targetId]) usersData[targetId] = { id: targetId, banned: false, muted: false, messages_count: 0 };
    usersData[targetId].banned = true;
    saveUsersData();
    await bot.sendMessage(chatId, '✅ تم حظر المستخدم `' + targetId + '` بنجاح.', { parse_mode: 'Markdown' });
});

// أمر رفع الحظر
bot.onText(/^\/unban\s+(\d+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    if (usersData[targetId]) {
        usersData[targetId].banned = false;
        saveUsersData();
        await bot.sendMessage(chatId, '✅ تم رفع الحظر عن المستخدم `' + targetId + '`.', { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '❌ المستخدم `' + targetId + '` غير موجود.', { parse_mode: 'Markdown' });
    }
});

// أمر الكتم
bot.onText(/^\/mute\s+(\d+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    if (!usersData[targetId]) usersData[targetId] = { id: targetId, banned: false, muted: false, messages_count: 0 };
    usersData[targetId].muted = true;
    saveUsersData();
    await bot.sendMessage(chatId, '✅ تم كتم المستخدم `' + targetId + '`.', { parse_mode: 'Markdown' });
});

// أمر رفع الكتم
bot.onText(/^\/unmute\s+(\d+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    if (usersData[targetId]) {
        usersData[targetId].muted = false;
        saveUsersData();
        await bot.sendMessage(chatId, '✅ تم رفع الكتم عن المستخدم `' + targetId + '`.', { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '❌ المستخدم `' + targetId + '` غير موجود.', { parse_mode: 'Markdown' });
    }
});

// أمر الطرد
bot.onText(/^\/kick\s+(\d+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    if (usersData[targetId]) {
        delete usersData[targetId];
        saveUsersData();
        await bot.sendMessage(chatId, '✅ تم طرد المستخدم `' + targetId + '` وحذف بياناته.', { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, '❌ المستخدم `' + targetId + '` غير موجود.', { parse_mode: 'Markdown' });
    }
});

// أمر الرد
bot.onText(/^\/reply\s+(\d+)\s+(.+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var targetId = match[1];
    var replyText = match[2];
    try {
        await bot.sendMessage(targetId, '📩 *رد من الإدارة:*\n' + replyText, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, '✅ تم إرسال الرد إلى `' + targetId + '`.', { parse_mode: 'Markdown' });
    } catch (err) {
        await bot.sendMessage(chatId, '❌ فشل الإرسال: ' + err.message);
    }
});

// أمر الرسالة الجماعية
bot.onText(/^\/broadcast\s+(.+)/, async function(msg, match) {
    var chatId = msg.chat.id;
    if (chatId.toString() !== developerId) return;
    var broadcastText = match[1];
    var allUsers = Object.values(usersData).filter(function(u) { return !u.banned && u.id; });
    var sent = 0;
    var failed = 0;

    await bot.sendMessage(chatId, '📢 جاري الإرسال لـ ' + allUsers.length + ' مستخدم...');

    for (var i = 0; i < allUsers.length; i++) {
        try {
            await bot.sendMessage(allUsers[i].id, '📢 *رسالة من الإدارة:*\n\n' + broadcastText, { parse_mode: 'Markdown' });
            sent++;
        } catch (err) {
            failed++;
        }
    }

    await bot.sendMessage(chatId, '✅ تم الإرسال!\n\n📨 نجح: ' + sent + '\n❌ فشل: ' + failed);
});

// ===== معالجة الرسائل العامة =====
bot.on('message', async function(msg) {
    var chatId = msg.chat.id;
    var userId = msg.from.id;
    var userName = msg.from.username;
    var fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

    // تجاهل الأوامر (تم معالجتها أعلاه)
    if (msg.text && msg.text.startsWith('/')) return;

    // تحديث بيانات المستخدم
    updateUserData(userId, userName, fullName);
    var user = usersData[userId];

    // التحقق من الحظر
    if (user && user.banned) {
        await bot.sendMessage(chatId, '⛔ أنت محظور من التواصل مع هذا البوت.');
        return;
    }

    // ===== رد المطور على رسالة (الرد الذكي) =====
    if (chatId.toString() === developerId) {
        // لو المطور رد على رسالة محولة من مستخدم
        if (msg.reply_to_message) {
            var originalText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
            if (originalText.includes('🆔 ID:')) {
                // استخراج ID المستخدم من التقرير
                var idMatch = originalText.match(/🆔 ID:\s*`?(\d+)`?/);
                if (idMatch) {
                    var targetUserId = idMatch[1];
                    try {
                        await bot.copyMessage(targetUserId, developerId, msg.message_id);
                        await bot.sendMessage(developerId, '✅ تم إرسال ردك للمستخدم `' + targetUserId + '`.', { parse_mode: 'Markdown' });
                    } catch (err) {
                        await bot.sendMessage(developerId, '❌ فشل إرسال الرد: ' + err.message);
                    }
                    return;
                }
            }
            // لو رد على رسالة محولة (forwarded)
            if (msg.reply_to_message.forward_from) {
                var forwardedUserId = msg.reply_to_message.forward_from.id;
                try {
                    await bot.copyMessage(forwardedUserId, developerId, msg.message_id);
                    await bot.sendMessage(developerId, '✅ تم إرسال ردك للمستخدم.');
                } catch (err) {
                    await bot.sendMessage(developerId, '❌ فشل إرسال الرد: ' + err.message);
                }
                return;
            }
        }
        // رسالة عادية من المطور بدون رد → لا نفعل شيء
        return;
    }

    // ===== رسائل المستخدمين العاديين =====

    // التحقق من الكتم
    if (user && user.muted) {
        // لا نخبر المستخدم أنه مكتوم، فقط لا نحول رسالته
        return;
    }

    var mediaType = getMediaType(msg);
    var report = buildReport(msg, mediaType);

    // إرسال التقرير للمطور
    try {
        await bot.sendMessage(developerId, report, { parse_mode: 'Markdown' });
        // إعادة توجيه الوسائط
        if (mediaType) {
            await bot.forwardMessage(developerId, chatId, msg.message_id);
        }
    } catch (err) {
        console.error('خطأ في إرسال التقرير للمطور:', err);
    }

    // ===== رسالة الترحيب/التذكير (كل 3 ساعات فقط) =====
    var now = Date.now();
    var THREE_HOURS = 3 * 60 * 60 * 1000;
    var lastReminder = user.last_reminder || 0;

    if (lastReminder === 0 || (now - lastReminder) > THREE_HOURS) {
        // أول رسالة أو مرت أكثر من 3 ساعات
        usersData[userId].last_reminder = now;
        saveUsersData();
        await bot.sendMessage(chatId, '👋 أهلاً بك!\n\nيمكنك إرسال رسالتك (نص، صورة، فيديو، ملف، صوت) وسوف تصل إلى المطور مباشرة.\n\n📌 سيتم الرد عليك في أقرب وقت.');
    }
    // لو ما مرت 3 ساعات → ما نرسل شيء (بدون إزعاج)
});

// ===== تشغيل خادم Express =====
var app = express();
app.get('/', function(req, res) {
    res.send('Radar System is Active!');
});
var port = process.env.PORT || 3000;
app.listen(port, function() {
    console.log('✅ Express server running on port ' + port);
});
