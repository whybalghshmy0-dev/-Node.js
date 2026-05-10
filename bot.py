import requests
import time
import logging
import asyncio
import http.server
import socketserver
import threading
import os
from datetime import datetime
from collections import defaultdict
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ===================== Keep Alive — مطلوب لـ Render =====================
class SilentHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Bot is Running!")

    def log_message(self, format, *args):
        pass  # إيقاف logs السيرفر

def keep_alive():
    port = int(os.environ.get("PORT", 8080))
    max_retries = 5
    for i in range(max_retries):
        try:
            httpd = socketserver.TCPServer(("0.0.0.0", port), SilentHandler)
            httpd.allow_reuse_address = True
            print(f"✅ Keep-alive server running on port {port}")
            httpd.serve_forever()
            break
        except OSError as e:
            print(f"⚠️ Port {port} busy, retrying... ({i+1}/{max_retries})")
            time.sleep(2)

threading.Thread(target=keep_alive, daemon=True).start()

# ===================== الإعدادات =====================
BOT_TOKEN = os.environ.get("BOT_TOKEN", "7243808108:AAFxlT-1HQ6twyVewzWqgdEgXd0EK_j4o5Y")
HERO_API_KEY = os.environ.get("HERO_API_KEY", "b7c49e0f481e15e7b96eAAb85e60570d")
HERO_BASE_URL = "https://hero-sms.com/api/v1"
NUMBER_LIFETIME = 1200  # 20 دقيقة

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ===================== تخزين البيانات =====================
active_numbers = {}
user_history = defaultdict(list)
user_stats = defaultdict(int)
user_state = {}
services_cache = {"data": {}, "updated_at": 0}

SERVICE_CATEGORIES = {
    "سوشيال ميديا 📲": ["vk", "ok", "fb", "instagram", "tiktok", "twitter", "snapchat", "telegram"],
    "مراسلة 💬": ["whatsapp", "viber", "line", "wechat", "signal"],
    "بريد وحسابات 📧": ["google", "gmail", "yahoo", "microsoft", "apple"],
    "تسوق 🛒": ["amazon", "aliexpress", "ebay", "shopee"],
    "أخرى 🔧": [],
}

# ===================== Hero SMS API =====================

def api_get(endpoint: str, params: dict):
    try:
        params["api_key"] = HERO_API_KEY
        r = requests.get(f"{HERO_BASE_URL}/{endpoint}", params=params, timeout=10)
        return r.json()
    except Exception as e:
        logger.error(f"API {endpoint}: {e}")
        return None


def get_balance():
    data = api_get("balance", {})
    return data.get("balance") if data else None


def fetch_all_services():
    now = time.time()
    if now - services_cache["updated_at"] < 300 and services_cache["data"]:
        return services_cache["data"]
    data = api_get("services", {})
    if isinstance(data, dict):
        services_cache["data"] = data
        services_cache["updated_at"] = now
        return data
    return {}


def get_free_services():
    all_svc = fetch_all_services()
    return {
        code: info for code, info in all_svc.items()
        if isinstance(info, dict) and float(info.get("price", 1)) == 0
    }


def get_countries_for_service(service_code: str):
    data = api_get("countries", {"service": service_code})
    return data if isinstance(data, dict) else {}


def get_free_number(service: str, country: str = "ru"):
    return api_get("get-number", {"service": service, "country": country, "price": 0})


def get_sms(order_id: str):
    return api_get("get-sms", {"order_id": order_id})


def cancel_number(order_id: str):
    return api_get("cancel", {"order_id": order_id})


# ===================== دوال مساعدة =====================

def get_category(svc_code: str) -> str:
    svc_lower = svc_code.lower()
    for cat, keywords in SERVICE_CATEGORIES.items():
        if any(k in svc_lower for k in keywords):
            return cat
    return "أخرى 🔧"


