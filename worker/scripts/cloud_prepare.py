"""Drive-to-Sites conversion job. Media remains in private temporary storage."""

import json
import os
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from prepare_video import prepare


def main() -> int:
    origin = os.environ["ITMOGUESSR_MEDIA_ORIGIN"].rstrip("/")
    headers = {"X-ITMOGUESSR-Media-Key": os.environ["ITMOGUESSR_MEDIA_KEY"]}

    def request(path, *, method="GET", body=None, extra=None):
        return urllib.request.urlopen(urllib.request.Request(
            origin + path, data=body, method=method, headers={**headers, **(extra or {})},
        ), timeout=180)

    prepared = errors = 0
    cursor = {}
    for _ in range(12):
        with request("/media/queue?" + urllib.parse.urlencode(cursor)) as response:
            queue = json.load(response)
        for item in queue["items"]:
            path = "/media/" + item["id"] + "/" + item["version"]
            try:
                with tempfile.TemporaryDirectory() as directory:
                    source = Path(directory) / "source"
                    output = Path(directory) / "telegram.mp4"
                    with request(path) as response, source.open("wb") as dst:
                        shutil.copyfileobj(response, dst, 1024 * 1024)
                    info = prepare(source, output)
                    with output.open("rb") as body, request(path, method="PUT", body=body, extra={
                        "Content-Type": "video/mp4", "Content-Length": str(info["size"]),
                        "X-Media-Width": str(info["width"]), "X-Media-Height": str(info["height"]),
                        "X-Media-Duration": str(info["duration"]),
                    }):
                        pass
                    prepared += 1
            except urllib.error.HTTPError as error:
                print(f"Media preparation HTTP {error.code}")
                errors += 1
            except (OSError, ValueError, KeyError) as error:
                print(f"Media preparation failed ({type(error).__name__})")
                errors += 1
            if prepared >= 2:
                break
        cursor = queue.get("next")
        if not cursor or prepared >= 2:
            break
    print(f"Prepared videos: {prepared}; errors: {errors}")
    with request("/media/wake", method="POST", body=b""):
        pass
    return int(errors > 0)


if __name__ == "__main__":
    raise SystemExit(main())
