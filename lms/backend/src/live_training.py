"""Live training and webinars: online meeting links (Zoom, Google Meet, Microsoft Teams), calendar invites,
session recordings, live Q&A, feedback, scheduled reminders, post-session assessments and trainer workload.

Scheduling, registration, seat limits and attendance live in development.py; this module adds to those sessions.
Session times are stored as server-local 'YYYY-MM-DDTHH:MM' strings, like the rest of the training calendar.
"""
import sys
from contextlib import closing
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

from admin import audit, media_reference
from analytics import local_now
from database import connect
from services import check, notify, now, require, text, uid

PROVIDERS = {'zoom': 'Zoom', 'meet': 'Google Meet', 'teams': 'Microsoft Teams', 'other': 'Online meeting'}
PROVIDER_HOSTS = {'zoom': ('zoom.us', 'zoomgov.com'), 'meet': ('meet.google.com',), 'teams': ('teams.microsoft.com', 'teams.live.com')}
DELIVERY = ('in_person', 'online', 'hybrid')
JOIN_EARLY_MINUTES = 15
QA_GRACE_MINUTES = 30  # Questions stay open briefly after the session for follow-ups.
MAX_QUESTIONS_PER_PERSON = 20
# Checked tightest first, so only the most urgent reminder that is due is sent (a server that was down skips stale ones).
REMINDERS = ((JOIN_EARLY_MINUTES, 'join', 'starts in 15 minutes. You can join now.'), (60, '1h', 'starts in 1 hour.'), (24 * 60, '24h', 'starts tomorrow.'))
FOLLOW_UP_DAYS = 7


# ---------------------------------------------------------------- time and access helpers

def parse_local(value):
    return datetime.strptime(value, '%Y-%m-%dT%H:%M')


