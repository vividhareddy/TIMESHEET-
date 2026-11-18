"""Learning activity history: an append-only record of meaningful learning events.

Events are written by the server inside the learning workflows (never from browser-supplied timestamps). Logging is
best effort: an event is worked out with reads first and stored with one write that cannot fail, so it never blocks the
lesson, assessment or completion it describes. Each event has a dedupe key, so a retried request or a replayed submission
is stored once. Opening events (course and lesson opened or resumed) are additionally collapsed when repeated within a
short window.

What is NOT recorded: answers, answer keys, scores of individual questions, page dwell time, keystrokes or anything
else that would amount to monitoring. An opened course is access, not proof of learning, and analytics say so.
"""
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone

# Activity type -> (label shown to people, group used by filters and analytics).
TYPES = {
    'course_opened': ('Course opened', 'course'),
    'course_started': ('Course started', 'course'),
    'course_resumed': ('Course resumed', 'course'),
    'course_completed': ('Course completed', 'course'),
    'lesson_opened': ('Lesson opened', 'lesson'),
    'lesson_started': ('Lesson started', 'lesson'),
    'lesson_completed': ('Lesson completed', 'lesson'),
    'assessment_started': ('Assessment started', 'assessment'),
    'assessment_submitted': ('Assessment submitted', 'assessment'),
    'assessment_passed': ('Assessment passed', 'assessment'),
    'assessment_failed': ('Assessment failed', 'assessment'),
    'certificate_generated': ('Certificate generated', 'other'),
    'resource_accessed': ('Learning resource accessed', 'other'),
}
ACCESS_TYPES = ('course_opened', 'course_started', 'course_resumed')
ATTEMPT_TYPES = ('assessment_started', 'assessment_submitted')
RESULT_TYPES = ('assessment_passed', 'assessment_failed')
# Kinds of scored attempt that are reported as assessments.
ATTEMPT_KINDS = {'exam': 'Module exam', 'assignment': 'Course assignment', 'assessment': 'Assessment', 'quiz': 'Knowledge check'}
# Repeated opens of the same course or lesson within this window are one visit.
OPEN_WINDOW_SECONDS = 600
# Metadata is limited to these keys and to short scalar values.
META_KEYS = {'courseTitle', 'lessonTitle', 'assessmentTitle', 'resourceTitle', 'resourceKind', 'kind', 'attempt', 'attemptNumber',
             'score', 'total', 'percent', 'passPercent', 'result', 'certificateNumber', 'videoIndex', 'runNumber', 'backfilled'}
PAGE_SIZE = 20
STAFF_PAGE_SIZE = 25
# Tables whose rows show that a course run has progress.
PROGRESS_TABLES = ('lesson_progress', 'lesson_watch', 'video_progress', 'exercise_attempts', 'exam_attempts', 'checkpoint_attempts',
                   'lesson_quiz_attempts', 'lesson_activity_attempts')
# The highest code point: an ISO timestamp t has t[:10] <= day exactly when t <= day + DAY_END (a whole UTC day, inclusive).
DAY_END = '\U0010ffff'
_ASCII_LOWER = str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')


def _check(condition, message, status=400):
    if not condition:
        # Raised as the portal's APIError so the server answers with the right status code.
        from services import APIError
        raise APIError(status, message)


def stamp(moment=None):
    moment = moment or datetime.now(timezone.utc)
    return moment.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _clean(metadata):
    result = {}
    for key, value in (metadata or {}).items():
        if key not in META_KEYS or value is None:
            continue
        if isinstance(value, str):
            value = value[:200]
        elif not isinstance(value, (bool, int, float)):
            continue
        result[key] = value
    return result


# ---------------------------------------------------------------- writing

def record(db, employee, kind, key, *, course=None, lesson=None, assessment=None, run=None, metadata=None, at=None, window=None):
    """Store one activity event; returns True when a new row was written.

    `key` identifies the event for de-duplication (per employee). `window` (seconds) skips the event when an event of
    the same family for the same course and lesson was recorded that recently.

    MongoDB has no savepoints and a failed write aborts the whole transaction, so logging can no longer be undone on its
    own. Instead everything is read first and the event is stored with a single insert that cannot fail: links to removed
    rows are dropped (as before, rather than failing the foreign key), and insert_ignore checks the (employee, dedupe key)
    and id unique constraints before writing, so a repeated event is skipped exactly like INSERT OR IGNORE skipped it.
    """
    if kind not in TYPES:
        raise ValueError(f'Unknown learning activity type: {kind}')
    if employee is None:
        return False  # The NOT NULL employee column made this insert fail, and logging failures return False.
    logs = db['learning_activity_logs']
    moment = at or stamp()
    if window:
        family = ACCESS_TYPES if kind in ACCESS_TYPES else (kind,) if kind != 'lesson_opened' else ('lesson_opened', 'lesson_started')
        since = stamp(datetime.now(timezone.utc) - timedelta(seconds=window))
        # COALESCE(column,'')=value: a missing course or lesson matches NULL or ''.
        if logs.exists({'employee_id': employee, 'activity_type': {'$in': list(family)}, 'course_id': course or {'$in': [None, '']},
                        'lesson_id': lesson or {'$in': [None, '']}, 'activity_timestamp': {'$gte': since}}):
            return False
    details = _clean(metadata)
    # Titles are kept with the event so history still reads correctly after a course or lesson is renamed or removed.
    # Links to rows that no longer exist are dropped rather than failing the foreign key.
    if course:
        row = db['courses'].find_one({'id': course}, ['title'])
        if row and 'courseTitle' not in details:
            details['courseTitle'] = row['title']
        if row is None:
            course = None
    if lesson:
        row = db['course_lessons'].find_one({'id': lesson}, ['title'])
        if row and 'lessonTitle' not in details:
            details['lessonTitle'] = row['title']
        if row is None:
            lesson = None
    if assessment:
        row = db['assessments'].find_one({'id': assessment}, ['title'])
        if row and 'assessmentTitle' not in details:
            details['assessmentTitle'] = row['title']
        if row is None:
            assessment = None
    if run and not db['course_runs'].exists({'id': run}):
        run = None
    return logs.insert_ignore({'id': str(uuid.uuid4()), 'employee_id': employee, 'course_id': course, 'lesson_id': lesson, 'assessment_id': assessment,
                               'run_id': run, 'activity_type': kind, 'activity_timestamp': moment, 'metadata': json.dumps(details, separators=(',', ':')),
                               'dedupe_key': key or f'{kind}:{uuid.uuid4()}', 'created_at': stamp()})


