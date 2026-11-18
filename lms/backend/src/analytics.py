"""Learning analytics computed from stored records: progress, assignments, dashboards, reports, recommendations.

No figure here is hardcoded; every number is derived from MongoDB records at request time.
"""
import json
import heapq
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from deadlines import end_of_day
from services import check, now
from store import like

UNITS = 15  # 6 videos + 6 exercises + 3 module exams per course run
STATUS_LABELS = {'completed': 'Completed', 'overdue': 'Overdue', 'in_progress': 'In progress', 'not_started': 'Not started'}
PAGE_SIZE = 25


def today():
    return date.today().isoformat()


def local_now():
    # Training session times are entered and compared in the server's local time.
    return datetime.now().strftime('%Y-%m-%dT%H:%M')


def ids_clause(ids, column):
    """MongoDB condition restricting a field to a list of ids; None means unrestricted (an empty list matches nothing)."""
    if ids is None:
        return {}
    return {column: {'$in': list(ids)}}


def names_by_id(db, table, ids, field='name'):
    """id -> one column of the rows with these ids (the former LEFT JOIN lookups)."""
    ids = [i for i in set(ids) if i is not None]
    return {r['id']: r[field] for r in db[table].find({'id': {'$in': ids}}, ['id', field])} if ids else {}


def run_owners(db, course_ids=None, employee_ids=None):
    """run id -> course run (id, candidate_id, course_id) for runs in scope: the former JOIN course_runs."""
    return {r['id']: r for r in db['course_runs'].find({**ids_clause(course_ids, 'course_id'), **ids_clause(employee_ids, 'candidate_id')}, ['id', 'candidate_id', 'course_id'])}


def run_filter(runs, unrestricted=False):
    """Restrict a run_id column to these runs; unrestricted reads every row (rows of unknown runs are then skipped)."""
    return {} if unrestricted else {'run_id': {'$in': list(runs)}}


_SQLITE_DATE = re.compile(r'\s*(\d{4})-(\d\d)-(\d\d)(?:(?:T|\s+)(\d\d):(\d\d)(?::(\d\d(?:\.\d*)?))?)?\s*(?:(Z)|([+-])(\d\d):(\d\d))?\s*', re.I)


def julian_ms(stamp):
    """SQLite's julianday() of a date/time string, as its internal integer milliseconds; None when SQLite returned NULL.
    Session start and end times keep their former arithmetic exactly (see training_seconds)."""
    match = _SQLITE_DATE.fullmatch(stamp) if isinstance(stamp, str) else None
    if not match:
        return None
    year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    hour, minute = int(match.group(4) or 0), int(match.group(5) or 0)
    second = float(match.group(6) or 0)
    if not (1 <= month <= 12 and 1 <= day <= 31 and hour <= 24 and minute <= 59 and second < 60):
        return None
    y, m = (year - 1, month + 12) if month <= 2 else (year, month)
    a = y // 100 + 48  # (Y+4800)/100 with C integer division; Y is positive here
    b = 38 - a + a // 4
    x1, x2 = 36525 * (y + 4716) // 100, 306001 * (m + 1) // 10000
    ms = int((x1 + x2 + day + b - 1524.5) * 86400000) + hour * 3600000 + minute * 60000 + int(second * 1000 + 0.5)
    if match.group(8):
        offset = int(match.group(9)) * 60 + int(match.group(10))
        ms -= (offset if match.group(8) == '+' else -offset) * 60000
    return ms


def query_date(query, field):
    value = query.get(field, [''])[0]
    if not value:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        check(False, f'{field} must be a date in YYYY-MM-DD format.')


def in_range(stamp, start, end):
    """ISO timestamps compare lexicographically; the end date is inclusive."""
    if not stamp:
        return False
    return (start is None or stamp >= start) and (end is None or stamp[:10] <= end)


# ---------------------------------------------------------------- scope and base data

def scope(db, user):
    """Return (employee_ids, course_ids) the user may analyse; None means all."""
    role = user['role']
    if role in ('admin', 'hr'):
        return None, None
    if role == 'manager':
        return [r['id'] for r in db['candidates'].find({'manager_id': user['id'], 'is_active': 1}, ['id'])], None
    if role == 'trainer':
        return None, [r['id'] for r in db['courses'].find({'$or': [{'trainer_id': user['id']}, {'created_by': user['id']}]}, ['id'])]
    check(False, 'You do not have permission to view learning analytics.', 403)


def employee_rows(db, ids=None):
    people = db['candidates'].find({'is_active': 1, 'role': {'$ne': 'admin'}, **ids_clause(ids, 'id')},
                                   ['id', 'full_name', 'email', 'role', 'department_id', 'job_role_id', 'manager_id', 'job_title'])
    departments = names_by_id(db, 'departments', [p['department_id'] for p in people])
    roles = names_by_id(db, 'job_roles', [p['job_role_id'] for p in people])
    rows = [{'id': p['id'], 'name': p['full_name'], 'email': p['email'], 'role': p['role'], 'department_id': p['department_id'], 'job_role_id': p['job_role_id'],
             'manager_id': p['manager_id'], 'job_title': p['job_title'], 'department': departments.get(p['department_id']), 'job_role': roles.get(p['job_role_id'])} for p in people]
    # Sorted here: the candidates collection compares strings ignoring case, and names were ordered case-sensitively.
    return sorted(rows, key=lambda r: r['name'])


def course_rows(db, course_ids=None, published_only=False):
    status = {'status': 'published'} if published_only else {}
    return {r['id']: r for r in db['courses'].find({**ids_clause(course_ids, 'id'), **status},
                                                   ['id', 'title', 'description', 'category', 'status', 'difficulty', 'duration_minutes', 'department_id', 'post_assessment_id'])}


# Learning activity of a run: (table, time column, the distinct items that count as done units, or None).
RUN_ACTIVITY = (
    ('video_progress', 'updated_at', {'$cond': [{'$ne': ['$completed_at', None]}, '$video_index', None]}),
    ('exercise_attempts', 'submitted_at', {'$cond': [{'$eq': ['$passed', 1]}, {'$add': [{'$multiply': ['$set_index', 2]}, '$exercise_index']}, None]}),
    ('exam_attempts', 'started_at', {'$cond': [{'$eq': ['$status', 'passed']}, '$set_index', None]}),
    ('lesson_progress', 'completed_at', '$lesson_id'),
    ('checkpoint_attempts', 'started_at', {'$cond': [{'$eq': ['$status', 'passed']}, '$checkpoint_id', None]}),
    ('lesson_watch', 'updated_at', None),
    ('lesson_activity_attempts', 'submitted_at', None),
)


