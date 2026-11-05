import os
import re
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from string import Formatter
from zoneinfo import ZoneInfo

import yaml

TEXT_FIELDS = {
    "round_caption": {"round_id", "closes_at"},
    "guess_button": set(),
    "round_prompt": {"round_id"},
    "welcome": set(),
    "round_closed": set(),
    "guess_duplicate": set(),
    "guess_accepted": set(),
    "guess_no_round": set(),
    "guess_live": set(),
    "guess_channel": {"mention", "round_id"},
    "result_private": {"round_id", "latitude", "longitude", "distance_km", "points", "maps_url"},
    "reveal_channel": {"round_id", "latitude", "longitude", "participants", "maps_url"},
}
MEDIA_LIMITS = {"photo": 10_000_000, "video": 50_000_000, "animation": 50_000_000}


@dataclass(frozen=True)
class RoundTime:
    id: str
    publish: time
    reveal: time


@dataclass(frozen=True)
class Settings:
    token: str
    admin_ids: frozenset[int]
    channel: int | str
    announcement_channel: int | str
    database: Path
    credentials: Path
    auth_mode: str
    drive_root: str
    selection: str
    timezone: ZoneInfo
    schedule_enabled: bool
    check_interval: int
    publication_retry: int
    manual_duration: int
    rounds: tuple[RoundTime, ...]
    text: dict[str, str]


def chat_id(value: int | str) -> int | str:
    value = str(value).strip()
    if re.fullmatch(r"-[1-9]\d*", value):
        return int(value)
    if re.fullmatch(r"@[A-Za-z][A-Za-z0-9_]{3,31}", value):
        return value
    raise ValueError("Для канала укажите @username или отрицательный числовой ID")


def clock_time(value: str) -> time:
    if not isinstance(value, str) or not re.fullmatch(r"\d{2}:\d{2}", value):
        raise ValueError("Время расписания должно иметь формат HH:MM")
    return time.fromisoformat(value)


def positive_int(value: int, key: str) -> int:
    if type(value) is not int or value < 1:
        raise ValueError(f"{key} должен быть положительным целым числом")
    return value


def load_settings() -> Settings:
    path = Path(os.environ.get("SETTINGS_PATH", "config/settings.yaml"))
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if positive_int(raw["attempts_per_round"], "attempts_per_round") != 1:
        raise ValueError("В MVP attempts_per_round поддерживает только значение 1")

    schedule = raw["schedule"]
    if type(schedule["enabled"]) is not bool:
        raise ValueError("schedule.enabled должен быть true или false")
    rounds = []
    for rule in schedule["rounds"]:
        rule_id = rule["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", rule_id):
            raise ValueError("Некорректный ID записи расписания")
        publish, reveal = clock_time(rule["publish"]), clock_time(rule["reveal"])
        if publish == reveal or any(existing.id == rule_id for existing in rounds):
            raise ValueError("ID расписания должны быть уникальны, времена публикации и раскрытия различны")
        rounds.append(RoundTime(rule_id, publish, reveal))

    selection = raw["drive"]["selection"]
    auth_mode = os.environ.get("DRIVE_AUTH_MODE", "service_account")
    if selection not in {"sequential", "random"}:
        raise ValueError("drive.selection должен быть sequential или random")
    if auth_mode not in {"service_account", "oauth"}:
        raise ValueError("DRIVE_AUTH_MODE должен быть service_account или oauth")

    texts = raw["text"]
    for key, allowed_fields in TEXT_FIELDS.items():
        template = texts[key]
        if not isinstance(template, str) or not template.strip():
            raise ValueError(f"text.{key} должен быть непустой строкой")
        for _, field, spec, conversion in Formatter().parse(template):
            if field is not None and (field not in allowed_fields or spec or conversion):
                raise ValueError(f"Недопустимое поле шаблона text.{key}")

    ids = os.environ.get("ADMIN_IDS", "").strip()
    admin_ids = frozenset(int(value) for value in re.split(r"[,\s]+", ids)) if ids else frozenset()
    if any(value <= 0 for value in admin_ids):
        raise ValueError("ADMIN_IDS должен содержать положительные Telegram User ID")
    return Settings(
        token=os.environ.get("BOT_TOKEN", "").strip(),
        admin_ids=admin_ids,
        channel=chat_id(os.environ.get("TELEGRAM_CHANNEL") or raw["telegram"]["channel"]),
        announcement_channel=chat_id(
            os.environ.get("TELEGRAM_ANNOUNCEMENT_CHANNEL") or raw["telegram"]["announcement_channel"]
        ),
        database=Path(os.environ.get("DB_PATH", "data/bot.sqlite3")),
        credentials=Path(os.environ.get("DRIVE_CREDENTIALS_PATH", "secrets/service-account.json")),
        auth_mode=auth_mode,
        drive_root=raw["drive"]["root_folder_id"],
        selection=selection,
        timezone=ZoneInfo(raw["timezone"]),
        schedule_enabled=schedule["enabled"],
        check_interval=positive_int(schedule["check_interval_seconds"], "schedule.check_interval_seconds"),
        publication_retry=positive_int(schedule["publication_retry_seconds"], "schedule.publication_retry_seconds"),
        manual_duration=positive_int(schedule["manual_duration_minutes"], "schedule.manual_duration_minutes") * 60,
        rounds=tuple(rounds),
        text=texts,
    )
