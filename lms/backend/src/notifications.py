"""Notification events and scoped reminders. No email or external delivery."""
from services import batch_read, notify, now, text, check, uid


def observers(db, employee, course=None):
    """Only administrators, HR, and the employee's direct manager receive records."""
    # Two indexed lookups (active admins/HR together with the employee, then the employee's manager) instead of scanning every account.
    rows = db['candidates'].find({'$or': [{'role': {'$in': ['admin', 'hr']}, 'is_active': 1}, {'id': employee}]}, ['id', 'role', 'is_active', 'manager_id'])
    ids = {r['id'] for r in rows if r['role'] in ('admin', 'hr') and r['is_active'] == 1 and r['id'] != employee}
    me = next((r for r in rows if r['id'] == employee), None)
    if me is not None and me['manager_id']:
        manager = db['candidates'].find_one({'id': me['manager_id'], 'is_active': 1}, ['id', 'role'])
        if manager is not None and manager['role'] == 'manager' and manager['id'] != employee:
            ids.add(manager['id'])
    return sorted(ids)  # UNION returned the ids sorted and without duplicates.


def staff_event(db, employee, title, body, key):
    notify(db, observers(db, employee), 'team', title, body, 'reports', key)


def refresh(db, user):
    employee = user['id']
    # The employee's assessment attempts and open course runs are read together, then the assessments and courses they use.
    first = batch_read(db, attempts=('assessment_attempts', {'employee_id': employee}, None, ['id', 'assessment_id', 'status']),
                       runs=('course_runs', {'candidate_id': employee, 'archived_at': None}))
    tries = {}
    for t in first['attempts']:
        tries.setdefault(t['assessment_id'], []).append(t)
    second = batch_read(db, assessments=('assessments', {'id': {'$in': list(tries)}, 'status': 'published'}, 'id', ['id', 'title', 'max_attempts']),
                        courses=('courses', {'id': {'$in': list({r['course_id'] for r in first['runs']})}, 'status': 'published', 'format': 'modules'}, None, ['id', 'title', 'max_attempts']))
    name = None

    def full_name():
        return db['candidates'].get(employee, ['full_name'])['full_name']
    for a in second['assessments']:
        attempts = tries[a['id']]
        if any(t['status'] in ('passed', 'in-progress') for t in attempts):
            continue
        used = len(attempts)
        left = max(0, a['max_attempts'] - used)
        notify(db, [employee], 'assessment', f'{left} assessment attempts remaining', a['title'], 'assessments', f'assessment-left:{a["id"]}:{used}')
        if not left:
            name = name or full_name()
            staff_event(db, employee, f'Assessment attempts exhausted: {name}', a['title'], f'assessment-exhausted:{employee}:{a["id"]}:{used}')
    # Module exams exist only in 3-module courses (lesson courses cannot record videos, exercises or exams), so only those
    # runs are checked, with their exam, video and exercise records read in one batched query instead of several per module.
    courses = {c['id']: c for c in second['courses']}
    runs = [{**r, 'title': courses[r['course_id']]['title'], 'max_attempts': courses[r['course_id']]['max_attempts']} for r in first['runs'] if r['course_id'] in courses]
    if runs:
        within = {'run_id': {'$in': [run['id'] for run in runs]}}
        found = batch_read(db, exams=('exam_attempts', within, ['run_id', 'set_index', 'attempt_number']),
                           videos=('video_progress', {**within, 'completed_at': {'$ne': None}}, None, ['run_id', 'video_index']),
                           exercises=('exercise_attempts', {**within, 'passed': 1}, None, ['run_id', 'set_index', 'exercise_index']))
        exams, videos, exercises = {}, {}, {}
        for attempt in found['exams']:
            exams.setdefault((attempt['run_id'], attempt['set_index']), []).append(attempt)
        for r in found['videos']:
            videos[(r['run_id'], r['video_index'] // 2)] = videos.get((r['run_id'], r['video_index'] // 2), 0) + (r['video_index'] < 6)
        for r in found['exercises']:
            exercises.setdefault((r['run_id'], r['set_index']), set()).add(r['exercise_index'])
        # Same rules as services.ready, services.passed and services.unlocked.
        is_ready = lambda run_id, s: videos.get((run_id, s), 0) == 2 and len(exercises.get((run_id, s), ())) == 2
        is_passed = lambda run_id, s: any(x['status'] == 'passed' for x in exams.get((run_id, s), ()))
        is_unlocked = lambda run_id, s: s == 0 or (is_ready(run_id, s - 1) and is_passed(run_id, s - 1))
        for run in runs:
            for s in range(3):
                attempts = exams.get((run['id'], s), [])
                if is_ready(run['id'], s) and is_unlocked(run['id'], s) and not attempts:
                    notify(db, [employee], 'exam', f'Module {s+1} exam unlocked', f'{run["title"]}: your videos and exercises are complete. Your exam is ready.', 'courses', f'unlocked:{run["id"]}:{s}')
                if attempts and not is_passed(run['id'], s) and attempts[-1]['status'] != 'in-progress':
                    left = max(0, run['max_attempts'] - len(attempts))
                    notify(db, [employee], 'exam', f'{left} exam attempts remaining', f'{run["title"]}, Module {s+1}: last attempt {attempts[-1]["status"]}.', 'courses', f'attempts:{attempts[-1]["id"]}')
                    if not left:
                        name = name or full_name()
                        staff_event(db, employee, f'Exam attempts exhausted: {name}', f'{run["title"]}, Module {s+1}.', f'exhausted:{run["id"]}:{s}')
    # Session reminders (24 hours, 1 hour and 15 minutes before) are sent by live_training.process.


def announce(db, actor, data):
    check(actor['role'] in ('admin', 'hr'), 'Only administrators and HR can publish announcements.', 403)
    title, body = text(data, 'title', 2, 200), text(data, 'body', 2, 500)
    key = f'announcement:{uid()}'
    notify(db, [r['id'] for r in db['candidates'].find({'is_active': 1}, ['id'])], 'announcement', title, body, 'dashboard', key)
    return {'ok': True}


def published(db, course, title):
    notify(db, [r['id'] for r in db['candidates'].find({'is_active': 1}, ['id'])], 'announcement', f'New course available: {title}', 'Explore the course catalog to start learning.', 'courses', f'published:{course}')


def resource_added(db, course, title, resource):
    notify(db, db['course_runs'].distinct('candidate_id', {'course_id': course, 'archived_at': None}), 'material', 'New learning material', title, 'courses', f'resource:{resource}')
