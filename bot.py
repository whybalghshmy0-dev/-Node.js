import asyncio
import logging
import sqlite3
import aiosqlite
from aiohttp import web
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardMarkup,
    KeyboardButton
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    ConversationHandler, filters, ContextTypes
)
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
import openai
import os
import tempfile
import re

# ==================== إعدادات النظام ====================
TOKEN = "7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw"
DEVELOPER_ID = 7411444902
DATABASE_PATH = "storage_bot.db"

# إعدادات Google Drive (ضع ملف credentials.json في نفس المجلد)
GOOGLE_DRIVE_ENABLED = True
GOOGLE_CREDENTIALS_FILE = "credentials.json"
DRIVE_FOLDER_ID = None  # اتركه فارغًا للرفع في root

# إعدادات DeepSeek AI
DEEPSEEK_API_KEY = "sk-8eccb5b5c3804d3585a2472936e74f19"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
AI_ENABLED = True

# إعدادات API الداخلي
API_PORT = 8080

# ==================== التهيئة الأساسية ====================
logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

# تهيئة OpenAI Client لـ DeepSeek
if AI_ENABLED:
    try:
        ai_client = openai.OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
        logger.info("✅ تم تهيئة DeepSeek AI بنجاح")
    except Exception as e:
        logger.error(f"❌ فشل تهيئة DeepSeek: {e}")
        ai_client = None
else:
    ai_client = None

# تهيئة Google Drive (اختياري)
drive_service = None
if GOOGLE_DRIVE_ENABLED:
    try:
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_CREDENTIALS_FILE, scopes=['https://www.googleapis.com/auth/drive.file']
        )
        drive_service = build('drive', 'v3', credentials=credentials, static_discovery=False)
        logger.info("✅ تم الاتصال بـ Google Drive بنجاح")
    except Exception as e:
        logger.warning(f"⚠️ تعذر الاتصال بـ Google Drive: {e}")
        drive_service = None

# ==================== حالات المحادثة ====================
WAITING_FOR_CATEGORY, WAITING_FOR_CONTENT = range(2)

# ==================== دوال قاعدة البيانات (غير متزامنة) ====================
async def init_db():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                file_id TEXT,
                drive_link TEXT,
                ai_summary TEXT,
                FOREIGN KEY (category_id) REFERENCES categories (id)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()

async def get_categories():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT id, name FROM categories ORDER BY id")
        return await cursor.fetchall()

async def get_category_id_by_name(name: str):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT id FROM categories WHERE name = ?", (name,))
        row = await cursor.fetchone()
        return row[0] if row else None

async def get_category_name_by_id(cat_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT name FROM categories WHERE id = ?", (cat_id,))
        row = await cursor.fetchone()
        return row[0] if row else None

# ==================== دوال المساعدة ====================
def is_developer(update: Update) -> bool:
    return update.effective_user.id == DEVELOPER_ID

async def save_user(update: Update):
    user = update.effective_user
    try:
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT OR IGNORE INTO users (user_id, username, first_name) VALUES (?, ?, ?)",
                (user.id, user.username, user.first_name)
            )
            await db.commit()
    except Exception as e:
        logger.error(f"خطأ في حفظ المستخدم: {e}")

def dev_reply_keyboard():
    buttons = [
        [KeyboardButton("📂 الخانات"), KeyboardButton("📥 عرض محتوى خانة")],
        [KeyboardButton("➕ إضافة محتوى")],
        [KeyboardButton("🏗️ إنشاء خانة"), KeyboardButton("🗑️ حذف خانة")],
        [KeyboardButton("🧹 حذف عنصر"), KeyboardButton("📢 بث للجميع")],
        [KeyboardButton("❌ إلغاء/رجوع")]
    ]
    return ReplyKeyboardMarkup(buttons, resize_keyboard=True, selective=True)

def user_reply_keyboard():
    buttons = [
        [KeyboardButton("📂 الخانات"), KeyboardButton("📥 عرض محتوى خانة")],
        [KeyboardButton("❌ إلغاء/رجوع")]
    ]
    return ReplyKeyboardMarkup(buttons, resize_keyboard=True, selective=True)

