"""Account and learning rules. All candidate identifiers come from the session."""
import json
import math
import re
import secrets
import time
import uuid
from datetime import datetime, timezone

from pymongo import ReturnDocument

import store
from database import COURSE_ID, public_curriculum
import activity as activity_log  # "activity" is also a local name in learning_action.
from security import password_hash, verify_password, token, token_hash


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def uid():
    return str(uuid.uuid4())


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def check(condition, message, status=400):
    if not condition:
        raise APIError(status, message)


def text(data, field, minimum=1, maximum=254):
    value = data.get(field)
    check(isinstance(value, str), f'{field} is required.')
    value = value.strip() if field != 'password' and field != 'currentPassword' else value
    check(minimum <= len(value) <= maximum, f'{field} must contain {minimum}–{maximum} characters.')
    return value


def index(data, key, maximum):
    value = data.get(key)
    check(type(value) is int and 0 <= value <= maximum, f'Invalid {key}.')
    return value


# ---------------------------------------------------------------- MongoDB helpers

def scalar(value):
    """A request value used in a query filter. sqlite3 refused to bind anything but a scalar (an error, not a match);
    refusing here (TypeError, a server error as before) also stops a JSON object from acting as a MongoDB query operator."""
    if value is not None and not isinstance(value, (str, int, float)):
        raise TypeError('Unsupported request value type.')
    return value


def batch_read(db, **parts):
    """Several reads in one MongoDB round trip. Each keyword is (table, filter[, sort[, projection]]) and comes back
    under the same name as a list of rows, like Table.find. Matching uses binary comparison, so case-insensitive
    columns (candidates.email and the NOCASE names) must not be matched here."""
    pipeline = [{'$documents': [{}]}]
    for name, part in parts.items():
        table, filter, sort, projection = (tuple(part) + (None, None))[:4]
        sub = [{'$match': filter or {}}]
        if sort:
            sub.append({'$sort': dict(store._sort(sort))})
        sub.append({'$project': store._projection(projection)})
        pipeline.append({'$lookup': {'from': db.collection_name(table), 'pipeline': sub, 'as': name}})
    return next(db.database.aggregate(pipeline, session=db.active_session()))


def merge(db, table, keys, insert, update):
    """INSERT ... ON CONFLICT(keys) DO UPDATE SET ..., as one atomic upsert (a failed write would abort the transaction).
    insert: columns of a new row (other columns get their defaults). update: {column: plain value, or an aggregation
    expression over the existing row such as {'$max': ['$watched_seconds', 5.0]}}. Returns True when a row was inserted."""
    row = store.with_defaults(table, {**insert, **keys})
    columns = [c for c in row if c not in keys]
    fresh = {'$eq': [{'$type': '$' + columns[0]}, 'missing']}  # Every stored row has every column.

    def value(column, given):
        return given if isinstance(given, dict) else {'$literal': store.coerce_fields(table, {column: given})[column]}
    stage = {c: {'$cond': [fresh, {'$literal': row[c]}, value(c, update[c]) if c in update else '$' + c]} for c in columns}
    db.lock_for_write()
    return db.collection(table).update_one(keys, [{'$set': stage}], upsert=True, session=db.active_session()).upserted_id is not None


def reserve_ids(db, table, count):
    """`count` consecutive INTEGER PRIMARY KEY values in one round trip (Table.insert allocates one per call)."""
    db.lock_for_write()
    top = db.database[db.prefix + 'counters'].find_one_and_update(
        {'_id': table}, {'$inc': {'seq': count}}, upsert=True, return_document=ReturnDocument.AFTER, session=db.active_session())['seq']
    return list(range(top - count + 1, top + 1))


ROLES = ('admin', 'hr', 'trainer', 'manager', 'employee')
# Backend permission matrix. Managers and trainers are further scoped to their own team or courses.
PERMISSIONS = {
    'users.manage': {'admin', 'hr'},
    'org.manage': {'admin', 'hr'},
    'courses.manage': {'admin', 'hr', 'trainer'},
    'courses.assign': {'admin', 'hr', 'manager'},
    'assessments.manage': {'admin', 'hr', 'trainer'},
    'sessions.manage': {'admin', 'hr', 'trainer'},
    'reports.view': {'admin', 'hr', 'manager', 'trainer'},
    'onboarding.manage': {'admin', 'hr'},
    'audit.view': {'admin'},
    # Learning activity history of other employees: organisation-wide for admin and HR, direct reports for managers.
    'activity.view': {'admin', 'hr', 'manager'},
}


def allowed(user, permission):
    return user['role'] in PERMISSIONS[permission]


def require(user, permission):
    check(allowed(user, permission), 'You do not have permission for this action.', 403)


