import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_schedule


class Opener:
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        outcome = next(self.outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return io.BytesIO(outcome)


class ActionsTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "ITMOGUESSR_MEDIA_ORIGIN": "https://bot.example",
            "ITMOGUESSR_MEDIA_KEY": "test-secret",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_verification_never_publishes(self):
        opener = Opener([b'{"items": [], "next": null}'])
        with patch.object(check_schedule.urllib.request, "build_opener", return_value=opener):
            check_schedule.check(verify=True)
        request = opener.requests[0]
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.full_url, "https://bot.example/media/queue?offset=0")
        self.assertEqual(request.get_header("X-itmoguessr-media-key"), "test-secret")

    def test_schedule_retries_transient_errors(self):
        error = urllib.error.HTTPError("https://bot.example", 503, "Unavailable", {}, None)
        opener = Opener([error, b"OK"])
        with patch.object(check_schedule.urllib.request, "build_opener", return_value=opener), \
                patch.object(check_schedule.time, "sleep"):
            check_schedule.check()
        self.assertEqual(len(opener.requests), 2)
        self.assertEqual(opener.requests[-1].method, "POST")

    def test_unauthorized_and_redirects_are_not_retried(self):
        for status in [302, 403]:
            opener = Opener([urllib.error.HTTPError("https://bot.example", status, "Denied", {}, None)])
            with patch.object(check_schedule.urllib.request, "build_opener", return_value=opener), \
                    self.assertRaisesRegex(ValueError, str(status)):
                check_schedule.check()
            self.assertEqual(len(opener.requests), 1)
        self.assertIsNone(check_schedule.RefuseRedirects().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_missing_key_and_unsafe_origins_fail_before_network(self):
        with patch.dict(os.environ, {"ITMOGUESSR_MEDIA_KEY": ""}), self.assertRaises(ValueError):
            check_schedule.configuration()
        for origin in ["http://bot.example", "https://user:pass@bot.example", "https://bot.example/path", "https://bot.example?x=1"]:
            with patch.dict(os.environ, {"ITMOGUESSR_MEDIA_ORIGIN": origin}), self.assertRaises(ValueError):
                check_schedule.configuration()


if __name__ == "__main__":
    unittest.main()
