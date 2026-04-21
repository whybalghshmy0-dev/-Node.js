"""
بوت تيليجرام متكامل للمراقبة والتحكم
المطور: 7411444902
"""

from telethon import TelegramClient, events, functions
from telethon.errors import FloodWaitError, PeerFloodError, UserBlockedError
from telethon.tl.types import User, Channel, Chat, UserStatusOnline, UserStatusOffline
from flask import Flask
from threading import Thread
import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

# ==================== الإعدادات ====================
app = Flask('')

# إعدادات API
API_ID = 21249786
API_HASH = "0ca10df559680289323e51f9d79f1e5a"

# المطور الأساسي
DEVELOPER_ID = 7411444902

# المجلدات
BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# ملفات البيانات
USERS_FILE = DATA_DIR / "users.json"
GROUPS_FILE = DATA_DIR / "groups.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
LOGS_FILE = DATA_DIR / "logs.json"

# ==================== نظام البيانات ====================
def load_json(file_path):
    """تحميل بيانات من ملف JSON"""
    try:
        if file_path.exists():
            with open(file_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {} if 'settings' not in str(file_path) else {"watched_users": [], "auto_forward": True, "verified_users": []}
    except Exception as e:
        print(f"خطأ في تحميل {file_path}: {e}")
        return {} if 'settings' not in str(file_path) else {"watched_users": [], "auto_forward": True, "verified_users": []}

def save_json(file_path, data):
    """حفظ بيانات إلى ملف JSON"""
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"خطأ في حفظ {file_path}: {e}")
        return False

# تحميل البيانات
users_data = load_json(USERS_FILE)
groups_data = load_json(GROUPS_FILE)
settings = load_json(SETTINGS_FILE)

# إعدادات افتراضية
if 'watched_users' not in settings:
    settings['watched_users'] = []
if 'auto_forward' not in settings:
    settings['auto_forward'] = True
if 'verified_users' not in settings:
    settings['verified_users'] = []
if 'bot_started' not in settings:
    settings['bot_started'] = False

save_json(SETTINGS_FILE, settings)

# ==================== Flask Server ====================
@app.route('/')
def home():
    return "🤖 البوت يعمل!"

def run():
    app.run(host='0.0.0.0', port=8080)

def keep_alive():
    t = Thread(target=run)
    t.daemon = True
    t.start()

# ==================== تيليجرام ====================
client = TelegramClient("bot", API_ID, API_HASH)

# القروب المستهدف للإرسال
TARGETS = ["@fullmark13"]

# الكلمات المفتاحية
KEYWORDS = [
    "يحل", "يسوي", "عرض", "بحث", "تكليف", "يعرف",
    "فاهم", "يشرح", "مختص", "خصوصي", "سيفي", "تقرير"
]

# ==================== أوامر التحكم ====================
def is_developer(user_id):
    """التحقق إذا كان المستخدم هو المطور"""
    return user_id == DEVELOPER_ID

def is_watched_user(user_id):
    """التحقق إذا كان المستخدم مراقب"""
    return str(user_id) in settings.get('watched_users', [])

def is_verified(user_id):
    """التحقق إذا كان المستخدم موثق"""
    return str(user_id) in settings.get('verified_users', []) or is_developer(user_id)

async def send_to_dev(message, from_user=None):
    """إرسال رسالة للمطور"""
    try:
        msg = f"📩 رسالة من "
        if from_user:
            msg += f"@{from_user.username}" if from_user.username else from_user.first_name
            msg += f" (ID: {from_user.id})"
        else:
            msg += "نظام البوت"
        msg += f"\n\n{message}"
        await client.send_message(DEVELOPER_ID, msg)
    except Exception as e:
        print(f"خطأ في إرسال للمطور: {e}")

async def forward_to_targets(message, source_name=""):
    """إرسال الرسائل للأهداف"""
    for target in TARGETS:
        try:
            await asyncio.sleep(10)
            await client.forward_messages(target, message)
            print(f"✅ تم توجيه رسالة من {source_name} إلى {target}")
        except FloodWaitError as e:
            print(f"⏳ FloodWaitError: انتظار {e.seconds} ثانية")
            await asyncio.sleep(e.seconds)
        except PeerFloodError:
            print("🚫 PeerFloodError - انتظار...")
        except Exception as e:
            print(f"⚠️ خطأ: {e}")