def candidate_view(row):
    keys = row.keys()
    return {'id': row['id'], 'name': row['full_name'], 'email': row['email'], 'createdAt': row['created_at'], 'role': row['role'], 'mustChangePassword': bool(row['must_change_password']), 'active': bool(row['is_active']),
            'departmentId': row['department_id'] if 'department_id' in keys else None, 'jobRoleId': row['job_role_id'] if 'job_role_id' in keys else None,
            'managerId': row['manager_id'] if 'manager_id' in keys else None, 'jobTitle': row['job_title'] if 'job_title' in keys else '',
            'source': row['auth_source'] if 'auth_source' in keys else 'local', 'kekaEmployeeNumber': row['keka_employee_number'] if 'keka_employee_number' in keys else '',
            'joiningDate': row['joining_date'] if 'joining_date' in keys else None}


def can_view_course(db, user, course):
    """Published courses are open to every employee unless limited to one department.
    Course managers, members of that department, and employees assigned the course always have access."""
    if course['status'] != 'published':
        return False
    if course['visibility'] != 'department' or not course['department_id']:
        return True
    if user['role'] in ('admin', 'hr') or user['id'] in (course['trainer_id'], course['created_by']) or user['department_id'] == course['department_id']:
        return True
    return db['course_assignments'].exists({'course_id': course['id'], '$or': [
        {'target_type': 'employee', 'target_id': user['id']}, {'target_type': 'department', 'target_id': user['department_id'] or ''},
        {'target_type': 'job_role', 'target_id': user['job_role_id'] or ''}]})


def notify(db, employees, kind, title, body, link, key):
    """Store one in-app notification per employee; the dedupe key makes repeat calls harmless.
    Existing keys are read once and the new rows written together (INSERT OR IGNORE for every employee at once)."""
    employees = [e for e in dict.fromkeys(employees) if e is not None]
    if not employees:
        return
    taken = set(db['notifications'].distinct('employee_id', {'employee_id': {'$in': employees}, 'dedupe_key': key}))
    fresh = [e for e in employees if e not in taken]
    if fresh:
        stamp = now()
        db['notifications'].insert_many([{'id': i, 'employee_id': e, 'kind': kind, 'title': title[:200], 'body': body[:500], 'link': link, 'dedupe_key': key, 'created_at': stamp}
                                         for i, e in zip(reserve_ids(db, 'notifications', len(fresh)), fresh)])


def auth_event(db, candidate, email, event, ip):
    db['auth_events'].insert({'candidate_id': candidate, 'email': email, 'event': event, 'ip_address': ip, 'created_at': now(), 'timestamp': time.time()})


def create_run(db, candidate, course_id=COURSE_ID):
    last = db['course_runs'].find_one({'candidate_id': candidate, 'course_id': course_id}, ['run_number'], sort='-run_number')
    number = (last['run_number'] if last else 0) + 1
    run = uid()
    db['course_runs'].insert({'id': run, 'candidate_id': candidate, 'course_id': course_id, 'run_number': number, 'started_at': now()})
    return run


def current_run(db, candidate, expected=None, course_id=COURSE_ID):
    if expected is not None:
        row=db['course_runs'].find_one({'id': scalar(expected), 'candidate_id': candidate, 'archived_at': None})
        check(row is not None,'The course run changed or is unavailable. Reload before continuing.',409)
    else:
        row=db['course_runs'].find_one({'candidate_id': candidate, 'course_id': scalar(course_id), 'archived_at': None})
        check(row is not None,'Course enrollment was not found.',404)
    return row


def authenticate(db, data, ip, register=False):
    check(not register, 'Accounts are created by an administrator. Contact your admin for login details.', 403)
    email = text(data, 'email').casefold()
    password = text(data, 'password', 8 if register else 1, 128)
    check(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) is not None, 'Enter a valid email address.')
    failures = db['auth_events'].count({'event': 'login_failed', 'timestamp': {'$gt': time.time() - 900},
                                        '$or': ([{'ip_address': ip}] if ip is not None else []) + [{'email': email}]})
    check(failures < 10, 'Too many sign-in attempts. Please try again in 15 minutes.', 429)
    row = db['candidates'].find_one({'email': email})
    valid = verify_password(password, row['password_hash']) if row else verify_password(password, DUMMY_HASH)
    if not valid or not row['is_active']:
        auth_event(db, row['id'] if row else None, email, 'login_failed', ip)
        db.commit()
        raise APIError(401, 'Email or password is incorrect or the account is unavailable.')
    return start_session(db, row, ip, data.get('remember') is True)


def start_session(db, row, ip, remember=False):
    """Sign in an account whose identity is already verified (by password or by Keka): record it and create a session."""
    if not row['last_login_at']:
        from notifications import staff_event
        staff_event(db, row['id'], f'First sign-in: {row["full_name"]}', 'This user signed in for the first time.', f'first-login:{row["id"]}')
    db['candidates'].update({'id': row['id']}, {'last_login_at': now()})
    auth_event(db, row['id'], row['email'], 'login', ip)
    raw, csrf = token(), token()
    lifetime = 30 * 86400 if remember else 8 * 3600
    db['sessions'].delete({'expires_at': {'$lte': time.time()}})
    db['sessions'].insert({'token_hash': token_hash(raw), 'candidate_id': row['id'], 'csrf_token': csrf, 'created_at': now(), 'expires_at': time.time() + lifetime})
    return {'user': candidate_view(row), 'csrfToken': csrf}, raw, lifetime


