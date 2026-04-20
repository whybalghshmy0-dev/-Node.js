import asyncio
import logging
import sqlite3
import aiosqlite
import json
import os
import tempfile
import time
from datetime import datetime, timedelta
from aiohttp import web
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyKeyboardMarkup, KeyboardButton, BotCommand
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    ConversationHandler, filters, ContextTypes
)
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
import openai

# ==================== الإعدادات الرئيسية ====================

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

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ==================== حالات المحادثة ====================

(
    STATE_MAIN, STATE_BROWSE, STATE_SEARCH,
    STATE_ADD_CAT, STATE_ADD_ITEM, STATE_ADMIN_PANEL,
    STATE_USER_PROFILE, STATE_MANAGE_ADMINS,
    STATE_BROADCAST, STATE_PERMISSIONS
) = range(10)

# ==================== الخدمات الخارجية ====================

ai_client = None
if AI_ENABLED:
    try:
        ai_client = openai.OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
    except Exception as e:
        logger.error(f"AI init error: {e}")

drive_service = None
if GOOGLE_DRIVE_ENABLED:
    try:
        credentials = service_account.Credentials.from_service_account_file(
            GOOGLE_CREDENTIALS_FILE,
            scopes=['https://www.googleapis.com/auth/drive.file']
        )
        drive_service = build('drive', 'v3', credentials=credentials, static_discovery=False)
    except Exception as e:
        logger.error(f"Drive init error: {e}")

# ==================== قاعدة البيانات ====================

async def init_db():
    async with aiosqlite.connect(DATABASE_PATH) as db:
        # جدول التصنيفات
        await db.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                parent_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(parent_id) REFERENCES categories(id)
            )
        """)

        # جدول العناصر
        await db.execute("""
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                file_id TEXT,
                drive_link TEXT,
                ai_summary TEXT,
                added_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                views INTEGER DEFAULT 0,
                FOREIGN KEY(category_id) REFERENCES categories(id)
            )
        """)

        # جدول المستخدمين (موسّع)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                language_code TEXT,
                is_bot INTEGER DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_messages INTEGER DEFAULT 0,
                is_banned INTEGER DEFAULT 0,
                ban_reason TEXT,
                notes TEXT
            )
        """)

        # جدول المشرفين مع الصلاحيات
        await db.execute("""
            CREATE TABLE IF NOT EXISTS admins (
                user_id INTEGER PRIMARY KEY,
                added_by INTEGER,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                permissions TEXT DEFAULT '{}',
                FOREIGN KEY(user_id) REFERENCES users(user_id)
            )
        """)

        # جدول سجل نشاط المستخدمين
        await db.execute("""
            CREATE TABLE IF NOT EXISTS user_activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(user_id)
            )
        """)

        # جدول الاختيارات الأكثر شيوعاً
        await db.execute("""
            CREATE TABLE IF NOT EXISTS item_views (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(item_id) REFERENCES items(id)
            )
        """)

        # جدول الإحصائيات اليومية
        await db.execute("""
            CREATE TABLE IF NOT EXISTS daily_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                new_users INTEGER DEFAULT 0,
                active_users INTEGER DEFAULT 0,
                total_messages INTEGER DEFAULT 0,
                total_searches INTEGER DEFAULT 0
            )
        """)

        # جدول الرسائل المجدولة / البث
        await db.execute("""
            CREATE TABLE IF NOT EXISTS broadcasts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                sent_by INTEGER NOT NULL,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                recipients INTEGER DEFAULT 0
            )
        """)

        await db.commit()
    logger.info("✅ Database initialized successfully")

# ==================== دوال قاعدة البيانات ====================

async def register_user(user):
    """تسجيل أو تحديث بيانات المستخدم"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("""
            INSERT INTO users (user_id, username, first_name, last_name, language_code, is_bot, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                username = excluded.username,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                last_seen = CURRENT_TIMESTAMP,
                total_messages = total_messages + 1
        """, (
            user.id, user.username, user.first_name,
            user.last_name, user.language_code, int(user.is_bot)
        ))
        await db.commit()

async def log_activity(user_id: int, action: str, details: str = None):
    """تسجيل نشاط المستخدم"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)",
            (user_id, action, details)
        )
        await db.commit()

