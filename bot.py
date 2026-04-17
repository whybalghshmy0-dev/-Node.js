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

# ==================== الإعدادات ====================
TOKEN = "7630845149:AAGwRUURpAA4ZqQhMH7W1wz6IV4iDaRN4Kw"
DEVELOPER_ID = 7411444902
DATABASE_PATH = "storage_bot.db"

GOOGLE_DRIVE_ENABLED = True
GOOGLE_CREDENTIALS_FILE = "credentials.json"
DRIVE_FOLDER_ID = None

DEEPSEEK_API_KEY = "sk-8eccb5b5c3804d3585a2472936e74f19"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
AI_ENABLED = True

API_PORT = 8080

logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

# ==================== الخدمات الخارجية ====================
ai_client = None
if AI_ENABLED:
    try:
        ai_client = openai.OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
    except:
        pass

drive_service = None
if GOOGLE_DRIVE_ENABLED:
    try:
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_CREDENTIALS_FILE, scopes=['https://www.googleapis.com/auth/drive.file']
        )
        drive_service = build('drive', 'v3', credentials=credentials, static_discovery=False)
    except:
        pass

# ==================== قاعدة البيانات ====================
async def init_db():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                parent_id INTEGER,
                FOREIGN KEY(parent_id) REFERENCES categories(id)
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
        await db.execute("""
            CREATE TABLE IF NOT EXISTS admins (
                user_id INTEGER PRIMARY KEY,
                added_by INTEGER,
                FOREIGN KEY(user_id) REFERENCES users(user_id)
            )
        """)
        await db.commit()

async def get_categories(parent_id=None):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        if parent_id is None:
            cursor = await db.execute("SELECT id, name FROM categories WHERE parent_id IS NULL ORDER BY id")
        else:
            cursor = await db.execute("SELECT id, name FROM categories WHERE parent_id = ? ORDER BY id", (parent_id,))
        return await cursor.fetchall()

async def get_category_name_by_id(cat_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT name FROM categories WHERE id = ?", (cat_id,))
        row = await cursor.fetchone()
        return row[0] if row else None

async def get_category_id_by_name(name: str):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT id FROM categories WHERE name = ?", (name,))
        row = await cursor.fetchone()
        return row[0] if row else None

# ==================== صلاحيات ====================
def is_developer(update: Update) -> bool:
    return update.effective_user.id == DEVELOPER_ID

async def is_admin(user_id: int) -> bool:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT 1 FROM admins WHERE user_id = ?", (user_id,))
        return await cursor.fetchone() is not None

async def save_user(update: Update):
    user = update.effective_user
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO users (user_id, username, first_name) VALUES (?, ?, ?)",
            (user.id, user.username, user.first_name)
        )
        await db.commit()

# ==================== لوحات المفاتيح ====================
def dev_reply_keyboard():
    return ReplyKeyboardMarkup([
        [KeyboardButton("📂 الخانات"), KeyboardButton("📥 عرض محتوى خانة")],
        [KeyboardButton("➕ إضافة محتوى")],
        [KeyboardButton("🏗️ إنشاء خانة"), KeyboardButton("🗑️ حذف خانة")],
        [KeyboardButton("🧹 حذف عنصر"), KeyboardButton("📢 بث للجميع")],
        [KeyboardButton("👤 إضافة أدمن"), KeyboardButton("❌ إلغاء/رجوع")]
    ], resize_keyboard=True)

def user_reply_keyboard():
    return ReplyKeyboardMarkup([
        [KeyboardButton("📂 الخانات"), KeyboardButton("📥 عرض محتوى خانة")],
        [KeyboardButton("❌ إلغاء/رجوع")]
    ], resize_keyboard=True)

async def get_categories_keyboard(parent_id=None):
    cats = await get_categories(parent_id)
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"cat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="cancel")])
    return InlineKeyboardMarkup(keyboard)

async def get_viewcategory_keyboard():
    cats = await get_categories()
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"viewcat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="ui_cancel")])
    return InlineKeyboardMarkup(keyboard)

async def get_deletecategory_keyboard():
    cats = await get_categories()
    if not cats:
        return InlineKeyboardMarkup([[InlineKeyboardButton("لا توجد خانات", callback_data="noop")]])
    keyboard = [[InlineKeyboardButton(name, callback_data=f"delcat_{id}")] for id, name in cats]
    keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="ui_cancel")])
    return InlineKeyboardMarkup(keyback)

# ==================== أوامر أساسية ====================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await save_user(update)
    kb = dev_reply_keyboard() if (is_developer(update) or await is_admin(update.effective_user.id)) else user_reply_keyboard()
    await update.message.reply_text("🤖 مرحباً! اختر من الأزرار أدناه:", reply_markup=kb)

