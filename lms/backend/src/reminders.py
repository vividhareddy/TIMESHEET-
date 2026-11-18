"""Automated course deadline reminders, delivered through the in-app notifications table.

Every delivery has a row in deadline_reminders with a unique idempotency key, so repeated or overlapping passes cannot
send twice. Keys contain the deadline: changing a deadline makes its reminders due again and retires undelivered ones.
Upcoming reminders are worked out from the current deadline on each pass, not stored ahead of time, so they cannot go stale.

A pass is started by the server's background thread, tools/process_reminders.py, or an administrator. Opening the
notification bell also runs one for that employee as a fallback; nothing depends on it.
"""
import json
import sys
import threading
from contextlib import closing
from datetime import datetime, time, timedelta, timezone

from pymongo.errors import PyMongoError

from analytics import assignment_index, progress_index
from database import connect
from deadlines import format_deadline, format_span, parse_utc, portal_timezone, utc_iso
from services import check, notify, now
from store import IntegrityError, like

MAX_ATTEMPTS = 5
RETRY_MINUTES = 5
MAX_INTERVALS = 8
# Sent during the working day rather than at midnight; earlier only when the deadline itself comes first.
DEADLINE_DAY_HOUR = 9


# ---------------------------------------------------------------- settings

def settings(db):
    row = db['reminder_settings'].find_one({'id': 1})
    return {'intervalDays': json.loads(row['intervals_json']), 'deadlineDay': bool(row['deadline_day']), 'overdue': bool(row['overdue']), 'dueSoonDays': row['due_soon_days'],
            'updatedAt': row['updated_at'], 'lastRunAt': row['last_run_at'], 'lastRun': json.loads(row['last_run_json']) if row['last_run_json'] else None}


def due_soon_seconds(db):
    return db['reminder_settings'].find_one({'id': 1}, ['due_soon_days'])['due_soon_days'] * 86400


def save_settings(db, user, data):
    days = data.get('intervalDays')
    check(isinstance(days, list) and len(days) <= MAX_INTERVALS and all(type(d) is int and 1 <= d <= 365 for d in days),
          f'Enter up to {MAX_INTERVALS} reminder intervals, each from 1 to 365 days before the deadline.')
    soon = data.get('dueSoonDays')
    check(type(soon) is int and 1 <= soon <= 90, 'Due Soon must be from 1 to 90 days.')
    check(type(data.get('deadlineDay')) is bool and type(data.get('overdue')) is bool, 'Select whether to send deadline-day and overdue reminders.')
    db['reminder_settings'].update({'id': 1}, {'intervals_json': json.dumps(sorted(set(days), reverse=True)), 'deadline_day': int(data['deadlineDay']),
                                               'overdue': int(data['overdue']), 'due_soon_days': soon, 'updated_by': user['id'], 'updated_at': now()})
    return settings(db)


# ---------------------------------------------------------------- what is due

def deadline_day_at(deadline):
    """The reminder time on the deadline's own day, in the portal timezone."""
    zone = portal_timezone()
    day = deadline.astimezone(zone).date()
    morning = datetime.combine(day, time(DEADLINE_DAY_HOUR), zone)
    return morning if morning < deadline else datetime.combine(day, time(0), zone)


def schedule(deadline, config):
    """(type, scheduled time) for every reminder before a deadline, earliest first."""
    entries = [(f'before_{days}d', deadline - timedelta(days=days)) for days in config['intervalDays']]
    if config['deadlineDay']:
        entries.append(('deadline_day', deadline_day_at(deadline)))
    return sorted(entries, key=lambda entry: entry[1])


def idempotency_key(employee, course, kind, scope):
    return f'deadline:{employee}:{course}:{kind}:{scope}'


def due_reminder(assignment, config, at):
    """The one reminder a deadline calls for now, or None.

    Reminders scheduled before the employee could have received them (a short deadline, a deadline just changed) do not
    apply. After downtime only the latest one is sent, so an employee never receives a backlog.
    """
    deadline = parse_utc(assignment['deadlineAt'])
    if at >= deadline:
        return ('overdue', deadline) if config['overdue'] else None
    opened = max(parse_utc(value) for value in (assignment['assignedAt'], assignment.get('deadlineUpdatedAt') or assignment['assignedAt']))
    due = [entry for entry in schedule(deadline, config) if opened < entry[1] <= at]
    return due[-1] if due else None


def next_reminder(assignment, config, at):
    """When the next reminder falls, for the administrator's view."""
    deadline = parse_utc(assignment['deadlineAt'])
    if at >= deadline:
        return None
    upcoming = [entry[1] for entry in schedule(deadline, config) if entry[1] > at]
    return utc_iso(upcoming[0]) if upcoming else utc_iso(deadline) if config['overdue'] else None


