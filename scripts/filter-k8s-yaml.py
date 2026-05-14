#!/usr/bin/env python3
"""Filter multi-document YAML from stdin by kind and/or resource name.

Usage:
    kustomize build ... | python3 scripts/filter-k8s-yaml.py \
        --exclude-kind ScaledObject \
        --exclude-name coder-acp-claude-code

Reads a multi-document YAML stream from stdin, drops documents that match
any --exclude-kind or --exclude-name, and writes the rest to stdout.
"""

import argparse
import re
import sys


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--exclude-kind', action='append', default=[], dest='kinds',
                   help='Drop documents with this kind (repeatable)')
    p.add_argument('--exclude-name', action='append', default=[], dest='names',
                   help='Drop documents whose metadata.name matches (repeatable)')
    return p.parse_args()


def main():
    args = parse_args()
    if not args.kinds and not args.names:
        sys.stdout.write(sys.stdin.read())
        return

    exclude_kinds = set(args.kinds)
    exclude_names = set(args.names)

    docs = re.split(r'^---$', sys.stdin.read(), flags=re.MULTILINE)
    for doc in docs:
        if not doc.strip():
            continue
        kind = ''
        name = ''
        for line in doc.splitlines():
            m = re.match(r'^kind:\s*(\S+)', line)
            if m:
                kind = m.group(1)
            m = re.match(r'^\s+name:\s*(\S+)', line)
            if m and not name:
                name = m.group(1)
        if kind in exclude_kinds:
            continue
        if name in exclude_names:
            continue
        sys.stdout.write('---\n')
        sys.stdout.write(doc.strip() + '\n')


if __name__ == '__main__':
    main()
