SPRINGER NATURE LATEX SUBMISSION SOURCES

The submission manuscript is manuscript.tex. It uses the official Springer
Nature sn-jnl class with the pdflatex and sn-apa options. The submission PDF
uses the class's single-column review layout so tables and figures remain in
the same reading order as manuscript.qmd. The generated review PDF uses a
160 mm A4 text area (approximately 25 mm side margins) for readable tables and
figures; the publisher may repaginate the accepted source.

Compile from this directory:

  pdflatex manuscript.tex
  bibtex manuscript
  pdflatex manuscript.tex
  pdflatex manuscript.tex

The author-year bibliography is generated with the included sn-apacite.bst
style. Both references.bib and the generated manuscript.bbl are supplied.
The PDF figures used for compilation, editable SVG counterparts, and
publication-oriented EPS files are included in the same directory.
manuscript.qmd is the project master source.

Template provenance:
Springer Nature journal article template package, version 3.1, December 2024.
https://www.springernature.com/gp/authors/campaigns/latex-author-support

The target journal's Instructions for Authors take precedence over this
generic Springer Nature formatting profile.
