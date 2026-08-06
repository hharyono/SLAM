#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const publicationRoot = path.resolve(import.meta.dirname, "..");
const inputPath = path.join(publicationRoot, "build", "manuscript.tex");
const outputDir = path.join(
  publicationRoot,
  "build",
  "springer-nature-submission",
);
const outputPath = path.join(outputDir, "manuscript.tex");

const source = fs.readFileSync(inputPath, "utf8");

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Unable to find required LaTeX boundary: ${start}`);
  }
  return text.slice(startIndex + start.length, endIndex).trim();
}

function convertLongtables(text) {
  return text.replace(
    /\\begin\{longtable\}\[\]\{([\s\S]*?@\{\})\}\n([\s\S]*?)\\end\{longtable\}/g,
    (_match, columns, content) => {
      const captionMatch = content.match(
        /^\\caption\{([\s\S]*?)\}\\label\{([^}]+)\}\\tabularnewline\n/,
      );
      if (!captionMatch) {
        throw new Error("Unable to parse a generated table caption");
      }

      const caption = captionMatch[1];
      const label = captionMatch[2];
      const tableBody = content.slice(captionMatch[0].length);
      const firstHeadMarker = tableBody.indexOf("\\endfirsthead");
      const repeatedHeadMarker = tableBody.indexOf(
        "\\endhead",
        firstHeadMarker,
      );
      const lastFootMarker = tableBody.indexOf(
        "\\endlastfoot",
        repeatedHeadMarker,
      );
      if (
        firstHeadMarker < 0 ||
        repeatedHeadMarker < 0 ||
        lastFootMarker < 0
      ) {
        throw new Error(`Unable to parse generated table ${label}`);
      }

      const header = tableBody.slice(0, firstHeadMarker).trim();
      let rows = tableBody.slice(
        lastFootMarker + "\\endlastfoot".length,
      );
      rows = rows.replace(/^\s*\\bottomrule\\noalign\{\}\s*/, "").trim();

      return [
        "\\begin{table*}[t]",
        `\\caption{${caption}}\\label{${label}}`,
        "\\centering",
        "\\scriptsize",
        `\\begin{tabular}{${columns}}`,
        header,
        rows,
        "\\bottomrule\\noalign{}",
        "\\end{tabular}",
        ...(label === "tbl-route"
          ? [
            "\\par\\vspace{2pt}\\raggedright\\scriptsize",
            "\\emph{Note.} Asterisks identify post-hoc corrected reference",
            "headings; estimator output and Accepted evidence were not changed.",
          ]
          : []),
        "\\end{table*}",
      ].join("\n");
    },
  );
}

function texAscii(text) {
  const replacements = new Map([
    ["°", "\\(^{\\circ}\\)"],
    ["±", "\\(\\pm\\)"],
    ["×", "\\(\\times\\)"],
    ["→", "\\(\\rightarrow\\)"],
    ["−", "-"],
    ["Á", "\\'{A}"],
    ["á", "\\'{a}"],
    ["É", "\\'{E}"],
    ["é", "\\'{e}"],
    ["Í", "\\'{I}"],
    ["í", "\\'{i}"],
    ["Ó", "\\'{O}"],
    ["ó", "\\'{o}"],
    ["Ú", "\\'{U}"],
    ["ú", "\\'{u}"],
    ["Ý", "\\'{Y}"],
    ["ý", "\\'{y}"],
    ["Ä", '\\"{A}'],
    ["ä", '\\"{a}'],
    ["Ö", '\\"{O}'],
    ["ö", '\\"{o}'],
    ["Ü", '\\"{U}'],
    ["ü", '\\"{u}'],
    ["Š", "\\v{S}"],
    ["š", "\\v{s}"],
  ]);

  let converted = text;
  for (const [character, replacement] of replacements) {
    converted = converted.replaceAll(character, replacement);
  }
  const remaining = converted.match(/[^\x00-\x7F]/g);
  if (remaining) {
    throw new Error(
      `Unconverted non-ASCII LaTeX characters: ${[
        ...new Set(remaining),
      ].join(" ")}`,
    );
  }
  return converted;
}

const abstract = between(
  source,
  "\\begin{abstract}",
  "\\end{abstract}",
);
const bodyStart = source.indexOf("\\section{Introduction}");
const bodyEnd = source.lastIndexOf("\\end{document}");
if (bodyStart < 0 || bodyEnd < 0) {
  throw new Error("Unable to find manuscript body");
}

let body = source.slice(bodyStart, bodyEnd).trim();
body = convertLongtables(body);
body = body
  .replaceAll("\\begin{figure}[H]", "\\begin{figure*}[t]")
  .replaceAll("\\begin{figure}", "\\begin{figure*}[t]")
  .replaceAll("\\end{figure}%", "\\end{figure*}")
  .replaceAll("\\end{figure}", "\\end{figure*]")
  .replace(
    /manuscript_files\/mediabag\/figures\/furniture-map-comparison\.pdf/g,
    "figure-1-furniture-map-comparison.pdf",
  )
  .replace(
    /manuscript_files\/mediabag\/figures\/dynamic-occlusion-evidence\.pdf/g,
    "figure-2-dynamic-occlusion-evidence.pdf",
  )
  .replaceAll(
    "\\bibliographystyle{apalike}",
    "",
  )
  .replaceAll(
    "\\bibliography{references/references.bib}",
    "\\bibliography{references}",
  )
  .replace(
    /\\emph\{Note\.\} Asterisks identify post-hoc corrected reference headings;\nestimator output and Accepted evidence were not changed\.\n/,
    "",
  )
  .replace(
    /^\\bibitem\[\\citeproctext\]\{[^}]+\}\n/gm,
    "\\item[]\n",
  )
  .replace(/^\\CSLLeftMargin/gm, "\\item[]\\CSLLeftMargin");

// Correct a bracket introduced only if a generic figure used no placement.
body = body.replaceAll("\\end{figure*]", "\\end{figure*}");

const preamble = String.raw`% Springer Nature journal article template, December 2024 release.
% Generated from manuscript.qmd; edit manuscript.qmd for scientific changes.
\documentclass[pdflatex,sn-apa,iicol]{sn-jnl}

