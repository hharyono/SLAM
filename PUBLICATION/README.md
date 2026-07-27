# Publication workspace

`PUBLICATION/` is the single source of truth for the journal manuscript.
Scientific content is edited in `manuscript.qmd`; generated Word/PDF files are
build artifacts and must not become independent manuscript copies.

## Golden workflow

```text
manuscript.qmd + references.bib + figures + tables
                         |
                    Quarto/Pandoc
                    /            \
        reference.docx             LaTeX
              |                       |
             DOCX                    PDF
```

## Build

From this directory:

```bash
./scripts/build.sh docx
./scripts/build.sh pdf
./scripts/build.sh all
./scripts/build.sh check
```

Outputs are written to `build/`.

- DOCX uses `templates/generic/reference.docx`.
- PDF uses LuaLaTeX and retains the intermediate `.tex` source locally; the
  generated `.tex` file is ignored by Git.
- Citations use `references/references.bib` and `styles/ieee.csl`.

Quarto stable 1.9.38 is installed for the current user at
`/root/.local/opt/quarto-1.9.38`; the executable is linked from
`/root/.local/bin/quarto`. The build script also works with any `quarto`
available on `PATH`.

## Switching journal

Do not rewrite `manuscript.qmd`. Add the target journal assets under:

```text
templates/journals/<journal-id>/
├── README.md
├── reference.docx
├── citation-style.csl
└── template.tex
```

Then update or add a Quarto profile for that journal. Only presentation,
article metadata, section ordering required by the journal, and citation style
should vary. Results, figures, tables, and scientific claims stay in the master
source.

## Rules

1. Accepted experimental evidence is read-only.
2. Tables and figures must identify their source experiment IDs.
3. Numerical claims must be traceable to `EXPERIMENTS/Accepted`.
4. Edit scientific content in `.qmd`, not in generated `.docx`.
5. Word is for visual review, coauthor comments, Track Changes, and final
   submission adjustments.
6. Author names, sequence, emails, corresponding-author status, program, and
   institution are confirmed; add ORCID identifiers only after the authors
   provide or verify them.
7. Regenerate data-derived figures through the build script; do not edit the
   generated SVG independently of its source script and Accepted telemetry.