def shift(value, minutes):
    return (parse_local(value) + timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M')


def to_utc(value):
    # Session times are server-local; a naive datetime's astimezone() reads it in the server's time zone.
    return parse_local(value).astimezone(timezone.utc)


def session_or_404(db, identity):
    session = db['training_sessions'].find_one({'id': identity}) if isinstance(identity, str) else None
    check(session is not None, 'Session was not found.', 404)
    return session


def is_staff(user, session):
    return user is not None and (user['role'] in ('admin', 'hr') or user['id'] in (session['trainer_id'], session['created_by']))


def my_status(db, session_id, user_id):
    row = db['session_registrations'].find_one({'session_id': session_id, 'employee_id': user_id}, ['status'])
    return row['status'] if row else None


def my_statuses(db, session_ids, user_id):
    """{session id: the user's registration status} for several sessions in one query (sessions without one are left out)."""
    ids = list(session_ids)
    return {r['session_id']: r['status'] for r in db['session_registrations'].find({'session_id': {'$in': ids}, 'employee_id': user_id}, ['session_id', 'status'])} if ids else {}


def registered_ids(db, session_id, statuses):
    """Employee ids registered for a session with one of these statuses, in employee id order (the former primary key order)."""
    return [r['employee_id'] for r in db['session_registrations'].find({'session_id': session_id, 'status': {'$in': list(statuses)}}, ['employee_id'], sort='employee_id')]


def participants(db, session_id):
    """Who took part: the attendance list once any attendance is recorded, otherwise everyone registered."""
    return participants_of(db, [session_id]).get(session_id, [])


def participants_of(db, session_ids):
    """participants() for several sessions in one query: {session id: employee ids}."""
    attended, registered = {}, {}
    for r in db['session_registrations'].find({'session_id': {'$in': list(session_ids)}, 'status': {'$in': ['attended', 'registered']}},
                                              ['session_id', 'employee_id', 'status'], sort=['session_id', 'employee_id']) if session_ids else []:
        (attended if r['status'] == 'attended' else registered).setdefault(r['session_id'], []).append(r['employee_id'])
    return {s: attended.get(s) or registered.get(s, []) for s in session_ids}


def detect_provider(url):
    host = (urlsplit(url).hostname or '').lower()
    for key, hosts in PROVIDER_HOSTS.items():
        if any(host == h or host.endswith('.' + h) for h in hosts):
            return key
    return 'other'


def https_link(value, label):
    value = value.strip()
    parts = urlsplit(value)
    check(parts.scheme == 'https' and parts.hostname and not parts.username and not parts.password, f'The {label} must be an HTTPS link.')
    return value


# ---------------------------------------------------------------- session settings (called from save_session)

def session_fields(db, data, old):
    """Validated delivery, meeting, recording, assessment, Q&A and feedback settings. Missing fields keep stored values."""
    def keep(field, column, default):
        return data[field] if field in data else (old[column] if old else default)
    delivery = keep('delivery', 'delivery', 'in_person')
    check(delivery in DELIVERY, 'Select how the session is delivered: in person, online or hybrid.')
    url, provider = keep('meetingUrl', 'meeting_url', '') or '', ''
    check(isinstance(url, str) and len(url) <= 2000, 'The meeting link must contain at most 2000 characters.')
    if delivery == 'in_person':
        url = ''
    else:
        check(url.strip(), 'Add the Zoom, Google Meet or Microsoft Teams link for an online or hybrid session.')
        url = https_link(url, 'meeting link')
        provider = detect_provider(url)
        chosen = keep('meetingProvider', 'meeting_provider', '') or ''
        check(chosen in ('', *PROVIDERS), 'Select a valid meeting platform.')
        if chosen and chosen != 'other':
            check(provider == chosen, f'This is not a {PROVIDERS[chosen]} link. Check the meeting link, or choose the platform it belongs to.')
    recording = keep('recordingUrl', 'recording_url', '') or ''
    check(isinstance(recording, str) and len(recording) <= 2000, 'The recording link must contain at most 2000 characters.')
    recording = recording.strip()
    check(not recording or media_reference(recording), 'The recording must be an uploaded video or an HTTPS link.')
    if recording.startswith('api/materials/'):
        check(db['materials'].exists({'id': recording.removeprefix('api/materials/')}), 'The uploaded recording was not found. Upload it again.')
    assessment = keep('assessmentId', 'assessment_id', None) or None
    if assessment is not None:
        row = db['assessments'].find_one({'id': assessment}, ['status']) if isinstance(assessment, str) else None
        check(row is not None, 'Select a valid post-session assessment.')
        check(row['status'] == 'published', 'Publish the post-session assessment before linking it, so participants can take it.')
    toggles = []
    for field, column in (('qaEnabled', 'qa_enabled'), ('feedbackEnabled', 'feedback_enabled')):
        value = keep(field, column, True)
        check(type(value) in (bool, int), f'{field} must be true or false.')
        toggles.append(int(bool(value)))
    return {'delivery': delivery, 'meeting_provider': provider, 'meeting_url': url, 'recording_url': recording,
            'assessment_id': assessment, 'qa_enabled': toggles[0], 'feedback_enabled': toggles[1]}


def check_trainer_free(db, trainer, starts, ends, identity):
    """A trainer cannot run two scheduled sessions at the same time."""
    if not trainer:
        return
    check(isinstance(trainer, str) and isinstance(identity or '', str) and isinstance(starts, str) and isinstance(ends, str), 'Select a valid trainer and session time.')
    row = db['training_sessions'].find_one({'trainer_id': trainer, 'status': 'scheduled', 'id': {'$ne': identity or ''}, 'starts_at': {'$lt': ends}, 'ends_at': {'$gt': starts}},
                                           ['title', 'starts_at', 'ends_at'], sort=[('$natural', 1)])
    check(row is None, f'The trainer is already running “{row["title"]}” from {row["starts_at"].replace("T", " ")} to {row["ends_at"][11:]}. Choose another time or trainer.' if row else '', 409)


def after_save(db, identity, title, old, fields):
    """Tell people about changes they act on: a new meeting link, or a recording becoming available."""
    if old is None:
        return
    if fields['meeting_url'] and fields['meeting_url'] != (old['meeting_url'] or ''):
        registered = registered_ids(db, identity, ('registered',))
        notify(db, registered, 'session', f'New joining link: {title}', f'Join on {PROVIDERS[fields["meeting_provider"]]}. The link is on the Training Calendar.', 'calendar', f'session-link:{identity}:{fields["meeting_url"]}')
    if fields['recording_url'] and not old['recording_url']:
        people = registered_ids(db, identity, ('registered', 'attended'))
        notify(db, people, 'session', f'Recording available: {title}', 'Watch the session recording from the Training Calendar.', 'calendar', f'session-recording:{identity}')


# ---------------------------------------------------------------- what each person sees for a session

def calendar_links(row, include_link):
    start, end = to_utc(row['starts_at']), to_utc(row['ends_at'])
    details, location = row['description'] or '', row['location'] or ''
    if include_link and row['meeting_url']:
        details = (details + '\n\n' if details else '') + f'Join on {PROVIDERS.get(row["meeting_provider"], "the meeting link")}: {row["meeting_url"]}'
        location = location or row['meeting_url']
    stamp = lambda value: value.strftime('%Y%m%dT%H%M%SZ')
    iso = lambda value: value.strftime('%Y-%m-%dT%H:%M:%SZ')
    return {'google': 'https://calendar.google.com/calendar/render?' + urlencode({'action': 'TEMPLATE', 'text': row['title'], 'dates': f'{stamp(start)}/{stamp(end)}', 'details': details, 'location': location}),
            'outlook': 'https://outlook.office.com/calendar/0/deeplink/compose?' + urlencode({'path': '/calendar/action/compose', 'rru': 'addevent', 'subject': row['title'], 'startdt': iso(start), 'enddt': iso(end), 'body': details, 'location': location})}


def row_extras(db, user, row, mine):
    """Fields added to every session in session_rows. Meeting links and recordings are shown only to participants and staff."""
    return rows_extras(db, user, [row], {row['id']: mine})[0]


def rows_extras(db, user, rows, mine=None):
    """row_extras() for several sessions, in the same order, with each kind of record read once for all of them.

    `mine` maps session id -> the user's registration status (see my_statuses); when omitted it is read here."""
    if mine is None:
        mine = my_statuses(db, [r['id'] for r in rows], user['id']) if user is not None else {}
    staff_ids = [r['id'] for r in rows if is_staff(user, r)]
    own_ids = [r['id'] for r in rows if user is not None and mine.get(r['id'])]
    assessment_ids = list({r['assessment_id'] for r in rows if r['assessment_id']})
    found = {}
    found['assessments'] = {a['id']: a for a in db['assessments'].find({'id': {'$in': assessment_ids}}, ['id', 'title', 'status'])} if assessment_ids else {}
    found['passed'] = set(db['assessment_attempts'].distinct('assessment_id', {'assessment_id': {'$in': assessment_ids}, 'employee_id': user['id'], 'status': 'passed'})) \
        if assessment_ids and own_ids else set()
    found['feedback'] = {f['session_id']: f for f in db['session_feedback'].find({'session_id': {'$in': own_ids}, 'employee_id': user['id']},
                                                                                  ['session_id', 'rating', 'comment'])} if own_ids else {}
    found['ratings'], found['questions'], found['attended'] = {}, {}, {}
    if staff_ids:
        for g in db['session_feedback'].aggregate([{'$match': {'session_id': {'$in': staff_ids}}},
                                                   {'$group': {'_id': '$session_id', 'count': {'$sum': 1}, 'rated': {'$sum': {'$cond': [{'$eq': ['$rating', None]}, 0, 1]}},
                                                               'total': {'$sum': '$rating'}}}]):
            found['ratings'][g['_id']] = g
        for table, where, key in (('session_questions', {'status': 'open'}, 'questions'), ('session_registrations', {'status': 'attended'}, 'attended')):
            for g in db[table].aggregate([{'$match': {'session_id': {'$in': staff_ids}, **where}}, {'$group': {'_id': '$session_id', 'n': {'$sum': 1}}}]):
                found[key][g['_id']] = g['n']
    return [_extras(user, row, mine.get(row['id']), found) for row in rows]


def _extras(user, row, mine, found):
    staff, current = is_staff(user, row), local_now()
    inside = staff or mine in ('registered', 'attended')
    scheduled = row['status'] == 'scheduled'
    item = {'delivery': row['delivery'], 'meetingProvider': row['meeting_provider'], 'providerLabel': PROVIDERS.get(row['meeting_provider'], ''),
            'online': row['delivery'] != 'in_person', 'joinOpensAt': shift(row['starts_at'], -JOIN_EARLY_MINUTES),
            'live': scheduled and row['starts_at'] <= current < row['ends_at'], 'ended': row['ends_at'] <= current,
            'qaEnabled': bool(row['qa_enabled']), 'qaOpen': bool(row['qa_enabled']) and scheduled and current < shift(row['ends_at'], QA_GRACE_MINUTES),
            'feedbackEnabled': bool(row['feedback_enabled']), 'hasRecording': bool(row['recording_url']), 'assessmentId': row['assessment_id']}
    if inside:
        item['calendarLinks'] = calendar_links(row, True)
        item['recordingUrl'] = row['recording_url']
        if item['online']:
            item['meetingUrl'] = row['meeting_url']
            item['canJoin'] = scheduled and (staff or item['joinOpensAt'] <= current) and current < row['ends_at']
    if row['assessment_id']:
        a = found['assessments'].get(row['assessment_id'])
        if a:
            item['assessment'] = {'id': a['id'], 'title': a['title'], 'published': a['status'] == 'published'}
            if user is not None and mine:
                item['assessment']['passed'] = a['id'] in found['passed']
                item['assessment']['open'] = item['ended'] and a['status'] == 'published'
    if user is not None and mine:
        f = found['feedback'].get(row['id'])
        item['myFeedback'] = {'rating': f['rating'], 'comment': f['comment']} if f else None
        item['canGiveFeedback'] = bool(row['feedback_enabled']) and row['starts_at'] <= current and mine in ('registered', 'attended')
    if staff:
        summary = found['ratings'].get(row['id'], {'count': 0, 'rated': 0, 'total': 0})
        item['feedbackCount'], item['averageRating'] = summary['count'], round(summary['total'] / summary['rated'], 1) if summary['rated'] else None
        item['openQuestions'] = found['questions'].get(row['id'], 0)
        item['attended'] = found['attended'].get(row['id'], 0)
        item['meetingUrl'], item['recordingUrl'] = row['meeting_url'], row['recording_url']
    return item


def registration_extras(db, session, registrations):
    """Each participant's feedback rating and post-session assessment result, for the trainer's roster."""
    ratings = {r['employee_id']: r['rating'] for r in db['session_feedback'].find({'session_id': session['id']}, ['employee_id', 'rating'])}
    results = {}
    if session['assessment_id']:
        for r in db['assessment_attempts'].aggregate([{'$match': {'assessment_id': session['assessment_id'], 'status': {'$ne': 'in-progress'}}},
                                                      {'$group': {'_id': '$employee_id', 'best': {'$max': '$percent'},
                                                                  'passed': {'$max': {'$cond': [{'$eq': ['$status', 'passed']}, 1, 0]}}}}]):
            results[r['_id']] = {'best': r['best'], 'passed': bool(r['passed'])}
    for item in registrations:
        item['rating'] = ratings.get(item['employeeId'])
        item['assessment'] = results.get(item['employeeId'])
    return registrations


# ---------------------------------------------------------------- calendar files (.ics)

def ics_text(value):
    return str(value).replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,').replace('\r\n', '\\n').replace('\n', '\\n')


def ics_fold(line):
    # RFC 5545: lines longer than 75 octets continue on the next line after a space.
    out, current = [], ''
    for char in line:
        if len((current + char).encode('utf-8')) > 74:
            out.append(current)
            current = ' '
        current += char
    out.append(current)
    return '\r\n'.join(out)


def vevent(row, include_link, stamp):
    description = row['description'] or ''
    location = row['location'] or ''
    if include_link and row['meeting_url']:
        description = (description + '\n\n' if description else '') + f'Join on {PROVIDERS.get(row["meeting_provider"], "the meeting link")}: {row["meeting_url"]}'
        location = location or row['meeting_url']
    lines = ['BEGIN:VEVENT', f'UID:{row["id"]}@shimentox-lms', f'DTSTAMP:{stamp}',
             f'DTSTART:{to_utc(row["starts_at"]):%Y%m%dT%H%M%SZ}', f'DTEND:{to_utc(row["ends_at"]):%Y%m%dT%H%M%SZ}',
             f'SUMMARY:{ics_text(row["title"])}', f'DESCRIPTION:{ics_text(description)}', f'LOCATION:{ics_text(location)}',
             f'STATUS:{"CANCELLED" if row["status"] == "cancelled" else "CONFIRMED"}']
    if include_link and row['meeting_url']:
        lines.append(f'URL:{row["meeting_url"]}')
    lines += ['BEGIN:VALARM', 'ACTION:DISPLAY', f'DESCRIPTION:{ics_text(row["title"])}', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT']
    return lines


def calendar_file(db, user, path):
    """(body, content type, file name) for one session, or for every session the person is registered for or trains."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    parts = path.removeprefix('/api/me/').split('/')
    if parts[0] == 'sessions':
        row = session_or_404(db, parts[1])
        mine = my_status(db, row['id'], user['id'])
        check(is_staff(user, row) or row['status'] == 'scheduled' or mine, 'Session was not found.', 404)
        events, name = vevent(row, is_staff(user, row) or mine in ('registered', 'attended'), stamp), 'shimentox-session.ics'
    else:
        since = shift(local_now(), -30 * 24 * 60)
        joined = db['session_registrations'].distinct('session_id', {'employee_id': user['id'], 'status': {'$in': ['registered', 'attended']}})
        # Sorted in Python so sessions starting together stay in stored order, as SQLite's sort left them.
        rows = sorted(db['training_sessions'].find({'ends_at': {'$gte': since}, '$or': [{'trainer_id': user['id']}, {'id': {'$in': joined}}]}, sort=[('$natural', 1)]),
                      key=lambda r: r['starts_at'])
        events, name = [line for row in rows for line in vevent(row, True, stamp)], 'shimentox-training-calendar.ics'
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ShimentoX//Learning Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:ShimentoX training', *events, 'END:VCALENDAR']
    return ('\r\n'.join(ics_fold(line) for line in lines) + '\r\n').encode('utf-8'), 'text/calendar; charset=utf-8', name


# ---------------------------------------------------------------- live Q&A

def qa_session(db, user, identity):
    session = session_or_404(db, identity)
    staff, mine = is_staff(user, session), my_status(db, identity, user['id'])
    check(staff or mine in ('registered', 'attended'), 'Register for this session to join its Q&A.', 403)
    check(staff or session['qa_enabled'], 'Q&A is turned off for this session.', 403)
    return session, staff


def questions(db, user, identity):
    session, staff = qa_session(db, user, identity)
    found = db['session_questions'].find({'session_id': identity}, sort=[('$natural', 1)])
    ids = [q['id'] for q in found]
    votes = {g['_id']: g['n'] for g in db['session_question_votes'].aggregate([{'$match': {'question_id': {'$in': ids}}}, {'$group': {'_id': '$question_id', 'n': {'$sum': 1}}}])} if ids else {}
    voted = set(db['session_question_votes'].distinct('question_id', {'question_id': {'$in': ids}, 'employee_id': user['id']})) if ids else set()
    people = {c['id']: c['full_name'] for c in db['candidates'].find({'id': {'$in': list({q['employee_id'] for q in found} | {q['answered_by'] for q in found if q['answered_by']})}},
                                                                    ['id', 'full_name'])} if found else {}
    rows = [{**q, 'asker': people[q['employee_id']], 'answerer': people.get(q['answered_by']), 'votes': votes.get(q['id'], 0), 'voted': int(q['id'] in voted)}
            for q in found if q['employee_id'] in people]
    rows.sort(key=lambda r: ({'open': 0, 'answered': 1}.get(r['status'], 2), -r['votes'], r['created_at']))
    items = []
    for r in rows:
        if r['status'] == 'dismissed' and not staff and r['employee_id'] != user['id']:
            continue
        own = r['employee_id'] == user['id']
        items.append({'id': r['id'], 'body': r['body'], 'status': r['status'], 'answer': r['answer'], 'answeredBy': r['answerer'], 'answeredAt': r['answered_at'],
                      'createdAt': r['created_at'], 'votes': r['votes'], 'voted': bool(r['voted']), 'mine': own, 'anonymous': bool(r['anonymous']),
                      'asker': r['asker'] if staff or own or not r['anonymous'] else 'Anonymous'})
    open_now = bool(session['qa_enabled']) and session['status'] == 'scheduled' and local_now() < shift(session['ends_at'], QA_GRACE_MINUTES)
    return {'session': {'id': session['id'], 'title': session['title'], 'live': session['starts_at'] <= local_now() < session['ends_at']},
            'questions': items, 'open': open_now, 'canModerate': staff}


def ask(db, user, identity, data):
    session, staff = qa_session(db, user, identity)
    check(bool(session['qa_enabled']) and session['status'] == 'scheduled' and local_now() < shift(session['ends_at'], QA_GRACE_MINUTES), 'Q&A for this session has closed.', 409)
    body = text(data, 'body', 2, 500)
    anonymous = data.get('anonymous', False)
    check(type(anonymous) is bool, 'anonymous must be true or false.')
    asked = db['session_questions'].count({'session_id': identity, 'employee_id': user['id']})
    check(asked < MAX_QUESTIONS_PER_PERSON, f'You can ask up to {MAX_QUESTIONS_PER_PERSON} questions in one session.', 429)
    db['session_questions'].insert({'id': uid(), 'session_id': identity, 'employee_id': user['id'], 'body': body, 'anonymous': int(anonymous), 'status': 'open',
                                    'answer': '', 'created_at': now()})
    return questions(db, user, identity)


def vote(db, user, identity, question_id):
    qa_session(db, user, identity)
    row = db['session_questions'].find_one({'id': question_id, 'session_id': identity}, ['status'])
    check(row is not None, 'Question was not found.', 404)
    if db['session_question_votes'].exists({'question_id': question_id, 'employee_id': user['id']}):
        db['session_question_votes'].delete({'question_id': question_id, 'employee_id': user['id']})
    else:
        check(row['status'] == 'open', 'Only open questions can be upvoted.', 409)
        db['session_question_votes'].insert({'question_id': question_id, 'employee_id': user['id'], 'created_at': now()})
    return questions(db, user, identity)


def moderate(db, user, identity, question_id, data):
    session = session_or_404(db, identity)
    check(is_staff(user, session), 'Only the session trainer or HR can answer questions.', 403)
    row = db['session_questions'].find_one({'id': question_id, 'session_id': identity})
    check(row is not None, 'Question was not found.', 404)
    status = data.get('status', 'answered')
    check(status in ('open', 'answered', 'dismissed'), 'Select a valid question status.')
    answer = data.get('answer', row['answer']) or ''
    check(isinstance(answer, str) and len(answer.strip()) <= 2000, 'The answer must contain at most 2000 characters.')
    answer = answer.strip()
    answered = status == 'answered'
    db['session_questions'].update({'id': question_id}, {'status': status, 'answer': answer, 'answered_by': user['id'] if answered else None,
                                                         'answered_at': now() if answered else None})
    if answered and row['status'] != 'answered' and row['employee_id'] != user['id']:
        notify(db, [row['employee_id']], 'session', f'Your question was answered: {session["title"]}', answer[:300] or 'The trainer answered it live in the session.', 'calendar', f'qa-answer:{question_id}')
    return questions(db, user, identity)


# ---------------------------------------------------------------- feedback

def submit_feedback(db, user, identity, data):
    session = session_or_404(db, identity)
    check(session['feedback_enabled'], 'Feedback is turned off for this session.', 403)
    check(my_status(db, identity, user['id']) in ('registered', 'attended'), 'Only participants can give feedback on this session.', 403)
    check(session['starts_at'] <= local_now(), 'Feedback opens when the session starts.', 409)
    rating = data.get('rating')
    check(type(rating) is int and 1 <= rating <= 5, 'Choose a rating from 1 to 5 stars.')
    comment = data.get('comment') or ''
    check(isinstance(comment, str) and len(comment.strip()) <= 2000, 'Comments must contain at most 2000 characters.')
    created = now()
    db['session_feedback'].upsert({'session_id': identity, 'employee_id': user['id']}, {'rating': rating, 'comment': comment.strip(), 'updated_at': now()},
                                  insert_only={'created_at': created})
    return {'feedback': {'rating': rating, 'comment': comment.strip()}}


def feedback_report(db, user, identity):
    session = session_or_404(db, identity)
    check(is_staff(user, session), 'Only the session trainer or HR can read session feedback.', 403)
    rows = db['session_feedback'].find({'session_id': identity}, ['employee_id', 'rating', 'comment', 'updated_at'])
    names = {c['id']: c['full_name'] for c in db['candidates'].find({'id': {'$in': [f['employee_id'] for f in rows]}}, ['id', 'full_name'])} if rows else {}
    # Newest first; equal times in the order SQLite's sort gave them (employee id, descending).
    rows = sorted(sorted((f for f in rows if f['employee_id'] in names), key=lambda f: f['employee_id'], reverse=True), key=lambda f: f['updated_at'], reverse=True)
    items = [{'name': names[f['employee_id']], 'rating': f['rating'], 'comment': f['comment'], 'at': f['updated_at']} for f in rows]
    count = len(items)
    people = len(participants(db, identity))
    return {'summary': {'responses': count, 'averageRating': round(sum(i['rating'] for i in items) / count, 1) if count else None,
                        'distribution': {str(n): sum(1 for i in items if i['rating'] == n) for n in range(1, 6)},
                        'participants': people, 'responseRate': round(count / people * 100) if people else 0},
            'items': items}


# ---------------------------------------------------------------- trainers

def trainers(db, user):
    require(user, 'sessions.manage')
    current = local_now()
    where = {'role': {'$in': ['admin', 'hr', 'trainer']}, 'is_active': 1} if user['role'] in ('admin', 'hr') else {'id': user['id']}
    people = sorted(db['candidates'].find(where, ['id', 'full_name', 'email', 'role'], sort=[('$natural', 1)]), key=lambda c: c['full_name'])
    # Sessions, feedback and attendance of every trainer, read once rather than per trainer.
    ids = [c['id'] for c in people]
    owned = db['training_sessions'].find({'trainer_id': {'$in': ids}}, ['id', 'title', 'starts_at', 'ends_at', 'status', 'trainer_id'], sort=[('$natural', 1)]) if ids else []
    trainer_of = {s['id']: s['trainer_id'] for s in owned}
    scheduled = {}
    for s in sorted((s for s in owned if s['status'] == 'scheduled'), key=lambda s: s['starts_at']):
        scheduled.setdefault(s['trainer_id'], []).append(s)
    feedback, attended = {}, {}
    for f in db['session_feedback'].find({'session_id': {'$in': list(trainer_of)}}, ['session_id', 'rating']) if trainer_of else []:
        feedback.setdefault(trainer_of[f['session_id']], []).append(f['rating'])
    for g in db['session_registrations'].find({'session_id': {'$in': list(trainer_of)}, 'status': 'attended'}, ['session_id']) if trainer_of else []:
        attended[trainer_of[g['session_id']]] = attended.get(trainer_of[g['session_id']], 0) + 1
    result = []
    for c in people:
        sessions = scheduled.get(c['id'], [])
        upcoming = [s for s in sessions if s['ends_at'] > current]
        delivered = [s for s in sessions if s['ends_at'] <= current]
        rated = [r for r in feedback.get(c['id'], []) if r is not None]
        rating = (len(feedback.get(c['id'], [])), sum(rated) / len(rated) if rated else None)  # COUNT(*), AVG(rating)
        attendees = attended.get(c['id'], 0)
        minutes = sum((parse_local(s['ends_at']) - parse_local(s['starts_at'])).total_seconds() / 60 for s in delivered)
        if not sessions and c['role'] != 'trainer' and user['role'] in ('admin', 'hr'):
            continue  # Admins and HR appear once they have sessions; dedicated trainers always appear.
        result.append({'id': c['id'], 'name': c['full_name'], 'email': c['email'], 'role': c['role'], 'upcoming': len(upcoming), 'delivered': len(delivered),
                       'hoursDelivered': round(minutes / 60, 1), 'attendees': attendees, 'ratings': rating[0],
                       'averageRating': round(rating[1], 1) if rating[1] is not None else None,
                       'next': {'id': upcoming[0]['id'], 'title': upcoming[0]['title'], 'startsAt': upcoming[0]['starts_at']} if upcoming else None})
    return {'trainers': result}


# ---------------------------------------------------------------- reminders and follow-ups

def process(db, at=None):
    """Send due session reminders and post-session follow-ups. Notification dedupe keys make repeat passes harmless."""
    current = at or datetime.now()
    text_now = current.strftime('%Y-%m-%dT%H:%M')
    horizon = (current + timedelta(minutes=REMINDERS[-1][0])).strftime('%Y-%m-%dT%H:%M')
    soon = db['training_sessions'].find({'status': 'scheduled', 'starts_at': {'$gt': text_now, '$lte': horizon}}, sort=[('$natural', 1)])
    registered = {}
    for r in db['session_registrations'].find({'session_id': {'$in': [s['id'] for s in soon]}, 'status': 'registered'}, ['session_id', 'employee_id'],
                                              sort=['session_id', 'employee_id']) if soon else []:
        registered.setdefault(r['session_id'], []).append(r['employee_id'])
    for s in soon:
        minutes = (parse_local(s['starts_at']) - current).total_seconds() / 60
        due = next((r for r in REMINDERS if minutes <= r[0]), None)
        if not due:
            continue
        _, key, phrase = due
        people = list(registered.get(s['id'], []))
        if s['trainer_id']:
            people.append(s['trainer_id'])
        where = f'on {PROVIDERS.get(s["meeting_provider"], "the meeting link")}' if s['delivery'] != 'in_person' else f'at {s["location"] or "the published location"}'
        if s['delivery'] == 'hybrid' and s['location']:
            where = f'at {s["location"]} or {where}'
        notify(db, people, 'session', f'{s["title"]} {phrase}', f'{s["starts_at"].replace("T", " ")}, {where}.', 'calendar', f'session-reminder:{key}:{s["id"]}:{s["starts_at"]}')
    since = (current - timedelta(days=FOLLOW_UP_DAYS)).strftime('%Y-%m-%dT%H:%M')
    ended = db['training_sessions'].find({'status': 'scheduled', 'ends_at': {'$lte': text_now, '$gt': since}}, sort=[('$natural', 1)])
    taking_part = participants_of(db, [s['id'] for s in ended])
    published = {a['id']: a for a in db['assessments'].find({'id': {'$in': [s['assessment_id'] for s in ended if s['assessment_id']]}, 'status': 'published'}, ['id', 'title'])}         if any(s['assessment_id'] for s in ended) else {}
    for s in ended:
        people = taking_part[s['id']]
        if not people:
            continue
        if s['feedback_enabled']:
            notify(db, people, 'session', f'How was {s["title"]}?', 'Rate the session and share feedback for the trainer on the Training Calendar.', 'calendar', f'session-feedback:{s["id"]}')
        if s['assessment_id']:
            a = published.get(s['assessment_id'])
            if a:
                notify(db, people, 'assessment', f'Post-session assessment: {a["title"]}', f'Check what you learned in {s["title"]}.', 'assessments', f'session-assessment:{s["id"]}:{s["assessment_id"]}')


def run_pass(path):
    """One scheduler pass in its own short transaction."""
    with closing(connect(path)) as db:
        db.begin(write=True)
        try:
            process(db)
            db.commit()
        except Exception as error:
            db.rollback()
            print(f'Session reminder pass failed: {type(error).__name__}', file=sys.stderr, flush=True)

