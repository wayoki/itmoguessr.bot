import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from bot.drive import FILES_URL, FOLDER_MIME, DriveClient, DriveError, Location, parse_coordinates


def response(*, status=200, payload=None, chunks=()):
    result = MagicMock()
    result.__enter__.return_value = result
    result.status_code = status
    result.headers = {}
    result.json.return_value = payload
    result.iter_content.return_value = iter(chunks)
    return result


class CoordinatesTest(unittest.TestCase):
    def test_decimal_pairs(self):
        self.assertEqual(parse_coordinates("35.0116, 135.7681"), (35.0116, 135.7681))
        self.assertEqual(parse_coordinates("  -90,+180 "), (-90, 180))
        self.assertEqual(parse_coordinates("-.5, +.05"), (-0.5, 0.05))

    def test_invalid_coordinates(self):
        for name in ("nan, 1", "1, infinity", "1e-3, 1", "90.1, 0", "1, -181", "1, 2, 3", "Paris"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                parse_coordinates(name)


class DriveTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.drive = DriveClient("root-id", Path("unused.json"), "service_account")
        self.session = MagicMock()
        self.session.__enter__.return_value = self.session
        session_patch = patch.object(self.drive, "_session", return_value=self.session)
        session_patch.start()
        self.addCleanup(session_patch.stop)

    async def test_scan_paginates_and_skips_invalid_folders(self):
        requests = []

        def get(url, *, params, **kwargs):
            requests.append((url, dict(params)))
            if url == f"{FILES_URL}/root-id":
                return response(payload={"mimeType": FOLDER_MIME})
            if "'root-id'" in params["q"]:
                if params.get("pageToken") == "second":
                    return response(payload={"files": [{"id": "ambiguous", "name": "0, 0"}]})
                return response(payload={
                    "nextPageToken": "second",
                    "files": [{"id": "broken", "name": "Paris"}, {"id": "valid", "name": "48.8566, 2.3522"}],
                })
            if "'valid'" in params["q"]:
                return response(payload={"files": [
                    {"id": "photo", "name": "any name", "mimeType": "image/jpeg", "size": "100"},
                    {"id": "unsupported", "name": "test.pdf", "mimeType": "application/pdf"},
                ]})
            if "'ambiguous'" in params["q"]:
                return response(payload={"files": [
                    {"id": "a", "name": "a.MP4", "mimeType": "application/octet-stream"},
                    {"id": "b", "name": "b.gif", "mimeType": "image/gif"},
                ]})
            self.fail(f"Unexpected request for {url}: {params}")

        self.session.get.side_effect = get
        with self.assertLogs("bot.drive", "WARNING") as captured:
            locations = await self.drive.scan()

        self.assertEqual(locations, [Location("valid", "photo", "any name", 48.8566, 2.3522, "photo", 100)])
        self.assertEqual(len(captured.records), 2)
        self.assertEqual([params.get("pageToken") for _, params in requests], [None, None, None, "second", None])

    async def test_unavailable_root_is_not_an_empty_queue(self):
        self.session.get.return_value = response(status=404)
        with self.assertRaises(DriveError) as raised:
            await self.drive.scan()
        self.assertEqual(raised.exception.status, 404)

    async def test_streams_media_into_file(self):
        self.session.get.return_value = response(chunks=(b"image ", b"contents"))
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "media"
            await self.drive.download("file-id", destination, max_bytes=14)
            self.assertEqual(destination.read_bytes(), b"image contents")
        self.session.get.assert_called_once()
        args, kwargs = self.session.get.call_args
        self.assertEqual(args[0], f"{FILES_URL}/file-id")
        self.assertEqual(kwargs["params"]["alt"], "media")
        self.assertTrue(kwargs["stream"])

    async def test_download_cleans_partial_file_and_preserves_destination_on_failure(self):
        self.session.get.return_value = response(chunks=(b"123", b"456"))
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "media"
            destination.write_bytes(b"existing")
            with self.assertRaises(DriveError):
                await self.drive.download("file-id", destination, max_bytes=4)
            self.assertEqual(list(Path(folder).iterdir()), [destination])
            self.assertEqual(destination.read_bytes(), b"existing")