async def get_user_profile(user_id: int) -> dict:
    """الحصول على ملف المستخدم الكامل"""
    async with aiosqlite.connect(DATABASE_PATH) as db:
        # بيانات المستخدم الأساسية
        cursor = await db.execute(
            "SELECT * FROM users WHERE user_id = ?", (user_id,)
        )
        user_row = await cursor.fetchone()
        if not user_row:
            return None

        cols = [d[0] for d in cursor.description]
        user_data = dict(zip(cols, user_row))

        # إحصائيات النشاط
        cursor = await db.execute(
            "SELECT COUNT(*) FROM user_activity WHERE user_id = ?", (user_id,)
        )
        activity_count = (await cursor.fetchone())[0]

        # آخر 10 أنشطة
        cursor = await db.execute(
            "SELECT action, details, timestamp FROM user_activity WHERE user_id = ? ORDER BY timestamp DESC LIMIT 10",
            (user_id,)
        )
        recent_activity = await cursor.fetchall()

        # العناصر الأكثر مشاهدة
        cursor = await db.execute("""
            SELECT i.content, COUNT(*) as views
            FROM item_views iv
            JOIN items i ON iv.item_id = i.id
            WHERE iv.user_id = ?
            GROUP BY iv.item_id
            ORDER BY views DESC
            LIMIT 5
        """, (user_id,))
        top_items = await cursor.fetchall()

        # هل هو مشرف؟
        cursor = await db.execute(
            "SELECT permissions FROM admins WHERE user_id = ?", (user_id,)
        )
        admin_row = await cursor.fetchone()
        is_admin = admin_row is not None
        permissions = json.loads(admin_row[0]) if admin_row else {}

        return {
            **user_data,
            "activity_count": activity_count,
            "recent_activity": recent_activity,
            "top_items": top_items,
            "is_admin": is_admin,
            "permissions": permissions
        }

async def get_all_users() -> list:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT user_id, username, first_name, last_seen, total_messages, is_banned FROM users ORDER BY last_seen DESC"
        )
        return await cursor.fetchall()

async def get_bot_stats() -> dict:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        stats = {}

        cursor = await db.execute("SELECT COUNT(*) FROM users")
        stats['total_users'] = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM users WHERE is_banned = 0")
        stats['active_users'] = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM admins")
        stats['total_admins'] = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM items")
        stats['total_items'] = (await cursor.fetchone())[0]

        cursor = await db.execute("SELECT COUNT(*) FROM categories")
        stats['total_categories'] = (await cursor.fetchone())[0]

        cursor = await db.execute(
            "SELECT COUNT(*) FROM users WHERE last_seen >= datetime('now', '-1 day')"
        )
        stats['active_today'] = (await cursor.fetchone())[0]

        cursor = await db.execute(
            "SELECT COUNT(*) FROM users WHERE joined_at >= datetime('now', '-7 days')"
        )
        stats['new_this_week'] = (await cursor.fetchone())[0]

        # أكثر العناصر مشاهدة
        cursor = await db.execute("""
            SELECT i.content, COUNT(*) as views
            FROM item_views iv
            JOIN items i ON iv.item_id = i.id
            GROUP BY iv.item_id
            ORDER BY views DESC
            LIMIT 5
        """)
        stats['top_items'] = await cursor.fetchall()

        # أكثر التصنيفات شعبية
        cursor = await db.execute("""
            SELECT c.name, COUNT(iv.id) as views
            FROM item_views iv
            JOIN items i ON iv.item_id = i.id
            JOIN categories c ON i.category_id = c.id
            GROUP BY i.category_id
            ORDER BY views DESC
            LIMIT 5
        """)
        stats['top_categories'] = await cursor.fetchall()

        return stats

async def is_banned(user_id: int) -> bool:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT is_banned FROM users WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return row[0] == 1 if row else False

async def ban_user(user_id: int, reason: str = None):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE users SET is_banned = 1, ban_reason = ? WHERE user_id = ?",
            (reason, user_id)
        )
        await db.commit()

async def unban_user(user_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE users SET is_banned = 0, ban_reason = NULL WHERE user_id = ?",
            (user_id,)
        )
        await db.commit()

async def add_admin(user_id: int, added_by: int, permissions: dict = None):
    if permissions is None:
        permissions = {
            "can_add_items": True,
            "can_delete_items": False,
            "can_manage_categories": False,
            "can_ban_users": False,
            "can_view_users": True,
            "can_broadcast": False
        }
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT OR REPLACE INTO admins (user_id, added_by, permissions) VALUES (?, ?, ?)",
            (user_id, added_by, json.dumps(permissions))
        )
        await db.commit()

async def remove_admin(user_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute("DELETE FROM admins WHERE user_id = ?", (user_id,))
        await db.commit()

async def get_admin_permissions(user_id: int) -> dict:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT permissions FROM admins WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return json.loads(row[0]) if row else {}

async def update_admin_permissions(user_id: int, permissions: dict):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "UPDATE admins SET permissions = ? WHERE user_id = ?",
            (json.dumps(permissions), user_id)
        )
        await db.commit()

async def get_categories(parent_id=None):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        if parent_id is None:
            cursor = await db.execute(
                "SELECT id, name FROM categories WHERE parent_id IS NULL ORDER BY id"
            )
        else:
            cursor = await db.execute(
                "SELECT id, name FROM categories WHERE parent_id = ? ORDER BY id",
                (parent_id,)
            )
        return await cursor.fetchall()

