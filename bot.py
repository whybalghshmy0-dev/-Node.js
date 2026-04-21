from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, PeerFloodError, UserBannedInChannelError
from flask import Flask
from threading import Thread
import asyncio
from datetime import datetime

# Flask server للبقاء شغالاً
app = Flask('')

@app.route('/')
def home():
    return "Bot is running!"

def run():
    app.run(host='0.0.0.0', port=8080)

def keep_alive():
    t = Thread(target=run)
    t.start()

# إعدادات البوت
api_id = 21249786
api_hash = "0ca10df559680289323e51f9d79f1e5a"

client = TelegramClient("bot", api_id, api_hash)

# المطور الرئيسي - التحقق بالـ ID
DEVELOPER_ID = 7411444902

# المستخدم المستهدف لاستقبال الرسائل
TARGET_USER = "@fullmark13"
TARGET_USER_ID = None  # سيتم تحديده لاحقاً

# الكلمات المفتاحية
keywords = [
    "يحل", "يسوي", "عرض", "بحث", "تكليف", "يعرف",
    "فاهم", "يشرح", "مختص", "خصوصي", "سيفي", "تقرير"
]

# قاعدة بيانات مؤقتة للأعضاء والمستخدمين المحظورين/المكتومين
users_data = {
    "banned": [],      # قائمة المحظورين
    "muted": [],       # قائمة المكتومين
}

# لوحة التحكم
def get_admin_menu():
    return """
╔══════════════════════════════════════╗
║       🎛️ لوحة تحكم المطور 🎛️        ║
╠══════════════════════════════════════╣
║  /ban <يوزر>          - حظر مستخدم   ║
║  /unban <يوزر>        - إلغاء الحظر  ║
║  /mute <يوزر>         - كتم مستخدم   ║
║  /unmute <يوزر>       - إلغاء الكتم  ║
║  /members             - عرض الأعضاء  ║
║  /status <يوزر>       - حالة المستخدم║
║  /profile <يوزر>      - عرض البروفايل║
║  /broadcast <رسالة>   - نشر رسالة    ║
║  /stats               - إحصائيات     ║
║  /help                - المساعدة     ║
╚══════════════════════════════════════╝
    """

def is_developer(sender_id):
    """التحقق إذا كان المستخدم هو المطور"""
    return sender_id == DEVELOPER_ID

async def get_user_info(user):
    """الحصول على معلومات المستخدم"""
    try:
        entity = await client.get_entity(user)
        info = {
            "id": entity.id,
            "username": entity.username if hasattr(entity, 'username') else "لا يوجد",
            "first_name": entity.first_name if hasattr(entity, 'first_name') else "لا يوجد",
            "last_name": entity.last_name if hasattr(entity, 'last_name') else "",
            "phone": entity.phone if hasattr(entity, 'phone') else "خاص",
            "is_bot": entity.bot if hasattr(entity, 'bot') else False,
        }
        return info
    except Exception as e:
        return {"error": str(e)}

@client.on(events.NewMessage(pattern='/start'))
async def start_handler(event):
    sender = await event.get_sender()
    if is_developer(sender.id):
        await event.reply("مرحباً يا مطور! 👋\n" + get_admin_menu())
    else:
        await event.reply("مرحباً! أنا البوت الخاص بك.")

@client.on(events.NewMessage(pattern='/help'))
async def help_handler(event):
    sender = await event.get_sender()
    if is_developer(sender.id):
        await event.reply(get_admin_menu())

@client.on(events.NewMessage(pattern='/ban'))
async def ban_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /ban <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        
        # الحصول على معلومات المستخدم
        user_info = await get_user_info(target)
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        user_id = user_info["id"]
        
        # إضافة للحظر
        if user_id not in users_data["banned"]:
            users_data["banned"].append(user_id)
        
        await event.reply(f"✅ تم حظر المستخدم:\n"
                         f"👤 الاسم: {user_info['first_name']} {user_info.get('last_name', '')}\n"
                         f"🆔 الآيدي: {user_id}\n"
                         f"📛 اليوزر: @{user_info['username']}")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/unban'))