def run_has_progress(db, run_id):
    # One round trip: every progress table is looked up from the run's own row.
    found = db['course_runs'].aggregate([{'$match': {'id': run_id}}, {'$limit': 1}, {'$project': {'_id': 1}}] + [
        {'$lookup': {'from': db.collection_name(table), 'pipeline': [{'$match': {'run_id': run_id}}, {'$limit': 1}, {'$project': {'_id': 1}}], 'as': table}}
        for table in PROGRESS_TABLES])
    if found:
        return any(found[0][table] for table in PROGRESS_TABLES)
    return any(db[table].exists({'run_id': run_id}) for table in PROGRESS_TABLES)


def course_opened(db, employee, run):
    """An employee opened a course page: the first open of a run starts it; later opens resume it or revisit it."""
    if not db['learning_activity_logs'].exists({'employee_id': employee, 'dedupe_key': f'course_started:{run["id"]}'}):
        return record(db, employee, 'course_started', f'course_started:{run["id"]}', course=run['course_id'], run=run['id'], metadata={'runNumber': run['run_number']})
    kind = 'course_resumed' if run['completed_at'] is None and run_has_progress(db, run['id']) else 'course_opened'
    return record(db, employee, kind, None, course=run['course_id'], run=run['id'], window=OPEN_WINDOW_SECONDS)


def lesson_opened(db, employee, run, lesson):
    key = f'lesson_started:{run["id"]}:{lesson["id"]}'
    if not db['learning_activity_logs'].exists({'employee_id': employee, 'dedupe_key': key}):
        return record(db, employee, 'lesson_started', key, course=run['course_id'], lesson=lesson['id'], run=run['id'])
    return record(db, employee, 'lesson_opened', None, course=run['course_id'], lesson=lesson['id'], run=run['id'], window=OPEN_WINDOW_SECONDS)


def lesson_completed(db, employee, run, lesson_id=None, video_index=None, title=None, at=None):
    target = lesson_id if lesson_id else f'video{video_index}'
    return record(db, employee, 'lesson_completed', f'lesson_completed:{run["id"]}:{target}', course=run['course_id'], lesson=lesson_id,
                  run=run['id'], metadata={'lessonTitle': title, 'videoIndex': video_index}, at=at)


def attempt_started(db, employee, kind, attempt_id, *, course=None, run=None, lesson=None, assessment=None, title=None, number=None, at=None, backfilled=None):
    return record(db, employee, 'assessment_started', f'assessment_started:{kind}:{attempt_id}', course=course, run=run, lesson=lesson, assessment=assessment,
                  metadata={'kind': kind, 'attempt': f'{kind}:{attempt_id}', 'assessmentTitle': title, 'attemptNumber': number, 'backfilled': backfilled}, at=at)


def attempt_finished(db, employee, kind, attempt_id, status, *, score=None, total=None, percent=None, pass_percent=None,
                     course=None, run=None, lesson=None, assessment=None, title=None, number=None, at=None, backfilled=None):
    """A submitted attempt: one 'submitted' event and one 'passed' or 'failed' event. Terminated or expired attempts were not submitted."""
    if status not in ('passed', 'failed'):
        return False
    details = {'kind': kind, 'attempt': f'{kind}:{attempt_id}', 'assessmentTitle': title, 'attemptNumber': number, 'score': score,
               'total': total, 'percent': percent, 'passPercent': pass_percent, 'result': status, 'backfilled': backfilled}
    refs = dict(course=course, run=run, lesson=lesson, assessment=assessment, at=at)
    submitted = record(db, employee, 'assessment_submitted', f'assessment_submitted:{kind}:{attempt_id}', metadata=details, **refs)
    record(db, employee, f'assessment_{status}', f'assessment_result:{kind}:{attempt_id}', metadata=details, **refs)
    return submitted


def course_completed(db, employee, run_id, at=None):
    run = db['course_runs'].find_one({'id': run_id})
    if run is None or not run['completed_at']:
        return False
    return record(db, employee, 'course_completed', f'course_completed:{run_id}', course=run['course_id'], run=run_id,
                  metadata={'runNumber': run['run_number']}, at=at or run['completed_at'])