async def get_chat_members(chat):
    """جلب معلومات الأعضاء"""
    try:
        participants = await client.get_participants(chat)
        return participants
    except Exception as e:
        print(f"خطأ في جلب الأعضاء: {e}")
        return []

def get_member_status(member):
    """الحصول على حالة العضو (متصل/غير متصل)"""
    if hasattr(member, 'status'):
        if isinstance(member.status, UserStatusOnline):
            return "🟢 متصل"
        elif isinstance(member.status, UserStatusOffline):
            return "⚫ غير متصل"
    return "❓ غير معروف"

def build_control_menu():
    """بناء قائمة التحكم"""
    menu = """
╔══════════════════════════════╗
║   🎛 لوحة تحكم المطور    ║
╠══════════════════════════════╣
║                              ║
║  📊 أوامر عامة:              ║
║  /start - بدء البوت          ║
║  /status - حالة البوت        ║
║  /help - المساعدة           ║
║                              ║
║  👥 إدارة المستخدمين:        ║
║  /adduser [ID] - إضافة      ║
║  /removeuser [ID] - حذف     ║
║  /listusers - عرض المضافين  ║
║  /userinfo [ID] - معلومات   ║
║                              ║
║  🚫 الحظر والإدارة:         ║
║  /ban [ID] - حظر            ║
║  /unban [ID] - إلغاء الحظر ║
║  /banned - عرض المحظورين   ║
║                              ║
║  📱 معلومات المستخدمين:      ║
║  /online - المتصلين الآن    ║
║  /offline - غير المتصلين    ║
║  /members [رابط القروب]     ║
║                              ║
║  👥 إدارة القروبات:         ║
║  /addgroup - إضافة قروب    ║
║  /removegroup - حذف         ║
║  /listgroups - عرض القروبات║
║                              ║
║  🔧 الإعدادات:              ║
║  /watch - تفعيل المراقبة   ║
║  /unwatch - إيقاف المراقبة  ║
║  /settings - عرض الإعدادات ║
║                              ║
║  📋 السجلات:                ║
║  /stats - الإحصائيات        ║
║  /logs [عدد] - عرض السجلات ║
║  /broadcast [نص] - رسالة   ║
║                              ║
╚══════════════════════════════╝
    """
    return menu.strip()

def build_verification_menu():
    """قائمة التحقق"""
    return """
🔐 نظام التحقق

مرحباً! هذا البوت خاص بالمطور.

للوصول إلى لوحة التحكم، يرجى الانتظار للموافقة.

أرسل /verify [رمز التحقق] للمتابعة.
    """