async def get_items_by_category(category_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT id, type, content, views FROM items WHERE category_id = ? ORDER BY views DESC",
            (category_id,)
        )
        return await cursor.fetchall()

async def record_item_view(item_id: int, user_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO item_views (item_id, user_id) VALUES (?, ?)",
            (item_id, user_id)
        )
        await db.execute(
            "UPDATE items SET views = views + 1 WHERE id = ?",
            (item_id,)
        )
        await db.commit()

# ==================== التحقق من الصلاحيات ====================

def is_developer(update: Update) -> bool:
    return update.effective_user.id == DEVELOPER_ID

async def is_admin(user_id: int) -> bool:
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT user_id FROM admins WHERE user_id = ?", (user_id,)
        )
        return await cursor.fetchone() is not None

async def has_permission(user_id: int, permission: str) -> bool:
    if user_id == DEVELOPER_ID:
        return True
    perms = await get_admin_permissions(user_id)
    return perms.get(permission, False)

# ==================== لوحات التحكم ====================

def get_main_keyboard(user_id: int, is_admin_user: bool = False) -> ReplyKeyboardMarkup:
    buttons = [
        [KeyboardButton("📂 تصفح الملفات"), KeyboardButton("🔍 بحث")],
        [KeyboardButton("📊 الإحصائيات"), KeyboardButton("👤 ملفي الشخصي")],
    ]
    if is_admin_user:
        buttons.append([KeyboardButton("⚙️ لوحة الإدارة")])
    if user_id == DEVELOPER_ID:
        buttons.append([KeyboardButton("🛠️ لوحة المطور")])
    return ReplyKeyboardMarkup(buttons, resize_keyboard=True)

def get_developer_panel_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("👥 المستخدمون", callback_data="dev_users"),
            InlineKeyboardButton("🛡️ المشرفون", callback_data="dev_admins")
        ],
        [
            InlineKeyboardButton("📊 إحصائيات شاملة", callback_data="dev_stats"),
            InlineKeyboardButton("📢 بث رسالة", callback_data="dev_broadcast")
        ],
        [
            InlineKeyboardButton("📂 إدارة التصنيفات", callback_data="dev_categories"),
            InlineKeyboardButton("📝 إدارة المحتوى", callback_data="dev_items")
        ],
        [
            InlineKeyboardButton("🚫 المحظورون", callback_data="dev_banned"),
            InlineKeyboardButton("📋 سجل النشاط", callback_data="dev_activity")
        ],
        [InlineKeyboardButton("⚙️ إعدادات البوت", callback_data="dev_settings")]
    ])

def get_admin_panel_keyboard(permissions: dict) -> InlineKeyboardMarkup:
    buttons = []
    if permissions.get("can_view_users"):
        buttons.append([InlineKeyboardButton("👥 عرض المستخدمين", callback_data="admin_users")])
    if permissions.get("can_add_items"):
        buttons.append([InlineKeyboardButton("➕ إضافة محتوى", callback_data="admin_add")])
    if permissions.get("can_delete_items"):
        buttons.append([InlineKeyboardButton("🗑️ حذف محتوى", callback_data="admin_delete")])
    if permissions.get("can_ban_users"):
        buttons.append([InlineKeyboardButton("🚫 حظر مستخدم", callback_data="admin_ban")])
    if permissions.get("can_broadcast"):
        buttons.append([InlineKeyboardButton("📢 إرسال بث", callback_data="admin_broadcast")])
    return InlineKeyboardMarkup(buttons)

# ==================== المعالجات الرئيسية ====================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await register_user(user)
    await log_activity(user.id, "start", "بدأ استخدام البوت")

    if await is_banned(user.id):
        await update.message.reply_text("🚫 أنت محظور من استخدام هذا البوت.")
        return

    is_admin_user = await is_admin(user.id) or user.id == DEVELOPER_ID

    welcome_text = (
        f"👋 مرحباً {user.first_name}!\n\n"
        f"🤖 أنا بوت التخزين الذكي\n"
        f"📁 يمكنك تصفح وإدارة الملفات بسهولة\n\n"
        f"{'🛡️ أنت مشرف في هذا البوت\n' if is_admin_user else ''}"
        f"{'👑 أنت المطور - لديك صلاحيات كاملة\n' if user.id == DEVELOPER_ID else ''}\n"
        f"اختر من القائمة أدناه:"
    )

    await update.message.reply_text(
        welcome_text,
        reply_markup=get_main_keyboard(user.id, is_admin_user)
    )

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    text = update.message.text

    if await is_banned(user.id):
        await update.message.reply_text("🚫 أنت محظور.")
        return

    await register_user(user)

    if text == "📂 تصفح الملفات":
        await browse_categories(update, context)
    elif text == "🔍 بحث":
        await start_search(update, context)
    elif text == "📊 الإحصائيات":
        await show_stats(update, context)
    elif text == "👤 ملفي الشخصي":
        await show_my_profile(update, context)
    elif text == "⚙️ لوحة الإدارة":
        await show_admin_panel(update, context)
    elif text == "🛠️ لوحة المطور":
        await show_developer_panel(update, context)
    else:
        # بحث تلقائي
        await search_content(update, context, query=text)