def ready(db, run, s):
    videos = db['video_progress'].count({'run_id': run, 'video_index': {'$in': [s * 2, s * 2 + 1]}, 'completed_at': {'$ne': None}})
    exercises = len(db['exercise_attempts'].distinct('exercise_index', {'run_id': run, 'set_index': s, 'passed': 1}))
    return videos == 2 and exercises == 2


def passed(db, run, s):
    return db['exam_attempts'].exists({'run_id': run, 'set_index': s, 'status': 'passed'})


def unlocked(db, run, s):
    return s == 0 or (ready(db, run, s - 1) and passed(db, run, s - 1))


def expire_exams(db, run, reason=None):
    from checkpoints import expire
    expire(db, run, reason)
    if reason:
        db['exam_attempts'].update({'run_id': run, 'status': 'in-progress'}, {'status': 'terminated', 'reason': reason, 'finished_at': now()})
    else:
        expired = {'run_id': run, 'status': 'in-progress', 'deadline': {'$lte': time.time()}}
        # Checked with a read first: usually nothing has expired, and a read does not take the writer lock.
        if db['exam_attempts'].exists(expired):
            db['exam_attempts'].update(expired, {'status': 'terminated', 'reason': 'Time expired. This attempt has ended.', 'finished_at': now()})


def attempt_view(row):
    return {'id': row['id'], 'status': row['status'], 'startedAt': row['started_at'], 'deadline': row['deadline'] * 1000, 'finishedAt': row['finished_at'], 'score': row['score'], 'reason': row['reason'], 'attemptNumber': row['attempt_number']}


def _certificate_items(rows, course_of_run, public_base=None, public_base_configured=True):
    """Certificate views; rows in issued_at,id order, course_of_run maps run id -> course id."""
    result = []
    for r in rows:
        item = {'id':r['id'],'runId':r['run_id'],'name':r['candidate_name'],'courseTitle':r['course_title'],'courseId':course_of_run[r['run_id']],'completedAt':r['issued_at'],
                'certificateNumber':r['certificate_number'],'shareEnabled':bool(r['public_token']),
                'publicBaseConfigured':public_base_configured}
        if r['public_token'] and public_base:
            item['publicUrl'] = f'{public_base}/certificates/{r["public_token"]}'
        result.append(item)
    return result


def candidate_certificates(db, candidate, public_base=None, public_base_configured=True):
    runs = {r['id']: r['course_id'] for r in db['course_runs'].find({'candidate_id': candidate}, ['id', 'course_id'])}
    rows = db['certificates'].find({'run_id': {'$in': list(runs)}}, sort=['issued_at', 'id']) if runs else []
    return _certificate_items(rows, runs, public_base, public_base_configured)


def set_certificate_sharing(db, candidate, certificate_id, enabled, consent=False):
    row = db['certificates'].get(scalar(certificate_id), ['id', 'run_id', 'certificate_number', 'public_token'])
    if row is not None and not db['course_runs'].exists({'id': row['run_id'], 'candidate_id': candidate}):
        row = None
    check(row is not None, 'Certificate was not found.', 404)
    check(type(enabled) is bool, 'Sharing status must be true or false.')
    if enabled:
        check(consent is True, 'Confirm that you want to make these certificate details public.')
        token = row['public_token'] or secrets.token_urlsafe(32)
    else:
        token = None
    db['certificates'].update({'id': certificate_id}, {'public_token': token})
    return {'certificateNumber': row['certificate_number'], 'shareEnabled': enabled, 'publicToken': token}