@client.on(events.NewMessage)
async def handler(event):
    """معالج الرسائل الرئيسي"""
    try:
        sender = await event.get_sender()
        chat = await event.get_chat()

        text = event.raw_text.strip() if event.raw_text else ""

        user_id = sender.id if sender else 0
        username = sender.username if sender else "بدون يوزر"
        first_name = sender.first_name if sender else "مستخدم"

        # تسجيل الرسالة
        log_entry = {
            "time": datetime.now().isoformat(),
            "user_id": user_id,
            "username": username,
            "first_name": first_name,
            "chat_id": chat.id if chat else 0,
            "chat_title": chat.title if hasattr(chat, 'title') else str(chat),
            "message": text[:200] if text else "[وسائط]"
        }
        logs = load_json(LOGS_FILE)
        if 'messages' not in logs:
            logs['messages'] = []
        logs['messages'].append(log_entry)
        # الاحتفاظ بآخر 1000 رسالة
        if len(logs['messages']) > 1000:
            logs['messages'] = logs['messages'][-1000:]
        save_json(LOGS_FILE, logs)

        # ==================== نظام التحقق ====================
        if not is_developer(user_id) and str(user_id) not in settings.get('verified_users', []):
            if text.startswith('/verify '):
                # نظام التحقق - يمكن تطويره لاحقاً
                await event.reply("🔐 جاري التحقق...")
                settings['verified_users'].append(str(user_id))
                save_json(SETTINGS_FILE, settings)
                await event.reply("✅ تم التحقق بنجاح!")
            elif text.startswith('/start') or text == "/start":
                await event.reply(build_verification_menu())
            return

        # ==================== تحكم المطور ====================
        if is_developer(user_id):

            if text.startswith('/start') or text == "/start":
                await event.reply(f"""
🎉 مرحباً بك في لوحة تحكم البوت!

👤 المطور: {DEVELOPER_ID}

{build_control_menu()}
                """)
                return

            elif text.startswith('/help') or text == "/help":
                await event.reply(build_control_menu())
                return

            elif text.startswith('/status'):
                watched = settings.get('watched_users', [])
                verified = settings.get('verified_users', [])
                await event.reply(f"""
📊 حالة البوت:
━━━━━━━━━━━━━━━━━
🟢 الوضع: يعمل
👥 المراقبون: {len(watched)} مستخدم
✅ الموثقون: {len(verified)} مستخدم
📢 التوجيه التلقائي: {'مفعل' if settings.get('auto_forward') else 'معطل'}
━━━━━━━━━━━━━━━━━
⏰ وقت التشغيل: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
                """)
                return

            # ==================== إدارة المستخدمين ====================
            elif text.startswith('/adduser '):
                try:
                    target_id = text.split()[1].strip()
                    if target_id.isdigit():
                        target_id = int(target_id)
                    if str(target_id) not in settings['watched_users']:
                        settings['watched_users'].append(str(target_id))
                        save_json(SETTINGS_FILE, settings)
                        await event.reply(f"✅ تم إضافة المستخدم {target_id} للمراقبة")
                        await send_to_dev(f"➕ تم إضافة مستخدم جديد للمراقبة: {target_id}", sender)
                    else:
                        await event.reply("⚠️ المستخدم موجود مسبقاً")
                except (IndexError, ValueError):
                    await event.reply("❌ الصيغة: /adduser [ID]\nمثال: /adduser 123456789")
                return

            elif text.startswith('/removeuser '):
                try:
                    target_id = text.split()[1].strip()
                    if target_id in settings['watched_users']:
                        settings['watched_users'].remove(target_id)
                        save_json(SETTINGS_FILE, settings)
                        await event.reply(f"✅ تم حذف المستخدم {target_id}")
                        await send_to_dev(f"➖ تم حذف مستخدم من المراقبة: {target_id}", sender)
                    else:
                        await event.reply("⚠️ المستخدم غير موجود")
                except IndexError:
                    await event.reply("❌ الصيغة: /removeuser [ID]")
                return

            elif text == '/listusers':
                watched = settings.get('watched_users', [])
                if watched:
                    msg = "👥 المستخدمون المراقبون:\n━━━━━━━━━━━━━━━━━\n"
                    for i, uid in enumerate(watched, 1):
                        msg += f"{i}. `{uid}`\n"
                    msg += f"━━━━━━━━━━━━━━━━━\n📊 المجموع: {len(watched)} مستخدم"
                    await event.reply(msg)
                else:
                    await event.reply("📭 لا يوجد مستخدمون مراقبون")
                return

            elif text.startswith('/userinfo '):
                try:
                    target_id = int(text.split()[1])
                    try:
                        user = await client.get_entity(target_id)
                        info = f"""
👤 معلومات المستخدم:
━━━━━━━━━━━━━━━━━
🆔 الآيدي: {user.id}
📛 الاسم: {user.first_name}
👤 اليوزر: {'@' + user.username if user.username else 'غير موجود'}
━━━━━━━━━━━━━━━━━
📊 الحالة: {'محظور' if user.restricted else 'نشط'}
🔒 مراقب: {'نعم' if str(target_id) in settings.get('watched_users', []) else 'لا'}
                        """
                        await event.reply(info)
                    except:
                        await event.reply(f"❌ لا يمكن العثور على المستخدم: {target_id}")
                except (IndexError, ValueError):
                    await event.reply("❌ الصيغة: /userinfo [ID]")
                return

            # ==================== الحظر والإدارة ====================
            elif text.startswith('/ban '):
                try:
                    target_id = int(text.split()[1])
                    try:
                        await client(functions.contacts.BlockRequest(id=target_id))
                        await event.reply(f"🚫 تم حظر المستخدم {target_id}")
                        await send_to_dev(f"🚫 تم حظر المستخدم: {target_id}", sender)
                    except Exception as e:
                        await event.reply(f"❌ فشل الحظر: {str(e)}")
                except (IndexError, ValueError):
                    await event.reply("❌ الصيغة: /ban [ID]")
                return

            elif text.startswith('/unban '):
                try:
                    target_id = int(text.split()[1])
                    try:
                        await client(functions.contacts.UnblockRequest(id=target_id))
                        await event.reply(f"✅ تم إلغاء حظر المستخدم {target_id}")
                        await send_to_dev(f"✅ تم إلغاء الحظر: {target_id}", sender)
                    except Exception as e:
                        await event.reply(f"❌ فشل إلغاء الحظر: {str(e)}")
                except (IndexError, ValueError):
                    await event.reply("❌ الصيغة: /unban [ID]")
                return

            elif text == '/banned':
                try:
                    blocked = await client(functions.contacts.GetBlockedRequest(0, 100))
                    if blocked.users:
                        msg = "🚫 المستخدمون المحظورون:\n━━━━━━━━━━━━━━━━━\n"
                        for user in blocked.users:
                            msg += f"• {user.first_name} (ID: {user.id})\n"
                        await event.reply(msg)
                    else:
                        await event.reply("✅ لا يوجد مستخدمون محظورون")
                except Exception as e:
                    await event.reply(f"❌ خطأ: {str(e)}")
                return

            # ==================== معلومات المستخدمين ====================
            elif text == '/online':
                # جلب جميع المحادثات والبحث عن المتصلين
                dialogs = await client.get_dialogs()
                online_count = 0
                online_users = []

                for dialog in dialogs:
                    if dialog.is_user:
                        user = dialog.entity
                        if hasattr(user, 'status') and isinstance(user.status, UserStatusOnline):
                            online_count += 1
                            online_users.append(user)

                if online_users:
                    msg = f"🟢 المتصلون الآن ({online_count}):\n━━━━━━━━━━━━━━━━━\n"
                    for user in online_users[:20]:  # عرض أول 20
                        msg += f"• {user.first_name} (ID: {user.id})\n"
                    if online_count > 20:
                        msg += f"\n... و {online_count - 20} آخرون"
                    await event.reply(msg)
                else:
                    await event.reply("⚫ لا يوجد مستخدمون متصلون حالياً")
                return

            elif text == '/offline':
                dialogs = await client.get_dialogs()
                offline_count = 0
                offline_users = []

                for dialog in dialogs:
                    if dialog.is_user:
                        user = dialog.entity
                        if hasattr(user, 'status'):
                            if isinstance(user.status, UserStatusOffline):
                                offline_count += 1
                                offline_users.append((user, user.status.was_online if hasattr(user.status, 'was_online') else None))

                if offline_users:
                    msg = f"⚫ غير المتصلين ({offline_count}):\n━━━━━━━━━━━━━━━━━\n"
                    for user, last_seen in offline_users[:20]:
                        last = f"آخر ظهور: {last_seen}" if last_seen else ""
                        msg += f"• {user.first_name} (ID: {user.id}) {last}\n"
                    if offline_count > 20:
                        msg += f"\n... و {offline_count - 20} آخرون"
                    await event.reply(msg)
                else:
                    await event.reply("❓ لا يمكن تحديد حالة المستخدمين")
                return

            elif text.startswith('/members '):
                try:
                    group_link = text.split()[1]
                    try:
                        chat_entity = await client.get_entity(group_link)
                        if hasattr(chat_entity, 'title'):
                            participants = await client.get_participants(chat_entity)
                            total = len(participants)

                            online = 0
                            offline = 0
                            members_list = []

                            for p in participants:
                                status = get_member_status(p)
                                if "متصل" in status:
                                    online += 1
                                else:
                                    offline += 1
                                members_list.append({
                                    'name': p.first_name,
                                    'id': p.id,
                                    'username': p.username,
                                    'status': status
                                })

                            msg = f"""
👥 أعضاء القروب: {chat_entity.title}
━━━━━━━━━━━━━━━━━
📊 المجموع: {total}
🟢 متصل: {online}
⚫ غير متصل: {offline}
━━━━━━━━━━━━━━━━━

"""
                            # عرض أول 30 عضو
                            for m in members_list[:30]:
                                uname = f"@{m['username']}" if m['username'] else ""
                                msg += f"{m['status']} {m['name']} {uname}\n"

                            if total > 30:
                                msg += f"\n... و {total - 30} عضو آخر"

                            await event.reply(msg)
                        else:
                            await event.reply("❌ هذا ليس قروباً")
                    except Exception as e:
                        await event.reply(f"❌ لا يمكن الوصول للقروب: {str(e)}")
                except IndexError:
                    await event.reply("❌ الصيغة: /members [رابط القروب]")
                return

            # ==================== إدارة القروبات ====================
            elif text == '/addgroup':
                await event.reply("📎 أرسل رابط القروب لإضافته للمراقبة:\n\nمثال: /addgroup https://t.me/joinchat/...")
                settings['waiting_for_group'] = True
                save_json(SETTINGS_FILE, settings)
                return

            elif text == '/removegroup':
                groups = groups_data.get('groups', [])
                if groups:
                    msg = "🗑 اختر القروب للحذف:\n\n"
                    for i, g in enumerate(groups, 1):
                        msg += f"{i}. {g}\n"
                    msg += "\nاستخدم /removegroup [رقم]"
                    await event.reply(msg)
                else:
                    await event.reply("📭 لا توجد قروبات مضافة")
                return

            elif text.startswith('/removegroup '):
                try:
                    idx = int(text.split()[1]) - 1
                    groups = groups_data.get('groups', [])
                    if 0 <= idx < len(groups):
                        removed = groups.pop(idx)
                        groups_data['groups'] = groups
                        save_json(GROUPS_FILE, groups_data)
                        await event.reply(f"✅ تم حذف القروب: {removed}")
                    else:
                        await event.reply("❌ رقم غير صحيح")
                except:
                    await event.reply("❌ الصيغة: /removegroup [رقم]")
                return

            elif text == '/listgroups':
                groups = groups_data.get('groups', [])
                if groups:
                    msg = "👥 القروبات المضافة:\n━━━━━━━━━━━━━━━━━\n"
                    for i, g in enumerate(groups, 1):
                        msg += f"{i}. {g}\n"
                    await event.reply(msg)
                else:
                    await event.reply("📭 لا توجد قروبات مضافة")
                return

            # ==================== الإعدادات ====================
            elif text == '/watch':
                settings['auto_forward'] = True
                save_json(SETTINGS_FILE, settings)
                await event.reply("✅ تم تفعيل المراقبة والتوجيه التلقائي")
                return

            elif text == '/unwatch':
                settings['auto_forward'] = False
                save_json(SETTINGS_FILE, settings)
                await event.reply("⛔ تم إيقاف المراقبة والتوجيه")
                return

            elif text == '/settings':
                watched = settings.get('watched_users', [])
                verified = settings.get('verified_users', [])
                await event.reply(f"""
⚙️ الإعدادات الحالية:
━━━━━━━━━━━━━━━━━
📢 التوجيه التلقائي: {'🟢 مفعل' if settings.get('auto_forward') else '🔴 معطل'}
👥 عدد المراقبين: {len(watched)}
✅ عدد الموثقين: {len(verified)}
👥 عدد القروبات: {len(groups_data.get('groups', []))}
━━━━━━━━━━━━━━━━━
🎯 الأهدات: {', '.join(TARGETS)}
🔑 الكلمات: {len(KEYWORDS)} كلمة
                """)
                return

            # ==================== السجلات ====================
            elif text == '/stats':
                logs = load_json(LOGS_FILE)
                msgs = logs.get('messages', [])
                watched = settings.get('watched_users', [])
                await event.reply(f"""
📈 الإحصائيات:
━━━━━━━━━━━━━━━━━
📨 إجمالي الرسائل: {len(msgs)}
👥 المستخدمون المراقبون: {len(watched)}
📅 آخر رسالة: {msgs[-1]['time'][:19] if msgs else 'لا يوجد'}
🔄 الجلسات: 1
━━━━━━━━━━━━━━━━━
⏰ وقت الطلب: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
                """)
                return

            elif text.startswith('/logs'):
                logs = load_json(LOGS_FILE)
                msgs = logs.get('messages', [])
                try:
                    count = int(text.split()[1]) if len(text.split()) > 1 else 10
                    count = min(count, 50)  # الحد الأقصى 50
                except:
                    count = 10

                if msgs:
                    recent = msgs[-count:]
                    msg = f"📋 آخر {len(recent)} رسائل:\n━━━━━━━━━━━━━━━━━\n"
                    for m in recent:
                        time_str = m['time'][11:19]
                        uname = m.get('username', '?')
                        message = m.get('message', '[وسائط]')[:60]
                        msg += f"[{time_str}] @{uname}: {message}...\n"
                    await event.reply(msg)
                else:
                    await event.reply("📭 لا توجد سجلات")
                return

            elif text.startswith('/broadcast '):
                broadcast_text = text[11:]
                if not broadcast_text:
                    await event.reply("❌ يرجى كتابة النص بعد /broadcast")
                    return

                sent = 0
                for uid in settings.get('watched_users', []):
                    try:
                        await client.send_message(int(uid), f"📢 رسالة من المطور:\n\n{broadcast_text}")
                        sent += 1
                        await asyncio.sleep(1)  # تجنب الفلود
                    except Exception as e:
                        print(f"فشل إرسال لـ {uid}: {e}")

                await event.reply(f"✅ تم إرسال الرسالة لـ {sent} مستخدم")
                return

        # ==================== توجيه المراقبين ====================
        # المراقبون يوصل لهم كل الرسائل
        if is_watched_user(user_id):
            # توجيه الرسائل التي تحتوي على كلمات مفتاحية
            if any(word in text for word in KEYWORDS):
                await forward_to_targets(event.message, first_name)

            # أو يمكن توجيه كل الرسائل
            # await client.forward_messages(DEVELOPER_ID, event.message)

    except FloodWaitError as e:
        print(f"⏳ FloodWaitError: انتظار {e.seconds} ثانية")
        await asyncio.sleep(e.seconds)
    except PeerFloodError:
        print("🚫 PeerFloodError - انتظار...")
        await asyncio.sleep(60)
    except Exception as e:
        print(f"خطأ في المعالج: {e}")