def certificate_generated(db, employee, run_id):
    row = db['certificates'].find_one({'run_id': run_id}, ['certificate_number', 'issued_at', 'course_title'])
    run = db['course_runs'].find_one({'id': run_id}, ['course_id']) if row is not None else None
    if row is None or run is None:
        return False
    return record(db, employee, 'certificate_generated', f'certificate:{run_id}', course=run['course_id'], run=run_id,
                  metadata={'certificateNumber': row['certificate_number'], 'courseTitle': row['course_title']}, at=row['issued_at'])


def resource_accessed(db, employee, resource):
    return record(db, employee, 'resource_accessed', None, course=resource['course_id'],
                  metadata={'resourceTitle': resource['title'], 'resourceKind': resource['kind']}, window=60)


# ---------------------------------------------------------------- history from before activity logging existed

def _by_id(db, table, ids, projection=None):
    """Rows of a table by id, as {id: row}, in one query."""
    ids = [i for i in set(ids) if i is not None]
    return {r['id']: r for r in db[table].find({'id': {'$in': ids}}, projection)} if ids else {}


def backfill(db):
    """Create events for learning recorded before this log existed (marked as backfilled). Opens and resumes were never
    recorded, so they cannot be reconstructed. Safe to repeat: every event uses the same dedupe key as live logging.
    (Used when upgrading old SQLite databases; it is no longer run at startup.)"""
    meta = {'backfilled': True}
    progressed = set()
    for table in ('lesson_progress', 'video_progress', 'exercise_attempts', 'exam_attempts', 'checkpoint_attempts', 'lesson_watch', 'lesson_quiz_attempts'):
        progressed.update(db[table].distinct('run_id'))
    for r in db['course_runs'].find({'$or': [{'id': {'$in': [i for i in progressed if i is not None]}}, {'completed_at': {'$ne': None}}]}):
        record(db, r['candidate_id'], 'course_started', f'course_started:{r["id"]}', course=r['course_id'], run=r['id'],
               metadata={**meta, 'runNumber': r['run_number']}, at=r['started_at'])
        if r['completed_at']:
            record(db, r['candidate_id'], 'course_completed', f'course_completed:{r["id"]}', course=r['course_id'], run=r['id'],
                   metadata={**meta, 'runNumber': r['run_number']}, at=r['completed_at'])

    def joined_runs(rows):
        """(row, its course run) for rows whose run exists (an inner join on course_runs)."""
        runs = _by_id(db, 'course_runs', [r['run_id'] for r in rows], ['id', 'candidate_id', 'course_id'])
        return [(r, runs[r['run_id']]) for r in rows if r['run_id'] in runs]

    for r, run in joined_runs(db['certificates'].find()):
        record(db, run['candidate_id'], 'certificate_generated', f'certificate:{r["run_id"]}', course=run['course_id'], run=r['run_id'],
               metadata={**meta, 'certificateNumber': r['certificate_number'], 'courseTitle': r['course_title']}, at=r['issued_at'])
    for r, run in joined_runs(db['lesson_progress'].find()):
        record(db, run['candidate_id'], 'lesson_completed', f'lesson_completed:{r["run_id"]}:{r["lesson_id"]}', course=run['course_id'],
               lesson=r['lesson_id'], run=r['run_id'], metadata=meta, at=r['completed_at'])
    videos = joined_runs(db['video_progress'].find({'completed_at': {'$ne': None}}))
    courses = _by_id(db, 'courses', [run['course_id'] for _, run in videos], ['id', 'lessons_json'])
    titles = {}
    for r, run in videos:
        if run['course_id'] not in titles:
            row = courses.get(run['course_id'])
            try:
                titles[run['course_id']] = [item.get('title') for item in json.loads(row['lessons_json'])] if row else []
            except (ValueError, AttributeError):
                titles[run['course_id']] = []
        names = titles[run['course_id']]
        title = names[r['video_index']] if r['video_index'] < len(names) else None
        record(db, run['candidate_id'], 'lesson_completed', f'lesson_completed:{r["run_id"]}:video{r["video_index"]}', course=run['course_id'],
               run=r['run_id'], metadata={**meta, 'lessonTitle': title, 'videoIndex': r['video_index']}, at=r['completed_at'])
    exams = joined_runs(db['exam_attempts'].find())
    courses = _by_id(db, 'courses', [run['course_id'] for _, run in exams], ['id', 'pass_percent'])
    for r, run in exams:
        if run['course_id'] not in courses:
            continue
        title = f'Module {r["set_index"] + 1} exam'
        refs = dict(course=run['course_id'], run=r['run_id'], title=title, number=r['attempt_number'])
        attempt_started(db, run['candidate_id'], 'exam', r['id'], at=r['started_at'], backfilled=True, **refs)
        if r['status'] in ('passed', 'failed') and r['score'] is not None:
            attempt_finished(db, run['candidate_id'], 'exam', r['id'], r['status'], score=r['score'], total=4, percent=r['score'] * 25,
                             pass_percent=courses[run['course_id']]['pass_percent'], at=r['finished_at'], backfilled=True, **refs)
    checks = joined_runs(db['checkpoint_attempts'].find())
    checkpoints = _by_id(db, 'course_checkpoints', [r['checkpoint_id'] for r, _ in checks], ['id', 'title', 'pass_percent'])
    for r, run in checks:
        c = checkpoints.get(r['checkpoint_id'])
        if c is None:
            continue
        refs = dict(course=run['course_id'], run=r['run_id'], title=c['title'], number=r['attempt_number'])
        attempt_started(db, run['candidate_id'], 'assignment', r['id'], at=r['started_at'], backfilled=True, **refs)
        if r['status'] in ('passed', 'failed') and r['score'] is not None:
            attempt_finished(db, run['candidate_id'], 'assignment', r['id'], r['status'], score=r['score'], total=r['total'],
                             percent=round(r['score'] * 100 / r['total']) if r['total'] else None, pass_percent=c['pass_percent'], at=r['finished_at'], backfilled=True, **refs)
    attempts = db['assessment_attempts'].find()
    assessments = _by_id(db, 'assessments', [r['assessment_id'] for r in attempts], ['id', 'title', 'course_id', 'pass_percent'])
    for r in attempts:
        a = assessments.get(r['assessment_id'])
        if a is None:
            continue
        refs = dict(course=a['course_id'], assessment=r['assessment_id'], title=a['title'], number=r['attempt_number'])
        attempt_started(db, r['employee_id'], 'assessment', r['id'], at=r['started_at'], backfilled=True, **refs)
        if r['status'] in ('passed', 'failed'):
            attempt_finished(db, r['employee_id'], 'assessment', r['id'], r['status'], score=r['score'], total=r['total'], percent=r['percent'],
                             pass_percent=a['pass_percent'], at=r['finished_at'], backfilled=True, **refs)
    quizzes = joined_runs(db['lesson_quiz_attempts'].find())
    lessons = _by_id(db, 'course_lessons', [r['lesson_id'] for r, _ in quizzes], ['id', 'title', 'quiz_json'])
    for r, run in quizzes:
        lesson = lessons.get(r['lesson_id'])
        if lesson is None:
            continue
        try:
            total = len(json.loads(lesson['quiz_json'])) if lesson['quiz_json'] else 0
        except ValueError:
            total = 0
        if total:
            attempt_finished(db, run['candidate_id'], 'quiz', r['id'], 'passed' if r['score'] >= total else 'failed', score=r['score'], total=total,
                             percent=round(r['score'] * 100 / total), pass_percent=100, course=run['course_id'], run=r['run_id'], lesson=r['lesson_id'],
                             title=f'{lesson["title"]} knowledge check', at=r['submitted_at'], backfilled=True)


