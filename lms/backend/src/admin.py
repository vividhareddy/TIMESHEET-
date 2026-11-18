"""Role-protected account provisioning, course authoring, and admin audit records."""
import json
import re
from collections import Counter
from urllib.parse import parse_qs, urlsplit

from database import COURSE_ID, CURRICULUM, LESSONS
from security import password_hash, verify_password
from analytics import training_progress
from services import ROLES, allowed, check, require, text, uid, now, create_run, candidate_view, records, expire_exams

DIFFICULTIES = ('beginner', 'intermediate', 'advanced', 'expert')


def audit(db, admin, action, target, detail=''):
    db['admin_events'].insert({'admin_id':admin,'action':action,'target_id':target,'detail':detail,'created_at':now()})


def setup_initial_admin(db,data):
    check(not db['candidates'].exists({'role':'admin'}),'Administrator setup has already been completed.',409)
    name,email,password=text(data,'name',2,100),text(data,'email').casefold(),text(data,'password',8,128)
    check(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) is not None,'Enter a valid email address.')
    existing=db['candidates'].find_one({'email':email})
    if existing:
        check(existing['is_active'] and verify_password(password,existing['password_hash']),'This email already exists. Enter its current password to use it for admin setup.',403)
        identity=existing['id']
        db['candidates'].update({'id':identity},{'role':'admin','must_change_password':0,'updated_at':now()})
        db['sessions'].delete({'candidate_id':identity})
    else:
        identity=uid()
        db['candidates'].insert({'id':identity,'full_name':name,'email':email,'password_hash':password_hash(password),'created_at':now(),'updated_at':now(),'role':'admin'})
        create_run(db,identity)
    audit(db,identity,'admin_setup',identity,'First administrator configured from the local setup page')


def optional_id(db, data, field, table, label, condition=None):
    value=data.get(field) or None
    if value is not None:
        check(isinstance(value,str) and db[table].exists({'id':value,**(condition or {})}),f'Select a valid {label}.')
    return value


def role_input(data, current=None):
    """Employee and Manager are the roles that can be assigned (the role architecture: Admin, Manager, Employee).
    An existing account may keep the role it already has."""
    role=data.get('role','employee')
    if role=='candidate':role='employee'  # Accept the pre-v3 API value.
    check(role in ROLES,'Invalid role.')
    check(role in ('employee','manager',current),'Only the Employee and Manager roles can be assigned.',403)
    return role


def org_fields(db, data, identity=None):
    department=optional_id(db,data,'departmentId','departments','department')
    job_role=optional_id(db,data,'jobRoleId','job_roles','job role')
    manager=optional_id(db,data,'managerId','candidates','manager',{'is_active':1})
    check(manager is None or manager!=identity,'An employee cannot be their own manager.')
    title=data.get('jobTitle','')
    check(isinstance(title,str) and len(title.strip())<=100,'Job title must contain at most 100 characters.')
    return department,job_role,manager,title.strip()


def provision(db, actor, data):
    name, email, password = text(data,'name',2,100), text(data,'email').casefold(), text(data,'password',8,128)
    check(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) is not None,'Enter a valid email address.')
    role=role_input(data)
    department,job_role,manager,title=org_fields(db,data)
    check(not db['candidates'].exists({'email':email}),'This email is already assigned.',409)
    identity,timestamp=uid(),now()
    from onboarding import auto_start, date_value  # onboarding imports this module for the audit log
    joining=date_value(data.get('joiningDate'),'Joining date')
    db['candidates'].insert({'id':identity,'full_name':name,'email':email,'password_hash':password_hash(password),'created_at':timestamp,'updated_at':timestamp,'role':role,'must_change_password':1,
                             'created_by':actor['id'],'department_id':department,'job_role_id':job_role,'manager_id':manager,'job_title':title,'joining_date':joining})
    create_run(db,identity)
    audit(db,actor['id'],'employee_created',identity,f'{role}: {email}')
    onboarding=auto_start(db,actor,identity)
    return candidate_view(db['candidates'].get(identity)),onboarding