\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb}
\usepackage{longtable,booktabs,array}
\usepackage{calc}
\usepackage{graphicx}

\newcounter{none}
\providecommand{\tightlist}{%
  \setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}

\makeatletter
\newsavebox\pandoc@box
\newcommand*\pandocbounded[1]{%
  \sbox\pandoc@box{#1}%
  \Gscale@div\@tempa{\textheight}{%
    \dimexpr\ht\pandoc@box+\dp\pandoc@box\relax}%
  \Gscale@div\@tempb{\linewidth}{\wd\pandoc@box}%
  \ifdim\@tempb\p@<\@tempa\p@\let\@tempa\@tempb\fi
  \ifdim\@tempa\p@<\p@\scalebox{\@tempa}{\usebox\pandoc@box}%
  \else\usebox{\pandoc@box}\fi}
\makeatother

% Pandoc citeproc output is author--year and the alphabetized reference list
% is embedded, keeping the editable source package self-contained.
\newcommand{\citeproc}[2]{#2}
\newlength{\cslhangindent}
\setlength{\cslhangindent}{1.5em}
\newlength{\csllabelwidth}
\setlength{\csllabelwidth}{3em}
\newenvironment{CSLReferences}[2]
 {\begin{list}{}{%
  \setlength{\itemindent}{0pt}%
  \setlength{\leftmargin}{0pt}%
  \setlength{\parsep}{0pt}%
  \ifodd #1
   \setlength{\leftmargin}{\cslhangindent}%
   \setlength{\itemindent}{-\cslhangindent}%
  \fi
  \setlength{\itemsep}{#2\baselineskip}}}
 {\end{list}}
\newcommand{\CSLBlock}[1]{\hfill\break
  \parbox[t]{\linewidth}{\strut\ignorespaces#1\strut}}
\newcommand{\CSLLeftMargin}[1]{%
  \parbox[t]{\csllabelwidth}{\strut#1\strut}}
\newcommand{\CSLRightInline}[1]{%
  \parbox[t]{\dimexpr\linewidth-\csllabelwidth\relax}{%
    \strut#1\strut}}
\newcommand{\CSLIndent}[1]{\hspace{\cslhangindent}#1}

\raggedbottom

\begin{document}

\title[Resource-Aware Embedded Localization]{Resource-Aware Local--Global
Multi-Resolution Localization and Recovery on a Constrained RV1103
Embedded Platform}
\subtitle{Physical, Ablation, and Sensor-Paced Hardware Evaluation}

\author*[1]{\sur{Haryono}}\email{haryono81@gmail.com}
\author*[1]{\fnm{Handri} \sur{Santoso}}
\email{handri.santoso@pradita.ac.id}

\affil*[1]{\orgdiv{Information Technology Master's Degree Program},
  \orgname{Pradita University},
  \orgaddress{\city{Tangerang}, \country{Indonesia}}}

`;

const frontMatter = [
  `\\abstract{${abstract}}`,
  "",
  "\\keywords{embedded localization, global relocalization,",
  "multi-resolution scan matching, resource-aware embedded systems, RV1103}",
  "",
  "\\maketitle",
  "",
].join("\n");

const result = texAscii(
  `${preamble}${frontMatter}${body}\n\n\\end{document}\n`,
);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, result);
console.log(`Generated ${outputPath}`);
