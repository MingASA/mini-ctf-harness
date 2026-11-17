# Follow an upload through storage and processing

Separate four events: request accepted, bytes stored, bytes retrievable, and content interpreted. An application can accept a file and rename it, transform it, queue it, or store it outside the served tree.

## Reproduce the working multipart request
Use curl's multipart support rather than writing boundaries by hand:
```bash
curl -sS --connect-timeout 3 --max-time 10 \
  -b cookies.txt -c cookies.txt \
  -F "file=@sample.bin;filename=sample.dat;type=application/octet-stream" \
  -D upload.headers -o upload.body "$UPLOAD_URL"
```
Replace the form field and content type with those required by the application. Keep additional fields and CSRF tokens from the working request. A response-provided identifier can be unrelated to the submitted filename.

## Locate the effective validation
Check extension, declared MIME type, magic bytes, parser acceptance, decoded content, and final storage extension. These checks answer different questions. A decoder/re-encoder may remove trailing content or normalize metadata. A random filename may prevent direct guessing but not an exposed retrieval API. Trace what happens after the validation step.

Use small files with distinctive content and compare stored/retrieved bytes. A synthetic file containing two recognizable text markers can distinguish truncation from renaming without relying on a challenge answer. If an image or document is transformed, inspect the transformed artifact's structure instead of assuming byte identity.

## Turn the capability into a test
If content reaches a template, converter, archive extractor, or interpreter, analyze that specific processor and invocation. An uploaded script extension alone does not establish execution; routing and server configuration decide the handler. Conversely, a processing endpoint may interpret data even when the storage URL only downloads it.

Keep the accepted input format, output identifier, retrieval route, and demonstrated processing effect. This provides a reusable primitive for the next step.

Primary reference: [PortSwigger file uploads](https://portswigger.net/web-security/file-upload).
