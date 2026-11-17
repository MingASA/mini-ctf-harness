# Inspect tokens and test server acceptance

Start with a token that works and the request that uses it. Identify whether it is an opaque session identifier, a signed client-side cookie, JWS/JWT, or an encrypted token. Dot-separated text is a hint, not sufficient format validation.

For a three-part JWS, header and payload use base64url. Decode them for inspection without confusing decoding with signature verification:
```python
import base64, json

def decode_part(part):
    raw = base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))
    return json.loads(raw)
# Apply to a captured header/payload segment; this does not verify its signature.
```

## Ask what the server validates
Check algorithm selection, key source, signature verification, issuer/audience, time claims, and the application fields actually used for identity or role. An editable `role` claim is not a bypass unless a modified token is accepted for the protected operation. A decode helper with verification disabled is analysis code, not the server's acceptance logic.

If source shows asymmetric verification, distinguish public verification material from a secret signing key. Algorithm confusion depends on both the library behavior and the accepted configuration; it is not implied by knowing a public key. An unrecognized key identifier can produce a generic error rather than a lookup primitive.

## Controlled probes
Retain the working token and replay it after failed probes to check expiry and session validity. Change a relevant claim or verification input, then test the same protected endpoint. Inspect content or state as well as HTTP status. Reuse the exact signing serialization when a legitimate signing key is available from the task's data.

Weak-secret search is one branch, not the default. Define the candidate source and budget, and verify any candidate by reproducing the captured signature before testing forged claims. Use standard libraries and local documentation for the selected algorithm rather than implementing cryptography from memory.

Primary references: [JWT RFC 7519](https://www.rfc-editor.org/rfc/rfc7519), [PortSwigger JWT attacks](https://portswigger.net/web-security/jwt).
