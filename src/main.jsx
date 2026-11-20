import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Dexie from 'dexie'
import JSZip from 'jszip'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { profiles } from './profiles'
import {
  blank,
  buildDocxConfig,
  buildLatex,
  buildPlainText,
  buildPreflightDiagnostics,
  buildSemanticDocument,
  countWords,
  splitSections,
  validateManuscript,
} from './lib'
import './styles.css'

const fields = [
  ['title', 'Manuscript title'],
  ['authors', 'Authors'],
  ['abstract', 'Abstract'],
  ['keywords', 'Keywords'],
  ['introduction', 'Introduction'],
  ['methods', 'Methods'],
  ['results', 'Results'],
  ['discussion', 'Discussion'],
  ['conclusion', 'Conclusion'],
  ['references', 'References'],
]

const tabs = [
  ['document', 'Upload'],
  ['sections', 'Check structure'],
  ['edit', 'Edit'],
  ['review', 'Review'],
  ['export', 'Export'],
]

function SemanticEditor({ blockId, value, label, onChange }) {
  const editor = useEditor({
    extensions: [StarterKit],
    content: value
      ? `<p>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '</p><p>')}</p>`
      : '<p></p>',
    onUpdate: ({ editor: current }) => onChange(current.getText({ blockSeparator: '\n' })),
  })

  useEffect(() => {
    if (!editor) return
    const current = editor.getText({ blockSeparator: '\n' })
    if (value !== current) {
      const paragraphs = value
        ? value.split('\n').filter(Boolean).map((paragraph) =>
          `<p>${paragraph.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
        ).join('')
        : '<p></p>'
      editor.commands.setContent(paragraphs)
    }
  }, [editor, value])

  return (
    <label className="semantic-block" htmlFor={blockId}>
      <span className="block-label">{label}</span>
      <EditorContent
        id={blockId}
        className="tiptap-editor"
        editor={editor}
        aria-label={label}
      />
      <small>{countWords(value)} words</small>
    </label>
  )
}

const projectDatabase = new Dexie('manuscript-formatter')
projectDatabase.version(1).stores({
  projects: 'id',
})

async function loadProject() {
  return projectDatabase.projects.get('current')
}

async function saveProject(project) {
  await projectDatabase.projects.put({ id: 'current', ...project })
}

async function extractPdf(file) {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  let pdf
  try {
    pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  } catch (error) {
    if (/password/i.test(error.message)) {
      throw new Error('This PDF is password-protected. Remove the password and try again.')
    }
    throw error
  }

  const pages = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const positioned = content.items
      .filter((item) => item.str?.trim())
      .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], eol: item.hasEOL }))
      .sort((a, b) => b.y - a.y || a.x - b.x)

    const lines = []
    let previousY = null
    for (const item of positioned) {
      if (previousY === null) {
        lines.push(item.text)
      } else if (Math.abs(item.y - previousY) > 3) {
        if (previousY - item.y > 12) lines.push('')
        lines.push(item.text)
      } else {
        lines[lines.length - 1] += (lines[lines.length - 1] ? ' ' : '') + item.text
      }
      previousY = item.y
    }
    pages.push(lines.join('\n').trim())
  }

  const text = pages.filter(Boolean).join('\n\n')
  if (!text.trim()) {
    throw new Error('No selectable text was found. This may be a scanned PDF.')
  }
  return text
}

const blockElements = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TR', 'UL',
])

function documentHtmlToText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, ' ')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  if (node.tagName === 'IMG') return `\n[[FIGURE:${node.dataset.assetId}]]\n`
  if (node.tagName === 'TABLE') return `\n[[TABLE:${node.dataset.assetId}]]\n`

  const content = [...node.childNodes].map(documentHtmlToText).join('')
  return blockElements.has(node.tagName) ? `\n${content}\n` : content
}

function formatImportedTable(html) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('table').forEach((table) => {
    table.classList.add('manuscript-table')
    table.setAttribute('data-reference-style', 'grid-gray-header')
    const firstRow = table.querySelector('tr')
    if (!firstRow) return
    firstRow.classList.add('table-header-row')
    firstRow.querySelectorAll('td').forEach((cell) => {
      const header = document.createElement('th')
      header.innerHTML = cell.innerHTML
      for (const attribute of cell.attributes) {
        header.setAttribute(attribute.name, attribute.value)
      }
      cell.replaceWith(header)
    })
  })
  return document.body.innerHTML
}

async function extractDocument(file) {
  if (/\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth')
    const arrayBuffer = await file.arrayBuffer()
    const citations = await extractCitationFields(arrayBuffer)
    const raw = await mammoth.extractRawText({
      arrayBuffer,
    })
    const html = await mammoth.convertToHtml(
      {
        arrayBuffer,
      },
      {
        convertImage: mammoth.images.imgElement((image) =>
          image.read('base64').then((base64) => ({
            src: `data:${image.contentType};base64,${base64}`,
          })),
        ),
      },
    )
    const formattedHtml = formatImportedTable(html.value)
    const documentHtml = new DOMParser().parseFromString(formattedHtml, 'text/html')
    const figures = [...documentHtml.querySelectorAll('img')].map((image, index) => ({
      id: `figure-${index + 1}`,
      name: image.getAttribute('alt') || `Embedded Figure ${index + 1}`,
      src: image.getAttribute('src') || '',
    })).filter((figure) => figure.src)
    const tables = [...documentHtml.querySelectorAll('table')].map((table, index) => ({
      id: `table-${index + 1}`,
      name: `Embedded Table ${index + 1}`,
      html: table.outerHTML,
      text: [...table.querySelectorAll('tr')]
        .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent.trim()).join(' | '))
        .join('\n'),
    }))
    documentHtml.querySelectorAll('img').forEach((image, index) => {
      image.dataset.assetId = figures[index]?.id || ''
    })
    documentHtml.querySelectorAll('table').forEach((table, index) => {
      table.dataset.assetId = tables[index]?.id || ''
    })
    const text = documentHtmlToText(documentHtml.body)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return { text: text || raw.value, assets: { figures, tables, citations } }
  }
  if (/\.pdf$/i.test(file.name)) return { text: await extractPdf(file), assets: { figures: [], tables: [], citations: [] } }
  if (/\.bib$|\.ris$/i.test(file.name)) {
    const libraryText = await file.text()
    return {
      text: `References\n${libraryText}`,
      assets: {
        figures: [],
        tables: [],
        citations: [{
          id: `library-${file.name}`,
          manager: /\.ris$/i.test(file.name) ? 'RIS library' : 'BibTeX library',
          detected: true,
          note: 'Citation library detected. Automated citation formatting is ready for Citeproc.js integration.',
        }],
      },
    }
  }
  return { text: await file.text(), assets: { figures: [], tables: [], citations: [] } }
}

async function extractCitationFields(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) return []

  const citations = []
  if (/ADDIN ZOTERO_ITEM CSL_CITATION/.test(documentXml) ||
      /<w:instrText[^>]*>[^<]*(CITATION|ZOTERO)/i.test(documentXml)) {
    citations.push({
      id: 'citation-field-zotero',
      manager: 'Zotero',
      detected: true,
      note: 'Zotero field codes were detected. Live Word fields require a specialized OOXML round-trip.',
    })
  }
  if (/Mendeley|MENDELEY|refWorks/i.test(documentXml)) {
    citations.push({
      id: 'citation-field-mendeley',
      manager: 'Mendeley',
      detected: true,
      note: 'Mendeley field metadata was detected. Live Word fields require a specialized OOXML round-trip.',
    })
  }
  return citations
}

function assetParts(text) {
  const parts = []
  const token = /\[\[(FIGURE|TABLE):([^\]]+)\]\]/g
  let start = 0
  let match
  while ((match = token.exec(text)) !== null) {
    if (match.index > start) parts.push({ type: 'text', value: text.slice(start, match.index) })
    parts.push({ type: match[1].toLowerCase(), id: match[2] })
    start = match.index + match[0].length
  }
  if (start < text.length) parts.push({ type: 'text', value: text.slice(start) })
  return parts
}

function App() {
  const [profile, setProfile] = useState('Scientific Reports')
  const [manuscript, setManuscript] = useState(blank)
  const [assets, setAssets] = useState({ figures: [], tables: [], citations: [] })
  const [tab, setTab] = useState('document')
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState('')
  const [drag, setDrag] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const input = useRef()
  const worker = useRef()
  const [workerAnalysis, setWorkerAnalysis] = useState(null)
  const p = profiles[profile]
  const checks = validateManuscript(manuscript, p, assets)
  const warnings = checks.filter((check) => !check.passed)
  const semanticDocument = workerAnalysis?.semanticDocument || buildSemanticDocument(manuscript)
  const diagnostics = workerAnalysis?.diagnostics || buildPreflightDiagnostics(manuscript, p, assets)
  const score = Math.max(
    0,
    Math.round(
      100 -
        diagnostics.filter((diagnostic) => diagnostic.severity !== 'success').length * 12 -
        diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length * 8,
    ),
  )
  const assetById = Object.fromEntries(
    [...assets.figures, ...assets.tables].map((asset) => [asset.id, asset]),
  )

  function appendDocxAsset(asset, children, config, docx) {
    if (!asset) return
    if (asset.src) {
      try {
        const base64 = asset.src.split(',')[1]
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
        children.push(
          new docx.Paragraph({
            alignment: 'center',
            children: [new docx.ImageRun({ data: bytes, transformation: { width: 500, height: 300 } })],
          }),
          new docx.Paragraph({
            alignment: 'center',
            spacing: { after: 240, line: config.line, lineRule: 'auto' },
            children: [new docx.TextRun({ text: asset.name, font: config.font, size: config.fontSize })],
          }),
        )
      } catch {
        children.push(new docx.Paragraph({ text: `[Image asset unavailable: ${asset.name}]` }))
      }
      return
    }

    const parsed = new DOMParser().parseFromString(asset.html, 'text/html')
    const sourceRows = [...parsed.querySelectorAll('tr')]
    if (sourceRows.length === 0) return
    const rows = sourceRows.map((sourceRow) =>
      new docx.TableRow({
        children: [...sourceRow.querySelectorAll('th, td')].map((cell) =>
          new docx.TableCell({
            width: { size: 25, type: docx.WidthType.PERCENTAGE },
            shading: cell.tagName === 'TH' ? { fill: 'F2F2F2' } : undefined,
            borders: {
              top: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
              bottom: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
              left: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
              right: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
            },
            children: [
              new docx.Paragraph({
                alignment: cell.tagName === 'TH' ? 'center' : 'left',
                spacing: { line: config.line, lineRule: 'auto' },
                children: [
                  new docx.TextRun({
                    text: cell.textContent.trim(),
                    font: config.font,
                    size: Math.min(config.fontSize, 20),
                    bold: cell.tagName === 'TH',
                  }),
                ],
              }),
            ],
          }),
        ),
      }),
    )
    children.push(
      new docx.Table({
        rows,
        borders: {
          top: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
          bottom: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
          left: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
          right: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
          insideHorizontal: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
          insideVertical: { style: docx.BorderStyle.SINGLE, size: 4, color: '666666' },
        },
      }),
      new docx.Paragraph({
        alignment: 'center',
        spacing: { before: 80, after: 160, line: config.line, lineRule: 'auto' },
        children: [new docx.TextRun({ text: asset.name, font: config.font, size: 18, italic: true })],
      }),
    )
  }

  function appendDocxText(text, children, config, docx) {
    assetParts(text).forEach((part) => {
      if (part.type === 'text') {
        part.value.split(/\n+/).filter(Boolean).forEach((line) =>
          children.push(
            new docx.Paragraph({
              spacing: { line: config.line, lineRule: 'auto', after: 120 },
              children: [new docx.TextRun({ text: line, font: config.font, size: config.fontSize })],
            }),
          ),
        )
      } else {
        appendDocxAsset(assetById[part.id], children, config, docx)
      }
    })
  }

  useEffect(() => {
    loadProject()
      .then((project) => {
        if (project) {
          setManuscript(project.manuscript || blank)
          setAssets(project.assets || { figures: [], tables: [], citations: [] })
          setProfile(project.profile || 'Scientific Reports')
          setFileName(project.fileName || '')
          setStatus('Restored your previously saved work.')
        }
      })
      .catch(() => setStatus('Local autosave is unavailable in this browser.'))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(
        new URL('./workers/document-worker.js', import.meta.url),
        { type: 'module' },
      )
      worker.current.onmessage = ({ data }) => {
        if (data.type === 'analysis') setWorkerAnalysis(data)
      }
    }
    worker.current.postMessage({
      type: 'analyze',
      manuscript,
      profile: p,
      assets,
    })
  }, [manuscript, p, assets])

  useEffect(() => {
    if (!loaded) return
    setUnsaved(true)
    const timer = window.setTimeout(() => {
      saveProject({ manuscript, assets, profile, fileName })
        .then(() => setUnsaved(false))
        .catch(() => setStatus('Could not save locally.'))
    }, 700)
    return () => window.clearTimeout(timer)
  }, [manuscript, assets, profile, fileName, loaded])

  useEffect(() => {
    const warn = (event) => {
      if (!unsaved) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  async function upload(file) {
    if (!file) return
    if (!/(\.docx|\.pdf|\.txt|\.tex|\.bib|\.ris)$/i.test(file.name)) {
      setStatus('Please upload DOCX, PDF, TXT, TEX, BIB, or RIS.')
      return
    }
    setStatus('Reading manuscript…')
    try {
      const extracted = await extractDocument(file)
      setManuscript(splitSections(extracted.text))
      setAssets(extracted.assets)
      setFileName(file.name)
      setStatus(`Imported ${file.name}`)
      setTab('sections')
    } catch (error) {
      setStatus(`Could not read this document: ${error.message}`)
    }
  }

  const update = (key, value) =>
    setManuscript((current) => ({ ...current, [key]: value }))

  function jumpToBlock(blockId) {
    setTab('edit')
    window.requestAnimationFrame(() => {
      const target = document.getElementById(`semantic-${blockId}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.focus()
    })
  }

  function triggerDownload(content, mime, extension) {
    const title =
      manuscript.title || 'Untitled Manuscript'
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'manuscript'}.${extension}`
    link.click()
    URL.revokeObjectURL(url)
  }

  function downloadTxt() {
    triggerDownload(
      buildPlainText(manuscript),
      'text/plain;charset=utf-8',
      'txt',
    )
  }

  function downloadTex() {
    triggerDownload(
      buildLatex(manuscript, p),
      'application/x-tex',
      'tex',
    )
  }

  async function downloadDocx() {
    const {
      Document,
      Packer,
      Paragraph,
      HeadingLevel,
      TextRun,
      ImageRun,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
    } = await import('docx')
    const docx = {
      Paragraph,
      TextRun,
      ImageRun,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
    }
    const config = buildDocxConfig(p)
    const children = []
    children.push(
      new Paragraph({
        alignment: 'center',
        spacing: { line: config.line, lineRule: 'auto' },
        children: [
          new TextRun({
            text: manuscript.title || 'Untitled Manuscript',
            bold: true,
            size: config.fontSize + 12,
            font: config.font,
          }),
        ],
      }),
    )
    if (manuscript.authors) {
      children.push(
        new Paragraph({
          alignment: 'center',
          spacing: { line: config.line, lineRule: 'auto' },
          children: [
            new TextRun({ text: manuscript.authors, font: config.font, size: config.fontSize }),
          ],
        }),
      )
    }

    ;[
      ['Abstract', manuscript.abstract],
      ['Keywords', manuscript.keywords],
      ['Introduction', manuscript.introduction],
      ['Methods', manuscript.methods],
      ['Results', manuscript.results],
      ['Discussion', manuscript.discussion],
      ['Conclusion', manuscript.conclusion],
      ['References', manuscript.references],
    ].forEach(([heading, text]) => {
      if (!text) return
      children.push(
        new Paragraph({
          text: heading,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 240, after: 120, line: config.line, lineRule: 'auto' },
        }),
      )
      appendDocxText(text, children, config, docx)
    })

    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: config.font, size: config.fontSize },
            paragraph: {
              spacing: { line: config.line, lineRule: 'auto', after: 120 },
            },
          },
        },
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: config.marginTwips,
                right: config.marginTwips,
                bottom: config.marginTwips,
                left: config.marginTwips,
              },
            },
          },
          children,
        },
      ],
    })
    const blob = await Packer.toBlob(doc)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'formatted-manuscript.docx'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function downloadPdf() {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
    const margin = p.margin
    pdf.setFont(p.font === 'Arial' ? 'helvetica' : 'times', 'normal')
    pdf.setFontSize(p.size)
    let y = margin

    const write = (text, bold = false) => {
      pdf.setFont(undefined, bold ? 'bold' : 'normal')
      pdf.splitTextToSize(text || '', 210 - margin * 2).forEach((line) => {
        if (y > 297 - margin) {
          pdf.addPage()
          y = margin
        }
        pdf.text(line, margin, y)
        y += p.spacing * 5
      })
    }

    const writeAsset = (asset) => {
      if (!asset) return
      if (asset.src) {
        const mime = asset.src.match(/^data:(image\/[^;]+);base64,/)?.[1]
        const format = mime === 'image/png' ? 'PNG' : mime === 'image/jpeg' ? 'JPEG' : null
        if (format) {
          if (y > 220) { pdf.addPage(); y = margin }
          pdf.addImage(asset.src, format, margin, y, 210 - margin * 2, 70)
          y += 75
        }
        write(asset.name)
        y += 5
        return
      }
      if (y > 270) { pdf.addPage(); y = margin }
      write(asset.name, true)
      y += 2
      write(asset.text)
      y += 5
    }

    write(manuscript.title || 'Untitled Manuscript', true)
    y += 5
    ;[
      ['Abstract', manuscript.abstract],
      ['Keywords', manuscript.keywords],
      ['Introduction', manuscript.introduction],
      ['Methods', manuscript.methods],
      ['Results', manuscript.results],
      ['Discussion', manuscript.discussion],
      ['Conclusion', manuscript.conclusion],
      ['References', manuscript.references],
    ].forEach(([heading, text]) => {
      if (!text) return
      write(heading, true)
      y += 2
      assetParts(text).forEach((part) => {
        if (part.type === 'text') write(part.value)
        else writeAsset(assetById[part.id])
      })
      y += 5
    })
    pdf.save('formatted-manuscript.pdf')
  }

  const previewSections = [
    ['Abstract', manuscript.abstract],
    ['Keywords', manuscript.keywords],
    ['Introduction', manuscript.introduction],
    ['Methods', manuscript.methods],
    ['Results', manuscript.results],
    ['Discussion', manuscript.discussion],
    ['Conclusion', manuscript.conclusion],
    ['References', manuscript.references],
  ].filter(([, text]) => text)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="mark">M</span>
          <div>
            <strong>Manuscript</strong>
            <span>Formatter AI</span>
          </div>
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Workspace navigation">
          {tabs.map(([key, label], index) => (
            <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
              <span className="nav-icon">{['⌂', '◈', '✎', '✓', '↗'][index]}</span>
              <span>{label}</span>
              {key === 'review' && warnings.length > 0 && <b>{warnings.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-version"><span>MF</span><div><strong>Manuscript Studio</strong><small>Workspace ready</small></div></div>
      </aside>

      <main className="content">
      <header>
        <div className="brand">
          <span className="mark">M</span>
          <div>
            <h1>Manuscript Formatter <span className="ai-pill">AI</span></h1>
            <p>Journal-ready formatting, without the busywork.</p>
          </div>
        </div>
        <div className="top-actions">
          <span className="local-engine"><i />Local Engine Active · Files stay on this device</span>
          <button className="icon-button" aria-label="Help">?</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">GOOD MORNING, RESEARCHER <span>✦</span></p>
          <h2>Bring your research<br /><em>to its final form.</em></h2>
          <p className="intro">A calm, intelligent workspace for transforming your manuscript into a publication-ready document.</p>
        </div>
        <div className="hero-side">
          <div className="journey-card">
            <div><h3>Your Manuscript<br />Journey</h3><span className="journey-icon">✦</span></div>
            <ul><li>Structured Format</li><li>Citation Ready</li><li>Journal Guidelines</li><li>Plagiarism Check</li></ul>
            <button onClick={() => setTab('review')}>➤ Ready for Submission</button>
          </div>
          <div className="journal-card">
            <div className="card-kicker"><span className="sparkle">✦</span> FORMATTING PROFILE</div>
            <label htmlFor="journal-profile">TARGET JOURNAL / TEMPLATE</label>
            <select id="journal-profile" value={profile} onChange={(event) => setProfile(event.target.value)}>
            <optgroup label="Journal-specific profiles">
              {Object.entries(profiles)
                .filter(([, value]) => value.scope === 'journal')
                .map(([name]) => <option key={name}>{name}</option>)}
            </optgroup>
            <optgroup label="Publisher templates">
              {Object.entries(profiles)
                .filter(([, value]) => value.scope !== 'journal')
                .map(([name]) => <option key={name}>{name}</option>)}
            </optgroup>
            </select>
            <small className="profile-status"><span className="status-dot" />{p.status}</small>
            <div className="specs">
              <span>{p.publisher}</span>
              <span>{p.font} {p.size} pt</span>
              <span>{p.style}</span>
            </div>
          </div>
        </div>
      </section>

      <div className="workspace-heading">
        <div><span className="workspace-eyebrow">CURRENT PROJECT</span><h3>{fileName || 'Untitled manuscript'}</h3></div>
        <span className="project-status"><i /> {unsaved ? 'Saving locally' : 'Saved locally'}</span>
      </div>
      <nav className="steps" role="tablist" aria-label="Manuscript setup steps">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {label}{key === 'review' && <b>{warnings.length}</b>}
          </button>
        ))}
      </nav>

      {tab === 'document' && (
        <section className="panel" id="panel-document" role="tabpanel">
          <div className="dashboard-columns">
            <div
              className={`dropzone ${drag ? 'drag' : ''}`}
              role="button"
              tabIndex="0"
              aria-label="Choose or drop a manuscript"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') input.current.click()
              }}
              onDragOver={(event) => { event.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDrag(false)
                upload(event.dataTransfer.files[0])
              }}
              onClick={() => input.current.click()}
            >
              <input ref={input} type="file" accept=".docx,.pdf,.txt,.tex,.bib,.ris" onChange={(event) => upload(event.target.files[0])} />
              <span className="upload-icon" aria-hidden="true">↑</span>
              <strong>{fileName || 'Drag & Drop Your Manuscript'}</strong>
              <span className="drop-subtitle">or choose a file from your device</span>
              <button type="button">▣ &nbsp; Choose Document <b>›</b></button>
              <small>Supports: <b>DOCX</b> · <b>PDF</b> · <b>LaTeX</b> · <b>BIB</b> · <b>RIS</b></small>
              <div className="upload-note">Files are processed locally in your browser</div>
            </div>
          </div>
        </section>
      )}

      {tab === 'sections' && (
        <section className="panel" id="panel-sections" role="tabpanel">
          <h3>Detected structure</h3>
          <p className="muted">Review the detected sections and move to Edit to correct any assignment.</p>
          <div className="structure-grid">
            {fields.map(([key, label]) => (
              <div className={manuscript[key] ? 'detected' : 'missing'} key={key}>
                <strong>{label}</strong>
                <span>{manuscript[key] ? `${countWords(manuscript[key])} words · detected` : 'not detected'}</span>
              </div>
            ))}
          </div>
          <div className="actions"><button className="primary" onClick={() => setTab('edit')}>Edit sections</button></div>
        </section>
      )}

      {tab === 'edit' && (
        <section className="studio" id="panel-edit" role="tabpanel">
          <aside className="studio-outline" aria-label="Manuscript outline">
            <div className="studio-pane-heading">
              <div><span>DOCUMENT</span><strong>Outline</strong></div>
              <b>{score}</b>
            </div>
            <nav>
              {semanticDocument.map((block) => (
                <button key={block.id} onClick={() => jumpToBlock(block.id)}>
                  <span>{block.label}</span>
                  <small>{countWords(block.text)} words</small>
                </button>
              ))}
            </nav>
            <div className="preflight">
              <strong>Submission readiness</strong>
              <div className="score-track"><i style={{ width: `${score}%` }} /></div>
              {diagnostics.map((diagnostic, index) => (
                <button
                  className={`diagnostic ${diagnostic.severity}`}
                  key={`${diagnostic.label}-${index}`}
                  onClick={() => jumpToBlock(diagnostic.blockId)}
                >
                  <span>{diagnostic.severity === 'success' ? '✓' : diagnostic.severity === 'error' ? '!' : '·'}</span>
                  <div><strong>{diagnostic.label}</strong><small>{diagnostic.detail}</small></div>
                </button>
              ))}
            </div>
          </aside>

          <div className="semantic-canvas">
            <div className="canvas-toolbar">
              <strong>Semantic Editor</strong>
              <div>
                <button aria-label="Light canvas">Aa</button>
                <button aria-label="Focus mode">Focus</button>
              </div>
            </div>
            {fields.map(([key, label]) => (
              <SemanticEditor
                key={key}
                blockId={`semantic-${key}`}
                label={label}
                value={manuscript[key]}
                onChange={(value) => update(key, value)}
              />
            ))}
          </div>

          <aside className="studio-preview" aria-label="Live journal preview">
            <div className="studio-pane-heading">
              <div><span>LIVE</span><strong>Journal Preview</strong></div>
              <small>{p.layout?.columns || 1} col</small>
            </div>
            <article
              className="mini-preview"
              style={{
                fontFamily: p.font,
                fontSize: `${Math.max(7, p.size - 5)}px`,
                lineHeight: p.spacing,
              }}
            >
              <h1>{manuscript.title || 'Untitled manuscript'}</h1>
              {manuscript.authors && <p className="preview-authors">{manuscript.authors}</p>}
              {previewSections.map(([heading, text]) => (
                <section key={heading}>
                  <h2>{heading}</h2>
                  {text.split(/\n+/).filter(Boolean).slice(0, 3).map((line, index) => <p key={index}>{line}</p>)}
                </section>
              ))}
            </article>
          </aside>
        </section>
      )}

      {tab === 'review' && (
        <section className="panel checklist" id="panel-review" role="tabpanel">
          <h3>Submission readiness</h3>
          {checks.map((check) => (
            <div className={check.passed ? 'success' : 'warning'} key={check.label}>
              <span aria-hidden="true">{check.passed ? '✓' : '!'}</span>
              <strong>{check.label}: </strong>{check.detail}
            </div>
          ))}
          <div className="profile">
            <strong>{profile}</strong>
            <span>{p.publisher} · {p.font} {p.size} pt · {p.spacing} line spacing · {p.margin} mm margins · Citation style: {p.style}</span>
          </div>
          <div className="source">
            <strong>Preset source:</strong>{' '}
            {p.sourceUrl ? <a href={p.sourceUrl} target="_blank" rel="noreferrer">{p.sourceName}</a> : p.sourceName}
            {' · checked '}{p.checkedDate}. Presets are starting defaults and must be verified against the journal’s current instructions.
          </div>
          <div className="manual-note">
            <strong>Scope:</strong> {p.limitations}
          </div>
          <div className="manual-note">
            <strong>Citation formatting:</strong> {p.style} is identified for the preset, but reference text is not automatically rewritten. Review and format references manually.
          </div>
          {(assets.citations?.length || 0) > 0 && (
            <div className="manual-note">
              <strong>Reference-manager fields detected:</strong>{' '}
              {assets.citations.map((citation) => citation.manager).join(', ')}.
              {' '}Live Word fields are preserved as detected, but reinjection into new DOCX exports requires the dedicated OOXML round-trip module.
            </div>
          )}
          {(assets.figures.length > 0 || assets.tables.length > 0) && (
            <div className="asset-review">
              <strong>Embedded assets</strong>
              {assets.figures.map((figure) => (
                <div className="asset-row" key={figure.id}>
                  <img src={figure.src} alt={figure.name} />
                  <span>{figure.name}</span>
                </div>
              ))}
              {assets.tables.map((table) => (
                <div className="asset-row table-preview" key={table.id}>
                  <pre>{table.text}</pre>
                  <span>{table.name}</span>
                </div>
              ))}
            </div>
          )}
          {assets.figures.length === 0 && assets.tables.length === 0 && (
            <div className="manual-note">
              <strong>Figures and tables:</strong> No embedded figure or table assets were found in this import. The formatter will still verify in-text Figure and Table references and preserve any assets added in future uploads.
            </div>
          )}
          <div className="actions"><button onClick={() => setTab('edit')}>Edit sections</button><button className="primary" onClick={() => setTab('export')}>Continue to export</button></div>
        </section>
      )}

      {tab === 'export' && (
        <section className="panel export-panel" id="panel-export" role="tabpanel">
          <h3>Preview and export</h3>
          <div className="preview-wrap">
            <article
              className="preview-page"
              style={{
                fontFamily: p.font,
                fontSize: `${p.size}px`,
                lineHeight: p.spacing,
                padding: `${p.margin / 25.4 * 96}px`,
              }}
            >
              <h1>{manuscript.title || 'Untitled Manuscript'}</h1>
              {manuscript.authors && <p className="preview-authors">{manuscript.authors}</p>}
              {previewSections.map(([heading, text]) => (
                <section key={heading}>
                  <h2>{heading}</h2>
                  {assetParts(text).map((part, index) => {
                    if (part.type === 'text') {
                      return part.value.split(/\n+/).filter(Boolean).map((line, lineIndex) => (
                        <p key={`${index}-${lineIndex}`}>{line}</p>
                      ))
                    }
                    const asset = assetById[part.id]
                    if (!asset) return null
                    if (asset.src) {
                      return (
                        <figure className="preview-asset inline" key={`${part.id}-${index}`}>
                          <img src={asset.src} alt={asset.name} />
                          <figcaption>{asset.name}</figcaption>
                        </figure>
                      )
                    }
                    return (
                      <div
                        className="preview-asset inline"
                        key={`${part.id}-${index}`}
                        dangerouslySetInnerHTML={{ __html: asset.html }}
                      />
                    )
                  })}
                </section>
              ))}
            </article>
          </div>
          <div className="actions">
            <button onClick={downloadTxt}>Export TXT</button>
            <button onClick={downloadDocx}>Export DOCX</button>
            <button onClick={downloadPdf}>Export PDF</button>
            <button onClick={downloadTex}>Export LaTeX</button>
          </div>
        </section>
      )}

      {status && <div className="toast" role="status">{status}<button aria-label="Dismiss message" onClick={() => setStatus('')}>×</button></div>}

      </main>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
