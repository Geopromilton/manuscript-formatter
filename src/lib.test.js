import { describe, expect, it } from 'vitest'
import {
  buildDocxConfig,
  buildLatex,
  countWords,
  escapeLatex,
  splitSections,
  validateManuscript,
} from './lib'

describe('manuscript parsing', () => {
  it('counts words and detects common section headings', () => {
    const text =
      'Example Study\nJane Doe\n\nABSTRACT\nA short abstract.\n\nMETHODS\nCollect samples.\n\nREFERENCES\n[1] Smith 2024'
    const manuscript = splitSections(text)
    expect(manuscript.title).toBe('Example Study')
    expect(manuscript.authors).toBe('Jane Doe')
    expect(manuscript.abstract).toBe('A short abstract.')
    expect(manuscript.methods).toContain('Collect samples.')
    expect(countWords('one two  three')).toBe(3)
  })

  it('detects numbered Scientific Reports-style headings', () => {
    const text =
      'Adyar study\nA. Author\n\nAbstract\nSummary text.\n\n1. Introduction\nBackground.\n\n3. Materials and methods\nMethods text.\n\n4. Results and discussion\nResults text.\n\n5. Conclusions\nConclusion text.\n\nReferences\n[1] Smith 2024'
    const manuscript = splitSections(text)
    expect(manuscript.abstract).toBe('Summary text.')
    expect(manuscript.introduction).toContain('Background.')
    expect(manuscript.methods).toContain('Methods text.')
    expect(manuscript.results).toContain('Results text.')
    expect(manuscript.conclusion).toContain('Conclusion text.')
    expect(manuscript.references).toContain('[1] Smith 2024')
  })
})

describe('exports and validation', () => {
  it('escapes LaTeX special characters', () => {
    expect(escapeLatex('A&B 100% _x #1')).toContain('\\&')
    expect(escapeLatex('A&B 100% _x #1')).toContain('\\%')
    expect(escapeLatex('A&B 100% _x #1')).toContain('\\_')
  })

  it('builds LaTeX with preset margins and spacing', () => {
    const latex = buildLatex(
      { title: 'A & B', abstract: 'Summary', keywords: '', introduction: '', methods: '', results: '', discussion: '', conclusion: '', references: '', authors: '' },
      { size: 12, margin: 25, spacing: 1.5 },
    )
    expect(latex).toContain('margin=0.98in')
    expect(latex).toContain('\\setstretch{1.5}')
  })

  it('maps DOCX preset values to document styles', () => {
    const config = buildDocxConfig({
      font: 'Times New Roman',
      size: 12,
      spacing: 1.5,
      margin: 25,
    })
    expect(config).toEqual({
      font: 'Times New Roman',
      fontSize: 24,
      line: 360,
      marginTwips: 1417,
    })
  })

  it('reports missing required sections separately', () => {
    const checks = validateManuscript(
      {
        title: 'Title',
        authors: '',
        abstract: 'Short abstract',
        keywords: 'one, two',
        introduction: '',
        methods: '',
        results: '',
        discussion: '',
        conclusion: '',
        references: '',
      },
      { abstract: 250 },
    )
    expect(checks.find((check) => check.label === 'Title').passed).toBe(true)
    expect(checks.find((check) => check.label === 'Required sections').passed).toBe(false)
  })
})