def format_time_left(start_time: float) -> str:
    remaining = NUMBER_LIFETIME - (time.time() - start_time)
    if remaining <= 0:
        return "⏰ انتهى الوقت"
    mins = int(remaining // 60)
    secs = int(remaining % 60)
    return f"⏱ متبقي: {mins:02d}:{secs:02d}"


def search_services(query: str, services: dict) -> dict:
    q = query.lower()
    return {
        code: info for code, info in services.items()
        if q in code.lower() or q in (info.get("name", "").lower() if isinstance(info, dict) else "")
    }


def add_to_history(user_id: int, number: str, service: str):
    history = user_history[user_id]
    history.insert(0, {
        "number": number,
        "service": service,
        "time": datetime.now().strftime("%Y-%m-%d %H:%M")
    })
    user_history[user_id] = history[:5]
    user_stats[user_id] += 1


# ===================== لوحات المفاتيح =====================

def main_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📱 احصل على رقم مجاني", callback_data="get_number_menu")],
        [InlineKeyboardButton("🔍 بحث عن خدمة", callback_data="search_mode"),
         InlineKeyboardButton("💰 رصيدي", callback_data="balance")],
        [InlineKeyboardButton("📋 سجل الأرقام", callback_data="history"),
         InlineKeyboardButton("📊 إحصائياتي", callback_data="stats")],
        [InlineKeyboardButton("ℹ️ مساعدة", callback_data="help")],
    ])


def back_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")]
    ])


def categories_keyboard(services: dict):
    cats = defaultdict(list)
    for code, info in services.items():
        cats[get_category(code)].append((code, info))
    keyboard = []
    for cat, items in cats.items():
        keyboard.append([InlineKeyboardButton(f"{cat} ({len(items)})", callback_data=f"cat:{cat}")])
    keyboard.append([InlineKeyboardButton("📋 عرض الكل", callback_data="cat:all")])
    keyboard.append([InlineKeyboardButton("🔙 رجوع", callback_data="back")])
    return InlineKeyboardMarkup(keyboard)


