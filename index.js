const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http = require('http');

const BOT_TOKEN = '8798272294:AAEY_LIYnVRIY2T-WUP63duCn5V7VFgGsCE';
const developerId = '7411444902';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://0ec90b57d6e95fcbda19832f.supabase.co';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJib2x0IiwicmVmIjoiMGVjOTBiNTdkNmU5NWZjYmRhMTk4MzJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4ODE1NzQsImV4cCI6MTc1ODg4MTU3NH0.9I8-U0x86Ak8t2DGaIk0HfvTSLsAyzdnz-Nw00mMkKw';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let adminIds = [developerId];
let bot = null;
let devState = {};
let pendingNotify = {};

const DEFAULT_PERMISSIONS = {
  canBan: true,
  canMute: true,
  canBroadcast: false,
  canViewStats: true,
  canManageTickets: true,
  canManageGroups: true,
  canReplyUsers: true
};

function isAdminUser(userId) {
  return adminIds.includes(String(userId));
}

function isDeveloper(userId) {
  return String(userId) === developerId;
}

async function initDB() {
  try {
    const { data: adminsData } = await supabase.from('admins').select('user_id');
    if (adminsData) {
      adminsData.forEach(a => {
        if (!adminIds.includes(a.user_id)) {
          adminIds.push(a.user_id);
        }
      });
    }
    console.log('✅ تم تهيئة قاعدة البيانات');
  } catch (e) {
    console.error('❌ خطأ تهيئة:', e.message);
  }
}

async function getUser(userId) {
  try {
    const { data } = await supabase.from('users').select('*').eq('id', String(userId)).maybeSingle();
    return data;
  } catch (e) {
    return null;
  }
}

async function getAllUsers() {
  try {
    const { data } = await supabase.from('users').select('*').order('last_seen', { ascending: false });
    return data || [];
  } catch (e) {
    return [];
  }
}

async function updateUser(userId, userName, fullName) {
  const now = Date.now();
  try {
    const existing = await getUser(userId);
    if (!existing) {
      await supabase.from('users').insert({
        id: String(userId),
        username: userName || '',
        name: fullName || '',
        first_seen: now,
        last_seen: now,
        messages_count: 1
      });
    } else {
      await supabase.from('users').update({
        last_seen: now,
        messages_count: (existing.messages_count || 0) + 1,
        username: userName || existing.username || '',
        name: fullName || existing.name || ''
      }).eq('id', String(userId));
    }
  } catch (e) {
    console.error('خطأ updateUser:', e.message);
  }
}

async function setUserField(userId, field, value) {
  try {
    await supabase.from('users').update({ [field]: value }).eq('id', String(userId));
  } catch (e) {}
}

async function addAdmin(userId, addedBy, permissions = DEFAULT_PERMISSIONS) {
  if (String(userId) === developerId) return;
  try {
    await supabase.from('admins').upsert({
      user_id: String(userId),
      added_by: String(addedBy),
      added_at: Date.now(),
      permissions: permissions
    });
    if (!adminIds.includes(String(userId))) adminIds.push(String(userId));
  } catch (e) {}
}

async function removeAdmin(userId) {
  if (String(userId) === developerId) return;
  try {
    await supabase.from('admins').delete().eq('user_id', String(userId));
    const idx = adminIds.indexOf(String(userId));
    if (idx > -1) adminIds.splice(idx, 1);
  } catch (e) {}
}

async function getAdminList() {
  try {
    const { data: admins } = await supabase.from('admins').select('*');
    if (!admins) return [];

    const result = [];
    for (const admin of admins) {
      const userData = await getUser(admin.user_id);
      result.push({
        ...admin,
        users: userData || { name: '', username: '' }
      });
    }
    return result;
  } catch (e) {
    return [];
  }
}

async function getAdminPermissions(adminId) {
  if (isDeveloper(adminId)) return { ...DEFAULT_PERMISSIONS, canBroadcast: true, canManageGroups: true };
  try {
    const { data } = await supabase.from('admins').select('permissions').eq('user_id', String(adminId)).maybeSingle();
    return data?.permissions || DEFAULT_PERMISSIONS;
  } catch (e) {
    return DEFAULT_PERMISSIONS;
  }
}

async function updateAdminPermissions(adminId, permissions) {
  try {
    await supabase.from('admins').update({ permissions }).eq('user_id', String(adminId));
  } catch (e) {}
}

async function canAdminReply(adminId, targetUserId) {
  if (isDeveloper(adminId)) return true;
  const perms = await getAdminPermissions(adminId);
  if (!perms.canReplyUsers) return false;

  const ticket = await getOpenTicket(targetUserId);
  if (!ticket) return true;
  if (ticket.claimed_by === String(adminId)) return true;

  const { data } = await supabase.from('admins').select('multi_reply').eq('user_id', String(adminId)).maybeSingle();
  return data?.multi_reply || false;
}

async function getOpenTicket(userId) {
  try {
    const { data } = await supabase.from('tickets')
      .select('*')
      .eq('user_id', String(userId))
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  } catch (e) {
    return null;
  }
}

async function createTicket(userId) {
  try {
    const { data } = await supabase.from('tickets').insert({
      user_id: String(userId),
      status: 'open',
      created_at: Date.now()
    }).select().single();
    return data?.id;
  } catch (e) {
    return null;
  }
}

async function claimTicket(ticketId, adminId) {
  try {
    const { data } = await supabase.from('tickets')
      .update({
        claimed_by: String(adminId),
        claimed_at: Date.now()
      })
      .eq('id', ticketId)
      .is('claimed_by', null)
      .select()
      .maybeSingle();
    return data;
  } catch (e) {
    return null;
  }
}

async function completeTicket(ticketId) {
  try {
    await supabase.from('tickets').update({
      status: 'completed',
      completed_at: Date.now()
    }).eq('id', ticketId);
  } catch (e) {}
}

async function rateTicket(ticketId, rating) {
  try {
    await supabase.from('tickets').update({ rating }).eq('id', ticketId);
  } catch (e) {}
}

async function saveTicketEvent(ticketId, userId, role, eventType, content) {
  try {
    await supabase.from('ticket_events').insert({
      ticket_id: ticketId,
      user_id: String(userId),
      role,
      event_type: eventType,
      content: content || '',
      ts: Date.now()
    });
  } catch (e) {}
}

async function saveMsgMap(userId, userMsgId, fwdMsgId, fwdChatId) {
  try {
    await supabase.from('msg_map').insert({
      user_id: String(userId),
      user_msg_id: userMsgId,
      fwd_msg_id: fwdMsgId,
      fwd_chat_id: String(fwdChatId),
      ts: Date.now()
    });
  } catch (e) {}
}

async function getUserByFwdMsg(fwdMsgId, fwdChatId) {
  try {
    const { data } = await supabase.from('msg_map')
      .select('user_id')
      .eq('fwd_msg_id', fwdMsgId)
      .eq('fwd_chat_id', String(fwdChatId))
      .maybeSingle();
    return data?.user_id;
  } catch (e) {
    return null;
  }
}

async function saveGroup(groupId, title, username, memberCount, addedBy) {
  try {
    await supabase.from('groups').upsert({
      group_id: String(groupId),
      title,
      username: username || '',
      member_count: memberCount || 0,
      added_at: Date.now(),
      added_by: String(addedBy),
      is_active: true
    });
  } catch (e) {}
}

async function updateGroupMember(groupId, userId, username, name, phone, isAdmin, isBot, isOwner) {
  try {
    const { data: existing } = await supabase.from('group_members')
      .select('*')
      .eq('group_id', String(groupId))
      .eq('user_id', String(userId))
      .maybeSingle();

    const memberData = {
      group_id: String(groupId),
      user_id: String(userId),
      username: username || '',
      name: name || '',
      phone: phone || '',
      is_admin: isAdmin || false,
      is_bot: isBot || false,
      is_owner: isOwner || false,
      last_seen: Date.now()
    };

    if (!existing) {
      memberData.joined_at = Date.now();
      await supabase.from('group_members').insert(memberData);
    } else {
      await supabase.from('group_members').update(memberData)
        .eq('group_id', String(groupId))
        .eq('user_id', String(userId));
    }
  } catch (e) {
    console.error('خطأ updateGroupMember:', e.message);
  }
}

async function updateMemberLastSeen(groupId, userId) {
  try {
    await supabase.from('group_members')
      .update({ last_seen: Date.now() })
      .eq('group_id', String(groupId))
      .eq('user_id', String(userId));
  } catch (e) {}
}

async function saveGroupMessage(groupId, userId, messageId, text) {
  try {
    await supabase.from('group_messages').insert({
      group_id: String(groupId),
      user_id: String(userId),
      message_id: messageId,
      text: text || '',
      ts: Date.now()
    });
  } catch (e) {}
}

async function getAllGroups() {
  try {
    const { data } = await supabase.from('groups')
      .select('*')
      .eq('is_active', true)
      .order('added_at', { ascending: false });
    return data || [];
  } catch (e) {
    return [];
  }
}

async function getGroupMembers(groupId) {
  try {
    const { data } = await supabase.from('group_members')
      .select('*')
      .eq('group_id', String(groupId))
      .order('last_seen', { ascending: false });
    return data || [];
  } catch (e) {
    return [];
  }
}

