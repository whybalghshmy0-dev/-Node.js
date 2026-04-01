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
    usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
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
            username: userName,
            name: fullName,
            first_seen: now,
            last_seen: now,
            messages_count: 0,
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
const mainMenuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 عرض المستخدمين', callback_data: 'users' }],
            [{ text: '➕ حظر مستخدم', callback_data: 'ban' }, { text: '🔓 رفع الحظر', callback_data: 'unban' }],
            [{ text: '🔇 كتم مستخدم', callback_data: 'mute' }, { text: '🔊 رفع الكتم', callback_data: 'unmute' }],
            [{ text: '👢 طرد مستخدم', callback_data: 'kick' }],
            [{ text: '💬 رد على مستخدم', callback_data: 'reply' }],
            [{ text: '📈 الإحصائيات', callback_data: 'stats' }]
        ]
    }
};

// دالة إرسال اللوحة للمطور
async function sendDeveloperPanel(chatId) {
    try {
        await bot.sendMessage(chatId, '🔧 **لوحة تحكم المطور**\nاختر الإجراء:', {
            parse_mode: 'Markdown',
            ...mainMenuKeyboard
        });
    } catch (err) {
        console.error('خطأ في إرسال اللوحة:', err);
    }
}

// دالة عرض المستخدمين مع أزرار تنقل
async function sendUserList(chatId, page = 1) {
    const users = Object.values(usersData).sort((a, b) => b.last_seen - a.last_seen);
    if (users.length === 0) {
        await bot.sendMessage(chatId, 'لا يوجد مستخدمون مسجلون بعد.');
        return;
    }

    const perPage = 10;
    const totalPages = Math.ceil(users.length / perPage);
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const pageUsers = users.slice(start, end);

    let message = `📊 **قائمة المستخدمين (الصفحة ${page}/${totalPages})**\n\n`;
    for (const user of pageUsers) {
        const status = [];
        if (user.banned) status.push('🚫 محظور');
        if (user.muted) status.push('🔇 مكتوم');
        const statusText = status.length ? ` (${status.join(', ')})` : '';
        message += `👤 ${user.name || 'بدون اسم'} (@${user.username || 'بدون يوزر'})\n`;
        message += `🆔 ID: \`${user.id}\`\n`;
        message += `📨 رسائل: ${user.messages_count}\n`;
        message += `🕒 آخر تفاعل: ${formatLastSeen(user.last_seen)}${statusText}\n\n`;
    }

    const navigation = [];
    if (page > 1) navigation.push({ text: '⬅️ السابق', callback_data: `users_${page - 1}` });
    if (page < totalPages) navigation.push({ text: 'التالي ➡️', callback_data: `users_${page + 1}` });
    
    if (navigation.length) {
        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [navigation] }
        });
    } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
}

