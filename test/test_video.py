from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from prepare_video import MAX_BYTES, prepare


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
class VideoTests(unittest.TestCase):
    def test_portrait_and_landscape_remain_telegram_mp4_without_distortion(self):
        for width, height in [(180, 320), (320, 180)]:
            with self.subTest(width=width, height=height), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "source.mp4"
                output = Path(directory) / "telegram.mp4"
                subprocess.run([
                    "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                    f"testsrc2=size={width}x{height}:rate=5", "-t", "0.4",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source),
                ], check=True, capture_output=True)
                info = prepare(source, output)
                self.assertEqual(info["codec_name"], "h264")
                self.assertLessEqual(info["size"], MAX_BYTES)
                self.assertGreater(info["size"], 0)
                self.assertLessEqual(info["width"], 1920)
                self.assertLessEqual(info["height"], 1080)
                self.assertAlmostEqual(info["width"] / info["height"], width / height, delta=0.02)