async def browse_categories(update: Update, context: ContextTypes.DEFAULT_TYPE):
    categories = await get_categories()
    if not categories:
        await update.message.reply_text("📭 لا توجد تصنيفات حالياً.")
        return

    buttons = []
    for cat_id, cat_name in categories:
        buttons.append([InlineKeyboardButton(f"📁 {cat_name}", callback_data=f"cat_{cat_id}")])

    await update.message.reply_text(
        "📂 اختر تصنيفاً:",
        reply_markup=InlineKeyboardMarkup(buttons)
    )

async def start_search(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "🔍 أرسل كلمة البحث:"
    )
    context.user_data['searching'] = True

async def search_content(update: Update, context: ContextTypes.DEFAULT_TYPE, query: str = None):
    if not query:
        query = update.message.text

    await log_activity(update.effective_user.id, "search", query)

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("""
            SELECT i.id, i.type, i.content, c.name, i.views
            FROM items i
            JOIN categories c ON i.category_id = c.id
            WHERE i.content LIKE ? OR i.ai_summary LIKE ?
            ORDER BY i.views DESC
            LIMIT 10
        """, (f"%{query}%", f"%{query}%"))
        results = await cursor.fetchall()

    if not results:
        await update.message.reply_text(f"❌ لا توجد نتائج لـ: {query}")
        return

    text = f"🔍 نتائج البحث عن: **{query}**\n\n"
    buttons = []
    for item_id, item_type, content, cat_name, views in results:
        preview = content[:50] + "..." if len(content) > 50 else content
        text += f"📌 [{cat_name}] {preview} (👁️ {views})\n"
        buttons.append([InlineKeyboardButton(f"📄 {preview}", callback_data=f"item_{item_id}")])

    await update.message.reply_text(
        text,
        reply_markup=InlineKeyboardMarkup(buttons),
        parse_mode="Markdown"
    )

async def show_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    stats = await get_bot_stats()

    text = (
        "📊 **إحصائيات البوت**\n\n"
        f"👥 إجمالي المستخدمين: {stats['total_users']}\n"
        f"✅ المستخدمون النشطون: {stats['active_users']}\n"
        f"🆕 انضموا هذا الأسبوع: {stats['new_this_week']}\n"
        f"🟢 نشطون اليوم: {stats['active_today']}\n"
        f"🛡️ المشرفون: {stats['total_admins']}\n"
        f"📁 التصنيفات: {stats['total_categories']}\n"
        f"📄 العناصر: {stats['total_items']}\n\n"
    )

    if stats['top_items']:
        text += "🔥 **الأكثر مشاهدة:**\n"
        for content, views in stats['top_items']:
            preview = content[:30] + "..." if len(content) > 30 else content
            text += f"  • {preview}: {views} مشاهدة\n"

    await update.message.reply_text(text, parse_mode="Markdown")