async def on_start():
    """عند بدء البوت"""
    print("🚀 جاري بدء البوت...")

    try:
        # إرسال رسالة ترحيب للمطور
        await client.send_message(
            DEVELOPER_ID,
            """
🤖 تم تشغيل البوت بنجاح!

━━━━━━━━━━━━━━━━━
🎛 لوحة التحكم متاحة الآن.

📋 الأوامر المتاحة:
• /start - بدء البوت
• /help - المساعدة
• /status - حالة البوت

━━━━━━━━━━━━━━━━━
⏰ وقت التشغيل: """ + datetime.now().strftime('%Y-%m-%d %H:%M:%S') + """
        """
        )
        print("✅ تم إرسال رسالة الترحيب للمطور")

        # تحديث حالة البوت
        settings['bot_started'] = True
        save_json(SETTINGS_FILE, settings)

        # جلب القروبات والتواصلات
        dialogs = await client.get_dialogs()
        print(f"📊 عدد المحادثات: {len(dialogs)}")

        # تسجيل القروبات
        groups = []
        for dialog in dialogs:
            if dialog.is_group or dialog.is_channel:
                chat = dialog.entity
                if hasattr(chat, 'title'):
                    groups.append(chat.title)
                    print(f"  📌 {chat.title}")

        # حفظ القروبات
        groups_data['groups'] = groups
        save_json(GROUPS_FILE, groups_data)

    except Exception as e:
        print(f"خطأ في بدء البوت: {e}")

@client.on(events.EventsHandler)
async def on_connect(event):
    """عند الاتصال"""
    print("✅ تم الاتصال بتيليجرام")

if __name__ == "__main__":
    keep_alive()
    print("🚀 البوت يعمل...")

    # تشغيل معالج البدء
    loop = asyncio.get_event_loop()
    loop.run_until_complete(on_start())

    client.start()
    client.run_until_disconnected()