from __future__ import annotations

import logging
import re
from datetime import datetime
from html import escape
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlencode

from aiogram import Bot, F, Router
from aiogram.enums import ChatType, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LinkPreviewOptions,
    Message,
)
from aiogram.utils.deep_linking import create_start_link

if TYPE_CHECKING:
    from .config import Settings
    from .service import GameService
    from .storage import OutboxItem, Round

logger = logging.getLogger(__name__)
ROUND_PREFIX = "round_"
SQLITE_MAX_ID = 2**63 - 1


def _parse_round_id(value: str) -> int | None:
    if not re.fullmatch(r"[1-9][0-9]{0,18}", value):
        return None
    number = int(value)
    return number if number <= SQLITE_MAX_ID else None


class TelegramGateway:
    def __init__(self, bot: Bot, settings: Settings) -> None:
        self.bot = bot
        self.settings = settings

    async def publish(self, game_round: Round, path: Path) -> int:
        location = game_round.location
        suffix = Path(location.file_name).suffix.lower()
        kind = location.media_kind
        # Keep source names out of Telegram because they may reveal the answer.
        extension = {
            "photo": ".png" if suffix == ".png" else ".jpg",
            "video": ".mp4",
            "animation": ".mp4" if suffix == ".mp4" else ".gif",
        }[kind]
        media = FSInputFile(path, filename=f"round-{game_round.id}{extension}")
        link = await create_start_link(self.bot, f"{ROUND_PREFIX}{game_round.id}")
        button = InlineKeyboardButton(text=self.settings.text["guess_button"], url=link)
        markup = InlineKeyboardMarkup(inline_keyboard=[[button]])
        closes_at = datetime.fromtimestamp(game_round.ends_at, self.settings.timezone)
        caption = self.settings.text["round_caption"].format(
            round_id=game_round.id,
            closes_at=closes_at.strftime("%d.%m %H:%M %Z"),
        )
        options = {
            "chat_id": game_round.channel,
            "caption": caption,
            "reply_markup": markup,
        }
        if kind == "photo":
            message = await self.bot.send_photo(photo=media, **options)
        elif kind == "video":
            message = await self.bot.send_video(video=media, supports_streaming=True, **options)
        else:
            message = await self.bot.send_animation(animation=media, **options)
        return message.message_id

    async def deliver(self, item: OutboxItem, game_round: Round) -> int:
        templates = self.settings.text
        if item.kind == "guess":
            if item.user_id is None:
                raise ValueError("Guess notification has no Telegram user ID")
            name = escape(item.user_name or str(item.user_id))
            mention = f'<a href="tg://user?id={item.user_id}">{name}</a>'
            text = templates["guess_channel"].format(round_id=game_round.id, mention=mention)
        else:
            latitude, longitude = game_round.location.latitude, game_round.location.longitude
            query = urlencode({"api": 1, "query": f"{latitude},{longitude}"})
            values = {
                "round_id": game_round.id,
                "latitude": latitude,
                "longitude": longitude,
                "maps_url": escape(f"https://www.google.com/maps/search/?{query}"),
            }
            if item.kind == "result":
                if item.distance_km is None or item.points is None:
                    raise ValueError("Result notification is missing distance or points")
                text = templates["result_private"].format(
                    **values, distance_km=f"{item.distance_km:.2f}", points=item.points
                )
            elif item.kind == "reveal":
                text = templates["reveal_channel"].format(**values, participants=item.participants)
            else:
                raise ValueError(f"Unsupported notification kind: {item.kind}")
        message = await self.bot.send_message(
            item.chat_id,
            text,
            parse_mode=ParseMode.HTML,
            link_preview_options=LinkPreviewOptions(is_disabled=True),
        )
        return message.message_id


def build_router(service: GameService, settings: Settings) -> Router:
    router = Router(name="training")
    router.message.filter(F.chat.type == ChatType.PRIVATE, F.from_user)
    templates = settings.text

    @router.message(CommandStart())
    async def start(message: Message, command: CommandObject) -> None:
        user = message.from_user
        if user is None:
            return
        if not command.args:
            await message.answer(f"{templates['welcome']}\n\nТвой Telegram ID: {user.id}")
            return
        payload = command.args.strip()
        round_id = None
        if payload.startswith(ROUND_PREFIX):
            round_id = _parse_round_id(payload.removeprefix(ROUND_PREFIX))
        status = service.open_round(round_id or 0, user.id)
        if status == "open":
            await message.answer(templates["round_prompt"].format(round_id=round_id))
        elif status == "duplicate":
            await message.answer(templates["guess_duplicate"])
        else:
            await message.answer(templates["round_closed"])

    @router.message(F.location)
    async def guess(message: Message) -> None:
        user, location = message.from_user, message.location
        if user is None or location is None:
            return
        if location.live_period is not None:
            await message.answer(templates["guess_live"])
            return
        status = service.submit_guess(user.id, user.full_name, location.latitude, location.longitude)
        template = {
            "accepted": "guess_accepted",
            "duplicate": "guess_duplicate",
            "closed": "round_closed",
            "no_round": "guess_no_round",
        }[status]
        await message.answer(templates[template])

    @router.message(Command("status", "sync", "next", "close", "pause", "resume"))
    async def administer(message: Message, command: CommandObject) -> None:
        user = message.from_user
        if user is None or user.id not in settings.admin_ids:
            await message.answer("Эта команда доступна администраторам.")
            return
        try:
            match command.command:
                case "status":
                    reply = service.status()
                case "sync":
                    count = await service.sync()
                    reply = f"Локаций в очереди: {count}."
                case "next":
                    round_id = await service.next_round((user.id, message.message_id))
                    if round_id is None:
                        reply = "В очереди нет подходящих локаций."
                    else:
                        reply = f"Раунд #{round_id} опубликован."
                case "close":
                    round_id = _parse_round_id((command.args or "").strip())
                    if round_id is None:
                        reply = "Укажи номер раунда. Например, /close 12."
                    elif await service.close_round(round_id):
                        reply = f"Раунд #{round_id} закрыт."
                    else:
                        reply = f"Раунд #{round_id} не найден или уже закрыт."
                case "pause":
                    service.pause()
                    reply = "Автоматические публикации приостановлены."
                case "resume":
                    service.resume()
                    reply = "Пауза снята. Публикации продолжатся, если расписание включено в настройках."
        except Exception as exc:
            logger.warning("Admin command /%s failed (%s)", command.command, type(exc).__name__)
            reply = "Не удалось выполнить команду. Подробности в логах бота."
        await message.answer(reply)

    return router
