export const blank = {
  title: '',
  authors: '',
  abstract: '',
  keywords: '',
  introduction: '',
  methods: '',
  results: '',
  discussion: '',
  conclusion: '',
  references: '',
}

export const countWords = (text = '') =>
  (text.trim().match(/\S+/g) || []).length

export function splitSections(text) {
  const sections = { ...blank }
  const heading = new RegExp(
    [
      '(?:^|\\n)\\s*(?:TITLE|AUTHOR[S]?)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:ABSTRACT)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:KEYWORDS?)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(?:INTRODUCTION)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(?:MATERIALS? AND METHODS?|METHODS?)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(?:RESULTS? AND DISCUSSION|RESULTS?|DISCUSSION)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s*)?(?:CONCLUSIONS?|CONCLUSION)(?=\\s*(?::|\\.|$|\\n))',
      '(?:^|\\n)\\s*(?:REFERENCES?|BIBLIOGRAPHY)(?=\\s*(?::|\\.|$|\\n))',
    ].join('|'),
    'gi',
  )
  const matches = [...text.matchAll(heading)]

  if (!matches.length) {
    sections.introduction = text
    return sections
  }

  const before = text.slice(0, matches[0].index).trim()
  if (before) {
    const lines = before
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    sections.title = lines.shift() || ''
    if (lines.length) sections.authors = lines.join(', ')
  }

  matches.forEach((match, index) => {
    const name = match[0]
      .replace(/^[\n\s]+/, '')
      .replace(/[:.]*$/, '')
      .trim()
      .replace(/^\d+(?:\.\d+)*\.?\s*/, '')
      .toUpperCase()
    const start = match.index + match[0].length
    const end =
      index + 1 < matches.length ? matches[index + 1].index : text.length
    const value = text
      .slice(start, end)
      .replace(/^\n+/, '')
      .trim()

    if (/^ABSTRACT/.test(name)) sections.abstract = value
    else if (/^KEYWORD/.test(name)) sections.keywords = value
    else if (/^INTRO/.test(name)) sections.introduction = value
    else if (/^METHOD/.test(name) || /^MATERIALS/.test(name))
      sections.methods = value
    else if (/^RESULTS? AND DISCUSSION/.test(name)) {
      sections.results = value
      sections.discussion = value
    }
    else if (/^RESULT/.test(name)) sections.results = value
    else if (/^DISCUSS/.test(name)) sections.discussion = value
    else if (/^CONCLUSION/.test(name)) sections.conclusion = value
    else if (/^REFERENCE/.test(name) || /^BIBLIO/.test(name))
      sections.references = value
  })

  return sections
}

export function escapeLatex(text = '') {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&_#$])/g, '\\$1')
    .replace(/([{}])/g, (character) =>
      character === '{' ? '\\{' : '\\}',
    )
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

export function buildLatex(manuscript, profile) {
  const title = escapeLatex(manuscript.title || 'Untitled Manuscript')
  const authors = escapeLatex(manuscript.authors)
  const section = (name, text) => {
    if (!text) return ''
    return `\\section*{${escapeLatex(name)}}\n${escapeLatex(text)}\n`
  }

  return `\\documentclass[${profile.size}pt]{article}
\\usepackage[margin=${(profile.margin / 25.4).toFixed(2)}in]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage{setspace}
\\setstretch{${profile.spacing}}
\\title{${title}}
${authors ? `\\author{${authors}}` : ''}
\\begin{document}
\\maketitle
\\begin{abstract}
${escapeLatex(manuscript.abstract)}
\\end{abstract}
${manuscript.keywords ? `\\noindent\\textbf{Keywords:} ${escapeLatex(manuscript.keywords)}\n\n` : ''}${section(
    'Introduction',
    manuscript.introduction,
  )}${section('Methods', manuscript.methods)}${section(
    'Results',
    manuscript.results,
  )}${section('Discussion', manuscript.discussion)}${section(
    'Conclusion',
    manuscript.conclusion,
  )}${section('References', manuscript.references)}
\\end{document}
`
}

export function buildDocxConfig(profile) {
  const fontSize = profile.size * 2
  const line = Math.round(profile.spacing * 240)
  return {
    font: profile.font,
    fontSize,
    line,
    marginTwips: Math.round((profile.margin / 25.4) * 1440),
  }
}

export function validateManuscript(manuscript, profile, assets = { figures: [], tables: [] }) {
  const checks = []
  const add = (label, passed, detail) =>
    checks.push({ label, passed, detail })

  add(
    'Title',
    Boolean(manuscript.title.trim()),
    manuscript.title.trim()
      ? 'A manuscript title was detected.'
      : 'No manuscript title was detected.',
  )
  add(
    'Abstract',
    Boolean(manuscript.abstract.trim()),
    manuscript.abstract.trim()
      ? 'An abstract section was detected.'
      : 'No abstract section was detected.',
  )

  const abstractWords = countWords(manuscript.abstract)
  add(
    'Abstract length',
    Boolean(manuscript.abstract.trim()) &&
      abstractWords <= profile.abstract,
    `${abstractWords} words; profile limit is ${profile.abstract}.`,
  )

  const keywordCount = manuscript.keywords
    .split(/[,;\n]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean).length
  add(
    'Keywords',
    keywordCount >= 3,
    `${keywordCount} keywords detected; at least 3 were used as a baseline check.`,
  )

  add(
    'Required sections',
    Boolean(manuscript.introduction.trim()) &&
      Boolean(manuscript.methods.trim()) &&
      Boolean(manuscript.results.trim()) &&
      Boolean(manuscript.discussion.trim()),
    'Checked for Introduction, Methods, Results, and Discussion sections.',
  )

  add(
    'References',
    Boolean(manuscript.references.trim()),
    manuscript.references.trim()
      ? 'A references section was detected.'
      : 'No references section was detected.',
  )

  const referenceLines = manuscript.references
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const numberedReferences = referenceLines.filter((line) =>
    /^\s*(\[\d+\]|\d+[.)])/.test(line),
  ).length
  add(
    'Reference format',
    referenceLines.length > 0 &&
      (numberedReferences === referenceLines.length ||
        referenceLines.some((line) => /\(\d{4}\)/.test(line))),
    'Checked for a recognizable numbered or author-year reference pattern. Citation style is manual unless implemented for the journal.',
  )

  const bodyText = manuscript.introduction + '\n' + manuscript.methods + '\n' + manuscript.results + '\n' + manuscript.discussion
  const figureMentions = bodyText.match(/\bFigure\s+\d+[a-z]?|\bFig\.?\s*\d+[a-z]?/gi)?.length || 0
  const tableMentions = bodyText.match(/\bTable\s+\d+/gi)?.length || 0
  const embeddedFigures = assets.figures?.length || 0
  const embeddedTables = assets.tables?.length || 0
  add(
    'Figure/table references',
    true,
    `Detected ${figureMentions} figure references and ${tableMentions} table references; found ${embeddedFigures} embedded figures and ${embeddedTables} embedded tables.`,
  )

  return checks
}

export function buildPlainText(manuscript) {
  const blocks = [
    ['Title', manuscript.title],
    ['Authors', manuscript.authors],
    ['Abstract', manuscript.abstract],
    ['Keywords', manuscript.keywords],
    ['Introduction', manuscript.introduction],
    ['Methods', manuscript.methods],
    ['Results', manuscript.results],
    ['Discussion', manuscript.discussion],
    ['Conclusion', manuscript.conclusion],
    ['References', manuscript.references],
  ]
  return blocks
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}\n${text}`)
    .join('\n\n')
}