async def show_my_profile(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    profile = await get_user_profile(user_id)

    if not profile:
        await update.message.reply_text("❌ لم يتم العثور على ملفك.")
        return

    joined = profile['joined_at'][:10] if profile['joined_at'] else "غير معروف"
    last_seen = profile['last_seen'][:16] if profile['last_seen'] else "غير معروف"

    text = (
        f"👤 **ملفك الشخصي**\n\n"
        f"🆔 المعرّف: `{profile['user_id']}`\n"
        f"👤 الاسم: {profile['first_name']} {profile['last_name'] or ''}\n"
        f"📛 اليوزر: @{profile['username'] or 'لا يوجد'}\n"
        f"📅 تاريخ الانضمام: {joined}\n"
        f"🕐 آخر نشاط: {last_seen}\n"
        f"💬 إجمالي الرسائل: {profile['total_messages']}\n"
        f"📊 عدد الأنشطة: {profile['activity_count']}\n"
        f"🛡️ مشرف: {'✅ نعم' if profile['is_admin'] else '❌ لا'}\n"
    )

    if profile['is_admin'] and profile['permissions']:
        text += "\n🔑 **صلاحياتك:**\n"
        perm_names = {
            "can_add_items": "إضافة محتوى",
            "can_delete_items": "حذف محتوى",
            "can_manage_categories": "إدارة التصنيفات",
            "can_ban_users": "حظر المستخدمين",
            "can_view_users": "عرض المستخدمين",
            "can_broadcast": "إرسال بث"
        }
        for perm, value in profile['permissions'].items():
            if value:
                text += f"  ✅ {perm_names.get(perm, perm)}\n"

    if profile['top_items']:
        text += "\n📌 **أكثر ما شاهدته:**\n"
        for content, views in profile['top_items'][:3]:
            preview = content[:25] + "..." if len(content) > 25 else content
            text += f"  • {preview} ({views}x)\n"

    await update.message.reply_text(text, parse_mode="Markdown")

# ==================== لوحة المطور ====================

async def show_developer_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        await update.message.reply_text("⛔ هذا الأمر للمطور فقط.")
        return

    stats = await get_bot_stats()
    text = (
        "🛠️ **لوحة تحكم المطور**\n\n"
        f"👥 المستخدمون: {stats['total_users']}\n"
        f"🛡️ المشرفون: {stats['total_admins']}\n"
        f"📄 العناصر: {stats['total_items']}\n"
        f"🟢 نشطون اليوم: {stats['active_today']}\n\n"
        "اختر الإجراء:"
    )
    await update.message.reply_text(
        text,
        reply_markup=get_developer_panel_keyboard(),
        parse_mode="Markdown"
    )

async def show_admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not (await is_admin(user_id) or is_developer(update)):
        await update.message.reply_text("⛔ ليس لديك صلاحية.")
        return

    permissions = await get_admin_permissions(user_id)
    if user_id == DEVELOPER_ID:
        permissions = {k: True for k in [
            "can_add_items", "can_delete_items", "can_manage_categories",
            "can_ban_users", "can_view_users", "can_broadcast"
        ]}

    keyboard = get_admin_panel_keyboard(permissions)
    await update.message.reply_text(
        "⚙️ **لوحة الإدارة**\n\nاختر الإجراء:",
        reply_markup=keyboard,
        parse_mode="Markdown"
    )

# ==================== معالج الأزرار ====================

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = query.from_user.id

    # تصفح التصنيفات
    if data.startswith("cat_"):
        cat_id = int(data.split("_")[1])
        await show_category_content(query, cat_id, user_id)

    # عرض عنصر
    elif data.startswith("item_"):
        item_id = int(data.split("_")[1])
        await show_item(query, item_id, user_id)

    # لوحة المطور
    elif data == "dev_users":
        await dev_show_users(query)
    elif data == "dev_admins":
        await dev_show_admins(query)
    elif data == "dev_stats":
        await dev_show_full_stats(query)
    elif data == "dev_broadcast":
        await dev_start_broadcast(query, context)
    elif data == "dev_banned":
        await dev_show_banned(query)
    elif data == "dev_activity":
        await dev_show_activity(query)

    # إدارة المستخدمين
    elif data.startswith("view_user_"):
        target_id = int(data.split("_")[2])
        await show_user_profile_admin(query, target_id)
    elif data.startswith("ban_"):
        target_id = int(data.split("_")[1])
        await ban_user(target_id, "محظور من قبل الإدارة")
        await query.edit_message_text(f"✅ تم حظر المستخدم {target_id}")
    elif data.startswith("unban_"):
        target_id = int(data.split("_")[1])
        await unban_user(target_id)
        await query.edit_message_text(f"✅ تم رفع الحظر عن {target_id}")
    elif data.startswith("make_admin_"):
        target_id = int(data.split("_")[2])
        await add_admin(target_id, user_id)
        await query.edit_message_text(f"✅ تم تعيين {target_id} مشرفاً")
    elif data.startswith("remove_admin_"):
        target_id = int(data.split("_")[2])
        await remove_admin(target_id)
        await query.edit_message_text(f"✅ تم إزالة {target_id} من المشرفين")

    # إدارة صلاحيات المشرف
    elif data.startswith("toggle_perm_"):
        parts = data.split("_")
        target_id = int(parts[2])
        perm = "_".join(parts[3:])
        await toggle_permission(query, target_id, perm)

async def show_category_content(query, cat_id: int, user_id: int):
    items = await get_items_by_category(cat_id)
    sub_cats = await get_categories(parent_id=cat_id)

    buttons = []

    if sub_cats:
        for sub_id, sub_name in sub_cats:
            buttons.append([InlineKeyboardButton(f"📁 {sub_name}", callback_data=f"cat_{sub_id}")])

    for item_id, item_type, content, views in items:
        preview = content[:40] + "..." if len(content) > 40 else content
        emoji = {"text": "📝", "photo": "🖼️", "video": "🎬", "document": "📄", "audio": "🎵"}.get(item_type, "📌")
        buttons.append([InlineKeyboardButton(f"{emoji} {preview} (👁️{views})", callback_data=f"item_{item_id}")])

    buttons.append([InlineKeyboardButton("🔙 رجوع", callback_data="back_main")])

    await query.edit_message_text(
        f"📂 محتوى التصنيف ({len(items)} عنصر):",
        reply_markup=InlineKeyboardMarkup(buttons)
    )
    await log_activity(user_id, "browse_category", str(cat_id))

async def show_item(query, item_id: int, user_id: int):
    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT type, content, file_id, drive_link, ai_summary, views FROM items WHERE id = ?",
            (item_id,)
        )
        item = await cursor.fetchone()

    if not item:
        await query.edit_message_text("❌ العنصر غير موجود.")
        return

    item_type, content, file_id, drive_link, ai_summary, views = item
    await record_item_view(item_id, user_id)
    await log_activity(user_id, "view_item", str(item_id))

    text = f"📄 **{content}**\n\n"
    if ai_summary:
        text += f"🤖 **ملخص AI:** {ai_summary}\n\n"
    if drive_link:
        text += f"🔗 [رابط Drive]({drive_link})\n"
    text += f"👁️ المشاهدات: {views + 1}"

    await query.edit_message_text(text, parse_mode="Markdown")