def run_activity(db, runs, unrestricted=False):
    """run id -> {table: (latest activity time or None, distinct done items)}, read with one aggregation.
    unrestricted reads every current (unarchived) run instead of listing their IDs. ($unionWith is not allowed in
    MongoDB transactions, so each table is joined to the runs with $lookup.)"""
    pipeline = [{'$match': {'archived_at': None} if unrestricted else {'id': {'$in': list(runs)}}}, {'$project': {'_id': 0, 'id': 1}}]
    for table, column, done in RUN_ACTIVITY:
        group = {'_id': None, 't': {'$max': '$' + column}}
        if done is not None:
            group['done'] = {'$addToSet': done}
        pipeline.append({'$lookup': {'from': db.collection_name(table), 'localField': 'id', 'foreignField': 'run_id', 'pipeline': [{'$group': group}], 'as': table}})
    result = {}
    for row in db['course_runs'].aggregate(pipeline):
        result[row['id']] = {table: (row[table][0].get('t'), {value for value in row[table][0].get('done', []) if value is not None})
                             for table, _, _ in RUN_ACTIVITY if row[table]}
    return result


def progress_index(db, employee_ids=None, course_ids=None):
    """(employee, course) -> progress of the current run plus whether any run was completed."""
    runs = db['course_runs'].find({**ids_clause(employee_ids, 'candidate_id'), **ids_clause(course_ids, 'course_id')},
                                  ['id', 'candidate_id', 'course_id', 'started_at', 'completed_at', 'deadline_at_completion', 'archived_at'])
    groups = {}
    for r in runs:
        groups.setdefault((r['candidate_id'], r['course_id']), []).append(r)
    index = {}
    for pair in sorted(groups):  # GROUP BY candidate_id,course_id returned the pairs in this order.
        rows = groups[pair]
        finished = [r for r in rows if r['completed_at'] is not None]
        completed_at = min((r['completed_at'] for r in finished), default=None)
        deadline_at_completion = min(finished, key=lambda r: r['completed_at'])['deadline_at_completion'] if finished else None
        started_at = min((r['started_at'] for r in rows if r['started_at'] is not None), default=None)
        index[pair] = {'units': 0, 'progress': 0, 'ready': False, 'completed': completed_at is not None, 'completedAt': completed_at, 'deadlineAtCompletion': deadline_at_completion, 'startedAt': started_at, 'started': False, 'lastActivity': ''}
    active = [r for r in runs if r['archived_at'] is None]
    course_ids_used = list({r['course_id'] for r in active})
    formats = {c['id']: c['format'] for c in db['courses'].find({'id': {'$in': course_ids_used}}, ['id', 'format'])} if active else {}
    active = [r for r in active if r['course_id'] in formats]
    lesson_course, lesson_total, checkpoint_total, activity = {}, Counter(), Counter(), {}
    if active:
        for lesson in db['course_lessons'].find({'course_id': {'$in': course_ids_used}}, ['id', 'course_id']):
            lesson_course[lesson['id']] = lesson['course_id']
            lesson_total[lesson['course_id']] += 1
        checkpoint_total = Counter(c['course_id'] for c in db['course_checkpoints'].find({'course_id': {'$in': course_ids_used}}, ['course_id']))
        activity = run_activity(db, [r['id'] for r in active], employee_ids is None and course_ids is None)
    # Module courses have 15 units per run; lesson-based courses have one unit per lesson.
    for run in active:
        done = activity.get(run['id'], {})
        items = lambda table: done.get(table, (None, set()))[1]
        r = {'format': formats[run['course_id']], 'lesson_total': lesson_total[run['course_id']], 'checkpoint_total': checkpoint_total[run['course_id']],
             'units': len(items('video_progress')) + len(items('exercise_attempts')) + len(items('exam_attempts')) + sum(1 for lesson in items('lesson_progress') if lesson_course.get(lesson) == run['course_id']),
             'checkpoint_done': len(items('checkpoint_attempts')), 'last_activity': max((stamp or '' for stamp, _ in done.values()), default='')}
        item = index[(run['candidate_id'], run['course_id'])]
        total = r['lesson_total'] + r['checkpoint_total'] if r['format'] == 'lessons' else UNITS
        units = r['units'] + r['checkpoint_done'] if r['format'] == 'lessons' else r['units']
        item.update({'units': units, 'progress': min(100, round(units / total * 100)) if total else 0, 'ready': total > 0 and units >= total,
                     'lastActivity': r['last_activity'], 'started': units > 0 or bool(r['last_activity'])})
    for item in index.values():
        item['started'] = item['started'] or item['completed']
    return index