# ---------------------------------------------------------------- reading

def _one(query, field, maximum=100):
    value = (query.get(field, [''])[0] or '').strip()
    _check(len(value) <= maximum, f'{field} is too long.')
    return value or None


def _date(query, field):
    value = _one(query, field, 10)
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        _check(False, f'{field} must be a date in YYYY-MM-DD format.')


def _page(query):
    try:
        return max(1, min(100000, int(query.get('page', ['1'])[0])))
    except ValueError:
        _check(False, 'page must be a whole number.')


def filters(query):
    """Validated history filters shared by the employee and staff views."""
    kind = _one(query, 'type', 40)
    _check(kind is None or kind in TYPES or kind in ('course', 'lesson', 'assessment', 'other'), 'Unknown activity type.')
    start, end = _date(query, 'from'), _date(query, 'to')
    _check(not (start and end) or start <= end, 'The start date must be on or before the end date.')
    return {'course': _one(query, 'course'), 'type': kind, 'from': start, 'to': end, 'page': _page(query)}


def _where(f):
    """The history filters as a query on learning_activity_logs."""
    where = {}
    if f.get('course'):
        where['course_id'] = f['course']
    if f.get('type') in TYPES:
        where['activity_type'] = f['type']
    elif f.get('type'):
        where['activity_type'] = {'$in': [k for k, (_, group) in TYPES.items() if group == f['type']]}
    period = {}
    if f.get('from'):
        period['$gte'] = f['from']
    if f.get('to'):
        # Dates are whole UTC days; the end date is inclusive.
        period['$lte'] = f['to'] + DAY_END
    if period:
        where['activity_timestamp'] = period
    return where


def view(row):
    """One event as shown in timelines and tables. Removed courses or lessons fall back to the titles stored with the event."""
    meta = json.loads(row['metadata'] or '{}')
    kind = row['activity_type']
    course = row['course_title'] if 'course_title' in row.keys() and row['course_title'] else meta.get('courseTitle')
    lesson = row['lesson_title'] if 'lesson_title' in row.keys() and row['lesson_title'] else meta.get('lessonTitle')
    subject = meta.get('assessmentTitle') or meta.get('resourceTitle') or lesson or course or 'Removed course'
    status, detail = None, ''
    if kind in RESULT_TYPES:
        status = 'passed' if kind == 'assessment_passed' else 'failed'
        if meta.get('percent') is not None:
            detail = f"{meta['percent']}%" + (f" · pass mark {meta['passPercent']}%" if meta.get('passPercent') is not None else '')
    elif kind == 'assessment_submitted':
        status = 'submitted'
        detail = f"Attempt {meta['attemptNumber']}" if meta.get('attemptNumber') else ''
    elif kind == 'assessment_started':
        status = 'started'
        detail = f"Attempt {meta['attemptNumber']}" if meta.get('attemptNumber') else ''
    elif kind in ('course_completed', 'lesson_completed'):
        status = 'completed'
    elif kind == 'certificate_generated':
        status = 'issued'
        detail = f"Certificate {meta['certificateNumber']}" if meta.get('certificateNumber') else ''
    elif kind == 'resource_accessed':
        detail = (meta.get('resourceKind') or '').capitalize()
    elif kind in ('course_started', 'lesson_started', 'course_resumed'):
        status = 'in_progress'
    if meta.get('kind') in ATTEMPT_KINDS and kind in ATTEMPT_TYPES + RESULT_TYPES:
        detail = ATTEMPT_KINDS[meta['kind']] + (f' · {detail}' if detail else '')
    return {'id': row['id'], 'type': kind, 'label': TYPES[kind][0], 'group': TYPES[kind][1], 'at': row['activity_timestamp'],
            'courseId': row['course_id'], 'course': course or 'Removed course', 'lesson': lesson, 'subject': subject, 'status': status,
            'detail': detail, 'percent': meta.get('percent'), 'backfilled': bool(meta.get('backfilled'))}


