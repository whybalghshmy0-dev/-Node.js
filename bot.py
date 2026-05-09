import requests
import time
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

# ===================== الإعدادات =====================
BOT_TOKEN = "7243808108:AAFxlT-1HQ6twyVewzWqgdEgXd0EK_j4o5Y"
HERO_API_KEY = "b7c49e0f481e15e7b96eAAb85e60570d"
HERO_BASE_URL = "https://hero-sms.com/api/v1"

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ===================== Hero SMS API =====================

def get_balance():
    try:
        r = requests.get(
            f"{HERO_BASE_URL}/balance",
            params={"api_key": HERO_API_KEY},
            timeout=10
        )
        return r.json().get("balance", "غير معروف")
    except Exception as e:
        logger.error(f"get_balance: {e}")
        return None


def get_free_services():
    """جلب الخدمات المجانية فقط (price = 0)"""
    try:
        r = requests.get(
            f"{HERO_BASE_URL}/services",
            params={"api_key": HERO_API_KEY},
            timeout=10
        )
        data = r.json()
        if isinstance(data, dict):
            return {
                code: info for code, info in data.items()
                if isinstance(info, dict) and float(info.get("price", 1)) == 0
            }
        return {}
    except Exception as e:
        logger.error(f"get_free_services: {e}")
        return {}


def get_free_number(service: str, country: str = "ru"):
    try:
        r = requests.get(
            f"{HERO_BASE_URL}/get-number",
            params={"api_key": HERO_API_KEY, "service": service, "country": country, "price": 0},
            timeout=10,
        )
        return r.json()
    except Exception as e:
        logger.error(f"get_free_number: {e}")
        return None


def get_sms(order_id: str):
    try:
        r = requests.get(
            f"{HERO_BASE_URL}/get-sms",
            params={"api_key": HERO_API_KEY, "order_id": order_id},
            timeout=10,
        )
        return r.json()
    except Exception as e:
        logger.error(f"get_sms: {e}")
        return None


def cancel_number(order_id: str):
    try:
        r = requests.get(
            f"{HERO_BASE_URL}/cancel",
            params={"api_key": HERO_API_KEY, "order_id": order_id},
            timeout=10,
        )
        return r.json()
    except Exception as e:
        logger.error(f"cancel_number: {e}")
        return None


# ===================== لوحات المفاتيح =====================

def main_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📱 احصل على رقم مجاني", callback_data="get_number_menu")],
        [InlineKeyboardButton("💰 رصيدي", callback_data="balance")],
        [InlineKeyboardButton("ℹ️ مساعدة", callback_data="help")],
    ])


def back_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")]
    ])


