"""MongoDB storage for the LMS (replaces SQLite).

The LMS keeps its data in the same MongoDB database as the timesheet application, in collections named
``<prefix><table>`` (prefix ``lms_`` by default), one per former SQLite table. Documents keep the former column names
and value types (JSON columns stay JSON strings, flags stay 0/1 integers, timestamps stay ISO strings), so rows read
from MongoDB look exactly like the former SQLite rows, as plain dicts.

Connection settings, in order of precedence:
  LMS_MONGODB_URI / LMS_MONGODB_DB      dedicated settings for the LMS
  MONGODB_URI / MONGODB_DB_NAME         shared settings (environment or lms/backend/.env)
  ../../backend/.env                    the timesheet backend's settings, read when nothing above is set
  LMS_COLLECTION_PREFIX                 collection name prefix (default "lms_")

Behaviour kept from SQLite:
  * One database connection per request (``Db``) with a transaction that ``commit()`` / ``rollback()`` end.
  * One writer at a time in this process: the first write in a transaction takes a process-wide lock that is
    released on commit/rollback/close (SQLite's database write lock). ``begin(write=True)`` takes it up front
    (SQLite's BEGIN IMMEDIATE).
  * Column defaults, column type affinity, unique constraints (including partial and case-insensitive ones),
    INTEGER PRIMARY KEY auto-numbering, and ON DELETE CASCADE / SET NULL / NO ACTION foreign key actions.
"""
import atexit
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
import re
import threading
from pathlib import Path

from bson import ObjectId
from pymongo import ASCENDING, IndexModel, MongoClient, ReturnDocument
from pymongo.collation import Collation
from pymongo.errors import CollectionInvalid, DuplicateKeyError, PyMongoError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from schema_spec import TABLES

BACKEND = Path(__file__).resolve().parents[1]
NOCASE = Collation(locale='en', strength=2)
_WRITE_LOCK = threading.RLock()
_CLIENT_LOCK = threading.Lock()
_clients = {}
_test_databases = set()


class IntegrityError(Exception):
    """A unique or foreign key constraint failed (sqlite3.IntegrityError). The server answers 409."""


class LockTimeout(Exception):
    """Another writer held the database for too long (SQLite's 'database is locked')."""


# ---------------------------------------------------------------- settings and connection

def _env_file(path):
    values = {}
    try:
        for line in Path(path).read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def settings():
    # The real environment wins, then lms/backend/.env (tools don't load it themselves), then the timesheet's backend/.env.
    own = _env_file(BACKEND / '.env')
    shared = _env_file(BACKEND.parents[1] / 'backend/.env')

    def pick(*names):
        for source in (os.environ, own, shared):
            for name in names:
                if source.get(name):
                    return source[name]
        return ''

    uri = pick('LMS_MONGODB_URI', 'MONGODB_URI')
    name = pick('LMS_MONGODB_DB', 'MONGODB_DB_NAME') or 'project_timesheet'
    if not uri:
        raise RuntimeError('MongoDB is not configured. Set MONGODB_URI (or LMS_MONGODB_URI) in lms/backend/.env, '
                           'or in the timesheet backend/.env.')
    return {'uri': uri, 'database': name, 'prefix': os.environ.get('LMS_COLLECTION_PREFIX', 'lms_')}


def client():
    uri = settings()['uri']
    with _CLIENT_LOCK:
        if uri not in _clients:
            _clients[uri] = MongoClient(uri, appname='shimentox-lms', tz_aware=False, serverSelectionTimeoutMS=15000)
        return _clients[uri]


def database_name(target=None):
    """The MongoDB database for a target.

    None or '' is the configured database. A file-system path (what callers passed when the LMS used SQLite files,
    as the tests still do) maps to its own throwaway database, dropped when the process exits.
    A plain name is used as the database name."""
    if target is None or str(target) == '':
        return settings()['database']
    text = str(target)
    if isinstance(target, Path) or re.search(r'[\\/:]|\.sqlite3$|\.db$', text):
        name = 'lmstest_' + hashlib.sha1(str(Path(text).resolve()).encode()).hexdigest()[:16]
        _test_databases.add(name)
        return name
    return text


@atexit.register
def _drop_test_databases():
    if not _test_databases or os.environ.get('LMS_KEEP_TEST_DATABASES') == '1':
        return
    try:
        for name in list(_test_databases):
            client().drop_database(name)
    except Exception:
        pass


def drop(target):
    """Delete a database entirely (tests)."""
    client().drop_database(database_name(target))


# ---------------------------------------------------------------- column types and defaults (SQLite affinity)