async function setGroupMemberField(groupId, userId, field, value) {
  try {
    await supabase.from('group_members')
      .update({ [field]: value })
      .eq('group_id', String(groupId))
      .eq('user_id', String(userId));
  } catch (e) {}
}

async function saveCB(data) {
  if (data.length < 50) return data;
  try {
    const { data: result } = await supabase.from('cb_data').insert({
      data,
      ts: Date.now()
    }).select().single();
    return 'c_' + result.id;
  } catch (e) {
    return data.substring(0, 50);
  }
}

async function getCB(id) {
  if (!id.startsWith('c_')) return id;
  try {
    const { data } = await supabase.from('cb_data').select('data').eq('id', id.substring(2)).maybeSingle();
    return data?.data || id;
  } catch (e) {
    return id;
  }
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('ar-YE', { timeZone: 'Asia/Aden' });
}

function getUserName(u) {
  let n = u.name || 'مجهول';
  if (u.username) n += ' (@' + u.username + ')';
  return n;
}

async function startBot() {
  await initDB();
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  devState = {};

  setInterval(async () => {
    try {
      await supabase.from('cb_data').delete().lt('ts', Date.now() - 24 * 60 * 60 * 1000);
    } catch(e) {}
  }, 3600000);

  bot.setMyCommands([
    { command: 'start', description: '🏠 القائمة الرئيسية' }
  ]).catch(() => {});

  bot.onText(/^\/(start|panel)$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

    if (isAdminUser(userId)) {
      devState[chatId] = {};
      await sendMainMenu(chatId);
      await notifyPendingUsers(userId);
      return;
    }

    const isNew = !(await getUser(userId));
    await updateUser(userId, msg.from.username || '', fullName);

    const introText = '🎓 *هنا أستاذك الخاص*\n\n'
      + 'لقد كثرت الـ AI بشكل كبير ومتفرع جداً، وكلهن متخصصات حتى في حل الواجبات والتكاليف وكل ما يتعلق بالأسئلة الوزارية.\n\n'
      + 'ولكن نحيطك علماً — وأنت تعرف ذلك — أن *50% من إجاباتهم خاطئة* ❌\n\n'
      + 'لهذا، هذا البوت يوفر لكم *أساتذة ومعيدين متخصصين* لخدمتكم شخصياً مع *ضمان الإجابات 100%* ✅\n\n'
      + 'سوف يصل طلبك للأستاذ المناسب فوراً.\n\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👋 أهلاً بك *' + (fullName || 'عزيزي') + '*!\n\n'
      + '📩 أرسل سؤالك أو طلبك الآن مباشرة وسيصل للأستاذ.\n\n'
      + '📌 *يمكنك إرسال:*\n'
      + '• 📝 نصوص وأسئلة\n'
      + '• 📸 صور بدقة عالية\n'
      + '• 🎥 فيديوهات\n'
      + '• 📁 ملفات وواجبات\n'
      + '• 🎤 مقاطع صوتية\n'
      + '• أي شيء!\n\n'
      + '✅ سوف نعلمك فور فتح الأستاذ للمحادثة.';

    await bot.sendMessage(chatId, introText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '💡 اقتراح ميزة أو خدمة', callback_data: 'suggest' }]]
      }
    });

    if (isNew) {
      const newUserNotif = '🆕 *مستخدم جديد انضم!*\n━━━━━━━━━━━━━━━\n'
        + '👤 ' + (fullName || 'بدون اسم') + '\n'
        + '🔗 ' + (msg.from.username ? '@' + msg.from.username : 'بدون يوزر') + '\n'
        + '🆔 `' + userId + '`\n'
        + '🕒 ' + formatTime(Date.now());

      const admins = await getAdminList();
      const recipients = [developerId];
      admins.forEach(a => {
        if (a.user_id !== developerId) recipients.push(a.user_id);
      });

      for (const recId of recipients) {
        try {
          await bot.sendMessage(recId, newUserNotif, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💬 مراسلة', callback_data: 'qr_' + userId }]] }
          });
        } catch (e) {}
      }
    }
  });

  async function notifyPendingUsers(adminId) {
    for (const uid in pendingNotify) {
      if (pendingNotify[uid] && !pendingNotify[uid].notified) {
        try {
          await bot.sendMessage(uid,
            '👀 *تمت قراءة رسالتك*\n\n'
            + '✅ الأستاذ فتح المحادثة وسوف يطلع على رسائلك ويرد عليك قريباً.\n\n'
            + '⏳ يرجى الانتظار، الرد في الطريق إليك!',
            { parse_mode: 'Markdown' }
          );
          pendingNotify[uid].notified = true;
        } catch (e) {}
      }
    }
  }

  async function sendMainMenu(chatId, editMsgId) {
    const userId = String(chatId);
    const perms = await getAdminPermissions(userId);

    if (isAdminUser(userId)) {
      await supabase.from('admins').update({ last_login: Date.now() }).eq('user_id', userId);
    }

    const { data: adminStats } = await supabase.from('admins').select('*').eq('user_id', userId).maybeSingle();
    const allUsers = await getAllUsers();
    const total = allUsers.length;
    const banned = allUsers.filter(u => u.banned).length;
    const muted = allUsers.filter(u => u.muted).length;
    const dayAgo = Date.now() - 86400000;
    const active = allUsers.filter(u => u.last_seen > dayAgo).length;
    const admins = await getAdminList();

    let openTickets = 0, claimedTickets = 0, newSuggestions = 0;
    try {
      const { count: ot } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'open').is('claimed_by', null);
      openTickets = ot || 0;
      const { count: ct } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'open').not('claimed_by', 'is', null);
      claimedTickets = ct || 0;
      const { count: sg } = await supabase.from('suggestions').select('*', { count: 'exact', head: true }).eq('status', 'new');
      newSuggestions = sg || 0;
    } catch (e) {}

    const allGroups = await getAllGroups();

    let text = '🔧 *لوحة التحكم المتطورة*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 الرتبة: ' + (isDeveloper(userId) ? '*👑 المطور*' : '*👨‍🏫 أستاذ/أدمن*') + '\n'
      + (adminStats ? '🤝 ساعدت: `' + (adminStats.helped_count || 0) + '` | ⏱ نشاط: `' + (adminStats.total_active_minutes || 0) + '`د\n' : '')
      + '━━━━━━━━━━━━━━━\n'
      + '👥 المستخدمين: ' + total + '\n'
      + '🟢 نشطين اليوم: ' + active + '\n'
      + '🚫 محظورين: ' + banned + '\n'
      + '🔇 مكتومين: ' + muted + '\n'
      + '👨‍💼 الأدمنية: ' + (admins.length + 1) + '\n'
      + '📱 القروبات: ' + allGroups.length + '\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🎫 طلبات مفتوحة: ' + openTickets + '\n'
      + '🔒 طلبات محجوزة: ' + claimedTickets + '\n'
      + (newSuggestions > 0 ? '💡 اقتراحات جديدة: ' + newSuggestions + '\n' : '')
      + '━━━━━━━━━━━━━━━';

    const kb = [];

    if (perms.canViewStats) {
      kb.push([
        { text: '👥 المستخدمين', callback_data: 'users_1' },
        { text: '📈 إحصائيات', callback_data: 'stats' }
      ]);
    }

    if (perms.canBroadcast) {
      kb.push([{ text: '📢 رسالة جماعية', callback_data: 'broadcast' }]);
    }

    if (perms.canBan || perms.canMute) {
      const row = [];
      if (perms.canBan) {
        row.push({ text: '🔨 حظر', callback_data: 'pick_ban_1' });
        row.push({ text: '🔓 رفع حظر', callback_data: 'pick_unban_1' });
      }
      if (perms.canMute) {
        row.push({ text: '🔇 كتم', callback_data: 'pick_mute_1' });
        row.push({ text: '🔊 رفع كتم', callback_data: 'pick_unmute_1' });
      }
      if (row.length) kb.push(row);
    }

    if (perms.canReplyUsers) {
      kb.push([{ text: '💬 مراسلة مستخدم', callback_data: 'pick_reply_1' }]);
    }

    if (perms.canManageTickets) {
      kb.push([{ text: '🎫 الطلبات المفتوحة', callback_data: 'tickets_open_1' }]);
      kb.push([{ text: '📋 الطلبات المعلقة', callback_data: 'tickets_claimed_1' }]);
    }

    kb.push([{ text: '💡 الاقتراحات' + (newSuggestions > 0 ? ' 🔴' + newSuggestions : ''), callback_data: 'suggestions_1' }]);

    if (perms.canManageGroups) {
      kb.push([{ text: '📱 إدارة القروبات (' + allGroups.length + ')', callback_data: 'groups_list_1' }]);
    }

    if (isDeveloper(chatId)) {
      kb.push([{ text: '👨‍💼 إدارة الأدمنية', callback_data: 'admin_panel' }]);
      kb.push([{ text: '📣 إرسال إشعار تحديث', callback_data: 'send_update' }]);
    }

    if (editMsgId) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: editMsgId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: kb }
        });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
  }

  bot.on('callback_query', async (cbq) => {
    const chatId = cbq.message.chat.id;
    const userId = String(cbq.from.id);
    const msgId = cbq.message.message_id;
    const rawData = cbq.data;
    const data = await getCB(rawData);

    await bot.answerCallbackQuery(cbq.id).catch(() => {});

    if (isAdminUser(userId)) {
      const { data: adminData } = await supabase.from('admins').select('*').eq('user_id', userId).maybeSingle();
      if (adminData) {
        const now = Date.now();
        if (now - adminData.last_login > 60000) {
          await supabase.from('admins').update({
            total_active_minutes: (adminData.total_active_minutes || 0) + 1,
            last_login: now
          }).eq('user_id', userId);
        }
      }
    }

    if (!isAdminUser(userId)) {
      await handleUserCallback(chatId, userId, msgId, data, cbq);
      return;
    }

    try {
      if (data === 'main') {
        devState[chatId] = {};
        await sendMainMenu(chatId, msgId);
        await notifyPendingUsers(userId);
        return;
      }

      if (data === 'noop') return;

      if (data.startsWith('qr_')) {
        const qrId = data.replace('qr_', '');
        if (String(qrId) === developerId && !isDeveloper(userId)) return;

        const canReply = await canAdminReply(userId, qrId);
        if (!canReply) {
          await bot.answerCallbackQuery(cbq.id, {
            text: '⛔ هذا الطلب محجوز',
            show_alert: true
          }).catch(() => {});
          return;
        }

        devState[chatId] = { action: 'reply', targetId: qrId };
        const qrUser = await getUser(qrId);
        await bot.sendMessage(chatId, '💬 *الرد على: ' + (qrUser ? getUserName(qrUser) : qrId) + '*\n\n✏️ اكتب ردك الآن:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
        });
        return;
      }

      if (data.startsWith('claim_')) {
        const parts = data.replace('claim_', '').split('_');
        const claimUserId = parts[0];
        const claimTicketId = parseInt(parts[1]);

        const claimed = await claimTicket(claimTicketId, userId);
        if (!claimed || claimed.claimed_by !== String(userId)) {
          await bot.answerCallbackQuery(cbq.id, { text: '⚠️ تم حجز الطلب من قبل!', show_alert: true }).catch(() => {});
          return;
        }

        const claimTargetUser = await getUser(claimUserId);
        await saveTicketEvent(claimTicketId, userId, 'admin', 'claimed', 'تكفل بالطلب');

        try {
          await bot.sendMessage(claimUserId,
            '✅ *تم التكفل بطلبك!*\n\n'
            + '👨‍🏫 الأستاذ سيتولى طلبك الآن.\n'
            + '⏳ يرجى الانتظار!',
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}

        try {
          await bot.editMessageReplyMarkup({
            inline_keyboard: [
              [{ text: '↩️ رد', callback_data: 'qr_' + claimUserId }],
              [{ text: '✅ إنهاء المهمة', callback_data: 'done_' + claimUserId + '_' + claimTicketId }],
              [{ text: '🔙 القائمة', callback_data: 'main' }]
            ]
          }, { chat_id: chatId, message_id: msgId });
        } catch (e) {}

        await bot.sendMessage(chatId,
          '✅ *تكفلت بالطلب*\n'
          + '👤 ' + (claimTargetUser ? getUserName(claimTargetUser) : claimUserId),
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [
              [{ text: '↩️ رد', callback_data: 'qr_' + claimUserId }],
              [{ text: '✅ إنهاء', callback_data: 'done_' + claimUserId + '_' + claimTicketId }]
            ]}
          }
        );
        return;
      }

      if (data.startsWith('done_')) {
        const parts = data.replace('done_', '').split('_');
        const doneUserId = parts[0];
        const doneTicketId = parseInt(parts[1]);

        await completeTicket(doneTicketId);
        await saveTicketEvent(doneTicketId, userId, 'admin', 'completed', 'أنهى المهمة');

        try {
          await bot.sendMessage(doneUserId,
            '✅ *تم إنهاء طلبك!*\n\n⭐ *قيّم تجربتك:*',
            {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [
                [
                  { text: '⭐', callback_data: 'rate_' + doneTicketId + '_1' },
                  { text: '⭐⭐', callback_data: 'rate_' + doneTicketId + '_2' },
                  { text: '⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_3' }
                ],
                [
                  { text: '⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_4' },
                  { text: '⭐⭐⭐⭐⭐', callback_data: 'rate_' + doneTicketId + '_5' }
                ]
              ]}
            }
          );
        } catch (e) {}

        await bot.sendMessage(chatId, '✅ تم إنهاء المهمة!', {
          reply_markup: { inline_keyboard: [[{ text: '🔙 القائمة', callback_data: 'main' }]] }
        });
        return;
      }

      if (data.startsWith('tickets_open_')) {
        const page = parseInt(data.replace('tickets_open_', '')) || 1;
        await showOpenTickets(chatId, page, msgId);
        return;
      }

      if (data.startsWith('tickets_claimed_')) {
        const page = parseInt(data.replace('tickets_claimed_', '')) || 1;
        await showClaimedTickets(chatId, page, msgId);
        return;
      }

      if (data.startsWith('users_')) {
        const page = parseInt(data.replace('users_', '')) || 1;
        await showUsers(chatId, page, msgId);
        return;
      }

      if (data.startsWith('user_') && !data.startsWith('user_msgs_')) {
        const targetId = data.replace('user_', '');
        await showUserDetail(chatId, targetId, msgId);
        return;
      }

      if (data.match(/^user_msgs_\d+_\d+$/)) {
        const parts = data.replace('user_msgs_', '').split('_');
        await showUserConvo(chatId, parts[0], parseInt(parts[1]) || 1, msgId);
        return;
      }

      if (data.startsWith('suggestions_')) {
        const page = parseInt(data.replace('suggestions_', '')) || 1;
        await showSuggestions(chatId, page, msgId);
        return;
      }

      if (data.startsWith('sg_read_')) {
        const sgId = parseInt(data.replace('sg_read_', ''));
        await supabase.from('suggestions').update({ status: 'read' }).eq('id', sgId);
        await showSuggestions(chatId, 1, msgId);
        return;
      }

      if (data === 'stats') {
        await showStats(chatId, msgId);
        return;
      }

      if (data === 'broadcast') {
        const perms = await getAdminPermissions(userId);
        if (!perms.canBroadcast) {
          await bot.answerCallbackQuery(cbq.id, { text: '⛔ ليس لديك صلاحية', show_alert: true }).catch(() => {});
          return;
        }
        devState[chatId] = { action: 'broadcast' };
        const allU = await getAllUsers();
        const activeCount = allU.filter(u => !u.banned).length;
        try {
          await bot.editMessageText('📢 *رسالة جماعية*\n\n✏️ اكتب رسالتك لـ ' + activeCount + ' مستخدم:', {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
          });
        } catch (e) {}
        return;
      }

      if (data.match(/^pick_(ban|unban|mute|unmute|reply)_\d+$/)) {
        const parts = data.split('_');
        const action = parts[1];
        const page = parseInt(parts[2]) || 1;
        await showPickUser(chatId, action, page, msgId);
        return;
      }

      if (data.match(/^do_(ban|unban|mute|unmute)_\d+$/)) {
        const parts = data.replace('do_', '').split('_');
        const action = parts[0];
        const targetId = parts[1];
        await confirmAction(chatId, action, targetId, msgId);
        return;
      }

      if (data.startsWith('do_reply_')) {
        const targetId = data.replace('do_reply_', '');
        devState[chatId] = { action: 'reply', targetId };
        const u = await getUser(targetId);
        try {
          await bot.editMessageText('💬 *مراسلة: ' + (u ? getUserName(u) : targetId) + '*\n\n✏️ اكتب ردك:', {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'main' }]] }
          });
        } catch (e) {}
        return;
      }

      if (data.startsWith('cf_')) {
        const parts = data.replace('cf_', '').split('_');
        const action = parts[0];
        const targetId = parts[1];
        await executeAction(chatId, action, targetId, msgId);
        return;
      }

      if (data === 'admin_panel') {
        if (!isDeveloper(userId)) {
          await bot.sendMessage(chatId, '⛔ للمطور فقط');
          return;
        }
        await showAdminPanel(chatId, msgId);
        return;
      }

      if (data === 'add_admin_id') {
        if (!isDeveloper(userId)) return;
        devState[chatId] = { action: 'add_admin' };
        try {
          await bot.editMessageText('👨‍💼 *إضافة أدمن*\n\n✏️ أرسل ID:', {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'admin_panel' }]] }
          });
        } catch (e) {}
        return;
      }

      if (data.match(/^pick_add_admin_\d+$/)) {
        if (!isDeveloper(userId)) return;
        const page = parseInt(data.replace('pick_add_admin_', '')) || 1;
        await showPickAddAdmin(chatId, page, msgId);
        return;
      }

      if (data.startsWith('add_admin_from_')) {
        if (!isDeveloper(userId)) return;
        const adminId = data.replace('add_admin_from_', '');
        await addAdmin(adminId, userId);
        const aUser = await getUser(adminId);
        await bot.sendMessage(chatId, '✅ تم إضافة *' + (aUser ? getUserName(aUser) : adminId) + '* كأدمن', { parse_mode: 'Markdown' });
        try {
          await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! /start');
        } catch (e) {}
        await showAdminPanel(chatId);
        return;
      }

      if (data.startsWith('rm_admin_')) {
        if (!isDeveloper(userId)) return;
        const rmId = data.replace('rm_admin_', '');
        await removeAdmin(rmId);
        const rmUser = await getUser(rmId);
        await bot.sendMessage(chatId, '✅ تم إزالة *' + (rmUser ? getUserName(rmUser) : rmId) + '*', { parse_mode: 'Markdown' });
        try {
          await bot.sendMessage(rmId, '⚠️ تم إزالتك من الأدمنية');
        } catch (e) {}
        await showAdminPanel(chatId);
        return;
      }

      if (data.startsWith('toggle_multi_')) {
        if (!isDeveloper(userId)) return;
        const tmId = data.replace('toggle_multi_', '');
        const { data: tmData } = await supabase.from('admins').select('multi_reply').eq('user_id', tmId).maybeSingle();
        const newVal = !tmData?.multi_reply;
        await supabase.from('admins').update({ multi_reply: newVal }).eq('user_id', tmId);
        await bot.sendMessage(chatId, (newVal ? '✅ تم منح' : '❌ تم سحب') + ' صلاحية الرد المتعدد', {
          reply_markup: { inline_keyboard: [[{ text: '🔙 إدارة الأدمنية', callback_data: 'admin_panel' }]] }
        });
        return;
      }

      if (data.startsWith('edit_perms_')) {
        if (!isDeveloper(userId)) return;
        const adminId = data.replace('edit_perms_', '');
        await showEditPermissions(chatId, adminId, msgId);
        return;
      }

      if (data.startsWith('perm_toggle_')) {
        if (!isDeveloper(userId)) return;
        const parts = data.replace('perm_toggle_', '').split('_');
        const adminId = parts[0];
        const permKey = parts.slice(1).join('_');
        const perms = await getAdminPermissions(adminId);
        perms[permKey] = !perms[permKey];
        await updateAdminPermissions(adminId, perms);
        await showEditPermissions(chatId, adminId, msgId);
        return;
      }

      if (data.startsWith('groups_list_')) {
        const page = parseInt(data.replace('groups_list_', '')) || 1;
        await showGroupsList(chatId, page, msgId);
        return;
      }

      if (data.startsWith('group_detail_')) {
        const groupId = data.replace('group_detail_', '');
        await showGroupDetail(chatId, groupId, msgId);
        return;
      }

      if (data.startsWith('group_members_')) {
        const parts = data.replace('group_members_', '').split('_p_');
        const groupId = parts[0];
        const page = parseInt(parts[1]) || 1;
        await showGroupMembers(chatId, groupId, page, msgId);
        return;
      }

      if (data.startsWith('gmember_')) {
        const parts = data.replace('gmember_', '').split('_u_');
        const groupId = parts[0];
        const memberId = parts[1];
        await showMemberActions(chatId, groupId, memberId, msgId);
        return;
      }

      if (data.startsWith('gaction_')) {
        const parts = data.replace('gaction_', '').split('_');
        const action = parts[0];
        const groupId = parts[1];
        const memberId = parts[2];
        await executeGroupAction(chatId, action, groupId, memberId, msgId);
        return;
      }

    } catch (err) {
      console.error('خطأ callback:', err.message);
    }
  });

  async function handleUserCallback(chatId, userId, msgId, data, cbq) {
    if (data === 'suggest') {
      devState[chatId] = { action: 'suggest' };
      try {
        await bot.editMessageText(
          '💡 *اقتراح ميزة*\n\nاكتب اقتراحك:',
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'cancel_suggest' }]] } }
        );
      } catch (e) {}
      return;
    }

    if (data === 'cancel_suggest') {
      devState[chatId] = {};
      try {
        await bot.editMessageText('🎓 *هنا أستاذك الخاص*\n\nأرسل سؤالك الآن.', {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح ميزة', callback_data: 'suggest' }]] }
        });
      } catch (e) {}
      return;
    }

    if (data.startsWith('rate_')) {
      const parts = data.replace('rate_', '').split('_');
      const ticketId = parseInt(parts[0]);
      const rating = parseInt(parts[1]);
      await rateTicket(ticketId, rating);
      const stars = '⭐'.repeat(rating);
      try {
        await bot.editMessageText('🙏 *شكراً على تقييمك!*\n\n' + stars, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: 'Markdown'
        });
      } catch (e) {}

      await saveTicketEvent(ticketId, userId, 'user', 'rating', 'تقييم: ' + rating + ' نجوم');
      return;
    }
  }

  async function showOpenTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;

    const { data: tickets, count: total } = await supabase.from('tickets')
      .select('*', { count: 'exact' })
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    const totalPages = Math.ceil((total || 0) / perPage) || 1;

    let text = '🎫 *الطلبات المفتوحة* (' + (total || 0) + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';
    const btns = [];

    if (!tickets || tickets.length === 0) {
      text += '📭 لا توجد طلبات';
    } else {
      for (const t of tickets) {
        const userData = await getUser(t.user_id);
        const uName = userData?.name || t.user_id;
        const username = userData?.username;
        const status = t.claimed_by ? '🔒 محجوز' : '🟢 مفتوح';
        text += status + ' | 👤 ' + uName + (username ? ' @' + username : '') + '\n🕒 ' + formatTime(t.created_at) + '\n\n';

        const rowBtns = [{ text: '👤 ' + uName, callback_data: 'user_' + t.user_id }];
        if (!t.claimed_by) {
          rowBtns.push({ text: '🙋 تكفل', callback_data: await saveCB('claim_' + t.user_id + '_' + t.id) });
        }
        btns.push(rowBtns);
      }
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'tickets_open_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_open_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showClaimedTickets(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;

    const { data: tickets, count: total } = await supabase.from('tickets')
      .select('*', { count: 'exact' })
      .not('claimed_by', 'is', null)
      .order('claimed_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    const totalPages = Math.ceil((total || 0) / perPage) || 1;

    let text = '📋 *الطلبات المعلقة* (' + (total || 0) + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';
    const btns = [];

    if (!tickets || tickets.length === 0) {
      text += '📭 لا توجد طلبات معلقة';
    } else {
      for (const t of tickets) {
        const uData = await getUser(t.user_id);
        const aData = await getUser(t.claimed_by);
        const statusIcon = t.status === 'completed' ? '✅' : '🔒';
        text += statusIcon + ' طلب #' + t.id + '\n'
          + '👤 العميل: ' + (uData ? getUserName(uData) : t.user_id) + '\n'
          + '👨‍💼 الأستاذ: ' + (aData ? getUserName(aData) : t.claimed_by) + '\n\n';
        btns.push([{ text: statusIcon + ' #' + t.id, callback_data: 'user_' + t.user_id }]);
      }
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'tickets_claimed_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'tickets_claimed_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showSuggestions(chatId, page, editMsgId) {
    const perPage = 5;
    const offset = (page - 1) * perPage;

    const { data: suggestions, count: total } = await supabase.from('suggestions')
      .select('*', { count: 'exact' })
      .order('ts', { ascending: false })
      .range(offset, offset + perPage - 1);

    const totalPages = Math.ceil((total || 0) / perPage) || 1;

    let text = '💡 *الاقتراحات* (' + (total || 0) + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';
    const btns = [];

    if (!suggestions || suggestions.length === 0) {
      text += '📭 لا توجد اقتراحات';
    } else {
      for (const sg of suggestions) {
        const userData = await getUser(sg.user_id);
        const sgUser = userData?.name || sg.user_id;
        const isNew = sg.status === 'new' ? '🔴 ' : '✅ ';
        text += isNew + '👤 ' + sgUser + '\n'
          + '💬 ' + (sg.text || '').substring(0, 100) + '\n'
          + '🕒 ' + formatTime(sg.ts) + '\n\n';
        if (sg.status === 'new') {
          btns.push([{ text: '✅ قرأته #' + sg.id, callback_data: 'sg_read_' + sg.id }]);
        }
      }
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'suggestions_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'suggestions_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showStats(chatId, editMsgId) {
    const allUsers = await getAllUsers();
    const dayAgo = Date.now() - 86400000;

    const { count: totalMsgs } = await supabase.from('msg_map').select('*', { count: 'exact', head: true });
    const { count: todayMsgs } = await supabase.from('msg_map').select('*', { count: 'exact', head: true }).gt('ts', dayAgo);
    const { count: totalTickets } = await supabase.from('tickets').select('*', { count: 'exact', head: true });
    const { count: completedTickets } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'completed');

    const { data: avgData } = await supabase.from('tickets').select('rating').gt('rating', 0);
    const avgRating = avgData && avgData.length > 0 ? (avgData.reduce((sum, t) => sum + t.rating, 0) / avgData.length).toFixed(1) : 0;

    const { count: totalSuggestions } = await supabase.from('suggestions').select('*', { count: 'exact', head: true });
    const allGroups = await getAllGroups();

    const text = '📈 *الإحصائيات المتقدمة*\n━━━━━━━━━━━━━━━\n'
      + '👥 المستخدمين: ' + allUsers.length + '\n'
      + '🟢 نشطين اليوم: ' + allUsers.filter(u => u.last_seen > dayAgo).length + '\n'
      + '🚫 محظورين: ' + allUsers.filter(u => u.banned).length + '\n'
      + '🔇 مكتومين: ' + allUsers.filter(u => u.muted).length + '\n'
      + '━━━━━━━━━━━━━━━\n'
      + '💬 الرسائل الكلية: ' + (totalMsgs || 0) + '\n'
      + '📨 رسائل اليوم: ' + (todayMsgs || 0) + '\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🎫 الطلبات الكلية: ' + (totalTickets || 0) + '\n'
      + '✅ المكتملة: ' + (completedTickets || 0) + '\n'
      + '⭐ متوسط التقييم: ' + avgRating + '/5\n'
      + '━━━━━━━━━━━━━━━\n'
      + '💡 الاقتراحات: ' + (totalSuggestions || 0) + '\n'
      + '📱 القروبات: ' + allGroups.length;

    if (editMsgId) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: editMsgId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] }
        });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] }
    });
  }

  async function showUsers(chatId, page, editMsgId) {
    const allUsers = await getAllUsers();
    const perPage = 8;
    const totalPages = Math.ceil(allUsers.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageUsers = allUsers.slice(start, start + perPage);

    let text = '👥 *المستخدمين* (' + allUsers.length + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━';
    const btns = [];

    for (const u of pageUsers) {
      let label = '';
      if (u.banned) label += '🚫 ';
      if (u.muted) label += '🔇 ';
      if (u.id === developerId) label += '👑 ';
      label += (u.name || 'بدون اسم');
      if (u.username) label += ' @' + u.username;
      btns.push([{ text: label, callback_data: 'user_' + u.id }]);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'users_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'users_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showUserDetail(chatId, targetId, editMsgId) {
    const u = await getUser(targetId);
    if (!u) {
      await bot.sendMessage(chatId, '❌ المستخدم غير موجود');
      return;
    }

    const { count: msgCount } = await supabase.from('msg_map').select('*', { count: 'exact', head: true }).eq('user_id', targetId);
    const { count: todayMsgs } = await supabase.from('msg_map').select('*', { count: 'exact', head: true }).eq('user_id', targetId).gt('ts', Date.now() - 86400000);
    const { count: ticketCount } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('user_id', targetId);
    const { data: avgData } = await supabase.from('tickets').select('rating').eq('user_id', targetId).gt('rating', 0);
    const avgRating = avgData && avgData.length > 0 ? (avgData.reduce((sum, t) => sum + t.rating, 0) / avgData.length).toFixed(1) : 0;
    const { count: suggCount } = await supabase.from('suggestions').select('*', { count: 'exact', head: true }).eq('user_id', targetId);

    const isDev = String(targetId) === developerId;
    let text = '👤 *ملف المستخدم*\n━━━━━━━━━━━━━━━\n'
      + (isDev ? '👑 *مطور البوت*\n' : '')
      + '📝 الاسم: ' + (u.name || '-') + '\n'
      + '🔗 يوزر: ' + (u.username ? '@' + u.username : '-') + '\n'
      + '🆔 ID: `' + u.id + '`\n'
      + (u.phone ? '📱 الهاتف: ' + u.phone + '\n' : '')
      + '━━━━━━━━━━━━━━━\n'
      + '📨 الرسائل: ' + (msgCount || 0) + '\n'
      + '📅 اليوم: ' + (todayMsgs || 0) + '\n'
      + '🎫 الطلبات: ' + (ticketCount || 0) + '\n'
      + '⭐ التقييم: ' + avgRating + '/5\n'
      + '💡 الاقتراحات: ' + (suggCount || 0) + '\n'
      + '🕒 آخر نشاط: ' + formatTime(u.last_seen) + '\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🚫 محظور: ' + (u.banned ? '✅' : '❌') + '\n'
      + '🔇 مكتوم: ' + (u.muted ? '✅' : '❌');

    const kb = [];
    if (!isDev) {
      kb.push([
        { text: u.banned ? '🔓 رفع الحظر' : '🔨 حظر', callback_data: 'do_' + (u.banned ? 'unban' : 'ban') + '_' + targetId },
        { text: u.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: 'do_' + (u.muted ? 'unmute' : 'mute') + '_' + targetId }
      ]);
    }
    kb.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    kb.push([{ text: '📜 المحادثات', callback_data: 'user_msgs_' + targetId + '_1' }]);
    kb.push([{ text: '🔙 رجوع', callback_data: 'users_1' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
  }

  async function showUserConvo(chatId, targetId, page, editMsgId) {
    const u = await getUser(targetId);
    const uName = u ? (u.name || 'مجهول') : targetId;
    const perPage = 10;
    const offset = (page - 1) * perPage;

    const { data: allTickets } = await supabase.from('tickets')
      .select('id')
      .eq('user_id', targetId);

    const ticketIds = allTickets ? allTickets.map(t => t.id) : [];

    let msgs = [];
    let total = 0;

    if (ticketIds.length > 0) {
      const { data: msgsData, count: totalCount } = await supabase.from('ticket_events')
        .select('*', { count: 'exact' })
        .in('ticket_id', ticketIds)
        .eq('event_type', 'message')
        .order('ts', { ascending: false })
        .range(offset, offset + perPage - 1);

      msgs = msgsData || [];
      total = totalCount || 0;
    }

    const totalPages = Math.ceil(total / perPage) || 1;

    let text = '📜 *محادثات: ' + uName + '*\n📊 ' + total + ' رسالة | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';

    if (msgs.length === 0) {
      text += '📭 لا توجد رسائل';
    } else {
      for (const m of msgs) {
        const roleIcon = m.role === 'admin' ? '👨‍💼' : '👤';
        const msgContent = (m.content || '').substring(0, 150);
        text += roleIcon + ' ' + msgContent + '\n🕒 ' + formatTime(m.ts) + '\n\n';
      }
    }

    const btns = [];
    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'user_msgs_' + targetId + '_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'user_msgs_' + targetId + '_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '💬 مراسلة', callback_data: 'do_reply_' + targetId }]);
    btns.push([{ text: '🔙 الملف', callback_data: 'user_' + targetId }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showPickUser(chatId, action, page, editMsgId) {
    const allUsers = await getAllUsers();
    let filtered = allUsers;

    if (action === 'ban') filtered = allUsers.filter(u => !u.banned && u.id !== developerId);
    if (action === 'unban') filtered = allUsers.filter(u => u.banned && u.id !== developerId);
    if (action === 'mute') filtered = allUsers.filter(u => !u.muted && u.id !== developerId);
    if (action === 'unmute') filtered = allUsers.filter(u => u.muted && u.id !== developerId);
    if (action === 'reply') filtered = allUsers.filter(u => u.id !== developerId);

    const perPage = 8;
    const totalPages = Math.ceil(filtered.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageUsers = filtered.slice(start, start + perPage);

    const titles = {
      ban: '🔨 اختر للحظر:',
      unban: '🔓 اختر لرفع الحظر:',
      mute: '🔇 اختر للكتم:',
      unmute: '🔊 اختر لرفع الكتم:',
      reply: '💬 اختر للمراسلة:'
    };

    let text = titles[action] || 'اختر:';
    if (filtered.length === 0) text += '\n\n⚠️ لا يوجد مستخدمين';

    const btns = [];
    for (const u of pageUsers) {
      let label = (u.banned ? '🚫 ' : '') + (u.muted ? '🔇 ' : '') + (u.name || 'بدون اسم');
      if (u.username) label += ' @' + u.username;
      btns.push([{ text: label, callback_data: 'do_' + action + '_' + u.id }]);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'pick_' + action + '_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'pick_' + action + '_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function confirmAction(chatId, action, targetId, editMsgId) {
    if (String(targetId) === developerId) {
      try {
        await bot.editMessageText('⛔ لا يمكن تطبيق إجراء على المطور', {
          chat_id: chatId,
          message_id: editMsgId,
          reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] }
        });
      } catch (e) {}
      return;
    }

    const u = await getUser(targetId);
    const actNames = {
      ban: '🔨 حظر',
      unban: '🔓 رفع حظر',
      mute: '🔇 كتم',
      unmute: '🔊 رفع كتم'
    };

    const text = '*' + actNames[action] + '*\n\n👤 ' + (u ? getUserName(u) : targetId) + '\n🆔 `' + targetId + '`\n\nهل أنت متأكد؟';

    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ تأكيد', callback_data: 'cf_' + action + '_' + targetId }],
          [{ text: '❌ إلغاء', callback_data: 'main' }]
        ]}
      });
    } catch (e) {}
  }

  async function executeAction(chatId, action, targetId, editMsgId) {
    if (String(targetId) === developerId) {
      try {
        await bot.editMessageText('⛔ لا يمكن تطبيق إجراء على المطور', {
          chat_id: chatId,
          message_id: editMsgId,
          reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] }
        });
      } catch (e) {}
      return;
    }

    let result = '';
    if (action === 'ban') {
      await setUserField(targetId, 'banned', true);
      result = '✅ تم حظر `' + targetId + '`';
      try {
        await bot.sendMessage(targetId, '⛔ تم حظرك من البوت');
      } catch (e) {}
    } else if (action === 'unban') {
      await setUserField(targetId, 'banned', false);
      result = '✅ تم رفع الحظر عن `' + targetId + '`';
      try {
        await bot.sendMessage(targetId, '✅ تم رفع الحظر عنك');
      } catch (e) {}
    } else if (action === 'mute') {
      await setUserField(targetId, 'muted', true);
      result = '✅ تم كتم `' + targetId + '`';
    } else if (action === 'unmute') {
      await setUserField(targetId, 'muted', false);
      result = '✅ تم رفع الكتم عن `' + targetId + '`';
    }

    try {
      await bot.editMessageText(result, {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'main' }]] }
      });
    } catch (e) {}
  }

  async function showAdminPanel(chatId, editMsgId) {
    const admins = await getAdminList();
    let text = '👨‍💼 *إدارة الأدمنية المتطورة*\n━━━━━━━━━━━━━━━\n'
      + '👑 المطور: (ID: `' + developerId + '`)\n';

    const btns = [];
    if (admins.length > 0) {
      text += '\n📋 *الأدمنية:*\n';
      for (const a of admins) {
        const aName = a.users?.name || a.user_id;
        const username = a.users?.username;
        const multiLabel = a.multi_reply ? ' 🔓' : '';
        text += '• ' + aName + (username ? ' @' + username : '') + multiLabel + ' (ID: `' + a.user_id + '`)\n';

        const rmData = await saveCB('rm_admin_' + a.user_id);
        const toggleData = await saveCB('toggle_multi_' + a.user_id);
        const permsData = await saveCB('edit_perms_' + a.user_id);

        btns.push([
          { text: '❌ إزالة ' + (a.users?.name || a.user_id), callback_data: rmData }
        ]);
        btns.push([
          { text: (a.multi_reply ? '🔒 سحب متعدد' : '🔓 منح متعدد'), callback_data: toggleData },
          { text: '⚙️ الصلاحيات', callback_data: permsData }
        ]);
      }
    } else {
      text += '\n📭 لا يوجد أدمنية';
    }

    btns.push([{ text: '➕ إضافة بالـ ID', callback_data: 'add_admin_id' }]);
    btns.push([{ text: '👥 إضافة من المستخدمين', callback_data: 'pick_add_admin_1' }]);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showPickAddAdmin(chatId, page, editMsgId) {
    const allUsers = await getAllUsers();
    const filtered = allUsers.filter(u => u.id !== developerId && !isAdminUser(u.id));

    const perPage = 8;
    const totalPages = Math.ceil(filtered.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageUsers = filtered.slice(start, start + perPage);

    const btns = [];
    for (const u of pageUsers) {
      let label = (u.name || 'بدون اسم');
      if (u.username) label += ' @' + u.username;
      btns.push([{ text: label, callback_data: 'add_admin_from_' + u.id }]);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'pick_add_admin_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'pick_add_admin_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'admin_panel' }]);

    try {
      await bot.editMessageText('👨‍💼 اختر مستخدم لإضافته كأدمن:', {
        chat_id: chatId,
        message_id: editMsgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: btns }
      });
    } catch (e) {}
  }

  async function showEditPermissions(chatId, adminId, editMsgId) {
    const perms = await getAdminPermissions(adminId);
    const u = await getUser(adminId);

    const permLabels = {
      canBan: '🔨 الحظر/الكتم',
      canMute: '🔇 الكتم',
      canBroadcast: '📢 الرسائل الجماعية',
      canViewStats: '📈 عرض الإحصائيات',
      canManageTickets: '🎫 إدارة الطلبات',
      canManageGroups: '📱 إدارة القروبات',
      canReplyUsers: '💬 الرد على المستخدمين'
    };

    let text = '⚙️ *صلاحيات: ' + (u ? getUserName(u) : adminId) + '*\n━━━━━━━━━━━━━━━\n\n';
    const btns = [];

    for (const [key, label] of Object.entries(permLabels)) {
      const status = perms[key] ? '✅' : '❌';
      text += status + ' ' + label + '\n';
      btns.push([{
        text: (perms[key] ? '✅ ' : '❌ ') + label,
        callback_data: await saveCB('perm_toggle_' + adminId + '_' + key)
      }]);
    }

    btns.push([{ text: '🔙 رجوع', callback_data: 'admin_panel' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showGroupsList(chatId, page, editMsgId) {
    const allGroups = await getAllGroups();
    const perPage = 8;
    const totalPages = Math.ceil(allGroups.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageGroups = allGroups.slice(start, start + perPage);

    let text = '📱 *إدارة القروبات* (' + allGroups.length + ') | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';
    const btns = [];

    if (pageGroups.length === 0) {
      text += '📭 لا توجد قروبات';
    } else {
      for (const g of pageGroups) {
        const members = await getGroupMembers(g.group_id);
        const label = '📱 ' + g.title + ' (' + members.length + ' عضو)';
        text += '• ' + g.title + '\n  👥 ' + members.length + ' عضو\n\n';
        btns.push([{ text: label, callback_data: await saveCB('group_detail_' + g.group_id) }]);
      }
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: 'groups_list_' + (page - 1) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: 'groups_list_' + (page + 1) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 رجوع', callback_data: 'main' }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showGroupDetail(chatId, groupId, editMsgId) {
    const { data: group } = await supabase.from('groups').select('*').eq('group_id', groupId).maybeSingle();
    if (!group) {
      await bot.sendMessage(chatId, '❌ القروب غير موجود');
      return;
    }

    const members = await getGroupMembers(groupId);
    const admins = members.filter(m => m.is_admin);
    const bots = members.filter(m => m.is_bot);
    const banned = members.filter(m => m.banned);
    const muted = members.filter(m => m.muted);

    let text = '📱 *تفاصيل القروب*\n━━━━━━━━━━━━━━━\n'
      + '📝 الاسم: ' + group.title + '\n'
      + '🔗 اليوزر: ' + (group.username ? '@' + group.username : '-') + '\n'
      + '🆔 ID: `' + group.group_id + '`\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👥 الأعضاء: ' + members.length + '\n'
      + '👨‍💼 الأدمنية: ' + admins.length + '\n'
      + '🤖 البوتات: ' + bots.length + '\n'
      + '🚫 المحظورين: ' + banned.length + '\n'
      + '🔇 المكتومين: ' + muted.length + '\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📅 أُضيف: ' + formatTime(group.added_at);

    const btns = [
      [{ text: '👥 عرض الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }],
      [{ text: '🔙 القروبات', callback_data: 'groups_list_1' }]
    ];

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showGroupMembers(chatId, groupId, page, editMsgId) {
    const { data: group } = await supabase.from('groups').select('*').eq('group_id', groupId).maybeSingle();
    const members = await getGroupMembers(groupId);

    const perPage = 8;
    const totalPages = Math.ceil(members.length / perPage) || 1;
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * perPage;
    const pageMembers = members.slice(start, start + perPage);

    let text = '👥 *أعضاء: ' + (group?.title || groupId) + '*\n'
      + '(' + members.length + ' عضو) | صفحة ' + page + '/' + totalPages + '\n━━━━━━━━━━━━━━━\n\n';

    const btns = [];

    for (const m of pageMembers) {
      let label = '';
      if (m.is_owner) label += '👑 ';
      else if (m.is_admin) label += '👨‍💼 ';
      if (m.is_bot) label += '🤖 ';
      if (m.banned) label += '🚫 ';
      if (m.muted) label += '🔇 ';
      if (m.warnings > 0) label += '⚠️' + m.warnings + ' ';

      label += (m.name || 'بدون اسم');
      if (m.username) label += ' @' + m.username;

      btns.push([{ text: label, callback_data: await saveCB('gmember_' + groupId + '_u_' + m.user_id) }]);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '⬅️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (page - 1)) });
    navRow.push({ text: page + '/' + totalPages, callback_data: 'noop' });
    if (page < totalPages) navRow.push({ text: '➡️', callback_data: await saveCB('group_members_' + groupId + '_p_' + (page + 1)) });
    if (navRow.length > 0) btns.push(navRow);
    btns.push([{ text: '🔙 تفاصيل القروب', callback_data: await saveCB('group_detail_' + groupId) }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function showMemberActions(chatId, groupId, memberId, editMsgId) {
    const { data: member } = await supabase.from('group_members')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', memberId)
      .maybeSingle();

    if (!member) {
      await bot.sendMessage(chatId, '❌ العضو غير موجود');
      return;
    }

    const { data: group } = await supabase.from('groups').select('*').eq('group_id', groupId).maybeSingle();

    let text = '👤 *إدارة العضو*\n━━━━━━━━━━━━━━━\n'
      + '📝 الاسم: ' + (member.name || 'بدون اسم') + '\n'
      + '🔗 اليوزر: ' + (member.username ? '@' + member.username : '-') + '\n'
      + '🆔 ID: `' + member.user_id + '`\n'
      + (member.phone ? '📱 الهاتف: ' + member.phone + '\n' : '')
      + '━━━━━━━━━━━━━━━\n'
      + '📱 القروب: ' + (group?.title || groupId) + '\n'
      + '👨‍💼 أدمن: ' + (member.is_admin ? '✅' : '❌') + '\n'
      + '🤖 بوت: ' + (member.is_bot ? '✅' : '❌') + '\n'
      + '⚠️ الإنذارات: ' + (member.warnings || 0) + '\n'
      + '🚫 محظور: ' + (member.banned ? '✅' : '❌') + '\n'
      + '🔇 مكتوم: ' + (member.muted ? '✅' : '❌') + '\n'
      + '🕒 آخر نشاط: ' + formatTime(member.last_seen);

    const btns = [];

    if (!member.is_owner && !member.is_bot) {
      btns.push([
        { text: '⚠️ إنذار', callback_data: await saveCB('gaction_warn_' + groupId + '_' + memberId) },
        { text: member.is_admin ? '➖ إزالة أدمن' : '➕ ترقية لأدمن', callback_data: await saveCB('gaction_' + (member.is_admin ? 'demote' : 'promote') + '_' + groupId + '_' + memberId) }
      ]);
      btns.push([
        { text: member.banned ? '🔓 رفع الحظر' : '🚫 حظر', callback_data: await saveCB('gaction_' + (member.banned ? 'unban' : 'ban') + '_' + groupId + '_' + memberId) },
        { text: member.muted ? '🔊 رفع الكتم' : '🔇 كتم', callback_data: await saveCB('gaction_' + (member.muted ? 'unmute' : 'mute') + '_' + groupId + '_' + memberId) }
      ]);
      btns.push([{ text: '👢 طرد', callback_data: await saveCB('gaction_kick_' + groupId + '_' + memberId) }]);
    }

    btns.push([{ text: '🔙 الأعضاء', callback_data: await saveCB('group_members_' + groupId + '_p_1') }]);

    if (editMsgId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  }

  async function executeGroupAction(chatId, action, groupId, memberId, editMsgId) {
    let result = '';

    try {
      if (action === 'warn') {
        const { data: member } = await supabase.from('group_members')
          .select('warnings')
          .eq('group_id', groupId)
          .eq('user_id', memberId)
          .maybeSingle();
        const newWarnings = (member?.warnings || 0) + 1;
        await setGroupMemberField(groupId, memberId, 'warnings', newWarnings);
        result = '⚠️ تم إنذار العضو (' + newWarnings + ' إنذار)';
        try {
          await bot.sendMessage(memberId, '⚠️ تلقيت إنذاراً في القروب! العدد: ' + newWarnings);
        } catch (e) {}
      } else if (action === 'promote') {
        await setGroupMemberField(groupId, memberId, 'is_admin', true);
        try {
          await bot.promoteChatMember(groupId, memberId, {
            can_change_info: true,
            can_delete_messages: true,
            can_invite_users: true,
            can_restrict_members: true,
            can_pin_messages: true
          });
          result = '✅ تم ترقية العضو لأدمن';
        } catch (e) {
          result = '✅ تم تحديث الحالة (قد يلزم منح صلاحيات يدوياً)';
        }
      } else if (action === 'demote') {
        await setGroupMemberField(groupId, memberId, 'is_admin', false);
        try {
          await bot.promoteChatMember(groupId, memberId, {
            can_change_info: false,
            can_delete_messages: false,
            can_invite_users: false,
            can_restrict_members: false,
            can_pin_messages: false
          });
          result = '✅ تم إزالة صلاحيات الأدمن';
        } catch (e) {
          result = '✅ تم تحديث الحالة';
        }
      } else if (action === 'ban') {
        await setGroupMemberField(groupId, memberId, 'banned', true);
        try {
          await bot.banChatMember(groupId, memberId);
          result = '✅ تم حظر العضو';
        } catch (e) {
          result = '⚠️ تم تحديث الحالة (قد تحتاج صلاحيات)';
        }
      } else if (action === 'unban') {
        await setGroupMemberField(groupId, memberId, 'banned', false);
        try {
          await bot.unbanChatMember(groupId, memberId);
          result = '✅ تم رفع الحظر';
        } catch (e) {
          result = '✅ تم تحديث الحالة';
        }
      } else if (action === 'mute') {
        await setGroupMemberField(groupId, memberId, 'muted', true);
        try {
          await bot.restrictChatMember(groupId, memberId, {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false
          });
          result = '✅ تم كتم العضو';
        } catch (e) {
          result = '⚠️ تم تحديث الحالة (قد تحتاج صلاحيات)';
        }
      } else if (action === 'unmute') {
        await setGroupMemberField(groupId, memberId, 'muted', false);
        try {
          await bot.restrictChatMember(groupId, memberId, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_other_messages: true
          });
          result = '✅ تم رفع الكتم';
        } catch (e) {
          result = '✅ تم تحديث الحالة';
        }
      } else if (action === 'kick') {
        try {
          await bot.banChatMember(groupId, memberId);
          await bot.unbanChatMember(groupId, memberId);
          await supabase.from('group_members').delete().eq('group_id', groupId).eq('user_id', memberId);
          result = '✅ تم طرد العضو';
        } catch (e) {
          result = '⚠️ فشل الطرد (قد تحتاج صلاحيات)';
        }
      }
    } catch (e) {
      result = '❌ حدث خطأ: ' + e.message;
    }

    try {
      await bot.editMessageText(result, {
        chat_id: chatId,
        message_id: editMsgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: await saveCB('gmember_' + groupId + '_u_' + memberId) }]] }
      });
    } catch (e) {}
  }

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const userName = msg.from.username || '';
    const fullName = ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim();

    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      try {
        const chatMember = await bot.getChatMember(chatId, userId);
        const isAdmin = ['creator', 'administrator'].includes(chatMember.status);
        const isOwner = chatMember.status === 'creator';

        await updateGroupMember(chatId, userId, userName, fullName, '', isAdmin, msg.from.is_bot, isOwner);
        await updateMemberLastSeen(chatId, userId);

        if (msg.text) {
          await saveGroupMessage(chatId, userId, msg.message_id, msg.text);
        }
      } catch (e) {
        console.error('خطأ معالجة رسالة القروب:', e.message);
      }
      return;
    }

    if (msg.chat.type !== 'private') return;

    if (msg.contact) {
      if (String(msg.contact.user_id) !== userId) {
        await bot.sendMessage(chatId, '⚠️ يرجى إرسال جهة اتصالك!');
        return;
      }
      await supabase.from('users').update({ phone: msg.contact.phone_number, verified: true }).eq('id', userId);
      await supabase.from('tickets').update({ user_locked: false }).eq('user_id', userId).eq('status', 'open');
      await bot.sendMessage(chatId, '✅ تم التحقق!', { reply_markup: { remove_keyboard: true } });
      await bot.sendMessage(developerId,
        '🆕 *تحقق جديد*\n━━━━━━━━━━━━━━━\n'
        + '👤 ' + fullName + '\n'
        + '🆔 `' + userId + '`\n'
        + '📞 `' + msg.contact.phone_number + '`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (msg.text && msg.text.startsWith('/')) return;

    if (isAdminUser(userId)) {
      await handleAdminMsg(chatId, userId, msg);
      return;
    }

    await updateUser(userId, userName, fullName);
    const user = await getUser(userId);

    if (user?.banned) {
      await bot.sendMessage(chatId, '⛔ أنت محظور');
      return;
    }

    if (user?.muted) {
      await bot.sendMessage(chatId, '🔇 أنت مكتوم');
      return;
    }

    const state = devState[chatId] || {};

    if (state.action === 'suggest') {
      devState[chatId] = {};
      const suggText = msg.text || '[محتوى غير نصي]';
      await supabase.from('suggestions').insert({
        user_id: userId,
        text: suggText,
        ts: Date.now(),
        status: 'new'
      });

      const sgUser = await getUser(userId);
      await bot.sendMessage(developerId,
        '💡 *اقتراح جديد!*\n━━━━━━━━━━━━━━━\n'
        + '👤 ' + (sgUser ? getUserName(sgUser) : userId) + '\n'
        + '🆔 `' + userId + '`\n\n'
        + '📝 ' + suggText,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 رد', callback_data: 'qr_' + userId }]] } }
      );

      await bot.sendMessage(chatId, '✅ *شكراً على اقتراحك!*\n\nتم إرساله للمطور.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '💡 اقتراح آخر', callback_data: 'suggest' }]] }
      });
      return;
    }

    const ticketId = await createTicket(userId);

    if (ticketId) {
      const msgContent = msg.text || (msg.photo ? '[صورة]' : msg.video ? '[فيديو]' : '[محتوى]');
      await saveTicketEvent(ticketId, userId, 'user', 'message', msgContent);
    }

    const quickBtns = {
      inline_keyboard: [
        [
          { text: '↩️ رد', callback_data: await saveCB('qr_' + userId) },
          { text: '🙋 تكفل', callback_data: await saveCB('claim_' + userId + '_' + ticketId) }
        ]
      ]
    };

    const admins = await getAdminList();
    pendingNotify[userId] = { notified: false, ts: Date.now() };

    try {
      const report = '📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n'
        + '👤 ' + fullName + '\n'
        + '🔗 ' + (userName ? '@' + userName : '-') + '\n'
        + '🆔 `' + userId + '`\n'
        + '🕒 ' + formatTime(Date.now());

      await bot.sendMessage(developerId, report, { parse_mode: 'Markdown' });
      const fwd = await bot.forwardMessage(developerId, chatId, msg.message_id);
      await saveMsgMap(userId, msg.message_id, fwd.message_id, developerId);
      await bot.sendMessage(developerId, '⬆️ من: *' + fullName + '*', { parse_mode: 'Markdown', reply_markup: quickBtns });
    } catch (e) {}

    for (const a of admins) {
      if (a.user_id === developerId) continue;
      try {
        const reportAdmin = '📨 *رسالة جديدة*\n━━━━━━━━━━━━━━━\n'
          + '👤 ' + fullName + '\n'
          + '🕒 ' + formatTime(Date.now());
        await bot.sendMessage(a.user_id, reportAdmin, { parse_mode: 'Markdown' });
        const fwdAdmin = await bot.forwardMessage(a.user_id, chatId, msg.message_id);
        await saveMsgMap(userId, msg.message_id, fwdAdmin.message_id, a.user_id);
        await bot.sendMessage(a.user_id, '⬆️ من: *' + fullName + '*', { parse_mode: 'Markdown', reply_markup: quickBtns });
      } catch (e) {}
    }

    await bot.sendMessage(chatId,
      '✅ *تم استلام رسالتك!*\n\n'
      + '📬 وصلت للأستاذ.\n'
      + '⏳ سنعلمك فور فتح المحادثة.',
      { parse_mode: 'Markdown' }
    );
  });

  async function handleAdminMsg(chatId, userId, msg) {
    const state = devState[chatId] || {};

    if (msg.text && msg.text.startsWith('/')) return;

    if (state.action === 'add_admin' && isDeveloper(userId)) {
      devState[chatId] = {};
      const adminId = (msg.text || '').trim();
      if (!adminId || !/^\d+$/.test(adminId)) {
        await bot.sendMessage(chatId, '⚠️ أرسل ID صحيح', {
          reply_markup: { inline_keyboard: [[{ text: '🔙 رجوع', callback_data: 'admin_panel' }]] }
        });
        return;
      }
      if (String(adminId) === developerId) {
        await bot.sendMessage(chatId, '⛔ المطور لا يُضاف');
        return;
      }
      await addAdmin(adminId, userId);
      await bot.sendMessage(chatId, '✅ تم إضافة `' + adminId + '` كأدمن', { parse_mode: 'Markdown' });
      try {
        await bot.sendMessage(adminId, '🎉 تم تعيينك كأدمن! /start');
      } catch (e) {}
      return;
    }

    if (state.action === 'broadcast') {
      const perms = await getAdminPermissions(userId);
      if (!perms.canBroadcast) return;

      devState[chatId] = {};
      const all = (await getAllUsers()).filter(u => !u.banned);
      let ok = 0, fail = 0;
      await bot.sendMessage(chatId, '📢 جاري الإرسال لـ ' + all.length + ' مستخدم...');

      for (const u of all) {
        try {
          await bot.copyMessage(u.id, chatId, msg.message_id);
          ok++;
        } catch (e) {
          fail++;
        }
      }

      await bot.sendMessage(chatId, '✅ تم! نجح: ' + ok + ' | فشل: ' + fail, {
        reply_markup: { inline_keyboard: [[{ text: '🔙 القائمة', callback_data: 'main' }]] }
      });
      return;
    }

    if (state.action === 'reply' && state.targetId) {
      const target = state.targetId;
      devState[chatId] = {};

      try {
        await bot.copyMessage(target, chatId, msg.message_id);

        const { data: adminData } = await supabase.from('admins').select('helped_count').eq('user_id', userId).maybeSingle();
        const newCount = (adminData?.helped_count || 0) + 1;
        await supabase.from('admins').update({ helped_count: newCount }).eq('user_id', userId);

        const targetTicket = await getOpenTicket(target);
        if (targetTicket) {
          const replyContent = msg.text || '[محتوى]';
          await saveTicketEvent(targetTicket.id, userId, 'admin', 'message', replyContent);

          const newReplyCount = (targetTicket.admin_reply_count || 0) + 1;
          await supabase.from('tickets').update({ admin_reply_count: newReplyCount }).eq('id', targetTicket.id);
        }

        try {
          await bot.sendMessage(target, '💬 *وصلك رد من الأستاذ*', { parse_mode: 'Markdown' });
        } catch (e) {}

        await bot.sendMessage(chatId, '✅ تم الإرسال', {
          reply_markup: { inline_keyboard: [
            [{ text: '↩️ رد آخر', callback_data: 'qr_' + target }],
            [{ text: '🔙 القائمة', callback_data: 'main' }]
          ]}
        });
      } catch (err) {
        await bot.sendMessage(chatId, '❌ فشل: ' + err.message);
      }
      return;
    }

    if (msg.reply_to_message) {
      const repliedMsgId = msg.reply_to_message.message_id;
      const targetUserId = await getUserByFwdMsg(repliedMsgId, chatId);

      if (targetUserId) {
        try {
          await bot.copyMessage(targetUserId, chatId, msg.message_id);

          const replyTicket = await getOpenTicket(targetUserId);
          if (replyTicket) {
            const replyContent = msg.text || '[محتوى]';
            await saveTicketEvent(replyTicket.id, userId, 'admin', 'message', replyContent);
          }

          try {
            await bot.sendMessage(targetUserId, '💬 *وصلك رد*', { parse_mode: 'Markdown' });
          } catch (e) {}

          await bot.sendMessage(chatId, '✅ تم الإرسال', {
            reply_markup: { inline_keyboard: [
              [{ text: '↩️ رد آخر', callback_data: 'qr_' + targetUserId }],
              [{ text: '🔙 القائمة', callback_data: 'main' }]
            ]}
          });
        } catch (err) {
          await bot.sendMessage(chatId, '❌ فشل: ' + err.message);
        }
        return;
      }
    }

    await sendMainMenu(chatId);
  }

  bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    const newMembers = msg.new_chat_members;

    for (const member of newMembers) {
      if (member.is_bot && member.username && member.username.includes('bot')) {
        const chatInfo = await bot.getChat(chatId);
        const memberCount = await bot.getChatMemberCount(chatId);
        const addedBy = msg.from.id;

        await saveGroup(chatId, chatInfo.title, chatInfo.username, memberCount, addedBy);

        const notif = '🆕 *تمت إضافة البوت لقروب جديد!*\n━━━━━━━━━━━━━━━\n'
          + '📱 القروب: ' + chatInfo.title + '\n'
          + '🔗 اليوزر: ' + (chatInfo.username ? '@' + chatInfo.username : '-') + '\n'
          + '🆔 ID: `' + chatId + '`\n'
          + '👥 الأعضاء: ' + memberCount + '\n'
          + '👤 أضافه: ' + ((msg.from.first_name || '') + ' ' + (msg.from.last_name || '')).trim() + '\n'
          + '🔗 ' + (msg.from.username ? '@' + msg.from.username : '-') + '\n'
          + '🕒 ' + formatTime(Date.now());

        await bot.sendMessage(developerId, notif, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📱 عرض التفاصيل', callback_data: await saveCB('group_detail_' + chatId) }]] }
        });

        try {
          const admins = await bot.getChatAdministrators(chatId);
          for (const admin of admins) {
            const isOwner = admin.status === 'creator';
            const isBot = admin.user.is_bot;
            const fullName = ((admin.user.first_name || '') + ' ' + (admin.user.last_name || '')).trim();
            await updateGroupMember(chatId, admin.user.id, admin.user.username, fullName, '', true, isBot, isOwner);
          }
        } catch (e) {}

        return;
      }

      const isBot = member.is_bot;
      const fullName = ((member.first_name || '') + ' ' + (member.last_name || '')).trim();
      await updateGroupMember(chatId, member.id, member.username, fullName, '', false, isBot, false);
    }
  });

  bot.on('left_chat_member', async (msg) => {
    const chatId = msg.chat.id;
    const member = msg.left_chat_member;

    try {
      await supabase.from('group_members').delete().eq('group_id', String(chatId)).eq('user_id', String(member.id));
    } catch (e) {}
  });

  console.log('✅ البوت جاهز مع ميزات القروبات المتطورة');
}

const app = express();
app.get('/', (req, res) => { res.send('Teachers Bot is running! 🎓'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

const port = process.env.PORT || 3000;
const serverUrl = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + port);

app.listen(port, () => {
  console.log('✅ Port ' + port);
  setInterval(() => {
    const url = serverUrl + '/health';
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      console.log('🔄 Keep-alive: ' + res.statusCode);
    }).on('error', (e) => {
      console.log('⚠️ Keep-alive error: ' + e.message);
    });
  }, 14 * 60 * 1000);
});

initDB().then(() => startBot()).catch((e) => {
  console.error('خطأ:', e.message);
  process.exit(1);
});