# ===================== أوامر البوت =====================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 *أهلاً بك في بوت الأرقام المجانية!*\n\n"
        "🆓 هذا البوت يوفر أرقام *مجانية* فقط لاستقبال رسائل SMS.\n\n"
        "اختر من القائمة:",
        parse_mode="Markdown",
        reply_markup=main_keyboard(),
    )


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    # ---- الرصيد ----
    if data == "balance":
        balance = get_balance()
        text = f"💰 *رصيدك الحالي:* `{balance}`" if balance is not None else "❌ تعذر جلب الرصيد."
        await query.edit_message_text(text, parse_mode="Markdown", reply_markup=back_keyboard())

    # ---- قائمة الخدمات المجانية ----
    elif data == "get_number_menu":
        await query.edit_message_text("⏳ جاري تحميل الخدمات المجانية...")
        services = get_free_services()

        if not services:
            await query.edit_message_text(
                "😔 لا توجد خدمات مجانية متاحة حالياً.\nحاول لاحقاً.",
                reply_markup=back_keyboard()
            )
            return

        items = list(services.items())[:12]
        keyboard = []
        for svc_code, svc_info in items:
            name = svc_info.get("name", svc_code) if isinstance(svc_info, dict) else svc_code
            count = svc_info.get("count", "")
            label = f"🆓 {name}" + (f" ({count})" if count else "")
            keyboard.append([InlineKeyboardButton(label, callback_data=f"select_svc:{svc_code}")])
        keyboard.append([InlineKeyboardButton("🔙 رجوع", callback_data="back")])

        await query.edit_message_text(
            f"📋 *الخدمات المجانية المتاحة ({len(services)}):*\n\nاختر الخدمة:",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    # ---- اختيار دولة ----
    elif data.startswith("select_svc:"):
        svc_code = data.split(":", 1)[1]
        keyboard = [
            [InlineKeyboardButton("🇷🇺 روسيا", callback_data=f"get_num:{svc_code}:ru")],
            [InlineKeyboardButton("🇺🇸 أمريكا", callback_data=f"get_num:{svc_code}:us")],
            [InlineKeyboardButton("🇬🇧 بريطانيا", callback_data=f"get_num:{svc_code}:gb")],
            [InlineKeyboardButton("🇩🇪 ألمانيا", callback_data=f"get_num:{svc_code}:de")],
            [InlineKeyboardButton("🌍 أي دولة", callback_data=f"get_num:{svc_code}:any")],
            [InlineKeyboardButton("🔙 رجوع", callback_data="get_number_menu")],
        ]
        await query.edit_message_text(
            f"🌍 *اختر الدولة للخدمة:* `{svc_code}`",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    # ---- جلب رقم مجاني ----
    elif data.startswith("get_num:"):
        _, svc_code, country = data.split(":", 2)
        await query.edit_message_text("⏳ جاري طلب رقم مجاني...")
        result = get_free_number(svc_code, country)

        if not result or "order_id" not in result:
            msg = result.get("message", "خطأ غير معروف") if result else "تعذر الاتصال بالخادم"
            await query.edit_message_text(
                f"❌ *فشل طلب الرقم*\n\n`{msg}`\n\nلا تتوفر أرقام مجانية لهذه الخدمة حالياً.",
                parse_mode="Markdown",
                reply_markup=back_keyboard()
            )
            return

        order_id = str(result["order_id"])
        number = result.get("number", "غير معروف")

        keyboard = [
            [InlineKeyboardButton("📩 تحقق من SMS", callback_data=f"check_sms:{order_id}")],
            [InlineKeyboardButton("❌ إلغاء الرقم", callback_data=f"cancel:{order_id}")],
            [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")],
        ]
        await query.edit_message_text(
            f"✅ *تم الحصول على الرقم المجاني!*\n\n"
            f"📱 *الرقم:* `{number}`\n"
            f"🆔 *رقم الطلب:* `{order_id}`\n\n"
            f"أرسل الكود إلى هذا الرقم ثم اضغط *تحقق من SMS* ⬇️",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )

    # ---- التحقق من SMS ----
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
                time.sleep(3)

        keyboard = [
            [InlineKeyboardButton("🔄 تحديث", callback_data=f"check_sms:{order_id}")],
            [InlineKeyboardButton("❌ إلغاء الرقم", callback_data=f"cancel:{order_id}")],
            [InlineKeyboardButton("🔙 القائمة الرئيسية", callback_data="back")],
        ]

        if sms_text:
            await query.edit_message_text(
                f"📩 *تم استلام الرسالة!*\n\n`{sms_text}`",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(keyboard),
            )
        else:
            await query.edit_message_text(
                "⌛ *لم تصل رسالة بعد.*\n\nاضغط *تحديث* للمحاولة مجدداً أو انتظر قليلاً.",
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup(keyboard),
            )

    # ---- إلغاء الرقم ----
    elif data.startswith("cancel:"):
        order_id = data.split(":", 1)[1]
        result = cancel_number(order_id)
        ok = result and result.get("status") in ("ok", "success", 1, "1")
        msg = "✅ تم إلغاء الرقم بنجاح." if ok else "⚠️ تعذر الإلغاء أو الرقم منتهي بالفعل."
        await query.edit_message_text(msg, reply_markup=back_keyboard())

    # ---- مساعدة ----
    elif data == "help":
        await query.edit_message_text(
            "ℹ️ *كيف يعمل البوت:*\n\n"
            "1️⃣ اضغط *احصل على رقم مجاني*\n"
            "2️⃣ اختر الخدمة التي تريدها\n"
            "3️⃣ اختر الدولة\n"
            "4️⃣ استخدم الرقم في التطبيق\n"
            "5️⃣ اضغط *تحقق من SMS* لاستلام الكود\n\n"
            "💡 البوت يعرض الأرقام المجانية فقط.\n"
            "❗ إذا لم تصل رسالة، اضغط تحديث عدة مرات.",
            parse_mode="Markdown",
            reply_markup=back_keyboard(),
        )

    # ---- رجوع ----
    elif data == "back":
        await query.edit_message_text(
            "👋 *القائمة الرئيسية*\n\nاختر ما تريد:",
            parse_mode="Markdown",
            reply_markup=main_keyboard(),
        )


# ===================== تشغيل البوت =====================

def main():
    print("🚀 البوت يعمل - أرقام مجانية فقط...")
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