def update_profile(db, actor, target, data):
    name=text(data,'name',2,100)
    role=role_input(data,target['role'])
    check(target['id']!=actor['id'] or role==target['role'],'You cannot change your own role.')
    department,job_role,manager,title=org_fields(db,data,target['id'])
    fields={'full_name':name,'role':role,'department_id':department,'job_role_id':job_role,'manager_id':manager,'job_title':title,'updated_at':now()}
    if 'joiningDate' in data:  # Older clients that do not send it keep the stored date.
        from onboarding import date_value
        fields['joining_date']=date_value(data.get('joiningDate'),'Joining date')
    db['candidates'].update({'id':target['id']},fields)
    audit(db,actor['id'],'employee_updated',target['id'],f'{role}: {target["email"]}')
    return candidate_view(db['candidates'].get(target['id']))


def candidate_list(db):
    users=[]
    people=db['candidates'].find()
    departments={r['id']:r['name'] for r in db['departments'].find({},['id','name'])}
    roles={r['id']:r['name'] for r in db['job_roles'].find({},['id','name'])}
    names={p['id']:p['full_name'] for p in people}
    owners={r['id']:r['candidate_id'] for r in db['course_runs'].find({},['id','candidate_id'])}
    runs=Counter(owners.values())
    certificates=Counter(owners[x['run_id']] for x in db['certificates'].find({},['run_id']) if x['run_id'] in owners)
    rows=[dict(c,department=departments.get(c['department_id']),job_role=roles.get(c['job_role_id']),manager=names.get(c['manager_id']),
               certificate_count=certificates[c['id']],run_count=runs[c['id']]) for c in people]
    # ORDER BY created_at DESC,id, sorted here because the candidates collection compares strings ignoring case.
    rows=sorted(sorted(rows,key=lambda r:r['id']),key=lambda r:(r['created_at'] is not None,r['created_at'] or ''),reverse=True)
    training=training_progress(db,[row['id'] for row in rows])
    for row in rows:
        item=candidate_view(row)
        item.update({'certificates':row['certificate_count'],'courseRuns':row['run_count'],'lastLoginAt':row['last_login_at'],'department':row['department'],'jobRole':row['job_role'],'manager':row['manager'],'training':training[row['id']]})
        users.append(item)
    return users


def course_view(row, private=False, db=None):
    result={key:row[key] for key in ('id','title','description','category','status','version')}
    keys=row.keys()
    if 'difficulty' in keys:
        result.update({'difficulty':row['difficulty'],'durationMinutes':row['duration_minutes'],'departmentId':row['department_id'],'trainerId':row['trainer_id'],
                       'passPercent':row['pass_percent'],'maxAttempts':row['max_attempts'],'postAssessmentId':row['post_assessment_id']})
    if 'format' in keys:
        result.update({'format':row['format'],'visibility':row['visibility']})
    if 'page_layout' in keys:
        result['layout']=row['page_layout']
    if 'source_url' in keys and row['source_url']:
        # Imported courses always show where the content came from; for courses written from a reference (no import status) only course managers see it.
        if private or row['import_status']:result['source']={'url':row['source_url'],'platform':row['source_platform'],'importStatus':row['import_status']}
        if private and row['import_report_json']:result['importReport']=json.loads(row['import_report_json'])
    if db is not None:
        department=db['departments'].find_one({'id':result.get('departmentId')},['name']) if result.get('departmentId') is not None else None
        result['department']=department['name'] if department else None
    if private:
        result['content']={'sets':json.loads(row['sets_json']),'lessons':json.loads(row['lessons_json'])}
        if db is not None:
            result['learners']=len(db['course_runs'].distinct('candidate_id',{'course_id':row['id']}))
            result['hasLearners']=bool(result['learners'])
            # Read in insertion order and sorted by created_at here, as SQLite's ORDER BY created_at returned them.
            resources=sorted(db['course_resources'].find({'course_id':row['id']},['id','module_index','title','kind','url','created_at']),key=lambda r:(r['created_at'] is not None,r['created_at'] or ''))
            result['resources']=[{key:r[key] for key in ('id','module_index','title','kind','url')} for r in resources]
            result['assignments']=db['course_assignments'].count({'course_id':row['id']})
    return result