def _coerce(table, column, value):
    spec = TABLES[table]['columns'].get(column)
    if spec is None or value is None:
        return value
    kind = spec['type']
    if kind == 'INTEGER':
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and re.fullmatch(r'-?\d+', value.strip()):
            return int(value)
    elif kind == 'REAL':
        if isinstance(value, bool):
            return float(int(value))
        if isinstance(value, int):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                return value
    elif kind == 'TEXT':
        if isinstance(value, bool):
            return str(int(value))
        if isinstance(value, (int, float)):
            return str(value)
    return value


def coerce_fields(table, fields):
    return {key: _coerce(table, key, value) for key, value in fields.items()}


def with_defaults(table, fields):
    """A complete row: every column present, missing ones at their SQLite default (or NULL)."""
    columns = TABLES[table]['columns']
    unknown = set(fields) - set(columns) - {'_id'}
    if unknown:
        raise ValueError(f'Unknown column(s) for {table}: {sorted(unknown)}')
    row = {name: spec['default'] for name, spec in columns.items()}
    row.update(fields)
    return coerce_fields(table, row)


def _coerce_update(table, update):
    if not update:
        return update
    if not any(key.startswith('$') for key in update):
        update = {'$set': update}
    result = dict(update)
    for operator in ('$set', '$setOnInsert'):
        if operator in result:
            result[operator] = coerce_fields(table, result[operator])
    return result


def _primary_key(table):
    return TABLES[table]['pk']


def _single_key(table):
    pk = _primary_key(table)
    return pk[0] if len(pk) == 1 else None


def _partial_filter(where):
    """The MongoDB partialFilterExpression for the SQLite partial index conditions used by the schema."""
    match = re.fullmatch(r"(\w+)='([^']*)'", where)
    if match:
        return {match.group(1): match.group(2)}
    match = re.fullmatch(r'length\((\w+)\)>0', where)
    if match:
        return {match.group(1): {'$gt': ''}}
    match = re.fullmatch(r'(\w+) IS NULL', where)
    if match:
        return {match.group(1): {'$type': 'null'}}
    match = re.fullmatch(r'(\w+) IS NOT NULL', where)
    if match:
        return {match.group(1): {'$type': 'string'}}
    raise ValueError(f'Unsupported partial index condition: {where}')


def _matches_partial(where, doc):
    """Whether a row falls under a partial index (used to emulate INSERT OR IGNORE before writing)."""
    if not where:
        return True
    match = re.fullmatch(r"(\w+)='([^']*)'", where)
    if match:
        return doc.get(match.group(1)) == match.group(2)
    match = re.fullmatch(r'length\((\w+)\)>0', where)
    if match:
        return bool(doc.get(match.group(1)))
    match = re.fullmatch(r'(\w+) IS NULL', where)
    if match:
        return doc.get(match.group(1)) is None
    match = re.fullmatch(r'(\w+) IS NOT NULL', where)
    if match:
        return doc.get(match.group(1)) is not None
    return True


def unique_keys(table):
    """Every unique constraint of a table: (columns, partial condition or None)."""
    keys = [(_primary_key(table), None)] if _primary_key(table) else []
    keys += [(index['columns'], index['where']) for index in TABLES[table]['indexes'] if index['unique']]
    return keys


# ---------------------------------------------------------------- the connection

