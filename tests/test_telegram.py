from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock
from zoneinfo import ZoneInfo

from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.methods import GetMe, SendAnimation, SendMessage, SendPhoto, SendVideo
from aiogram.types import Update, User

from bot.telegram import TelegramGateway, build_router


class RecordingSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.requests = []

    async def make_request(self, bot, method, timeout=None):
        self.requests.append(method)
        if isinstance(method, GetMe):
            return User(id=bot.id, is_bot=True, first_name="Test", username="test_training_bot")
        return SimpleNamespace(message_id=101)

    async def close(self):
        pass

    async def stream_content(self, *args, **kwargs):
        raise AssertionError("Unit tests must not access the network")
        yield b""


class TelegramTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.session = RecordingSession()
        self.bot = Bot("123456:unit-test", session=self.session)
        self.settings = SimpleNamespace(
            timezone=ZoneInfo("Europe/Moscow"),
            admin_ids=frozenset({10}),
            text={
                "round_caption": "Раунд #{round_id} до {closes_at}",
                "guess_button": "Сделать предположение",
                "round_prompt": "Выбери точку для #{round_id}",
                "welcome": "Привет",
                "round_closed": "Раунд закрыт",
                "guess_duplicate": "Попытка использована",
                "guess_accepted": "Принято",
                "guess_no_round": "Сначала выбери раунд",
                "guess_live": "Отправь обычную точку",
                "guess_channel": "{mention} сделал предположение в раунде #{round_id}",
                "result_private": (
                    '{latitude}, {longitude} · {distance_km} км · {points} · <a href="{maps_url}">Карта</a>'
                ),
                "reveal_channel": "#{round_id} · {latitude}, {longitude} · {participants} · {maps_url}",
            },
        )
        self.service = Mock()
        self.dispatcher = Dispatcher()
        self.dispatcher.include_router(build_router(self.service, self.settings))
        self.gateway = TelegramGateway(self.bot, self.settings)
        self.game_round = SimpleNamespace(
            id=12,
            channel="@test_channel",
            ends_at=1783353600,
            location=SimpleNamespace(latitude=59.9343, longitude=30.3351),
        )

    async def message(self, user_id=10, private=True, **content):
        await self.dispatcher.feed_update(
            self.bot,
            Update.model_validate({
                "update_id": 1,
                "message": {
                    "message_id": 1,
                    "date": 1783353600,
                    "chat": {"id": user_id if private else -1, "type": "private" if private else "group"},
                    "from": {"id": user_id, "is_bot": False, "first_name": "Игрок"},
                    **content,
                },
            }),
        )

    async def test_publication_methods_and_neutral_filenames(self):
        cases = (
            ("photo", "answer.PNG", SendPhoto, "photo", "round-12.png"),
            ("video", "answer.MP4", SendVideo, "video", "round-12.mp4"),
            ("animation", "answer.GIF", SendAnimation, "animation", "round-12.gif"),
        )
        for kind, filename, method, field, upload in cases:
            with self.subTest(kind=kind):
                self.game_round.location.media_kind = kind
                self.game_round.location.file_name = filename
                self.assertEqual(await self.gateway.publish(self.game_round, Path(filename)), 101)
                request = self.session.requests[-1]
                self.assertIsInstance(request, method)
                self.assertEqual(getattr(request, field).filename, upload)
                self.assertEqual(request.chat_id, "@test_channel")
                self.assertNotIn("59.9343", request.caption)
                button = request.reply_markup.inline_keyboard[0][0]
                self.assertEqual(button.url, "https://t.me/test_training_bot?start=round_12")

    async def test_start_and_static_point_use_private_chat(self):
        self.service.open_round.return_value = "open"
        self.service.submit_guess.return_value = "accepted"
        await self.message(text="/start round_12")
        self.service.open_round.assert_called_once_with(12, 10)
        prompt = self.session.requests[-1]
        self.assertEqual(prompt.text, "Выбери точку для #12")
        self.assertIsNone(prompt.reply_markup)
        point = {"latitude": 12.3, "longitude": -45.6}
        await self.message(private=False, location=point)
        await self.message(location={**point, "live_period": 60})
        self.service.submit_guess.assert_not_called()
        self.assertEqual(self.session.requests[-1].text, "Отправь обычную точку")
        await self.message(location=point)
        self.service.submit_guess.assert_called_once_with(10, "Игрок", 12.3, -45.6)
        self.assertEqual(self.session.requests[-1].text, "Принято")

    async def test_closed_and_duplicate_deep_links(self):
        self.service.open_round.return_value = "closed"
        await self.message(text="/start round_12")
        self.assertEqual(self.session.requests[-1].text, "Раунд закрыт")
        self.service.open_round.return_value = "duplicate"
        await self.message(text="/start round_12")
        self.assertEqual(self.session.requests[-1].text, "Попытка использована")

    async def test_invalid_deep_link_replaces_prior_selection(self):
        self.service.open_round.return_value = "closed"
        await self.message(text="/start round_9223372036854775808")
        self.service.open_round.assert_called_once_with(0, 10)
        self.assertEqual(self.session.requests[-1].text, "Раунд закрыт")

    async def test_admin_commands_check_chat_and_id(self):
        await self.message(private=False, text="/status")
        await self.message(user_id=11, text="/status")
        self.service.status.assert_not_called()
        self.assertEqual(self.session.requests[-1].text, "Эта команда доступна администраторам.")
        self.service.status.return_value = "Всё работает"
        await self.message(text="/status")
        self.service.status.assert_called_once_with()
        self.assertEqual(self.session.requests[-1].text, "Всё работает")

    async def test_notification_content_and_targets(self):
        guess = SimpleNamespace(kind="guess", chat_id="@test_channel", user_id=42, user_name="<Игрок & Ко>")
        self.assertEqual(await self.gateway.deliver(guess, self.game_round), 101)
        notice = self.session.requests[-1]
        self.assertIsInstance(notice, SendMessage)
        self.assertEqual(notice.chat_id, "@test_channel")
        self.assertEqual(notice.text, '<a href="tg://user?id=42">&lt;Игрок &amp; Ко&gt;</a> сделал предположение в раунде #12')
        self.assertNotIn("59.9343", notice.text)
        result = SimpleNamespace(kind="result", chat_id=42, distance_km=10.125, points=4980)
        await self.gateway.deliver(result, self.game_round)
        private_message = self.session.requests[-1]
        self.assertEqual(private_message.chat_id, 42)
        self.assertIn("59.9343, 30.3351", private_message.text)
        self.assertIn("10.12 км", private_message.text)
        self.assertIn("4980", private_message.text)
        self.assertIn("https://www.google.com/maps/search/?api=1&amp;query=59.9343%2C30.3351", private_message.text)
        reveal = SimpleNamespace(kind="reveal", chat_id="@test_channel", participants=1)
        await self.gateway.deliver(reveal, self.game_round)
        public_message = self.session.requests[-1]
        self.assertEqual(public_message.chat_id, "@test_channel")
        self.assertIn("#12 · 59.9343, 30.3351 · 1", public_message.text)
