# Find paths without burying the result in false positives

Start with names from HTML, script URLs, route definitions, manifests, and error messages. Pick a small local SecLists file only after these leads are exhausted. Confirm the wordlist path exists; distributions install SecLists in different locations.

A basic bounded scan, with BASE_URL and WORDLIST already set:
```bash
ffuf -w "$WORDLIST" -u "${BASE_URL%/}/FUZZ" -mc all \
  -t 8 -rate 20 -timeout 5 -maxtime 60 -of json -o paths.json
```
The limits are a small starting configuration, not a required rate for every service. Lower concurrency when response time or error rate rises. For a wildcard application returning the same page for missing paths, evaluate `-ac`, `-fs`, `-fw`, `-fl`, or `-fr` against captured controls. A path returning 403 or redirecting may still be useful.

## Filter meaningfully
| Background behavior | Candidate filter | Verify before accepting it |
|---|---|---|
| Constant-size not-found body | `-fs` | A valid route does not share that size |
| Dynamic token but stable word count | `-fw` or response expression | Token variation is actually background noise |
| Stable error phrase | `-fr` | The phrase is absent from successful pages |
| Multiple hosts with different catch-alls | Host-specific controls / `-ach` | Each host's valid route remains visible |

Automatic calibration sends additional probes and may overfilter. Its output is evidence to inspect, not a guaranteed classifier. Keep an unfiltered small candidate run when calibration is uncertain.

## Triage JSON and confirm
```bash
jq -r '.results[] | [.status,.length,.words,.url] | @tsv' paths.json
```
Compare a candidate with the nearest negative control. Fetch the candidate using the same method and cookies. Preserve a discovered redirect rather than blindly following it and losing the origin. Expand recursion only within directories that showed meaningful content; unrestricted recursion over a catch-all route produces noise.

Primary references: [ffuf usage](https://github.com/ffuf/ffuf), [SecLists](https://github.com/danielmiessler/SecLists).