// ===== معالجة الأوامر النصية =====
bot.onText(/^\/(start|panel)/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    // فقط المطور يمكنه استخدام هذه الأوامر
    if (chatId.toString() === developerId || userId.toString() === developerId) {
        await sendDeveloperPanel(chatId);
    } else {
        // للمستخدمين العاديين رسالة ترحيب عادية (مرة واحدة)
        const user = usersData[userId];
        if (!user || !user.last_reminder) {
            await bot.sendMessage(chatId, '👋 أهلاً بك! يمكنك إرسال رسالتك (نص، صورة، فيديو، ملف، إلخ) وسوف تصل إلى المطور مباشرة.\n📌 سيتم الرد عليك في أقرب وقت.');
            updateUserData(userId, msg.from.username, `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim());
            if (usersData[userId]) usersData[userId].last_reminder = Date.now();
            saveUsersData();
        } else {
            await bot.sendMessage(chatId, 'مرحباً! يمكنك إرسال رسالتك وسيتم التواصل معك قريباً.');
        }
    }
});

// ===== معالجة الأزرار (callback_query) =====
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // التحقق من أن المستخدم هو المطور
    if (chatId.toString() !== developerId && userId.toString() !== developerId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'هذه اللوحة مخصصة للمطور فقط.', show_alert: true });
        return;
    }

    await bot.answerCallbackQuery(callbackQuery.id); // إزالة التحميل

    try {
        if (data === 'users') {
            await sendUserList(chatId);
        } 
        else if (data.startsWith('users_')) {
            const page = parseInt(data.split('_')[1]);
            await sendUserList(chatId, page);
        }
        else if (data === 'ban') {
            await bot.sendMessage(chatId, '🔨 أرسل معرف المستخدم لحظره:\n`/ban ID`', { parse_mode: 'Markdown' });
        }
        else if (data === 'unban') {
            await bot.sendMessage(chatId, '🔓 أرسل معرف المستخدم لرفع الحظر:\n`/unban ID`', { parse_mode: 'Markdown' });
        }
        else if (data === 'mute') {
            await bot.sendMessage(chatId, '🔇 أرسل معرف المستخدم لكتمه:\n`/mute ID`', { parse_mode: 'Markdown' });
        }
        else if (data === 'unmute') {
            await bot.sendMessage(chatId, '🔊 أرسل معرف المستخدم لرفع الكتم:\n`/unmute ID`', { parse_mode: 'Markdown' });
        }
        else if (data === 'kick') {
            await bot.sendMessage(chatId, '👢 أرسل معرف المستخدم لطرده:\n`/kick ID`', { parse_mode: 'Markdown' });
        }
        else if (data === 'reply') {
            await bot.sendMessage(chatId, '💬 أرسل معرف المستخدم ثم النص:\n`/reply ID النص`', { parse_mode: 'Markdown' });
        }
        else if (data === 'stats') {
            const totalUsers = Object.keys(usersData).length;
            const banned = Object.values(usersData).filter(u => u.banned).length;
            const muted = Object.values(usersData).filter(u => u.muted).length;
            const totalMessages = Object.values(usersData).reduce((sum, u) => sum + (u.messages_count || 0), 0);
            const statsMsg = `📈 **الإحصائيات**\n\n👥 إجمالي المستخدمين: ${totalUsers}\n🚫 محظورون: ${banned}\n🔇 مكتومون: ${muted}\n💬 إجمالي الرسائل: ${totalMessages}`;
            await bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('خطأ في معالجة الزر:', error);
        await bot.sendMessage(chatId, `⚠️ حدث خطأ: ${error.message}`);
    }
});

// ===== قائمة بأنواع الوسائط =====
const forwardableTypes = ['photo', 'video', 'audio', 'voice', 'document', 'video_note', 'sticker', 'animation', 'location', 'venue', 'contact', 'poll'];

function getMediaType(msg) {
    for (let type of forwardableTypes) {
        if (msg[type]) return type;
    }
    return null;
}

function buildReport(msg, mediaType) {
    const userId = msg.from.id;
    const userName = msg.from.username || 'بدون يوزر';
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'بدون اسم';
    const lang = msg.from.language_code || 'غير معروف';
    const time = new Date().toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });

    let report = `👤 **مستخدم يتواصل:**\n`;
    report += `📝 الاسم: ${fullName}\n`;
    report += `🔗 اليوزر: @${userName}\n`;
    report += `🆔 ID: ${userId}\n`;
    report += `🌍 اللغة: ${lang}\n`;
    report += `🕒 الوقت: ${time}\n`;
    if (mediaType) report += `📎 نوع الوسائط: ${mediaType.toUpperCase()}\n`;
    let caption = msg.caption || msg.text;
    if (caption) report += `💬 النص: ${caption}\n`;
    if (msg.location) report += `📍 الموقع: ${msg.location.latitude}, ${msg.location.longitude}\n`;
    if (msg.venue) report += `🏢 المكان: ${msg.venue.title}\n${msg.venue.address}\n`;
    if (msg.contact) report += `📞 جهة اتصال: ${msg.contact.first_name} ${msg.contact.last_name || ''}\nرقم: ${msg.contact.phone_number}\n`;
    if (msg.poll) report += `📊 استطلاع: ${msg.poll.question}\n`;
    return report;
}

// ===== معالجة أوامر المطور النصية =====
bot.onText(/^\/(ban|unban|mute|unmute|kick|reply)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (chatId.toString() !== developerId && userId.toString() !== developerId) return;

    const command = match[1];
    const args = match[2] ? match[2].trim().split(/\s+/) : [];

    try {
        if (command === 'ban') {
            if (!args[0]) return bot.sendMessage(chatId, 'يرجى إدخال معرف المستخدم: /ban ID');
            const targetId = args[0];
            if (!usersData[targetId]) usersData[targetId] = { banned: false, muted: false };
            usersData[targetId].banned = true;
            saveUsersData();
            await bot.sendMessage(chatId, `✅ تم حظر المستخدم \`${targetId}\`.`, { parse_mode: 'Markdown' });
        }
        else if (command === 'unban') {
            if (!args[0]) return bot.sendMessage(chatId, 'يرجى إدخال معرف المستخدم: /unban ID');
            const targetId = args[0];
            if (usersData[targetId]) {
                usersData[targetId].banned = false;
                saveUsersData();
                await bot.sendMessage(chatId, `✅ تم رفع الحظر عن المستخدم \`${targetId}\`.`, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `المستخدم \`${targetId}\` غير موجود.`, { parse_mode: 'Markdown' });
            }
        }
        else if (command === 'mute') {
            if (!args[0]) return bot.sendMessage(chatId, 'يرجى إدخال معرف المستخدم: /mute ID');
            const targetId = args[0];
            if (!usersData[targetId]) usersData[targetId] = { banned: false, muted: false };
            usersData[targetId].muted = true;
            saveUsersData();
            await bot.sendMessage(chatId, `✅ تم كتم المستخدم \`${targetId}\`.`, { parse_mode: 'Markdown' });
        }
        else if (command === 'unmute') {
            if (!args[0]) return bot.sendMessage(chatId, 'يرجى إدخال معرف المستخدم: /unmute ID');
            const targetId = args[0];
            if (usersData[targetId]) {
                usersData[targetId].muted = false;
                saveUsersData();
                await bot.sendMessage(chatId, `✅ تم رفع الكتم عن المستخدم \`${targetId}\`.`, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `المستخدم \`${targetId}\` غير موجود.`, { parse_mode: 'Markdown' });
            }
        }
        else if (command === 'kick') {
            if (!args[0]) return bot.sendMessage(chatId, 'يرجى إدخال معرف المستخدم: /kick ID');
            const targetId = args[0];
            if (usersData[targetId]) {
                delete usersData[targetId];
                saveUsersData();
                await bot.sendMessage(chatId, `✅ تم طرد المستخدم \`${targetId}\` (حذف بياناته).`, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `المستخدم \`${targetId}\` غير موجود.`, { parse_mode: 'Markdown' });
            }
        }
        else if (command === 'reply') {
            if (args.length < 2) return bot.sendMessage(chatId, 'استخدم: /reply ID النص المراد إرساله');
            const targetId = args[0];
            const replyText = args.slice(1).join(' ');
            try {
                await bot.sendMessage(targetId, `📩 رد من الإدارة:\n${replyText}`);
                await bot.sendMessage(chatId, `✅ تم إرسال الرد إلى \`${targetId}\`.`, { parse_mode: 'Markdown' });
            } catch (err) {
                await bot.sendMessage(chatId, `❌ فشل الإرسال: ${err.message}`);
            }
        }
    } catch (error) {
        console.error('خطأ في أمر المطور:', error);
        await bot.sendMessage(chatId, `⚠️ حدث خطأ: ${error.message}`);
    }
});