def owns_course(actor, row):
    return actor['role'] in ('admin','hr') or actor['id'] in (row['trainer_id'],row['created_by'])


def course_list(db, actor):
    """Enrich a role-scoped catalog with three queries, independent of its size."""
    where={} if actor['role'] in ('admin','hr') else {'$or':[{'trainer_id':actor['id']},{'created_by':actor['id']}]}
    # Courses are read in insertion order and sorted by title here (ORDER BY k.title); the rest is joined by course ID.
    courses=sorted(db['courses'].find(where),key=lambda k:k['title'])
    ids={k['id'] for k in courses}
    scoped={} if not where else {'course_id':{'$in':list(ids)}}
    resources,assignments={},{}
    # ORDER BY q.created_at,q.rowid: insertion order, then a stable sort by created_at.
    for row in sorted(db['course_resources'].find(scoped,['course_id','id','module_index','title','kind','url','created_at']),key=lambda r:(r['created_at'] is not None,r['created_at'] or '')):
        if row['course_id'] in ids:resources.setdefault(row['course_id'],[]).append({key:row[key] for key in ('id','module_index','title','kind','url')})
    for course,count in Counter(row['course_id'] for row in db['course_assignments'].find(scoped,['course_id'])).items():
        if course in ids:assignments[course]=count
    departments={r['id']:r['name'] for r in db['departments'].find({},['id','name'])}
    learners={}
    for run in db['course_runs'].find(scoped,['course_id','candidate_id']):
        learners.setdefault(run['course_id'],set()).add(run['candidate_id'])
    result=[]
    for course in courses:
        row=dict(course,department_name=departments.get(course['department_id']),learners=len(learners.get(course['id'],())))
        item=course_view(row,True)
        item.update({'department':row['department_name'],'hasLearners':bool(row['learners']),'learners':row['learners'],'resources':resources.pop(row['id'],[]),'assignments':assignments.pop(row['id'],0)})
        result.append(item)
    return result


def media_reference(value):
    parsed=urlsplit(value)
    return (parsed.scheme=='https' and parsed.netloc and not parsed.username and not parsed.password) or (not parsed.scheme and not parsed.netloc and (value.startswith('assets/') or re.fullmatch(r'api/materials/[0-9a-f-]{36}',value) is not None) and '..' not in value.split('/'))


def validate_content(content):
    check(isinstance(content,dict),'Course content must be a JSON object.')
    sets,lessons=content.get('sets'),content.get('lessons')
    check(isinstance(sets,list) and len(sets)==3,'A course requires exactly 3 modules.')
    check(isinstance(lessons,list) and len(lessons)==6,'A course requires exactly 6 video lessons.')
    for i,lesson in enumerate(lessons):
        check(isinstance(lesson,dict),f'Invalid lesson {i+1}.')
        text(lesson,'title',2,150)
        for field in ('body','code','task'):
            check(isinstance(lesson.get(field),str) and len(lesson[field])<=12000,f'Lesson {i+1}: {field} text is required.')
        for field in ('src','captions'):
            value=lesson.get(field,'')
            if field=='captions' and not value: continue
            check(isinstance(value,str) and len(value)<=2000,f'Invalid lesson {field}.')
            check(media_reference(value),f'Lesson {field} must be an assets/ path, an uploaded material, or an HTTPS URL.')
        duration=lesson.get('duration')
        check(type(duration) in (int,float) and 1<=duration<=7200,'Video duration must be between 1 and 7200 seconds.')
    for s,item in enumerate(sets):
        check(isinstance(item,dict),'Invalid course module.')
        text(item,'title',2,150);text(item,'summary',1,1000)
        check(item.get('videos')==[s*2,s*2+1],'Each module must reference its two sequential video indices.')
        exercises=item.get('exercises')
        check(isinstance(exercises,list) and len(exercises)==2,'Every module requires exactly 2 exercises.')
        groups=[]
        for exercise in exercises:
            check(isinstance(exercise,dict),'Invalid exercise.')
            text(exercise,'title',2,150)
            groups.append((exercise.get('questions'),2,True))
        groups.append((item.get('exam'),4,False))
        for questions,count,practice in groups:
            check(isinstance(questions,list) and len(questions)==count,f'Expected {count} questions.')
            for q in questions:
                check(isinstance(q,list) and len(q)>=(4 if practice else 3),'Invalid question format.')
                check(isinstance(q[0],str) and 1<=len(q[0])<=2000,'Question text is required.')
                check(isinstance(q[1],list) and 2<=len(q[1])<=6 and all(isinstance(o,str) and 1<=len(o)<=1000 for o in q[1]),'Provide 2-6 non-empty answer options.')
                check(type(q[2]) is int and 0<=q[2]<len(q[1]),'Question has an invalid correct-answer index.')
                if practice: check(isinstance(q[3],str) and len(q[3])<=2000,'Practice feedback is required.')
    return sets,lessons


