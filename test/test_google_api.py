import io
import json
import sys
import unittest
import urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from google_api import GoogleBot, GoogleRedirects


class GoogleApiTests(unittest.TestCase):
    def test_rejects_untrusted_origins_before_sending_credentials(self):
        for origin in ['http://script.google.com/macros/s/id/exec', 'https://example.com/macros/s/id/exec',
                       'https://script.google.com@evil.test/macros/s/id/exec', 'https://script.google.com/macros/s/id/exec?key=leak']:
            with self.assertRaises(ValueError):
                GoogleBot(origin, 'private')

    def test_google_content_redirect_never_forwards_key_or_body(self):
        redirect = GoogleRedirects()
        request = urllib.request.Request('https://script.google.com/macros/s/id/exec', data=b'private-key')
        result = redirect.redirect_request(request, None, 302, '', {}, 'https://script.googleusercontent.com/macros/echo?one-use=1')
        self.assertIsNone(result.data)
        self.assertEqual(result.get_method(), 'GET')
        with self.assertRaises(ValueError):
            redirect.redirect_request(request, None, 302, '', {}, 'https://evil.test/')

    def test_key_is_only_in_the_authenticated_post_body(self):
        requests = []
        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return io.BytesIO(b'{"ready":true}')
        GoogleBot('https://script.google.com/macros/s/test/exec', 'private', Opener()).call('check')
        self.assertEqual(json.loads(requests[0].data), {'action': 'check', 'key': 'private'})
        self.assertNotIn('private', requests[0].full_url)


if __name__ == '__main__':
    unittest.main()
