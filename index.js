const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// ===== إعدادات البوت =====
const token = '7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw'; // ضع التوكن الصحيح
const developerId = '7411444902'; // ايدي لبيب
const bot = new TelegramBot(token, { polling: true });

console.log('🛠️ نظام الرادار والتواصل المتطور يعمل...');

// ===== قائمة بأنواع الرسائل التي يمكن توجيهها =====
const forwardableTypes = [
  'photo', 'video', 'audio', 'voice', 'document', 'video_note',
  'sticker', 'animation', 'location', 'venue', 'contact', 'poll'
];

// ===== دالة مساعدة لاستخراج نوع الوسائط من الرسالة =====
function getMediaType(msg) {
  for (let type of forwardableTypes) {
    if (msg[type]) return type;
  }
  return null;
}

// ===== دالة لبناء التقرير التفصيلي =====
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

  // النص المصاحب (الكابشن أو النص العادي)
  let caption = msg.caption || msg.text;
  if (caption) {
    report += `💬 النص: ${caption}\n`;
  }

  // معلومات إضافية حسب النوع
  if (msg.location) {
    report += `📍 الموقع: خط الطول ${msg.location.latitude}, خط العرض ${msg.location.longitude}\n`;
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

// ===== المعالجة الرئيسية للرسائل =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
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
      const mediaType = getMediaType(msg);
      const report = buildReport(msg, mediaType);

      // إرسال التقرير النصي للمطور
      await bot.sendMessage(developerId, report, { parse_mode: 'Markdown' });

      // إذا كانت هناك وسائط، قم بتوجيهها للمطور
      if (mediaType) {
        // استخدم forwardMessage للحفاظ على هوية المرسل (الصورة، الاسم)
        await bot.forwardMessage(developerId, chatId, msg.message_id);
      }

      // رد واحد هادئ للمستخدم
      await bot.sendMessage(chatId, '✅ تم استلام رسالتك بنجاح، سيتم مراجعتها من قبل الإدارة.');
    }
  } catch (error) {
    console.error('خطأ أثناء معالجة الرسالة:', error);
    // إعلام المطور بوجود خطأ (اختياري)
    await bot.sendMessage(developerId, `⚠️ حدث خطأ أثناء معالجة رسالة من ${userId}: ${error.message}`);
  }
});

// ===== تشغيل خادم Express لإبقاء البوت نشطاً على Render =====
const app = express();
app.get('/', (req, res) => res.send('Radar System is Active!'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Express server running on port ${port}`));