def assignment_index(db, employee_ids=None, course_ids=None):
    """(employee, course) -> the assignment in force when an employee has several (employee, department, job role).

    A mandatory assignment beats an optional one, so a manager's recommendation cannot weaken mandatory training. Next a
    deadline beats none, an individual assignment beats a group one (this is how one person gets a different deadline),
    and otherwise the earliest deadline applies.
    """
    index = {}
    people = db['candidates'].find({'is_active': 1, **ids_clause(employee_ids, 'id')}, ['id', 'department_id', 'job_role_id'])
    if not people:
        return index
    where = ids_clause(course_ids, 'course_id')
    if employee_ids is not None:
        where['$or'] = [{'target_type': 'employee', 'target_id': {'$in': [p['id'] for p in people]}},
                        {'target_type': 'department', 'target_id': {'$in': list({p['department_id'] for p in people if p['department_id'] is not None})}},
                        {'target_type': 'job_role', 'target_id': {'$in': list({p['job_role_id'] for p in people if p['job_role_id'] is not None})}}]
    assignments = db['course_assignments'].find(where, ['id', 'course_id', 'target_type', 'target_id', 'mandatory', 'due_date', 'deadline_at', 'original_deadline_at', 'deadline_updated_at', 'assigned_at', 'assigned_by'])
    if not assignments:
        return index
    published = {c['id'] for c in db['courses'].find({'id': {'$in': list({a['course_id'] for a in assignments})}, 'status': 'published'}, ['id'])}
    assigners = names_by_id(db, 'candidates', [a['assigned_by'] for a in assignments], 'full_name')
    by_target = {}
    for a in assignments:
        if a['course_id'] in published:
            by_target.setdefault((a['target_type'], a['target_id']), []).append(a)
    rows = []
    for person in people:
        for target in (('employee', person['id']), ('department', person['department_id']), ('job_role', person['job_role_id'])):
            if target[1] is not None:
                rows.extend(dict(a, employee_id=person['id'], assigned_by=assigners.get(a['assigned_by'])) for a in by_target.get(target, ()))

    def order(r):  # ORDER BY a.mandatory DESC,COALESCE(deadline_at,due_date) IS NULL,target_type<>'employee',COALESCE(...),assigned_at,id
        deadline = r['deadline_at'] if r['deadline_at'] is not None else r['due_date']
        return (-(r['mandatory'] or 0), deadline is None, r['target_type'] != 'employee', deadline or '', r['assigned_at'] is not None, r['assigned_at'] or '', r['id'])
    for r in sorted(rows, key=order):
        pair = (r['employee_id'], r['course_id'])
        if pair not in index:
            # Rows written directly with only a date still have an exact deadline: the end of that day.
            deadline = r['deadline_at'] or (end_of_day(r['due_date']) if r['due_date'] else None)
            index[pair] = {'assignmentId': r['id'], 'targetType': r['target_type'], 'mandatory': bool(r['mandatory']), 'dueDate': r['due_date'], 'deadlineAt': deadline, 'originalDeadlineAt': r['original_deadline_at'] or deadline,
                           'deadlineUpdatedAt': r['deadline_updated_at'], 'assignedAt': r['assigned_at'], 'assignedBy': r['assigned_by'] or ''}
    return index


def pair_status(progress, assignment):
    if progress and progress['completed']:
        return 'completed'
    if assignment and assignment['deadlineAt'] and assignment['deadlineAt'] <= now():
        return 'overdue'
    if progress and progress['started']:
        return 'in_progress'
    return 'not_started'


def activity_times(db, course_ids=None):
    """Learning activity timestamps per employee (video, practice, exams, assessments)."""
    sources = (('video_progress', 'updated_at'), ('exercise_attempts', 'submitted_at'), ('exam_attempts', 'started_at'),
               ('lesson_progress', 'completed_at'), ('lesson_watch', 'updated_at'), ('lesson_activity_attempts', 'submitted_at'))
    # One aggregation over the runs in scope, joining each activity table ($unionWith is not allowed in transactions).
    pipeline = [{'$match': ids_clause(course_ids, 'course_id')}, {'$project': {'_id': 0, 'id': 1, 'candidate_id': 1}}]
    pipeline += [{'$lookup': {'from': db.collection_name(table), 'localField': 'id', 'foreignField': 'run_id',
                              'pipeline': [{'$project': {'_id': 0, 't': {'$ifNull': ['$' + column, None]}}}], 'as': table}} for table, column in sources]
    times = {}
    for run in db['course_runs'].aggregate(pipeline):
        for table, _ in sources:
            for r in run[table]:
                times.setdefault(run['candidate_id'], []).append(r['t'])
    if course_ids is None:
        for r in db['assessment_attempts'].find({}, ['employee_id', 'started_at']):
            times.setdefault(r['employee_id'], []).append(r['started_at'])
    return times


def training_seconds(db, course_ids=None, start=None, end=None):
    """Seconds of verified video watching, attended instructor-led sessions and completed lessons, per employee.
    A completed lesson counts for its planned duration, so text-based courses add to training time too."""
    runs = run_owners(db, course_ids)
    match = run_filter(runs, course_ids is None)
    totals = {}
    for r in db['video_progress'].find(match, ['run_id', 'watched_seconds', 'updated_at']) if runs else []:
        if r['run_id'] in runs and (start is None and end is None or in_range(r['updated_at'], start, end)):
            candidate = runs[r['run_id']]['candidate_id']
            totals[candidate] = totals.get(candidate, 0) + r['watched_seconds']
    sessions = {s['id']: s for s in db['training_sessions'].find(ids_clause(course_ids, 'course_id'), ['id', 'starts_at', 'ends_at'])}
    for r in db['session_registrations'].find({'status': 'attended', 'session_id': {'$in': list(sessions)}}, ['employee_id', 'session_id']) if sessions else []:
        s = sessions[r['session_id']]
        if start is None and end is None or in_range(s['starts_at'], start, end):
            # (julianday(ends_at)-julianday(starts_at))*86400, with SQLite's floating-point arithmetic.
            ends, starts = julian_ms(s['ends_at']), julian_ms(s['starts_at'])
            seconds = None if ends is None or starts is None else (ends / 86400000.0 - starts / 86400000.0) * 86400
            totals[r['employee_id']] = totals.get(r['employee_id'], 0) + max(0, seconds or 0)
    progress = db['lesson_progress'].find(match, ['run_id', 'lesson_id', 'completed_at']) if runs else []
    minutes = names_by_id(db, 'course_lessons', [p['lesson_id'] for p in progress], 'duration_minutes')
    for r in progress:
        if r['run_id'] in runs and r['lesson_id'] in minutes and (start is None and end is None or in_range(r['completed_at'], start, end)):
            candidate = runs[r['run_id']]['candidate_id']
            totals[candidate] = totals.get(candidate, 0) + max(0, minutes[r['lesson_id']] or 0) * 60
    return totals


def training_progress(db, employee_ids, year=None):
    """Each employee's yearly training-hours target and the hours completed in that calendar year."""
    year = year or date.today().year
    seconds = training_seconds(db, None, f'{year}-01-01', f'{year}-12-31')
    targets = {r['employee_id']: r['hours'] for r in db['training_targets'].find({'year': year}, ['employee_id', 'hours'])}
    result = {}
    for employee in employee_ids:
        done, target = round(seconds.get(employee, 0) / 3600, 1), targets.get(employee)
        result[employee] = {'year': year, 'targetHours': target, 'completedHours': done,
                            'percent': min(100, round(done / target * 100)) if target else None}
    return result


