# Test identities, objects, and workflow transitions

Keep one `requests.Session` or cookie jar per identity. Record what each identity owns and which action is expected to work. Two accounts are useful when available; lack of a second account is not a reason to invent one or halt all analysis. Use existing objects, source logic, and available roles to choose a test.

## Distinguish boundaries
Authentication establishes identity. Authorization decides an operation on an object. Workflow state may impose a further condition. A valid session can still fail either later check.

A compact test matrix is enough:
| Identity | Object | Operation | Normal result | Test |
|---|---|---|---|---|
| A | Owned by A | Read | Allowed | Baseline |
| B | Owned by A | Read | Restricted | Cross-owner request |
| A | Owned by A | Restricted action | Role-dependent | Same object, changed action |

Use identifiers obtained from the application rather than sweeping an arbitrary numeric range. A returned metadata object may be public while its content is protected; inspect which part crosses the boundary.

## Reproduce stateful sequences
Capture registration/login, CSRF issuance, object creation, and action requests as separate steps. Update cookies and one-time tokens at the point the server rotates them. When testing stage skipping or repeated actions, begin each comparison from a known state. A reused nonce failure is not evidence that the target action itself is correctly authorized.

Server-side readback is the completion check for an update. A UI label or client-side role field can be stale or ignored. Avoid performing the exact same write twice merely to test visibility; use a readback when it answers the question.

## Find the actual rule
With source available, trace identity lookup, object selection, and permission checks. A query filtered by owner differs from an unfiltered lookup followed by a check; missing checks in one route may not affect another. Evaluate methods and alternate routes individually.

Primary reference: [PortSwigger access control](https://portswigger.net/web-security/access-control).
