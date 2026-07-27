#!/usr/bin/env bash
set -euo pipefail

publication_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$publication_root"

if command -v quarto >/dev/null 2>&1; then
  quarto_command="$(command -v quarto)"
elif test -x /root/.local/bin/quarto; then
  quarto_command=/root/.local/bin/quarto
else
  echo "Quarto is not installed. Install stable Quarto before building." >&2
  exit 1
fi

target="${1:-all}"

generate_figures() {
  node scripts/generate-dynamic-occlusion-figure.mjs
  node scripts/generate-furniture-map-comparison.mjs
  node scripts/generate-evidence-tables.mjs
}

build_docx() {
  generate_figures
  "$quarto_command" render manuscript.qmd --to docx
}

build_pdf() {
  generate_figures
  "$quarto_command" render manuscript.qmd --to pdf
}

check_sources() {
  test -s manuscript.qmd
  test -f references/references.bib
  test -s styles/ieee.csl
  test -s templates/generic/reference.docx
  test -s scripts/generate-dynamic-occlusion-figure.mjs
  test -s scripts/generate-furniture-map-comparison.mjs
  test -s scripts/generate-evidence-tables.mjs
  generate_figures
  test -s figures/dynamic-occlusion-evidence.svg
  test -s figures/furniture-map-comparison.svg
  test -s tables/generated/accepted-inventory.md
  "$quarto_command" check
}

case "$target" in
  docx)
    build_docx
    ;;
  pdf)
    build_pdf
    ;;
  all)
    build_docx
    build_pdf
    ;;
  check)
    check_sources
    ;;
  *)
    echo "Usage: $0 {docx|pdf|all|check}" >&2
    exit 2
    ;;
esac
