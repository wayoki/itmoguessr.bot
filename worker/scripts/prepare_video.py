"""Prepare a Telegram MP4 while keeping the input video's display aspect ratio."""

import argparse
import json
import math
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

MAX_BYTES = 50_000_000
TARGET_BYTES = 38_000_000


def media_info(path: Path) -> dict:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,codec_name:format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(probe.stdout)
    return {**data["streams"][0], "duration": float(data["format"]["duration"])}


def prepare(source: Path, target: Path, speed: float = 1) -> dict:
    if target.exists():
        raise ValueError("Output already exists")
    duration = media_info(source)["duration"] / speed
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid video duration")
    rate = max(150, min(12_000, math.floor(TARGET_BYTES * 8 / duration / 1000) - 112))
    encoders = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], check=True, capture_output=True, text=True)
    hardware = platform.system() == "Darwin" and "h264_videotoolbox" in encoders.stdout
    scale = (
        "scale=w='trunc(oh*dar/2)*2':h='trunc(min(min(1080,ih),1920/dar)/2)*2',setsar=1"
    )
    video_filter = scale + (f",setpts=PTS/{speed}" if speed != 1 else "")
    audio_filter = ["-af", f"atempo={speed}"] if speed != 1 else []
    with tempfile.TemporaryDirectory(dir=target.parent) as work:
        output = Path(work) / "encoded.mp4"
        for _ in range(3):
            encoder = ["-c:v", "h264_videotoolbox", "-realtime", "0"] if hardware else [
                "-c:v", "libx264", "-preset", "veryfast",
            ]
            command = [
                "ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(source),
                "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
                "-vf", video_filter, *audio_filter, "-fps_mode", "vfr", *encoder, "-b:v", f"{rate}k",
                "-maxrate", f"{rate}k", "-bufsize", f"{rate * 2}k", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(output),
            ]
            result = subprocess.run(command, capture_output=True)
            if result.returncode:
                if hardware:
                    hardware = False
                    continue
                raise ValueError("FFmpeg could not encode this video")
            size = output.stat().st_size
            if size <= MAX_BYTES:
                info = media_info(output)
                if size == 0 or info["codec_name"] != "h264":
                    raise ValueError("Invalid output MP4")
                with output.open("rb") as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                return {**info, "duration": max(1, round(info["duration"])), "size": size}
            rate = max(100, math.floor(rate * TARGET_BYTES / size))
    raise ValueError("Video remains above the Telegram size limit")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", nargs="?", type=Path)
    parser.add_argument("--speed", type=float, default=1)
    args = parser.parse_args()
    if not 1 <= args.speed <= 2:
        parser.error("--speed must be between 1 and 2")
    target = args.target or args.source.with_name(args.source.stem + "__telegram.mp4")
    print(json.dumps(prepare(args.source, target, args.speed)))


if __name__ == "__main__":
    main()
