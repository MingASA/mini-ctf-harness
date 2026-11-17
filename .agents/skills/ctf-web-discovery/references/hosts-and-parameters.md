# Discover virtual hosts and parameters

## Virtual hosts are not DNS records
When an HTTP listener serves name-based virtual hosts, fuzz the Host header against the known listener using candidate hostnames:
```bash
ffuf -w "$HOST_WORDLIST" -u "$BASE_URL/" -H 'Host: FUZZ' \
  -mc all -t 8 -rate 20 -timeout 5 -maxtime 45 -of json -o hosts.json
```
Here each wordlist entry is a complete host value. Compare with a nonexistent hostname and replay a candidate. HTTPS can additionally select a backend through SNI; a changed Host header leaves the TLS SNI unchanged. Use curl `--resolve` for individual hostname/SNI confirmation rather than treating every TLS failure as a nonexistent vhost.

## Pick the fuzz position
A parameter-name experiment changes names while keeping a meaningful value fixed. A parameter-value experiment keeps the accepted name and changes values. Existing HTML forms, request builders, or error keys are better seed lists than an unrestricted dictionary.

For an authenticated request, save a valid raw HTTP request and replace precisely one field with `FUZZ`:
```bash
ffuf -request request.txt -request-proto http -w "$WORDLIST" \
  -mc all -t 4 -rate 10 -timeout 5 -maxtime 45 -of json -o params.json
```
Set `-request-proto` to match the working endpoint. Keep the Content-Type correct. Refresh expired cookies or one-time tokens before resuming; a scan of identical login failures does not test the application's input parser.

Multiple keywords introduce another choice: `clusterbomb` explores a Cartesian product, while `pitchfork` pairs entries by position. Compute the expected request count before choosing. Use paired lists only when the pairing is meaningful.

## Promote a result
Verify that the newly found name affects a specific server result. A reflected query string alone does not prove the parameter is consumed. If several fields must vary together, move to a requests-based workflow rather than forcing a stateful sequence into a single ffuf template.

Primary reference: [ffuf options and examples](https://github.com/ffuf/ffuf).
