import asyncio
import logging
import sqlite3
import aiosqlite
from aiohttp import web
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
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
    ai_client = openai.OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
else:
    ai_client = None

# تهيئة Google Drive (اختياري)
drive_service = None
if GOOGLE_DRIVE_ENABLED:
    try:
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_CREDENTIALS_FILE, scopes=['https://www.googleapis.com/auth/drive.file']
        )
        drive_service = build('drive', 'v3', credentials=credentials)
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
        cursor = await db.execute("SELECT id, name FROM categories")
        return await cursor.fetchall()

async def get_category_id_by_name(name: str):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT id FROM categories WHERE name = ?", (name,))
        row = await cursor.fetchone()
        return row[0] if row else None

# ==================== دوال المساعدة ====================
def is_developer(update: Update) -> bool:
    return update.effective_user.id == DEVELOPER_ID

async def save_user(update: Update):
    user = update.effective_user
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT OR IGNORE INTO users (user_id, username, first_name) VALUES (?, ?, ?)",
            (user.id, user.username, user.first_name)
        )
        await db.commit()

async def get_categories_keyboard():
    cats = await get_categories()
    keyboard = [[InlineKeyboardButton(name, callback_data=f"cat_{id}")] for id, name in cats]
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

# ==================== أوامر البوت ====================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await save_user(update)
    await update.message.reply_text(
        "🤖 **أهلاً بك في بوت التخزين الذكي!**\n\n"
        "📌 الأوامر العامة:\n"
        "/categories - عرض الخانات المتاحة\n"
        "/view <اسم الخانة> - عرض محتويات خانة\n\n"
        "🛠️ أوامر المطور:\n"
        "/newcategory <الاسم> - إنشاء خانة جديدة\n"
        "/add - إضافة محتوى\n"
        "/deletecategory <الاسم> - حذف خانة\n"
        "/deleteitem <id> - حذف عنصر\n"
        "/broadcast <رسالة> - إرسال للجميع\n\n"
        "🧠 مميزات جنونية:\n"
        "- رفع تلقائي لـ Google Drive (للملفات الكبيرة)\n"
        "- تلخيص AI للمحتوى النصي"
    )

