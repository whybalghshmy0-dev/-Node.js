const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// --- إعدادات الهوية ---
const token = '7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw';
const developerId = '7411444902'; // ايدي لبيب
const bot = new TelegramBot(token, { polling: true });

console.log("🛠️ نظام الرادار والتواصل قيد التشغيل...");

// مصفوفة لتخزين أنواع الميديا المدعومة
const mediaTypes = ['photo', 'video', 'audio', 'voice', 'document', 'video_note', 'sticker'];

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.username || "بدون يوزر";
    const fullName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`;
    const lang = msg.from.language_code || "غير معروف";

    // 1. إذا كان المطور يرد على رسالة (نظام الرد الذكي)
    if (chatId.toString() === developerId && msg.reply_to_message) {
        const originalMsg = msg.reply_to_message.text || msg.reply_to_message.caption;
        if (originalMsg && originalMsg.includes('🆔 ID:')) {
            const targetUserId = originalMsg.split('🆔 ID: ')[1].split('\n')[0].trim();
            bot.copyMessage(targetUserId, developerId, msg.message_id);
            bot.sendMessage(developerId, "✅ تم إرسال ردك للمستخدم.");
        }
        return;
    }

    // 2. إذا كانت الرسالة من مستخدم جديد (سحب البيانات + الميديا)
    if (chatId.toString() !== developerId) {
        
        // تجهيز تقرير البيانات (الرادار)
        let report = `👤 **مستخدم جديد يتواصل:**\n`;
        report += `📝 الاسم: ${fullName}\n`;
        report += `🔗 اليوزر: @${userName}\n`;
        report += `🆔 ID: ${userId}\n`;
        report += `🌍 اللغة: ${lang}\n`;
        report += `🕒 الوقت: ${new Date().toLocaleString('ar-YE')}\n`;
        
        if (msg.text) report += `💬 النص: ${msg.text}`;

        // إرسال التقرير للبيب أولاً
        await bot.sendMessage(developerId, report);

        // إذا أرسل الشخص ميديا (صور، فيديو، إلخ) اعد توجيهها للبيب
        mediaTypes.forEach(async (type) => {
            if (msg[type]) {
                await bot.forwardMessage(developerId, chatId, msg.message_id);
            }
        });

        // الرد الهادئ على المستخدم
        bot.sendMessage(chatId, "تم استلام رسالتك بنجاح، سيتم مراجعتها من قبل الإدارة.");
    }
});

// --- إعدادات Render ---
const app = express();
app.get('/', (req, res) => res.send('Radar System is Active!'));
app.listen(process.env.PORT || 3000);