async def get_categories_keyboard():
    cats = await get_categories()
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"cat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="cancel")])
    return InlineKeyboardMarkup(keyboard)

async def get_deletecategory_keyboard():
    cats = await get_categories()
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"delcat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="ui_cancel")])
    return InlineKeyboardMarkup(keyboard)

async def get_viewcategory_keyboard():
    cats = await get_categories()
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"viewcat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="ui_cancel")])
    return InlineKeyboardMarkup(keyboard)

async def upload_to_drive(file_path, file_name):
    if not drive_service:
        return None
    try:
        file_metadata = {'name': file_name}
        if DRIVE_FOLDER_ID:
            file_metadata['parents'] = [DRIVE_FOLDER_ID]
        media = MediaFileUpload(file_path, resumable=True)
        file = drive_service.files().create(body=file_metadata, media_body=media, fields='id, webViewLink').execute()
        return file.get('webViewLink')
    except Exception as e:
        logger.error(f"خطأ في رفع الملف إلى Drive: {e}")
        return None

async def summarize_text(text: str) -> str:
    if not AI_ENABLED or not ai_client:
        return ""
    try:
        response = ai_client.chat.completions.create(
            model="deepseek-chat",
            messages=[{"role": "user", "content": f"لخص النص التالي في جملة واحدة بالعربية:\n{text}"}],
            max_tokens=100
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        logger.error(f"خطأ في التلخيص: {e}")
        return ""

# ==================== أوامر البوت الأساسية ====================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await save_user(update)
    
    if is_developer(update):
        await update.message.reply_text(
            "🤖 **مرحباً! لوحة المطوّر جاهزة**\n\n"
            "اختر ما تريد من الأزرار أدناه أو استخدم الأوامر الكتابية.\n",
            parse_mode="Markdown",
            reply_markup=dev_reply_keyboard()
        )
    else:
        await update.message.reply_text(
            "🤖 **مرحباً!**\n\n"
            "هذه لوحة المستخدم العادي.\n"
            "اختر من الأزرار أدناه:",
            reply_markup=user_reply_keyboard()
        )

async def categories(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات حالياً.")
        return
    text = "📂 **الخانات المتاحة:**\n\n" + "\n".join(f"▫️ {name}" for _, name in cats)
    await update.message.reply_text(text, parse_mode="Markdown")

async def view_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("📛 استخدم: /view <اسم الخانة>\nأو استخدم الزر 📥 عرض محتوى خانة")
        return
    
    cat_name = " ".join(context.args).strip()
    await show_category_content(update, context, cat_name)

async def show_category_content(update: Update, context: ContextTypes.DEFAULT_TYPE, cat_name: str, query=None):
    """عرض محتوى الخانة - يعمل للرسائل والاستعلامات"""
    cat_id = await get_category_id_by_name(cat_name)
    if not cat_id:
        if query:
            await query.edit_message_text("❌ الخانة غير موجودة.")
        else:
            await update.message.reply_text("❌ الخانة غير موجودة.")
        return

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT id, type, content, file_id, drive_link, ai_summary FROM items WHERE category_id=? ORDER BY id",
            (cat_id,)
        )
        items = await cursor.fetchall()

    target = query.message if query else update.message
    
    if not items:
        msg = f"📭 الخانة '{cat_name}' فارغة حالياً."
        if query:
            await query.edit_message_text(msg)
        else:
            await target.reply_text(msg)
        return

    # إرسال رسالة الترويسة
    header = f"📦 محتويات **{cat_name}** ({len(items)} عنصر):"
    if query:
        await query.edit_message_text(header, parse_mode="Markdown")
    else:
        await target.reply_text(header, parse_mode="Markdown")

    # إرسال المحتويات
    for item_id, item_type, text, file_id, drive_link, ai_summary in items:
        caption = text or ""
        if ai_summary:
            caption += f"\n\n🧠 *ملخص AI:* {ai_summary}"

        try:
            if item_type == "text":
                await target.reply_text(f"📝 {text}\n\n(🆔 {item_id})")
            elif drive_link:
                await target.reply_text(
                    f"🔗 [رابط الملف على Drive]({drive_link})\n{caption}\n\n(🆔 {item_id})",
                    parse_mode="Markdown"
                )
            elif file_id:
                send_method = {
                    "photo": target.reply_photo,
                    "video": target.reply_video,
                    "document": target.reply_document,
                    "audio": target.reply_audio,
                    "voice": target.reply_voice,
                }.get(item_type)
                if send_method:
                    await send_method(media=file_id, caption=f"{caption}\n(🆔 {item_id})")
                else:
                    await target.reply_text(f"⚠️ نوع غير معروف للعنصر {item_id}")
            else:
                await target.reply_text(f"⚠️ عنصر {item_id} غير متاح.")
        except Exception as e:
            logger.error(f"خطأ في إرسال العنصر {item_id}: {e}")
            await target.reply_text(f"⚠️ تعذر عرض العنصر {item_id}")

# ==================== أوامر المطوّر ====================
async def new_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        await update.message.reply_text("❌ هذا الأمر للمطوّر فقط.")
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /newcategory <اسم الخانة>")
        return
    name = " ".join(context.args).strip()
    try:
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute("INSERT INTO categories (name) VALUES (?)", (name,))
            await db.commit()
        await update.message.reply_text(f"✅ تم إنشاء الخانة: **{name}**", parse_mode="Markdown")
    except sqlite3.IntegrityError:
        await update.message.reply_text("❌ الخانة موجودة مسبقاً.")

async def delete_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        await update.message.reply_text("❌ هذا الأمر للمطوّر فقط.")
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /deletecategory <اسم الخانة>\nأو استخدم الزر 🗑️ حذف خانة")
        return
    name = " ".join(context.args).strip()
    await delete_category_by_name(update, context, name)

async def delete_category_by_name(update: Update, context: ContextTypes.DEFAULT_TYPE, name: str):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT id FROM categories WHERE name = ?", (name,))
        cat = await cursor.fetchone()
        if not cat:
            await update.message.reply_text("❌ الخانة غير موجودة.")
            return
        cat_id = cat[0]
        await db.execute("DELETE FROM items WHERE category_id = ?", (cat_id,))
        await db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        await db.commit()
    await update.message.reply_text(f"🗑️ تم حذف الخانة '{name}' ومحتوياتها.")

async def delete_item(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        await update.message.reply_text("❌ هذا الأمر للمطوّر فقط.")
        return
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("📛 استخدم: /deleteitem <رقم_العنصر>")
        return
    item_id = int(context.args[0])
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM items WHERE id = ?", (item_id,))
        await db.commit()
    await update.message.reply_text(f"🗑️ تم حذف العنصر رقم {item_id}.")

async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        await update.message.reply_text("❌ هذا الأمر للمطوّر فقط.")
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /broadcast <الرسالة>")
        return
    message = " ".join(context.args)
    await send_broadcast(update, context, message)

async def send_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE, message: str):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT user_id FROM users")
        users = await cursor.fetchall()
    
    success = 0
    failed = 0
    for (user_id,) in users:
        try:
            await context.bot.send_message(chat_id=user_id, text=f"📢 رسالة من المشرف:\n\n{message}")
            success += 1
        except Exception as e:
            failed += 1
            logger.error(f"فشل الإرسال للمستخدم {user_id}: {e}")
    
    await update.message.reply_text(f"✅ تم الإرسال إلى {success} مستخدم.\n❌ فشل الإرسال إلى {failed} مستخدم.")

# ==================== نظام الإضافة (Conversation) ====================
async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """بداية إضافة محتوى - يعمل للأمر /add وللزر"""
    if not is_developer(update):
        return ConversationHandler.END
    
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات. أنشئ خانة أولاً بـ /newcategory")
        return ConversationHandler.END
    
    keyboard = await get_categories_keyboard()
    await update.message.reply_text("🗂️ اختر الخانة لإضافة المحتوى:", reply_markup=keyboard)
    return WAITING_FOR_CATEGORY

async def category_chosen(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """معالجة اختيار الخانة"""
    query = update.callback_query
    await query.answer()
    
    if query.data == "cancel":
        await query.edit_message_text("❌ تم الإلغاء.")
        context.user_data.pop("temp_category_id", None)
        return ConversationHandler.END
    
    if query.data.startswith("cat_"):
        try:
            cat_id = int(query.data.split("_")[1])
            context.user_data["temp_category_id"] = cat_id
            cat_name = await get_category_name_by_id(cat_id)
            
            await query.edit_message_text(
                f"📥 الآن أرسل المحتوى إلى **{cat_name}**\n\n"
                f"يمكنك إرسال: نص، صورة، فيديو، ملف، صوت، أو رسالة صوتية.\n"
                f"أرسل /cancel للإلغاء.",
                parse_mode="Markdown"
            )
            return WAITING_FOR_CONTENT
        except Exception as e:
            logger.error(f"خطأ في اختيار الخانة: {e}")
            await query.edit_message_text("❌ حدث خطأ، حاول مرة أخرى.")
            return ConversationHandler.END
    
    return WAITING_FOR_CATEGORY

async def receive_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """استقبال المحتوى وحفظه"""
    if not is_developer(update):
        return ConversationHandler.END

    cat_id = context.user_data.get("temp_category_id")
    if not cat_id:
        await update.message.reply_text("⚠️ لم يتم اختيار خانة. ابدأ من جديد بـ /add")
        return ConversationHandler.END

    msg = update.message
    content_type = "text"
    content_text = ""
    file_id = None
    drive_link = None
    ai_summary = ""

    # معالجة أنواع المحتوى المختلفة
    try:
        if msg.text:
            content_type = "text"
            content_text = msg.text
            if AI_ENABLED and len(content_text) > 200:
                ai_summary = await summarize_text(content_text)

        elif msg.photo:
            content_type = "photo"
            file_id = msg.photo[-1].file_id
            content_text = msg.caption or ""
            if msg.caption and AI_ENABLED and len(msg.caption) > 200:
                ai_summary = await summarize_text(msg.caption)

        elif msg.video:
            content_type = "video"
            file_id = msg.video.file_id
            content_text = msg.caption or ""

        elif msg.document:
            content_type = "document"
            file_id = msg.document.file_id
            content_text = msg.caption or ""

        elif msg.audio:
            content_type = "audio"
            file_id = msg.audio.file_id
            content_text = msg.caption or ""

        elif msg.voice:
            content_type = "voice"
            file_id = msg.voice.file_id
            
        elif msg.video_note:
            content_type = "video_note"
            file_id = msg.video_note.file_id
            
        else:
            await update.message.reply_text("❌ نوع المحتوى غير مدعوم.")
            return WAITING_FOR_CONTENT

        # رفع الملفات الكبيرة إلى Google Drive
        if drive_service and file_id:
            try:
                file_obj = await context.bot.get_file(file_id)
                file_size = file_obj.file_size or 0
                
                if file_size > 20 * 1024 * 1024:  # أكبر من 20MB
                    await update.message.reply_text("⏳ جاري رفع الملف الكبير إلى Google Drive...")
                    
                    with tempfile.NamedTemporaryFile(delete=False) as tmp:
                        await file_obj.download_to_drive(tmp.name)
                        file_name = getattr(msg, content_type, None)
                        file_name = file_name.file_name if hasattr(file_name, 'file_name') else f"file_{file_id}"
                        drive_link = await upload_to_drive(tmp.name, file_name)
                        os.unlink(tmp.name)
                    
                    if drive_link:
                        file_id = None  # نستخدم الرابط بدلاً من file_id
                        content_text = f"{content_text}\n\n📎 رابط Drive: {drive_link}".strip()
                    else:
                        await update.message.reply_text("⚠️ تعذر الرفع إلى Drive، سيتم التخزين في تيليجرام فقط.")
            except Exception as e:
                logger.error(f"خطأ في معالجة الملف الكبير: {e}")

        # حفظ في قاعدة البيانات
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT INTO items (category_id, type, content, file_id, drive_link, ai_summary) VALUES (?, ?, ?, ?, ?, ?)",
                (cat_id, content_type, content_text, file_id, drive_link, ai_summary)
            )
            await db.commit()

        # تأكيد الحفظ
        confirm_msg = "✅ تم تخزين المحتوى بنجاح."
        if ai_summary:
            confirm_msg += f"\n\n🧠 ملخص AI:\n{ai_summary}"
        
        await update.message.reply_text(confirm_msg)
        
        # إعادة عرض لوحة التحكم
        await update.message.reply_text("يمكنك إرسال محتوى آخر أو /cancel للخروج.", reply_markup=dev_reply_keyboard())
        
        # البقاء في نفس الحالة للسماح بإضافة محتوى آخر
        return WAITING_FOR_CONTENT
        
    except Exception as e:
        logger.error(f"خطأ في حفظ المحتوى: {e}")
        await update.message.reply_text("❌ حدث خطأ أثناء الحفظ. حاول مرة أخرى.")
        return WAITING_FOR_CONTENT

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """إلغاء المحادثة"""
    await update.message.reply_text("❌ تم إلغاء العملية.", reply_markup=dev_reply_keyboard())
    context.user_data.pop("temp_category_id", None)
    return ConversationHandler.END

# ==================== معالجات الأزرار (UI) ====================
async def ui_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """معالج الأزرار Inline"""
    query = update.callback_query
    await query.answer()
    
    data = query.data

    # إلغاء عام
    if data in ("ui_cancel", "cancel", "noop"):
        if data == "noop":
            await query.edit_message_text("⚠️ لا توجد خانات متاحة.")
        else:
            try:
                await query.edit_message_text("❌ تم الإلغاء.")
            except:
                pass
        return

    # التحقق من المطور للأزرار الحساسة
    dev_only_buttons = ["ui_deletecategory_start", "ui_deleteitem_start", "ui_broadcast_start"]
    if data in dev_only_buttons and not is_developer(update):
        await query.edit_message_text("❌ هذا الخيار للمطوّر فقط.")
        return

    # عرض الخانات
    if data == "ui_categories":
        cats = await get_categories()
        if not cats:
            await query.edit_message_text("⚠️ لا توجد خانات حالياً.")
            return
        text = "📂 **الخانات المتاحة:**\n\n" + "\n".join(f"▫️ {name}" for _, name in cats)
        await query.edit_message_text(text, parse_mode="Markdown")
        return

    # اختيار خانة للعرض
    if data == "ui_view_pick":
        keyboard = await get_viewcategory_keyboard()
        await query.edit_message_text("📥 اختر خانة لعرض محتواها:", reply_markup=keyboard)
        return

    # حذف خانة - اختيار
    if data == "ui_deletecategory_start":
        keyboard = await get_deletecategory_keyboard()
        await query.edit_message_text("🗑️ اختر الخانة المراد حذفها:", reply_markup=keyboard)
        return

    # عرض محتوى خانة محددة
    if data.startswith("viewcat_"):
        try:
            cat_id = int(data.split("_")[1])
            cat_name = await get_category_name_by_id(cat_id)
            if cat_name:
                await show_category_content(update, context, cat_name, query)
            else:
                await query.edit_message_text("❌ الخانة غير موجودة.")
        except Exception as e:
            logger.error(f"خطأ في عرض الخانة: {e}")
            await query.edit_message_text("❌ حدث خطأ.")
        return

    # حذف خانة محددة
    if data.startswith("delcat_"):
        if not is_developer(update):
            await query.edit_message_text("❌ هذا الخيار للمطوّر فقط.")
            return
        try:
            cat_id = int(data.split("_")[1])
            cat_name = await get_category_name_by_id(cat_id)
            if cat_name:
                async with aiosqlite.connect(DATABASE_PATH) as db:
                    await db.execute("DELETE FROM items WHERE category_id = ?", (cat_id,))
                    await db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
                    await db.commit()
                await query.edit_message_text(f"🗑️ تم حذف الخانة '{cat_name}' ومحتوياتها.")
            else:
                await query.edit_message_text("❌ الخانة غير موجودة.")
        except Exception as e:
            logger.error(f"خطأ في حذف الخانة: {e}")
            await query.edit_message_text("❌ حدث خطأ.")
        return

    # الأزرار التي تحتاج إدخال نصي لاحقاً
    if data == "ui_newcategory_start":
        await query.edit_message_text(
            "🏗️ أرسل اسم الخانة الجديدة مباشرة في رسالة:\n\n"
            "مثال: أخبار اليوم"
        )
        context.user_data["ui_pending"] = "newcategory"
        return

    if data == "ui_deleteitem_start":
        await query.edit_message_text("🧹 أرسل رقم العنصر (ID) المراد حذفه:")
        context.user_data["ui_pending"] = "deleteitem_id"
        return

    if data == "ui_broadcast_start":
        await query.edit_message_text("📢 أرسل رسالة البث للجميع:")
        context.user_data["ui_pending"] = "broadcast_text"
        return

    await query.edit_message_text("❓ خيار غير معروف.")

async def ui_reply_keyboard(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """معالج أزرار لوحة المفاتيح (Reply Keyboard)"""
    txt = (update.message.text or "").strip()
    
    # إلغاء العمليات المعلقة
    if txt in ("❌ إلغاء/رجوع", "إلغاء", "الغاء"):
        context.user_data.pop("ui_pending", None)
        await update.message.reply_text("❌ تم الإلغاء.", reply_markup=dev_reply_keyboard() if is_developer(update) else user_reply_keyboard())
        return

    # عرض الخانات
    if txt == "📂 الخانات":
        await categories(update, context)
        return

    # عرض محتوى خانة - إرسال أزرار Inline
    if txt == "📥 عرض محتوى خانة":
        keyboard = await get_viewcategory_keyboard()
        await update.message.reply_text("📥 اختر الخانة:", reply_markup=keyboard)
        return

    # إضافة محتوى - بدء Conversation
    if txt == "➕ إضافة محتوى":
        if not is_developer(update):
            await update.message.reply_text("❌ هذا الخيار للمطوّر فقط.")
            return
        return await add_start(update, context)  # <-- مهم: إرجاع حالة المحادثة

    # الأزرار الخاصة بالمطور فقط
    if not is_developer(update):
        return

    if txt == "🏗️ إنشاء خانة":
        await update.message.reply_text(
            "🏗️ أرسل اسم الخانة الجديدة:\n\nمثال: منتجات جديدة"
        )
        context.user_data["ui_pending"] = "newcategory"
        return

    if txt == "🗑️ حذف خانة":
        keyboard = await get_deletecategory_keyboard()
        await update.message.reply_text("🗑️ اختر الخانة المراد حذفها:", reply_markup=keyboard)
        return

    if txt == "🧹 حذف عنصر":
        await update.message.reply_text("🧹 أرسل رقم العنصر (ID) المراد حذفه:\n\nلمعرفة الـ ID، عرض محتوى الخانة أولاً.")
        context.user_data["ui_pending"] = "deleteitem_id"
        return

    if txt == "📢 بث للجميع":
        await update.message.reply_text("📢 أرسل رسالة البث الآن:")
        context.user_data["ui_pending"] = "broadcast_text"
        return

async def ui_text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """معالج الرسائل النصية (للعمليات المعلقة)"""
    if not is_developer(update):
        return
    
    pending = context.user_data.get("ui_pending")
    if not pending:
        return  # ليست رسالة موجهة للبوت
    
    text = (update.message.text or "").strip()
    
    # إلغاء
    if text.lower() in ("إلغاء", "cancel", "/cancel", "❌"):
        context.user_data.pop("ui_pending", None)
        await update.message.reply_text("❌ تم الإلغاء.", reply_markup=dev_reply_keyboard())
        return

    # إنشاء خانة
    if pending == "newcategory":
        if not text:
            await update.message.reply_text("📛 الاسم فارغ، أعد المحاولة:")
            return
        try:
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute("INSERT INTO categories (name) VALUES (?)", (text,))
                await db.commit()
            await update.message.reply_text(f"✅ تم إنشاء الخانة: **{text}**", parse_mode="Markdown", reply_markup=dev_reply_keyboard())
        except sqlite3.IntegrityError:
            await update.message.reply_text("❌ الخانة موجودة مسبقاً.", reply_markup=dev_reply_keyboard())
        context.user_data.pop("ui_pending", None)
        return

    # حذف عنصر
    if pending == "deleteitem_id":
        if not text.isdigit():
            await update.message.reply_text("📛 أرسل رقماً صحيحاً:");
            return
        item_id = int(text)
        try:
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute("DELETE FROM items WHERE id = ?", (item_id,))
                await db.commit()
            await update.message.reply_text(f"🗑️ تم حذف العنصر رقم {item_id}.", reply_markup=dev_reply_keyboard())
        except Exception as e:
            await update.message.reply_text("❌ حدث خطأ أثناء الحذف.")
        context.user_data.pop("ui_pending", None)
        return

    # بث للجميع
    if pending == "broadcast_text":
        await send_broadcast(update, context, text)
        context.user_data.pop("ui_pending", None)
        await update.message.reply_text("تم إرسال البث.", reply_markup=dev_reply_keyboard())
        return

# ==================== API داخلي ====================
async def api_categories(request):
    try:
        cats = await get_categories()
        return web.json_response([{"id": c[0], "name": c[1]} for c in cats])
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def api_items(request):
    try:
        cat_name = request.match_info.get('category')
        cat_id = await get_category_id_by_name(cat_name)
        if not cat_id:
            return web.json_response({"error": "Category not found"}, status=404)
        
        async with aiosqlite.connect(DATABASE_PATH) as db:
            cursor = await db.execute(
                "SELECT id, type, content, file_id, drive_link, ai_summary FROM items WHERE category_id=?",
                (cat_id,)
            )
            items = await cursor.fetchall()
        
        data = [{
            "id": i[0],
            "type": i[1],
            "content": i[2],
            "drive_link": i[4],
            "ai_summary": i[5]
        } for i in items]
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def run_api():
    try:
        app = web.Application()
        app.router.add_get('/api/categories', api_categories)
        app.router.add_get('/api/items/{category}', api_items)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', API_PORT)
        await site.start()
        logger.info(f"🌐 API يعمل على المنفذ {API_PORT}")
    except Exception as e:
        logger.error(f"❌ فشل تشغيل API: {e}")

# ==================== التشغيل الرئيسي ====================
def main():
    # إنشاء التطبيق
    app = Application.builder().token(TOKEN).build()

    # ===== Conversation Handler للإضافة =====
    # مهم: يجب أن يكون قبل MessageHandler العام
    conv_handler = ConversationHandler(
        entry_points=[
            CommandHandler("add", add_start),
            MessageHandler(filters.Regex("^➕ إضافة محتوى$") & filters.TEXT, add_start)
        ],
        states={
            WAITING_FOR_CATEGORY: [
                CallbackQueryHandler(category_chosen, pattern="^(cat_|cancel)$")
            ],
            WAITING_FOR_CONTENT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, receive_content),
                MessageHandler(filters.PHOTO, receive_content),
                MessageHandler(filters.VIDEO, receive_content),
                MessageHandler(filters.Document.ALL, receive_content),
                MessageHandler(filters.VOICE, receive_content),
                MessageHandler(filters.AUDIO, receive_content),
                MessageHandler(filters.VIDEO_NOTE, receive_content),
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel)],
        allow_reentry=True
    )
    app.add_handler(conv_handler)

    # ===== الأوامر الأساسية =====
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("categories", categories))
    app.add_handler(CommandHandler("view", view_category))
    app.add_handler(CommandHandler("newcategory", new_category))
    app.add_handler(CommandHandler("deletecategory", delete_category))
    app.add_handler(CommandHandler("deleteitem", delete_item))
    app.add_handler(CommandHandler("broadcast", broadcast))

    # ===== معالجات الأزرار (Callbacks) =====
    # يجب أن تكون قبل MessageHandler العام
    app.add_handler(CallbackQueryHandler(ui_callback, pattern="^(ui_|viewcat_|delcat_|cancel|noop)"))

    # ===== معالج الرسائل النصية =====
    # 1. معالج الأزرار المعلقة (pending) - يتحقق من context.user_data أولاً
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, ui_text_handler), group=1)
    # 2. معالج أزرار لوحة المفاتيح (ReplyKeyboard)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, ui_reply_keyboard), group=2)

    # ===== التهيئة =====
    async def post_init(application: Application):
        await init_db()
        asyncio.create_task(run_api())
        logger.info("✅ البوت جاهز للعمل!")

    app.post_init = post_init

    # ===== بدء التشغيل =====
    logger.info("🤖 جاري تشغيل البوت...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()