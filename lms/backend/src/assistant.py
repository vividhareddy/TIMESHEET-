"""Optional AI learning assistant grounded in approved (published) course materials.

Disabled unless an operator opts in: set LMS_AI_ENABLED=1, install the official SDK (`pip install anthropic`),
and provide Claude API credentials on the server (for example ANTHROPIC_API_KEY). Credentials never reach the browser.
Calls are billed by Anthropic per token; see docs/ai-assistant.md before enabling.
"""
import json
import os
import time

from services import check, scalar

try:  # The core portal stays dependency-free; the SDK is needed only when the assistant is enabled.
    import anthropic
except ImportError:
    anthropic = None

MODEL = os.environ.get('LMS_AI_MODEL', 'claude-opus-5-5')
MODES = {
    'ask': 'Answer the employee\'s question.',
    'summarize': 'Summarise the selected lesson (or the whole course if none is selected) in short bullet points.',
    'explain': 'Explain the concept the employee names in plain language, with one short, concrete example.',
    'practice': 'Write 3 new multiple-choice practice questions on the selected lesson, then list the answers with one-line explanations at the end.',
    'revision': 'Using the employee\'s assessment results below, recommend which modules and lessons to revise first and why.',
}
SYSTEM = """You are the ShimentoX learning assistant for employees.
Use only the approved course material provided below for course-specific facts. If the material does not cover a question, say so plainly and suggest asking the course trainer; you may add general background only when you label it as general knowledge.
Never reveal or guess exam or assessment answer keys, and do not claim the employee has mastered a skill.
Keep answers concise and practical, and use plain text with short lists where helpful.

APPROVED COURSE MATERIAL
{material}"""


def hourly_limit():
    try:
        return max(1, int(os.environ.get('LMS_AI_HOURLY_LIMIT', '20')))
    except ValueError:
        return 20


def status():
    if os.environ.get('LMS_AI_ENABLED') != '1':
        return {'enabled': False, 'reason': 'The AI learning assistant has not been enabled by your administrator.'}
    if anthropic is None:
        return {'enabled': False, 'reason': 'The AI learning assistant is enabled but the server is missing the anthropic package.'}
    return {'enabled': True, 'model': MODEL, 'hourlyLimit': hourly_limit()}


def course_material(db, course):
    """Lessons and module summaries only; assessment questions and answer keys are never included."""
    lessons = json.loads(course['lessons_json'])
    sets = json.loads(course['sets_json'])
    parts = [f'Course: {course["title"]}\n{course["description"]}']
    for s, module in enumerate(sets):
        parts.append(f'\nModule {s + 1}: {module["title"]}\n{module["summary"]}')
        for i in module['videos']:
            lesson = lessons[i]
            parts.append(f'\nLesson {i + 1}: {lesson["title"]}\n{lesson["body"]}\nExample code:\n{lesson["code"]}\nTask: {lesson["task"]}')
    for number, lesson in enumerate(db['course_lessons'].find({'course_id': course['id']}, sort='position'), 1):
        links = ', '.join(r['title'] for r in json.loads(lesson['resources_json']))
        parts.append(f'\nLesson {number}: {lesson["title"]}\n{lesson["description"]}\n{lesson["content"]}' + (f'\nPractical exercise: {lesson["exercise"]}' if lesson['exercise'] else '') + (f'\nLinked resources (titles only): {links}' if links else ''))
    resources = [r['title'] for r in db['course_resources'].find({'course_id': course['id']}, ['title'])]
    if resources:
        parts.append('\nSupplementary resources (titles only): ' + ', '.join(resources))
    return '\n'.join(parts)


def revision_context(db, employee, course_id):
    runs = db['course_runs'].distinct('id', {'candidate_id': employee, 'course_id': course_id})
    rows = db['exam_attempts'].find({'run_id': {'$in': runs}, 'status': {'$in': ['passed', 'failed']}}, ['set_index', 'score', 'status', 'finished_at'], sort='finished_at') if runs else []
    attempts = db['assessment_attempts'].find({'employee_id': employee, 'status': {'$in': ['passed', 'failed']}}, ['assessment_id', 'percent', 'status'])
    titles = {a['id']: a['title'] for a in db['assessments'].find({'id': {'$in': list({t['assessment_id'] for t in attempts})}, 'course_id': course_id}, ['id', 'title'])} if attempts else {}
    assessments = [{'title': titles[t['assessment_id']], **t} for t in attempts if t['assessment_id'] in titles]
    lines = [f'Module {r["set_index"] + 1} exam: {r["score"] * 25}% ({r["status"]})' for r in rows]
    lines += [f'{r["title"]}: {r["percent"]}% ({r["status"]})' for r in assessments]
    return '\n'.join(lines) or 'No assessment results yet.'


def ask(db, user, data):
    state = status()
    check(state['enabled'], state.get('reason', 'The assistant is unavailable.'), 503)
    course = db['courses'].find_one({'id': scalar(data.get('courseId')), 'status': 'published'})
    check(course is not None, 'Choose a published course to ask about.', 404)
    mode = data.get('mode', 'ask')
    check(mode in MODES, 'Select a valid assistant action.')
    question = data.get('question') or ''
    check(isinstance(question, str) and len(question.strip()) <= 2000, 'Questions must contain at most 2000 characters.')
    check(mode not in ('ask', 'explain') or question.strip(), 'Type your question first.')
    lesson = data.get('lessonIndex')
    check(lesson is None or (type(lesson) is int and 0 <= lesson <= 5), 'Select a valid lesson.')
    used = db['assistant_usage'].count({'employee_id': user['id'], 'timestamp': {'$gt': time.time() - 3600}})
    check(used < hourly_limit(), f'You have reached the limit of {hourly_limit()} assistant requests per hour. Try again later.', 429)
    db['assistant_usage'].insert({'employee_id': user['id'], 'timestamp': time.time()})
    db.commit()  # Count the request even if the upstream call fails.
    prompt = [MODES[mode]]
    if lesson is not None:
        prompt.append(f'Selected lesson: Lesson {lesson + 1} ({json.loads(course["lessons_json"])[lesson]["title"]}).')
    if mode == 'revision':
        prompt.append('Employee assessment results:\n' + revision_context(db, user['id'], course['id']))
    if question.strip():
        prompt.append('Employee message: ' + question.strip())
    try:
        client = anthropic.Anthropic(max_retries=2, timeout=90.0)
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            output_config={'effort': 'medium'},
            cache_control={'type': 'ephemeral'},  # The per-course material prefix repeats across employees.
            system=SYSTEM.format(material=course_material(db, course)),
            messages=[{'role': 'user', 'content': '\n\n'.join(prompt)}],
            betas=['server-side-fallback-2026-07-01'],
            fallbacks='default',
        )
    except anthropic.RateLimitError:
        check(False, 'The assistant is busy. Please try again in a minute.', 503)
    except anthropic.AuthenticationError:
        check(False, 'The assistant is not configured correctly. Contact your administrator.', 503)
    except (anthropic.APIStatusError, anthropic.APIConnectionError):
        check(False, 'The assistant could not be reached. Please try again later.', 502)
    if response.stop_reason == 'refusal':
        return {'answer': 'The assistant cannot help with this request. Try rephrasing it around the course material.', 'mode': mode}
    answer = '\n'.join(block.text for block in response.content if block.type == 'text').strip()
    return {'answer': answer or 'The assistant did not return an answer. Please try again.', 'mode': mode, 'truncated': response.stop_reason == 'max_tokens'}
