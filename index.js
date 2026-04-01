const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// --- إعدادات البوت ---
const token = '7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw';
const developerId = '7411444902';
const bot = new TelegramBot(token, { polling: true });

// --- منطق البوت ---
console.log("✅ جاري تشغيل البوت...");

// إرسال رسالة عند التشغيل
bot.sendMessage(developerId, "الوه الوه (البوت شغال الآن على Render)");

// الرد على الرسائل
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() === developerId) {
        bot.sendMessage(chatId, "الوه الوه");
    }
});

// --- إعدادات السيرفر (مهم لـ Render) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is Running!'));

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