async def dev_show_users(query):
    if query.from_user.id != DEVELOPER_ID:
        return

    users = await get_all_users()
    text = f"👥 **قائمة المستخدمين** ({len(users)})\n\n"
    buttons = []

    for user_id, username, first_name, last_seen, messages, is_banned_val in users[:20]:
        status = "🚫" if is_banned_val else "✅"
        name = first_name or username or str(user_id)
        last = last_seen[:10] if last_seen else "?"
        text += f"{status} {name} | 💬{messages} | 📅{last}\n"
        buttons.append([InlineKeyboardButton(
            f"{status} {name}", callback_data=f"view_user_{user_id}"
        )])

    buttons.append([InlineKeyboardButton("🔙 رجوع", callback_data="dev_back")])
    await query.edit_message_text(
        text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown"
    )

async def dev_show_admins(query):
    if query.from_user.id != DEVELOPER_ID:
        return

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("""
            SELECT a.user_id, u.first_name, u.username, a.added_at, a.permissions
            FROM admins a
            LEFT JOIN users u ON a.user_id = u.user_id
        """)
        admins = await cursor.fetchall()

    text = f"🛡️ **المشرفون** ({len(admins)})\n\n"
    buttons = []

    for admin_id, fname, uname, added_at, perms_json in admins:
        perms = json.loads(perms_json) if perms_json else {}
        active_perms = sum(1 for v in perms.values() if v)
        name = fname or uname or str(admin_id)
        text += f"🛡️ {name} | 🔑 {active_perms} صلاحية\n"
        buttons.append([
            InlineKeyboardButton(f"✏️ {name}", callback_data=f"edit_admin_{admin_id}"),
            InlineKeyboardButton("❌ إزالة", callback_data=f"remove_admin_{admin_id}")
        ])

    buttons.append([InlineKeyboardButton("➕ إضافة مشرف", callback_data="add_new_admin")])
    buttons.append([InlineKeyboardButton("🔙 رجوع", callback_data="dev_back")])

    await query.edit_message_text(
        text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown"
    )

async def dev_show_full_stats(query):
    if query.from_user.id != DEVELOPER_ID:
        return

    stats = await get_bot_stats()
    text = (
        "📊 **إحصائيات شاملة**\n\n"
        f"👥 إجمالي المستخدمين: **{stats['total_users']}**\n"
        f"✅ نشطون: **{stats['active_users']}**\n"
        f"🟢 نشطون اليوم: **{stats['active_today']}**\n"
        f"🆕 هذا الأسبوع: **{stats['new_this_week']}**\n"
        f"🛡️ المشرفون: **{stats['total_admins']}**\n"
        f"📁 التصنيفات: **{stats['total_categories']}**\n"
        f"📄 العناصر: **{stats['total_items']}**\n\n"
    )

    if stats['top_items']:
        text += "🔥 **أكثر العناصر مشاهدة:**\n"
        for i, (content, views) in enumerate(stats['top_items'], 1):
            preview = content[:25] + "..." if len(content) > 25 else content
            text += f"  {i}. {preview}: **{views}** مشاهدة\n"

    if stats['top_categories']:
        text += "\n📂 **أكثر التصنيفات نشاطاً:**\n"
        for i, (name, views) in enumerate(stats['top_categories'], 1):
            text += f"  {i}. {name}: **{views}** مشاهدة\n"

    await query.edit_message_text(
        text,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="dev_back")]]),
        parse_mode="Markdown"
    )

async def dev_show_banned(query):
    if query.from_user.id != DEVELOPER_ID:
        return

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute(
            "SELECT user_id, first_name, username, ban_reason FROM users WHERE is_banned = 1"
        )
        banned = await cursor.fetchall()

    text = f"🚫 **المحظورون** ({len(banned)})\n\n"
    buttons = []

    for uid, fname, uname, reason in banned:
        name = fname or uname or str(uid)
        text += f"🚫 {name} | السبب: {reason or 'غير محدد'}\n"
        buttons.append([InlineKeyboardButton(f"✅ رفع حظر {name}", callback_data=f"unban_{uid}")])

    buttons.append([InlineKeyboardButton("🔙 رجوع", callback_data="dev_back")])
    await query.edit_message_text(
        text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown"
    )