def assessment_scores(db, course_ids=None, start=None, end=None):
    """Percent scores of finished module exams and standalone assessments, per employee."""
    runs = run_owners(db, course_ids)
    scores = {}
    for r in db['exam_attempts'].find({'status': {'$in': ['passed', 'failed']}, **run_filter(runs, course_ids is None)}, ['run_id', 'score', 'finished_at']) if runs else []:
        if r['run_id'] in runs and in_range(r['finished_at'], start, end):
            scores.setdefault(runs[r['run_id']]['candidate_id'], []).append(None if r['score'] is None else r['score'] * 25)
    assessments = {a['id'] for a in db['assessments'].find(ids_clause(course_ids, 'course_id'), ['id'])}
    where = {} if course_ids is None else {'assessment_id': {'$in': list(assessments)}}
    for r in db['assessment_attempts'].find({'status': {'$in': ['passed', 'failed']}, **where}, ['employee_id', 'assessment_id', 'percent', 'finished_at']) if assessments else []:
        if r['assessment_id'] in assessments and in_range(r['finished_at'], start, end):
            scores.setdefault(r['employee_id'], []).append(r['percent'])
    return scores


def average(values):
    return round(sum(values) / len(values)) if values else None


# ---------------------------------------------------------------- recommendations

def recommendations(db, employee, progress, assigned, limit=6):
    """Transparent rule-based recommendations; every item lists the rules that selected it."""
    completed = db['course_runs'].distinct('course_id', {'candidate_id': employee['id'], 'completed_at': {'$ne': None}})
    finished = set(completed)
    # Department-only courses are recommended only inside that department.
    visible = {'status': 'published', '$or': [{'visibility': 'everyone'}, {'department_id': None}, {'department_id': employee.get('department_id') or ''}]}
    # Read in insertion order and sorted here by title, which keeps ORDER BY title,rowid.
    courses = db['courses'].find({'$or': [{'id': {'$in': completed}}, visible]}, ['id', 'title', 'description', 'difficulty', 'duration_minutes', 'category', 'department_id', 'status', 'visibility'])
    completed_categories = {c['category'] for c in courses if c['id'] in finished}
    published = sorted((c for c in courses if c['status'] == 'published' and (c['visibility'] == 'everyone' or c['department_id'] is None or c['department_id'] == (employee.get('department_id') or ''))),
                       key=lambda c: c['title'])
    department = employee.get('department')

    def candidates():
        for course in published:
            item = progress.get((employee['id'], course['id']))
            if (item and (item['completed'] or item['started'])) or (employee['id'], course['id']) in assigned:
                continue
            reasons, score = [], 0
            if department and course['department_id'] and course['department_id'] == employee['department_id']:
                reasons.append(f'Designed for the {department} department.'); score += 1
            if course['category'] in completed_categories:
                reasons.append(f'Builds on {course["category"]} courses you have completed.'); score += 1
            if score:
                yield {'id': course['id'], 'title': course['title'], 'description': course['description'], 'difficulty': course['difficulty'], 'durationMinutes': course['duration_minutes'],
                       'category': course['category'], 'reasons': reasons, 'score': score}
    rank = lambda row: (-row['score'], row['title'])
    if limit is None or limit < 0:
        return sorted(candidates(), key=rank)[:limit]
    return heapq.nsmallest(limit, candidates(), key=rank)


def pending_assessments(db, employee, progress):
    """Assessments the employee is expected to take next, with the reason and remaining attempts."""
    used = {}
    for r in db['assessment_attempts'].find({'employee_id': employee['id']}, ['assessment_id', 'status']):
        count, has_passed = used.get(r['assessment_id'], (0, 0))
        used[r['assessment_id']] = (count + 1, max(has_passed, 1 if r['status'] == 'passed' else 0))
    assessments = sorted(db['assessments'].find({'status': 'published'}), key=lambda a: a['title'])
    course_titles = names_by_id(db, 'courses', [a['course_id'] for a in assessments], 'title')
    items = []
    for a in assessments:
        a['course_title'] = course_titles.get(a['course_id'])
        count, has_passed = used.get(a['id'], (0, 0))
        if count >= a['max_attempts']:
            continue
        item = progress.get((employee['id'], a['course_id'])) if a['course_id'] else None
        reason = None
        if a['kind'] == 'post' and item and item['ready'] and not item['completed'] and not has_passed:
            reason = f'Required to complete {a["course_title"]}.'
        elif a['kind'] == 'pre' and item and not item['completed'] and count == 0:
            reason = f'Pre-training check for {a["course_title"]}.'
        if reason:
            items.append({'id': a['id'], 'title': a['title'], 'kind': a['kind'], 'reason': reason, 'attemptsLeft': a['max_attempts'] - count})
    return items


# ---------------------------------------------------------------- dashboard