async def categories(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات حالياً.")
        return
    text = "📂 الخانات المتاحة:\n" + "\n".join(f"▫️ {name}" for _, name in cats)
    await update.message.reply_text(text)

# ==================== محادثة الإضافة ====================
WAITING_FOR_CATEGORY, WAITING_FOR_CONTENT = range(2)

async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not (is_developer(update) or await is_admin(user.id)):
        await update.message.reply_text("❌ هذا الخيار للمطوّر أو الأدمن فقط.")
        return ConversationHandler.END
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات. أنشئ خانة أولاً.")
        return ConversationHandler.END
    keyboard = await get_categories_keyboard()
    await update.message.reply_text("🗂️ اختر الخانة لإضافة المحتوى:", reply_markup=keyboard)
    return WAITING_FOR_CATEGORY

async def category_chosen(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if query.data == "cancel":
        await query.edit_message_text("❌ تم الإلغاء.")
        return ConversationHandler.END
    try:
        cat_id = int(query.data.split("_")[1])
        context.user_data["temp_category_id"] = cat_id
        cat_name = await get_category_name_by_id(cat_id)
        await query.edit_message_text(f"📥 الآن أرسل المحتوى إلى '{cat_name}' (نص، صورة، فيديو، ملف، صوت، أو /cancel للإلغاء):")
        return WAITING_FOR_CONTENT
    except Exception as e:
        logger.error(f"خطأ في اختيار الخانة: {e}")
        await query.edit_message_text("❌ حدث خطأ.")
        return ConversationHandler.END

async def receive_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
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

        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute(
                "INSERT INTO items (category_id, type, content, file_id, drive_link, ai_summary) VALUES (?, ?, ?, ?, ?, ?)",
                (cat_id, content_type, content_text, file_id, drive_link, ai_summary)
            )
            await db.commit()

        await update.message.reply_text("✅ تم تخزين المحتوى بنجاح." + (f"\n🧠 ملخص AI: {ai_summary}" if ai_summary else ""))
        return WAITING_FOR_CONTENT
    except Exception as e:
        logger.error(f"خطأ في حفظ المحتوى: {e}")
        await update.message.reply_text("❌ حدث خطأ أثناء الحفظ.")
        return WAITING_FOR_CONTENT

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ تم إلغاء العملية.")
    context.user_data.pop("temp_category_id", None)
    return ConversationHandler.END

# ==================== أزرار ReplyKeyboard ====================
async def ui_reply_keyboard(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    is_dev = is_developer(update)
    is_adm = await is_admin(user.id)

    if not (is_dev or is_adm):
        kb = user_reply_keyboard()
    else:
        kb = dev_reply_keyboard()

    txt = (update.message.text or "").strip()

    if txt == "📂 الخانات":
        await categories(update, context)
    elif txt == "📥 عرض محتوى خانة":
        keyboard = await get_viewcategory_keyboard()
        await update.message.reply_text("📥 اختر خانة:", reply_markup=keyboard)
    elif txt == "➕ إضافة محتوى":
        return await add_start(update, context)
    elif txt == "❌ إلغاء/رجوع":
        await update.message.reply_text("تم الإلغاء.", reply_markup=kb)
    elif txt == "🏗️ إنشاء خانة" and (is_dev or is_adm):
        await update.message.reply_text("أرسل اسم الخانة الجديدة:")
        context.user_data["pending"] = "newcat"
    elif txt == "🗑️ حذف خانة" and (is_dev or is_adm):
        keyboard = await get_deletecategory_keyboard()
        await update.message.reply_text("اختر الخانة لحذفها:", reply_markup=keyboard)
    elif txt == "🧹 حذف عنصر" and (is_dev or is_adm):
        await update.message.reply_text("أرسل رقم العنصر (ID):")
        context.user_data["pending"] = "delitem"
    elif txt == "📢 بث للجميع" and (is_dev or is_adm):
        await update.message.reply_text("أرسل رسالة البث:")
        context.user_data["pending"] = "broadcast"
    elif txt == "👤 إضافة أدمن" and is_dev:
        await update.message.reply_text("أرسل آيدي المستخدم لإضافته كأدمن:")
        context.user_data["pending"] = "addadmin"

async def ui_text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not (is_developer(update) or await is_admin(user.id)):
        return
    pending = context.user_data.get("pending")
    text = update.message.text.strip()
    if pending == "newcat":
        try:
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute("INSERT INTO categories (name) VALUES (?)", (text,))
                await db.commit()
            await update.message.reply_text(f"✅ تم إنشاء الخانة: {text}")
        except sqlite3.IntegrityError:
            await update.message.reply_text("❌ الخانة موجودة مسبقاً.")
        context.user_data.pop("pending", None)
    elif pending == "delitem":
        if text.isdigit():
            async with aiosqlite.connect(DATABASE_PATH) as db:
                await db.execute("DELETE FROM items WHERE id = ?", (int(text),))
                await db.commit()
            await update.message.reply_text(f"🗑️ تم حذف العنصر رقم {text}")
        else:
            await update.message.reply_text("❌ أرسل رقماً صحيحاً.")
        context.user_data.pop("pending", None)
    elif pending == "broadcast":
        async with aiosqlite.connect(DATABASE_PATH) as db:
            cursor = await db.execute("SELECT user_id FROM users")
            users = await cursor.fetchall()
        success = 0
        for (user_id,) in users:
            try:
                await context.bot.send_message(chat_id=user_id, text=f"📢 {text}")
                success += 1
            except:
                pass
        await update.message.reply_text(f"✅ تم الإرسال إلى {success} مستخدم.")
        context.user_data.pop("pending", None)
    elif pending == "addadmin":
        if text.isdigit():
            try:
                async with aiosqlite.connect(DATABASE_PATH) as db:
                    await db.execute("INSERT OR IGNORE INTO admins (user_id, added_by) VALUES (?, ?)", (int(text), update.effective_user.id))
                    await db.commit()
                await update.message.reply_text(f"✅ تم إضافة الأدمن بنجاح.")
            except:
                await update.message.reply_text("❌ حدث خطأ أو المستخدم موجود.")
        else:
            await update.message.reply_text("❌ أرسل آيدي رقمي صحيح.")
        context.user_data.pop("pending", None)

# ==================== معالجات الأزرار Inline ====================
async def ui_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data == "noop":
        await query.edit_message_text("⚠️ لا توجد خانات.")
        return

    if data == "ui_cancel":
        await query.edit_message_text("❌ تم الإلغاء.")
        return

    if data.startswith("viewcat_"):
        cat_id = int(data.split("_")[1])
        cat_name = await get_category_name_by_id(cat_id)
        async with aiosqlite.connect(DATABASE_PATH) as db:
            cursor = await db.execute("SELECT id, type, content, file_id, ai_summary FROM items WHERE category_id=? ORDER BY id", (cat_id,))
            items = await cursor.fetchall()
        if not items:
            await query.edit_message_text(f"📭 الخانة '{cat_name}' فارغة.")
            return
        await query.edit_message_text(f"📦 محتويات '{cat_name}' ({len(items)} عنصر):")
        for item_id, item_type, text, file_id, ai_summary in items:
            caption = text or ""
            if ai_summary:
                caption += f"\n\n🧠 *ملخص AI:* {ai_summary}"
            try:
                if item_type == "text":
                    await query.message.reply_text(f"📝 {text}\n(🆔 {item_id})")
                elif file_id:
                    method = {
                        "photo": query.message.reply_photo,
                        "video": query.message.reply_video,
                        "document": query.message.reply_document,
                        "audio": query.message.reply_audio,
                        "voice": query.message.reply_voice,
                        "video_note": query.message.reply_video_note
                    }.get(item_type)
                    if method:
                        await method(media=file_id, caption=f"{caption}\n(🆔 {item_id})")
                    else:
                        await query.message.reply_text(f"⚠️ عنصر {item_id} غير معروف.")
            except Exception as e:
                logger.error(f"خطأ في إرسال العنصر: {e}")

    elif data.startswith("delcat_"):
        user = update.effective_user
        if not (is_developer(update) or await is_admin(user.id)):
            await query.edit_message_text("❌ هذا الخيار للمطوّر أو الأدمن فقط.")
            return
        cat_id = int(data.split("_")[1])
        cat_name = await get_category_name_by_id(cat_id)
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute("DELETE FROM items WHERE category_id = ?", (cat_id,))
            await db.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
            await db.commit()
        await query.edit_message_text(f"🗑️ تم حذف الخانة '{cat_name}' ومحتوياتها.")

# ==================== التشغيل ====================
def main():
    app = Application.builder().token(TOKEN).build()

    # ConversationHandler
    conv_handler = ConversationHandler(
        entry_points=[
            CommandHandler("add", add_start),
            MessageHandler(filters.Regex("^➕ إضافة محتوى$"), add_start)
        ],
        states={
            WAITING_FOR_CATEGORY: [CallbackQueryHandler(category_chosen, pattern="^(cat_|cancel)$")],
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

    # الأوامر
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("categories", categories))
    app.add_handler(CommandHandler("cancel", cancel))

    # الأزرار Inline
    app.add_handler(CallbackQueryHandler(ui_callback, pattern="^(viewcat_|delcat_|ui_cancel|noop)"))

    # الرسائل النصية
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, ui_text_handler), group=1)
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, ui_reply_keyboard), group=2)

    # التهيئة
    async def post_init(application: Application):
        await init_db()
        logger.info("✅ البوت جاهز!")

    app.post_init = post_init
    logger.info("🤖 جاري تشغيل البوت...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()