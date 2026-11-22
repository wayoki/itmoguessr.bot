"""Convert Drive videos on GitHub and store them in private Google Drive."""
import base64
import json
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from google_api import GoogleBot
from prepare_video import prepare
from cloud_prepare import RefuseRedirects


def main():
    api = GoogleBot()
    opener = urllib.request.build_opener(RefuseRedirects())
    converted = errors = 0
    cursor = {}
    for _ in range(12):
        queue = api.call('queue', **cursor)
        for item in queue['items']:
            try:
                if not re.fullmatch(r'[A-Za-z0-9_-]+', item['id']) or not re.fullmatch(r'\d+', item['version']):
                    raise ValueError('Invalid media identifier')
                source = api.call('source', **item)
                url = urllib.parse.urlsplit(source['url'])
                if url.scheme != 'https' or url.hostname != 'www.googleapis.com' or url.path != '/drive/v3/files/' + item['id']:
                    raise ValueError('Unexpected source URL')
                with tempfile.TemporaryDirectory() as directory:
                    original, output = Path(directory) / 'original', Path(directory) / 'telegram.mp4'
                    request = urllib.request.Request(source['url'], headers={'Authorization': 'Bearer ' + source['token']})
                    with opener.open(request, timeout=180) as response, original.open('wb') as stream:
                        total = 0
                        while block := response.read(1024 * 1024):
                            total += len(block)
                            if total > 1000000000:
                                raise ValueError('Source exceeds limit')
                            stream.write(block)
                    info = prepare(original, output)
                    api.call('prepared', **item, width=info['width'], height=info['height'], duration=info['duration'],
                        data=base64.b64encode(output.read_bytes()).decode())
                converted += 1
                print('Prepared private Google video: ' + str(info['size']) + ' bytes', flush=True)
            except (KeyError, ValueError, OSError, urllib.error.URLError, subprocess.SubprocessError) as error:
                print('Google video preparation failed (' + type(error).__name__ + ')')
                errors += 1
            if converted >= 2:
                break
        cursor = queue.get('next')
        if not cursor or converted >= 2:
            break
    print('Prepared videos: ' + str(converted) + '; errors: ' + str(errors))
    if converted:
        api.call('wake')
    return int(errors > 0)


if __name__ == '__main__':
    raise SystemExit(main())
