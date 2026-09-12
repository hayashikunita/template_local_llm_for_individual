import unittest

from backend.config import local_endpoint


class EndpointTests(unittest.TestCase):
    def test_loopback(self):
        self.assertEqual(local_endpoint("http://127.0.0.1:11434/"), "http://127.0.0.1:11434")
        self.assertEqual(local_endpoint("http://[::1]:11434"), "http://[::1]:11434")

    def test_reject_untrusted_endpoints(self):
        for endpoint in (
            "https://example.com", "http://192.168.1.1:11434", "http://localhost:11434",
            "http://127.0.0.1:11434/path", "http://user@127.0.0.1:11434",
            "http://127.0.0.1:11434?target=remote", "http://127.0.0.1",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                local_endpoint(endpoint)