def course_metadata(db, data, old):
    """Training metadata; missing fields keep their stored (or default) values."""
    def value(field, column, default):
        return data[field] if field in data else (old[column] if old else default)
    difficulty=value('difficulty','difficulty','beginner');check(difficulty in DIFFICULTIES,'Select a valid difficulty level.')
    duration=value('durationMinutes','duration_minutes',0);check(type(duration) is int and 0<=duration<=100000,'Estimated duration must be a whole number of minutes.')
    pass_percent=value('passPercent','pass_percent',75);check(type(pass_percent) is int and 25<=pass_percent<=100,'Passing score must be between 25 and 100%.')
    attempts=value('maxAttempts','max_attempts',3);check(type(attempts) is int and 1<=attempts<=3,'Exam attempts per module must be between 1 and 3.')
    department=optional_id(db,{'d':value('departmentId','department_id',None)},'d','departments','department')
    trainer=optional_id(db,{'t':value('trainerId','trainer_id',None)},'t','candidates','trainer',{'role':{'$in':['admin','hr','trainer']},'is_active':1})
    post=optional_id(db,{'p':value('postAssessmentId','post_assessment_id',None)},'p','assessments','post-training assessment',{'kind':'post'})
    return difficulty,duration,pass_percent,attempts,department,trainer,post


VIDEO_FILE = re.compile(r'\.(mp4|webm|ogg|m4v)$', re.I)


def embed_video(value):
    """Permitted embeds become official embed URLs; other video must be an upload, an assets/ file, or a direct HTTPS video file."""
    parsed=urlsplit(value);host=(parsed.hostname or '').lower();segments=[s for s in parsed.path.split('/') if s]
    if host in ('youtu.be','youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com'):
        video=segments[0] if host=='youtu.be' and segments else parse_qs(parsed.query).get('v',[''])[0] if parsed.path=='/watch' else segments[1] if len(segments)>1 and segments[0] in ('embed','shorts','live') else ''
        check(re.fullmatch(r'[A-Za-z0-9_-]{6,20}',video or '') is not None,'Enter a valid YouTube video link.')
        return f'https://www.youtube-nocookie.com/embed/{video}'
    if host in ('vimeo.com','www.vimeo.com','player.vimeo.com'):
        video=next((s for s in reversed(segments) if s.isdigit()),'')
        check(bool(video),'Enter a valid Vimeo video link.')
        return f'https://player.vimeo.com/video/{video}'
    check(media_reference(value) and (not parsed.scheme or VIDEO_FILE.search(parsed.path) is not None),'Use a YouTube or Vimeo link, an uploaded video, or a direct HTTPS .mp4/.webm video link.')
    return value


def lesson_text(item, key, maximum, label, number, minimum=0):
    value=item.get(key) or ''
    check(isinstance(value,str) and minimum<=len(value.strip())<=maximum,f'Lesson {number}: {label} must contain {minimum}–{maximum} characters.' if minimum else f'Lesson {number}: {label} must contain at most {maximum} characters.')
    return value.strip()