# ---------------------------------------------------------------- messages

def message(kind, course, assignment, progress, at):
    """Notification title and body for one reminder."""
    percent = (progress or {}).get('progress', 0)
    if kind == 'assigned':
        by = f' Complete by {format_deadline(assignment["deadlineAt"], " at ")}.' if assignment['deadlineAt'] else ' Open My Learning to start.'
        label = 'Mandatory training assigned' if assignment['mandatory'] else 'New training assigned'
        return f'{label}: {course}', f'You have been assigned "{course}".{by}'
    due = format_deadline(assignment['deadlineAt'], ' at ')
    remaining = (parse_utc(assignment['deadlineAt']) - at).total_seconds()
    # A pass runs shortly after a reminder falls due: the 3-day reminder should say "3 days", not "2 days, 23 hours".
    if abs(remaining) >= 3600:
        remaining = round(remaining / 3600) * 3600
    if kind == 'overdue':
        return (f'Overdue: {course}', f'Your assigned course "{course}" was due on {due}.\nCurrent progress: {percent}%\nOverdue by {format_span(-remaining)}.\n'
                'The course is still open: please complete it as soon as possible. The late completion will be recorded.')
    title = 'Course Deadline Today' if kind == 'deadline_day' else 'Course Deadline Updated' if kind == 'deadline_changed' else 'Course Deadline Reminder'
    return (title, f'Your assigned course "{course}" must be completed by {due}.\nCurrent progress: {percent}%\nTime remaining: {format_span(remaining)}.\n'
            'Please complete the remaining lessons before the deadline.')


def deliver_in_app(db, employee, kind, title, body, course, key):
    """Create the notification and return its ID; separate so tests can make delivery fail."""
    notify(db, [employee], 'assignment' if kind == 'assigned' else 'deadline', title, body, f'course:{course}', key)
    return db['notifications'].find_one({'employee_id': employee, 'dedupe_key': key}, ['id'])['id']


# ---------------------------------------------------------------- delivery

def send(db, employee, course, assignment, kind, scheduled, title, body, at):
    """Deliver one reminder exactly once. Returns 'sent', 'failed', or 'skipped' (already handled or not yet due for retry)."""
    # An assignment is announced once per assignment; every other reminder belongs to one exact deadline.
    deadline_at = None if kind == 'assigned' else assignment['deadlineAt']
    key = idempotency_key(employee, course, kind, assignment['assignmentId'] if kind == 'assigned' else deadline_at)
    stamp = utc_iso(at)
    row = db['deadline_reminders'].find_one({'idempotency_key': key})
    if row is None:
        created = db['deadline_reminders'].insert_ignore({'employee_id': employee, 'assignment_id': assignment['assignmentId'], 'course_id': course, 'reminder_type': kind, 'deadline_at': deadline_at,
                                                          'scheduled_at': utc_iso(scheduled), 'status': 'pending', 'idempotency_key': key, 'created_at': stamp})
        if not created:
            return 'skipped'
        attempts = 0
    else:
        retry_due = row['status'] == 'cancelled' or (row['status'] in ('failed', 'pending') and row['attempts'] < MAX_ATTEMPTS and (not row['next_attempt_at'] or parse_utc(row['next_attempt_at']) <= at))
        if not retry_due:
            return 'skipped'
        attempts = row['attempts']
    # MongoDB has no savepoints (SQLite rolled a failed delivery back to a SAVEPOINT here). A failed delivery is undone by
    # hand instead: a notification it created before failing is deleted, so it leaves nothing behind and the failure is
    # recorded, as before. A database error aborts the whole MongoDB transaction, so it cannot be recorded and is raised.
    existed = db['notifications'].exists({'employee_id': employee, 'dedupe_key': key})
    try:
        notification = deliver_in_app(db, employee, kind, title, body, course, key)
    except (PyMongoError, IntegrityError):
        raise
    except Exception as error:
        if not existed:
            db['notifications'].delete({'employee_id': employee, 'dedupe_key': key})
        attempts += 1
        retry = utc_iso(at + timedelta(minutes=RETRY_MINUTES * 2 ** attempts)) if attempts < MAX_ATTEMPTS else None
        db['deadline_reminders'].update({'idempotency_key': key}, {'status': 'failed', 'attempts': attempts, 'next_attempt_at': retry, 'failure_reason': str(error)[:500] or type(error).__name__})
        return 'failed'
    db['deadline_reminders'].update({'idempotency_key': key}, {'status': 'sent', 'sent_at': stamp, 'attempts': attempts + 1, 'next_attempt_at': None, 'failure_reason': None, 'notification_id': notification})
    return 'sent'


