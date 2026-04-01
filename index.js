const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// --- إعدادات البوت ---
const token = '7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw';
const developerId = '7411444902'; // ايديك يا لبيب
const bot = new TelegramBot(token, { polling: true });

console.log("🚀 بوت التواصل قيد التشغيل...");

// --- منطق التواصل ---

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || "مستخدم";
    const text = msg.text;

    // 1. إذا كانت الرسالة قادمة من المطور (لبيب) وهو يقوم بالرد على شخص
    if (chatId.toString() === developerId && msg.reply_to_message) {
        // استخراج ايدي الشخص من نص الرسالة التي يرد عليها المطور
        // (سنعتمد على أن البوت يرسل لنا الايدي في نص الرسالة)
        const originalMsg = msg.reply_to_message.text;
        const targetUserId = originalMsg.split('ID: ')[1];

        if (targetUserId) {
            bot.sendMessage(targetUserId, `👨‍💻 رد من الإدارة:\n\n${text}`);
            bot.sendMessage(developerId, "✅ تم إرسال ردك للمستخدم.");
        }
        return;
    }

    // 2. إذا كانت الرسالة من مستخدم عادي (يريد التواصل)
    if (chatId.toString() !== developerId) {
        // إرسال الرسالة لك (للمطور)
        const report = `📩 رسالة جديدة من: ${userName}\n📝 النص: ${text}\n🆔 ID: ${userId}`;
        bot.sendMessage(developerId, report);

        // تأكيد للمستخدم أنه تم استلام رسالته
        bot.sendMessage(chatId, `يا ${userName}، وصلت رسالتك بنجاح للبيب. سيتم الرد عليك قريباً! 🌹`);
    } else if (!msg.reply_to_message) {
        // إذا لبيب أرسل رسالة للبوت بدون "رد"، يرحب به فقط
        bot.sendMessage(developerId, "أهلاً لبيب، بانتظار رسائل المستخدمين...");
    }
});

// --- إعدادات السيرفر لـ Render ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Support Bot is Active!'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
