"""SQLite persistence for rounds, guesses and Telegram deliveries."""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import sqlite3

from .drive import Location

ChatId = int | str
Scorer = Callable[[float, float, float, float], tuple[float, int]]


@dataclass(frozen=True)
class Round:
    id: int
    location: Location
    slot_key: str | None
    starts_at: float
    ends_at: float
    channel: ChatId
    status: str
    message_id: int | None
    closed_at: float | None


@dataclass(frozen=True)
class OutboxItem:
    id: int
    kind: str
    round_id: int
    chat_id: ChatId
    user_id: int | None
    user_name: str | None
    distance_km: float | None
    points: int | None
    participants: int | None
    attempts: int


SCHEMA = """
CREATE TABLE IF NOT EXISTS locations (
    folder_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    media_kind TEXT NOT NULL,
    size_bytes INTEGER,
    available INTEGER NOT NULL CHECK (available IN (0, 1))
);
CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES locations(folder_id),
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    media_kind TEXT NOT NULL,
    size_bytes INTEGER,
    slot_key TEXT UNIQUE,
    starts_at REAL NOT NULL,
    ends_at REAL NOT NULL CHECK (ends_at > starts_at),
    channel NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('reserved', 'publishing', 'active', 'closed', 'failed', 'uncertain')
    ),
    message_id INTEGER,
    closed_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS used_folder ON rounds(folder_id) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS due_rounds ON rounds(status, ends_at);
CREATE TABLE IF NOT EXISTS guesses (
    round_id INTEGER NOT NULL REFERENCES rounds(id),
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    submitted_at REAL NOT NULL,
    distance_km REAL,
    points INTEGER CHECK (points BETWEEN 0 AND 5000),
    PRIMARY KEY (round_id, user_id)
);
CREATE TABLE IF NOT EXISTS pending_rounds (
    user_id INTEGER PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES rounds(id)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('guess', 'result', 'reveal')),
    round_id INTEGER NOT NULL REFERENCES rounds(id),
    chat_id NOT NULL,
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'sending', 'sent', 'failed', 'uncertain')
    ),
    next_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    message_id INTEGER,
    FOREIGN KEY (round_id, user_id) REFERENCES guesses(round_id, user_id),
    CHECK ((kind = 'reveal') = (user_id IS NULL)),
    UNIQUE (kind, round_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_reveal ON outbox(round_id) WHERE kind = 'reveal';
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(status, next_at);
"""

AVAILABLE_LOCATIONS = """
    SELECT locations.* FROM locations
    WHERE available = 1 AND NOT EXISTS (
        SELECT 1 FROM rounds
        WHERE rounds.folder_id = locations.folder_id AND status <> 'failed'
    )
"""


def read_location(row: sqlite3.Row) -> Location:
    return Location(
        folder_id=row["folder_id"],
        file_id=row["file_id"],
        file_name=row["file_name"],
        latitude=row["latitude"],
        longitude=row["longitude"],
        media_kind=row["media_kind"],
        size_bytes=row["size_bytes"],
    )


def read_round(row: sqlite3.Row) -> Round:
    return Round(
        id=row["id"],
        location=read_location(row),
        slot_key=row["slot_key"],
        starts_at=row["starts_at"],
        ends_at=row["ends_at"],
        channel=row["channel"],
        status=row["status"],
        message_id=row["message_id"],
        closed_at=row["closed_at"],
    )


