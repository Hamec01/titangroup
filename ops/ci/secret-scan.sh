#!/usr/bin/env bash
# R02 — repo-wide committed-secret scan. Deterministic, no external tool. Scans tracked files only
# (git ls-files) so generated node_modules / .next are never in scope. Exit 1 on any hit.
#
#   ops/ci/secret-scan.sh            # scan the working tree's tracked files
#
# Deliberately conservative: real key material and credential URLs, not short doc placeholders.
# .env.example / *.env.example and this script itself are excluded.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
note() { echo "  SECRET? $1"; fail=1; }

# Files to scan: tracked, text, not example env, not the scanner.
mapfile -t files < <(git ls-files -z \
  | tr '\0' '\n' \
  | grep -vE '(^|/)\.env\.example$|\.env\..*\.example$|^ops/ci/secret-scan\.sh$|^titanor-time-app/scripts/run-lint\.mjs$|(^|/)package-lock\.json$' \
  | grep -vE '\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|mp4|mov)$' || true)

scan() { # <regex> <label>
  local re="$1" label="$2" hit
  hit=$(grep -nEI --color=never "$re" "${files[@]}" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    note "$label"
    echo "$hit" | sed 's/^/      /' | head -20
  fi
}

scan '-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----'              'private key block'
scan '\bAKIA[0-9A-Z]{16}\b'                                                  'AWS access key id'
scan '\bASIA[0-9A-Z]{16}\b'                                                  'AWS temporary key id'
scan 'aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}'                        'AWS secret access key'
scan '\bxox[baprs]-[0-9A-Za-z-]{20,}\b'                                      'Slack token'
scan '\bgh[pousr]_[A-Za-z0-9]{36,}\b'                                        'GitHub token'
scan '\bglpat-[0-9A-Za-z_-]{20,}\b'                                          'GitLab PAT'
scan '\bAIza[0-9A-Za-z_-]{35}\b'                                             'Google API key'
scan 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'     'JWT'
scan '-----BEGIN CERTIFICATE-----'                                           'x509 certificate'
# postgres/redis/amqp URL with an inline password against a NON-local host
scan '(postgres(ql)?|redis|amqp|mongodb(\+srv)?)://[a-z0-9_.-]+:[^@ /"'"'"':]{6,}@(?!(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|db|postgres|redis|host|hostname|example\.com))[a-z0-9.-]+' 'service URL with inline password'
# our own crypto keys assigned a long base64 literal in code/config
scan '(IDEMPOTENCY_ENCRYPTION_KEY|PERSONAL_DATA_ENCRYPTION_KEY|ACTIVATION_TOKEN_HMAC_KEY|PASSWORD_RESET_TOKEN_HMAC_KEY|SESSION_SECRET|NEXTAUTH_SECRET)\s*[:=]\s*["'"'"'][A-Za-z0-9+/]{24,}={0,2}["'"'"']' 'hard-coded crypto key'

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "  secret-scan: FAIL — review the hits above. A real leak must be rotated, not just removed."
  exit 1
fi
echo "  secret-scan: clean (${#files[@]} tracked files)"
