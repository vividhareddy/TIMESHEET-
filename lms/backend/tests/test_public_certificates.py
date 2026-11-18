"""Public certificate rendering against a throwaway MongoDB database only."""
from contextlib import closing
from html import escape
from pathlib import Path
import os
import sys
import tempfile
import threading
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from database import connect, initialize
import store
from server import PortalHandler, PortalServer


class PublicCertificateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ['LMS_QUIET'] = '1'
        cls.temp = tempfile.TemporaryDirectory(prefix='certificate-copy-')
        cls.path = Path(cls.temp.name) / 'copy.sqlite3'
        initialize(cls.path)
        cls.token = 'public_test_' + 'a' * 40
        cls.name = '<img src=x onerror=alert(1)> & "Learner"'
        cls.course = '<script>alert(2)</script> & Course'
        # Synthetic foreign keys keep this fixture independent of copied personal records.
        with closing(connect(cls.path)) as db, db:
            db['certificates'].insert({'id': 'private-test-id', 'run_id': 'private-run-id', 'candidate_name': cls.name, 'course_title': cls.course,
                                       'issued_at': '2026-11-12T20:00:00Z', 'certificate_number': 'SX-TEST-<&"', 'public_token': cls.token})
        cls.server = PortalServer(('127.0.0.1', 0), PortalHandler, cls.path)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()
        store.drop(cls.path)  # Free the throwaway database now (the cluster limits collections).

    def test_public_design_privacy_metadata_and_revocation(self):
        url = self.base + '/certificates/' + self.token
        with urllib.request.urlopen(url) as response:
            body = response.read().decode()
            self.assertIn('noindex', response.headers['X-Robots-Tag'])
        for fragment in ('/styles/certificate.css', 'ShimentoX-Light-Logo.webp', 'certificate-header',
                         'Certificate of Completion', 'certificate-seal', 'certificate-note',
                         '>Valid</p>', '13 November 2026', 'name="viewport"', 'property="og:title"',
                         'property="og:description"', 'property="og:url"', 'property="og:image"',
                         escape(self.name, quote=True), escape(self.course, quote=True), escape('SX-TEST-<&"', quote=True)):
            self.assertIn(fragment, body)
        for fragment in ('<script', '<button', 'private-test-id', 'private-run-id', 'email', 'Print', 'Login', self.name, self.course):
            self.assertNotIn(fragment, body)
        for asset in ('/styles/certificate.css', '/assets/images/ShimentoX-Light-Logo.webp'):
            with urllib.request.urlopen(self.base + asset) as response:
                self.assertEqual(response.status, 200)
        with closing(connect(self.path)) as db, db:
            db['certificates'].update({'public_token': self.token}, {'revoked_at': '2026-11-13T01:00:00Z'})
        with urllib.request.urlopen(url) as response:
            revoked = response.read().decode()
            self.assertIn('certificate-status revoked">Revoked</p>', revoked)
            self.assertNotIn('>Valid</p>', revoked)
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD')) as response:
            self.assertEqual(response.read(), b'')
            self.assertIn('noindex', response.headers['X-Robots-Tag'])
