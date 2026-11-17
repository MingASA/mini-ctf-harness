---
name: ctf-sql-injection
description: Confirm and exploit SQL injection using query context, differential probes, and sqlmap request replay.
  Use for controllable SQL fragments, database error clues, UNION extraction, or boolean/time-based SQL oracles.
  Template expressions, shell commands, and non-SQL parsers belong to ctf-web-source-analysis.
---

# SQL Injection Analysis and Extraction

Establish a reliable SQL execution signal, then extract only the data needed for the task.

## Start
Save a working request and identify one candidate parameter. Read the query construction when source is available. Determine whether the value enters a literal, a numeric expression, an identifier, or an application-specific query fragment.

## Choose a reference
- Establishing syntax, DBMS behavior, and a repeatable true/false signal: [query-context.md](references/query-context.md).
- UNION/error/boolean/time extraction and sqlmap replay: [extraction-and-sqlmap.md](references/extraction-and-sqlmap.md).

## Solve
1. Compare baseline, a context-appropriate probe, and a control. Retain application state and request encoding.
2. Identify the DBMS from evidence before using dialect-specific functions or comments. Transport errors and unstable sessions are not SQL results.
3. Select the clearest available channel: returned rows, explicit error data, a stable boolean difference, or repeated timing evidence.
4. Enumerate the necessary schema or value with a bounded plan. Save progress and confirm extracted data independently when possible.
5. Use the verified data or changed query behavior to finish the task.

For automation, pass the actual raw request and parameter to sqlmap rather than starting a broad crawl. Preserve the request and the accepted predicate so the result is reproducible.
