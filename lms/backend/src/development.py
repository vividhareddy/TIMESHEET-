"""Employee learning & development: organisation setup, assignments, assessments,
training sessions, notifications, materials, and the employee-facing learning views.

Every route checks permissions on the server. Managers are limited to their direct reports and trainers to
the courses, assessments, and sessions they own.
"""
import json
import random
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from admin import audit, course_view, media_reference, owns_course
from analytics import (UNITS, assignment_index, dashboard, local_now, pair_status, pending_assessments,
                       progress_index, recommendations, report, today, training_progress)
from notifications import announce
import activity
import compliance
import onboarding
import games
import course_generator
import keka
import live_training
from database import BACKEND, MAX_EXAM_ATTEMPTS, VIDEO_ROOT, public_curriculum
from deadlines import STATUS_LABELS, deadline_status, deadline_view, end_of_day, format_deadline, local_date, local_input, parse_utc, timezone_label, utc_iso
import reminders
from services import allowed, can_view_course, check, current_run, issue_certificate, notify, now, require, text, uid

VIDEO_TYPES = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8', '.jpg': 'image/jpeg'}
MATERIALS = BACKEND / 'data/materials'
MATERIAL_TYPES = {'.pdf': 'application/pdf', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8',
                  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}
MAX_MATERIAL_BYTES = 50 * 1024 * 1024
TARGETS = {'employee': ('candidates', {'is_active': 1, 'role': {'$ne': 'admin'}}, 'id'), 'department': ('departments', None, 'department_id'), 'job_role': ('job_roles', None, 'job_role_id')}
KINDS = ('pre', 'post', 'knowledge')
_FOLD = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')


# ---------------------------------------------------------------- query helpers

def nocase(value):
    """Sort key of SQLite's COLLATE NOCASE (only ASCII letters fold), for lists ordered by a NOCASE column."""
    return value.translate(_FOLD)


def bound(value):
    """A request value used in a query filter. sqlite3 refused to bind anything but a scalar (an error, not a match);
    refusing here also stops a JSON object from acting as a MongoDB query operator."""
    if value is not None and not isinstance(value, (str, int, float)):
        raise TypeError('Unsupported request value type.')
    return value


def names(db, table, ids, field='name'):
    """{id: field} for the rows with these ids, read in one query (the former LEFT JOIN)."""
    ids = list({i for i in ids if i is not None})
    return {r['id']: r[field] for r in db[table].find({'id': {'$in': ids}}, ['id', field])} if ids else {}


def counts(db, table, match=None, key='course_id'):
    """{key value: number of rows} (SELECT key,COUNT(*) ... GROUP BY key)."""
    return {r['_id']: r['n'] for r in db[table].aggregate(([{'$match': match}] if match else []) + [{'$group': {'_id': '$' + key, 'n': {'$sum': 1}}}])}


# ---------------------------------------------------------------- validation helpers

def opt_text(data, field, maximum, label=None):
    value = data.get(field) or ''
    check(isinstance(value, str) and len(value.strip()) <= maximum, f'{label or field} must contain at most {maximum} characters.')
    return value.strip()


def opt_date(data, field, label='Date'):
    value = data.get(field) or None
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        check(False, f'{label} must be a valid date.')


def date_time(data, field, label):
    try:
        return datetime.fromisoformat(data.get(field)).strftime('%Y-%m-%dT%H:%M')
    except (TypeError, ValueError):
        check(False, f'Enter a valid {label}.')


def integer(data, field, low, high, label, default=None):
    value = data.get(field, default)
    check(type(value) is int and low <= value <= high, f'{label} must be a whole number from {low} to {high}.')
    return value


def flag(data, field, default=False):
    value = data.get(field, default)
    check(type(value) is bool, f'{field} must be true or false.')
    return value


def choice(data, field, options, label, default=None):
    value = data.get(field, default)
    check(value in options, f'Select a valid {label}.')
    return value


def ref(db, data, field, table, label, condition=None, required=False):
    value = data.get(field) or None
    if value is None:
        check(not required, f'Select a {label}.')
        return None
    check(isinstance(value, str) and db[table].exists({'id': value, **(condition or {})}), f'Select a valid {label}.')
    return value