def lesson_input(db, item, number):
    check(isinstance(item,dict),f'Lesson {number} is invalid.')
    lesson={'title':lesson_text(item,'title',150,'the title',number,2),'description':lesson_text(item,'description',2000,'the description',number),
            'content':lesson_text(item,'content',100000,'the learning content',number),'exercise':lesson_text(item,'exercise',5000,'the practical exercise',number)}
    video=lesson_text(item,'videoUrl',2000,'the video link',number)
    lesson['video_url']=embed_video(video) if video else ''
    document=lesson_text(item,'documentUrl',2000,'the document link',number)
    material=re.fullmatch(r'api/materials/([0-9a-f-]{36})',document)
    check(not document or (media_reference(document) and (material is None or db['materials'].exists({'id':material.group(1)}))),f'Lesson {number}: the document must be an uploaded file or an HTTPS link.')
    lesson['document_url']=document
    lesson['document_name']=lesson_text(item,'documentName',200,'the document name',number) if document else ''
    resources=item.get('resources') or []
    check(isinstance(resources,list) and len(resources)<=20,f'Lesson {number}: add up to 20 external resources.')
    clean=[]
    for resource in resources:
        check(isinstance(resource,dict),f'Lesson {number}: invalid external resource.')
        url=lesson_text(resource,'url',2000,'each resource link',number,1)
        parsed=urlsplit(url)
        check(parsed.scheme=='https' and parsed.netloc and not parsed.username and not parsed.password,f'Lesson {number}: external resources must be HTTPS links.')
        clean.append({'title':lesson_text(resource,'title',150,'each resource title',number,2),'url':url})
    lesson['resources_json']=json.dumps(clean)
    duration=item.get('durationMinutes',0)
    check(type(duration) is int and 0<=duration<=1000,f'Lesson {number}: duration must be a whole number of minutes from 0 to 1000.')
    lesson['duration_minutes']=duration
    # Optional video settings; when a field is not sent, the stored value is kept (see save_lessons).
    if 'captionsUrl' in item:
        captions=lesson_text(item,'captionsUrl',2000,'the captions link',number)
        check(not captions or (media_reference(captions) and urlsplit(captions).path.lower().endswith('.vtt')),f'Lesson {number}: captions must be a WebVTT (.vtt) file.')
        lesson['captions_url']=captions
    if 'videoSeconds' in item:
        seconds=item.get('videoSeconds') or 0
        check(type(seconds) in (int,float) and 0<=seconds<=36000,f'Lesson {number}: video length must be between 0 and 36000 seconds.')
        lesson['video_seconds']=float(seconds)
    if 'completionPercent' in item:
        percent=item.get('completionPercent')
        check(type(percent) is int and 50<=percent<=100,f'Lesson {number}: the completion threshold must be a whole percentage from 50 to 100.')
        lesson['completion_percent']=percent
    # Optional module name; consecutive lessons with the same name form one module (index set in save_lessons).
    if 'moduleTitle' in item:
        lesson['module_title']=lesson_text(item,'moduleTitle',150,'the module name',number)
    return lesson


