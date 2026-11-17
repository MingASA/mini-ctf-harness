---
name: ctf-web-auth-testing
description: Test login, session, token, and object-level access-control workflows using separate identities and
  reproducible API sequences. Use for cookie/JWT validation, IDOR, role checks, or actions that depend on earlier
  steps. For merely reproducing a request or redirect use ctf-http-replay.
---

# Web Authentication and Workflow Testing

Identify which identity, object, or workflow condition controls the useful operation, then test that boundary.

## Start
Reproduce one normal login or API sequence with a dedicated session. Identify the protected read/action and the server-issued state needed to reach it. Use available account names and credentials; derive missing values from application evidence.

## Choose a reference
- Session persistence, object ownership, roles, and multi-step operations: [identity-and-state.md](references/identity-and-state.md).
- Signed cookies/JWTs, token claims, and server-side verification: [token-validation.md](references/token-validation.md).

## Test the boundary
1. Establish the ordinary outcome for an available identity and object.
2. Change one relevant boundary: identity, object identifier, operation, or workflow stage. Preserve unrelated tokens and required request fields.
3. Check the protected content or persistent state, not only the presence of a token or a success-looking page.
4. Repeat with isolated sessions to distinguish a real access-control difference from cookie reuse or cached responses.
5. Use the verified access path to complete the challenge objective.

Keep the minimal working request sequence and identity/object relationship. A client claim is useful test input; the server's accepted operation determines whether it grants authority.