class Db:
    """One unit of work on the LMS database, used like the former sqlite3 connection.

    ``db['table']`` is a Table with SQL-shaped helpers. A transaction starts with the first operation and ends with
    commit() or rollback(); the next operation starts a new one. close() rolls back anything uncommitted.
    With transactional=False every operation is applied immediately (startup seeding, maintenance tools).
    """

    def __init__(self, target=None, transactional=True):
        self.settings = settings()
        self.client = client()
        self.name = database_name(target)
        self.database = self.client[self.name]
        self.prefix = self.settings['prefix']
        self.transactional = transactional
        self.session = None
        self._locked = False
        self.closed = False

    # -- names
    def collection_name(self, table):
        """Full collection name of a table, for $lookup 'from' and $unionWith 'coll'."""
        if table not in TABLES:
            raise KeyError(f'Unknown LMS table: {table}')
        return self.prefix + table

    def collection(self, table):
        """The raw pymongo collection. Pass session=db.active_session() to every call made with it."""
        return self.database[self.collection_name(table)]

    def __getitem__(self, table):
        return Table(self, table)

    # -- transactions
    def active_session(self):
        """The session of the current transaction, starting one if needed (None when not transactional)."""
        if not self.transactional:
            return None
        if self.closed:
            raise RuntimeError('This database connection is closed.')
        if self.session is None or not self.session.in_transaction:
            if self.session is None:
                self.session = self.client.start_session()
            self.session.start_transaction(read_concern=ReadConcern('snapshot'), write_concern=WriteConcern('majority'))
        return self.session

    def begin(self, write=False):
        """Start a transaction now; write=True first takes the writer lock (SQLite BEGIN IMMEDIATE)."""
        if write:
            self.lock_for_write()
        self.active_session()

    def lock_for_write(self):
        if not self._locked:
            if not _WRITE_LOCK.acquire(timeout=30):
                raise LockTimeout('The database is busy. Try again.')
            self._locked = True

    def _release(self):
        if self._locked:
            self._locked = False
            _WRITE_LOCK.release()

    def commit(self):
        try:
            if self.session is not None and self.session.in_transaction:
                for attempt in range(3):
                    try:
                        self.session.commit_transaction()
                        break
                    except PyMongoError as error:
                        # Committing again is safe: MongoDB applies a transaction's commit at most once.
                        if attempt == 2 or not error.has_error_label('UnknownTransactionCommitResult'):
                            raise
        finally:
            self._release()

    def rollback(self):
        try:
            if self.session is not None and self.session.in_transaction:
                self.session.abort_transaction()
        except PyMongoError:
            pass
        finally:
            self._release()

    def close(self):
        if self.closed:
            return
        try:
            self.rollback()
        finally:
            if self.session is not None:
                self.session.end_session()
                self.session = None
            self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None:
            self.commit()
        else:
            self.rollback()
        return False

    # -- schema
    def ensure_schema(self):
        """Create every collection with its indexes (idempotent). Not allowed inside a transaction.

        A marker in the counters collection records the schema that was applied, so later starts skip the work."""
        counters = self.database[self.prefix + 'counters']
        marker = hashlib.sha1(repr(TABLES).encode()).hexdigest()
        if (counters.find_one({'_id': '__schema__'}) or {}).get('hash') == marker:
            return
        existing = set(self.database.list_collection_names())

        def create(table):
            spec = TABLES[table]
            name = self.collection_name(table)
            if name not in existing:
                try:
                    self.database.create_collection(name, **({'collation': NOCASE} if spec['nocase'] else {}))
                except CollectionInvalid:
                    pass
            models = _index_models(spec)
            if models:
                self.database[name].create_indexes(models)

        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(create, TABLES))
        counters.update_one({'_id': '__schema__'}, {'$set': {'hash': marker}}, upsert=True)

    def next_id(self, table):
        """The next INTEGER PRIMARY KEY value of a table (SQLite rowid allocation)."""
        self.lock_for_write()
        result = self.database[self.prefix + 'counters'].find_one_and_update(
            {'_id': table}, {'$inc': {'seq': 1}}, upsert=True, return_document=ReturnDocument.AFTER,
            session=self.active_session())
        return result['seq']

    def drop_all(self):
        """Delete every LMS collection of this database (tests and resets)."""
        for name in self.database.list_collection_names():
            if name.startswith(self.prefix):
                self.database.drop_collection(name)


def _index_models(spec):
    """The table's indexes: primary key, unique and plain indexes from the schema, and foreign key columns
    (so ON DELETE actions and joins stay fast). Plain indexes already covered by a longer index are skipped."""
    wanted = []  # (columns, unique, where)
    if spec['pk']:
        wanted.append((tuple(spec['pk']), True, None))
    wanted += [(tuple(i['columns']), i['unique'], i['where']) for i in spec['indexes']]
    wanted += [(tuple(f['columns']), False, None) for f in spec['foreign_keys']]
    models, seen = [], set()
    for columns, unique, where in wanted:
        if not unique and not where and any(other[:len(columns)] == columns and (other != columns or u) and not w
                                            for other, u, w in wanted):
            continue
        if (columns, where) in seen:
            continue
        seen.add((columns, where))
        options = {'name': ('u_' if unique else 'i_') + '_'.join(columns)[:90] + ('_partial' if where else ''), 'unique': unique}
        if where:
            options['partialFilterExpression'] = _partial_filter(where)
        models.append(IndexModel([(c, ASCENDING) for c in columns], **options))
    return models


def connect(target=None, transactional=True):
    return Db(target, transactional)


# ---------------------------------------------------------------- one table

def _strip_id(doc):
    if doc is not None:
        doc.pop('_id', None)
    return doc


def _projection(projection):
    if projection is None:
        return {'_id': 0}
    if isinstance(projection, (list, tuple, set)):
        projection = {field: 1 for field in projection}
    projection = dict(projection)
    projection.setdefault('_id', 0)
    return projection