def save_lessons(db, course_id, lessons):
    """Persist the ordered lesson list. Lessons that employees have completed cannot be removed."""
    check(isinstance(lessons,list) and len(lessons)<=100,'A course can have up to 100 lessons.')
    existing={r['id']:r['title'] for r in db['course_lessons'].find({'course_id':course_id},['id','title'])}
    kept=set()
    module,previous=-1,None
    for position,item in enumerate(lessons):
        lesson=lesson_input(db,item,position+1)
        if 'module_title' in lesson:
            name=lesson['module_title']
            if name and name!=previous: module+=1
            lesson['module_index']=module if name else None
            previous=name or None
        identity=item.get('id') if item.get('id') in existing and item.get('id') not in kept else None
        columns=dict(lesson,position=position,updated_at=now())
        if identity:
            db['course_lessons'].update({'id':identity},columns)
        else:
            identity=uid()
            columns.update(id=identity,course_id=course_id,created_at=columns['updated_at'])
            db['course_lessons'].insert(columns)
        kept.add(identity)
    removed=set(existing)-kept
    if removed:
        # Checked for all removed lessons at once (one query per table), then deleted together.
        used=set()
        for table in ('lesson_progress','lesson_watch','lesson_activity_attempts'):
            used.update(db[table].distinct('lesson_id',{'lesson_id':{'$in':list(removed)}}))
        for identity in removed:
            check(identity not in used,f'“{existing[identity]}” has employee progress and cannot be removed. Edit it instead, or archive this course and create a new version.',409)
        db['course_lessons'].delete({'id':{'$in':list(removed)}})


def check_publishable(db, course_id):
    lessons=db['course_lessons'].find({'course_id':course_id},['title','video_url','document_url','resources_json','content','position'],sort='position')
    check(lessons,'Add at least one lesson before publishing.')
    for number,lesson in enumerate(lessons,1):
        check(lesson['video_url'] or lesson['document_url'] or lesson['content'] or json.loads(lesson['resources_json']),f'Lesson {number} (“{lesson["title"]}”) needs a video, document, resource link, or learning content before publishing.')


def save_course(db, actor, data):
    title=text(data,'title',2,150);category=text(data,'category',2,80);description=text(data,'description',1,2000)
    check(db['course_categories'].exists({'name':category}),'Select a configured course category.')
    status=data.get('status','draft');check(status in ('draft','published','archived'),'Invalid course status.')
    identity=data.get('id') or uid()
    check(isinstance(identity,str) and len(identity)<=100,'Invalid course ID.')
    old=db['courses'].get(identity)
    if old: check(owns_course(actor,old),'Trainers can edit only the courses they own.',403)
    difficulty,duration,pass_percent,attempts,department,trainer,post=course_metadata(db,data,old)
    if actor['role']=='trainer' and not old: trainer=actor['id']
    # Existing courses keep the 3-module format; new lesson-based courses are built step by step in Manage Courses.
    course_format=old['format'] if old else data.get('format','modules')
    check(course_format in ('modules','lessons') and data.get('format',course_format)==course_format,'A course format cannot be changed after the course is created.')
    visibility=data.get('visibility',old['visibility'] if old else 'everyone')
    check(visibility in ('everyone','department'),'Select a valid visibility setting.')
    check(visibility=='everyone' or department,'Select a department for department-only visibility.')
    has_history=old is not None and db['course_runs'].exists({'course_id':identity})
    if course_format=='modules':
        content=data.get('content')
        if content is None: content={'sets':CURRICULUM,'lessons':LESSONS} if old is None else {'sets':json.loads(old['sets_json']),'lessons':json.loads(old['lessons_json'])}
        sets,lessons=validate_content(content)
        if has_history:
            check(json.loads(old['sets_json'])==sets and json.loads(old['lessons_json'])==lessons,'This course has learner history. Create a new course version to change its lessons or questions.',409)
    else:
        sets,lessons=[],[]
    fields={'title':title,'category':category,'description':description,'status':status,'sets_json':json.dumps(sets),'lessons_json':json.dumps(lessons),'updated_at':now(),'difficulty':difficulty,
            'duration_minutes':duration,'pass_percent':pass_percent,'max_attempts':attempts,'department_id':department,'trainer_id':trainer,'post_assessment_id':post,'visibility':visibility}
    if old:
        db['courses'].update({'id':identity},fields)
    else:
        db['courses'].insert({'id':identity,'version':1,'created_by':actor['id'],'format':course_format,**fields})
    if course_format=='lessons':
        if 'lessons' in data: save_lessons(db,identity,data['lessons'])
        if 'assessment' in data:
            from development import save_course_assessment  # Local import: development builds on this module.
            db['courses'].update({'id':identity},{'post_assessment_id':save_course_assessment(db,actor,identity,title,data['assessment'],status)})
        if status=='published': check_publishable(db,identity)
    elif not has_history:
        db['assessment_questions'].delete({'course_id':identity})
        db['videos'].delete({'course_id':identity})
        db['course_sets'].delete({'course_id':identity})
        course_sets,videos,questions=[],[],[]
        for s,item in enumerate(sets):
            course_sets.append({'course_id':identity,'set_index':s,'title':item['title']})
            for i in item['videos']: videos.append({'course_id':identity,'video_index':i,'set_index':s,'duration_seconds':lessons[i]['duration']})
            groups=[('exam',-1,item['exam'])]+[('exercise',e,x['questions']) for e,x in enumerate(item['exercises'])]
            for kind,e,questions_ in groups:
                for i,q in enumerate(questions_): questions.append({'course_id':identity,'set_index':s,'kind':kind,'exercise_index':e,'question_index':i,'prompt':q[0],'options_json':json.dumps(q[1]),'correct_option':q[2],'explanation':q[3] if len(q)>3 else ''})
        db['course_sets'].insert_many(course_sets)
        db['videos'].insert_many(videos)
        db['assessment_questions'].insert_many(questions)
    if status=='published' and (old is None or old['status']!='published'):
        from notifications import published
        published(db,identity,title)
    audit(db,actor['id'],'course_saved',identity,f'{status}: {title}')
    return course_view(db['courses'].get(identity),True,db)


