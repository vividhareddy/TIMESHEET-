"""Same-origin JSON endpoints and static frontend serving (local development)."""
import hmac
from collections import defaultdict, deque
from datetime import datetime
from html import escape
import json
import os
import re
import time
import ipaddress
import socket
import threading
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qs
from deadlines import IST

from pymongo.errors import PyMongoError

from database import BACKEND, connect, public_curriculum
from store import IntegrityError
from security import token, token_hash, password_hash, verify_password
from services import APIError, can_view_course, authenticate, auth_event, bundle, candidate_view, candidate_certificates, set_certificate_sharing, check, current_run, create_run, expire_exams, learning_action, records, text, now
from admin import admin_action, course_view, setup_initial_admin
from development import MAX_MATERIAL_BYTES, catalog, course_video, course_extras, development_action, material_file, store_material
import activity
import assistant
import compliance
import onboarding
import keka
import timesheet_sso
import live_training

PUBLIC = BACKEND.parent / 'frontend/public'
COOKIE = 'shimentox_session'
# Holds the Keka sign-in state between leaving for Keka and coming back, for 10 minutes.
KEKA_COOKIE = 'shimentox_keka'
# Reported by /api/session so the browser can detect a server still running older code.
API_VERSION = 15
# A request whose MongoDB transaction hits a transient conflict is run again, up to this many times in all.
API_ATTEMPTS = 3


def base_path():
    """The URL path the portal is served under, e.g. '/lms' when the timesheet server proxies it there ('' at the root).
    Requests arrive without it (the proxy strips it); it is added to every address the server hands to the browser."""
    value = os.environ.get('LMS_BASE_PATH', '').strip().rstrip('/')
    if value and not re.fullmatch(r'(?:/[A-Za-z0-9._-]+)+', value):
        raise ValueError('LMS_BASE_PATH must look like /lms')
    return value


def transient(error):
    """A MongoDB error after which the whole transaction can safely be run again."""
    # Only errors after which nothing was saved: an uncertain commit is retried by Db.commit() itself, never by re-running the request.
    return error.has_error_label('TransientTransactionError')


class PortalServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server bind an occupied port, and requests keep reaching the
    # old process. Claim the port exclusively there so a duplicate start fails instead.
    allow_reuse_address = os.name != 'nt'

    def __init__(self, address, handler, db_path):
        # The MongoDB target passed to database.connect(): a path (a throwaway test database) or None/a database name.
        self.db_path = db_path
        self.public_rate_lock = threading.Lock()
        self.public_rate_hits = defaultdict(deque)
        super().__init__(address, handler)

    def server_bind(self):
        if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class PortalHandler(SimpleHTTPRequestHandler):
    server_version = 'ShimentoX'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def send_response(self, *args, **kwargs):
        # Recorded so a request is only run again (after a transient database conflict) before any response was started.
        self.response_started = True
        super().send_response(*args, **kwargs)

    def end_headers(self):
        request_path = urlsplit(self.path).path
        sandbox = request_path == '/python-sandbox.html'
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN' if sandbox else 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        if sandbox:
            host = self.headers.get('Host', 'localhost:5007')
            host = host if re.fullmatch(r'[a-zA-Z0-9.\-\[\]:]+', host) else 'localhost:5007'
            runtime_path = f'{base_path()}/assets/python-runtime/'
            runtime = f'http://{host}{runtime_path} https://{host}{runtime_path}'
            self.send_header('Content-Security-Policy', f"default-src 'none'; script-src 'self' {runtime} 'wasm-unsafe-eval'; worker-src blob:; connect-src {runtime}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
        else:
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' https:; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if request_path.startswith('/assets/python-runtime/'):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=86400')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):
        # Do not log request bodies, passwords, cookies, or tokens.
        if re.fullmatch(r'/certificates/[A-Za-z0-9_-]+', urlsplit(self.path).path):
            return
        if os.environ.get('LMS_QUIET') != '1':
            super().log_message(fmt, *args)

    def public_base_url(self):
        configured = os.environ.get('LMS_PUBLIC_BASE_URL', '').strip()
        if configured:
            parsed = urlsplit(configured)
            check(parsed.scheme in ('http', 'https') and parsed.hostname and parsed.netloc and
                  parsed.username is None and parsed.password is None and parsed.path in ('', '/') and
                  not parsed.query and not parsed.fragment,
                  'LMS_PUBLIC_BASE_URL must be an HTTP(S) website origin without a path.', 500)
            return f'{parsed.scheme}://{parsed.netloc}{base_path()}'

        host = self.headers.get('Host', '')
        if not re.fullmatch(r'(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?', host):
            host = 'localhost:5007'
        for candidate in (self.headers.get('Origin', ''), self.headers.get('Referer', '')):
            parsed = urlsplit(candidate)
            if parsed.scheme in ('http', 'https') and parsed.netloc.lower() == host.lower():
                return f'{parsed.scheme}://{parsed.netloc}{base_path()}'
        forwarded = self.headers.get('X-Forwarded-Proto', '').lower()
        scheme = forwarded if forwarded in ('http', 'https') else 'http'
        return f'{scheme}://{host}{base_path()}'

    def client_ip(self):
        """The browser's address. Behind the timesheet server's proxy (LMS_TRUST_PROXY=1) every connection comes from
        loopback, so the address the proxy reports in X-Forwarded-For is used instead; it is trusted only from loopback."""
        peer = self.client_address[0]
        if os.environ.get('LMS_TRUST_PROXY') == '1' and ipaddress.ip_address(peer).is_loopback:
            forwarded = self.headers.get('X-Forwarded-For', '').split(',')[0].strip()
            try:
                return str(ipaddress.ip_address(forwarded.removeprefix('::ffff:')))
            except ValueError:
                pass
        return peer

    def public_route_allowed(self):
        now_mono = time.monotonic()
        address = self.client_ip()
        with self.server.public_rate_lock:
            hits = self.server.public_rate_hits[address]
            while hits and now_mono - hits[0] >= 60:
                hits.popleft()
            if len(hits) >= 30:
                return False
            hits.append(now_mono)
            if len(self.server.public_rate_hits) > 5000:
                for ip, entries in list(self.server.public_rate_hits.items()):
                    while entries and now_mono - entries[0] >= 60:
                        entries.popleft()
                    if not entries:
                        self.server.public_rate_hits.pop(ip, None)
        return True

    def certificate_html_response(self, status, body, head=False):
        data = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Robots-Tag', 'noindex, nofollow, noarchive')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def public_certificate(self, token, head=False):
        if not self.public_route_allowed():
            return self.certificate_html_response(429, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Try again later</title><p>Too many requests. Please try again later.</p></html>', head)
        not_found = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><title>Certificate not found</title><body><main><h1>Certificate not found</h1><p>This certificate is unavailable.</p></main></body></html>'
        if not re.fullmatch(r'[A-Za-z0-9_-]{40,64}', token):
            return self.certificate_html_response(404, not_found, head)
        db = connect(self.server.db_path)
        try:
            award = db['certificates'].find_one({'public_token': token}, ['candidate_name', 'course_title', 'issued_at', 'certificate_number', 'revoked_at'])
        finally:
            db.close()
        if award is None:
            return self.certificate_html_response(404, not_found, head)

        try:
            base = self.public_base_url()
        except APIError:
            return self.certificate_html_response(500, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Certificate unavailable</title><p>Certificate unavailable.</p></html>', head)
        link = f'{base}/certificates/{token}'
        image = f'{base}/assets/images/certificate-share-preview.png'
        timestamp = datetime.fromisoformat(award['issued_at'].replace('Z', '+00:00'))
        completed = timestamp.astimezone(IST)
        date = f'{completed.day} {completed.strftime("%B %Y")}'
        name = escape(award['candidate_name'], quote=True)
        course = escape(award['course_title'], quote=True)
        number = escape(award['certificate_number'], quote=True)
        safe_date = escape(date, quote=True)
        title = escape(f'Certificate of Completion — {award["course_title"]}', quote=True)
        description = escape(f'{award["candidate_name"]} completed {award["course_title"]} on {date}.', quote=True)
        safe_link = escape(link, quote=True)
        safe_image = escape(image, quote=True)
        status = 'Revoked' if award['revoked_at'] else 'Valid'
        status_class = ' revoked' if award['revoked_at'] else ''
        body = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="googlebot" content="noindex,nofollow,noarchive">
<meta property="og:type" content="website"><meta property="og:site_name" content="ShimentoX Learning">
<meta property="og:title" content="{title}"><meta property="og:description" content="{description}">
<meta property="og:url" content="{safe_link}"><meta property="og:image" content="{safe_image}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><title>{title}</title>
<link rel="stylesheet" href="{base_path()}/styles/main.css"><link rel="stylesheet" href="{base_path()}/styles/certificate.css">
</head><body class="public-certificate"><main>
<p class="certificate-status{status_class}">{status}</p>
<article class="certificate" aria-label="Certificate of Completion">
<div class="certificate-header"><img src="{base_path()}/assets/images/ShimentoX-Light-Logo.webp" alt="ShimentoX" width="960" height="169"><span>LEARNING &amp; DEVELOPMENT</span></div>
<div class="certificate-body"><div class="certificate-kicker">A COMMITMENT TO CONTINUOUS GROWTH</div>
<h2>Certificate of Completion</h2><p class="certificate-presented">This certificate is proudly presented to</p>
<h3 class="certificate-name">{name}</h3>
<p class="certificate-description">for successfully completing all lessons, practice activities and required assessments in</p>
<h4 class="certificate-course">{course}</h4><p class="certificate-description">Lessons &middot; Practice &middot; Assessment</p>
<div class="certificate-details"><div><strong>{safe_date}</strong><span>DATE OF COMPLETION</span></div>
<div class="certificate-seal"><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="5"/><path d="m8 12-2 9 6-3 6 3-2-9"/></svg></span><span>COURSE<br>COMPLETED</span></div>
<div><strong>ShimentoX</strong><span>LEARNING &amp; DEVELOPMENT</span></div></div>
<p class="certificate-note">Certificate number <span class="certificate-number">{number}</span></p>
</div></article></main></body></html>'''
        return self.certificate_html_response(200, body, head)

    def json_response(self, status, payload, cookie=None):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        if cookie is not None:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(data)

    def download_response(self, body, content_type, filename):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def cookie_value(self, name=COOKIE):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
            return cookies[name].value if name in cookies else ''
        except Exception:
            return ''

    def session(self, db):
        raw = self.cookie_value()
        if not raw:
            return None
        found = db['sessions'].find_one({'token_hash': token_hash(raw), 'expires_at': {'$gt': time.time()}}, ['candidate_id', 'csrf_token', 'token_hash'])
        if found is None:
            return None
        user = db['candidates'].find_one({'id': found['candidate_id'], 'is_active': 1})
        # Every candidate column plus the session's csrf_token and token_hash, as the former joined row had.
        return None if user is None else {**user, 'csrf_token': found['csrf_token'], 'token_hash': found['token_hash']}

    def session_cookie(self, raw, lifetime):
        secure = '; Secure' if os.environ.get('LMS_COOKIE_SECURE') == '1' else ''
        path = base_path() or '/'
        return f'{COOKIE}={raw}; Path={path}; HttpOnly; SameSite=Lax; Max-Age={lifetime}{secure}'

    def redirect(self, location, *cookies):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Cache-Control', 'no-store')
        for cookie in cookies:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def keka_state_cookie(self, value, lifetime):
        secure = '; Secure' if os.environ.get('LMS_COOKIE_SECURE') == '1' else ''
        return f'{KEKA_COOKIE}={value}; Path={base_path()}/api/auth/keka; HttpOnly; SameSite=Lax; Max-Age={lifetime}{secure}'

    def keka_start(self):
        """Send the browser to Keka's sign-in page; Keka returns it to /api/auth/keka/callback."""
        if not keka.sso_ready():
            return self.redirect(f'{base_path()}/?signin_error=keka-not-configured')
        state = token()
        return self.redirect(keka.authorize_url(state, token(), keka.redirect_uri(self.public_base_url())), self.keka_state_cookie(state, 600))

    def keka_callback(self, db, user, query):
        """Keka sends the person back here after they sign in. Any problem returns to the login page with a fixed message code."""
        clear = self.keka_state_cookie('', 0)
        expected, state = self.cookie_value(KEKA_COOKIE), query.get('state', [''])[0]
        if query.get('error'):
            return self.redirect(f'{base_path()}/?signin_error=keka-cancelled', clear)
        if not expected or not state or not hmac.compare_digest(expected, state):
            return self.redirect(f'{base_path()}/?signin_error=keka-expired', clear)
        try:
            payload, raw, lifetime = keka.sign_in(db, query.get('code', [''])[0], self.client_ip(), keka.redirect_uri(self.public_base_url()))
        except keka.SignInError as error:
            db.commit()
            return self.redirect(f'{base_path()}/?signin_error={error.code}', clear)
        if user:
            db['sessions'].delete({'token_hash': user['token_hash']})
        db.commit()
        return self.redirect(f'{base_path()}/', clear, self.session_cookie(raw, lifetime))

    def timesheet_sign_in(self, db, user, query):
        """Single sign-on from the timesheet's "My LMS" link: verify the one-minute ticket and start an LMS session."""
        # Takes the write lock first, so the account update cannot conflict and the single-use ticket is never retried.
        db.begin(write=True)
        try:
            payload, raw, lifetime = timesheet_sso.sign_in(db, query.get('ticket', [''])[0], self.client_ip())
        except timesheet_sso.SignInError as error:
            db.rollback()
            return self.redirect(f'{base_path()}/?signin_error={error.code}')
        if user:
            db['sessions'].delete({'token_hash': user['token_hash']})
        db.commit()
        return self.redirect(f'{base_path()}/', self.session_cookie(raw, lifetime))

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            return self.api('GET', path)
        if path.startswith('/certificates/'):
            return self.public_certificate(path.removeprefix('/certificates/'))
        resolved = (PUBLIC / unquote(path).lstrip('/')).resolve()
        if not resolved.is_relative_to(PUBLIC.resolve()) or any(part.startswith('.') for part in Path(unquote(path)).parts):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        self.api('POST', urlsplit(self.path).path)

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if path.startswith('/certificates/'):
            return self.public_certificate(path.removeprefix('/certificates/'), head=True)
        elif path.startswith('/api/'):
            self.send_response(405)
            self.end_headers()
        else:
            super().do_HEAD()

    def file_response(self, file_path, content_type, name):
        """Stream a protected file, honouring a single HTTP byte range so browsers can seek in video."""
        size = file_path.stat().st_size
        start, end, status = 0, size - 1, 200
        requested = self.headers.get('Range', '')
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested.strip())
        if requested:
            if not match or (not match.group(1) and not match.group(2)):
                status = 416
            elif match.group(1):
                start, end = int(match.group(1)), min(int(match.group(2)) if match.group(2) else size - 1, size - 1)
                status = 206 if start <= end and start < size else 416
            else:
                start, status = max(0, size - int(match.group(2))), 206
        safe = ''.join(c for c in name if c.isalnum() or c in ' ._-')[:150] or 'material'
        if status == 416:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Disposition', f'inline; filename="{safe}"')
        self.end_headers()
        with open(file_path, 'rb') as handle:
            handle.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def api(self, method, path):
        db = connect(self.server.db_path)
        self.response_started = False
        try:
            data, upload = self.request_body(method, path)
            # The body is read once; a transient MongoDB transaction conflict before any response was started rolls back
            # and handles the request again with it.
            for attempt in range(1, API_ATTEMPTS + 1):
                try:
                    return self.api_request(db, method, path, data, upload)
                except PyMongoError as error:
                    if attempt == API_ATTEMPTS or self.response_started or not transient(error):
                        raise
                    db.rollback()
        except APIError as error:
            db.rollback()
            self.json_response(error.status, {'error': error.message})
        except IntegrityError:
            db.rollback()
            self.json_response(409, {'error': 'This record already exists or changed. Reload and try again.'})
        except (BrokenPipeError, ConnectionResetError):
            db.rollback()
        except Exception as error:
            db.rollback()
            self.log_error('Internal error: %s', type(error).__name__)
            self.json_response(500, {'error': 'The server could not complete your request. Please try again.'})
        finally:
            db.close()

    def request_body(self, method, path):
        """Check a POST request's origin and read its body: (JSON data, upload or None)."""
        data = {}
        upload = None
        if method == 'POST':
            check(self.headers.get('X-Portal-Request') == '1', 'Invalid request origin.', 403)
            check(self.headers.get('Sec-Fetch-Site', 'same-origin') in ('same-origin', 'none'), 'Cross-site requests are not allowed.', 403)
            origin = self.headers.get('Origin')
            host = self.headers.get('Host', '')
            if origin:
                parsed = urlsplit(origin)
                check(parsed.netloc == host and parsed.scheme in ('http', 'https'), 'Invalid request origin.', 403)
            if path == '/api/manage/materials':
                # Learning materials are uploaded as a raw body; the file name travels URL-encoded in a header.
                check(self.headers.get('Content-Type', '').split(';')[0] == 'application/octet-stream', 'Upload the file as binary content.', 415)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                except ValueError:
                    length = 0
                check(0 < length <= MAX_MATERIAL_BYTES, 'Files must be between 1 byte and 50 MB.', 413)
                upload = (unquote(self.headers.get('X-File-Name', '')), self.rfile.read(length))
            else:
                check(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON content is required.', 415)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    check(0 < length <= 65536, 'Invalid request size.', 413)
                    data = json.loads(self.rfile.read(length))
                    check(isinstance(data, dict), 'A JSON object is required.')
                except (ValueError, UnicodeError):
                    raise APIError(400, 'Invalid JSON request.')
        return data, upload

    def api_request(self, db, method, path, data, upload):
        """Handle one API request inside its database transaction."""
        # A Keka sync waits on outbound requests before it writes, so it must not hold the write lock that every other POST takes.
        if method == 'POST' and path != '/api/manage/keka/sync':
            db.begin(write=True)
        user = self.session(db)
        query = parse_qs(urlsplit(self.path).query)
        if method == 'GET' and path == '/api/session':
            payload = {'user': candidate_view(user) if user else None, 'csrfToken': user['csrf_token'] if user else None,'setupRequired':not db['candidates'].exists({'role':'admin'}),'setupAllowed':ipaddress.ip_address(self.client_ip()).is_loopback,'apiVersion':API_VERSION,'kekaSignIn':keka.sso_ready(),'timesheetUrl':timesheet_sso.timesheet_url() if timesheet_sso.enabled() else None}
        elif method=='POST' and path=='/api/setup/admin':
            check(ipaddress.ip_address(self.client_ip()).is_loopback,'Initial setup must be completed on the server computer.',403)
            check(urlsplit('http://'+self.headers.get('Host','')).hostname in ('localhost','127.0.0.1','::1'),'Open the local portal address to complete setup.',403)
            setup_initial_admin(db,data)
            payload,raw,lifetime=authenticate(db,data,self.client_ip())
            db.commit()
            return self.json_response(201,payload,self.session_cookie(raw,lifetime))
        elif method == 'GET' and path == '/api/auth/keka/start':
            return self.keka_start()
        elif method == 'GET' and path == '/api/auth/keka/callback':
            return self.keka_callback(db, user, query)
        elif method == 'GET' and path == '/api/auth/timesheet':
            return self.timesheet_sign_in(db, user, query)
        elif method == 'POST' and path in ('/api/auth/login', '/api/auth/register'):
            payload, raw, lifetime = authenticate(db, data, self.client_ip(), path.endswith('register'))
            if user:
                db['sessions'].delete({'token_hash': user['token_hash']})
            db.commit()
            return self.json_response(201 if path.endswith('register') else 200, payload, self.session_cookie(raw, lifetime))
        else:
            check(user is not None, 'Please sign in to continue.', 401)
            if method == 'POST':
                check(hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf_token']), 'Your session could not be verified. Reload and try again.', 403)
            candidate = user['id']
            check(not user['must_change_password'] or path in ('/api/auth/password','/api/auth/logout'), 'Change your temporary password before accessing the portal.',403)
            if path.startswith('/api/admin/'):
                # Each admin route checks its own permission (admin, HR, trainer, or manager scope).
                check(user['role']!='employee','Administrator access is required.',403)
                payload=admin_action(db,user,method,path.removeprefix('/api/admin/'),data)
                db.commit()
                return self.json_response(200,payload)
            if upload is not None:
                payload=store_material(db,user,*upload)
                db.commit()
                return self.json_response(200,payload)
            if method=='GET' and path.startswith('/api/videos/'):
                return self.file_response(*course_video(db,user,path.removeprefix('/')))
            if method=='GET' and path.startswith('/api/materials/'):
                return self.file_response(*material_file(db,user,path.removeprefix('/api/materials/')))
            if path=='/api/me/assistant':
                payload=assistant.status() if method=='GET' else assistant.ask(db,user,data)
                db.commit()
                return self.json_response(200,payload)
            if method=='GET' and path in ('/api/manage/compliance/export','/api/manage/onboarding/export'):
                download=(compliance if 'compliance' in path else onboarding).export(db,user,query)
                db.commit()
                return self.download_response(*download)
            if method=='GET' and re.fullmatch(r'/api/me/(calendar|sessions/[^/]+/calendar)\.ics',path):
                download=live_training.calendar_file(db,user,path)
                db.commit()
                return self.download_response(*download)
            if path.startswith('/api/manage/') or path.startswith('/api/me/'):
                payload=development_action(db,user,method,path.removeprefix('/api/'),query,data)
                db.commit()
                return self.json_response(200,payload)
            if method == 'POST' and path == '/api/auth/logout':
                for run in db['course_runs'].find({'candidate_id':candidate,'archived_at':None},['id']):
                    expire_exams(db, run['id'], 'You signed out during the exam.')
                db['sessions'].delete({'token_hash': user['token_hash']})
                auth_event(db, candidate, user['email'], 'logout', self.client_ip())
                db.commit()
                return self.json_response(200, {'ok': True}, self.session_cookie('', 0))
            if method == 'POST' and path == '/api/auth/password':
                previous, replacement = text(data, 'currentPassword', 1, 128), text(data, 'password', 8, 128)
                check(verify_password(previous, user['password_hash']), 'Current password is incorrect.', 400)
                check(previous!=replacement,'Choose a new password different from the temporary or current password.')
                db['candidates'].update({'id': candidate}, {'password_hash': password_hash(replacement), 'updated_at': now(), 'must_change_password': 0})
                db['sessions'].delete({'candidate_id': candidate, 'token_hash': {'$ne': user['token_hash']}})
                auth_event(db, candidate, user['email'], 'password_changed', self.client_ip())
                from services import notify
                notify(db, [candidate], 'account', 'Password changed successfully', 'Your account password has been updated.', 'account', f'password:{now()}')
                payload = {'ok': True,'user':candidate_view(db['candidates'].get(candidate))}
            elif method=='GET' and path=='/api/courses':
                payload={'courses':catalog(db,user)}
            elif method=='POST' and path=='/api/learning/enroll':
                identity=text(data,'courseId',1,100)
                course=db['courses'].find_one({'id':identity,'status':'published'})
                check(course is not None,'This course is not published or is unavailable.',404)
                run=db['course_runs'].find_one({'candidate_id':candidate,'course_id':identity,'archived_at':None},['id'])
                # Department-only courses: employees who already started keep access if visibility later changes.
                check(run is not None or can_view_course(db,user,course),'This course is not published or is unavailable.',404)
                if not run:create_run(db,candidate,identity)
                # Only an employee opening the course page counts; loading the last course in the background at sign-in does not.
                if data.get('open') is True:
                    activity.course_opened(db,candidate,db['course_runs'].find_one({'candidate_id':candidate,'course_id':identity,'archived_at':None}))
                payload={'learning':bundle(db,candidate,identity)}
            elif method == 'GET' and path == '/api/learning':
                identity=parse_qs(urlsplit(self.path).query).get('courseId',['python-programming'])[0]
                course=db['courses'].find_one({'id':identity,'status':'published'})
                check(course is not None,'This course is unavailable.',404)
                check(can_view_course(db,user,course) or db['course_runs'].exists({'candidate_id':candidate,'course_id':identity}),'This course is unavailable.',404)
                payload = {'learning': bundle(db, candidate,identity), 'course': public_curriculum(db,identity),'lessons':json.loads(course['lessons_json']),'courseInfo':course_view(course,False,db),**course_extras(db,user,identity)}
            elif method == 'GET' and path == '/api/records':
                payload = {'user': candidate_view(user), **records(db, candidate)}
            elif method=='GET' and path=='/api/certificates':
                payload={'certificates':candidate_certificates(db,candidate,self.public_base_url(),bool(os.environ.get('LMS_PUBLIC_BASE_URL','').strip()))}
            elif method=='POST' and re.fullmatch(r'/api/certificates/[0-9a-fA-F-]{36}/sharing',path):
                identity=path.split('/')[3]
                sharing=set_certificate_sharing(db,candidate,identity,data.get('enabled'),data.get('consent'))
                public_url=f'{self.public_base_url()}/certificates/{sharing["publicToken"]}' if sharing['publicToken'] else None
                payload={'certificateNumber':sharing['certificateNumber'],'shareEnabled':sharing['shareEnabled'],'publicUrl':public_url}
            elif method == 'POST' and path.startswith('/api/learning/'):
                payload = learning_action(db, candidate, path.removeprefix('/api/learning/'), data)
            else:
                raise APIError(404, f'Endpoint was not found: {method} {path}')
        if user and isinstance(payload,dict) and (isinstance(payload.get('learning'),dict) or 'certificates' in payload):
            awards=candidate_certificates(db,candidate,self.public_base_url(),bool(os.environ.get('LMS_PUBLIC_BASE_URL','').strip()))
            if isinstance(payload.get('learning'),dict):
                payload['learning']['certificates']=awards
            if 'certificates' in payload:
                payload['certificates']=awards
        db.commit()
        self.json_response(200, payload)