def bundle(db, candidate, course_id=COURSE_ID):
    """The learner's state for one course. Two round trips: the candidate's runs, then everything else in one batched read."""
    from checkpoints import build_views
    scalar(course_id)
    runs = db['course_runs'].find({'candidate_id': candidate})
    run = next((r for r in runs if r['course_id'] == course_id and r['archived_at'] is None), None)
    check(run is not None, 'Course enrollment was not found.', 404)
    run_id = run['id']

    def read():
        return batch_read(db,
            videos=('video_progress', {'run_id': run_id}, 'video_index'),
            exercises=('exercise_attempts', {'run_id': run_id, 'passed': 1}, ['set_index', 'exercise_index'], ['set_index', 'exercise_index']),
            exams=('exam_attempts', {'run_id': run_id}, ['set_index', 'attempt_number']),
            certificates=('certificates', {'run_id': {'$in': [r['id'] for r in runs]}}, ['issued_at', 'id']),
            course=('courses', {'id': run['course_id']}, None, ['format']),
            lessons=('course_lessons', {'course_id': run['course_id']}, None, ['id']),
            progress=('lesson_progress', {'run_id': run_id}, 'lesson_id'),
            watch=('lesson_watch', {'run_id': run_id}, 'lesson_id'),
            activity=('lesson_activity_attempts', {'run_id': run_id}),
            checkpoints=('course_checkpoints', {'course_id': course_id}, 'after_lesson'),
            checkpoint_attempts=('checkpoint_attempts', {'run_id': run_id}, ['checkpoint_id', 'attempt_number']),
            drafts=('lesson_code_drafts', {'run_id': run_id}, 'lesson_id', ['lesson_id', 'code']))
    moment = time.time()
    data = read()
    # expire_exams(): end attempts past their deadline, then read again (rare).
    if any(a['status'] == 'in-progress' and a['deadline'] <= moment for a in data['exams'] + data['checkpoint_attempts']):
        expire_exams(db, run_id)
        data = read()
    videos = {str(r['video_index']): {'watched': r['watched_seconds'], 'complete': r['completed_at'] is not None} for r in data['videos']}
    exercises = {f"{r['set_index']}-{r['exercise_index']}": True for r in data['exercises']}
    attempts = [[], [], []]
    for row in data['exams']:
        attempts[row['set_index']].append(attempt_view(row))
    awards = _certificate_items(data['certificates'], {r['id']: r['course_id'] for r in runs})
    course = data['course'][0] if data['course'] else None
    lessons = {r['lesson_id']: {'completed': True, 'completedAt': r['completed_at'], 'response': r['response'], 'score': r['score']} for r in data['progress']}
    watch = {r['lesson_id']: {'position': r['position_seconds'], 'watched': r['watched_seconds']} for r in data['watch']}
    return {'version': 3, 'run': {'id': run['id'], 'courseId':run['course_id'], 'runNumber': run['run_number'], 'videos': videos, 'exercises': exercises, 'attempts': attempts, 'completedAt': run['completed_at'],
                                  'format': course['format'], 'lessons': lessons, 'lessonTotal': len(data['lessons']), 'watch': watch, 'activity': _activity_state(db, data['activity']),
                                  'checkpoints': build_views(data['checkpoints'], data['checkpoint_attempts'], {r['lesson_id'] for r in data['progress']}, run_id),
                                  'codeDrafts': {r['lesson_id']: r['code'] for r in data['drafts']},
                                  'lastLessonId': run['last_lesson_id']}, 'certificates': awards}


def activity_state(db, run_id):
    """Attempts, best score and feedback for the latest submission of each interactive exercise in a run."""
    return _activity_state(db, db['lesson_activity_attempts'].find({'run_id': run_id}))


def _activity_state(db, rows):
    """activity_state() from a run's lesson_activity_attempts rows, read without a sort: within one lesson they come
    back in insertion order (index order breaks ties by record id), so the last one is the latest submission."""
    from development import score_activity  # Local import: development builds on this module.
    by_lesson = {}
    for row in rows:
        by_lesson.setdefault(row['lesson_id'], []).append(row)
    if not by_lesson:
        return {}
    activities = {l['id']: l['activity_json'] for l in db['course_lessons'].find({'id': {'$in': list(by_lesson)}}, ['id', 'activity_json'])}
    state = {}
    for lesson_id in sorted(by_lesson):
        if lesson_id not in activities:
            continue
        submissions = by_lesson[lesson_id]
        row = submissions[-1]
        scores = [r['score'] for r in submissions if r['score'] is not None]
        answers = json.loads(row['answers_json'])
        _, results = score_activity(json.loads(activities[lesson_id]), answers)
        state[lesson_id] = {'attempts': len(submissions), 'bestScore': max(scores) if scores else None, 'lastScore': row['score'], 'passed': bool(row['passed']),
                            'submittedAt': row['submitted_at'], 'answers': answers, 'results': results}
    return state


def post_assessment_passed(db, candidate, run):
    """A published post-training assessment linked to the course must be passed during this run."""
    owner = db['course_runs'].get(run, ['course_id', 'started_at'])
    course = db['courses'].get(owner['course_id'], ['post_assessment_id']) if owner else None
    row = db['assessments'].find_one({'id': course['post_assessment_id'], 'status': 'published'}, ['id']) if course and course['post_assessment_id'] else None
    if row is None:
        return True
    return db['assessment_attempts'].exists({'assessment_id': row['id'], 'employee_id': candidate, 'status': 'passed', 'finished_at': {'$gte': owner['started_at']}})


def threshold_met(db, run_id, lesson):
    row = db['lesson_watch'].find_one({'run_id': run_id, 'lesson_id': lesson['id']}, ['watched_seconds'])
    return row is not None and row['watched_seconds'] >= lesson['video_seconds'] * lesson['completion_percent'] / 100 - 0.5


