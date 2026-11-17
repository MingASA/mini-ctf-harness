# Recover SQL context before generating probes

A value bound by a parameterized query remains data. A string interpolated into SQL text can alter syntax. Parameter binding for values does not automatically cover dynamic identifiers, ordering clauses, or separately concatenated fragments. Inspect both query construction and the database API call.

## Determine the insertion context
For a quoted value, account for the surrounding quote and suffix. For a numeric field, quoted-string syntax may only cause a type error. For `ORDER BY` or an identifier, use syntax valid in that position; a predicate designed for a WHERE clause may not apply. Match comment syntax and concatenation operators to the observed DBMS.

Use a baseline and logically opposed predicates within the recovered context. Compare a stable content field, row count, or known response condition. A raw size difference can be caused by reflection or an error page. Repeat the control to exclude cache, session expiry, and fluctuating content.

## A local semantics check
This standalone SQLite example distinguishes values from SQL text. It is a local demonstration, not an application payload:
```python
import sqlite3
c = sqlite3.connect(':memory:')
c.execute('CREATE TABLE sample(value TEXT)')
c.execute('INSERT INTO sample VALUES (?)', ('literal',))
s = "' OR 'a'='a"
assert c.execute('SELECT count(*) FROM sample WHERE value=?', (s,)).fetchone()[0] == 0
assert c.execute('SELECT count(*) FROM sample WHERE 3 > 1').fetchone()[0] == 1
assert c.execute('SELECT count(*) FROM sample WHERE 3 < 1').fetchone()[0] == 0
```

## Ambiguous signals
A database-looking error establishes a parser/backend clue, not complete control of a query. Successful JSON parsing only establishes the frontend representation. Where a value is stored and later consumed by another query, test both storage and use; the initial request may contain no visible SQL response.

When no reliable difference appears, revisit the exact request, input position, and server query before cycling through unrelated DBMS payloads.

Primary references: [PortSwigger SQL injection](https://portswigger.net/web-security/sql-injection), [Python sqlite3 parameter binding](https://docs.python.org/3/library/sqlite3.html).