def retire_undelivered(db, employee, assigned, progress):
    """Undelivered reminders stop retrying once the course is finished or unassigned, or its deadline has changed."""
    retired = {}
    for row in db['deadline_reminders'].find({'employee_id': employee, 'status': {'$in': ['pending', 'failed']}}, ['id', 'course_id', 'reminder_type', 'deadline_at']):
        pair = (employee, row['course_id'])
        a, p = assigned.get(pair), progress.get(pair)
        reason = 'Assignment removed' if a is None else 'Course completed' if p and p['completed'] else 'Deadline changed' if row['deadline_at'] and row['deadline_at'] != a['deadlineAt'] else None
        if reason:
            retired.setdefault(reason, []).append(row['id'])
    for reason, ids in retired.items():  # One write per reason rather than one per row.
        db['deadline_reminders'].update({'id': {'$in': ids}}, {'status': 'cancelled', 'next_attempt_at': None, 'failure_reason': reason})


def already_notified_of_assignment(db, employee, assignment_id):
    """Assignments made before the reminder ledger were announced under the older notification key."""
    return db['notifications'].exists({'employee_id': employee, 'dedupe_key': like(f'assigned:{assignment_id}:%')})


def notified_assignments(db, employee):
    """The keys of an employee's older assignment notifications, casefolded and read once for already_notified()."""
    return [r['dedupe_key'].casefold() for r in db['notifications'].find({'employee_id': employee, 'dedupe_key': like('assigned:%')}, ['dedupe_key'])]


def already_notified(keys, assignment_id):
    """already_notified_of_assignment() against keys from notified_assignments(): the same prefix match, ignoring case like LIKE."""
    prefix = f'assigned:{assignment_id}:'.casefold()
    return any(key.startswith(prefix) for key in keys)


def process_employee(db, employee, at=None, assigned=None, progress=None):
    """Send everything due for one employee. The caller owns the transaction.
    `assigned` and `progress`, when the caller has just read them for this employee, are reused instead of read again."""
    at = at or datetime.now(timezone.utc)
    config = settings(db)
    assigned = assignment_index(db, [employee]) if assigned is None else assigned
    progress = progress_index(db, [employee]) if progress is None else progress
    retire_undelivered(db, employee, assigned, progress)
    counts = {'sent': 0, 'failed': 0, 'skipped': 0}
    titles = {r['id']: r['title'] for r in db['courses'].find({}, ['id', 'title'])}
    notified = notified_assignments(db, employee)
    for pair, a in assigned.items():
        course, p = pair[1], progress.get(pair)
        if p and p['completed']:
            continue
        name = titles.get(course, 'Assigned course')
        if not already_notified(notified, a['assignmentId']):
            title, body = message('assigned', name, a, p, at)
            counts[send(db, employee, course, a, 'assigned', parse_utc(a['assignedAt']), title, body, at)] += 1
        if a['deadlineAt']:
            due = due_reminder(a, config, at)
            if due:
                title, body = message(due[0].split('_')[0] if due[0].startswith('before_') else due[0], name, a, p, at)
                counts[send(db, employee, course, a, due[0], due[1], title, body, at)] += 1
    from onboarding import milestone_reminders  # imported here because onboarding imports this module
    counts['sent'] += milestone_reminders(db, employee, at, progress, assigned)
    return counts


def announce_assignment(db, employee, course, name, assignment, title, at=None):
    """Immediately tell an employee about a new assignment; the ledger stops the next pass repeating it."""
    at = at or datetime.now(timezone.utc)
    _, body = message('assigned', name, assignment, None, at)
    return send(db, employee, course, assignment, 'assigned', at, title, body, at)


def record_announcement(db, employee, course, assignment, notification_id, at=None):
    """Record that a notification sent elsewhere already announced this assignment (an onboarding plan announces all its
    courses in one notice), so the next pass does not announce it again."""
    at = at or datetime.now(timezone.utc)
    stamp = utc_iso(at)
    db['deadline_reminders'].insert_ignore({'employee_id': employee, 'assignment_id': assignment['assignmentId'], 'course_id': course, 'reminder_type': 'assigned', 'deadline_at': None,
                                            'scheduled_at': stamp, 'sent_at': stamp, 'status': 'sent', 'attempts': 1, 'notification_id': notification_id,
                                            'idempotency_key': idempotency_key(employee, course, 'assigned', assignment['assignmentId']), 'created_at': stamp})


