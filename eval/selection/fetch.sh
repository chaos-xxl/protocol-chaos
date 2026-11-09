#!/bin/sh
# Downloads PersistBench, as Inspect Evals bundles it, into eval/external/persistbench (not
# committed), and extracts its prompt constants. The classifier prompt of Zhao et al. (2026,
# arXiv 2608.08300, Appendix F) is copied from the paper by hand into
# eval/external/structured-memory/dynamic-classifier.txt.
set -eu
cd "$(dirname "$0")/../external" 2>/dev/null || { mkdir -p "$(dirname "$0")/../external"; cd "$(dirname "$0")/../external"; }
BASE=https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_evals/main/src/inspect_evals/persistbench
mkdir -p persistbench/samples
for f in README.md prompts.py scorers.py solvers.py dataset.py utils.py persistbench.py; do curl -sSfL "$BASE/$f" -o "persistbench/$f"; done
for f in cross_domain.jsonl beneficial_samples.jsonl sycophancy.jsonl; do curl -sSfL "$BASE/benchmark_samples/$f" -o "persistbench/samples/$f"; done
python3 - <<'EOF'
import ast
src = open('persistbench/prompts.py').read()
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
        open(f'persistbench/{node.targets[0].id}.txt', 'w').write(node.value.value)
EOF
shasum -a 256 persistbench/samples/*.jsonl
