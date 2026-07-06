#!/usr/bin/env python3
"""profile_get.py PROFILE.yaml dotted.key  -> prints the value, or exits 1 if absent.

Lets build_firmware.sh read nested profile fields without embedding a YAML parser
in bash. Exit code 1 (with no output) means "not present", so callers can `|| echo default`.
"""
import sys
import yaml

if len(sys.argv) != 3:
    print("usage: profile_get.py FILE dotted.key", file=sys.stderr)
    sys.exit(2)

with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)

cur = data
for part in sys.argv[2].split("."):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        sys.exit(1)

if cur is None:
    sys.exit(1)
print(cur)