def _sort(sort):
    if sort is None:
        return None
    if isinstance(sort, str):
        sort = [sort]
    result = []
    for item in sort:
        if isinstance(item, str):
            result.append((item[1:], -1) if item.startswith('-') else (item, 1))
        else:
            result.append(tuple(item))
    return result


class Table:
    """SQL-shaped access to one LMS collection inside the connection's transaction.

    Rows come back as plain dicts with the former column names and without MongoDB's ``_id``.
    ``sort`` accepts 'col', '-col' (descending), or a list of those / (col, ±1) pairs.
    """

    def __init__(self, db, table):
        if table not in TABLES:
            raise KeyError(f'Unknown LMS table: {table}')
        self.db = db
        self.table = table
        self.collection = db.collection(table)

    def _session(self):
        return self.db.active_session()

    def _write(self):
        self.db.lock_for_write()
        return self._session()

    # -- reads
    def find(self, filter=None, projection=None, sort=None, limit=0, skip=0):
        cursor = self.collection.find(filter or {}, _projection(projection), session=self._session())
        if sort:
            cursor = cursor.sort(_sort(sort))
        if skip:
            cursor = cursor.skip(skip)
        if limit:
            cursor = cursor.limit(limit)
        return list(cursor)

    def find_one(self, filter=None, projection=None, sort=None):
        rows = self.find(filter, projection, sort, limit=1)
        return rows[0] if rows else None

    def get(self, key, projection=None):
        """The row with this primary key value (single-column keys only)."""
        return self.find_one({_single_key(self.table): key}, projection)

    def exists(self, filter=None):
        return self.collection.find_one(filter or {}, {'_id': 1}, session=self._session()) is not None

    def count(self, filter=None):
        return self.collection.count_documents(filter or {}, session=self._session())

    def distinct(self, field, filter=None):
        return self.collection.distinct(field, filter or {}, session=self._session())

    def aggregate(self, pipeline):
        """Run an aggregation. In $lookup use db.collection_name('table') for 'from'. Results keep any _id the pipeline produces."""
        return list(self.collection.aggregate(pipeline, session=self._session()))

    # -- writes
    def _prepare(self, fields):
        row = with_defaults(self.table, fields)
        key = _single_key(self.table)
        if key and row.get(key) is None and TABLES[self.table]['columns'][key]['type'] == 'INTEGER':
            row[key] = self.db.next_id(self.table)
        if key:
            row['_id'] = row[key]
        return row

    def insert(self, fields):
        """INSERT INTO: a full row with defaults. Returns the row (with any generated INTEGER key, like lastrowid)."""
        session = self._write()
        row = self._prepare(fields)
        try:
            self.collection.insert_one(row, session=session)
        except DuplicateKeyError as error:
            raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error
        return _strip_id(dict(row))

    def insert_many(self, rows):
        rows = list(rows)
        if not rows:
            return []
        session = self._write()
        prepared = [self._prepare(fields) for fields in rows]
        try:
            self.collection.insert_many(prepared, ordered=True, session=session)
        except DuplicateKeyError as error:
            raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error
        except PyMongoError as error:
            if 'E11000' in str(error):
                raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error
            raise
        return [_strip_id(dict(row)) for row in prepared]

    def conflict(self, row):
        """The existing row that would make this row violate a unique constraint, or None."""
        for columns, where in unique_keys(self.table):
            if not _matches_partial(where, row):
                continue
            if any(row.get(c) is None for c in columns):
                continue  # NULLs never conflict in SQLite unique constraints
            found = self.find_one({c: row[c] for c in columns})
            if found is not None:
                return found
        return None

    def insert_ignore(self, fields):
        """INSERT OR IGNORE: insert unless the row would break a unique constraint. Returns True when inserted.

        Checked before writing, because a failed write aborts the whole MongoDB transaction."""
        self._write()
        row = with_defaults(self.table, fields)
        if self.conflict(row) is not None:
            return False
        self.insert(fields)
        return True

    def replace(self, fields):
        """INSERT OR REPLACE: delete the rows this one conflicts with on any unique constraint, then insert it."""
        session = self._write()
        row = with_defaults(self.table, fields)
        for columns, where in unique_keys(self.table):
            if _matches_partial(where, row) and all(row.get(c) is not None for c in columns):
                self.collection.delete_many({c: row[c] for c in columns}, session=session)
        return self.insert(fields)

    def upsert(self, keys, fields, insert_only=None):
        """INSERT ... ON CONFLICT(keys) DO UPDATE SET fields.

        keys: {column: value} identifying the row (the conflict target).
        fields: columns set on insert and on update. insert_only: columns set only when inserting.
        Returns True when a row was inserted."""
        session = self._write()
        full = with_defaults(self.table, {**(insert_only or {}), **keys, **fields})
        key = _single_key(self.table)
        if key and full.get(key) is None and TABLES[self.table]['columns'][key]['type'] == 'INTEGER':
            existing = self.collection.find_one(keys, {'_id': 1}, session=session)
            if existing is None:
                full[key] = self.db.next_id(self.table)
        on_insert = {c: v for c, v in full.items() if c not in fields and c not in keys}
        if key:
            on_insert['_id'] = full[key]
        update = {'$set': coerce_fields(self.table, fields)} if fields else {}
        if on_insert:
            update['$setOnInsert'] = on_insert
        if not update:
            update = {'$setOnInsert': {}}
        try:
            result = self.collection.update_one(keys, update, upsert=True, session=session)
        except DuplicateKeyError as error:
            raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error
        return result.upserted_id is not None

    def update(self, filter, fields):
        """UPDATE ... SET fields WHERE filter. A dict of columns, or a MongoDB update document ($set/$inc/...).
        Returns the number of rows matched (SQLite's changes())."""
        session = self._write()
        try:
            return self.collection.update_many(filter, _coerce_update(self.table, fields), session=session).matched_count
        except DuplicateKeyError as error:
            raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error

    def update_one(self, filter, fields):
        session = self._write()
        try:
            return self.collection.update_one(filter, _coerce_update(self.table, fields), session=session).matched_count
        except DuplicateKeyError as error:
            raise IntegrityError(f'UNIQUE constraint failed: {self.table}') from error

    def find_one_and_update(self, filter, fields, sort=None, after=True, projection=None):
        """Update the first matching row and return it (after the update by default)."""
        session = self._write()
        return _strip_id(self.collection.find_one_and_update(
            filter, _coerce_update(self.table, fields), projection=_projection(projection), sort=_sort(sort),
            return_document=ReturnDocument.AFTER if after else ReturnDocument.BEFORE, session=session))

    def delete(self, filter):
        """DELETE FROM ... WHERE filter, applying the schema's ON DELETE actions. Returns the number of rows deleted."""
        session = self._write()
        rows = list(self.collection.find(filter, session=session))
        if not rows:
            return 0
        _apply_delete_actions(self.db, self.table, rows)
        ids = [row['_id'] for row in rows]
        return self.collection.delete_many({'_id': {'$in': ids}}, session=session).deleted_count


