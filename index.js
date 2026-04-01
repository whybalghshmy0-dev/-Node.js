const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ===== إعدادات البوت =====
const token = '7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw';
const developerId = '7411444902'; // ايدي لبيب
const bot = new TelegramBot(token, { polling: true });

console.log('🛠️ نظام الرادار والتواصل المتطور يعمل...');

// ===== ملف تخزين بيانات المستخدمين =====
const usersFilePath = path.join(__dirname, 'users_data.json');

// تحميل البيانات أو إنشاء ملف جديد
let usersData = {};
if (fs.existsSync(usersFilePath)) {
    usersData = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
} else {
    fs.writeFileSync(usersFilePath, JSON.stringify({}, null, 2));
}

// دالة لحفظ البيانات
function saveUsersData() {
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
}

// دالة لتحديث بيانات المستخدم
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

// دالة لتنسيق وقت آخر دخول
function formatLastSeen(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

// دالة إرسال قائمة المستخدمين للمطور
async function sendUserList(chatId) {
    const users = Object.values(usersData).sort((a, b) => b.last_seen - a.last_seen);
    if (users.length === 0) {
        await bot.sendMessage(chatId, 'لا يوجد مستخدمون مسجلون بعد.');
        return;
    }

    let message = '📊 **قائمة المستخدمين:**\n\n';
    for (const user of users.slice(0, 20)) { // عرض 20 فقط لتجنب طول الرسالة
        const status = [];
        if (user.banned) status.push('🚫 محظور');
        if (user.muted) status.push('🔇 مكتوم');
        const statusText = status.length ? ` (${status.join(', ')})` : '';
        message += `👤 ${user.name || 'بدون اسم'} (@${user.username || 'بدون يوزر'})\n`;
        message += `🆔 ID: \`${user.id}\`\n`;
        message += `📨 رسائل: ${user.messages_count}\n`;
        message += `🕒 آخر تفاعل: ${formatLastSeen(user.last_seen)}${statusText}\n\n`;
    }
    if (users.length > 20) message += `... و ${users.length - 20} مستخدم آخر.\n`;
    message += '\nاستخدم الأوامر:\n/ban ID - /unban ID\n/mute ID - /unmute ID\n/kick ID\n/reply ID النص';
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ===== قائمة بأنواع الوسائط القابلة للتوجيه =====
const forwardableTypes = [
    'photo', 'video', 'audio', 'voice', 'document', 'video_note',
    'sticker', 'animation', 'location', 'venue', 'contact', 'poll'
];

// دالة لاستخراج نوع الوسائط
function getMediaType(msg) {
    for (let type of forwardableTypes) {
        if (msg[type]) return type;
    }
    return null;
}

// دالة بناء التقرير
function buildReport(msg, mediaType) {
    const userId = msg.from.id;
    const userName = msg.from.username || 'بدون يوزر';
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'بدون اسم';
    const lang = msg.from.language_code || 'غير معروف';
    const time = new Date().toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });

    let report = `👤 **مستخدم جديد يتواصل:**\n`;
    report += `📝 الاسم: ${fullName}\n`;
    report += `🔗 اليوزر: @${userName}\n`;
    report += `🆔 ID: ${userId}\n`;
    report += `🌍 اللغة: ${lang}\n`;
    report += `🕒 الوقت: ${time}\n`;

    if (mediaType) {
        report += `📎 نوع الوسائط: ${mediaType.toUpperCase()}\n`;
    }

    let caption = msg.caption || msg.text;
    if (caption) {
        report += `💬 النص: ${caption}\n`;
    }

    if (msg.location) {
        report += `📍 الموقع: ${msg.location.latitude}, ${msg.location.longitude}\n`;
    }
    if (msg.venue) {
        report += `🏢 المكان: ${msg.venue.title}\n${msg.venue.address}\n`;
    }
    if (msg.contact) {
        report += `📞 جهة اتصال: ${msg.contact.first_name} ${msg.contact.last_name || ''}\nرقم: ${msg.contact.phone_number}\n`;
    }
    if (msg.poll) {
        report += `📊 استطلاع: ${msg.poll.question}\n`;
    }

    return report;
}

// ===== معالجة الأوامر للمطور =====
bot.onText(/^\/(users|ban|unban|mute|unmute|kick|reply)(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // التأكد أن الأمر من المطور فقط
    if (chatId.toString() !== developerId && userId.toString() !== developerId) return;

    const command = match[1];
    const args = match[2] ? match[2].trim().split(/\s+/) : [];

    try {
        if (command === 'users') {
            await sendUserList(chatId);
        }
        else if (command === 'ban') {
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
                await bot.sendMessage(chatId, `المستخدم \`${targetId}\` غير موجود في البيانات.`, { parse_mode: 'Markdown' });
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
                await bot.sendMessage(chatId, `المستخدم \`${targetId}\` غير موجود في البيانات.`, { parse_mode: 'Markdown' });
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

// ===== معالجة الرسائل العامة =====
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.username;
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();

    try {
        // تحديث بيانات المستخدم (عدد الرسائل وآخر تفاعل)
        updateUserData(userId, userName, fullName);

        // التحقق من الحظر
        if (usersData[userId] && usersData[userId].banned) {
            await bot.sendMessage(chatId, '⛔ أنت محظور من التواصل مع هذا البوت.');
            return;
        }

        // --- 1. نظام الرد الذكي (المطور يرد على رسالة) ---
        if (chatId.toString() === developerId && msg.reply_to_message) {
            const originalMsg = msg.reply_to_message.text || msg.reply_to_message.caption;
            if (originalMsg && originalMsg.includes('🆔 ID:')) {
                const targetUserId = originalMsg.split('🆔 ID: ')[1].split('\n')[0].trim();
                // نسخ رسالة المطور إلى المستخدم الأصلي
                await bot.copyMessage(targetUserId, developerId, msg.message_id);
                await bot.sendMessage(developerId, '✅ تم إرسال ردك للمستخدم.');
            }
            return;
        }

        // --- 2. رسائل المستخدمين العاديين (غير المطور) ---
        if (chatId.toString() !== developerId) {
            // إذا كان المستخدم مكتوماً، لا نرسل رد للمستخدم (لكن نرسل التقرير للمطور)
            const isMuted = usersData[userId] && usersData[userId].muted;

            const mediaType = getMediaType(msg);
            const report = buildReport(msg, mediaType);

            // إرسال التقرير للمطور (مرة واحدة)
            await bot.sendMessage(developerId, report, { parse_mode: 'Markdown' });

            // إعادة توجيه الوسائط (إذا وجدت) مرة واحدة فقط
            if (mediaType) {
                await bot.forwardMessage(developerId, chatId, msg.message_id);
            }

            // الرد على المستخدم فقط إذا لم يكن مكتوماً
            if (!isMuted) {
                await bot.sendMessage(chatId, '✅ تم استلام رسالتك بنجاح، سيتم مراجعتها من قبل الإدارة.');
            }
        }
    } catch (error) {
        console.error('خطأ أثناء معالجة الرسالة:', error);
        await bot.sendMessage(developerId, `⚠️ حدث خطأ أثناء معالجة رسالة من ${userId}: ${error.message}`);
    }
});

// ===== تشغيل خادم Express =====
const app = express();
app.get('/', (req, res) => res.send('Radar System is Active!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Express server running on port ${port}`));