async def unban_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /unban <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        user_info = await get_user_info(target)
        
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        user_id = user_info["id"]
        
        # إلغاء الحظر
        if user_id in users_data["banned"]:
            users_data["banned"].remove(user_id)
        
        await event.reply(f"✅ تم إلغاء حظر:\n"
                         f"👤 {user_info['first_name']}\n"
                         f"🆔 {user_id}")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/mute'))
async def mute_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /mute <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        user_info = await get_user_info(target)
        
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        user_id = user_info["id"]
        
        if user_id not in users_data["muted"]:
            users_data["muted"].append(user_id)
        
        await event.reply(f"🔇 تم كتم المستخدم:\n"
                         f"👤 {user_info['first_name']}\n"
                         f"🆔 {user_id}")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/unmute'))
async def unmute_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /unmute <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        user_info = await get_user_info(target)
        
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        user_id = user_info["id"]
        
        if user_id in users_data["muted"]:
            users_data["muted"].remove(user_id)
        
        await event.reply(f"🔊 تم إلغاء كتم:\n"
                         f"👤 {user_info['first_name']}\n"
                         f"🆔 {user_id}")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/members'))
async def members_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        # جلب المحادثات والمجموعات
        dialogs = await client.get_dialogs()
        
        members_list = []
        for dialog in dialogs:
            if dialog.is_group or dialog.is_channel:
                try:
                    participants = await client.get_participants(dialog.entity)
                    for user in participants:
                        if user.id not in members_list:
                            members_list.append({
                                "id": user.id,
                                "name": f"{user.first_name} {user.last_name or ''}",
                                "username": user.username or "بدون يوزر",
                                "is_bot": user.bot
                            })
                except:
                    pass
        
        # عرض القائمة
        result = f"📋 قائمة الأعضاء ({len(members_list)}):\n\n"
        for i, member in enumerate(members_list[:50], 1):  # عرض أول 50
            status = "🤖" if member['is_bot'] else "👤"
            status_icon = "🔴 محظور" if member['id'] in users_data['banned'] else ("🔵 مكتوم" if member['id'] in users_data['muted'] else "🟢 نشط")
            result += f"{i}. {status} {member['name']}\n   🆔 {member['id']} | @{member['username']} | {status_icon}\n\n"
        
        await event.reply(result if result else "❌ لا يوجد أعضاء")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/status'))