def dashboard(db, user, query):
    employee_scope, course_scope = scope(db, user)
    start, end = query_date(query, 'from'), query_date(query, 'to')
    people = employee_rows(db, employee_scope)
    ids = [p['id'] for p in people]
    progress = progress_index(db, ids, course_scope)
    assignments = assignment_index(db, ids, course_scope)
    pairs = set(progress) | set(assignments)
    statuses = {pair: pair_status(progress.get(pair), assignments.get(pair)) for pair in pairs}
    times = activity_times(db, course_scope)
    id_set = set(ids)
    recent_cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%S')
    active = {e for e in ids if any(t and t >= recent_cutoff for t in times.get(e, []))}
    hours = training_seconds(db, course_scope)
    certificate_runs = run_owners(db, course_scope, ids)
    certificates = db['certificates'].count({'run_id': {'$in': list(certificate_runs)}}) if certificate_runs else 0
    completed = sum(1 for s in statuses.values() if s == 'completed')
    by_employee = {}
    for (employee, course), status in statuses.items():
        by_employee.setdefault(employee, []).append((course, status))
    assigned_by_employee = {}
    for (employee, course) in assignments:
        assigned_by_employee.setdefault(employee, []).append(statuses[(employee, course)])
    courses = course_rows(db, course_scope)
    published = [c for c in courses.values() if c['status'] == 'published']
    overdue_people = [{'id': e['id'], 'name': e['name'], 'department': e['department'], 'overdue': sum(1 for _, s in by_employee.get(e['id'], []) if s == 'overdue')} for e in people]
    overdue_people = sorted([o for o in overdue_people if o['overdue']], key=lambda o: -o['overdue'])
    kpis = {
        'totalEmployees': len(people), 'activeLearners': len(active), 'publishedCourses': len(published),
        'completionRate': round(completed / len(pairs) * 100) if pairs else 0, 'enrollments': len(pairs), 'completions': completed,
        'certificatesEarned': certificates, 'trainingHours': round(sum(hours.get(e, 0) for e in ids) / 3600, 1),
        'pendingMandatory': sum(1 for pair, a in assignments.items() if a['mandatory'] and statuses[pair] != 'completed'),
    }
    progress_summary = {
        'activelyLearning': sum(1 for e in ids if any(s == 'in_progress' for _, s in by_employee.get(e, []))),
        'completedAssigned': sum(1 for e, items in assigned_by_employee.items() if items and all(s == 'completed' for s in items)),
        'notStarted': sum(1 for e in ids if not any(s in ('completed', 'in_progress') for _, s in by_employee.get(e, [])) and e not in times),
        'overdue': len(overdue_people), 'overdueEmployees': overdue_people[:8],
    }
    scores = assessment_scores(db, course_scope, start, end)
    period_hours = training_seconds(db, course_scope, start, end) if (start or end) else hours
    departments = {}
    for e in people:
        key = e['department'] or 'Unassigned'
        row = departments.setdefault(key, {'department': key, 'employees': 0, 'participants': 0, 'pairs': 0, 'completed': 0, 'completionsInPeriod': 0, 'scores': [], 'seconds': 0})
        row['employees'] += 1
        employee_times = times.get(e['id'], [])
        if any(in_range(t, start, end) for t in employee_times):
            row['participants'] += 1
        for course, status in by_employee.get(e['id'], []):
            row['pairs'] += 1
            row['completed'] += status == 'completed'
            if status == 'completed' and in_range(progress.get((e['id'], course), {}).get('completedAt'), start, end):
                row['completionsInPeriod'] += 1
        row['scores'] += scores.get(e['id'], [])
        row['seconds'] += period_hours.get(e['id'], 0)
    department_rows = []
    for row in sorted(departments.values(), key=lambda r: r['department']):
        department_rows.append({'department': row['department'], 'employees': row['employees'], 'participants': row['participants'],
                                'participationRate': round(row['participants'] / row['employees'] * 100) if row['employees'] else 0,
                                'completionRate': round(row['completed'] / row['pairs'] * 100) if row['pairs'] else 0, 'completionsInPeriod': row['completionsInPeriod'],
                                'averageScore': average(row['scores']), 'trainingHours': round(row['seconds'] / 3600, 1)})
    # Yearly training-hours progress per direct report, for the Manager View.
    team_training = training_progress(db, ids) if employee_scope is not None else {}
    return {'scope': 'organisation' if employee_scope is None and course_scope is None else 'team' if employee_scope is not None else 'courses',
            'kpis': kpis, 'progress': progress_summary, 'departments': department_rows, 'period': {'from': start, 'to': end},
            'recent': recent_activity(db, id_set, course_scope, employee_scope is not None), 'upcoming': upcoming_training(db, people, progress, assignments, statuses, courses),
            'training': [{'id': e['id'], 'name': e['name'], 'department': e['department'], **team_training[e['id']]} for e in people if e['id'] in team_training]}


def recent_activity(db, ids, course_scope, team_only, limit=12):
    events = []
    # The latest 40 (or 20) records of each kind are read first, then joined to names with one query per collection.
    runs = None if course_scope is None else run_owners(db, course_scope)
    by_run = {} if runs is None else {'run_id': {'$in': list(runs)}}
    awards = db['certificates'].find(by_run, ['run_id', 'issued_at'], sort='-issued_at', limit=40) if runs != {} else []
    exams = db['exam_attempts'].find({'status': {'$in': ['passed', 'failed']}, **by_run}, ['run_id', 'score', 'status', 'finished_at', 'set_index'], sort='-finished_at', limit=40) if runs != {} else []
    if runs is None:
        read = list({x['run_id'] for x in awards + exams})
        runs = {r['id']: r for r in db['course_runs'].find({'id': {'$in': read}}, ['id', 'candidate_id', 'course_id'])} if read else {}
    assessments = {a['id']: a['title'] for a in db['assessments'].find(ids_clause(course_scope, 'course_id'), ['id', 'title'])} if course_scope is not None else None
    attempts = db['assessment_attempts'].find({'status': {'$in': ['passed', 'failed']}, **({} if assessments is None else {'assessment_id': {'$in': list(assessments)}})},
                                              ['assessment_id', 'percent', 'status', 'finished_at', 'employee_id'], sort='-finished_at', limit=40) if assessments != {} else []
    if assessments is None:
        assessments = names_by_id(db, 'assessments', [t['assessment_id'] for t in attempts], 'title')
    published = []
    if not team_only:
        published = db['admin_events'].aggregate([{'$match': {'action': 'course_saved', 'detail': like('published:%'), **ids_clause(course_scope, 'target_id')}},
                                                  {'$group': {'_id': '$target_id', 'at': {'$min': '$created_at'}}}])
    assigned = db['course_assignments'].find(ids_clause(course_scope, 'course_id'), ['target_type', 'target_id', 'mandatory', 'assigned_at', 'course_id'], sort='-assigned_at', limit=20)
    names = names_by_id(db, 'candidates', [r['candidate_id'] for r in runs.values()] + [t['employee_id'] for t in attempts] + [a['target_id'] for a in assigned if a['target_type'] == 'employee'], 'full_name')
    titles = names_by_id(db, 'courses', [r['course_id'] for r in runs.values()] + [g['_id'] for g in published] + [a['course_id'] for a in assigned], 'title')
    joined = lambda run_id: runs[run_id] if run_id in runs and runs[run_id]['candidate_id'] in names and runs[run_id]['course_id'] in titles else None
    for x in awards:
        r = joined(x['run_id'])
        if r and r['candidate_id'] in ids:
            events.append({'type': 'completion', 'at': x['issued_at'], 'text': f'{names[r["candidate_id"]]} completed {titles[r["course_id"]]} and earned a certificate'})
    for x in exams:
        r = joined(x['run_id'])
        if r and r['candidate_id'] in ids:
            events.append({'type': 'assessment', 'at': x['finished_at'], 'text': f'{names[r["candidate_id"]]} {"passed" if x["status"] == "passed" else "did not pass"} the Module {x["set_index"] + 1} exam in {titles[r["course_id"]]} ({x["score"] * 25}%)'})
    for t in attempts:
        if t['assessment_id'] in assessments and t['employee_id'] in names and t['employee_id'] in ids:
            events.append({'type': 'assessment', 'at': t['finished_at'], 'text': f'{names[t["employee_id"]]} {"passed" if t["status"] == "passed" else "did not pass"} {assessments[t["assessment_id"]]} ({t["percent"]}%)'})
    for g in sorted((g for g in published if g['_id'] in titles), key=lambda g: g['at'], reverse=True)[:20]:
        events.append({'type': 'course', 'at': g['at'], 'text': f'{titles[g["_id"]]} was published'})
    groups = {kind: names_by_id(db, table, [a['target_id'] for a in assigned if a['target_type'] == kind]) for kind, table in (('department', 'departments'), ('job_role', 'job_roles'))}
    for r in assigned:
        if r['course_id'] not in titles:
            continue
        if team_only and not (r['target_type'] == 'employee' and r['target_id'] in ids):
            continue
        target = names.get(r['target_id']) if r['target_type'] == 'employee' else groups.get(r['target_type'], {}).get(r['target_id'])
        events.append({'type': 'assignment', 'at': r['assigned_at'], 'text': f'{titles[r["course_id"]]} assigned to {target or "a removed target"}{" (mandatory)" if r["mandatory"] else ""}'})
    events.sort(key=lambda e: e['at'] or '', reverse=True)
    return events[:limit]