// ===== معالجة الرسائل العامة للمستخدمين =====
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.username;
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();

    // تحديث بيانات المستخدم
    updateUserData(userId, userName, fullName);
    const user = usersData[userId];

    // التحقق من الحظر
    if (user && user.banned) {
        await bot.sendMessage(chatId, '⛔ أنت محظور من التواصل مع هذا البوت.');
        return;
    }

    // رد المطور على رسالة (الرد الذكي)
    if (chatId.toString() === developerId && msg.reply_to_message) {
        const originalMsg = msg.reply_to_message.text || msg.reply_to_message.caption;
        if (originalMsg && originalMsg.includes('🆔 ID:')) {
            const targetUserId = originalMsg.split('🆔 ID: ')[1].split('\n')[0].trim();
            await bot.copyMessage(targetUserId, developerId, msg.message_id);
            await bot.sendMessage(developerId, '✅ تم إرسال ردك للمستخدم.');
        }
        return;
    }

    // رسائل المستخدمين العاديين
    if (chatId.toString() !== developerId) {
        const isMuted = user && user.muted;
        const mediaType = getMediaType(msg);
        const report = buildReport(msg, mediaType);

        // إرسال التقرير للمطور
        await bot.sendMessage(developerId, report, { parse_mode: 'Markdown' });
        if (mediaType) {
            await bot.forwardMessage(developerId, chatId, msg.message_id);
        }

        // رسالة الترحيب/التذكير (كل 3 ساعات)
        const now = Date.now();
        const THREE_HOURS = 3 * 60 * 60 * 1000;
        if (!user.last_reminder || (now - user.last_reminder) > THREE_HOURS) {
            usersData[userId].last_reminder = now;
            saveUsersData();
            await bot.sendMessage(chatId, '👋 أهلاً بك! يمكنك إرسال رسالتك (نص، صورة، فيديو، ملف، إلخ) وسوف تصل إلى المطور مباشرة.\n📌 سيتم الرد عليك في أقرب وقت.');
        }
        // لا نرسل رسالة "تم الاستلام" لتجنب الإزعاج
    }
});

// ===== تشغيل خادم Express =====
const app = express();
app.get('/', (req, res) => res.send('Radar System is Active!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Express server running on port ${port}`));