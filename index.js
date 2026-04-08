const TelegramBot = require('node-telegram-bot-api');

// ===== إعدادات =====
const BOT_TOKEN = '7153051636:AAF5QHDdWBtK046BxtUlZ96I8N5Q50pEFKg';
const DEVELOPER_ID = '7411444902'; // غيرها

// ===== تخزين مؤقت (في الذاكرة) =====
const admins = new Set([DEVELOPER_ID]);           // قائمة الأدمنية
const pendingTickets = new Map();                 // ticketId -> { userId, claimedBy, status }
const userStates = new Map();                     // حالة المستخدم الحالية

// ===== البوت =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 البوت المصغر يعمل...');

// ===== أمر /start =====
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const name = msg.from.first_name || 'مستخدم';

    if (admins.has(userId)) {
        // لوحة الأدمن
        await bot.sendMessage(chatId,
            `👨‍💼 *لوحة الأدمن*\n━━━━━━━━━━━━━━━\n` +
            `👤 أهلاً ${name}\n` +
            `🆔 معرفك: \`${userId}\`\n\n` +
            `📥 استقبال رسائل المستخدمين تلقائياً.\n` +
            `📝 للرد: اضغط على زر "رد" أسفل أي رسالة.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 إدارة الأدمنية', callback_data: 'admin_panel' }],
                        [{ text: '📊 إحصائيات', callback_data: 'stats' }]
                    ]
                }
            }
        );
    } else {
        // مستخدم عادي
        await bot.sendMessage(chatId,
            `🎓 *مرحباً ${name}*\n\n` +
            `📩 أرسل سؤالك أو طلبك هنا مباشرة وسيصل للأستاذ.`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ===== استقبال رسائل المستخدمين =====
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const name = msg.from.first_name || 'مستخدم';
    const username = msg.from.username ? '@' + msg.from.username : '';

    // تجاهل رسائل الأدمنية (سيتم معالجتها لاحقاً)
    if (admins.has(userId)) {
        await handleAdminMessage(msg);
        return;
    }

    // إنشاء تذكرة جديدة
    const ticketId = Date.now() + '_' + userId;
    pendingTickets.set(ticketId, {
        userId,
        claimedBy: null,
        status: 'open',
        createdAt: Date.now()
    });

    // إرسال إشعار للأدمنية
    const adminList = [...admins];
    for (const adminId of adminList) {
        try {
            await bot.sendMessage(adminId,
                `📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n` +
                `👤 ${name} ${username}\n` +
                `🆔 \`${userId}\`\n` +
                `🎫 رقم التذكرة: \`${ticketId}\``,
                { parse_mode: 'Markdown' }
            );
            // إعادة توجيه الرسالة نفسها
            const fwd = await bot.forwardMessage(adminId, chatId, msg.message_id);
            // إضافة أزرار للرد
            await bot.sendMessage(adminId,
                `⬆️ من: ${name}`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💬 رد', callback_data: `reply_${userId}_${ticketId}` }],
                            [{ text: '🚫 حظر', callback_data: `ban_${userId}` }]
                        ]
                    }
                }
            );
        } catch (e) {
            console.log(`فشل إرسال للأدمن ${adminId}`);
        }
    }

    // رد للمستخدم
    await bot.sendMessage(chatId, '✅ تم استلام رسالتك، سيتم الرد قريباً.');
});

// ===== معالجة ردود الأدمن =====
async function handleAdminMessage(msg) {
    const chatId = msg.chat.id;
    const adminId = String(msg.from.id);

    // التحقق من حالة "الرد"
    const state = userStates.get(adminId);
    if (state && state.action === 'reply') {
        const targetUserId = state.targetUserId;
        userStates.delete(adminId);

        try {
            // نسخ الرسالة إلى المستخدم
            await bot.copyMessage(targetUserId, chatId, msg.message_id);
            await bot.sendMessage(targetUserId, '💬 *وصلك رد من الأستاذ*', { parse_mode: 'Markdown' });
            await bot.sendMessage(chatId, `✅ تم إرسال الرد إلى المستخدم \`${targetUserId}\``, { parse_mode: 'Markdown' });
        } catch (e) {
            await bot.sendMessage(chatId, `❌ فشل الإرسال: ${e.message}`);
        }
        return;
    }

    // إذا لم يكن في حالة رد، عرض لوحة التحكم
    await bot.sendMessage(chatId, 'استخدم الأزرار للتحكم.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 إدارة الأدمنية', callback_data: 'admin_panel' }]
            ]
        }
    });
}

