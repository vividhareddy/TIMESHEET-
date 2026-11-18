"""Single sign-on from the timesheet portal: one account and one sign-in for both applications.

The timesheet's "My LMS" link sends the browser to GET /api/auth/timesheet?ticket=<JWT>. The ticket is an HS256 JWT
signed with LMS_SSO_SECRET (the same value is in the timesheet's backend/.env), valid for one minute and usable once.
It carries the employee's email, name, role, designation, department, joining date, manager's email and direct reports' emails. The LMS account
with that email is created (first visit) or updated from those details, and an ordinary LMS session is started.

Settings (lms/backend/.env):
  LMS_SSO_SECRET   shared secret, at least 32 characters (required to enable single sign-on)
  TIMESHEET_URL    the timesheet portal, where people sign in (default http://localhost:5172)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time

from services import create_run, now, start_session, uid

ISSUER = 'timesheet-api'
AUDIENCE = 'shimentox-lms'
# Accounts created from the timesheet have no LMS password: this marker never matches any password.
NO_PASSWORD = '!timesheet-sign-in-only'
# Timesheet role -> LMS role. HR and trainer exist only in the LMS and are kept for timesheet associates.
ROLES = {'admin': 'admin', 'manager': 'manager', 'associate': 'employee'}
LMS_ONLY_ROLES = ('hr', 'trainer')
CLOCK_SKEW = 30
_used = {}
_used_lock = threading.Lock()


class SignInError(Exception):
    """A timesheet sign-in that cannot continue. The code is shown on the LMS page as a fixed message."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def secret():
    value = os.environ.get('LMS_SSO_SECRET', '').strip()
    return value if len(value) >= 32 else ''


def timesheet_url():
    return (os.environ.get('TIMESHEET_URL', '').strip() or 'http://localhost:5172').rstrip('/')


def enabled():
    return bool(secret())


def _b64decode(part):
    return base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))


def verify_ticket(ticket):
    """The ticket's claims, after checking signature, issuer, audience, lifetime and single use."""
    key = secret()
    if not key:
        raise SignInError('timesheet-not-configured')
    try:
        header_part, payload_part, signature_part = ticket.split('.')
        header = json.loads(_b64decode(header_part))
        claims = json.loads(_b64decode(payload_part))
        signature = _b64decode(signature_part)
    except (ValueError, TypeError, AttributeError):
        raise SignInError('timesheet-expired')
    expected = hmac.new(key.encode(), f'{header_part}.{payload_part}'.encode(), hashlib.sha256).digest()
    if header.get('alg') != 'HS256' or not hmac.compare_digest(signature, expected):
        raise SignInError('timesheet-expired')
    stamp = time.time()
    if (claims.get('iss') != ISSUER or claims.get('aud') != AUDIENCE or not isinstance(claims.get('exp'), (int, float))
            or claims['exp'] + CLOCK_SKEW < stamp or not isinstance(claims.get('jti'), str)):
        raise SignInError('timesheet-expired')
    with _used_lock:
        for jti, until in list(_used.items()):
            if until < stamp:
                del _used[jti]
        if claims['jti'] in _used:
            raise SignInError('timesheet-expired')
        _used[claims['jti']] = claims['exp'] + CLOCK_SKEW
    email = str(claims.get('email') or '').strip().casefold()
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or claims.get('role') not in ROLES:
        raise SignInError('timesheet-expired')
    return {**claims, 'email': email}


def _department(db, name):
    name = (name or '').strip()[:80]
    if len(name) < 2:
        return None
    row = db['departments'].find_one({'name': name})
    if row is None:
        row = db['departments'].insert({'id': uid(), 'name': name, 'created_at': now()})
    return row['id']


def upsert_account(db, claims):
    """Create or update the LMS account for a timesheet employee; returns its row. Learning history is kept."""
    candidates = db['candidates']
    email, stamp = claims['email'], now()
    name = (str(claims.get('name') or '').strip() or email.split('@')[0])[:100]
    title = str(claims.get('designation') or '').strip()[:150]
    department = _department(db, claims.get('department'))
    joining = claims.get('joinDate') if re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(claims.get('joinDate') or '')) else None
    role = ROLES[claims['role']]
    row = candidates.find_one({'email': email})
    if row is None:
        identity = uid()
        candidates.insert({'id': identity, 'full_name': name, 'email': email, 'password_hash': NO_PASSWORD, 'created_at': stamp, 'updated_at': stamp,
                           'role': role, 'must_change_password': 0, 'job_title': title, 'department_id': department, 'joining_date': joining,
                           'auth_source': 'timesheet'})
        create_run(db, identity)
    else:
        identity = row['id']
        if row['role'] in LMS_ONLY_ROLES and role == 'employee':
            role = row['role']
        changes = {'full_name': name, 'role': role, 'updated_at': stamp}
        if title:
            changes['job_title'] = title
        if department:
            changes['department_id'] = department
        if joining and not row['joining_date']:
            changes['joining_date'] = joining
        if row['must_change_password'] and row['password_hash'] == NO_PASSWORD:
            changes['must_change_password'] = 0
        candidates.update({'id': identity}, changes)
    manager_email = str(claims.get('managerEmail') or '').strip().casefold()
    if manager_email:
        manager = candidates.find_one({'email': manager_email}, ['id'])
        if manager and manager['id'] != identity:
            candidates.update({'id': identity}, {'manager_id': manager['id']})
    # The timesheet's direct reports who already have LMS accounts report to this person in the LMS too.
    reports = [str(e).strip().casefold() for e in (claims.get('reportEmails') or [])[:500] if isinstance(e, str) and e.strip()]
    if reports:
        candidates.update({'email': {'$in': reports}, 'id': {'$ne': identity}}, {'manager_id': identity})
    return candidates.find_one({'id': identity})


def sign_in(db, ticket, ip):
    """Verify the ticket, bring the account up to date and start an LMS session: (payload, raw token, lifetime)."""
    claims = verify_ticket(ticket)
    row = upsert_account(db, claims)
    if not row['is_active']:
        raise SignInError('timesheet-disabled')
    return start_session(db, row, ip)