async def categories(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات حالياً.")
        return
    text = "📂 **الخانات المتاحة:**\n" + "\n".join(f"▫️ {name}" for _, name in cats)
    await update.message.reply_text(text, parse_mode="Markdown")

async def new_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /newcategory <اسم الخانة>")
        return
    name = " ".join(context.args).strip()
    try:
        async with aiosqlite.connect(DATABASE_PATH) as db:
            await db.execute("INSERT INTO categories (name) VALUES (?)", (name,))
            await db.commit()
        await update.message.reply_text(f"✅ تم إنشاء الخانة: {name}")
    except sqlite3.IntegrityError:
        await update.message.reply_text("❌ الخانة موجودة مسبقاً.")

async def delete_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /deletecategory <اسم الخانة>")
        return
    name = " ".join(context.args).strip()
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
        return
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("📛 استخدم: /deleteitem <رقم_العنصر>")
        return
    item_id = int(context.args[0])
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM items WHERE id = ?", (item_id,))
        await db.commit()
    await update.message.reply_text(f"🗑️ تم حذف العنصر رقم {item_id}.")

# ==================== نظام الإضافة المحسّن ====================
async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return ConversationHandler.END
    cats = await get_categories()
    if not cats:
        await update.message.reply_text("⚠️ لا توجد خانات. أنشئ خانة أولاً بـ /newcategory")
        return ConversationHandler.END
    keyboard = await get_categories_keyboard()
    keyboard.inline_keyboard.append([InlineKeyboardButton("❌ إلغاء", callback_data="cancel")])
    await update.message.reply_text("🗂️ اختر الخانة:", reply_markup=keyboard)
    return WAITING_FOR_CATEGORY

async def category_chosen(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if query.data == "cancel":
        await query.edit_message_text("❌ تم الإلغاء.")
        return ConversationHandler.END
    cat_id = int(query.data.split("_")[1])
    context.user_data["temp_category_id"] = cat_id
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT name FROM categories WHERE id=?", (cat_id,))
        row = await cursor.fetchone()
        cat_name = row[0]
    await query.edit_message_text(
        f"📥 الآن أرسل المحتوى إلى **{cat_name}**\n"
        "(نص، صورة، ملف، فيديو... أو /cancel للإلغاء)"
    )
    return WAITING_FOR_CONTENT

async def receive_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    cat_id = context.user_data.get("temp_category_id")
    if not cat_id:
        await update.message.reply_text("⚠️ لم يتم اختيار خانة. استخدم /add أولاً.")
        return ConversationHandler.END

    msg = update.message
    content_type = "text"
    content_text = ""
    file_id = None
    drive_link = None
    ai_summary = ""

    # معالجة النص
    if msg.text:
        content_type = "text"
        content_text = msg.text
        if AI_ENABLED and len(content_text) > 200:
            ai_summary = await summarize_text(content_text)

    # معالجة الميديا
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
    else:
        await update.message.reply_text("❌ نوع المحتوى غير مدعوم.")
        return WAITING_FOR_CONTENT

    # التحقق من الحجم ورفع الملفات الكبيرة إلى Google Drive
    if drive_service and file_id and content_type in ("document", "video"):
        file_obj = await context.bot.get_file(file_id)
        file_size = file_obj.file_size
        if file_size > 20 * 1024 * 1024:  # أكبر من 20MB
            # تنزيل مؤقت ورفع إلى Drive
            with tempfile.NamedTemporaryFile(delete=False) as tmp:
                await file_obj.download_to_drive(tmp.name)
                drive_link = await upload_to_drive(tmp.name, file_obj.file_path.split('/')[-1])
                os.unlink(tmp.name)
            if drive_link:
                file_id = None  # لن نعتمد على file_id بعد الآن
                content_text = f"{content_text}\n\n📎 رابط Google Drive: {drive_link}"
            else:
                await update.message.reply_text("⚠️ تعذر الرفع إلى Drive، سيتم الاعتماد على تخزين تيليجرام.")

    # حفظ في قاعدة البيانات
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO items (category_id, type, content, file_id, drive_link, ai_summary) VALUES (?, ?, ?, ?, ?, ?)",
            (cat_id, content_type, content_text, file_id, drive_link, ai_summary)
        )
        await db.commit()

    await update.message.reply_text("✅ تم تخزين المحتوى بنجاح." + (f"\n🧠 ملخص AI: {ai_summary}" if ai_summary else ""))
    context.user_data.pop("temp_category_id", None)
    return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ تم إلغاء العملية.")
    context.user_data.pop("temp_category_id", None)
    return ConversationHandler.END

# ==================== عرض المحتوى ====================
async def view_category(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("📛 استخدم: /view <اسم الخانة>")
        return
    cat_name = " ".join(context.args).strip()
    cat_id = await get_category_id_by_name(cat_name)
    if not cat_id:
        await update.message.reply_text("❌ الخانة غير موجودة.")
        return

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT id, type, content, file_id, drive_link, ai_summary FROM items WHERE category_id=? ORDER BY id",
            (cat_id,)
        )
        items = await cursor.fetchall()

    if not items:
        await update.message.reply_text(f"📭 الخانة '{cat_name}' فارغة حالياً.")
        return

    await update.message.reply_text(f"📦 محتويات **{cat_name}** ({len(items)} عنصر):")
    for item_id, item_type, text, file_id, drive_link, ai_summary in items:
        caption = text or ""
        if ai_summary:
            caption += f"\n\n🧠 *ملخص AI:* {ai_summary}"

        if item_type == "text":
            await update.message.reply_text(f"📝 {text}\n\n(🆔 {item_id})")
        elif drive_link:
            await update.message.reply_text(f"🔗 [رابط الملف على Drive]({drive_link})\n{caption}", parse_mode="Markdown")
        elif file_id:
            send_method = {
                "photo": update.message.reply_photo,
                "video": update.message.reply_video,
                "document": update.message.reply_document,
                "audio": update.message.reply_audio,
                "voice": update.message.reply_voice,
            }.get(item_type)
            if send_method:
                await send_method(media=file_id, caption=f"{caption}\n(🆔 {item_id})")
        else:
            await update.message.reply_text(f"⚠️ عنصر {item_id} غير متاح.")

# ==================== نظام البث ====================
async def broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    if not context.args:
        await update.message.reply_text("📛 استخدم: /broadcast <الرسالة>")
        return
    message = " ".join(context.args)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("SELECT user_id FROM users")
        users = await cursor.fetchall()
    success = 0
    for (user_id,) in users:
        try:
            await context.bot.send_message(chat_id=user_id, text=f"📢 {message}")
            success += 1
        except:
            continue
    await update.message.reply_text(f"✅ تم الإرسال إلى {success} مستخدم.")

# ==================== API داخلي (HTTP) ====================
async def api_categories(request):
    cats = await get_categories()
    return web.json_response([{"id": c[0], "name": c[1]} for c in cats])

async def api_items(request):
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
    data = [{"id": i[0], "type": i[1], "content": i[2], "drive_link": i[4], "ai_summary": i[5]} for i in items]
    return web.json_response(data)

async def run_api():
    app = web.Application()
    app.router.add_get('/api/categories', api_categories)
    app.router.add_get('/api/items/{category}', api_items)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', API_PORT)
    await site.start()
    logger.info(f"🌐 API يعمل على المنفذ {API_PORT}")

# ==================== التشغيل الرئيسي ====================
async def main():
    await init_db()
    
    # تشغيل API في الخلفية
    asyncio.create_task(run_api())
    
    app = Application.builder().token(TOKEN).build()
    
    # أوامر عامة
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("categories", categories))
    app.add_handler(CommandHandler("view", view_category))
    
    # أوامر المطور
    app.add_handler(CommandHandler("newcategory", new_category))
    app.add_handler(CommandHandler("deletecategory", delete_category))
    app.add_handler(CommandHandler("deleteitem", delete_item))
    app.add_handler(CommandHandler("broadcast", broadcast))
    
    # محادثة الإضافة (مصححة)
    conv_handler = ConversationHandler(
        entry_points=[CommandHandler("add", add_start)],
        states={
            WAITING_FOR_CATEGORY: [CallbackQueryHandler(category_chosen, pattern="^(cat_|cancel)")],
            WAITING_FOR_CONTENT: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, receive_content),
                MessageHandler(filters.PHOTO | filters.VIDEO | filters.Document.AUDIO | filters.Document.VIDEO | filters.VOICE, receive_content),
                CommandHandler("cancel", cancel)
            ]
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    app.add_handler(conv_handler)
    
    logger.info("🤖 البوت يعمل الآن...")
    await app.run_polling()

if __name__ == "__main__":
    asyncio.run(main())