def learning_complete(db, run):
    from checkpoints import all_passed
    owner = db['course_runs'].get(run, ['course_id'])
    course = db['courses'].get(owner['course_id'], ['id', 'format'])
    if course['format'] == 'lessons':
        lesson_ids = [r['id'] for r in db['course_lessons'].find({'course_id': course['id']}, ['id'])]
        done = db['lesson_progress'].count({'run_id': run, 'lesson_id': {'$in': lesson_ids}}) if lesson_ids else 0
        return len(lesson_ids) > 0 and done >= len(lesson_ids) and all_passed(db, run)
    return all(ready(db, run, s) and passed(db, run, s) for s in range(3))


def issue_certificate(db, candidate, run):
    if learning_complete(db, run) and post_assessment_passed(db, candidate, run):
        name = db['candidates'].get(candidate, ['full_name'])['full_name']
        timestamp = now()
        owner = db['course_runs'].get(run, ['course_id', 'completed_at'])
        title = db['courses'].get(owner['course_id'], ['title'])['title']
        # The server clock records completion, once, along with the deadline in force at that moment.
        if owner['completed_at'] is None:
            from analytics import assignment_index
            assignment = assignment_index(db, [candidate], [owner['course_id']]).get((candidate, owner['course_id']))
            db['course_runs'].update({'id': run}, {'completed_at': timestamp, 'deadline_at_completion': assignment['deadlineAt'] if assignment else None})
            activity_log.course_completed(db, candidate, run)
        # One certificate per qualifying run (UNIQUE run_id); notify only when a new one is created.
        while True:
            certificate_number = 'SX-' + secrets.token_hex(6).upper()
            if not db['certificates'].exists({'certificate_number': certificate_number}):
                break
        created = db['certificates'].insert_ignore({'id': uid(), 'run_id': run, 'candidate_name': name, 'course_title': title, 'issued_at': timestamp,
                                                    'certificate_number': certificate_number, 'public_token': None})
        if created:
            activity_log.certificate_generated(db, candidate, run)
            from notifications import staff_event
            staff_event(db, candidate, f'Course completed: {name}', f'{title}: a completion certificate was earned.', f'team-certificate:{run}')
            notify(db, [candidate], 'certificate', f'Certificate earned: {title}', 'Your completion certificate is ready to view and print.', 'certificates', f'certificate:{run}')


def grade(db, s, kind, e, answers, course_id=COURSE_ID):
    questions = db['assessment_questions'].find({'course_id': course_id, 'set_index': s, 'kind': kind, 'exercise_index': e}, sort='question_index')
    check(isinstance(answers, list) and len(answers) == len(questions), 'Answer every question before submitting.')
    check(all(type(a) is int and 0 <= a < len(json.loads(q['options_json'])) for a, q in zip(answers, questions)), 'Invalid answer selection.')
    details = [{'correct': answer == question['correct_option'], 'explanation': question['explanation']} for answer, question in zip(answers, questions)]
    return sum(d['correct'] for d in details), details