# ---------------------------------------------------------------- SQL semantics kept in Python

def _coalesce(*values):
    return next((v for v in values if v is not None), None)


def _sql_order(value):
    """Sort key matching SQLite's ordering of mixed values: NULL, then numbers, then text (binary)."""
    if value is None:
        return (0, 0)
    if isinstance(value, (bool, int, float)):
        return (1, value)
    return (2, value)


def _nocase(value):
    """SQLite's NOCASE collation: ASCII letters compare without case."""
    return value.translate(_ASCII_LOWER) if isinstance(value, str) else value


def _json(text, key):
    """json_extract(text, '$.key') for an event's metadata object."""
    if text is None:
        return None
    value = json.loads(text)
    return value.get(key) if isinstance(value, dict) else None


def _groups(rows, key):
    """GROUP BY: [(key, rows)] in SQLite's group order (ascending key)."""
    found = {}
    for r in rows:
        found.setdefault(key(r), []).append(r)
    return [(k, found[k]) for k in sorted(found, key=lambda k: tuple(_sql_order(v) for v in k))]


def _weekday(text):
    """strftime('%w', timestamp) as an integer (0 = Sunday), or None for a value SQLite cannot read as a date."""
    match = re.fullmatch(r'\s*(\d{4}-\d\d-\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d*)?)?)?\s*(?:([zZ])|([+-])(\d\d):?(\d\d))?\s*', text or '')
    if not match:
        return None
    try:
        moment = datetime.fromisoformat(match.group(1)).replace(hour=int(match.group(2) or 0), minute=int(match.group(3) or 0), second=int(match.group(4) or 0))
    except ValueError:
        return None
    if match.group(6):
        offset = timedelta(hours=int(match.group(7)), minutes=int(match.group(8)))
        moment = moment - offset if match.group(6) == '+' else moment + offset
    return (moment.weekday() + 1) % 7


def _with_titles(db, rows):
    """LEFT JOIN courses and course_lessons: each event gets course_title and lesson_title (None when removed)."""
    courses = {r['id']: r['title'] for r in _by_id(db, 'courses', [r['course_id'] for r in rows], ['id', 'title']).values()}
    lessons = {r['id']: r['title'] for r in _by_id(db, 'course_lessons', [r['lesson_id'] for r in rows], ['id', 'title']).values()}
    for r in rows:
        r['course_title'], r['lesson_title'] = courses.get(r['course_id']), lessons.get(r['lesson_id'])
    return rows


