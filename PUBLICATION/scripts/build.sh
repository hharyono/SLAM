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
  test -s manuscript.tex
  test -d manuscript_files
  mkdir -p build/manuscript_files
  cp -a manuscript_files/. build/manuscript_files/
  mv manuscript.tex build/manuscript.tex
}

build_latex() {
  build_pdf
  test -s build/manuscript.tex
}

build_springer() {
  build_pdf

  springer_output="build/springer-nature-submission"
  springer_archive="build/springer-nature-submission.zip"
  springer_template_url="https://cms-resources.apps.public.k8s.springernature.io/springer-cms/rest/v1/content/18782940/data/v12"
  springer_temp="$(mktemp -d)"
  trap 'rm -rf "$springer_temp"' RETURN

  mkdir -p "$springer_output"
  curl -fsSL "$springer_template_url" \
    -o "$springer_temp/sn-article-template.zip"
  unzip -p "$springer_temp/sn-article-template.zip" \
    sn-article-template/sn-jnl.cls > "$springer_output/sn-jnl.cls"
  unzip -p "$springer_temp/sn-article-template.zip" \
    sn-article-template/bst/sn-basic.bst > "$springer_output/sn-basic.bst"

  cp manuscript.qmd "$springer_output/manuscript.qmd"
  cp references/references.bib "$springer_output/references.bib"
  cp templates/journals/springer-nature/README.txt \
    "$springer_output/README.txt"
  cp figures/furniture-map-comparison.svg \
    "$springer_output/figure-1-furniture-map-comparison.svg"
  cp figures/dynamic-occlusion-evidence.svg \
    "$springer_output/figure-2-dynamic-occlusion-evidence.svg"
  cp build/manuscript_files/mediabag/figures/furniture-map-comparison.pdf \
    "$springer_output/figure-1-furniture-map-comparison.pdf"
  cp build/manuscript_files/mediabag/figures/dynamic-occlusion-evidence.pdf \
    "$springer_output/figure-2-dynamic-occlusion-evidence.pdf"

  node scripts/generate-springer-nature-tex.mjs

  if command -v pdflatex >/dev/null 2>&1; then
    pdflatex_command="$(command -v pdflatex)"
  elif test -x /root/.TinyTeX/bin/x86_64-linux/pdflatex; then
    pdflatex_command=/root/.TinyTeX/bin/x86_64-linux/pdflatex
  else
    echo "pdflatex is required for the Springer Nature build." >&2
    exit 1
  fi

  (
    cd "$springer_output"
    "$pdflatex_command" -interaction=nonstopmode -halt-on-error \
      manuscript.tex > manuscript-build.log
    "$pdflatex_command" -interaction=nonstopmode -halt-on-error \
      manuscript.tex >> manuscript-build.log
  )

  rm -f "$springer_archive"
  (
    cd "$springer_output"
    springer_files=(
      README.txt manuscript.qmd manuscript.tex manuscript.pdf
      references.bib sn-jnl.cls sn-basic.bst
      figure-1-furniture-map-comparison.pdf
      figure-1-furniture-map-comparison.svg
      figure-2-dynamic-occlusion-evidence.pdf
      figure-2-dynamic-occlusion-evidence.svg
    )
    if command -v zip >/dev/null 2>&1; then
      zip -q "../$(basename "$springer_archive")" "${springer_files[@]}"
    elif command -v jar >/dev/null 2>&1; then
      jar --create --file "../$(basename "$springer_archive")" \
        --no-manifest "${springer_files[@]}"
    else
      echo "zip or jar is required to package the submission." >&2
      exit 1
    fi
  )
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
  latex|tex)
    build_latex
    ;;
  springer|springer-nature)
    build_springer
    ;;
  all)
    build_docx
    build_springer
    ;;
  check)
    check_sources
    ;;
  *)
    echo "Usage: $0 {docx|pdf|latex|springer|all|check}" >&2
    exit 2
    ;;
esac