def learning_action(db, candidate, action, data):
    import checkpoints
    check(isinstance(data.get('runId'), str), 'Course run ID is required.')
    run = current_run(db, candidate, data.get('runId'))
    run_id = run['id']
    course = db['courses'].get(run['course_id'], ['status', 'format', 'max_attempts', 'title', 'pass_percent'])
    if action not in ('exam-finish', 'checkpoint-finish'):
        check(course['status']=='published','This course is not currently published.',403)
    expire_exams(db, run_id)
    course_format = course['format']
    check(course_format == 'modules' or action in ('resume', 'restart', 'lesson', 'lesson-open', 'lesson-video', 'lesson-activity', 'lesson-draft', 'lesson-quiz', 'checkpoint-start', 'checkpoint-finish'), 'This activity does not apply to lesson-based courses.', 409)
    if action not in ('checkpoint-finish', 'resume', 'restart', 'lesson-open'):
        check(not db['checkpoint_attempts'].exists({'run_id': run_id, 'status': 'in-progress'}),
              'Finish the active assignment before continuing lessons.', 409)
    extra = {}
    lesson = None
    lesson_done_before = None
    if action in ('lesson', 'lesson-open', 'lesson-video', 'lesson-activity', 'lesson-draft', 'lesson-quiz'):
        check(course_format == 'lessons', 'Lessons in this course are completed through its modules.', 409)
        lesson = db['course_lessons'].find_one({'id': scalar(data.get('lessonId')), 'course_id': run['course_id']})
        check(lesson is not None, 'Lesson was not found.', 404)
        check(checkpoints.lesson_unlocked(db, run_id, run['course_id'], lesson['id']), 'Pass the previous assignment to unlock this module.', 403)
        lesson_done_before = db['lesson_progress'].exists({'run_id': run_id, 'lesson_id': lesson['id']})
    progress_key = {'run_id': run_id, 'lesson_id': lesson['id']} if lesson is not None else None
    if action == 'lesson-open':
        # Remember the lesson the employee is reading so the course reopens there.
        db['course_runs'].update({'id': run_id}, {'last_lesson_id': lesson['id']})
        activity_log.lesson_opened(db, candidate, run, lesson)
    elif action == 'checkpoint-start':
        check(course_format == 'lessons', 'This course has no lesson assignments.', 409)
        extra = checkpoints.start(db, run, data)
        row = db['checkpoint_attempts'].get(extra['attempt']['id'], ['id', 'attempt_number', 'checkpoint_id'])
        title = db['course_checkpoints'].get(row['checkpoint_id'], ['title'])['title']
        activity_log.attempt_started(db, candidate, 'assignment', row['id'], course=run['course_id'], run=run_id, title=title, number=row['attempt_number'])
    elif action == 'checkpoint-finish':
        extra = checkpoints.finish(db, run, data)
        row = db['checkpoint_attempts'].get(extra['attempt']['id'])
        checkpoint = db['course_checkpoints'].get(row['checkpoint_id'], ['title', 'pass_percent']) if row else None
        row = {**row, **checkpoint} if row and checkpoint else None
        if row and row['score'] is not None:
            activity_log.attempt_finished(db, candidate, 'assignment', row['id'], row['status'], score=row['score'], total=row['total'],
                                      percent=round(row['score'] * 100 / row['total']) if row['total'] else None, pass_percent=row['pass_percent'],
                                      course=run['course_id'], run=run_id, title=row['title'], number=row['attempt_number'])
    elif action == 'lesson-draft':
        check(bool(lesson['practice_json']), 'This lesson has no coding practice.', 409)
        code = data.get('code')
        check(isinstance(code, str) and len(code) <= 20000, 'Code must contain at most 20,000 characters.')
        db['lesson_code_drafts'].upsert(progress_key, {'code': code, 'updated_at': now()})
    elif action == 'lesson-quiz':
        questions = json.loads(lesson['quiz_json']) if lesson['quiz_json'] else []
        check(bool(questions), 'This lesson has no knowledge check.', 409)
        answers = data.get('answers')
        check(isinstance(answers, list) and len(answers) == len(questions), 'Answer every knowledge-check question.')
        check(all(type(a) is int and 0 <= a < len(q[1]) for a, q in zip(answers, questions)), 'Invalid knowledge-check answer.')
        correct = [a == q[2] for a, q in zip(answers, questions)]
        score = sum(correct)
        quiz_attempt = uid()
        db['lesson_quiz_attempts'].insert({'id': quiz_attempt, 'run_id': run_id, 'lesson_id': lesson['id'], 'answers_json': json.dumps(answers), 'score': score, 'submitted_at': now()})
        activity_log.attempt_finished(db, candidate, 'quiz', quiz_attempt, 'passed' if all(correct) else 'failed', score=score, total=len(questions),
                                  percent=round(score * 100 / len(questions)), pass_percent=100, course=run['course_id'], run=run_id, lesson=lesson['id'],
                                  title=f"{lesson['title']} knowledge check")
        if all(correct):
            db['lesson_progress'].upsert(progress_key, {'score': 100}, insert_only={'completed_at': now()})
        extra['quizResult'] = {'score': score, 'total': len(questions), 'passed': all(correct), 'correct': correct}
    elif action == 'lesson-video':
        check(not lesson['quiz_json'], 'Complete this module through its knowledge check.', 409)
        # Watch reports come from the browser; watched time is capped at the video length and never decreases.
        position, watched = data.get('position'), data.get('watched')
        check(all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in (position, watched)), 'Invalid video progress.')
        limit = lesson['video_seconds'] or 36000
        stamp = now()
        merge(db, 'lesson_watch', progress_key, {'position_seconds': min(position, limit), 'watched_seconds': min(watched, limit), 'updated_at': stamp},
              {'position_seconds': min(position, limit), 'watched_seconds': {'$max': ['$watched_seconds', float(min(watched, limit))]}, 'updated_at': stamp})
        if lesson['video_seconds'] and not lesson['activity_json'] and not lesson['exercise'] and threshold_met(db, run_id, lesson):
            if db['lesson_progress'].insert_ignore({**progress_key, 'completed_at': now()}):
                extra['lessonCompleted'] = lesson['id']
    elif action == 'lesson-activity':
        from development import score_activity  # Local import: development builds on this module.
        check(bool(lesson['activity_json']), 'This lesson has no interactive exercise.', 409)
        activity = json.loads(lesson['activity_json'])
        answers = data.get('answers')
        check(isinstance(answers, list) and len(answers) == len(activity['tasks']) and all(isinstance(a, str) and 1 <= len(a.strip()) <= 3000 for a in answers),
              'Write a prompt for every task (up to 3000 characters each).')
        answers = [a.strip() for a in answers]
        score, results = score_activity(activity, answers)
        activity_passed = score >= activity['passPercent']
        db['lesson_activity_attempts'].insert({'id': uid(), 'run_id': run_id, 'lesson_id': lesson['id'], 'answers_json': json.dumps(answers), 'score': score, 'passed': int(activity_passed), 'submitted_at': now()})
        if activity_passed:
            # The completion keeps the best passing score; a later lower score never reduces it.
            merge(db, 'lesson_progress', progress_key, {'completed_at': now(), 'score': score},
                  {'score': {'$max': [{'$ifNull': ['$score', 0]}, store.coerce_fields('lesson_progress', {'score': score})['score']]}})
        extra['activityResult'] = {'score': score, 'passed': activity_passed, 'passPercent': activity['passPercent'], 'results': results}
    elif action == 'lesson':
        from development import video_available
        check(not lesson['activity_json'], 'Submit the exercise to complete this lesson.', 409)
        check(not lesson['quiz_json'], 'Pass the knowledge check to complete this module.', 409)
        required = lesson['video_seconds'] and video_available(lesson['video_url'])
        check(not required or threshold_met(db, run_id, lesson), 'Watch at least %d%% of the video to complete this lesson.' % lesson['completion_percent'], 409)
        response = data.get('response') or ''
        check(isinstance(response, str) and len(response.strip()) <= 5000, 'Your exercise response must contain at most 5000 characters.')
        check(not lesson['exercise'] or len(response.strip()) >= 10, 'Write your response to the practical exercise (at least 10 characters) to complete this lesson.')
        db['lesson_progress'].upsert(progress_key, {'response': response.strip()}, insert_only={'completed_at': now()})
    elif action == 'resume':
        expire_exams(db, run_id, 'The exam page was closed, reloaded, or opened in another tab.')
    elif action == 'restart':
        expire_exams(db, run_id, 'A new course run was started.')
        db['course_runs'].update({'id': run_id}, {'archived_at': now()})
        create_run(db, candidate, run['course_id'])
    elif action == 'video':
        i = index(data, 'videoIndex', 5)
        check(unlocked(db, run_id, i // 2), 'Complete the previous set first.', 403)
        watched = data.get('watched')
        duration=db['videos'].find_one({'course_id': run['course_id'], 'video_index': i}, ['duration_seconds'])['duration_seconds']
        check(type(watched) in (int,float) and math.isfinite(watched) and 0 <= watched <= duration,'Invalid watched duration.')
        completed = now() if data.get('complete') is True and watched >= duration * 0.9 else None
        video_done_before = db['video_progress'].exists({'run_id': run_id, 'video_index': i, 'completed_at': {'$ne': None}})
        merge(db, 'video_progress', {'run_id': run_id, 'video_index': i}, {'watched_seconds': watched, 'completed_at': completed, 'updated_at': now()},
              {'watched_seconds': {'$max': ['$watched_seconds', float(watched)]}, 'completed_at': {'$ifNull': ['$completed_at', {'$literal': completed}]}, 'updated_at': now()})
        if completed and not video_done_before:
            titles = json.loads(db['courses'].get(run['course_id'], ['lessons_json'])['lessons_json'] or '[]')
            activity_log.lesson_completed(db, candidate, run, video_index=i, title=titles[i].get('title') if i < len(titles) and isinstance(titles[i], dict) else None)
    elif action == 'exercise':
        s, e = index(data, 'setIndex', 2), index(data, 'exerciseIndex', 1)
        check(unlocked(db, run_id, s), 'Complete the previous set first.', 403)
        answers = data.get('answers')
        score, details = grade(db, s, 'exercise', e, answers, run['course_id'])
        db['exercise_attempts'].insert({'id': uid(), 'run_id': run_id, 'set_index': s, 'exercise_index': e, 'answers_json': json.dumps(answers), 'score': score, 'passed': int(score == 2), 'submitted_at': now()})
        extra = {'feedback': {'score': score, 'answers': answers, 'details': details}}
    elif action == 'exam-start':
        s = index(data, 'setIndex', 2)
        check(unlocked(db, run_id, s) and ready(db, run_id, s), 'Complete both videos and both exercises before the exam.', 403)
        check(not passed(db, run_id, s), 'This exam has already been passed.', 409)
        # A concurrent second start still fails on the unique index of in-progress attempts (409), as before.
        check(not db['exam_attempts'].exists({'run_id': run_id, 'status': 'in-progress'}), 'An examination is already active. Reload to end the interrupted attempt.', 409)
        number = db['exam_attempts'].count({'run_id': run_id, 'set_index': s}) + 1
        limit = course['max_attempts']
        check(number <= limit, f'All {limit} exam attempts have been used. Start a new course run to try again.', 409)
        identity = uid()
        attempt = db['exam_attempts'].insert({'id': identity, 'run_id': run_id, 'set_index': s, 'attempt_number': number, 'status': 'in-progress', 'started_at': now(), 'deadline': time.time() + 600})
        extra['attempt'] = attempt_view(attempt)
        activity_log.attempt_started(db, candidate, 'exam', identity, course=run['course_id'], run=run_id, title=f'Module {s + 1} exam', number=number)
    elif action == 'exam-finish':
        identity = data.get('attemptId')
        check(isinstance(identity, str), 'Attempt ID is required.')
        attempt = db['exam_attempts'].find_one({'id': identity, 'run_id': run_id})
        check(attempt is not None, 'Attempt was not found.', 404)
        if attempt['status'] == 'in-progress':
            if data.get('terminate') is True:
                reason = str(data.get('reason') or 'The examination was ended.')[:300]
                db['exam_attempts'].update({'id': identity}, {'status': 'terminated', 'reason': reason, 'finished_at': now()})
            else:
                answers = data.get('answers')
                score, _ = grade(db, attempt['set_index'], 'exam', -1, answers, run['course_id'])
                result = 'passed' if score * 25 >= course['pass_percent'] else 'failed'
                db['exam_attempts'].update({'id': identity}, {'status': result, 'score': score, 'answers_json': json.dumps(answers), 'finished_at': now()})
                activity_log.attempt_finished(db, candidate, 'exam', identity, result, score=score, total=4, percent=score * 25, pass_percent=course['pass_percent'],
                                          course=run['course_id'], run=run_id, title=f"Module {attempt['set_index'] + 1} exam", number=attempt['attempt_number'])
                notify(db, [candidate], 'assessment', f"Module {attempt['set_index'] + 1} exam {'passed' if result == 'passed' else 'not passed'}: {course['title']}", f"You scored {score * 25}% (pass mark {course['pass_percent']}%).", 'courses', f'exam:{identity}')
        extra['attempt'] = attempt_view(db['exam_attempts'].get(identity))
    else:
        raise APIError(404, 'Endpoint was not found.')
    if lesson is not None and lesson_done_before is False:
        row = db['lesson_progress'].find_one(progress_key, ['completed_at'])
        if row:
            activity_log.lesson_completed(db, candidate, run, lesson_id=lesson['id'], at=row['completed_at'])
    from notifications import refresh
    if action != 'video' or data.get('complete') is True:
        refresh(db, {'id': candidate})
    issue_certificate(db, candidate, current_run(db, candidate, course_id=run['course_id'])['id'])
    return {'learning': bundle(db, candidate,run['course_id']), **extra}


def records(db, candidate):
    """Every learning record of one candidate. Two round trips: the runs, then everything else in one batched read.
    Rows of the per-run tables come in the former join order: runs by course and run number, then each table's key order."""
    runs = db['course_runs'].find({'candidate_id': candidate}, sort='run_number')
    rank = {r['id']: i for i, r in enumerate(sorted(runs, key=lambda r: (r['course_id'], r['run_number'])))}
    within = {'run_id': {'$in': list(rank)}}
    data = batch_read(db,
        video_progress=('video_progress', within), exercise_attempts=('exercise_attempts', within),
        exam_attempts=('exam_attempts', within), certificates=('certificates', within),
        assignment_attempts=('checkpoint_attempts', within, None, ['id', 'run_id', 'checkpoint_id', 'attempt_number', 'status', 'started_at', 'deadline', 'finished_at', 'score', 'total', 'reason']),
        assessment_attempts=('assessment_attempts', {'employee_id': candidate}, None, ['id', 'assessment_id', 'attempt_number', 'status', 'started_at', 'finished_at', 'score', 'total', 'percent']),
        session_registrations=('session_registrations', {'employee_id': candidate}),
        development_records=('development_records', {'employee_id': candidate}),
        account_events=('auth_events', {'candidate_id': candidate}, 'id', ['event', 'created_at']))
    keys = {'video_progress': ('video_index',), 'exercise_attempts': ('set_index', 'exercise_index'), 'exam_attempts': ('set_index', 'attempt_number'), 'certificates': ()}
    result = {'runs': runs}
    for table, columns in keys.items():
        # Stable sorts keep insertion order among equal keys, like SQLite's rowid order.
        result[table] = sorted(data[table], key=lambda r: (rank[r['run_id']], *(r[c] for c in columns)))
    result['assignment_attempts'] = sorted(data['assignment_attempts'], key=lambda r: r['started_at'])
    result['assessment_attempts'] = sorted(data['assessment_attempts'], key=lambda r: r['started_at'])
    result['session_registrations'] = data['session_registrations']
    result['development_records'] = sorted(data['development_records'], key=lambda r: r['completed_on'])
    result['account_events'] = data['account_events']
    return result


DUMMY_HASH = password_hash('not-a-real-candidate-password')
