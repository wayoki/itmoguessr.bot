from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from unittest import TestCase

from bot.drive import Location
from bot.storage import Storage


class StorageTest(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "bot.sqlite3"
        self.store = Storage(self.path)
        self.addCleanup(lambda: self.store.close())
        self.first = Location("folder-a", "file-a", "a.jpg", 35.0116, 135.7681, "photo")
        self.second = Location("folder-b", "file-b", "b.mp4", 59.9343, 30.3351, "video")
        self.store.sync_locations([self.first, self.second])

    def reopen(self):
        self.store.close()
        self.store = Storage(self.path)

    def active_round(self):
        item = self.store.reserve_round(self.first, "morning", 10, 20, -100123)
        self.assertTrue(self.store.begin_publication(item.id))
        self.store.publication_succeeded(item.id, 14, published_at=11)
        return self.store.get_round(item.id)

    def test_retry_definite_failure_and_preserve_published_location_snapshot(self):
        item = self.store.reserve_round(self.first, "morning", 10, 20, -100123)
        self.assertIsNone(self.store.reserve_round(self.second, "morning", 10, 20, -100123))
        self.assertIsNone(self.store.reserve_round(self.first, "evening", 20, 30, -100123))

        self.store.publication_failed(item.id)
        retried = self.store.reserve_round(self.second, "morning", 12, 20, "@channel")
        self.assertEqual(retried.id, item.id)
        self.assertTrue(self.store.begin_publication(retried.id))
        self.assertFalse(self.store.begin_publication(retried.id))
        self.store.publication_succeeded(retried.id, 14)
        self.store.sync_locations([self.first, replace(self.second, latitude=50, file_id="renamed")])

        published = self.store.round_for_slot("morning")
        self.assertEqual(published.location, self.second)
        self.assertEqual(published.channel, "@channel")
        self.assertEqual(published.message_id, 14)
        self.assertEqual(self.store.available_locations(), [self.first])

    def test_accepts_one_concurrent_guess_and_rejects_at_deadline(self):
        item = self.active_round()
        barrier = Barrier(2, timeout=5)

        def attempt():
            store = Storage(self.path)
            try:
                barrier.wait()
                return store.submit_guess(item.id, 42, "Игрок", 35, 135, 19, "@announcements")
            finally:
                store.close()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: attempt(), range(2)))

        self.assertCountEqual(outcomes, ["accepted", "duplicate"])
        self.assertTrue(self.store.has_guess(item.id, 42))
        self.assertEqual(
            self.store.submit_guess(item.id, 43, "Игрок", 35, 135, 20, "@announcements"), "closed"
        )
        self.assertEqual(self.store.due_rounds(20), [item])
        notice = self.store.claim_outbox(20)
        self.assertEqual((notice.kind, notice.user_id, notice.chat_id), ("guess", 42, "@announcements"))
        self.assertIsNone(self.store.claim_outbox(20))

    def test_closing_and_notifications_are_durable_across_restart(self):
        item = self.active_round()
        self.store.set_pending_round(42, item.id)
        self.store.set_paused(True)
        self.store.submit_guess(item.id, 42, "Игрок", 35, 135, 19, "@announcements")
        notice = self.store.claim_outbox(19)
        self.store.finish_outbox(notice.id, "sent", 77)

        def scorer(latitude, longitude, target_latitude, target_longitude):
            self.assertEqual((latitude, longitude, target_latitude, target_longitude), (35, 135, 35.0116, 135.7681))
            return 70.0, 4900

        self.assertTrue(self.store.close_round(item.id, 20, scorer))
        self.reopen()
        self.assertEqual(self.store.recover_interrupted(), (0, 0))
        self.assertEqual(self.store.get_pending_round(42), item.id)
        self.assertTrue(self.store.is_paused())
        self.assertFalse(self.store.close_round(item.id, 21, scorer))
        result = self.store.claim_outbox(21)
        self.assertEqual((result.kind, result.chat_id, result.distance_km, result.points), ("result", 42, 70.0, 4900))
        self.store.retry_outbox(result.id, 30)
        reveal = self.store.claim_outbox(21)
        self.assertEqual((reveal.kind, reveal.chat_id, reveal.participants), ("reveal", -100123, 1))
        self.store.finish_outbox(reveal.id, "sent", 78)
        self.assertIsNone(self.store.claim_outbox(29))
        self.assertEqual(self.store.claim_outbox(30).attempts, 2)
        self.store.finish_outbox(result.id, "sent", 79)

        self.reopen()
        self.assertEqual(self.store.get_round(item.id).closed_at, 20)
        self.assertIsNone(self.store.claim_outbox(40))

    def test_restart_never_retries_uncertain_telegram_sends(self):
        item = self.active_round()
        self.store.submit_guess(item.id, 42, "Игрок", 35, 135, 19, "@announcements")
        self.store.claim_outbox(19)
        next_item = self.store.reserve_round(self.second, "evening", 20, 30, "@channel")
        self.store.begin_publication(next_item.id)

        self.reopen()
        self.assertEqual(self.store.recover_interrupted(), (1, 1))
        self.assertEqual(self.store.status_counts(), (0, 1, 1, 0))
        self.assertEqual(self.store.round_for_slot("evening").status, "uncertain")
        self.assertIsNone(self.store.claim_outbox(20))
        self.assertIsNone(self.store.reserve_round(self.second, "evening", 20, 30, "@channel"))