def archive_course(db, actor, course_id):
    """Hide a course from catalogs while keeping every learner record and certificate."""
    row=db['courses'].get(course_id)
    check(row is not None,'Course was not found.',404)
    check(owns_course(actor,row),'Trainers can archive only the courses they own.',403)
    db['courses'].update({'id':course_id},{'status':'archived','updated_at':now()})
    audit(db,actor['id'],'course_archived',course_id,row['title'])
    return {'ok':True}


def delete_course(db, actor, course_id):
    """Permanently remove a course nobody has started, with its lessons, assessments, assignments and path entries.

    Courses with learner history are archived instead, so employees keep their progress and certificates.
    The ID is recorded so packaged courses are not re-created when the server starts.
    """
    row=db['courses'].get(course_id)
    check(row is not None,'Course was not found.',404)
    check(owns_course(actor,row),'Trainers can delete only the courses they own.',403)
    check(course_id!=COURSE_ID,'This is the starter course every new employee is enrolled in, so it cannot be deleted. Archive it to hide it from the catalog.',409)
    learners=len(db['course_runs'].distinct('candidate_id',{'course_id':course_id}))
    owned=[{'course_id':course_id}]+([{'id':row['post_assessment_id']}] if row['post_assessment_id'] is not None else [])
    assessments=[r['id'] for r in db['assessments'].find({'$or':owned},['id'])]
    attempts=len(db['assessment_attempts'].distinct('employee_id',{'assessment_id':{'$in':assessments}})) if assessments else 0
    people=max(learners,attempts)
    check(not people,f'{people} employee{"" if people==1 else "s"} {"has" if people==1 else "have"} records in this course. Archive it instead: it disappears from catalogs, and their progress and certificates are kept.',409)
    db['courses'].update({'id':course_id},{'post_assessment_id':None})
    db['course_lessons'].update({'course_id':course_id},{'assessment_id':None})
    db['training_sessions'].update({'course_id':course_id},{'course_id':None})
    # Explicit deletes, in the former order; each applies the schema's ON DELETE actions as SQLite's foreign keys did.
    for table in ('course_lessons','course_checkpoints','course_content_updates','course_assignments',
                  'course_resources','assessment_questions','videos','course_sets'):
        db[table].delete({'course_id':course_id})
    if assessments:
        db['assessment_bank'].delete({'assessment_id':{'$in':assessments}})
        db['assessments'].delete({'id':{'$in':assessments}})
    db['courses'].delete({'id':course_id})
    db['deleted_courses'].replace({'course_id':course_id,'title':row['title'],'deleted_by':actor['id'],'deleted_at':now()})
    audit(db,actor['id'],'course_deleted',course_id,row['title'])
    return {'ok':True}


