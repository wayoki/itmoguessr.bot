import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from aiogram.exceptions import TelegramNetworkError
from aiogram.methods import SendPhoto

from bot.__main__ import backup
from bot.config import load_settings
from bot.drive import Location, UnusableMedia
from bot.schedule import open_slots
from bot.scoring import score_guess
from bot.service import GameService
from bot.storage import Storage


class FakeDrive:
    def __init__(self):
        self.locations = [
            Location("a", "a1", "a.jpg", 48.8566, 2.3522, "photo", 1),
            Location("b", "b1", "b.mp4", 35.0116, 135.7681, "video", 1),
        ]
        self.downloads = []
        self.bad_files = set()

    async def scan(self):
        return self.locations

    async def download(self, file_id, path, max_bytes):
        self.downloads.append(file_id)
        if file_id in self.bad_files:
            raise UnusableMedia("test fixture")
        path.write_bytes(b"a")


class FakeTelegram:
    def __init__(self):
        self.posts = []
        self.deliveries = []
        self.fail_publication = False

    async def publish(self, game_round, path):
        self.posts.append((game_round, path.read_bytes()))
        if self.fail_publication:
            raise TelegramNetworkError(method=SendPhoto(chat_id=-100123, photo="test"), message="test timeout")
        return len(self.posts)

    async def deliver(self, item, game_round):
        self.deliveries.append((item, game_round))
        return len(self.deliveries) + 100


class ServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(directory) / "test.sqlite3"
        self.settings = replace(load_settings(), channel=-100123, announcement_channel="@swidfkjew")
        self.drive = FakeDrive()
        self.telegram = FakeTelegram()
        self.storage = None
        self.at(5, 12)
        self.restart()
        self.addCleanup(lambda: self.storage.close())

    def at(self, day, hour):
        self.clock = datetime(2026, 11, day, hour, tzinfo=self.settings.timezone).timestamp()

    def restart(self):
        if self.storage is not None:
            self.storage.close()
        self.storage = Storage(self.path)
        self.service = GameService(self.settings, self.storage, self.drive, self.telegram, lambda: self.clock)
        self.service.recover()

    async def test_play_recover_and_reveal_once(self):
        await self.service.tick_schedule()
        self.assertEqual(self.drive.downloads, ["a1"])
        game_round, _ = self.telegram.posts[0]
        self.assertEqual(game_round.slot_key, "morning:2026-11-05")
        self.assertEqual(datetime.fromtimestamp(game_round.ends_at, self.settings.timezone).hour, 19)
        self.assertEqual(self.service.open_round(game_round.id, 42), "open")

        self.restart()
        await self.service.tick_schedule()
        self.assertEqual(len(self.telegram.posts), 1)
        self.assertEqual(self.service.submit_guess(42, "Игрок", 48.8566, 2.3522), "accepted")
        self.assertEqual(self.service.submit_guess(42, "Игрок", 50, 0), "duplicate")
        await self.service.tick_notifications()
        notice, _ = self.telegram.deliveries[0]
        self.assertEqual((notice.kind, notice.chat_id, notice.user_id), ("guess", "@swidfkjew", 42))
        self.assertIsNone(notice.distance_km)

        self.at(5, 19)
        self.assertEqual(self.service.submit_guess(42, "Игрок", 50, 0), "closed")
        self.restart()
        await self.service.tick_notifications()
        (_, _), (private, closed), (public, _) = self.telegram.deliveries
        self.assertEqual(closed.status, "closed")
        self.assertEqual((private.kind, private.chat_id, private.distance_km, private.points), ("result", 42, 0, 5000))
        self.assertEqual((public.kind, public.chat_id, public.participants), ("reveal", -100123, 1))
        self.assertEqual(self.service.open_round(game_round.id, 42), "closed")

        self.restart()
        await self.service.tick_notifications()
        await self.service.tick_schedule()
        self.assertEqual(len(self.telegram.deliveries), 3)
        self.assertEqual(len(self.telegram.posts), 1)

        self.at(6, 8)
        await self.service.tick_schedule()
        self.assertEqual(self.drive.downloads, ["a1", "b1"])
        evening, _ = self.telegram.posts[1]
        self.assertEqual(evening.slot_key, "evening:2026-11-05")
        self.assertEqual(datetime.fromtimestamp(evening.ends_at, self.settings.timezone).hour, 9)

    async def test_pause_persists_manual_round_still_closes(self):
        self.service.pause()
        self.restart()
        await self.service.tick_schedule()
        self.assertFalse(self.telegram.posts)
        game_round_id = await self.service.next_round()
        self.at(5, 15)
        await self.service.tick_notifications()
        self.assertEqual(self.storage.get_round(game_round_id).status, "closed")
        self.assertTrue(self.storage.is_paused())

    async def test_skip_unusable_file_and_no_replay_on_ambiguous_publication(self):
        self.drive.bad_files = {"a1"}
        self.telegram.fail_publication = True
        await self.service.tick_schedule()
        self.assertEqual(self.drive.downloads, ["a1", "b1"])
        self.assertEqual(self.storage.round_for_slot("morning:2026-11-05").status, "uncertain")
        self.restart()
        await self.service.tick_schedule()
        self.assertEqual(len(self.telegram.posts), 1)

    async def test_backup_copies_active_sqlite_database(self):
        round_id = await self.service.next_round()
        target = self.path.with_name("copy.sqlite3")
        backup(self.path, target)
        copy = Storage(target)
        self.addCleanup(copy.close)
        self.assertEqual(copy.get_round(round_id), self.storage.get_round(round_id))
        with self.assertRaises(FileExistsError):
            backup(self.path, target)

    async def test_replayed_next_command_does_not_publish_twice(self):
        round_id = await self.service.next_round((42, 10))
        self.restart()
        self.assertEqual(await self.service.next_round((42, 10)), round_id)
        self.assertEqual(len(self.telegram.posts), 1)

    def test_window_end_and_scoring_limits(self):
        self.at(6, 9)
        self.assertEqual(open_slots(self.clock, self.settings), [])
        distance, points = score_guess(0, 0, 0, 1)
        self.assertAlmostEqual(distance, 111.195, places=3)
        self.assertGreater(points, 0)
        self.assertLess(points, 5000)
        self.assertEqual(score_guess(0, 0, 0, 180)[1], 0)
