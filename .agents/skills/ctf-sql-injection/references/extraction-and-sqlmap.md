# Use the strongest available extraction channel

## Select a channel
Returned rows usually give more information per request than timing. For UNION-based output, determine column count and type compatibility, then identify which column is visible. A query that succeeds without visible output does not prove extraction works. Error-based extraction depends on the DBMS and error handling; use it only when the relevant error reaches the response.

For a boolean oracle, verify known true and known false conditions repeatedly. Infer length and bounds before extracting characters. Distinguish NULL from an empty value. Use byte or character semantics consistent with the database encoding and function. For a time oracle, interleave controls and repeat observations; avoid concurrent probes that create queueing noise.

## Replay a request with sqlmap
Save an HTTP request with a working session and body. Set PARAM to the actual input name:
```bash
sqlmap -r request.txt -p "$PARAM" --batch --level=1 --risk=1 \
  --threads=1 --timeout=8 --retries=1 --output-dir=sqlmap-out
```
These options bound the initial detection effort; they are not a claim that every injection is covered. If syntax requires explicit prefix/suffix or a dynamic CSRF token, configure it from the recovered request and source. Inspect `sqlmap -hh` for installed-version options.

After confirmation, enumerate only what advances the task: current database, relevant tables/columns, then the needed values. Use `-D`, `-T`, `-C`, and `--dump` only with names justified by prior results. Reuse cached findings when the target/request is unchanged. When the environment or request changed, separate the output directory or intentionally refresh its session; stale findings can mislead.

## Verify the extraction
Check one recovered value through a second predicate or known application behavior. Save raw data rather than manually copying encoded text. A single error or a tool's heuristic identification is weaker than a replayable accepted predicate and consistent extraction.

Primary reference: [sqlmap usage](https://github.com/sqlmapproject/sqlmap/wiki/Usage).
