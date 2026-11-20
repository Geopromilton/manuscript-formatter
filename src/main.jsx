import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { profiles } from './profiles'
import {
  blank,
  buildDocxConfig,
  buildLatex,
  buildPlainText,
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

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('manuscript-formatter', 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore('projects')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadProject() {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database
      .transaction('projects', 'readonly')
      .objectStore('projects')
      .get('current')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveProject(project) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database
      .transaction('projects', 'readwrite')
      .objectStore('projects')
      .put(project, 'current')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
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

async function extractDocument(file) {
  if (/\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    })
    return result.value
  }
  if (/\.pdf$/i.test(file.name)) return extractPdf(file)
  return file.text()
}

function App() {
  const [profile, setProfile] = useState('Scientific Reports')
  const [manuscript, setManuscript] = useState(blank)
  const [tab, setTab] = useState('document')
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState('')
  const [drag, setDrag] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const input = useRef()
  const p = profiles[profile]
  const total = fields.reduce(
    (sum, [key]) => sum + countWords(manuscript[key]),
    0,
  )
  const checks = validateManuscript(manuscript, p)
  const warnings = checks.filter((check) => !check.passed)

  useEffect(() => {
    loadProject()
      .then((project) => {
        if (project) {
          setManuscript(project.manuscript || blank)
          setProfile(project.profile || 'Nature')
          setFileName(project.fileName || '')
          setStatus('Restored your previously saved work.')
        }
      })
      .catch(() => setStatus('Local autosave is unavailable in this browser.'))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (!loaded) return
    setUnsaved(true)
    const timer = window.setTimeout(() => {
      saveProject({ manuscript, profile, fileName })
        .then(() => setUnsaved(false))
        .catch(() => setStatus('Could not save locally.'))
    }, 700)
    return () => window.clearTimeout(timer)
  }, [manuscript, profile, fileName, loaded])

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
    if (!/(\.docx|\.pdf|\.txt|\.tex)$/i.test(file.name)) {
      setStatus('Please upload DOCX, PDF, TXT, or TEX.')
      return
    }
    setStatus('Reading manuscript…')
    try {
      const text = await extractDocument(file)
      setManuscript(splitSections(text))
      setFileName(file.name)
      setStatus(`Imported ${file.name}`)
      setTab('sections')
    } catch (error) {
      setStatus(`Could not read this document: ${error.message}`)
    }
  }

  const update = (key, value) =>
    setManuscript((current) => ({ ...current, [key]: value }))

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
    } = await import('docx')
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
      text.split(/\n+/).filter(Boolean).forEach((line) =>
        children.push(
          new Paragraph({
            spacing: { line: config.line, lineRule: 'auto', after: 120 },
            children: [
              new TextRun({ text: line, font: config.font, size: config.fontSize }),
            ],
          }),
        ),
      )
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
      write(text)
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
    <main>
      <header>
        <div className="brand">
          <span className="mark">M</span>
          <div>
            <h1>Manuscript Formatter</h1>
            <p>Journal-ready formatting, without the busywork.</p>
          </div>
        </div>
        <span className="save-state">{unsaved ? 'Saving…' : 'Saved locally'}</span>
        <span className="badge">OPEN SOURCE · PRIVATE BY DEFAULT</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">RESEARCH AUTHOR WORKSPACE</p>
          <h2>Format once.<br /><em>Submit with confidence.</em></h2>
          <p className="intro">Upload your complete manuscript and prepare a journal-ready structure.</p>
        </div>
        <div className="journal-card">
          <label htmlFor="journal-profile">PUBLISHER / JOURNAL</label>
          <select id="journal-profile" value={profile} onChange={(event) => setProfile(event.target.value)}>
            {Object.keys(profiles).map((name) => <option key={name}>{name}</option>)}
          </select>
          <div className="specs">
            <span>{p.publisher}</span>
            <span>{p.font} {p.size} pt</span>
            <span>{p.style}</span>
          </div>
        </div>
      </section>

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
            <input ref={input} type="file" accept=".docx,.pdf,.txt,.tex" onChange={(event) => upload(event.target.files[0])} />
            <span className="upload-icon" aria-hidden="true">↑</span>
            <strong>{fileName || 'Drop your manuscript here'}</strong>
            <small>DOCX, PDF, TXT or LaTeX</small>
            <button type="button">Choose document</button>
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
        <section className="panel editor" id="panel-edit" role="tabpanel">
          <div className="wordbar">
            <div><strong>{total.toLocaleString()}</strong><span> manuscript words</span></div>
            <div><strong>{countWords(manuscript.abstract)}</strong><span> / {p.abstract} abstract words</span></div>
          </div>
          {fields.map(([key, label]) => (
            <label key={key}>
              {label.toUpperCase()}
              <textarea
                className={['title', 'authors', 'keywords'].includes(key) ? 'short' : ''}
                value={manuscript[key]}
                onChange={(event) => update(key, event.target.value)}
                placeholder={`Add ${label.toLowerCase()}...`}
              />
              <small>{countWords(manuscript[key])} words</small>
            </label>
          ))}
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
            <strong>Citation formatting:</strong> {p.style} is identified for the preset, but reference text is not automatically rewritten. Review and format references manually.
          </div>
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
                  {text.split(/\n+/).filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}
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

      <footer>
        <span>Built for researchers · Files stay in your browser</span>
        <span>{Object.keys(profiles).length} publisher presets</span>
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)