def upcoming_training(db, people, progress, assignments, statuses, courses):
    now_local, horizon = local_now(), (date.today() + timedelta(days=60)).isoformat()
    rows = db['training_sessions'].find({'status': 'scheduled', 'ends_at': {'$gte': now_local}, 'starts_at': {'$lte': horizon + 'T23:59'}},
                                        ['id', 'title', 'kind', 'starts_at', 'ends_at', 'location', 'capacity', 'trainer_id'], sort='starts_at', limit=8)
    trainers = names_by_id(db, 'candidates', [s['trainer_id'] for s in rows], 'full_name')
    registered = Counter(g['session_id'] for g in db['session_registrations'].find({'session_id': {'$in': [s['id'] for s in rows]}, 'status': {'$in': ['registered', 'attended']}}, ['session_id'])) if rows else Counter()
    sessions = [{'id': s['id'], 'title': s['title'], 'kind': s['kind'], 'starts_at': s['starts_at'], 'ends_at': s['ends_at'], 'location': s['location'], 'capacity': s['capacity'],
                 'trainer': trainers.get(s['trainer_id']), 'registered': registered[s['id']]} for s in rows]
    deadline_limit = (date.today() + timedelta(days=30)).isoformat()
    deadlines = {}
    for pair, a in assignments.items():
        if a['mandatory'] and a['dueDate'] and statuses[pair] != 'completed' and a['dueDate'] <= deadline_limit:
            row = deadlines.setdefault((pair[1], a['dueDate']), {'courseId': pair[1], 'course': courses.get(pair[1], {}).get('title', ''), 'dueDate': a['dueDate'], 'pending': 0, 'overdue': bool(a['deadlineAt'] and a['deadlineAt'] <= now())})
            row['pending'] += 1
    pending = {}
    for (employee, course), item in progress.items():
        c = courses.get(course)
        if c and c['post_assessment_id'] and item['ready'] and not item['completed']:
            pending.setdefault(course, {'course': c['title'], 'employees': 0})['employees'] += 1
    published_post = {r['id'] for r in db['assessments'].find({'status': 'published', 'kind': 'post'}, ['id'])}
    pending_rows = [dict(v, courseId=k) for k, v in pending.items() if courses[k]['post_assessment_id'] in published_post]
    return {'sessions': sessions, 'deadlines': sorted(deadlines.values(), key=lambda d: d['dueDate'])[:10], 'pendingAssessments': pending_rows}


# ---------------------------------------------------------------- reports

REPORTS = {
    'enrollments': 'Course enrollment and completion', 'employees': 'Employee learning progress', 'departments': 'Department training statistics',
    'assessments': 'Assessment performance', 'compliance': 'Mandatory training compliance', 'certificates': 'Certificate records',
}
TRAINER_REPORTS = ('enrollments', 'assessments', 'certificates')