def announce_change(db, employee, course, name, assignment, progress, at=None):
    """Immediately tell an employee their deadline changed."""
    at = at or datetime.now(timezone.utc)
    title, body = message('deadline_changed', name, assignment, progress, at)
    return send(db, employee, course, assignment, 'deadline_changed', at, title, body, at)


# ---------------------------------------------------------------- passes

def employees_to_process(db):
    """Active non-admin employees with an assignment, plus anyone with an undelivered reminder to retire."""
    active = {r['id'] for r in db['candidates'].find({'is_active': 1, 'role': {'$ne': 'admin'}}, ['id'])}
    open_rows = set(db['deadline_reminders'].distinct('employee_id', {'status': {'$in': ['pending', 'failed']}}))
    return sorted(({pair[0] for pair in assignment_index(db)} & active) | open_rows)


def record_run(db, summary, at):
    db['reminder_settings'].update({'id': 1}, {'last_run_at': utc_iso(at), 'last_run_json': json.dumps(summary)})


def process_all(db, at=None):
    """One pass inside the caller's transaction, for the authenticated administrator endpoint."""
    at = at or datetime.now(timezone.utc)
    summary = {'employees': 0, 'sent': 0, 'failed': 0, 'skipped': 0, 'errors': 0}
    for employee in employees_to_process(db):
        counts = process_employee(db, employee, at)
        summary['employees'] += 1
        for field, value in counts.items():
            summary[field] += value
    record_run(db, summary, at)
    return summary


def run_pass(path, at=None):
    """One pass from the scheduler or command line. Each employee commits separately so the write lock is held briefly."""
    at = at or datetime.now(timezone.utc)
    summary = {'employees': 0, 'sent': 0, 'failed': 0, 'skipped': 0, 'errors': 0}
    with closing(connect(path)) as db:
        employees = employees_to_process(db)
        db.commit()  # End the reading transaction so each employee's work runs in its own current transaction.
        for employee in employees:
            try:
                db.begin(write=True)
                counts = process_employee(db, employee, at)
                db.commit()
            except Exception as error:
                db.rollback()
                summary['errors'] += 1
                print(f'Reminder pass failed for one employee: {type(error).__name__}', file=sys.stderr, flush=True)
                continue
            summary['employees'] += 1
            for field, value in counts.items():
                summary[field] += value
        db.begin(write=True)
        record_run(db, summary, at)
        db.commit()
    return summary


def preview(path, at=None):
    """What a pass would send at a given time, writing nothing. Used by the command line's --dry-run."""
    at = at or datetime.now(timezone.utc)
    items = []
    with closing(connect(path)) as db:
        config = settings(db)
        titles = {r['id']: r['title'] for r in db['courses'].find({}, ['id', 'title'])}
        employees = employees_to_process(db)
        # Read for all employees at once (each employee's results are the same as when read alone), then one ledger query.
        assigned_all, progress = assignment_index(db, employees), progress_index(db, employees)
        by_employee = {}
        for pair, a in assigned_all.items():
            by_employee.setdefault(pair[0], []).append((pair, a))
        due_items = []
        for employee in employees:
            for pair, a in by_employee.get(employee, []):
                if (progress.get(pair) or {}).get('completed') or not a['deadlineAt']:
                    continue
                due = due_reminder(a, config, at)
                if not due:
                    continue
                due_items.append((employee, pair, due, idempotency_key(employee, pair[1], due[0], a['deadlineAt'])))
        keys = [item[3] for item in due_items]
        sent = set(db['deadline_reminders'].distinct('idempotency_key', {'idempotency_key': {'$in': keys}, 'status': 'sent'})) if keys else set()
        for employee, pair, due, key in due_items:
            if key not in sent:
                items.append({'employeeId': employee, 'course': titles.get(pair[1], pair[1]), 'type': due[0], 'scheduledAt': utc_iso(due[1])})
    return items


def start_scheduler(path, interval_seconds):
    """Run passes on a daemon thread for as long as the server process lives. A failed pass never stops the loop."""
    stop = threading.Event()

    def loop():
        # A short delay lets the server finish starting; this first pass catches up on anything missed while it was down.
        delay = min(5, interval_seconds)
        while not stop.wait(delay):
            delay = interval_seconds
            try:
                run_pass(path)
            except Exception as error:
                print(f'Reminder pass could not run: {type(error).__name__}', file=sys.stderr, flush=True)
            try:
                import live_training  # Session reminders and post-session follow-ups share this loop.
                live_training.run_pass(path)
            except Exception as error:
                print(f'Session reminder pass could not run: {type(error).__name__}', file=sys.stderr, flush=True)

    threading.Thread(target=loop, name='deadline-reminders', daemon=True).start()
    return stop
