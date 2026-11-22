"""Authenticated Apps Script maintenance client; never logs credentials."""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


class GoogleRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != 'https' or target.hostname != 'script.googleusercontent.com' or code not in (302, 303):
            raise ValueError('Unexpected Apps Script redirect')
        # ContentService redirects to a one-use content URL. Never forward the key or POST body.
        return urllib.request.Request(newurl, method='GET', headers={'User-Agent': 'ITMOGUESSR-Google/1.0'})


class GoogleBot:
    def __init__(self, origin=None, key=None, opener=None):
        self.origin = origin or os.environ.get('ITMOGUESSR_GOOGLE_ORIGIN', '')
        self.key = (key or os.environ.get('ITMOGUESSR_MEDIA_KEY', '')).strip()
        if not re.fullmatch(r'https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec', self.origin):
            raise ValueError('Set the exact Apps Script deployment HTTPS URL')
        if not self.key:
            raise ValueError('Missing maintenance key')
        self.opener = opener or urllib.request.build_opener(GoogleRedirects())

    def call(self, action, **data):
        request = urllib.request.Request(self.origin, method='POST',
            data=json.dumps({'action': action, 'key': self.key, **data}).encode(),
            headers={'Content-Type': 'application/json', 'User-Agent': 'ITMOGUESSR-Google/1.0'})
        with self.opener.open(request, timeout=240) as response:
            result = json.load(response)
        if not isinstance(result, dict) or ('error' in result):
            raise ValueError('Google bot did not confirm the operation')
        return result


def main():
    import sys
    verify = '--verify' in sys.argv[1:]
    result = GoogleBot().call('check' if verify else 'wake')
    if verify and (not result.get('ready') or not result.get('active')):
        raise ValueError('Google bot is not active')
    print('Google bot access verified' if verify else 'Google schedule check completed')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, urllib.error.URLError) as error:
        # Network exceptions can contain token-bearing Google content URLs.
        print('Google maintenance failed (' + type(error).__name__ + ')')
        raise SystemExit(1)
