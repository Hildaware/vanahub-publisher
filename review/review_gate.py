#!/usr/bin/env python3
"""Run VanaHub's local Semgrep policy and enforce exact-file review baselines."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def stable_json(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_relative(source: Path, result_path: str) -> tuple[str, Path]:
    candidate = Path(result_path)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    resolved = candidate.resolve()
    try:
        relative = resolved.relative_to(source)
    except ValueError as exc:
        raise ValueError(f"Semgrep result escapes source root: {result_path}") from exc
    return relative.as_posix(), resolved


def load_baseline(path: str, package_id: str) -> dict[str, str]:
    if not path:
        return {}
    baseline_path = Path(path).resolve()
    value = json.loads(baseline_path.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1 or value.get("packageId") != package_id:
        raise ValueError("Semantic review baseline has the wrong schema or package ID.")
    files = value.get("files")
    if not isinstance(files, dict):
        raise ValueError("Semantic review baseline files must be an object.")
    for name, value_digest in files.items():
        if (
            not isinstance(name, str)
            or name.startswith("/")
            or any(part in ("", ".", "..") for part in name.split("/"))
            or not isinstance(value_digest, str)
            or len(value_digest) != 64
            or any(character not in "0123456789abcdef" for character in value_digest)
        ):
            raise ValueError(f"Semantic review baseline contains an invalid file: {name}")
    return files


def write_output(name: str, value: str) -> None:
    target = os.environ.get("GITHUB_OUTPUT")
    if target:
        with open(target, "a", encoding="utf-8") as output:
            output.write(f"{name}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--semgrep", required=True)
    parser.add_argument("--rules", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--package-id", required=True)
    parser.add_argument("--baseline", default="")
    parser.add_argument("--output-directory", required=True)
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if not source.is_dir():
        raise ValueError(f"Addon source directory was not found: {args.source}")
    output_directory = Path(args.output_directory).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    raw_report = output_directory / "semgrep.json"
    subprocess.run(
        [
            args.semgrep,
            "scan",
            "--config",
            args.rules,
            "--metrics=off",
            "--quiet",
            "--json-output",
            str(raw_report),
            str(source),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    baseline = load_baseline(args.baseline, args.package_id)
    raw = json.loads(raw_report.read_text(encoding="utf-8"))
    findings = []
    unapproved: dict[str, str] = {}
    critical = False
    for result in raw.get("results", []):
        relative, absolute = safe_relative(source, result["path"])
        file_digest = digest(absolute)
        metadata = result.get("extra", {}).get("metadata", {})
        risk = metadata.get("vanahub_risk", "elevated")
        reviewed = risk == "informational" or baseline.get(relative) == file_digest
        if risk == "critical":
            reviewed = False
            critical = True
        if risk == "elevated" and not reviewed:
            unapproved[relative] = file_digest
        finding = {
            "ruleId": result.get("check_id", "unknown"),
            "risk": risk,
            "capability": metadata.get("capability", "elevated"),
            "path": relative,
            "line": result.get("start", {}).get("line", 0),
            "message": result.get("extra", {}).get("message", ""),
            "reviewed": reviewed,
        }
        findings.append(finding)
        if not reviewed:
            print(
                f"::error file={relative},line={finding['line']}::{finding['ruleId']}: {finding['message']}"
            )

    for error in raw.get("errors", []):
        error_path = error.get("path")
        if not error_path:
            raise ValueError(f"Semgrep reported a scan error: {error.get('message', 'unknown error')}")
        relative, absolute = safe_relative(source, error_path)
        file_digest = digest(absolute)
        reviewed = baseline.get(relative) == file_digest
        if not reviewed:
            unapproved[relative] = file_digest
        spans = error.get("spans") or []
        line = spans[0].get("start", {}).get("line", 0) if spans else 0
        finding = {
            "ruleId": "semgrep.parse-error",
            "risk": "elevated",
            "capability": "analysis-gap",
            "path": relative,
            "line": line,
            "message": error.get("message", "Semgrep could not fully parse this file."),
            "reviewed": reviewed,
        }
        findings.append(finding)
        if not reviewed:
            print(
                f"::error file={relative},line={line}::semgrep.parse-error: "
                "Semgrep could not fully parse this file; manual review is required."
            )

    report = {
        "schemaVersion": 1,
        "packageId": args.package_id,
        "accepted": not critical and not unapproved,
        "findings": findings,
    }
    reviewed_commit = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    ).stdout.strip().lower()
    if not reviewed_commit:
        reviewed_commit = os.environ.get("GITHUB_SHA", "").lower()
    if len(reviewed_commit) != 40 or any(
        character not in "0123456789abcdef" for character in reviewed_commit
    ):
        reviewed_commit = "0" * 40
    candidate = {
        "schemaVersion": 1,
        "packageId": args.package_id,
        "reviewedCommit": reviewed_commit,
        "files": dict(sorted({**baseline, **unapproved}.items())),
        "findings": [finding for finding in findings if not finding["reviewed"]],
    }
    report_path = output_directory / "semantic-review.json"
    candidate_path = output_directory / "semantic-review-candidate.json"
    report_path.write_text(stable_json(report), encoding="utf-8")
    candidate_path.write_text(stable_json(candidate), encoding="utf-8")
    write_output("report-path", str(report_path))
    write_output("candidate-path", str(candidate_path))
    print(
        f"VanaHub semantic review: {len(findings)} finding(s), "
        f"{len(unapproved)} file(s) need review."
    )
    return 0 if report["accepted"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"VanaHub semantic review failed: {error}", file=sys.stderr)
        raise SystemExit(1)