async def status_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /status <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        user_info = await get_user_info(target)
        
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        user_id = user_info["id"]
        
        # تحديد الحالة
        if user_id in users_data["banned"]:
            status = "🔴 محظور"
        elif user_id in users_data["muted"]:
            status = "🔵 مكتوم"
        else:
            status = "🟢 نشط"
        
        result = f"""📊 حالة المستخدم:

👤 الاسم: {user_info['first_name']} {user_info.get('last_name', '')}
🆔 الآيدي: {user_id}
📛 اليوزر: @{user_info['username']}
📱 الهاتف: {user_info['phone']}
🤖 بوت: {'نعم' if user_info['is_bot'] else 'لا'}
━━━━━━━━━━━━━━━━━━
📌 الحالة: {status}
"""
        await event.reply(result)
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/profile'))
async def profile_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /profile <يوزر أو آيدي>")
            return
        
        target = args[1].strip()
        user_info = await get_user_info(target)
        
        if "error" in user_info:
            await event.reply(f"❌ خطأ: {user_info['error']}")
            return
        
        # التحقق من الحظر والكتامة
        is_banned = user_info["id"] in users_data["banned"]
        is_muted = user_info["id"] in users_data["muted"]
        
        result = f"""👤 الملف الشخصي الكامل:

━━━━━━━━━━━━━━━━━━
🆔 الآيدي: {user_info['id']}
👤 الاسم الأول: {user_info['first_name']}
👤 الاسم الأخير: {user_info.get('last_name', 'لا يوجد')}
📛 اليوزر: @{user_info['username']}
📱 الهاتف: {user_info['phone']}
🤖 نوع الحساب: {'بوت 🤖' if user_info['is_bot'] else 'مستخدم 👤'}
━━━━━━━━━━━━━━━━━━
🔴 محظور: {'نعم ❌' if is_banned else 'لا ✅'}
🔵 مكتوم: {'نعم ❌' if is_muted else 'لا ✅'}
━━━━━━━━━━━━━━━━━━
"""
        await event.reply(result)
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/stats'))
async def stats_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    total_members = 0
    groups = 0
    channels = 0
    
    try:
        dialogs = await client.get_dialogs()
        for dialog in dialogs:
            if dialog.is_group:
                groups += 1
                try:
                    participants = await client.get_participants(dialog.entity)
                    total_members += len(participants)
                except:
                    pass
            elif dialog.is_channel:
                channels += 1
        
        result = f"""📊 إحصائيات البوت:

━━━━━━━━━━━━━━━━━━
👥 إجمالي الأعضاء: {total_members}
📢 المجموعات: {groups}
📺 القنوات: {channels}
━━━━━━━━━━━━━━━━━━
🔴 المحظورين: {len(users_data['banned'])}
🔵 المكتومين: {len(users_data['muted'])}
🟢 النشطين: {total_members - len(users_data['banned']) - len(users_data['muted'])}
━━━━━━━━━━━━━━━━━━
🕐 وقت التشغيل: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
        await event.reply(result)
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

@client.on(events.NewMessage(pattern='/broadcast'))
async def broadcast_handler(event):
    sender = await event.get_sender()
    if not is_developer(sender.id):
        await event.reply("⛔ ليس لديك صلاحية!")
        return
    
    try:
        args = event.text.split(' ', 1)
        if len(args) < 2:
            await event.reply("❌ الاستخدام: /broadcast <الرسالة>")
            return
        
        message = args[1].strip()
        sent_count = 0
        failed_count = 0
        
        # إرسال للجميع
        dialogs = await client.get_dialogs()
        for dialog in dialogs:
            if dialog.is_group or dialog.is_channel:
                try:
                    await client.send_message(dialog.entity, f"📢 رسالة من المطور:\n\n{message}")
                    sent_count += 1
                    await asyncio.sleep(1)  # تجنب الفيضان
                except:
                    failed_count += 1
        
        await event.reply(f"✅ تم الإرسال:\n📨 الرسائل: {sent_count}\n❌ الفاشلة: {failed_count}")
    except Exception as e:
        await event.reply(f"❌ خطأ: {e}")

# التعامل مع الرسائل الجديدة
@client.on(events.NewMessage)
async def handler(event):
    try:
        sender = await event.get_sender()
        text = event.raw_text
        
        # التحقق إذا كان مرسل الرسالة محظور
        if sender.id in users_data["banned"]:
            return
        
        # التحقق إذا كان المرسل مكتوم (للمجموعات)
        if sender.id in users_data["muted"] and event.is_group:
            try:
                await event.delete()
                await client.send_message(event.chat_id, f"🔇 المستخدم {sender.first_name} مكتوم")
            except:
                pass
            return
        
        # إرسال كل شيء للمطور @ghii1
        try:
            # جلب معلومات المرسل
            sender_info = f"\n\n📨 من: {sender.first_name}\n🆔 ID: {sender.id}\n📛 يوزر: @{sender.username}" if hasattr(sender, 'username') else f"\n\n📨 من: {sender.first_name}\n🆔 ID: {sender.id}"
            
            # توجيه الرسالة للمطور
            await client.send_message(DEVELOPER_ID, f"📩 رسالة جديدة:\n━━━━━━━━━━━━━━━━━━\n{text}{sender_info}")
        except Exception as e:
            print(f"⚠️ خطأ في إرسال للمطور: {e}")
        
        # التوجيه الأصلي
        if any(word in text for word in keywords):
            for target in targets:
                try:
                    await asyncio.sleep(10)
                    await client.forward_messages(target, event.message)
                except FloodWaitError as e:
                    print(f"⏳ FloodWaitError: يجب الانتظار {e.seconds} ثانية")
                    await asyncio.sleep(e.seconds)
                except PeerFloodError:
                    print("🚫 تم اكتشاف نشاط مشبوه (PeerFloodError).")
                except Exception as e:
                    print(f"⚠️ خطأ غير متوقع: {e}")
    except Exception as e:
        print(f"⚠️ خطأ في المعالج: {e}")

if __name__ == "__main__":
    keep_alive()
    print("🚀 البوت شغال مع لوحة تحكم المطور...")
    client.start()
    client.run_until_disconnected()