def _referencing(table):
    """(child table, foreign key) pairs whose foreign key points at this table."""
    return [(child, foreign) for child, spec in TABLES.items() for foreign in spec['foreign_keys'] if foreign['table'] == table]


def _apply_delete_actions(db, table, rows):
    pk = _primary_key(table)
    restricted = []
    for child, foreign in _referencing(table):
        targets = [t if t is not None else pk[i] for i, t in enumerate(foreign['to'])]
        if len(foreign['columns']) == 1:
            values = list({row.get(targets[0]) for row in rows if row.get(targets[0]) is not None})
            if not values:
                continue
            match = {foreign['columns'][0]: {'$in': values}}
        else:
            keys = {tuple(row.get(t) for t in targets) for row in rows}
            keys = [k for k in keys if None not in k]
            if not keys:
                continue
            match = {'$or': [dict(zip(foreign['columns'], k)) for k in keys]}
        action = foreign['on_delete']
        if action == 'CASCADE':
            if child == table:
                ids = {row['_id'] for row in rows}
                match = {'$and': [match, {'_id': {'$nin': list(ids)}}]}
            db[child].delete(match)
        elif action == 'SET NULL':
            db.collection(child).update_many(match, {'$set': {c: None for c in foreign['columns']}}, session=db.active_session())
        else:
            restricted.append((child, match))
    for child, match in restricted:
        if child == table:
            ids = [row['_id'] for row in rows]
            match = {'$and': [match, {'_id': {'$nin': ids}}]}
        if db[child].exists(match):
            raise IntegrityError(f'FOREIGN KEY constraint failed: {child} still references {table}')


def like(text):
    """SQLite LIKE pattern (% and _ wildcards, ASCII case-insensitive) as a MongoDB $regex condition."""
    pattern = ''.join('.*' if ch == '%' else '.' if ch == '_' else re.escape(ch) for ch in text)
    return {'$regex': f'^{pattern}$', '$options': 'is'}


def new_id():
    return str(ObjectId())