def protected_target(actor, target):
    # HR manages employee accounts but cannot change administrator accounts.
    check(actor['role']=='admin' or target['role']!='admin','Only administrators can change administrator accounts.',403)


def admin_action(db, actor, method, route, data):
    identity=actor['id']
    if method=='GET' and route=='overview':
        require(actor,'users.manage')
        employees=db['candidates'].count({'role':{'$ne':'admin'}})
        return {'stats':{'employees':employees,'candidates':employees, 'courses':db['courses'].count(), 'certificates':db['certificates'].count(), 'exams':db['exam_attempts'].count()}}
    if method=='GET' and route=='candidates': require(actor,'users.manage');return {'candidates':candidate_list(db)}
    if method=='POST' and route=='candidates':
        require(actor,'users.manage');candidate,onboarding=provision(db,actor,data)
        return {'candidate':candidate,'onboarding':onboarding}
    if method=='GET' and route=='courses':
        require(actor,'courses.manage')
        return {'courses':course_list(db,actor)}
    if method=='POST' and route=='courses': require(actor,'courses.manage');return {'course':save_course(db,actor,data)}
    if method=='GET' and route=='audit':
        require(actor,'audit.view')
        events=db['admin_events'].find({},sort='-id',limit=100)
        names={r['id']:r['full_name'] for r in db['candidates'].find({'id':{'$in':list({e['admin_id'] for e in events})}},['id','full_name'])} if events else {}
        return {'events':[{**{key:e[key] for key in ('id','admin_id','action','target_id','detail','created_at')},'admin_name':names[e['admin_id']]} for e in events if e['admin_id'] in names]}
    parts=route.split('/')
    if method=='POST' and len(parts)==3 and parts[0]=='courses' and parts[2]=='delete':
        require(actor,'courses.manage');return delete_course(db,actor,parts[1])
    if method=='POST' and len(parts)==3 and parts[0]=='courses' and parts[2]=='archive':
        require(actor,'courses.manage');return archive_course(db,actor,parts[1])
    if len(parts)==3 and parts[0]=='candidates':
        target=db['candidates'].get(parts[1]);check(target is not None,'Employee was not found.',404)
        if method=='GET' and parts[2]=='records':
            check(allowed(actor,'users.manage') or (actor['role']=='manager' and target['manager_id']==identity),'You can view records only for employees you manage.',403)
            return {'user':candidate_view(target),'training':training_progress(db,[target['id']])[target['id']],**records(db,target['id'])}
        require(actor,'users.manage');protected_target(actor,target)
        if method=='POST' and parts[2]=='profile':return {'candidate':update_profile(db,actor,target,data)}
        if method=='POST' and parts[2]=='reset-password':
            check(target['id']!=identity,'Use My profile to change your own password.')
            password=text(data,'password',8,128)
            db['candidates'].update({'id':target['id']},{'password_hash':password_hash(password),'must_change_password':1,'updated_at':now()})
            db['sessions'].delete({'candidate_id':target['id']})
            for run in db['course_runs'].find({'candidate_id':target['id'],'archived_at':None},['id']):expire_exams(db,run['id'],'An administrator reset the account password.')
            audit(db,identity,'password_reset',target['id'])
            return {'ok':True}
        if method=='POST' and parts[2]=='status':
            check(target['id']!=identity,'You cannot disable your own account.')
            check(type(data.get('active')) is bool,'An active status is required.')
            db['candidates'].update({'id':target['id']},{'is_active':int(data['active']),'updated_at':now()})
            if not data['active']:
                db['sessions'].delete({'candidate_id':target['id']})
                for run in db['course_runs'].find({'candidate_id':target['id'],'archived_at':None},['id']):expire_exams(db,run['id'],'The account was disabled by an administrator.')
            audit(db,identity,'account_status',target['id'],str(data['active']))
            return {'ok':True}
    check(False,'Admin endpoint was not found.',404)