def timeline(db, employee, query, size=PAGE_SIZE):
    f = filters(query)
    logs = db['learning_activity_logs']
    where = {'employee_id': employee, **_where(f)}
    total = logs.count(where)
    pages = max(1, -(-total // size))
    page = min(f['page'], pages)
    rows = _with_titles(db, logs.find(where, sort=['-activity_timestamp', '-created_at'], limit=size, skip=(page - 1) * size))
    # Every course in the employee's history: its current title, else the title stored with the latest event (MAX(metadata)).
    groups = logs.aggregate([{'$match': {'employee_id': employee, 'course_id': {'$ne': None}}},
                             {'$group': {'_id': '$course_id', 'metadata': {'$max': '$metadata'}}}])
    titles = {r['id']: r['title'] for r in _by_id(db, 'courses', [g['_id'] for g in groups], ['id', 'title']).values()}
    named = [(g['_id'], _coalesce(titles.get(g['_id']), _json(g['metadata'], 'courseTitle'))) for g in sorted(groups, key=lambda g: _sql_order(g['_id']))]
    named.sort(key=lambda c: _sql_order(c[1]))
    courses = [{'id': i, 'title': t or 'Removed course'} for i, t in named]
    return {'items': [view(r) for r in rows], 'page': page, 'pages': pages, 'total': total,
            'filters': {k: f[k] for k in ('course', 'type', 'from', 'to')}, 'courses': courses,
            'types': [[k, label] for k, (label, _) in TYPES.items()]}


def my_activity(db, user, query):
    """The signed-in employee's own history. The employee comes from the session; no employee parameter is accepted."""
    return timeline(db, user['id'], query)


# ---------------------------------------------------------------- HR, admin and manager views

def activity_scope(db, user):
    """Employee ids the user may see (None = everyone). HR and admins see the organisation; managers their active direct reports."""
    if user['role'] in ('admin', 'hr'):
        return None
    _check(user['role'] == 'manager', 'You do not have permission to view learning activity.', 403)
    return [r['id'] for r in db['candidates'].find({'manager_id': user['id'], 'is_active': 1}, ['id'])]


def _people(db, scope, department=None, job_role=None, employee=None, active_only=False, name=None):
    """Employees (not administrators) in scope matching the filters, in stored order.

    The candidates collection compares text case-insensitively, so ids typed into filters are matched exactly in Python too.
    `name` is a substring of the full name, matched like SQLite LIKE (ASCII letters without case, wildcards literal)."""
    where = [{'role': {'$ne': 'admin'}}]
    if scope is not None:
        where.append({'id': {'$in': list(scope)}})
    if active_only:
        where.append({'is_active': 1})
    for column, value in (('department_id', department), ('job_role_id', job_role), ('id', employee)):
        if value:
            where.append({column: value})
    if name:
        where.append({'full_name': {'$regex': ''.join(f'[{c.lower()}{c.upper()}]' if c.isascii() and c.isalpha() else re.escape(c) for c in name)}})
    # In SQLite's scan order (ties in later sorts keep it): by id when looked up from a scope list, else as stored.
    rows = db['candidates'].find({'$and': where}, ['id', 'full_name', 'keka_employee_number', 'role', 'is_active', 'department_id', 'job_role_id'],
                                 sort=[('$natural', 1)])
    if scope is not None:
        rows.sort(key=lambda r: r['id'])
    return [r for r in rows if all(not value or r[column] == value for column, value in (('department_id', department), ('job_role_id', job_role), ('id', employee)))]


def _staff_filters(db, user, query):
    scope = activity_scope(db, user)
    f = filters(query)
    f.update(employee=_one(query, 'employee'), department=_one(query, 'department'), jobRole=_one(query, 'jobRole'), q=_one(query, 'q', 80))
    if f['employee'] and scope is not None:
        _check(f['employee'] in scope, 'You can view learning activity only for employees you manage.', 403)
    return scope, f


def _names(db, table, ids):
    return {r['id']: r['name'] for r in _by_id(db, table, ids, ['id', 'name']).values()}


def _options(db, scope):
    people = [{'id': r['id'], 'name': r['full_name']} for r in sorted(_people(db, scope), key=lambda r: _sql_order(r['full_name']))]
    courses = [{'id': r['id'], 'title': r['title']} for r in db['courses'].find({}, ['id', 'title'], sort='title')]
    # Department and job role names were NOCASE columns, so they sort without regard to ASCII case.
    by_name = lambda table: [{'id': r['id'], 'name': r['name']} for r in sorted(db[table].find({}, ['id', 'name']), key=lambda r: _sql_order(_nocase(r['name'])))]
    return {'employees': people, 'courses': courses, 'types': [[k, label] for k, (label, _) in TYPES.items()],
            'departments': by_name('departments'), 'jobRoles': by_name('job_roles')}


def staff_activity(db, user, query):
    """Organisation (or team) activity table with summary metrics; every figure is counted from activity rows."""
    from analytics import progress_index
    scope, f = _staff_filters(db, user, query)
    # Employee name search; LIKE wildcards typed by the user are matched literally.
    people = {r['id']: r for r in _people(db, scope, f['department'], f['jobRole'], f['employee'], name=f['q'])}
    logs = db['learning_activity_logs']
    where = {'employee_id': {'$in': list(people)}, **_where(f)}
    # Summary counts from one grouped read; metadata is kept only for attempts, whose attempt id is inside it.
    total = lessons = completions = 0
    employees, courses, attempts = set(), set(), set()
    for g in logs.aggregate([{'$match': where}, {'$group': {'_id': {'e': '$employee_id', 'c': '$course_id', 't': '$activity_type',
                             'm': {'$cond': [{'$in': ['$activity_type', list(ATTEMPT_TYPES)]}, '$metadata', None]}}, 'n': {'$sum': 1}}}]):
        key, n = g['_id'], g['n']
        total += n
        employees.add(key.get('e'))
        if key.get('t') in ACCESS_TYPES and key.get('c') is not None:
            courses.add(key['c'])
        if key.get('t') == 'lesson_completed':
            lessons += n
        if key.get('t') == 'course_completed':
            completions += n
        if key.get('t') in ATTEMPT_TYPES:
            attempt = _json(key.get('m'), 'attempt')
            if attempt is not None:
                attempts.add(attempt)
    summary = {'totalActivities': total, 'activeLearners': len(employees), 'coursesAccessed': len(courses), 'lessonsCompleted': lessons,
               'assessmentsAttempted': len(attempts), 'coursesCompleted': completions}
    pages = max(1, -(-total // STAFF_PAGE_SIZE))
    page = min(f['page'], pages)
    rows = _with_titles(db, logs.find(where, sort=['-activity_timestamp', '-created_at'], limit=STAFF_PAGE_SIZE, skip=(page - 1) * STAFF_PAGE_SIZE) if people else [])
    departments = _names(db, 'departments', [people[r['employee_id']]['department_id'] for r in rows])
    roles = _names(db, 'job_roles', [people[r['employee_id']]['job_role_id'] for r in rows])
    progress = progress_index(db, list({r['employee_id'] for r in rows}), list({r['course_id'] for r in rows if r['course_id']})) if rows else {}
    items = []
    for r in rows:
        person = people[r['employee_id']]
        item = view(r)
        p = progress.get((r['employee_id'], r['course_id']))
        item.update(employeeId=r['employee_id'], employeeNumber=person['keka_employee_number'] or '', employee=person['full_name'],
                    department=departments.get(person['department_id']) or '', jobRole=roles.get(person['job_role_id']) or '',
                    progress=(100 if p['completed'] else p['progress']) if p else None)
        items.append(item)
    return {'summary': summary, 'items': items, 'page': page, 'pages': pages, 'total': total, 'scope': 'organisation' if scope is None else 'team',
            'filters': {k: f[k] for k in ('course', 'type', 'from', 'to', 'employee', 'department', 'jobRole', 'q')}, 'options': _options(db, scope)}


def employee_activity(db, user, employee_id, query):
    """One employee's full history for HR, admins, or that employee's manager."""
    scope = activity_scope(db, user)
    _check(scope is None or employee_id in scope, 'You can view learning activity only for employees you manage.', 403)
    row = db['candidates'].find_one({'id': employee_id}, ['id', 'full_name', 'keka_employee_number', 'role', 'department_id', 'job_role_id'])
    if row is not None and row['id'] != employee_id:
        row = None  # Ids are matched exactly, although the collection compares text without case.
    _check(row is not None and row['role'] != 'admin', 'Employee was not found.', 404)
    department = _names(db, 'departments', [row['department_id']]).get(row['department_id'])
    job_role = _names(db, 'job_roles', [row['job_role_id']]).get(row['job_role_id'])
    return {'employee': {'id': row['id'], 'name': row['full_name'], 'employeeNumber': row['keka_employee_number'] or '',
                         'department': department or '', 'jobRole': job_role or ''}, **timeline(db, employee_id, query)}


def _rate(part, whole):
    return round(part * 100 / whole) if whole else None


def analytics(db, user, query):
    """Aggregates over recorded events in a stated period. Access is counted separately from completion; nothing here
    measures study time, productivity or attendance."""
    scope = activity_scope(db, user)
    today = datetime.now(timezone.utc).date()
    end = _date(query, 'to') or today.isoformat()
    start = _date(query, 'from') or (date.fromisoformat(end) - timedelta(days=89)).isoformat()
    _check(start <= end, 'The start date must be on or before the end date.')
    try:
        inactive_days = int(query.get('inactiveDays', ['30'])[0])
    except ValueError:
        inactive_days = 0
    _check(7 <= inactive_days <= 365, 'inactiveDays must be between 7 and 365.')
    department = _one(query, 'department')
    people = {r['id']: r for r in _people(db, scope, department)}
    logs = db['learning_activity_logs']
    # Every event in the period for these employees, read once; the figures below are counted from it as the SQL queries did.
    rows = logs.find({'employee_id': {'$in': list(people)}, 'activity_timestamp': {'$gte': start, '$lte': end + DAY_END}},
                     ['employee_id', 'course_id', 'lesson_id', 'assessment_id', 'activity_type', 'activity_timestamp', 'metadata']) if people else []
    titles = {r['id']: r['title'] for r in _by_id(db, 'courses', [r['course_id'] for r in rows], ['id', 'title']).values()}

    def title(course_id, group):
        # COALESCE(course title, courseTitle of MAX(metadata), 'Removed course')
        latest = max((r['metadata'] for r in group if r['metadata'] is not None), default=None)
        return _coalesce(titles.get(course_id), _json(latest, 'courseTitle'), 'Removed course')

    by_course = lambda types: _groups([r for r in rows if r['activity_type'] in types and r['course_id'] is not None], lambda r: (r['course_id'],))
    learners = lambda group, types=None: {r['employee_id'] for r in group if types is None or r['activity_type'] in types}

    access = by_course(ACCESS_TYPES)
    # Ties keep SQLite's order: group order for the two-key sorts of one-column groups, reversed for the others.
    accessed = sorted(({'courseId': k[0], 'course': title(k[0], g), 'learners': len(learners(g)), 'visits': len(g)} for k, g in access),
                      key=lambda a: (-a['learners'], -a['visits']))[:10]
    completed = sorted(({'courseId': k[0], 'course': title(k[0], g), 'learners': len(learners(g))} for k, g in reversed(by_course(('course_completed',)))),
                       key=lambda a: -a['learners'])[:10]

    # Abandonment: of the learners who started a course in the period, those who have not completed it and have had no
    # activity in that course for `inactive_days`. Starters still active recently are counted as in progress, not abandoned.
    cutoff = stamp(datetime.now(timezone.utc) - timedelta(days=inactive_days))
    starts = by_course(('course_started',))
    done, recent = set(), set()
    if starts:
        for r in logs.find({'employee_id': {'$in': list({r['employee_id'] for _, g in starts for r in g})}, 'course_id': {'$in': [k[0] for k, _ in starts]},
                            '$or': [{'activity_type': 'course_completed'}, {'activity_timestamp': {'$gte': cutoff}}]},
                           ['employee_id', 'course_id', 'activity_type', 'activity_timestamp']):
            if r['activity_type'] == 'course_completed':
                done.add((r['employee_id'], r['course_id']))
            if r['activity_timestamp'] >= cutoff:
                recent.add((r['employee_id'], r['course_id']))
    abandonment = []
    for (course,), g in starts:
        starters = learners(g)
        finished = sum((e, course) in done for e in starters)
        abandoned = sum((e, course) not in done and (e, course) not in recent for e in starters)
        abandonment.append({'courseId': course, 'course': title(course, g), 'started': len(starters), 'completed': finished, 'abandoned': abandoned,
                            'inProgress': len(starters) - finished - abandoned, 'rate': _rate(abandoned, len(starters))})
    abandonment.sort(key=lambda a: (-(a['rate'] or 0), -a['started']))

    lesson_rows = [r for r in rows if r['activity_type'] in ('lesson_started', 'lesson_completed')]
    lesson_titles = {r['id']: r['title'] for r in _by_id(db, 'course_lessons', [r['lesson_id'] for r in lesson_rows], ['id', 'title']).values()}
    lessons = []
    for (course, _), g in _groups(lesson_rows, lambda r: (r['course_id'], _coalesce(r['lesson_id'], _json(r['metadata'], 'videoIndex')))):
        latest = max((r['metadata'] for r in g if r['metadata'] is not None), default=None)
        name = _coalesce(max((lesson_titles[r['lesson_id']] for r in g if lesson_titles.get(r['lesson_id']) is not None), default=None), _json(latest, 'lessonTitle'))
        began, finished = len(learners(g, ('lesson_started',))), len(learners(g, ('lesson_completed',)))
        lessons.append({'course': title(course, g), 'lesson': name or 'Lesson', 'started': began, 'completed': finished, 'rate': _rate(finished, began) if began else None})
    lessons = sorted(reversed(lessons), key=lambda r: (-r['started'], -r['completed']))[:15]
    weekdays = [0] * 7
    for day, g in _groups([r for r in rows if r['activity_type'] == 'lesson_completed'], lambda r: (_weekday(r['activity_timestamp']),)):
        weekdays[day[0]] = len(g)

    # Attempt rate per course: of the learners who accessed the course in the period, how many started or submitted one of its assessments.
    tried = {(r['employee_id'], r['course_id']) for r in rows if r['activity_type'] in ATTEMPT_TYPES}
    attempts = sorted(({'courseId': k[0], 'course': title(k[0], g), 'accessed': len(learners(g)), 'attempted': sum((e, k[0]) in tried for e in learners(g)),
                        'rate': _rate(sum((e, k[0]) in tried for e in learners(g)), len(learners(g)))} for k, g in reversed(access)), key=lambda a: -a['accessed'])[:15]
    # Results stay in group order: the former ORDER BY 4+5 was a constant expression, so it never reordered the groups.
    results = [{'assessment': k[3] or 'Assessment', 'kind': ATTEMPT_KINDS.get(k[2], 'Assessment'), 'course': title(k[1], g),
                'passed': sum(r['activity_type'] == 'assessment_passed' for r in g), 'failed': sum(r['activity_type'] == 'assessment_failed' for r in g),
                'passRate': _rate(sum(r['activity_type'] == 'assessment_passed' for r in g), len(g))}
               for k, g in _groups([r for r in rows if r['activity_type'] in RESULT_TYPES],
                                   lambda r: (_coalesce(r['assessment_id'], ''), r['course_id'], _json(r['metadata'], 'kind'), _json(r['metadata'], 'assessmentTitle')))[:20]]

    active = [p for p in people.values() if p['is_active'] == 1]
    names = _names(db, 'departments', [p['department_id'] for p in active])
    last = {g['_id']: g['last'] for g in logs.aggregate([{'$match': {'employee_id': {'$in': [p['id'] for p in active]}}},
                                                         {'$group': {'_id': '$employee_id', 'last': {'$max': '$activity_timestamp'}}}])} if active else {}
    quiet_cutoff = stamp(datetime.now(timezone.utc) - timedelta(days=inactive_days))
    quiet_rows = sorted(active, key=lambda p: (last.get(p['id']) is not None, _sql_order(last.get(p['id'])), _sql_order(p['full_name'])))
    quiet = [{'employeeId': p['id'], 'employee': p['full_name'], 'department': names.get(p['department_id']) or '', 'lastActivity': last.get(p['id'])}
             for p in quiet_rows if not last.get(p['id']) or last[p['id']] < quiet_cutoff]

    period_rows = {}
    for r in rows:
        period_rows.setdefault(r['employee_id'], []).append(r)
    departments = []
    for (identity,), group in _groups(active, lambda p: (p['department_id'] if p['department_id'] in names else None,)):
        events = [r for p in group for r in period_rows.get(p['id'], [])]
        count = lambda kind: sum(r['activity_type'] == kind for r in events)
        engaged = sum(p['id'] in period_rows for p in group)
        departments.append({'department': _coalesce(names.get(identity), 'No department'), 'employees': len(group), 'activeLearners': engaged,
                            'engagementRate': _rate(engaged, len(group)), 'lessonsCompleted': count('lesson_completed'), 'coursesCompleted': count('course_completed'),
                            'assessmentsSubmitted': count('assessment_submitted')})
    departments.sort(key=lambda d: d['department'])
    return {'period': {'from': start, 'to': end, 'inactiveDays': inactive_days, 'department': department}, 'scope': 'organisation' if scope is None else 'team',
            'mostAccessed': accessed, 'mostCompleted': completed, 'abandonment': abandonment[:10], 'lessonPatterns': lessons, 'completionsByWeekday': weekdays,
            'attemptRates': attempts, 'assessmentResults': results, 'inactive': quiet[:50], 'inactiveTotal': len(quiet), 'departments': departments,
            'definitions': {
                'access': 'Course opened, started or resumed. Access is not evidence of learning.',
                'abandonment': f'Started in the period, not completed, and no activity in that course for {inactive_days} days. Share of learners who started.',
                'attemptRate': 'Of the learners who accessed a course in the period, the share who started or submitted one of its assessments.',
                'passRate': 'Passed attempts divided by submitted attempts. Terminated and expired attempts were not submitted and are excluded.',
                'engagement': 'Active employees with at least one recorded learning activity in the period. Activity volume is not a measure of productivity.',
                'dates': 'Dates are whole days in UTC; both ends of the period are included.'},
            'options': _options(db, scope)}
