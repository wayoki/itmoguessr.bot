from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import Settings


@dataclass(frozen=True)
class Slot:
    key: str
    starts_at: float
    ends_at: float


def open_slots(now: float, settings: Settings) -> list[Slot]:
    today = datetime.fromtimestamp(now, settings.timezone).date()
    slots = []
    # Look back one calendar day for slots whose reveal time crosses midnight.
    for day in (today - timedelta(days=1), today):
        for rule in settings.rounds:
            reveal_day = day + timedelta(days=rule.reveal < rule.publish)
            starts_at = datetime.combine(day, rule.publish, settings.timezone).timestamp()
            ends_at = datetime.combine(reveal_day, rule.reveal, settings.timezone).timestamp()
            if starts_at <= now < ends_at:
                slots.append(Slot(f"{rule.id}:{day.isoformat()}", starts_at, ends_at))
    return sorted(slots, key=lambda slot: slot.starts_at)