async def dev_show_activity(query):
    if query.from_user.id != DEVELOPER_ID:
        return

    async with aiosqlite.connect(DATABASE_PATH) as db:
        cursor = await db.execute("""
            SELECT ua.user_id, u.first_name, ua.action, ua.details, ua.timestamp
            FROM user_activity ua
            LEFT JOIN users u ON ua.user_id = u.user_id
            ORDER BY ua.timestamp DESC
            LIMIT 20
        """)
        activities = await cursor.fetchall()

    text = "📋 **آخر الأنشطة**\n\n"
    for uid, fname, action, details, ts in activities:
        name = fname or str(uid)
        time_str = ts[:16] if ts else "?"
        text += f"👤 {name} | {action} | {details or ''} | {time_str}\n"

    await query.edit_message_text(
        text,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 رجوع", callback_data="dev_back")]]),
        parse_mode="Markdown"
    )

async def dev_start_broadcast(query, context):
    if query.from_user.id != DEVELOPER_ID:
        return
    context.user_data['awaiting_broadcast'] = True
    await query.edit_message_text(
        "📢 أرسل الرسالة التي تريد بثها لجميع المستخدمين:\n\n"
        "(أرسل /cancel للإلغاء)"
    )

async def show_user_profile_admin(query, target_id: int):
    profile = await get_user_profile(target_id)
    if not profile:
        await query.edit_message_text("❌ المستخدم غير موجود.")
        return

    joined = profile['joined_at'][:10] if profile['joined_at'] else "?"
    last_seen = profile['last_seen'][:16] if profile['last_seen'] else "?"

    text = (
        f"👤 **ملف المستخدم**\n\n"
        f"🆔 ID: `{profile['user_id']}`\n"
        f"👤 الاسم: {profile['first_name']} {profile['last_name'] or ''}\n"
        f"📛 اليوزر: @{profile['username'] or 'لا يوجد'}\n"
        f"📅 الانضمام: {joined}\n"
        f"🕐 آخر ظهور: {last_seen}\n"
        f"💬 الرسائل: {profile['total_messages']}\n"
        f"📊 الأنشطة: {profile['activity_count']}\n"
        f"🛡️ مشرف: {'✅' if profile['is_admin'] else '❌'}\n"
        f"🚫 محظور: {'✅' if profile['is_banned'] else '❌'}\n"
    )

    if profile['recent_activity']:
        text += "\n📋 **آخر الأنشطة:**\n"
        for action, details, ts in profile['recent_activity'][:5]:
            text += f"  • {action}: {details or ''} ({ts[:10] if ts else '?'})\n"

    buttons = []
    if profile['is_banned']:
        buttons.append([InlineKeyboardButton("✅ رفع الحظر", callback_data=f"unban_{target_id}")])
    else:
        buttons.append([InlineKeyboardButton("🚫 حظر", callback_data=f"ban_{target_id}")])

    if profile['is_admin']:
        buttons.append([InlineKeyboardButton("❌ إزالة من المشرفين", callback_data=f"remove_admin_{target_id}")])
    else:
        buttons.append([InlineKeyboardButton("🛡️ تعيين مشرفاً", callback_data=f"make_admin_{target_id}")])

    buttons.append([InlineKeyboardButton("🔙 رجوع", callback_data="dev_users")])

    await query.edit_message_text(
        text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown"
    )

async def toggle_permission(query, target_id: int, perm: str):
    if query.from_user.id != DEVELOPER_ID:
        return
    perms = await get_admin_permissions(target_id)
    perms[perm] = not perms.get(perm, False)
    await update_admin_permissions(target_id, perms)
    status = "✅ ممنوحة" if perms[perm] else "❌ مسحوبة"
    await query.edit_message_text(f"🔑 صلاحية '{perm}' {status} للمستخدم {target_id}")

# ==================== معالج البث ====================

async def handle_broadcast_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != DEVELOPER_ID:
        return
    if not context.user_data.get('awaiting_broadcast'):
        return

    context.user_data['awaiting_broadcast'] = False
    message_text = update.message.text
    users = await get_all_users()

    sent = 0
    failed = 0
    await update.message.reply_text(f"📢 جاري الإرسال لـ {len(users)} مستخدم...")

    for user_id, *_ in users:
        try:
            await context.bot.send_message(chat_id=user_id, text=message_text)
            sent += 1
        except Exception:
            failed += 1
        await asyncio.sleep(0.05)  # تجنب الحظر

    async with aiosqlite.connect(DATABASE_PATH) as db:
        await db.execute(
            "INSERT INTO broadcasts (message, sent_by, recipients) VALUES (?, ?, ?)",
            (message_text, DEVELOPER_ID, sent)
        )
        await db.commit()

    await update.message.reply_text(
        f"✅ **تم الإرسال**\n\n"
        f"✅ ناجح: {sent}\n"
        f"❌ فشل: {failed}",
        parse_mode="Markdown"
    )

