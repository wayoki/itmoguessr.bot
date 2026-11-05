import argparse
import asyncio
import logging
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfoNotFoundError

from aiogram import Bot, Dispatcher

from .config import MEDIA_LIMITS, Settings, load_settings
from .drive import DriveClient, DriveError
from .service import GameService
from .storage import Storage
from .telegram import TelegramGateway, build_router

logger = logging.getLogger(__name__)


def backup(source: Path, target: Path) -> None:
    if not source.is_file():
        raise ValueError("База SQLite ещё не создана")
    with target.open("xb"):
        pass
    try:
        uri = source.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as source_db, closing(sqlite3.connect(target)) as target_db:
            source_db.backup(target_db)
    except Exception:
        target.unlink(missing_ok=True)
        raise


async def check_drive(drive: DriveClient) -> None:
    locations = await drive.scan()
    logger.info("Подходящих по формату папок: %s", len(locations))
    for location in locations:
        limit = MEDIA_LIMITS[location.media_kind]
        if location.size_bytes is None or location.size_bytes <= limit:
            with TemporaryDirectory(prefix="itmoguessr-check-") as directory:
                path = Path(directory) / "location"
                await drive.download(location.file_id, path, limit)
                logger.info("Медиа скачано: %s, %s байт", location.media_kind, path.stat().st_size)
                return
    logger.warning("Доступ к корневой папке есть. Нет медиафайла подходящего размера для проверки загрузки.")


async def run(settings: Settings, drive: DriveClient) -> None:
    if not settings.token:
        raise ValueError("Заполните BOT_TOKEN в .env")
    settings.database.parent.mkdir(parents=True, exist_ok=True)
    with closing(Storage(settings.database)) as storage:
        async with Bot(settings.token) as bot:
            profile = await bot.me()
            await bot.delete_webhook(drop_pending_updates=False)
            service = GameService(settings, storage, drive, TelegramGateway(bot, settings))
            service.recover()
            dispatcher = Dispatcher()
            dispatcher.include_router(build_router(service, settings))
            logger.info("Запущен @%s. Канал раундов: %s", profile.username, settings.channel)
            async with asyncio.TaskGroup() as group:
                schedule = group.create_task(service.run_schedule())
                notifications = group.create_task(service.run_notifications())
                try:
                    await dispatcher.start_polling(bot, close_bot_session=False, allowed_updates=["message"])
                finally:
                    schedule.cancel()
                    notifications.cancel()


def main() -> None:
    parser = argparse.ArgumentParser(description="ITMOGUESSR* Telegram Training Bot")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--check-drive", action="store_true", help="Проверить чтение Google Drive без Telegram")
    modes.add_argument("--backup", metavar="PATH", type=Path, help="Записать резервную копию SQLite")
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        settings = load_settings()
        if args.backup:
            backup(settings.database, args.backup)
            logger.info("Резервная копия создана: %s", args.backup)
            return
        drive = DriveClient(settings.drive_root, settings.credentials, settings.auth_mode)
        asyncio.run(check_drive(drive) if args.check_drive else run(settings, drive))
    except (ValueError, KeyError, OSError, sqlite3.Error, ZoneInfoNotFoundError, DriveError) as exc:
        parser.exit(1, f"Ошибка: {exc}\n")


if __name__ == "__main__":
    main()
