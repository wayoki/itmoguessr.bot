import asyncio
import logging
import random
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from time import time

from aiogram.exceptions import (
    TelegramBadRequest,
    TelegramEntityTooLarge,
    TelegramForbiddenError,
    TelegramMigrateToChat,
    TelegramNotFound,
    TelegramRetryAfter,
    TelegramUnauthorizedError,
)

from .config import MEDIA_LIMITS, Settings
from .drive import DriveClient, DriveError, UnusableMedia
from .schedule import Slot, open_slots
from .scoring import score_guess
from .storage import Storage
from .telegram import TelegramGateway

logger = logging.getLogger(__name__)

REJECTED_BY_TELEGRAM = (
    TelegramBadRequest,
    TelegramEntityTooLarge,
    TelegramForbiddenError,
    TelegramMigrateToChat,
    TelegramNotFound,
    TelegramUnauthorizedError,
)
PUBLICATION_REJECTIONS = (*REJECTED_BY_TELEGRAM, TelegramRetryAfter)
MEDIA_ERROR_MARKERS = (
    "photo_invalid_dimensions",
    "image_process_failed",
    "failed to process image",
    "video_content_type_invalid",
    "wrong type of the web page content",
    "file is too big",
)
OUTBOX_BATCH_SIZE = 50


class GameService:
    def __init__(
        self,
        settings: Settings,
        storage: Storage,
        drive: DriveClient,
        telegram: TelegramGateway,
        now: Callable[[], float] = time,
    ):
        self.settings = settings
        self.storage = storage
        self.drive = drive
        self.telegram = telegram
        self.now = now
        self.publication_lock = asyncio.Lock()
        self.sync_lock = asyncio.Lock()
        self.wake_outbox = asyncio.Event()
        self.retry_slots: dict[str, float] = {}

    def recover(self) -> None:
        publications, deliveries = self.storage.recover_interrupted()
        if publications or deliveries:
            logger.warning(
                "После прерывания требуют проверки публикации (%s) и уведомления (%s)",
                publications,
                deliveries,
            )

    def open_round(self, round_id: int, user_id: int) -> str:
        game_round = self.storage.get_round(round_id)
        if game_round is None:
            self.storage.clear_pending_round(user_id)
            return "closed"
        self.storage.set_pending_round(user_id, round_id)
        if game_round.status != "active" or self.now() >= game_round.ends_at:
            return "closed"
        return "duplicate" if self.storage.has_guess(round_id, user_id) else "open"

    def submit_guess(self, user_id: int, user_name: str, latitude: float, longitude: float) -> str:
        round_id = self.storage.get_pending_round(user_id)
        if round_id is None:
            return "no_round"
        status = self.storage.submit_guess(
            round_id, user_id, user_name, latitude, longitude, self.now(),
            self.settings.announcement_channel,
        )
        if status == "accepted":
            self.wake_outbox.set()
        return status

    def status(self) -> str:
        mode = "выключено в YAML"
        if self.settings.schedule_enabled:
            mode = "на паузе" if self.storage.is_paused() else "включено"
        available, publications, uncertain, failed = self.storage.status_counts()
        lines = [
            f"Расписание: {mode}.",
            f"Неиспользованных локаций после последней синхронизации: {available}.",
            f"Публикаций с неизвестным исходом: {publications}.",
            f"Уведомлений с неизвестным исходом: {uncertain}. Отклонено Telegram: {failed}.",
        ]
        active = [item for item in self.storage.active_rounds() if self.now() < item.ends_at]
        if not active:
            lines.append("Активных раундов нет.")
        for item in active:
            deadline = datetime.fromtimestamp(item.ends_at, self.settings.timezone)
            lines.append(f"Раунд #{item.id}, приём до {deadline:%d.%m %H:%M %Z}.")
        return "\n".join(lines)

    async def sync(self) -> int:
        async with self.sync_lock:
            try:
                locations = await self.drive.scan()
            except DriveError as exc:
                logger.warning("Синхронизация Drive: %s", exc)
                raise
            suitable = []
            for location in locations:
                if location.size_bytes is None or location.size_bytes <= MEDIA_LIMITS[location.media_kind]:
                    suitable.append(location)
                else:
                    logger.warning("Папка Drive %s пропущена. Превышен лимит Telegram", location.folder_id)
            self.storage.sync_locations(suitable)
            available = len(self.storage.available_locations())
            logger.info("Синхронизация Drive завершена. Локаций в очереди: %s", available)
            return available

    def pause(self) -> None:
        self.storage.set_paused(True)

    def resume(self) -> None:
        self.storage.set_paused(False)

    async def next_round(self, request_id: tuple[int, int] | None = None) -> int | None:
        command_key = f"command:{request_id[0]}:{request_id[1]}" if request_id else None
        return await self.publish_round(command_key=command_key)

    def automatic_available(self, slot: Slot) -> bool:
        existing = self.storage.round_for_slot(slot.key)
        return (
            self.settings.schedule_enabled
            and not self.storage.is_paused()
            and slot.starts_at <= self.now() < slot.ends_at
            and (existing is None or existing.status == "failed")
        )

    async def publish_round(self, slot: Slot | None = None, *, command_key: str | None = None) -> int | None:
        async with self.publication_lock:
            if slot and not self.automatic_available(slot):
                return None
            if command_key:
                existing = self.storage.round_for_slot(command_key)
                if existing and existing.status != "failed":
                    if existing.message_id is None:
                        raise RuntimeError("Исход этой команды /next неизвестен")
                    return existing.id
            await self.sync()
            candidates = self.storage.available_locations()
            if self.settings.selection == "random":
                random.shuffle(candidates)
            else:
                candidates.sort(key=lambda item: (item.file_name.casefold(), item.folder_id))

            for location in candidates:
                if slot and not self.automatic_available(slot):
                    return None
                with TemporaryDirectory(prefix="itmoguessr-") as directory:
                    path = Path(directory) / "location"
                    try:
                        await self.drive.download(location.file_id, path, MEDIA_LIMITS[location.media_kind])
                    except DriveError as exc:
                        logger.warning("Загрузка медиа из Drive: %s", exc)
                        if exc.status == 404 or isinstance(exc, UnusableMedia):
                            continue
                        raise
                    if slot and not self.automatic_available(slot):
                        return None
                    now = self.now()
                    ends_at = slot.ends_at if slot else now + self.settings.manual_duration
                    if ends_at <= now:
                        return None
                    game_round = self.storage.reserve_round(
                        location, slot.key if slot else command_key, now, ends_at, self.settings.channel
                    )
                    if game_round is None:
                        continue
                    if not self.storage.begin_publication(game_round.id):
                        raise RuntimeError("Не удалось зарезервировать отправку раунда")

                    try:
                        message_id = await self.telegram.publish(game_round, path)
                    except PUBLICATION_REJECTIONS as exc:
                        self.storage.publication_failed(game_round.id)
                        logger.warning("Telegram отклонил публикацию раунда #%s (%s)", game_round.id, type(exc).__name__)
                        if isinstance(exc, TelegramEntityTooLarge) or (
                            isinstance(exc, TelegramBadRequest)
                            and any(marker in exc.message.casefold() for marker in MEDIA_ERROR_MARKERS)
                        ):
                            continue
                        raise
                    except Exception as exc:
                        # An upload can be accepted even if the response never arrives.
                        self.storage.publication_failed(game_round.id, uncertain=True)
                        logger.warning("Исход публикации раунда #%s неизвестен (%s)", game_round.id, type(exc).__name__)
                        raise

                    self.storage.publication_succeeded(game_round.id, message_id, self.now())
                    logger.info("Раунд #%s опубликован", game_round.id)
                    return game_round.id
            return None

    async def close_round(self, round_id: int) -> bool:
        closed = self.storage.close_round(round_id, self.now(), score_guess)
        if closed:
            self.wake_outbox.set()
            logger.info("Раунд #%s закрыт", round_id)
        return closed

    async def tick_schedule(self) -> None:
        if not self.settings.schedule_enabled or self.storage.is_paused():
            return
        slots = open_slots(self.now(), self.settings)
        self.retry_slots = {
            slot.key: self.retry_slots[slot.key] for slot in slots if slot.key in self.retry_slots
        }
        for slot in slots:
            if not self.automatic_available(slot) or self.now() < self.retry_slots.get(slot.key, 0):
                continue
            try:
                await self.publish_round(slot)
            except TelegramRetryAfter as exc:
                delay = max(exc.retry_after + 1, self.settings.publication_retry)
            except Exception as exc:
                logger.warning("Ошибка автопубликации %s (%s)", slot.key, type(exc).__name__)
                delay = self.settings.publication_retry
            else:
                delay = self.settings.publication_retry
            self.retry_slots[slot.key] = self.now() + delay

    async def tick_notifications(self) -> bool:
        for game_round in self.storage.due_rounds(self.now()):
            await self.close_round(game_round.id)

        for _ in range(OUTBOX_BATCH_SIZE):
            item = self.storage.claim_outbox(self.now())
            if item is None:
                return False
            game_round = self.storage.get_round(item.round_id)
            try:
                message_id = await self.telegram.deliver(item, game_round)
            except TelegramRetryAfter as exc:
                self.storage.retry_outbox(item.id, self.now() + exc.retry_after + 1)
            except REJECTED_BY_TELEGRAM as exc:
                self.storage.finish_outbox(item.id, "failed")
                logger.warning("Telegram отклонил уведомление %s раунда #%s (%s)", item.kind, item.round_id, type(exc).__name__)
            except Exception as exc:
                self.storage.finish_outbox(item.id, "uncertain")
                logger.warning("Исход уведомления %s раунда #%s неизвестен (%s)", item.kind, item.round_id, type(exc).__name__)
            else:
                self.storage.finish_outbox(item.id, "sent", message_id)
        return True

    async def run_schedule(self) -> None:
        while True:
            await self.tick_schedule()
            await asyncio.sleep(self.settings.check_interval)

    async def run_notifications(self) -> None:
        while True:
            self.wake_outbox.clear()
            more = await self.tick_notifications()
            if more:
                continue
            try:
                await asyncio.wait_for(self.wake_outbox.wait(), self.settings.check_interval)
            except TimeoutError:
                pass