# ==================== أوامر المطور ====================

async def cmd_add_admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /addadmin [user_id]")
        return
    try:
        target_id = int(context.args[0])
        await add_admin(target_id, DEVELOPER_ID)
        await update.message.reply_text(f"✅ تم إضافة {target_id} كمشرف")
    except ValueError:
        await update.message.reply_text("❌ معرّف غير صالح")

async def cmd_remove_admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_developer(update):
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /removeadmin [user_id]")
        return
    target_id = int(context.args[0])
    await remove_admin(target_id)
    await update.message.reply_text(f"✅ تم إزالة {target_id} من المشرفين")

async def cmd_ban(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not (is_developer(update) or await has_permission(update.effective_user.id, "can_ban_users")):
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /ban [user_id] [سبب اختياري]")
        return
    target_id = int(context.args[0])
    reason = " ".join(context.args[1:]) if len(context.args) > 1 else None
    await ban_user(target_id, reason)
    await update.message.reply_text(f"✅ تم حظر {target_id}")

async def cmd_unban(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not (is_developer(update) or await has_permission(update.effective_user.id, "can_ban_users")):
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /unban [user_id]")
        return
    target_id = int(context.args[0])
    await unban_user(target_id)
    await update.message.reply_text(f"✅ تم رفع الحظر عن {target_id}")

async def cmd_userinfo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not (is_developer(update) or await has_permission(update.effective_user.id, "can_view_users")):
        return
    if not context.args:
        await update.message.reply_text("الاستخدام: /userinfo [user_id]")
        return
    target_id = int(context.args[0])
    profile = await get_user_profile(target_id)
    if not profile:
        await update.message.reply_text("❌ المستخدم غير موجود")
        return

    text = (
        f"👤 **معلومات المستخدم**\n\n"
        f"🆔 ID: `{profile['user_id']}`\n"
        f"👤 الاسم: {profile['first_name']}\n"
        f"📛 اليوزر: @{profile['username'] or 'لا يوجد'}\n"
        f"📅 الانضمام: {profile['joined_at'][:10] if profile['joined_at'] else '?'}\n"
        f"🕐 آخر ظهور: {profile['last_seen'][:16] if profile['last_seen'] else '?'}\n"
        f"💬 الرسائل: {profile['total_messages']}\n"
        f"🛡️ مشرف: {'✅' if profile['is_admin'] else '❌'}\n"
        f"🚫 محظور: {'✅' if profile['is_banned'] else '❌'}\n"
    )
    await update.message.reply_text(text, parse_mode="Markdown")

async def cmd_setperm(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """تعيين صلاحية لمشرف: /setperm [user_id] [permission] [true/false]"""
    if not is_developer(update):
        return
    if len(context.args) < 3:
        await update.message.reply_text(
            "الاستخدام: /setperm [user_id] [permission] [true/false]\n\n"
            "الصلاحيات المتاحة:\n"
            "• can_add_items\n• can_delete_items\n• can_manage_categories\n"
            "• can_ban_users\n• can_view_users\n• can_broadcast"
        )
        return
    target_id = int(context.args[0])
    perm = context.args[1]
    value = context.args[2].lower() == "true"

    perms = await get_admin_permissions(target_id)
    perms[perm] = value
    await update_admin_permissions(target_id, perms)
    await update.message.reply_text(
        f"✅ تم {'منح' if value else 'سحب'} صلاحية '{perm}' {'من' if not value else 'لـ'} {target_id}"
    )

# ==================== تشغيل البوت ====================

async def main():
    await init_db()

    app = Application.builder().token(TOKEN).build()

    # أوامر عامة
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("stats", show_stats))

    # أوامر المطور
    app.add_handler(CommandHandler("addadmin", cmd_add_admin))
    app.add_handler(CommandHandler("removeadmin", cmd_remove_admin))
    app.add_handler(CommandHandler("ban", cmd_ban))
    app.add_handler(CommandHandler("unban", cmd_unban))
    app.add_handler(CommandHandler("userinfo", cmd_userinfo))
    app.add_handler(CommandHandler("setperm", cmd_setperm))

    # معالج الأزرار
    app.add_handler(CallbackQueryHandler(handle_callback))

    # معالج الرسائل
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND,
        handle_message
    ))

    logger.info("🚀 Bot started successfully!")
    await app.run_polling(drop_pending_updates=True)

if __name__ == "__main__":
    asyncio.run(main())