# ===================== أوامر البوت =====================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_state.pop(update.effective_user.id, None)
    await update.message.reply_text(
        "👋 *أهلاً بك في بوت الأرقام المجانية!*\n\n"
        "🆓 أرقام مجانية لاستقبال SMS\n"
        "🔔 إشعار تلقائي عند وصول الرسالة\n"
        "⏱ مؤقت يعرض الوقت المتبقي\n"
        "🔍 بحث سريع عن أي خدمة\n\n"
        "اختر من القائمة:",
        parse_mode="Markdown",
        reply_markup=main_keyboard(),
    )


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = update.effective_user.id

    if data == "balance":
        balance = get_balance()
        text = f"💰 *رصيدك الحالي:* `{balance}`" if balance is not None else "❌ تعذر جلب الرصيد."
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=back_keyboard())

    elif data == "search_mode":
        user_state[user_id] = "searching"
        await query.edit_message_text(
            "🔍 *وضع البحث*\n\nأرسل اسم التطبيق أو الخدمة:\n\nمثال: `whatsapp` أو `google`",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("❌ إلغاء", callback_data="back")]])
        )

    elif data == "get_number_menu":
        await query.edit_message_text("⏳ جاري تحميل الخدمات المجانية...")
        services = get_free_services()
        if not services:
            await query.edit_message_text("😔 لا توجد خدمات مجانية حالياً.", reply_markup=back_keyboard())
            return
        await query.edit_message_text(
            f"📂 *اختر التصنيف:*\n\n🆓 إجمالي الخدمات المجانية: *{len(services)}*",
            parse_mode="Markdown",
            reply_markup=categories_keyboard(services)
        )

    elif data.startswith("cat:"):
        cat_name = data.split(":", 1)[1]
        services = get_free_services()
        filtered = services if cat_name == "all" else {
            code: info for code, info in services.items()
            if get_category(code) == cat_name
        }
        if not filtered:
            await query.edit_message_text("😔 لا توجد خدمات في هذا التصنيف.", reply_markup=back_keyboard())
            return
        items = list(filtered.items())[:12]
        keyboard = []
        for svc_code, svc_info in items:
            name = svc_info.get("name", svc_code) if isinstance(svc_info, dict) else svc_code
            count = svc_info.get("count", "")
            label = f"🆓 {name}" + (f" | {count} رقم" if count else "")
            keyboard.append([InlineKeyboardButton(label, callback_data=f"select_svc:{svc_code}")])
        keyboard.append([InlineKeyboardButton("🔙 رجوع", callback_data="get_number_menu")])
        await query.edit_message_text(
            f"📋 *{cat_name}* — *{len(filtered)}* خدمة:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif data.startswith("select_svc:"):
        svc_code = data.split(":", 1)[1]
        await query.edit_message_text(f"⏳ جاري جلب الدول المتاحة...", parse_mode="Markdown")
        countries = get_countries_for_service(svc_code)
        keyboard = []
        if countries:
            for country_code, country_info in list(countries.items())[:8]:
                name = country_info.get("name", country_code) if isinstance(country_info, dict) else country_code
                count = country_info.get("count", "") if isinstance(country_info, dict) else ""
                label = f"🌍 {name}" + (f" ({count})" if count else "")
                keyboard.append([InlineKeyboardButton(label, callback_data=f"get_num:{svc_code}:{country_code}")])
        else:
            keyboard = [
                [InlineKeyboardButton("🇷🇺 روسيا", callback_data=f"get_num:{svc_code}:ru")],
                [InlineKeyboardButton("🇺🇸 أمريكا", callback_data=f"get_num:{svc_code}:us")],
                [InlineKeyboardButton("🇬🇧 بريطانيا", callback_data=f"get_num:{svc_code}:gb")],
                [InlineKeyboardButton("🇩🇪 ألمانيا", callback_data=f"get_num:{svc_code}:de")],
                [InlineKeyboardButton("🌍 أي دولة", callback_data=f"get_num:{svc_code}:any")],
            ]
        keyboard.append([InlineKeyboardButton("🔙 رجوع", callback_data="cat:all")])
        await query.edit_message_text(
            f"🌍 *اختر الدولة للخدمة:* `{svc_code}`",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    elif data.startswith("get_num:"):
        _, svc_code, country = data.split(":", 2)
        await query.edit_message_text("⏳ جاري طلب رقم مجاني...")
        result = get_free_number(svc_code, country)
        if not result or "order_id" not in result:
            msg = result.get("message", "خطأ غير معروف") if result else "تعذر الاتصال"
            await query.edit_message_text(
                f"❌ *فشل طلب الرقم*\n\n`{msg}`",
                parse_mode="Markdown",
                reply_markup=back_keyboard()
            )
            return

        order_id = str(result["order_id"])
        number = result.get("number", "غير معروف")
        start_time = time.time()

        active_numbers[user_id] = {
            "order_id": order_id,
            "number": number,
            "service": svc_code,
            "time": start_time,
            "chat_id": query.message.chat_id,
        }
        add_to_history(user_id, number, svc_code)

        keyboard = [
            [InlineKeyboardButton("📩 تحقق من SMS", callback_data=f"check_sms:{order_id}")],
            [InlineKeyboardButton("❌ إلغاء الرقم", callback_data=f"cancel:{order_id}")],
            [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")],
        ]
        await query.edit_message_text(
            f"✅ *تم الحصول على الرقم المجاني!*\n\n"
            f"📱 *الرقم:* `{number}`\n"
            f"🔧 *الخدمة:* `{svc_code}`\n"
            f"🆔 *رقم الطلب:* `{order_id}`\n"
            f"{format_time_left(start_time)}\n\n"
            f"سيصلك إشعار تلقائي عند وصول الرسالة 🔔",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
        asyncio.create_task(auto_sms_watcher(context, user_id, order_id, number, svc_code, query.message.chat_id))

    elif data.startswith("check_sms:"):
        order_id = data.split(":", 1)[1]
        await query.edit_message_text("⏳ جاري البحث عن الرسالة...")
        sms_text = None
        for attempt in range(3):
            result = get_sms(order_id)
            if result and result.get("sms"):
                sms_text = result["sms"]
                break
            if attempt < 2:
                time.sleep(2)

        info = active_numbers.get(user_id, {})
        time_left = format_time_left(info["time"]) if info else ""
        keyboard = [
            [InlineKeyboardButton("🔄 تحديث", callback_data=f"check_sms:{order_id}")],
            [InlineKeyboardButton("❌ إلغاء الرقم", callback_data=f"cancel:{order_id}")],
            [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")],
        ]
        if sms_text:
            active_numbers.pop(user_id, None)
            await query.edit_message_text(
                f"📩 *تم استلام الرسالة!*\n\n```\n{sms_text}\n```",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")]]),
            )
        else:
            await query.edit_message_text(
                f"⌛ *لم تصل رسالة بعد.*\n{time_left}\n\nاضغط *تحديث* للمحاولة.",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(keyboard),
            )

    elif data.startswith("cancel:"):
        order_id = data.split(":", 1)[1]
        cancel_number(order_id)
        active_numbers.pop(user_id, None)
        await query.edit_message_text("✅ تم إلغاء الرقم بنجاح.", reply_markup=back_keyboard())

    elif data == "history":
        history = user_history.get(user_id, [])
        if not history:
            await query.edit_message_text("📋 *سجل الأرقام*\n\nلم تستخدم أي رقم بعد.", parse_mode="Markdown", reply_markup=back_keyboard())
            return
        text = "📋 *آخر 5 أرقام استخدمتها:*\n\n"
        for i, h in enumerate(history, 1):
            text += f"{i}. `{h['number']}` — {h['service']}\n    🕐 {h['time']}\n\n"
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=back_keyboard())

    elif data == "stats":
        total = user_stats.get(user_id, 0)
        info = active_numbers.get(user_id)
        text = f"📊 *إحصائياتك:*\n\n📱 إجمالي الأرقام المستخدمة: *{total}*\n🟢 رقم نشط الآن: *{'نعم' if info else 'لا'}*\n"
        if info:
            text += f"{format_time_left(info['time'])}\n📞 الرقم: `{info['number']}`"
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=back_keyboard())

    elif data == "help":
        await query.edit_message_text(
            "ℹ️ *كيف يعمل البوت:*\n\n"
            "1️⃣ اضغط *احصل على رقم مجاني*\n"
            "2️⃣ اختر التصنيف ثم الخدمة\n"
            "3️⃣ اختر الدولة المتاحة\n"
            "4️⃣ استخدم الرقم في التطبيق\n"
            "5️⃣ سيصلك إشعار تلقائي عند وصول SMS 🔔\n\n"
            "🔍 *البحث:* اكتب اسم الخدمة مباشرة\n"
            "📋 *السجل:* آخر 5 أرقام استخدمتها\n"
            "⏱ *المؤقت:* يعرض الوقت المتبقي للرقم\n\n"
            "❗ الأرقام المجانية فقط — لا تحتاج رصيد.",
            parse_mode="Markdown",
            reply_markup=back_keyboard(),
        )

    elif data == "back":
        user_state.pop(user_id, None)
        await query.edit_message_text(
            "👋 *القائمة الرئيسية*\n\nاختر ما تريد:",
            parse_mode="Markdown",
            reply_markup=main_keyboard(),
        )


# ===================== معالج البحث النصي =====================

async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_state.get(user_id) != "searching":
        return
    query_text = update.message.text.strip()
    user_state.pop(user_id, None)
    await update.message.reply_text(f"🔍 جاري البحث عن: *{query_text}*...", parse_mode="Markdown")
    services = get_free_services()
    results = search_services(query_text, services)
    if not results:
        await update.message.reply_text(
            f"😔 لم أجد خدمات مجانية باسم *{query_text}*",
            parse_mode="Markdown",
            reply_markup=main_keyboard()
        )
        return
    items = list(results.items())[:8]
    keyboard = []
    for svc_code, svc_info in items:
        name = svc_info.get("name", svc_code) if isinstance(svc_info, dict) else svc_code
        count = svc_info.get("count", "")
        label = f"🆓 {name}" + (f" ({count})" if count else "")
        keyboard.append([InlineKeyboardButton(label, callback_data=f"select_svc:{svc_code}")])
    keyboard.append([InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")])
    await update.message.reply_text(
        f"✅ *نتائج البحث ({len(results)} خدمة):*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ===================== مراقب SMS التلقائي =====================

async def auto_sms_watcher(context, user_id: int, order_id: str, number: str, service: str, chat_id: int):
    max_attempts = NUMBER_LIFETIME // 10
    for _ in range(max_attempts):
        await asyncio.sleep(10)
        if user_id not in active_numbers:
            return
        if active_numbers[user_id].get("order_id") != order_id:
            return
        result = get_sms(order_id)
        if result and result.get("sms"):
            sms_text = result["sms"]
            active_numbers.pop(user_id, None)
            try:
                await context.bot.send_message(
                    chat_id=chat_id,
                    text=(
                        f"🔔 *وصلت رسالتك تلقائياً!*\n\n"
                        f"📱 *الرقم:* `{number}`\n"
                        f"🔧 *الخدمة:* `{service}`\n\n"
                        f"📩 *الرسالة:*\n```\n{sms_text}\n```"
                    ),
                    parse_mode="Markdown",
                    reply_markup=main_keyboard()
                )
            except Exception as e:
                logger.error(f"auto_sms send: {e}")
            return

    if user_id in active_numbers and active_numbers[user_id].get("order_id") == order_id:
        active_numbers.pop(user_id, None)
        try:
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"⏰ انتهى وقت الرقم `{number}` بدون استقبال رسالة.",
                parse_mode="Markdown",
                reply_markup=main_keyboard()
            )
        except Exception as e:
            logger.error(f"auto_sms timeout: {e}")


# ===================== تشغيل البوت =====================

def main():
    print("🚀 البوت يعمل...")
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