// ===== معالجة الأزرار =====
bot.on('callback_query', async (cbq) => {
    const chatId = cbq.message.chat.id;
    const userId = String(cbq.from.id);
    const data = cbq.data;

    await bot.answerCallbackQuery(cbq.id);

    // === رد على مستخدم ===
    if (data.startsWith('reply_')) {
        const parts = data.split('_');
        const targetId = parts[1];
        const ticketId = parts[2];

        // تعيين حالة الرد
        userStates.set(userId, { action: 'reply', targetUserId: targetId });

        await bot.sendMessage(chatId,
            `✏️ اكتب ردك الآن (نص، صورة، ملف...).`,
            {
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_reply' }]]
                }
            }
        );
    }

    // === إلغاء الرد ===
    else if (data === 'cancel_reply') {
        userStates.delete(userId);
        await bot.editMessageText('❌ تم إلغاء الرد.', { chat_id: chatId, message_id: cbq.message.message_id });
    }

    // === حظر مستخدم ===
    else if (data.startsWith('ban_')) {
        const targetId = data.split('_')[1];
        // مجرد إشعار (لا يوجد قاعدة بيانات)
        await bot.sendMessage(chatId, `⚠️ تم محاكاة حظر المستخدم \`${targetId}\` (لا يوجد قاعدة بيانات دائمة).`, { parse_mode: 'Markdown' });
    }

    // === إدارة الأدمنية ===
    else if (data === 'admin_panel') {
        if (userId !== DEVELOPER_ID) {
            await bot.sendMessage(chatId, '⛔ هذه الصلاحية للمطور فقط.');
            return;
        }

        const adminList = [...admins].filter(id => id !== DEVELOPER_ID);
        let text = `👑 *إدارة الأدمنية*\n━━━━━━━━━━━━━━━\n` +
                   `المطور: \`${DEVELOPER_ID}\`\n\n` +
                   `📋 *الأدمنية الحاليين:*\n`;
        if (adminList.length === 0) text += 'لا يوجد أدمنية.';
        else adminList.forEach(id => text += `- \`${id}\`\n`);

        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ إضافة أدمن (بالمعرف)', callback_data: 'add_admin_prompt' }],
                [{ text: '❌ حذف أدمن', callback_data: 'remove_admin_prompt' }],
                [{ text: '🔙 رجوع', callback_data: 'main_menu' }]
            ]
        };

        await bot.editMessageText(text, { chat_id: chatId, message_id: cbq.message.message_id, parse_mode: 'Markdown', reply_markup: keyboard });
    }

    // === إضافة أدمن (طلب إدخال ID) ===
    else if (data === 'add_admin_prompt') {
        if (userId !== DEVELOPER_ID) return;
        userStates.set(userId, { action: 'add_admin' });
        await bot.editMessageText('✏️ أرسل معرف (ID) الشخص المراد ترقيته:', {
            chat_id: chatId,
            message_id: cbq.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_panel' }]] }
        });
    }

    // === حذف أدمن (طلب إدخال ID) ===
    else if (data === 'remove_admin_prompt') {
        if (userId !== DEVELOPER_ID) return;
        userStates.set(userId, { action: 'remove_admin' });
        await bot.editMessageText('✏️ أرسل معرف (ID) الأدمن المراد إزالته:', {
            chat_id: chatId,
            message_id: cbq.message.message_id,
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_panel' }]] }
        });
    }

    // === إحصائيات ===
    else if (data === 'stats') {
        const openCount = [...pendingTickets.values()].filter(t => t.status === 'open').length;
        await bot.editMessageText(
            `📊 *إحصائيات*\n━━━━━━━━━━━━━━━\n` +
            `👨‍💼 عدد الأدمنية: ${admins.size}\n` +
            `🎫 التذاكر المفتوحة: ${openCount}\n` +
            `💾 التخزين: مؤقت (في الذاكرة)`,
            { chat_id: chatId, message_id: cbq.message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main_menu' }]] } }
        );
    }

    // === القائمة الرئيسية ===
    else if (data === 'main_menu') {
        await bot.editMessageText(
            `👨‍💼 *لوحة الأدمن*\nاختر من الأزرار:`,
            {
                chat_id: chatId,
                message_id: cbq.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 إدارة الأدمنية', callback_data: 'admin_panel' }],
                        [{ text: '📊 إحصائيات', callback_data: 'stats' }]
                    ]
                }
            }
        );
    }
});

// ===== معالجة إدخال ID للأدمنية =====
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const text = msg.text?.trim();

    const state = userStates.get(userId);
    if (!state) return;

    if (state.action === 'add_admin' && userId === DEVELOPER_ID) {
        userStates.delete(userId);
        const newAdminId = text;
        if (!/^\d+$/.test(newAdminId)) {
            await bot.sendMessage(chatId, '⚠️ معرف غير صحيح.');
            return;
        }
        admins.add(newAdminId);
        await bot.sendMessage(chatId, `✅ تمت إضافة \`${newAdminId}\` كأدمن.`, { parse_mode: 'Markdown' });
        // إشعار الأدمن الجديد
        try {
            await bot.sendMessage(newAdminId, '🎉 تم تعيينك كأدمن! أرسل /start.');
        } catch (e) {}
    }

    else if (state.action === 'remove_admin' && userId === DEVELOPER_ID) {
        userStates.delete(userId);
        const removeId = text;
        if (removeId === DEVELOPER_ID) {
            await bot.sendMessage(chatId, '⛔ لا يمكن إزالة المطور.');
            return;
        }
        if (admins.delete(removeId)) {
            await bot.sendMessage(chatId, `✅ تمت إزالة \`${removeId}\` من الأدمنية.`, { parse_mode: 'Markdown' });
            try {
                await bot.sendMessage(removeId, '⚠️ تم إزالتك من الأدمنية.');
            } catch (e) {}
        } else {
            await bot.sendMessage(chatId, '⚠️ هذا الشخص ليس أدمن.');
        }
    }
});

// تشغيل
console.log('✅ البوت المصغر جاهز!');