class Storage:
    def __init__(self, path: Path | str):
        self.connection = sqlite3.connect(path, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = FULL")
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.executescript(SCHEMA)

    def close(self) -> None:
        self.connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.connection.commit()
        except BaseException:
            self.connection.rollback()
            raise

    def recover_interrupted(self) -> tuple[int, int]:
        """Restore safe retries and leave potentially delivered sends for manual review."""
        with self._transaction():
            self.connection.execute("UPDATE rounds SET status = 'failed' WHERE status = 'reserved'")
            publications = self.connection.execute(
                "UPDATE rounds SET status = 'uncertain' WHERE status = 'publishing'"
            ).rowcount
            deliveries = self.connection.execute(
                "UPDATE outbox SET status = 'uncertain' WHERE status = 'sending'"
            ).rowcount
        return publications, deliveries

    def sync_locations(self, locations: list[Location]) -> None:
        with self._transaction():
            self.connection.execute("UPDATE locations SET available = 0 WHERE available = 1")
            self.connection.executemany(
                """
                INSERT INTO locations (
                    folder_id, file_id, file_name, latitude, longitude, media_kind, size_bytes, available
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(folder_id) DO UPDATE SET
                    file_id = excluded.file_id, file_name = excluded.file_name,
                    latitude = excluded.latitude, longitude = excluded.longitude,
                    media_kind = excluded.media_kind, size_bytes = excluded.size_bytes, available = 1
                """,
                [
                    (
                        item.folder_id,
                        item.file_id,
                        item.file_name,
                        item.latitude,
                        item.longitude,
                        item.media_kind,
                        item.size_bytes,
                    )
                    for item in locations
                ],
            )

    def available_locations(self) -> list[Location]:
        rows = self.connection.execute(AVAILABLE_LOCATIONS + " ORDER BY folder_id")
        return [read_location(row) for row in rows]

    def reserve_round(
        self,
        location: Location,
        slot_key: str | None,
        starts_at: float,
        ends_at: float,
        channel: ChatId,
    ) -> Round | None:
        with self._transaction():
            row = self.connection.execute(
                AVAILABLE_LOCATIONS + " AND locations.folder_id = ?", (location.folder_id,)
            ).fetchone()
            if row is None or read_location(row) != location:
                return None
            return_row = self.connection.execute(
                """
                INSERT INTO rounds (
                    folder_id, file_id, file_name, latitude, longitude, media_kind, size_bytes,
                    slot_key, starts_at, ends_at, channel, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')
                ON CONFLICT(slot_key) DO UPDATE SET
                    folder_id = excluded.folder_id, file_id = excluded.file_id,
                    file_name = excluded.file_name, latitude = excluded.latitude,
                    longitude = excluded.longitude, media_kind = excluded.media_kind,
                    size_bytes = excluded.size_bytes, starts_at = excluded.starts_at,
                    ends_at = excluded.ends_at, channel = excluded.channel, status = 'reserved'
                WHERE rounds.status = 'failed'
                RETURNING *
                """,
                (
                    row["folder_id"], row["file_id"], row["file_name"], row["latitude"],
                    row["longitude"], row["media_kind"], row["size_bytes"],
                    slot_key, starts_at, ends_at, channel,
                ),
            ).fetchone()
        return read_round(return_row) if return_row else None

    def get_round(self, round_id: int) -> Round | None:
        row = self.connection.execute("SELECT * FROM rounds WHERE id = ?", (round_id,)).fetchone()
        return read_round(row) if row else None

    def round_for_slot(self, slot_key: str) -> Round | None:
        row = self.connection.execute(
            "SELECT * FROM rounds WHERE slot_key = ?", (slot_key,)
        ).fetchone()
        return read_round(row) if row else None

    def active_rounds(self) -> list[Round]:
        rows = self.connection.execute("SELECT * FROM rounds WHERE status = 'active' ORDER BY ends_at")
        return [read_round(row) for row in rows]

    def due_rounds(self, now: float) -> list[Round]:
        rows = self.connection.execute(
            "SELECT * FROM rounds WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at", (now,)
        )
        return [read_round(row) for row in rows]

    def begin_publication(self, round_id: int) -> bool:
        return self.connection.execute(
            "UPDATE rounds SET status = 'publishing' WHERE id = ? AND status = 'reserved'", (round_id,)
        ).rowcount == 1

    def publication_succeeded(
        self, round_id: int, message_id: int, published_at: float | None = None
    ) -> None:
        changed = self.connection.execute(
            """
            UPDATE rounds SET status = 'active', message_id = ?,
                starts_at = CASE WHEN ? < ends_at THEN ? ELSE starts_at END
            WHERE id = ? AND status = 'publishing'
            """,
            (message_id, published_at, published_at, round_id),
        ).rowcount
        if changed != 1:
            raise RuntimeError(f"Round #{round_id} is not being published")

    def publication_failed(self, round_id: int, uncertain: bool = False) -> None:
        self.connection.execute(
            "UPDATE rounds SET status = ? WHERE id = ? AND status IN ('reserved', 'publishing')",
            ("uncertain" if uncertain else "failed", round_id),
        )

    def is_paused(self) -> bool:
        row = self.connection.execute(
            "SELECT value FROM settings WHERE key = 'paused'"
        ).fetchone()
        return bool(row and row["value"])

    def set_paused(self, paused: bool) -> None:
        self.connection.execute(
            "INSERT INTO settings VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (paused,),
        )

    def set_pending_round(self, user_id: int, round_id: int) -> None:
        self.connection.execute(
            """
            INSERT INTO pending_rounds(user_id, round_id) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET round_id = excluded.round_id
            """,
            (user_id, round_id),
        )

    def get_pending_round(self, user_id: int) -> int | None:
        row = self.connection.execute(
            "SELECT round_id FROM pending_rounds WHERE user_id = ?", (user_id,)
        ).fetchone()
        return row["round_id"] if row else None

    def clear_pending_round(self, user_id: int) -> None:
        self.connection.execute("DELETE FROM pending_rounds WHERE user_id = ?", (user_id,))

    def has_guess(self, round_id: int, user_id: int) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM guesses WHERE round_id = ? AND user_id = ?", (round_id, user_id)
        ).fetchone() is not None

    def submit_guess(
        self,
        round_id: int,
        user_id: int,
        user_name: str,
        latitude: float,
        longitude: float,
        now: float,
        announcement_channel: ChatId,
    ) -> str:
        with self._transaction():
            row = self.connection.execute(
                "SELECT status, ends_at FROM rounds WHERE id = ?", (round_id,)
            ).fetchone()
            if row is None or row["status"] != "active" or now >= row["ends_at"]:
                return "closed"
            inserted = self.connection.execute(
                """
                INSERT INTO guesses (round_id, user_id, user_name, latitude, longitude, submitted_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(round_id, user_id) DO NOTHING
                """,
                (round_id, user_id, user_name, latitude, longitude, now),
            ).rowcount
            if not inserted:
                return "duplicate"
            self.connection.execute(
                "INSERT INTO outbox(kind, round_id, chat_id, user_id, next_at) VALUES ('guess', ?, ?, ?, ?)",
                (round_id, announcement_channel, user_id, now),
            )
        return "accepted"

    def close_round(self, round_id: int, now: float, scorer: Scorer) -> bool:
        with self._transaction():
            item = self.get_round(round_id)
            if item is None or item.status != "active":
                return False
            self.connection.execute(
                "UPDATE rounds SET status = 'closed', closed_at = ? WHERE id = ?", (now, round_id)
            )
            guesses = self.connection.execute(
                "SELECT user_id, latitude, longitude FROM guesses WHERE round_id = ? ORDER BY user_id",
                (round_id,),
            ).fetchall()
            for guess in guesses:
                distance, points = scorer(
                    guess["latitude"], guess["longitude"], item.location.latitude, item.location.longitude
                )
                self.connection.execute(
                    "UPDATE guesses SET distance_km = ?, points = ? WHERE round_id = ? AND user_id = ?",
                    (distance, points, round_id, guess["user_id"]),
                )
            self.connection.executemany(
                "INSERT INTO outbox(kind, round_id, chat_id, user_id, next_at) VALUES ('result', ?, ?, ?, ?)",
                [(round_id, guess["user_id"], guess["user_id"], now) for guess in guesses],
            )
            self.connection.execute(
                "INSERT INTO outbox(kind, round_id, chat_id, next_at) VALUES ('reveal', ?, ?, ?)",
                (round_id, item.channel, now),
            )
        return True

    def claim_outbox(self, now: float) -> OutboxItem | None:
        with self._transaction():
            row = self.connection.execute(
                """
                UPDATE outbox SET status = 'sending', attempts = attempts + 1
                WHERE id = (
                    SELECT id FROM outbox WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT 1
                )
                RETURNING id, kind, round_id, chat_id, user_id, attempts
                """,
                (now,),
            ).fetchone()
            if row is None:
                return None
            guess = None
            participants = None
            if row["user_id"] is not None:
                guess = self.connection.execute(
                    "SELECT user_name, distance_km, points FROM guesses WHERE round_id = ? AND user_id = ?",
                    (row["round_id"], row["user_id"]),
                ).fetchone()
            else:
                participants = self.connection.execute(
                    "SELECT COUNT(*) FROM guesses WHERE round_id = ?", (row["round_id"],)
                ).fetchone()[0]
        return OutboxItem(
            **dict(row),
            user_name=guess["user_name"] if guess else None,
            distance_km=guess["distance_km"] if guess else None,
            points=guess["points"] if guess else None,
            participants=participants,
        )

    def finish_outbox(self, item_id: int, status: str, message_id: int | None = None) -> None:
        if status not in {"sent", "failed", "uncertain"}:
            raise ValueError(f"Invalid outbox final status {status!r}")
        self.connection.execute(
            "UPDATE outbox SET status = ?, message_id = ? WHERE id = ? AND status = 'sending'",
            (status, message_id, item_id),
        )

    def retry_outbox(self, item_id: int, next_at: float) -> None:
        self.connection.execute(
            "UPDATE outbox SET status = 'pending', next_at = ? WHERE id = ? AND status = 'sending'",
            (next_at, item_id),
        )

    def status_counts(self) -> tuple[int, int, int, int]:
        available = self.connection.execute(
            f"SELECT COUNT(*) FROM ({AVAILABLE_LOCATIONS})"
        ).fetchone()[0]
        uncertain_publications = self.connection.execute(
            "SELECT COUNT(*) FROM rounds WHERE status = 'uncertain'"
        ).fetchone()[0]
        deliveries = dict(self.connection.execute(
            "SELECT status, COUNT(*) FROM outbox WHERE status IN ('uncertain', 'failed') GROUP BY status"
        ))
        return available, uncertain_publications, deliveries.get("uncertain", 0), deliveries.get("failed", 0)