def pages(items, query, size=25):
    try:
        page = max(1, int(query.get('page', ['1'])[0]))
    except ValueError:
        page = 1
    count = max(1, -(-len(items) // size))
    page = min(page, count)
    return {'items': items[(page - 1) * size:page * size], 'page': page, 'pages': count, 'total': len(items)}


def me(db, user):
    # One round trip: the employee with department, job role and manager joined in.
    c = db['candidates'].aggregate([{'$match': {'id': user['id']}}, {'$limit': 1},
                                    {'$lookup': {'from': db.collection_name('departments'), 'localField': 'department_id', 'foreignField': 'id', 'as': 'd'}},
                                    {'$lookup': {'from': db.collection_name('job_roles'), 'localField': 'job_role_id', 'foreignField': 'id', 'as': 'j'}},
                                    {'$lookup': {'from': db.collection_name('candidates'), 'localField': 'manager_id', 'foreignField': 'id', 'as': 'm'}}])[0]
    joined = lambda key, column, field: c[key][0][field] if c[column] is not None and c[key] else None
    return {'id': c['id'], 'name': c['full_name'], 'email': c['email'], 'role': c['role'], 'department_id': c['department_id'], 'job_role_id': c['job_role_id'],
            'manager_id': c['manager_id'], 'job_title': c['job_title'], 'department': joined('d', 'department_id', 'name'), 'job_role': joined('j', 'job_role_id', 'name'),
            'manager': joined('m', 'manager_id', 'full_name')}


def save_training_targets(db, user, data):
    """Set or clear the yearly training-hours target for one or more employees.
    Administrators and HR can set it for anyone; a manager only for their own direct reports."""
    check(allowed(user, 'users.manage') or user['role'] == 'manager', 'You do not have permission to set training targets.', 403)
    ids = data.get('employeeIds')
    check(isinstance(ids, list) and 1 <= len(ids) <= 5000 and all(isinstance(i, str) for i in ids), 'Choose at least one employee.')
    ids = list(dict.fromkeys(ids))
    year = integer(data, 'year', 2000, 2100, 'Year', date.today().year)
    hours = data.get('hours')
    check(hours is None or (type(hours) is int and 1 <= hours <= 2000), 'Training target must be a whole number of hours from 1 to 2000.')
    found = set(db['candidates'].distinct('id', {'is_active': 1, 'role': {'$ne': 'admin'}, 'id': {'$in': ids}}))
    check(found == set(ids), 'One or more employees were not found.', 404)
    if not allowed(user, 'users.manage'):
        check(set(ids) <= team(db, user['id']), 'Managers can set training targets only for their direct reports.', 403)
    # Up to 5000 employees: written in a few batched operations rather than one upsert per employee.
    if hours is None:
        db['training_targets'].delete({'employee_id': {'$in': ids}, 'year': year})
    else:
        stamp = now()
        existing = set(db['training_targets'].distinct('employee_id', {'employee_id': {'$in': ids}, 'year': year}))
        if existing:
            db['training_targets'].update({'employee_id': {'$in': list(existing)}, 'year': year}, {'hours': hours, 'set_by': user['id'], 'updated_at': stamp})
        db['training_targets'].insert_many([{'employee_id': e, 'year': year, 'hours': hours, 'set_by': user['id'], 'updated_at': stamp} for e in ids if e not in existing])
    audit(db, user['id'], 'training_target_set', ids[0] if len(ids) == 1 else '', f'{year}: {hours if hours is not None else "cleared"} hours for {len(ids)} employee(s)')
    return {'training': training_progress(db, ids, year)}


def team(db, manager_id):
    return set(db['candidates'].distinct('id', {'manager_id': manager_id, 'is_active': 1}))


def target_input(db, actor, data, mandatory=False):
    kind = choice(data, 'targetType', TARGETS, 'assignment target type')
    table, condition, _ = TARGETS[kind]
    target = ref(db, data, 'targetId', table, 'employee, department, or job role', condition, required=True)
    if actor['role'] == 'manager':
        check(kind == 'employee' and target in team(db, actor['id']), 'Managers can assign training only to their direct reports.', 403)
        check(not mandatory, 'Mandatory training is assigned by HR or administrators.', 403)
    return kind, target


def target_employees(db, kind, target):
    column = TARGETS[kind][2]
    return [r['id'] for r in db['candidates'].find({column: target, 'is_active': 1, 'role': {'$ne': 'admin'}}, ['id'])]


def target_name(db, kind, target):
    table, field = {'employee': ('candidates', 'full_name'), 'department': ('departments', 'name'), 'job_role': ('job_roles', 'name')}[kind]
    row = db[table].get(target, [field])
    return row[field] if row else 'Removed'


def course_or_404(db, identity):
    row = db['courses'].get(identity)
    check(row is not None, 'Course was not found.', 404)
    return row


def questions_input(data):
    questions = data.get('questions')
    check(isinstance(questions, list) and 1 <= len(questions) <= 200, 'Add between 1 and 200 questions to the question bank.')
    clean = []
    for i, q in enumerate(questions):
        check(isinstance(q, list) and len(q) in (3, 4, 5), f'Question {i + 1}: use [prompt, options, correct option index, explanation, optional code].')
        check(isinstance(q[0], str) and 1 <= len(q[0].strip()) <= 2000, f'Question {i + 1}: question text is required.')
        check(isinstance(q[1], list) and 2 <= len(q[1]) <= 6 and all(isinstance(o, str) and 1 <= len(o.strip()) <= 1000 for o in q[1]), f'Question {i + 1}: provide 2-6 answer options.')
        check(type(q[2]) is int and 0 <= q[2] < len(q[1]), f'Question {i + 1}: invalid correct option index (indices start at 0).')
        explanation = q[3] if len(q) >= 4 else ''
        check(isinstance(explanation, str) and len(explanation) <= 2000, f'Question {i + 1}: explanation is too long.')
        code = q[4] if len(q) == 5 else ''
        check(isinstance(code, str) and len(code) <= 5000, f'Question {i + 1}: the code snippet must contain at most 5000 characters.')
        # A code snippet turns a multiple-choice item into a coding question; it is kept only when present.
        clean.append([q[0].strip(), [o.strip() for o in q[1]], q[2], explanation.strip()] + ([code.rstrip()] if code.strip() else []))
    return clean


# ---------------------------------------------------------------- organisation

def org(db, user):
    # Department, job role and category names sort as COLLATE NOCASE columns; titles and people's names as plain text.
    departments = sorted(db['departments'].find({}, ['id', 'name']), key=lambda r: nocase(r['name']))
    department_names = {d['id']: d['name'] for d in departments}
    active = sorted(db['candidates'].find({'is_active': 1}, ['id', 'full_name', 'role', 'department_id']), key=lambda r: r['full_name'])
    members = {}
    for c in active:
        members[c['department_id']] = members.get(c['department_id'], 0) + 1
    return {'departments': [{'id': d['id'], 'name': d['name'], 'employees': members.get(d['id'], 0)} for d in departments],
            'jobRoles': [{'id': j['id'], 'name': j['name'], 'departmentId': j['department_id'], 'department': department_names.get(j['department_id'])}
                         for j in sorted(db['job_roles'].find({}, ['id', 'name', 'department_id']), key=lambda r: nocase(r['name']))],
            'categories': sorted((r['name'] for r in db['course_categories'].find({}, ['name'])), key=nocase),
            'courses': [{'id': k['id'], 'title': k['title'], 'status': k['status'], 'category': k['category']}
                        for k in sorted(db['courses'].find({}, ['id', 'title', 'status', 'category']), key=lambda r: r['title'])],
            'trainers': [{'id': c['id'], 'name': c['full_name'], 'role': c['role']} for c in active if c['role'] in ('admin', 'hr', 'trainer')],
            'managers': [{'id': c['id'], 'name': c['full_name']} for c in active if c['role'] in ('manager', 'hr', 'admin')]}


def save_org_item(db, user, kind, data):
    require(user, 'org.manage')
    if kind == 'categories':
        name = text(data, 'name', 2, 80)
        if data.get('delete') is True:
            check(not db['courses'].exists({'category': name}), 'This category is used by courses. Move those courses to another category first.', 409)
            db['course_categories'].delete({'name': name})
        else:
            db['course_categories'].insert({'name': name, 'created_at': now()})
        audit(db, user['id'], 'category_deleted' if data.get('delete') is True else 'category_created', name, name)
        return org(db, user)
    table = 'departments' if kind == 'departments' else 'job_roles'
    identity = data.get('id') or None
    if identity is not None:
        check(isinstance(identity, str) and db[table].exists({'id': identity}), 'Record was not found.', 404)
    if data.get('delete') is True:
        check(identity is not None, 'Record was not found.', 404)
        target_type = 'department' if kind == 'departments' else 'job_role'
        db['course_assignments'].delete({'target_type': target_type, 'target_id': identity})
        db[table].delete({'id': identity})
        audit(db, user['id'], f'{target_type}_deleted', identity)
        return org(db, user)
    name = text(data, 'name', 2, 80)
    if kind == 'departments':
        if identity:
            db['departments'].update({'id': identity}, {'name': name})
        else:
            identity = uid()
            db['departments'].insert({'id': identity, 'name': name, 'created_at': now()})
    else:
        department = ref(db, data, 'departmentId', 'departments', 'department')
        if identity:
            db['job_roles'].update({'id': identity}, {'name': name, 'department_id': department})
        else:
            identity = uid()
            db['job_roles'].insert({'id': identity, 'name': name, 'department_id': department, 'created_at': now()})
    audit(db, user['id'], f'{kind[:-1].replace("-", "_")}_saved', identity, name)
    return org(db, user)


def people(db, user):
    if user['role'] == 'manager':
        ids = team(db, user['id'])
    else:
        ids = None
    rows = sorted(db['candidates'].find({'is_active': 1, 'role': {'$ne': 'admin'}}, ['id', 'full_name', 'email', 'role', 'department_id', 'job_role_id', 'manager_id']), key=lambda r: r['full_name'])
    departments, roles = names(db, 'departments', [r['department_id'] for r in rows]), names(db, 'job_roles', [r['job_role_id'] for r in rows])
    return {'people': [{'id': r['id'], 'name': r['full_name'], 'email': r['email'], 'role': r['role'], 'departmentId': r['department_id'], 'jobRoleId': r['job_role_id'],
                        'managerId': r['manager_id'], 'department': departments.get(r['department_id']), 'jobRole': roles.get(r['job_role_id'])}
                       for r in rows if ids is None or r['id'] in ids]}


# ---------------------------------------------------------------- assignments

def assignment_rows(db, user, course_id=None):
    rows = []
    reports = team(db, user['id']) if user['role'] == 'manager' else None
    latest = db['course_assignments'].find({'course_id': course_id} if course_id else {}, sort='-assigned_at', limit=300)
    titles = names(db, 'courses', [r['course_id'] for r in latest], 'title')
    # The former inner join with courses: an assignment whose course is gone is not listed.
    assignments = [r for r in latest if r['course_id'] in titles and (reports is None or (r['target_type'] == 'employee' and r['target_id'] in reports))]
    if not assignments:
        return rows
    # Members of every target, target names and completions are read once for all assignments (same rules as
    # target_employees, target_name and progress_index's "completed": any run of the course has been completed).
    members = {'employee': {}, 'department': {}, 'job_role': {}}
    for c in db['candidates'].find({'is_active': 1, 'role': {'$ne': 'admin'}}, ['id', 'department_id', 'job_role_id']):
        members['employee'].setdefault(c['id'], []).append(c['id'])
        members['department'].setdefault(c['department_id'], []).append(c['id'])
        members['job_role'].setdefault(c['job_role_id'], []).append(c['id'])
    people_names = names(db, 'candidates', [r['target_id'] for r in assignments if r['target_type'] == 'employee'] + [r['assigned_by'] for r in assignments], 'full_name')
    targets = {'employee': people_names,
               'department': names(db, 'departments', [r['target_id'] for r in assignments if r['target_type'] == 'department']),
               'job_role': names(db, 'job_roles', [r['target_id'] for r in assignments if r['target_type'] == 'job_role'])}
    course_ids = sorted({r['course_id'] for r in assignments})
    done = {(r['candidate_id'], r['course_id']) for r in db['course_runs'].find({'completed_at': {'$ne': None}, 'course_id': {'$in': course_ids}}, ['candidate_id', 'course_id'])}
    for r in assignments:
        employees = members[r['target_type']].get(r['target_id'], [])
        completed = sum((e, r['course_id']) in done for e in employees)
        rows.append({'id': r['id'], 'courseId': r['course_id'], 'course': titles[r['course_id']], 'targetType': r['target_type'], 'targetId': r['target_id'], 'target': targets[r['target_type']].get(r['target_id'], 'Removed'),
                     'mandatory': bool(r['mandatory']), 'dueDate': r['due_date'], 'deadlineAt': r['deadline_at'], 'deadlineDisplay': format_deadline(r['deadline_at']) if r['deadline_at'] else None, 'deadlineInput': local_input(r['deadline_at']),
                     'originalDisplay': format_deadline(r['original_deadline_at']) if r['original_deadline_at'] and r['original_deadline_at'] != r['deadline_at'] else None, 'note': r['note'], 'assignedBy': people_names.get(r['assigned_by']), 'assignedAt': r['assigned_at'],
                     'employees': len(employees), 'completed': completed, 'canRemove': user['role'] != 'manager' or r['assigned_by'] == user['id']})
    return rows


def deadline_input(data):
    """The exact UTC deadline from a form's date and time (portal timezone) or an older date-only request."""
    value = data.get('deadline') or None
    if value is not None:
        check(isinstance(value, str) and len(value) <= 40, 'Enter a valid deadline date and time.')
        try:
            return utc_iso(parse_utc(value))
        except (ValueError, OverflowError):
            check(False, 'Enter a valid deadline date and time.')
    due = opt_date(data, 'dueDate', 'Due date')
    return end_of_day(due) if due else None


def create_assignment(db, user, data):
    """Create an assignment, or update the existing one for the same course and target."""
    require(user, 'courses.assign')
    course = course_or_404(db, data.get('courseId') if isinstance(data.get('courseId'), str) else '')
    check(course['status'] == 'published', 'Only published courses can be assigned.', 409)
    mandatory = flag(data, 'mandatory')
    kind, target = target_input(db, user, data, mandatory)
    deadline = deadline_input(data)
    check(not mandatory or deadline is not None, 'Mandatory training requires a completion deadline.')
    note = opt_text(data, 'note', 500, 'Note')
    existing = db['course_assignments'].find_one({'course_id': course['id'], 'target_type': kind, 'target_id': target})
    changed_deadline = (existing['deadline_at'] if existing else None) != deadline
    # An overdue assignment can keep its deadline while another field is edited, but a new deadline must be in the future.
    check(not changed_deadline or deadline is None or parse_utc(deadline) > datetime.now(timezone.utc), 'The completion deadline cannot be in the past.')
    due = local_date(deadline) if deadline else None
    stamp = now()
    if existing:
        check(user['role'] != 'manager' or not existing['mandatory'], 'This mandatory assignment is managed by HR.', 403)
        identity = existing['id']
        fields = {'mandatory': int(mandatory), 'due_date': due, 'deadline_at': deadline,
                  'original_deadline_at': existing['original_deadline_at'] if existing['original_deadline_at'] is not None else deadline,
                  'note': note, 'assigned_by': user['id'], 'assigned_at': stamp}
        if changed_deadline and existing['deadline_at']:
            fields.update(deadline_updated_at=stamp, deadline_updated_by=user['id'])
        db['course_assignments'].update({'id': identity}, fields)
    else:
        identity = uid()
        db['course_assignments'].insert({'id': identity, 'course_id': course['id'], 'target_type': kind, 'target_id': target, 'mandatory': int(mandatory), 'due_date': due,
                                         'deadline_at': deadline, 'original_deadline_at': deadline, 'note': note, 'assigned_by': user['id'], 'assigned_at': stamp})
    label = 'Mandatory training assigned' if mandatory else ('Training recommended by your manager' if user['role'] == 'manager' else 'New training assigned')
    employees = target_employees(db, kind, target)
    assigned, progress = assignment_index(db, employees, [course['id']]), progress_index(db, employees, [course['id']])
    for employee in employees:
        pair = (employee, course['id'])
        # Employees whose own assignment outranks this one, and those already finished, have nothing new to act on.
        if assigned[pair]['assignmentId'] != identity or (progress.get(pair) or {}).get('completed'):
            continue
        if not existing:
            reminders.announce_assignment(db, employee, course['id'], course['title'], assigned[pair], f'{label}: {course["title"]}')
        elif changed_deadline and deadline:
            reminders.announce_change(db, employee, course['id'], course['title'], assigned[pair], progress.get(pair))
    if changed_deadline and existing and existing['deadline_at']:
        audit(db, user['id'], 'course_deadline_changed', identity, f'{course["title"]} -> {kind}:{target_name(db, kind, target)}: {existing["deadline_at"]} to {deadline or "none"}')
    audit(db, user['id'], 'course_assigned', identity, f'{course["title"]} -> {kind}:{target_name(db, kind, target)}{" (mandatory)" if mandatory else ""}')
    return {'assignments': assignment_rows(db, user, course['id'])}


def course_deadlines(db, user, query):
    """Course Deadline Settings: assignment targets plus the deadline each employee actually has."""
    require(user, 'courses.assign')
    course = course_or_404(db, query.get('courseId', [''])[0])
    config = reminders.settings(db)
    soon = config['dueSoonDays'] * 86400
    assigned = assignment_index(db, None, [course['id']])
    people_rows = {r['id']: r for r in db['candidates'].find({'id': {'$in': list({pair[0] for pair in assigned})}}, ['id', 'full_name', 'email', 'role', 'department_id'])}
    departments = names(db, 'departments', [r['department_id'] for r in people_rows.values()])
    for r in people_rows.values():
        r['department'] = departments.get(r['department_id'])
    reports = team(db, user['id']) if user['role'] == 'manager' else None
    ids = [pair[0] for pair in assigned if people_rows[pair[0]]['role'] != 'admin' and (reports is None or pair[0] in reports)]
    progress = progress_index(db, ids, [course['id']]) if ids else {}
    # Each employee's latest reminder (MAX(COALESCE(sent_at,created_at)) per employee, with the type and status of the row
    # holding the maximum; as in SQLite, the first such row in (created_at, id) order wins a tie).
    last = {}
    for r in db['deadline_reminders'].find({'course_id': course['id']}, ['id', 'employee_id', 'reminder_type', 'status', 'sent_at', 'created_at'], sort=['created_at', 'id']):
        stamp = r['sent_at'] if r['sent_at'] is not None else r['created_at']
        best = last.get(r['employee_id'])
        if best is None or (stamp is not None and (best['at'] is None or stamp > best['at'])):
            last[r['employee_id']] = {'employee_id': r['employee_id'], 'reminder_type': r['reminder_type'], 'status': r['status'], 'at': stamp}
    at = datetime.now(timezone.utc)
    employees = []
    for employee in ids:
        pair = (employee, course['id'])
        a, p, person = assigned[pair], progress.get(pair), people_rows[employee]
        status = deadline_status(p, a, soon, at)
        employees.append({'employeeId': employee, 'name': person['full_name'], 'email': person['email'], 'department': person['department'] or '', 'assignmentId': a['assignmentId'], 'source': a['targetType'],
                          'mandatory': a['mandatory'], 'deadlineAt': a['deadlineAt'], 'deadlineDisplay': format_deadline(a['deadlineAt']) if a['deadlineAt'] else None, 'deadlineInput': local_input(a['deadlineAt']),
                          'originalDisplay': format_deadline(a['originalDeadlineAt']) if a['originalDeadlineAt'] and a['originalDeadlineAt'] != a['deadlineAt'] else None,
                          'status': status, 'statusLabel': STATUS_LABELS[status], 'progress': 100 if p and p['completed'] else (p or {}).get('progress', 0), 'completedDisplay': format_deadline(p['completedAt']) if p and p['completed'] and p['completedAt'] else None,
                          'lastReminder': last.get(employee), 'nextReminderAt': None if status.startswith('completed') or not a['deadlineAt'] else reminders.next_reminder(a, config, at)})
    employees.sort(key=lambda e: e['name'])
    return {'courseId': course['id'], 'timezone': timezone_label(at), 'targets': assignment_rows(db, user, course['id']), 'employees': employees}


def reminder_staff(user):
    check(user['role'] in ('admin', 'hr'), 'Only administrators and HR can manage deadline reminders.', 403)


def reminder_settings_view(db, user):
    reminder_staff(user)
    return {'settings': reminders.settings(db)}


def save_reminder_settings(db, user, data):
    reminder_staff(user)
    saved = reminders.save_settings(db, user, data)
    audit(db, user['id'], 'reminder_settings_changed', 'reminder_settings', f'{saved["intervalDays"]} days before; due soon {saved["dueSoonDays"]} days')
    return {'settings': saved}


def run_reminders(db, user):
    reminder_staff(user)
    summary = reminders.process_all(db)
    audit(db, user['id'], 'reminders_processed', 'reminder_settings', json.dumps(summary))
    return {'summary': summary, 'settings': reminders.settings(db)}


def reminder_history(db, user, query):
    reminder_staff(user)
    course = query.get('courseId', [None])[0]
    rows = db['deadline_reminders'].find({'course_id': course} if course else {}, sort='-id', limit=100)
    employees, titles = names(db, 'candidates', [r['employee_id'] for r in rows], 'full_name'), names(db, 'courses', [r['course_id'] for r in rows], 'title')
    # Reminders are deleted with their employee, so the former inner join with candidates never dropped a row.
    return {'history': [{'id': r['id'], 'employeeId': r['employee_id'], 'employee': employees[r['employee_id']], 'assignmentId': r['assignment_id'], 'courseId': r['course_id'],
                         'course': titles.get(r['course_id']), 'type': r['reminder_type'], 'channel': r['channel'], 'deadlineAt': r['deadline_at'], 'scheduledAt': r['scheduled_at'],
                         'sentAt': r['sent_at'], 'status': r['status'], 'attempts': r['attempts'], 'failureReason': r['failure_reason']}
                        for r in rows if r['employee_id'] in employees]}


def delete_assignment(db, user, identity):
    require(user, 'courses.assign')
    row = db['course_assignments'].get(identity)
    check(row is not None, 'Assignment was not found.', 404)
    check(user['role'] != 'manager' or row['assigned_by'] == user['id'], 'Managers can remove only the training they recommended.', 403)
    db['course_assignments'].delete({'id': identity})
    audit(db, user['id'], 'assignment_removed', identity, row['course_id'])
    return {'assignments': assignment_rows(db, user, row['course_id'])}


# ---------------------------------------------------------------- course preview, resources, materials

def owned_course(db, user, identity):
    require(user, 'courses.manage')
    course = course_or_404(db, identity)
    check(owns_course(user, course), 'Trainers can manage only the courses they own.', 403)
    return course


def course_resources(db, course_id):
    rows = sorted(db['course_resources'].find({'course_id': course_id}), key=lambda r: (r['module_index'] is None, r['module_index'] or 0, r['created_at']))
    return [{'id': r['id'], 'moduleIndex': r['module_index'], 'title': r['title'], 'kind': r['kind'], 'url': r['url']} for r in rows]


def preview(db, user, identity):
    course = owned_course(db, user, identity)
    return {'course': public_curriculum(db, identity), 'lessons': json.loads(course['lessons_json']), 'courseInfo': course_view(course, False, db), 'resources': course_resources(db, identity)}


def save_resource(db, user, course_id, data):
    course = owned_course(db, user, course_id)
    title = text(data, 'title', 2, 150)
    kind = choice(data, 'kind', ('document', 'presentation', 'video', 'link'), 'resource type')
    url = text(data, 'url', 1, 2000)
    check(media_reference(url), 'Resource location must be an uploaded material, an assets/ path, or an HTTPS URL.')
    material = re.fullmatch(r'api/materials/([0-9a-f-]{36})', url)
    check(material is None or db['materials'].exists({'id': material.group(1)}), 'The uploaded material was not found.')
    module = data.get('moduleIndex')
    check(module is None or (type(module) is int and 0 <= module <= 2), 'Select a valid module.')
    identity = uid()
    db['course_resources'].insert({'id': identity, 'course_id': course_id, 'module_index': module, 'title': title, 'kind': kind, 'url': url, 'created_by': user['id'], 'created_at': now()})
    audit(db, user['id'], 'resource_added', course_id, title)
    if course['status'] == 'published':  # Read above in this transaction; nothing in between changes it.
        from notifications import resource_added
        resource_added(db, course_id, title, identity)
    return {'resources': course_resources(db, course_id)}


def delete_resource(db, user, identity):
    row = db['course_resources'].get(identity)
    check(row is not None, 'Resource was not found.', 404)
    owned_course(db, user, row['course_id'])
    db['course_resources'].delete({'id': identity})
    audit(db, user['id'], 'resource_removed', row['course_id'], row['title'])
    return {'resources': course_resources(db, row['course_id'])}


def store_material(db, user, filename, body):
    require(user, 'courses.manage')
    name = Path(filename or '').name.strip()
    suffix = Path(name).suffix.lower()
    check(2 <= len(name) <= 200 and suffix in MATERIAL_TYPES, 'Upload a PDF, Office document, text, CSV, image, caption, or MP4/WebM video file.', 415)
    check(0 < len(body) <= MAX_MATERIAL_BYTES, 'Files must be between 1 byte and 50 MB.', 413)
    MATERIALS.mkdir(parents=True, exist_ok=True)
    identity = uid()
    stored = identity + suffix
    (MATERIALS / stored).write_bytes(body)
    db['materials'].insert({'id': identity, 'original_name': name, 'content_type': MATERIAL_TYPES[suffix], 'size': len(body), 'stored_name': stored, 'uploaded_by': user['id'], 'uploaded_at': now()})
    audit(db, user['id'], 'material_uploaded', identity, name)
    return {'material': {'id': identity, 'name': name, 'size': len(body), 'url': f'api/materials/{identity}'}}


def material_file(db, user, identity):
    """Materials live outside the public folder; employees may open only those used by published courses."""
    row = db['materials'].get(identity)
    check(row is not None, 'File was not found.', 404)
    url = f'api/materials/{identity}'
    if not allowed(user, 'courses.manage'):
        used = db['courses'].exists({'id': {'$in': db['course_resources'].distinct('course_id', {'url': url})}, 'status': 'published'}) or \
            db['courses'].exists({'status': 'published', 'lessons_json': {'$regex': re.escape(url)}}) or \
            db['session_registrations'].exists({'session_id': {'$in': db['training_sessions'].distinct('id', {'recording_url': url})}, 'employee_id': user['id'], 'status': {'$in': ['registered', 'attended']}})
        check(used, 'This file is not part of a published course.', 403)
    path = (MATERIALS / row['stored_name']).resolve()
    check(path.is_relative_to(MATERIALS.resolve()) and path.is_file(), 'File was not found.', 404)
    return path, row['content_type'], row['original_name']


# ---------------------------------------------------------------- assessments (question banks)

def owns_assessment(db, user, row, courses=None):
    """`courses` (id -> row), when given, replaces the per-assessment course lookup."""
    if user['role'] in ('admin', 'hr'):
        return True
    if row['created_by'] == user['id']:
        return True
    if not row['course_id']:
        return False
    course = courses.get(row['course_id']) if courses is not None else db['courses'].get(row['course_id'])
    return course is not None and owns_course(user, course)


def assessment_views(db, rows, private=False):
    """Views for many assessments with a fixed number of queries: attempt statistics, question banks and history read once."""
    ids = [r['id'] for r in rows]
    stats, banks, attempted = {}, {}, set()
    if ids:
        for r in db['assessment_attempts'].aggregate([{'$match': {'assessment_id': {'$in': ids}, 'status': {'$ne': 'in-progress'}}},
                                                      {'$group': {'_id': '$assessment_id', 'count': {'$sum': 1}, 'passed': {'$sum': {'$cond': [{'$eq': ['$status', 'passed']}, 1, 0]}},
                                                                  'average': {'$avg': '$percent'}}}]):
            stats[r['_id']] = (r['count'], r['passed'], r['average'])
        if private:
            for q in db['assessment_bank'].find({'assessment_id': {'$in': ids}}, sort=['assessment_id', 'position']):
                banks.setdefault(q['assessment_id'], []).append([q['prompt'], json.loads(q['options_json']), q['correct_option'], q['explanation']] + ([q['code']] if q['code'] else []))
            attempted.update(db['assessment_attempts'].distinct('assessment_id', {'assessment_id': {'$in': ids}}))
    views = []
    for row in rows:
        count, passed, average = stats.get(row['id'], (0, None, None))
        result = {'id': row['id'], 'title': row['title'], 'description': row['description'], 'kind': row['kind'], 'courseId': row['course_id'],
                  'passPercent': row['pass_percent'], 'maxAttempts': row['max_attempts'], 'questionCount': row['question_count'], 'timeLimitMinutes': row['time_limit_minutes'], 'status': row['status'],
                  'attempts': count, 'passRate': round((passed or 0) / count * 100) if count else None, 'averageScore': round(average) if average is not None else None}
        if private:
            result['questions'] = banks.get(row['id'], [])
            result['locked'] = count > 0 or row['id'] in attempted
        views.append(result)
    return views


def assessment_view(db, row, private=False):
    return assessment_views(db, [row], private)[0]


def assessment_list(db, user):
    require(user, 'assessments.manage')
    courses = None if user['role'] in ('admin', 'hr') else {c['id']: c for c in db['courses'].find({}, ['id', 'trainer_id', 'created_by'])}
    return {'assessments': assessment_views(db, [r for r in sorted(db['assessments'].find(), key=lambda r: r['title']) if owns_assessment(db, user, r, courses)], True)}


def save_assessment(db, user, data):
    identity = store_assessment(db, user, data)
    return {'assessment': assessment_view(db, db['assessments'].get(identity), True), **assessment_list(db, user)}


def save_course_assessment(db, user, course_id, course_title, payload, course_status):
    """Save the assessment built inside Manage Courses as the course's required post-training assessment."""
    course = db['courses'].get(course_id, ['post_assessment_id'])
    current = db['assessments'].find_one({'id': course['post_assessment_id'], 'kind': 'post', 'course_id': course_id}) if course and course['post_assessment_id'] is not None else None
    if payload is None:
        if current:  # Archive rather than delete so attempt history is kept.
            db['assessments'].update({'id': current['id']}, {'status': 'archived', 'updated_at': now()})
        return None
    check(isinstance(payload, dict), 'The course assessment is invalid.')
    items = payload.get('questions')
    check(isinstance(items, list) and items, 'Add at least one question to the assessment, or remove the assessment.')
    questions = []
    for i, q in enumerate(items):
        check(isinstance(q, dict), f'Question {i + 1} is invalid.')
        questions.append([q.get('prompt'), q.get('options'), q.get('correct'), q.get('explanation') or '', q.get('code') or ''])
    status = {'published': 'published', 'archived': 'archived'}.get(course_status, 'draft')
    count = payload.get('questionCount') or len(items)
    return store_assessment(db, user, {'id': current['id'] if current else None, 'title': payload.get('title') or f'{course_title} assessment', 'description': payload.get('description') or '',
                                       'kind': 'post', 'courseId': course_id, 'passPercent': payload.get('passPercent'), 'maxAttempts': payload.get('maxAttempts'),
                                       'timeLimitMinutes': payload.get('timeLimitMinutes'), 'questionCount': count, 'status': status, 'questions': questions})


def store_assessment(db, user, data):
    require(user, 'assessments.manage')
    identity = bound(data.get('id') or None)
    old = db['assessments'].get(identity) if identity else None
    check(identity is None or old is not None, 'Assessment was not found.', 404)
    check(old is None or owns_assessment(db, user, old), 'You can edit only the assessments you own.', 403)
    title, description = text(data, 'title', 2, 150), opt_text(data, 'description', 2000, 'Description')
    kind = choice(data, 'kind', KINDS, 'assessment type')
    course = ref(db, data, 'courseId', 'courses', 'course', required=kind in ('pre', 'post'))
    if course and user['role'] == 'trainer':
        check(owns_course(user, course_or_404(db, course)), 'Trainers can link assessments only to their own courses.', 403)
    pass_percent = integer(data, 'passPercent', 1, 100, 'Passing score')
    attempts = integer(data, 'maxAttempts', 1, MAX_EXAM_ATTEMPTS, 'Attempts allowed')
    limit = integer(data, 'timeLimitMinutes', 1, 240, 'Time limit')
    status = choice(data, 'status', ('draft', 'published', 'archived'), 'status', 'draft')
    questions = questions_input(data)
    count = integer(data, 'questionCount', 1, len(questions), 'Questions per attempt')
    has_attempts = old is not None and db['assessment_attempts'].exists({'assessment_id': identity})
    if has_attempts:
        stored = assessment_view(db, old, True)['questions']
        check(stored == questions and old['kind'] == kind, 'Employees have attempted this assessment. Create a new assessment to change its questions or type.', 409)
    fields = {'title': title, 'description': description, 'kind': kind, 'course_id': course, 'pass_percent': pass_percent, 'max_attempts': attempts, 'question_count': count,
              'time_limit_minutes': limit, 'status': status}
    if old:
        db['assessments'].update({'id': identity}, dict(fields, updated_at=now()))
    else:
        identity = uid()
        db['assessments'].insert(dict(fields, id=identity, created_by=user['id'], created_at=now(), updated_at=now()))
    if not has_attempts:
        db['assessment_bank'].delete({'assessment_id': identity})
        db['assessment_bank'].insert_many([{'id': uid(), 'assessment_id': identity, 'position': position, 'prompt': q[0], 'options_json': json.dumps(q[1]), 'correct_option': q[2],
                                            'explanation': q[3], 'code': q[4] if len(q) > 4 else ''} for position, q in enumerate(questions)])
    audit(db, user['id'], 'assessment_saved', identity, f'{status}: {title}')
    return identity


def assessment_attempts(db, user, identity, query):
    require(user, 'assessments.manage')
    row = db['assessments'].get(identity)
    check(row is not None, 'Assessment was not found.', 404)
    check(owns_assessment(db, user, row), 'You can review only the assessments you own.', 403)
    attempts = sorted(db['assessment_attempts'].find({'assessment_id': identity}), key=lambda t: t['started_at'], reverse=True)
    people = {c['id']: c for c in db['candidates'].find({'id': {'$in': list({t['employee_id'] for t in attempts})}}, ['id', 'full_name', 'department_id'])} if attempts else {}
    departments = names(db, 'departments', [c['department_id'] for c in people.values()])
    items = [{'id': t['id'], 'employee': people[t['employee_id']]['full_name'], 'department': departments.get(people[t['employee_id']]['department_id']), 'attempt_number': t['attempt_number'],
              'status': t['status'], 'score': t['score'], 'total': t['total'], 'percent': t['percent'], 'started_at': t['started_at'], 'finished_at': t['finished_at']}
             for t in attempts if t['employee_id'] in people]
    return {'assessment': assessment_view(db, row), **pages(items, query)}


def expire_assessments(db, employee):
    db['assessment_attempts'].update({'employee_id': employee, 'status': 'in-progress', 'deadline': {'$lt': time.time()}}, {'status': 'expired', 'finished_at': now()})


def visible_assessments(db):
    """Published assessments whose course (if any) is published, ordered by kind and title, with the course title as course_title."""
    rows = db['assessments'].find({'status': 'published'})
    courses = {c['id']: c for c in db['courses'].find({'id': {'$in': list({a['course_id'] for a in rows if a['course_id'] is not None})}}, ['id', 'title', 'status'])} if rows else {}
    visible = [dict(a, course_title=courses[a['course_id']]['title'] if a['course_id'] in courses else None) for a in rows
               if a['course_id'] is None or (a['course_id'] in courses and courses[a['course_id']]['status'] == 'published')]
    return sorted(visible, key=lambda a: (a['kind'], a['title']))


def attempt_questions(db, attempt):
    ids = json.loads(attempt['question_ids_json'])
    rows = {r['id']: r for r in db['assessment_bank'].find({'id': {'$in': ids}})}
    return [rows[i] for i in ids]


def option_orders(attempt, questions):
    """Display order of each question's options for an attempt; attempts made before shuffling use the bank order."""
    stored = json.loads(attempt['option_orders_json'] or '[]')
    return stored if len(stored) == len(questions) else [list(range(len(json.loads(q['options_json'])))) for q in questions]


def active_attempt_view(db, attempt):
    questions = attempt_questions(db, attempt)
    orders = option_orders(attempt, questions)
    return {'id': attempt['id'], 'assessmentId': attempt['assessment_id'], 'attemptNumber': attempt['attempt_number'], 'deadline': attempt['deadline'] * 1000,
            'questions': [{'id': q['id'], 'prompt': q['prompt'], 'code': q['code'], 'options': [json.loads(q['options_json'])[i] for i in order]} for q, order in zip(questions, orders)]}


def my_assessments(db, user):
    expire_assessments(db, user['id'])
    result = []
    # The employee's attempts for every assessment are read in one query (indexed by employee), then grouped.
    history, open_attempts = {}, {}
    for r in db['assessment_attempts'].find({'employee_id': user['id']}, sort=['assessment_id', 'attempt_number']):
        history.setdefault(r['assessment_id'], []).append({k: r[k] for k in ('id', 'attempt_number', 'status', 'percent', 'reason', 'started_at', 'finished_at')})
        if r['status'] == 'in-progress':
            open_attempts[r['assessment_id']] = r
    for a in visible_assessments(db):
        attempts = history.get(a['id'], [])
        active = open_attempts.get(a['id'])
        result.append({'id': a['id'], 'title': a['title'], 'description': a['description'], 'kind': a['kind'], 'course': a['course_title'], 'courseId': a['course_id'],
                       'passPercent': a['pass_percent'], 'maxAttempts': a['max_attempts'],
                       'questionCount': a['question_count'], 'timeLimitMinutes': a['time_limit_minutes'], 'attempts': attempts,
                       'passed': any(t['status'] == 'passed' for t in attempts), 'best': max([t['percent'] for t in attempts if t['percent'] is not None], default=None),
                       'attemptsLeft': max(0, a['max_attempts'] - len(attempts)), 'active': active_attempt_view(db, active) if active else None})
    return {'assessments': result}


def start_assessment(db, user, identity):
    expire_assessments(db, user['id'])
    a = next((r for r in visible_assessments(db) if r['id'] == identity), None)
    check(a is not None, 'This assessment is not available.', 404)
    # Attempts cannot be resumed: one still open was interrupted (page closed or reloaded), so it ends and counts as used.
    db['assessment_attempts'].update({'assessment_id': identity, 'employee_id': user['id'], 'status': 'in-progress'},
                                     {'status': 'terminated', 'reason': 'The attempt was interrupted before it was submitted.', 'finished_at': now()})
    used = db['assessment_attempts'].count({'assessment_id': identity, 'employee_id': user['id']})
    check(used < a['max_attempts'], f'All {a["max_attempts"]} attempts have been used for this assessment.', 409)
    # Ids and option counts of the whole bank in one read (in the bank's index order, assessment then position).
    rows = db['assessment_bank'].find({'assessment_id': identity}, ['id', 'options_json'], sort='position')
    bank = [r['id'] for r in rows]
    check(len(bank) >= a['question_count'], 'This assessment does not have enough questions yet. Contact the course owner.', 409)
    # Randomised selection from the question bank for every attempt.
    generator = random.SystemRandom()
    chosen = generator.sample(bank, a['question_count'])
    # Answer positions are shuffled too, so the correct option is not always in the same place.
    sizes = {r['id']: len(json.loads(r['options_json'])) for r in rows}
    orders = [generator.sample(range(sizes[q]), sizes[q]) for q in chosen]
    attempt = uid()
    row = db['assessment_attempts'].insert({'id': attempt, 'assessment_id': identity, 'employee_id': user['id'], 'attempt_number': used + 1, 'question_ids_json': json.dumps(chosen),
                                            'option_orders_json': json.dumps(orders), 'status': 'in-progress', 'started_at': now(), 'deadline': time.time() + a['time_limit_minutes'] * 60, 'total': len(chosen)})
    activity.attempt_started(db, user['id'], 'assessment', attempt, course=a['course_id'], assessment=identity, title=a['title'], number=used + 1)
    return {'attempt': active_attempt_view(db, row)}


def terminate_assessment(db, user, identity, data):
    """End an attempt that broke the exam rules (left full screen, switched tabs or windows, navigated away). It counts as used."""
    attempt = db['assessment_attempts'].find_one({'id': bound(data.get('attemptId')), 'assessment_id': identity, 'employee_id': user['id']})
    check(attempt is not None, 'Attempt was not found.', 404)
    reason = data.get('reason') if isinstance(data.get('reason'), str) and data['reason'].strip() else 'The attempt was ended before it was submitted.'
    if attempt['status'] == 'in-progress':
        db['assessment_attempts'].update({'id': attempt['id']}, {'status': 'terminated', 'reason': reason[:200], 'finished_at': now()})
        a = db['assessments'].get(identity, ['title'])
        notify(db, [user['id']], 'assessment', f'Assessment attempt terminated: {a["title"]}', reason[:200], 'assessments', f'assessment:{attempt["id"]}')
    ended = db['assessment_attempts'].get(attempt['id'], ['status', 'reason'])
    return {'result': {'status': ended['status'], 'reason': ended['reason'], 'percent': None, 'details': []}}


def submit_assessment(db, user, identity, data):
    attempt = db['assessment_attempts'].find_one({'id': bound(data.get('attemptId')), 'assessment_id': identity, 'employee_id': user['id']})
    check(attempt is not None, 'Attempt was not found.', 404)
    check(attempt['status'] == 'in-progress', 'This attempt has already ended.', 409)
    a = db['assessments'].get(identity)
    if time.time() > attempt['deadline'] + 5:
        db['assessment_attempts'].update({'id': attempt['id']}, {'status': 'expired', 'finished_at': now()})
        notify(db, [user['id']], 'assessment', f'Assessment time expired: {a["title"]}', 'The attempt ended without a score.', 'assessments', f'assessment:{attempt["id"]}')
        return {'result': {'status': 'expired', 'percent': None, 'details': []}}
    questions = attempt_questions(db, attempt)
    answers = data.get('answers')
    check(isinstance(answers, list) and len(answers) == len(questions), 'Answer every question before submitting.')
    check(all(type(x) is int and 0 <= x < len(json.loads(q['options_json'])) for x, q in zip(answers, questions)), 'Invalid answer selection.')
    answers = [order[x] for x, order in zip(answers, option_orders(attempt, questions))]  # Displayed position -> bank option.
    details = [{'correct': x == q['correct_option'], 'explanation': q['explanation'], 'answer': json.loads(q['options_json'])[q['correct_option']]} for x, q in zip(answers, questions)]
    score = sum(d['correct'] for d in details)
    percent = round(score / len(questions) * 100)
    status = 'passed' if percent >= a['pass_percent'] else 'failed'
    db['assessment_attempts'].update({'id': attempt['id']}, {'status': status, 'score': score, 'percent': percent, 'answers_json': json.dumps(answers), 'finished_at': now()})
    activity.attempt_finished(db, user['id'], 'assessment', attempt['id'], status, score=score, total=len(questions), percent=percent, pass_percent=a['pass_percent'],
                              course=a['course_id'], assessment=identity, title=a['title'], number=attempt['attempt_number'])
    if status == 'passed' and a['kind'] == 'post' and a['course_id']:
        run = db['course_runs'].find_one({'candidate_id': user['id'], 'course_id': a['course_id'], 'archived_at': None}, ['id'])
        if run:
            issue_certificate(db, user['id'], run['id'])
    notify(db, [user['id']], 'assessment', f'Assessment {"passed" if status == "passed" else "not passed"}: {a["title"]}', f'You scored {percent}% (pass mark {a["pass_percent"]}%).', 'assessments', f'assessment:{attempt["id"]}')
    return {'result': {'status': status, 'score': score, 'total': len(questions), 'percent': percent, 'passPercent': a['pass_percent'], 'details': details}}


# ---------------------------------------------------------------- training sessions

def session_rows(db, user=None, upcoming_only=False, where=None):
    """Sessions ordered by start, with trainer name, course title and seats taken. `where` is a MongoDB filter on training_sessions."""
    if upcoming_only:
        where = {'status': 'scheduled', 'ends_at': {'$gte': local_now()}}
    sessions = sorted(db['training_sessions'].find(where or {}), key=lambda s: s['starts_at'])
    if not sessions:
        return []
    ids = [s['id'] for s in sessions]
    trainers, titles = names(db, 'candidates', [s['trainer_id'] for s in sessions], 'full_name'), names(db, 'courses', [s['course_id'] for s in sessions], 'title')
    taken = counts(db, 'session_registrations', {'session_id': {'$in': ids}, 'status': {'$in': ['registered', 'attended']}}, 'session_id')
    # The user's own registration status for every session in one read (what live_training.my_status returns per session).
    statuses = {g['session_id']: g['status'] for g in db['session_registrations'].find({'session_id': {'$in': ids}, 'employee_id': user['id']}, ['session_id', 'status'])} if user is not None else {}
    raws = [dict(s, trainer=trainers.get(s['trainer_id']), course=titles.get(s['course_id']), registered=taken.get(s['id'], 0)) for s in sessions]
    # Meeting links, assessments, feedback and Q&A for every session in a few batched reads (row_extras per session before).
    extras = live_training.rows_extras(db, user, raws, statuses)
    rows = []
    for r, extra in zip(raws, extras):
        item = {'id': r['id'], 'title': r['title'], 'description': r['description'], 'kind': r['kind'], 'courseId': r['course_id'], 'course': r['course'], 'trainerId': r['trainer_id'], 'trainer': r['trainer'],
                'location': r['location'], 'startsAt': r['starts_at'], 'endsAt': r['ends_at'], 'capacity': r['capacity'], 'registered': r['registered'],
                'seatsLeft': max(0, r['capacity'] - r['registered']), 'status': r['status']}
        if user is not None:
            item['myStatus'] = statuses.get(r['id'])
            item['canEdit'] = live_training.is_staff(user, r)
        item.update(extra)
        rows.append(item)
    return rows


def save_session(db, user, data):
    require(user, 'sessions.manage')
    identity = bound(data.get('id') or None)
    old = db['training_sessions'].get(identity) if identity else None
    check(identity is None or old is not None, 'Session was not found.', 404)
    check(old is None or user['role'] in ('admin', 'hr') or user['id'] in (old['trainer_id'], old['created_by']), 'Trainers can edit only their own sessions.', 403)
    title, description = text(data, 'title', 2, 150), opt_text(data, 'description', 2000, 'Description')
    kind = choice(data, 'kind', ('session', 'workshop', 'webinar'), 'session type', 'session')
    course = ref(db, data, 'courseId', 'courses', 'course')
    trainer = user['id'] if user['role'] == 'trainer' else ref(db, data, 'trainerId', 'candidates', 'trainer', {'is_active': 1, 'role': {'$in': ['admin', 'hr', 'trainer']}})
    location = opt_text(data, 'location', 200, 'Location')
    starts, ends = date_time(data, 'startsAt', 'start date and time'), date_time(data, 'endsAt', 'end date and time')
    check(ends > starts, 'The session must end after it starts.')
    capacity = integer(data, 'capacity', 1, 10000, 'Capacity')
    status = choice(data, 'status', ('scheduled', 'cancelled'), 'status', 'scheduled')
    extra = live_training.session_fields(db, data, old)
    if status == 'scheduled':
        live_training.check_trainer_free(db, trainer, starts, ends, identity)
    columns = dict(title=title, description=description, kind=kind, course_id=course, trainer_id=trainer, location=location, starts_at=starts, ends_at=ends,
                   capacity=capacity, status=status, **extra)
    if old:
        registered = db['session_registrations'].count({'session_id': identity, 'status': {'$in': ['registered', 'attended']}})
        check(capacity >= registered, f'{registered} employees are registered; capacity cannot be lower.', 409)
        db['training_sessions'].update({'id': identity}, columns)
        # SQLite read these through the (session_id, employee_id) key, so in employee id order.
        attendees = [r['employee_id'] for r in db['session_registrations'].find({'session_id': identity, 'status': 'registered'}, ['employee_id'], sort='employee_id')]
        if status == 'cancelled' and old['status'] != 'cancelled':
            notify(db, attendees, 'session', f'Session cancelled: {title}', f'The session on {starts.replace("T", " ")} has been cancelled.', 'calendar', f'session-cancel:{identity}')
        elif status == 'scheduled' and (starts, ends, location) != (old['starts_at'], old['ends_at'], old['location']):
            notify(db, attendees, 'session', f'Session updated: {title}', f'Now {starts.replace("T", " ")} at {location or "the published location"}.', 'calendar', f'session-update:{identity}:{starts}:{location}')
        live_training.after_save(db, identity, title, old, extra)
    else:
        identity = uid()
        columns.update(id=identity, created_by=user['id'], created_at=now())
        db['training_sessions'].insert(columns)
    audit(db, user['id'], 'session_saved', identity, f'{status}: {title}')
    return {'sessions': session_rows(db, user)}


def session_registrations(db, user, identity):
    require(user, 'sessions.manage')
    session = db['training_sessions'].get(identity)
    check(session is not None, 'Session was not found.', 404)
    registrations = db['session_registrations'].find({'session_id': identity}, sort='employee_id')
    people = {c['id']: c for c in db['candidates'].find({'id': {'$in': [g['employee_id'] for g in registrations]}}, ['id', 'full_name', 'email', 'department_id'])} if registrations else {}
    departments = names(db, 'departments', [c['department_id'] for c in people.values()])
    rows = [{'employeeId': g['employee_id'], 'name': people[g['employee_id']]['full_name'], 'email': people[g['employee_id']]['email'],
             'department': departments.get(people[g['employee_id']]['department_id']), 'status': g['status'], 'registeredAt': g['registered_at']}
            for g in sorted(registrations, key=lambda g: people[g['employee_id']]['full_name'] if g['employee_id'] in people else '') if g['employee_id'] in people]
    return {'registrations': live_training.registration_extras(db, session, rows)}


def mark_attendance(db, user, identity, data):
    require(user, 'sessions.manage')
    session = db['training_sessions'].get(identity)
    check(session is not None, 'Session was not found.', 404)
    check(user['role'] in ('admin', 'hr') or user['id'] in (session['trainer_id'], session['created_by']), 'Only the session trainer or HR can record attendance.', 403)
    check(session['starts_at'] <= local_now(), 'Attendance can be recorded once the session has started.', 409)
    if data.get('all') is True:
        marked = db['session_registrations'].update({'session_id': identity, 'status': 'registered'}, {'status': 'attended', 'updated_at': now()})
        audit(db, user['id'], 'attendance_recorded', identity, f'all registered: {marked}')
        return session_registrations(db, user, identity)
    employee = bound(data.get('employeeId'))
    row = db['session_registrations'].find_one({'session_id': identity, 'employee_id': employee, 'status': {'$in': ['registered', 'attended']}}, ['status'])
    check(row is not None, 'This employee is not registered for the session.', 404)
    db['session_registrations'].update({'session_id': identity, 'employee_id': employee}, {'status': 'attended' if flag(data, 'attended') else 'registered', 'updated_at': now()})
    audit(db, user['id'], 'attendance_recorded', identity, f'{employee}: {data["attended"]}')
    return session_registrations(db, user, identity)


def register_session(db, user, identity, register):
    session = db['training_sessions'].get(identity)
    check(session is not None, 'Session was not found.', 404)
    current = db['session_registrations'].find_one({'session_id': identity, 'employee_id': user['id']}, ['status'])
    if register:
        check(session['status'] == 'scheduled' and session['starts_at'] > local_now(), 'Registration is closed for this session.', 409)
        if not (current and current['status'] == 'registered'):
            taken = db['session_registrations'].count({'session_id': identity, 'status': {'$in': ['registered', 'attended']}})
            check(taken < session['capacity'], 'This session is full.', 409)
            stamp = now()
            db['session_registrations'].upsert({'session_id': identity, 'employee_id': user['id']}, {'status': 'registered', 'updated_at': stamp}, insert_only={'registered_at': stamp})
    else:
        check(current is not None and current['status'] == 'registered', 'You are not registered for this session.', 409)
        db['session_registrations'].update({'session_id': identity, 'employee_id': user['id']}, {'status': 'cancelled', 'updated_at': now()})
    return my_calendar(db, user)


def my_calendar(db, user):
    upcoming = session_rows(db, user, True)
    # Past sessions keep their recording, feedback form and post-session assessment.
    mine = db['session_registrations'].distinct('session_id', {'employee_id': user['id'], 'status': {'$in': ['registered', 'attended']}})
    past = session_rows(db, user, where={'ends_at': {'$lt': local_now()}, 'id': {'$in': mine}})
    past.reverse()
    return {'sessions': upcoming, 'past': past[:20]}


# ---------------------------------------------------------------- notifications and reminders

def refresh_reminders(db, employee, progress, assigned, titles=None):
    """Create staff overdue and inactivity reminders; dedupe keys stop repeats. Employee deadline reminders are in reminders.py
    and session reminders in live_training.py. For many employees, pass `titles` (course id -> title) read once."""
    titles = {r['id']: r['title'] for r in db['courses'].find({}, ['id', 'title'])} if titles is None else titles
    for pair, a in assigned.items():
        if a['dueDate'] and pair_status(progress.get(pair), a) == 'overdue':
            from notifications import staff_event
            staff_event(db, employee['id'], f'Overdue training: {employee["name"]}', f'{titles.get(pair[1], "Assigned course")} was due on {a["dueDate"]}.', f'team-overdue:{employee["id"]}:{pair[1]}:{a["dueDate"]}')
    stale = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M')
    week = date.today().isocalendar()
    for (e, course), item in progress.items():
        if item['started'] and not item['completed'] and item['lastActivity'] and item['lastActivity'] < stale and course in titles:
            notify(db, [e], 'reminder', f'Continue {titles[course]}', f'You are {item["progress"]}% through this course.', 'courses', f'incomplete:{course}:{week[0]}-{week[1]}')


def my_notifications(db, user):
    employee = me(db, user)
    from notifications import refresh
    refresh(db, user)
    if user['role'] in ('admin', 'hr', 'manager'):
        from analytics import scope, employee_rows
        ids, _ = scope(db, user)
        team = employee_rows(db, ids)
        team_ids = [person['id'] for person in team]
        team_progress, team_assignments = progress_index(db, team_ids), assignment_index(db, team_ids)
        by_progress, by_assignment = {}, {}
        for key, value in team_progress.items(): by_progress.setdefault(key[0], {})[key] = value
        for key, value in team_assignments.items(): by_assignment.setdefault(key[0], {})[key] = value
        # Course titles are read once for the whole team, not once per person.
        titles = {r['id']: r['title'] for r in db['courses'].find({}, ['id', 'title'])}
        for person in team:
            refresh_reminders(db, person, by_progress.get(person['id'], {}), by_assignment.get(person['id'], {}), titles)
    # Fallback only: the scheduler sends session reminders and follow-ups whether or not anyone opens the portal.
    live_training.process(db)
    own_progress, own_assigned = progress_index(db, [user['id']]), assignment_index(db, [user['id']])
    refresh_reminders(db, employee, own_progress, own_assigned)
    if user['role'] != 'admin':
        # Fallback only: the scheduler sends these whether or not the employee ever opens the portal.
        reminders.process_employee(db, user['id'], assigned=own_assigned, progress=own_progress)
    items = [{'id': r['id'], 'kind': r['kind'], 'title': r['title'], 'body': r['body'], 'link': r['link'], 'createdAt': r['created_at'], 'readAt': r['read_at']}
             for r in db['notifications'].find({'employee_id': user['id']}, ['id', 'kind', 'title', 'body', 'link', 'created_at', 'read_at'], sort='-id', limit=50)]
    return {'notifications': items, 'unread': db['notifications'].count({'employee_id': user['id'], 'read_at': None})}


def unread_count(db, user):
    """The bell's light polling endpoint: a count only, with no reminder processing."""
    return {'unread': db['notifications'].count({'employee_id': user['id'], 'read_at': None})}


def read_notifications(db, user, data):
    if data.get('all') is True:
        db['notifications'].update({'employee_id': user['id'], 'read_at': None}, {'read_at': now()})
    else:
        ids = data.get('ids')
        check(isinstance(ids, list) and len(ids) <= 100 and all(type(i) is int for i in ids), 'Select notifications to mark as read.')
        if ids:  # One update for all of them; notifications already read keep their read time (COALESCE).
            db['notifications'].update({'id': {'$in': ids}, 'employee_id': user['id'], 'read_at': None}, {'read_at': now()})
    return my_notifications(db, user)


# ---------------------------------------------------------------- employee views

def catalog(db, user, progress=None, assigned=None):
    """Published catalog with the employee's own progress and assignment details.
    Callers that already hold the employee's progress and assignments pass them in to avoid reading them twice."""
    progress = progress_index(db, [user['id']]) if progress is None else progress
    assigned = assignment_index(db, [user['id']]) if assigned is None else assigned
    lesson_counts = counts(db, 'course_lessons')
    # Assessments an employee takes in a course: its published assessments (lesson knowledge checks and the final one),
    # its timed checkpoints, and the three module exams of a 3-module course.
    assessment_counts = counts(db, 'assessments', {'course_id': {'$ne': None}, 'status': 'published'})
    checkpoint_counts = counts(db, 'course_checkpoints')
    soon = reminders.due_soon_seconds(db)
    items = []
    # Department names are read once for all courses rather than looked up once per course.
    published = sorted(db['courses'].find({'status': 'published'}), key=lambda k: k['title'])
    departments = names(db, 'departments', [k['department_id'] for k in published])
    for row in (dict(k, department_name=departments.get(k['department_id'])) for k in published):
        p, a = progress.get((user['id'], row['id'])), assigned.get((user['id'], row['id']))
        if not (a or can_view_course(db, user, row)):
            continue
        item = course_view(row, False)
        item['department'] = row['department_name']
        item.update({'progress': p['progress'] if p else 0, 'enrolled': p is not None, 'started': bool(p and p['started']), 'completed': bool(p and p['completed']), 'lastActivity': p['lastActivity'] if p else '',
                     'assignment': a, 'status': pair_status(p, a), 'deadline': deadline_view(p, a, soon), 'lessonCount': lesson_counts.get(row['id'], 0),
                     'assessmentCount': assessment_counts.get(row['id'], 0) + checkpoint_counts.get(row['id'], 0) + (3 if row['format'] != 'lessons' else 0)})
        items.append(item)
    return items


def video_file(url):
    """Resolve an api/videos/<course>/<file> path inside the videos folder; None if it is not one or would escape it."""
    match = re.fullmatch(r'api/videos/([a-z0-9-]{1,100})/([a-z0-9-]{1,100}\.(mp4|webm|vtt|jpg))', url or '')
    if not match:
        return None
    path = (VIDEO_ROOT / match.group(1) / match.group(2)).resolve()
    return path if path.is_relative_to(VIDEO_ROOT.resolve()) else None


def video_available(url):
    path = video_file(url)
    return bool(url) and (path is None or path.is_file())


def public_activity(activity_json):
    """Exercise tasks for employees: instructions and criteria labels only (no rubric keywords or model answers)."""
    if not activity_json:
        return None
    activity = json.loads(activity_json)
    return {'passPercent': activity['passPercent'], 'tasks': [{'id': t['id'], 'title': t['title'], 'instructions': t['instructions'], 'criteria': [c['label'] for c in t['criteria']]} for t in activity['tasks']]}


def lesson_view(row, staff=False):
    view = {'id': row['id'], 'title': row['title'], 'description': row['description'], 'videoUrl': row['video_url'], 'documentUrl': row['document_url'], 'documentName': row['document_name'],
            'resources': json.loads(row['resources_json']), 'content': row['content'], 'exercise': row['exercise'], 'durationMinutes': row['duration_minutes'],
            'captionsUrl': row['captions_url'], 'videoSeconds': row['video_seconds'], 'completionPercent': row['completion_percent'], 'assessmentId': row['assessment_id'],
            'updatedAt': row['updated_at'], 'moduleIndex': row['module_index'], 'moduleTitle': row['module_title'], 'sourceUrl': row['source_url']}
    if staff:
        view['hasActivity'] = bool(row['activity_json'])
    else:
        view['activity'] = public_activity(row['activity_json'])
    practice = json.loads(row['practice_json']) if row['practice_json'] else None
    view['practice'] = {k: practice[k] for k in ('instructions', 'starter', 'tests')} if practice else None
    view['quiz'] = [{'prompt': q[0], 'options': q[1]} for q in json.loads(row['quiz_json'])] if row['quiz_json'] else []
    return view


def course_video(db, user, url):
    """Lesson videos, captions and posters, served only to employees who can open the course (or manage it)."""
    path = video_file(url)
    check(path is not None, 'File was not found.', 404)
    course = db['courses'].get(path.parent.name)
    check(course is not None, 'File was not found.', 404)
    permitted = can_view_course(db, user, course) or (allowed(user, 'courses.manage') and owns_course(user, course)) or \
        db['course_runs'].exists({'candidate_id': user['id'], 'course_id': course['id']})
    check(permitted, 'This video is not available to you.', 403)
    if not (allowed(user, 'courses.manage') and owns_course(user, course)):
        from checkpoints import lesson_unlocked
        lesson = db['course_lessons'].find_one({'course_id': course['id'], 'video_url': re.sub(r'\.(vtt|jpg)$', '.mp4', url)}, ['id'])
        run = db['course_runs'].find_one({'candidate_id': user['id'], 'course_id': course['id'], 'archived_at': None}, ['id'])
        if lesson:
            check(lesson_unlocked(db, run['id'] if run else None, course['id'], lesson['id']), 'Pass the previous assignment to unlock this module.', 403)
    check(path.is_file(), 'This video has not been published yet.', 404)
    return path, VIDEO_TYPES[path.suffix], path.name


def score_activity(activity, answers):
    """Transparent rubric scoring: each criterion is met when the answer contains one of its key phrases."""
    results = []
    for task, answer in zip(activity['tasks'], answers):
        normalized = ' '.join(answer.lower().split())
        too_short = len(normalized) < 40
        criteria = [{'label': c['label'], 'met': not too_short and any(k in normalized for k in c['keywords']), 'tip': c['tip']} for c in task['criteria']]
        met = sum(c['met'] for c in criteria)
        results.append({'id': task['id'], 'title': task['title'], 'score': round(met / len(criteria) * 100), 'tooShort': too_short,
                        'criteria': [dict(c, tip='' if c['met'] else c['tip']) for c in criteria], 'modelAnswer': task['modelAnswer'], 'explanation': task.get('explanation', '')})
    return round(sum(r['score'] for r in results) / len(results)), results


def course_builder(db, user, identity):
    """Everything the Manage Courses builder needs to reopen a lesson-based course, including answer keys (staff only)."""
    course = owned_course(db, user, identity)
    check(course['format'] == 'lessons', 'This course uses the 3-module format. Edit it with the curriculum editor.', 409)
    rows = db['course_lessons'].find({'course_id': identity}, sort='position')
    ids = [r['id'] for r in rows]
    completed = {i for table in ('lesson_progress', 'lesson_watch', 'lesson_activity_attempts') for i in db[table].distinct('lesson_id', {'lesson_id': {'$in': ids}})} if ids else set()
    lessons = [dict(lesson_view(r, staff=True), hasProgress=r['id'] in completed) for r in rows]
    assessment = db['assessments'].find_one({'id': course['post_assessment_id'], 'kind': 'post', 'course_id': identity, 'status': {'$ne': 'archived'}}) if course['post_assessment_id'] is not None else None
    return {'course': course_view(course, True, db), 'lessons': lessons, 'assessment': assessment_view(db, assessment, True) if assessment else None}


def my_dashboard(db, user):
    employee = me(db, user)
    progress, assigned = progress_index(db, [user['id']]), assignment_index(db, [user['id']])
    refresh_reminders(db, employee, progress, assigned)
    courses = {c['id']: c for c in catalog(db, user, progress, assigned)}
    assigned_items = sorted([courses[c] for (_, c) in assigned if c in courses], key=lambda c: ({'overdue': 0, 'in_progress': 1, 'not_started': 2, 'completed': 3}[c['status']], c['assignment']['dueDate'] or '9999'))
    continuing = sorted([c for c in courses.values() if progress.get((user['id'], c['id']), {}).get('started') and not c['completed']], key=lambda c: c['lastActivity'], reverse=True)[:4]
    certificates = db['certificates'].count({'run_id': {'$in': db['course_runs'].distinct('id', {'candidate_id': user['id']})}})
    return {'profile': {k: employee[k] for k in ('name', 'email', 'role', 'department', 'job_role', 'manager', 'job_title')},
            'training': training_progress(db, [user['id']])[user['id']],
            'stats': {'assigned': len(assigned_items), 'inProgress': sum(1 for c in courses.values() if c['status'] == 'in_progress'), 'completed': sum(1 for c in courses.values() if c['completed']),
                      'overdue': sum(1 for c in assigned_items if c['status'] == 'overdue'), 'certificates': certificates},
            'assigned': assigned_items, 'continue': continuing, 'recommendations': recommendations(db, employee, progress, assigned),
            'sessions': [s for s in session_rows(db, user, True)][:4], 'pendingAssessments': pending_assessments(db, employee, progress),
            'history': history_items(db, user['id'])[:6]}


def history_items(db, employee):
    items = []
    # Each former join is two reads: the employee's rows, then the related titles by id (inner joins: rows without one are skipped).
    runs = db['course_runs'].find({'candidate_id': employee}, ['id', 'course_id', 'completed_at'])
    titles = names(db, 'courses', [r['course_id'] for r in runs], 'title')
    run_titles = {r['id']: titles[r['course_id']] for r in runs if r['course_id'] in titles}
    for r in runs:
        if r['course_id'] in titles and r['completed_at']:
            items.append({'type': 'completion', 'at': r['completed_at'], 'text': f'Completed {titles[r["course_id"]]} and earned a certificate'})
    exams = db['exam_attempts'].find({'run_id': {'$in': list(run_titles)}, 'status': {'$in': ['passed', 'failed']}}, ['run_id', 'finished_at', 'score', 'status', 'set_index']) if run_titles else []
    for r in exams:
        items.append({'type': 'assessment', 'at': r['finished_at'], 'text': f'{"Passed" if r["status"] == "passed" else "Attempted"} Module {r["set_index"] + 1} exam in {run_titles[r["run_id"]]} ({r["score"] * 25}%)'})
    attempts = db['assessment_attempts'].find({'employee_id': employee, 'status': {'$in': ['passed', 'failed']}}, ['assessment_id', 'finished_at', 'percent', 'status'])
    assessment_titles = names(db, 'assessments', [r['assessment_id'] for r in attempts], 'title')
    for r in attempts:
        if r['assessment_id'] in assessment_titles:
            items.append({'type': 'assessment', 'at': r['finished_at'], 'text': f'{"Passed" if r["status"] == "passed" else "Attempted"} {assessment_titles[r["assessment_id"]]} ({r["percent"]}%)'})
    for r in attended_sessions(db, employee):
        items.append({'type': 'session', 'at': r['starts_at'], 'text': f'Attended {r["title"]}'})
    for r in db['development_records'].find({'employee_id': employee}, ['title', 'provider', 'completed_on', 'hours']):
        items.append({'type': 'record', 'at': r['completed_on'], 'text': f'Recorded {r["title"]}{" with " + r["provider"] if r["provider"] else ""} ({r["hours"]:g} h)'})
    items.sort(key=lambda i: i['at'] or '', reverse=True)
    return items


def my_history(db, user, query):
    """The employee's own learning activity timeline (filtered and paginated on the server), attended sessions and self-reported records."""
    records = [{'id': r['id'], 'title': r['title'], 'provider': r['provider'], 'completedOn': r['completed_on'], 'hours': r['hours']}
               for r in sorted(db['development_records'].find({'employee_id': user['id']}), key=lambda r: r['completed_on'], reverse=True)]
    sessions = [{'title': r['title'], 'at': r['starts_at']} for r in sorted(attended_sessions(db, user['id']), key=lambda r: r['starts_at'], reverse=True)]
    return {'records': records, 'sessions': sessions, **activity.my_activity(db, user, query)}


def attended_sessions(db, employee):
    """Title and start of every session the employee attended (session_registrations joined with training_sessions)."""
    ids = db['session_registrations'].distinct('session_id', {'employee_id': employee, 'status': 'attended'})
    return db['training_sessions'].find({'id': {'$in': ids}}, ['title', 'starts_at']) if ids else []


def open_resource(db, user, identity):
    """Record that an employee opened a course learning material, then hand back its address."""
    resource = db['course_resources'].get(identity)
    check(resource is not None, 'Learning material was not found.', 404)
    course = db['courses'].get(resource['course_id'])
    enrolled = db['course_runs'].exists({'candidate_id': user['id'], 'course_id': resource['course_id']})
    check(course is not None and (enrolled or can_view_course(db, user, course)), 'Learning material was not found.', 404)
    activity.resource_accessed(db, user['id'], resource)
    return {'url': resource['url']}


def save_record(db, user, data):
    if data.get('delete') is True:
        db['development_records'].delete({'id': bound(data.get('id')), 'employee_id': user['id']})
        return my_history(db, user, {})
    title, provider = text(data, 'title', 2, 150), opt_text(data, 'provider', 150, 'Provider')
    completed = opt_date(data, 'completedOn', 'Completion date')
    check(completed is not None and completed <= today(), 'Enter a completion date that is not in the future.')
    hours = data.get('hours', 0)
    check(type(hours) in (int, float) and 0 <= hours <= 1000, 'Hours must be between 0 and 1000.')
    db['development_records'].insert({'id': uid(), 'employee_id': user['id'], 'title': title, 'provider': provider, 'completed_on': completed, 'hours': float(hours), 'created_at': now()})
    return my_history(db, user, {})


def course_extras(db, user, course_id):
    """Resources and linked pre/post assessments shown on the employee course page."""
    assessments = []
    published = sorted(db['assessments'].find({'course_id': course_id, 'status': 'published', 'kind': {'$in': list(KINDS)}}, ['id', 'title', 'kind', 'pass_percent', 'max_attempts']),
                       key=lambda a: a['kind'], reverse=True)
    # The employee's attempt statistics for those assessments, from one read: count, best percent, any pass.
    stats = {}
    for t in db['assessment_attempts'].find({'assessment_id': {'$in': [a['id'] for a in published]}, 'employee_id': user['id']}, ['assessment_id', 'percent', 'status']) if published else []:
        count, best, passed = stats.get(t['assessment_id'], (0, None, 0))
        stats[t['assessment_id']] = (count + 1, best if t['percent'] is None or (best is not None and best >= t['percent']) else t['percent'], max(passed, int(t['status'] == 'passed')))
    for a in published:
        attempts = stats.get(a['id'], (0, None, None))
        assessments.append({'id': a['id'], 'title': a['title'], 'kind': a['kind'], 'passPercent': a['pass_percent'], 'attemptsLeft': max(0, a['max_attempts'] - attempts[0]),
                            'best': attempts[1], 'passed': bool(attempts[2])})
    required = db['courses'].get(course_id, ['post_assessment_id', 'format'])
    rows = db['course_lessons'].find({'course_id': course_id}, sort='position') if required and required['format'] == 'lessons' else []
    lessons = [lesson_view(r) for r in rows]
    from checkpoints import unlock_threshold
    run = db['course_runs'].find_one({'candidate_id': user['id'], 'course_id': course_id, 'archived_at': None}, ['id'])
    threshold = unlock_threshold(db, run['id'] if run else None, course_id) if lessons else None
    for row, lesson in zip(rows, lessons):
        lesson['locked'] = threshold is not None and threshold <= row['position']
        if lesson['locked']:
            for key in ('content', 'videoUrl', 'captionsUrl', 'posterUrl', 'documentUrl', 'exercise'):
                lesson[key] = ''
            lesson['resources'], lesson['activity'], lesson['practice'], lesson['quiz'] = [], None, None, []
    return {'resources': course_resources(db, course_id), 'assessments': assessments, 'requiredAssessmentId': required['post_assessment_id'] if required else None, 'courseLessons': lessons}


# ---------------------------------------------------------------- routing

def development_action(db, user, method, route, query, data):
    parts = route.split('/')
    if parts[0] == 'me':
        return employee_action(db, user, method, parts[1:], query, data)
    check(parts[0] == 'manage', f'Endpoint was not found: {method} /api/{route}', 404)
    check(user['role'] != 'employee', 'You do not have permission for this area.', 403)
    p = parts[1:]
    key = (method, '/'.join(x if i == 0 or x in ('assign', 'progress', 'delete', 'attempts', 'registrations', 'attendance', 'preview', 'resources', 'builder', 'save', 'sync', 'settings', 'run', 'history', 'templates', 'status', 'start', 'cancel', 'analytics', 'employees', 'questions', 'feedback') else '*' for i, x in enumerate(p)))
    handlers = {
        ('POST', 'announcements'): lambda: announce(db, user, data),
        ('GET', 'org'): lambda: org(db, user),
        ('POST', 'departments'): lambda: save_org_item(db, user, 'departments', data),
        ('POST', 'job-roles'): lambda: save_org_item(db, user, 'job-roles', data),
        ('POST', 'categories'): lambda: save_org_item(db, user, 'categories', data),
        ('GET', 'people'): lambda: people(db, user),
        ('GET', 'dashboard'): lambda: (require(user, 'reports.view'), dashboard(db, user, query))[1],
        ('GET', 'reports'): lambda: (require(user, 'reports.view'), report(db, user, query))[1],
        ('GET', 'activity'): lambda: (require(user, 'activity.view'), activity.staff_activity(db, user, query))[1],
        ('GET', 'activity/analytics'): lambda: (require(user, 'activity.view'), activity.analytics(db, user, query))[1],
        ('GET', 'activity/employees/*'): lambda: (require(user, 'activity.view'), activity.employee_activity(db, user, p[2], query))[1],
        ('GET', 'assignments'): lambda: (check(allowed(user, 'courses.assign') or allowed(user, 'courses.manage'), 'You do not have permission to view assignments.', 403), {'assignments': assignment_rows(db, user, query.get('courseId', [None])[0])})[1],
        ('POST', 'assignments'): lambda: create_assignment(db, user, data),
        ('POST', 'assignments/*/delete'): lambda: delete_assignment(db, user, p[1]),
        ('GET', 'deadlines'): lambda: course_deadlines(db, user, query),
        ('GET', 'compliance'): lambda: compliance.monitoring(db, user, query),
        ('GET', 'onboarding'): lambda: onboarding.monitoring(db, user, query),
        ('GET', 'onboarding/templates'): lambda: onboarding.templates_payload(db, user),
        ('POST', 'onboarding/templates'): lambda: onboarding.save_template(db, user, data),
        ('POST', 'onboarding/templates/*/status'): lambda: onboarding.set_status(db, user, p[2], data),
        ('POST', 'onboarding/start'): lambda: onboarding.start_manual(db, user, data),
        ('GET', 'onboarding/*'): lambda: onboarding.detail(db, user, p[1]),
        ('POST', 'onboarding/*/cancel'): lambda: onboarding.cancel(db, user, p[1]),
        ('GET', 'reminders/settings'): lambda: reminder_settings_view(db, user),
        ('POST', 'reminders/settings'): lambda: save_reminder_settings(db, user, data),
        ('POST', 'reminders/run'): lambda: run_reminders(db, user),
        ('GET', 'reminders/history'): lambda: reminder_history(db, user, query),
        ('GET', 'courses/*/preview'): lambda: preview(db, user, p[1]),
        ('GET', 'courses/*/builder'): lambda: course_builder(db, user, p[1]),
        ('POST', 'courses/*/resources'): lambda: save_resource(db, user, p[1], data),
        ('GET', 'course-generator'): lambda: course_generator.status(user),
        ('POST', 'course-generator'): lambda: course_generator.start(db, user, data),
        ('GET', 'course-generator/*'): lambda: course_generator.get_job(user, p[1]),
        ('POST', 'resources/*/delete'): lambda: delete_resource(db, user, p[1]),
        ('POST', 'training-targets'): lambda: save_training_targets(db, user, data),
        ('POST', 'keka/sync'): lambda: keka.sync_all(db, user),
        ('GET', 'assessments'): lambda: assessment_list(db, user),
        ('POST', 'assessments'): lambda: save_assessment(db, user, data),
        ('GET', 'assessments/*/attempts'): lambda: assessment_attempts(db, user, p[1], query),
        ('GET', 'sessions'): lambda: (require(user, 'sessions.manage'), {'sessions': session_rows(db, user)})[1],
        ('POST', 'sessions'): lambda: save_session(db, user, data),
        ('GET', 'sessions/*/registrations'): lambda: session_registrations(db, user, p[1]),
        ('POST', 'sessions/*/attendance'): lambda: mark_attendance(db, user, p[1], data),
        ('GET', 'sessions/*/feedback'): lambda: live_training.feedback_report(db, user, p[1]),
        ('POST', 'sessions/*/questions/*'): lambda: live_training.moderate(db, user, p[1], p[3], data),
        ('GET', 'trainers'): lambda: live_training.trainers(db, user),
    }
    check(key in handlers, f'Endpoint was not found: {method} /api/{route}', 404)
    return handlers[key]()


def employee_action(db, user, method, p, query, data):
    key = (method, '/'.join(x if i == 0 or x in ('register', 'cancel', 'start', 'submit', 'terminate', 'read', 'unread', 'open', 'questions', 'vote', 'feedback') else '*' for i, x in enumerate(p)))
    handlers = {
        ('GET', 'dashboard'): lambda: my_dashboard(db, user),
        ('GET', 'calendar'): lambda: my_calendar(db, user),
        ('POST', 'sessions/*/register'): lambda: register_session(db, user, p[1], True),
        ('POST', 'sessions/*/cancel'): lambda: register_session(db, user, p[1], False),
        ('GET', 'sessions/*/questions'): lambda: live_training.questions(db, user, p[1]),
        ('POST', 'sessions/*/questions'): lambda: live_training.ask(db, user, p[1], data),
        ('POST', 'sessions/*/questions/*/vote'): lambda: live_training.vote(db, user, p[1], p[3]),
        ('POST', 'sessions/*/feedback'): lambda: live_training.submit_feedback(db, user, p[1], data),
        ('GET', 'assessments'): lambda: my_assessments(db, user),
        ('POST', 'assessments/*/start'): lambda: start_assessment(db, user, p[1]),
        ('POST', 'assessments/*/submit'): lambda: submit_assessment(db, user, p[1], data),
        ('POST', 'assessments/*/terminate'): lambda: terminate_assessment(db, user, p[1], data),
        ('GET', 'notifications'): lambda: my_notifications(db, user),
        ('GET', 'onboarding'): lambda: onboarding.my_onboarding(db, user),
        ('GET', 'notifications/unread'): lambda: unread_count(db, user),
        ('POST', 'notifications/read'): lambda: read_notifications(db, user, data),
        ('GET', 'history'): lambda: my_history(db, user, query),
        ('POST', 'resources/*/open'): lambda: open_resource(db, user, p[1]),
        ('POST', 'records'): lambda: save_record(db, user, data),
        ('GET', 'games'): lambda: games.lesson_games(db, user, query),
    }
    check(key in handlers, f'Endpoint was not found: {method} /api/me/{"/".join(p)}', 404)
    return handlers[key]()