def report(db, user, query):
    employee_scope, course_scope = scope(db, user)
    kind = query.get('type', ['enrollments'])[0]
    check(kind in REPORTS, 'Unknown report type.')
    check(user['role'] != 'trainer' or kind in TRAINER_REPORTS, 'Trainers can view course-level reports only.', 403)
    start, end = query_date(query, 'from'), query_date(query, 'to')
    department, employee, course = (query.get(k, [''])[0] or None for k in ('department', 'employee', 'course'))
    people = [p for p in employee_rows(db, employee_scope) if (department is None or p['department_id'] == department) and (employee is None or p['id'] == employee)]
    ids = [p['id'] for p in people]
    courses_in_scope = course_scope if course is None else [c for c in (course_scope if course_scope is not None else [course]) if c == course]
    builder = {'enrollments': report_enrollments, 'employees': report_employees, 'departments': report_departments, 'assessments': report_assessments,
               'compliance': report_compliance, 'certificates': report_certificates}[kind]
    columns, rows, summary = builder(db, people, ids, courses_in_scope, start, end)
    total = len(rows)
    if query.get('export', [''])[0] == '1':
        page, pages, rows = 1, 1, rows[:10000]
    else:
        try:
            page = max(1, int(query.get('page', ['1'])[0]))
        except ValueError:
            page = 1
        pages = max(1, -(-total // PAGE_SIZE))
        page = min(page, pages)
        rows = rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]
    return {'type': kind, 'title': REPORTS[kind], 'columns': [{'key': k, 'label': l} for k, l in columns], 'rows': rows, 'summary': summary, 'total': total, 'page': page, 'pages': pages,
            'filters': {'from': start, 'to': end, 'department': department, 'employee': employee, 'course': course}}


def report_enrollments(db, people, ids, course_ids, start, end):
    progress, assignments = progress_index(db, ids, course_ids), assignment_index(db, ids, course_ids)
    courses, by_id = course_rows(db, course_ids), {p['id']: p for p in people}
    rows = []
    for pair in sorted(set(progress) | set(assignments), key=lambda k: (by_id[k[0]]['name'] if k[0] in by_id else '', courses.get(k[1], {}).get('title', ''))):
        if pair[0] not in by_id or pair[1] not in courses:
            continue
        item, assignment = progress.get(pair), assignments.get(pair)
        if (start or end) and not any(in_range(t, start, end) for t in ((item or {}).get('startedAt'), (item or {}).get('completedAt'), (assignment or {}).get('assignedAt'))):
            continue
        person, c = by_id[pair[0]], courses[pair[1]]
        status = pair_status(item, assignment)
        rows.append({'employee': person['name'], 'email': person['email'], 'department': person['department'] or 'Unassigned', 'course': c['title'], 'category': c['category'],
                     'assigned': 'Yes' if assignment else 'No', 'mandatory': 'Yes' if assignment and assignment['mandatory'] else 'No', 'dueDate': (assignment or {}).get('dueDate') or '',
                     'progress': 100 if status == 'completed' else (item or {}).get('progress', 0), 'status': STATUS_LABELS[status], 'completedAt': ((item or {}).get('completedAt') or '')[:10]})
    done = sum(1 for r in rows if r['status'] == 'Completed')
    return ([('employee', 'Employee'), ('department', 'Department'), ('course', 'Course'), ('assigned', 'Assigned'), ('mandatory', 'Mandatory'), ('dueDate', 'Due'), ('progress', 'Progress %'), ('status', 'Status'), ('completedAt', 'Completed')],
            rows, {'Enrollments': len(rows), 'Completed': done, 'Completion rate': f'{round(done / len(rows) * 100) if rows else 0}%'})


def employee_summaries(db, people, ids, course_ids, start, end):
    progress, assignments = progress_index(db, ids, course_ids), assignment_index(db, ids, course_ids)
    seconds, scores = training_seconds(db, course_ids, start, end), assessment_scores(db, course_ids, start, end)
    runs = run_owners(db, course_ids, ids)
    certificates = {}
    for r in db['certificates'].find({'run_id': {'$in': list(runs)}}, ['run_id', 'issued_at']) if runs else []:
        if in_range(r['issued_at'], start, end):
            candidate = runs[r['run_id']]['candidate_id']
            certificates[candidate] = certificates.get(candidate, 0) + 1
    summaries = {e: {'enrolled': 0, 'completed': 0, 'in_progress': 0, 'overdue': 0, 'not_started': 0} for e in ids}
    for pair in set(progress) | set(assignments):
        if pair[0] in summaries:
            status = pair_status(progress.get(pair), assignments.get(pair))
            summaries[pair[0]]['enrolled'] += 1
            summaries[pair[0]][status] += 1
    for e in ids:
        summaries[e].update({'hours': round(seconds.get(e, 0) / 3600, 1), 'certificates': certificates.get(e, 0), 'scores': scores.get(e, [])})
    return summaries


def report_employees(db, people, ids, course_ids, start, end):
    summaries = employee_summaries(db, people, ids, course_ids, start, end)
    rows = []
    for person in people:
        s = summaries[person['id']]
        rows.append({'employee': person['name'], 'email': person['email'], 'department': person['department'] or 'Unassigned', 'jobRole': person['job_role'] or '',
                     'enrolled': s['enrolled'], 'completed': s['completed'], 'inProgress': s['in_progress'], 'overdue': s['overdue'], 'hours': s['hours'],
                     'certificates': s['certificates'], 'averageScore': average(s['scores']) if s['scores'] else ''})
    return ([('employee', 'Employee'), ('department', 'Department'), ('jobRole', 'Job role'), ('enrolled', 'Enrolled'), ('completed', 'Completed'), ('inProgress', 'In progress'), ('overdue', 'Overdue'),
             ('hours', 'Training hours'), ('certificates', 'Certificates'), ('averageScore', 'Avg. score %')], rows,
            {'Employees': len(rows), 'Training hours': round(sum(r['hours'] for r in rows), 1), 'With overdue training': sum(1 for r in rows if r['overdue'])})


def report_departments(db, people, ids, course_ids, start, end):
    summaries = employee_summaries(db, people, ids, course_ids, start, end)
    times = activity_times(db, course_ids)
    groups = {}
    for person in people:
        key = person['department'] or 'Unassigned'
        g = groups.setdefault(key, {'department': key, 'employees': 0, 'participants': 0, 'enrolled': 0, 'completed': 0, 'overdue': 0, 'hours': 0, 'scores': [], 'certificates': 0})
        s = summaries[person['id']]
        g['employees'] += 1
        g['participants'] += any(in_range(t, start, end) for t in times.get(person['id'], []))
        for field in ('enrolled', 'completed', 'overdue', 'hours', 'certificates'):
            g[field] += s[field]
        g['scores'] += s['scores']
    rows = [{'department': g['department'], 'employees': g['employees'], 'participants': g['participants'], 'participation': round(g['participants'] / g['employees'] * 100) if g['employees'] else 0,
             'enrolled': g['enrolled'], 'completed': g['completed'], 'completionRate': round(g['completed'] / g['enrolled'] * 100) if g['enrolled'] else 0, 'overdue': g['overdue'],
             'hours': round(g['hours'], 1), 'certificates': g['certificates'], 'averageScore': average(g['scores']) if g['scores'] else ''} for g in sorted(groups.values(), key=lambda g: g['department'])]
    return ([('department', 'Department'), ('employees', 'Employees'), ('participants', 'Active learners'), ('participation', 'Participation %'), ('enrolled', 'Enrollments'), ('completed', 'Completed'),
             ('completionRate', 'Completion %'), ('overdue', 'Overdue'), ('hours', 'Training hours'), ('certificates', 'Certificates'), ('averageScore', 'Avg. score %')], rows, {'Departments': len(rows)})


def report_assessments(db, people, ids, course_ids, start, end):
    by_id = {p['id']: p for p in people}
    rows = []
    runs = run_owners(db, course_ids, list(by_id))
    titles = names_by_id(db, 'courses', [r['course_id'] for r in runs.values()], 'title')
    exams = db['exam_attempts'].find({'status': {'$ne': 'in-progress'}, 'run_id': {'$in': list(runs)}}, ['run_id', 'set_index', 'attempt_number', 'score', 'status', 'finished_at', 'started_at']) if runs else []
    for x in exams:
        if runs[x['run_id']]['course_id'] not in titles:
            continue
        r = dict(x, candidate_id=runs[x['run_id']]['candidate_id'], title=titles[runs[x['run_id']]['course_id']])
        if r['candidate_id'] in by_id and in_range(r['finished_at'] or r['started_at'], start, end):
            rows.append({'employee': by_id[r['candidate_id']]['name'], 'department': by_id[r['candidate_id']]['department'] or 'Unassigned', 'assessment': f'{r["title"]}: Module {r["set_index"] + 1} exam',
                         'type': 'Module exam', 'attempt': r['attempt_number'], 'score': '' if r['score'] is None else r['score'] * 25, 'result': r['status'].capitalize(), 'date': (r['finished_at'] or r['started_at'])[:10]})
    kinds = {'pre': 'Pre-training', 'post': 'Post-training', 'knowledge': 'Knowledge check'}
    assessments = {a['id']: a for a in db['assessments'].find(ids_clause(course_ids, 'course_id'), ['id', 'title', 'kind'])}
    attempts = db['assessment_attempts'].find({'status': {'$ne': 'in-progress'}, 'employee_id': {'$in': list(by_id)}, **({} if course_ids is None else {'assessment_id': {'$in': list(assessments)}})},
                                              ['employee_id', 'assessment_id', 'attempt_number', 'percent', 'status', 'finished_at', 'started_at']) if by_id and assessments else []
    for t in attempts:
        if t['assessment_id'] not in assessments:
            continue
        r = dict(t, title=assessments[t['assessment_id']]['title'], kind=assessments[t['assessment_id']]['kind'])
        if r['employee_id'] in by_id and in_range(r['finished_at'] or r['started_at'], start, end):
            rows.append({'employee': by_id[r['employee_id']]['name'], 'department': by_id[r['employee_id']]['department'] or 'Unassigned', 'assessment': r['title'], 'type': kinds[r['kind']],
                         'attempt': r['attempt_number'], 'score': '' if r['percent'] is None else r['percent'], 'result': r['status'].capitalize(), 'date': (r['finished_at'] or r['started_at'])[:10]})
    rows.sort(key=lambda r: r['date'], reverse=True)
    graded = [r['score'] for r in rows if r['score'] != '']
    return ([('employee', 'Employee'), ('department', 'Department'), ('assessment', 'Assessment'), ('type', 'Type'), ('attempt', 'Attempt'), ('score', 'Score %'), ('result', 'Result'), ('date', 'Date')], rows,
            {'Attempts': len(rows), 'Pass rate': f'{round(sum(1 for r in rows if r["result"] == "Passed") / len(rows) * 100) if rows else 0}%', 'Average score': f'{average(graded) or 0}%'})


def report_compliance(db, people, ids, course_ids, start, end):
    progress, assignments = progress_index(db, ids, course_ids), assignment_index(db, ids, course_ids)
    courses, by_id = course_rows(db, course_ids), {p['id']: p for p in people}
    rows = []
    for pair, a in assignments.items():
        if not a['mandatory'] or pair[0] not in by_id or ((start or end) and not in_range(a['dueDate'], start, end)):
            continue
        status, item = pair_status(progress.get(pair), a), progress.get(pair)
        rows.append({'employee': by_id[pair[0]]['name'], 'department': by_id[pair[0]]['department'] or 'Unassigned', 'course': courses[pair[1]]['title'], 'dueDate': a['dueDate'] or '',
                     'status': 'Compliant' if status == 'completed' else 'Overdue' if status == 'overdue' else 'Pending', 'progress': 100 if status == 'completed' else (item or {}).get('progress', 0),
                     'completedAt': ((item or {}).get('completedAt') or '')[:10]})
    rows.sort(key=lambda r: (r['status'] != 'Overdue', r['dueDate'] or '9999', r['employee']))
    compliant = sum(1 for r in rows if r['status'] == 'Compliant')
    return ([('employee', 'Employee'), ('department', 'Department'), ('course', 'Mandatory course'), ('dueDate', 'Due'), ('progress', 'Progress %'), ('status', 'Status'), ('completedAt', 'Completed')], rows,
            {'Mandatory assignments': len(rows), 'Compliance': f'{round(compliant / len(rows) * 100) if rows else 0}%', 'Overdue': sum(1 for r in rows if r['status'] == 'Overdue')})


def report_certificates(db, people, ids, course_ids, start, end):
    by_id = {p['id']: p for p in people}
    runs = run_owners(db, course_ids, list(by_id))
    awards = [dict(x, candidate_id=runs[x['run_id']]['candidate_id']) for x in db['certificates'].find({'run_id': {'$in': list(runs)}}, sort='-issued_at')] if runs else []
    rows = [{'employee': by_id[r['candidate_id']]['name'], 'department': by_id[r['candidate_id']]['department'] or 'Unassigned', 'course': r['course_title'], 'issuedAt': r['issued_at'][:10], 'certificate': r['id']}
            for r in awards
            if r['candidate_id'] in by_id and in_range(r['issued_at'], start, end)]
    return ([('employee', 'Employee'), ('department', 'Department'), ('course', 'Course'), ('issuedAt', 'Issued'), ('certificate', 'Certificate ID')], rows, {'Certificates': len(rows)})
