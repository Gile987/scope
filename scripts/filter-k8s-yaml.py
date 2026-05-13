#!/usr/bin/env python3
"""Filter multi-document YAML from stdin by kind and resource name.

Usage:
    kustomize build ... | python3 scripts/filter-k8s-yaml.py \
        --exclude-kind ScaledObject --exclude-kind TriggerAuthentication \
"""
import argparse, re, sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exclude-kind", action="append", default=[])
    parser.add_argument("--exclude-name", action="append", default=[])
    args = parser.parse_args()

    exclude_kinds = set(args.exclude_kind)
    exclude_names = set(args.exclude_name)

    if not exclude_kinds and not exclude_names:
        sys.stdout.write(sys.stdin.read())
        return

    raw = sys.stdin.read()
    docs = re.split(r"^---$", raw, flags=re.MULTILINE)
    kept = []

    for doc in docs:
        if not doc.strip():
            continue
        kind_m = re.search(r"^kind:\s+(\S+)", doc, re.MULTILINE)
        name_m = re.search(r"^\s+name:\s+(\S+)", doc, re.MULTILINE)
        kind = kind_m.group(1) if kind_m else ""
        name = name_m.group(1) if name_m else ""
        if kind in exclude_kinds:
            continue
        if name in exclude_names:
            continue
        kept.append(doc)

    sys.stdout.write("---".join(kept))


if __name__ == "__main__":
    main()
