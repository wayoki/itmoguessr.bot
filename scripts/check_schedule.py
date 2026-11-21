"""Run one idempotent schedule check; --verify only checks authenticated access."""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def configuration():
    origin = os.environ.get("ITMOGUESSR_MEDIA_ORIGIN", "").rstrip("/")
    key = os.environ.get("ITMOGUESSR_MEDIA_KEY", "").strip()
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError("ITMOGUESSR_MEDIA_ORIGIN must be an HTTPS origin")
    if not key:
        raise ValueError("Add the ITMOGUESSR_MEDIA_KEY repository secret before enabling maintenance")
    return origin, key


def check(*, verify=False):
    origin, key = configuration()
    path = "/media/queue?offset=0" if verify else "/media/wake"
    opener = urllib.request.build_opener(RefuseRedirects)
    for attempt in range(3):
        request = urllib.request.Request(
            origin + path,
            data=None if verify else b"",
            method="GET" if verify else "POST",
            headers={"X-ITMOGUESSR-Media-Key": key, "User-Agent": "ITMOGUESSR-Actions/1.0"},
        )
        try:
            with opener.open(request, timeout=75) as response:
                if verify:
                    queue = json.load(response)
                    if not isinstance(queue.get("items"), list):
                        raise ValueError("Invalid media queue response")
                else:
                    response.read()
            print("Authenticated access verified" if verify else "Schedule check completed")
            return
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise ValueError(f"Bot endpoint returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise ValueError("Bot endpoint did not respond after three attempts") from None
        time.sleep(3 * (attempt + 1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    arguments = parser.parse_args()
    try:
        check(verify=arguments.verify)
    except (ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
